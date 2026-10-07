import { create } from 'zustand';

import {
  getSong,
  normalizeUrl,
  type Song,
  type SubsonicAuth,
} from '@/api/backend';
import {
  createListeningSession,
  createOpenSubsonicLibraryId,
  getListeningSessionCapabilities,
  joinListeningSession,
} from '@/api/listeningSessions';
import {
  registerListeningSessionBridge,
  withListeningSessionBypass,
} from '@/lib/listeningSessionBridge';
import {
  LISTENING_SESSION_HEARTBEAT_MS,
  LISTENING_SESSION_CORRECTION_COOLDOWN_MS,
  ListeningSessionClock,
  createListeningSessionInvite,
  isKnownListeningSessionServerMessageType,
  isSafeListeningSessionConnectionUrl,
  isListeningSessionServerTrack,
  isListeningSessionServerMessage,
  listeningSessionInviteUrl,
  listeningSessionStateHasDiscontinuity,
  normalizeListeningSessionCode,
  normalizeListeningSessionCoordinatorUrl,
  normalizeListeningSessionServerUrl,
  projectedListeningPositionMs,
  shouldReconcileListeningPosition,
  type ListeningSessionAccess,
  type ListeningSessionClientMessage,
  type ListeningSessionControl,
  type ListeningSessionInvite,
  type ListeningSessionPlaybackState,
  type ListeningSessionRoom,
  type ListeningSessionServerMessage,
} from '@/lib/listeningSessions';
import { getItem, setItem } from '@/lib/storage';
import { useAuthStore } from './auth';
import { currentPlaybackPositionSec, usePlayerStore } from './player';

type ListeningSessionStatus =
  | 'idle'
  | 'checking'
  | 'unsupported'
  | 'connecting'
  | 'leaving'
  | 'connected'
  | 'error';

interface ListeningSessionStore {
  status: ListeningSessionStatus;
  supported: boolean | null;
  room: ListeningSessionRoom | null;
  error: string | null;
  coordinatorUrl: string;
  coordinatorHydrated: boolean;
  setCoordinatorUrl: (value: string) => void;
  hydrateCoordinator: () => Promise<void>;
  checkSupport: (coordinatorUrl?: string, force?: boolean) => Promise<boolean>;
  start: () => Promise<void>;
  join: (code: string, target?: ListeningSessionJoinTarget) => Promise<void>;
  leave: () => Promise<void>;
  end: () => Promise<void>;
  shareInvite: () => { invite: ListeningSessionInvite; appUrl: string } | null;
  clearError: () => void;
}

export interface ListeningSessionJoinTarget {
  coordinatorUrl: string;
  serverUrl: string;
  libraryId: string;
}

let socket: WebSocket | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let clockFallback: ReturnType<typeof setTimeout> | null = null;
let initialized = false;
let sessionAuth: SubsonicAuth | null = null;
let sessionCoordinatorUrl = '';
let sessionLibraryId = '';
let supportCoordinator = '';
let publishTimer: ReturnType<typeof setTimeout> | null = null;
let lastGuestState: ListeningSessionPlaybackState | null = null;
const songCache = new Map<string, Song>();
const songRequests = new Map<string, Promise<Song>>();
const clock = new ListeningSessionClock();
let clockReady = false;
let lastGuestCorrectionAt = 0;
let latestGuestRevision = -1;
let roomOperation: Promise<void> | null = null;
let connectionGeneration = 0;
let lifecycleRequest: {
  kind: 'leave' | 'end';
  requestId: string;
  resolve: () => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;
let pendingGuestTransport: {
  isPlaying: boolean;
  afterRevision: number;
  requestId: string;
  timeout: ReturnType<typeof setTimeout>;
} | null = null;
const SOCKET_AUTH_TIMEOUT_MS = 10_000;
const LIFECYCLE_CONFIRM_TIMEOUT_MS = 5_000;
// WebSocket message events are separate JS tasks. Without a short collection
// window, each task can start installing its intermediate track before the
// next revision is even visible to `latestGuestRevision`. Collapse transport
// bursts before they reach Media3; the final authoritative state is the only
// one a listener needs to hear.
const STATE_BURST_COALESCE_MS = 40;
const COORDINATOR_STORAGE_KEY = 'listening-session-coordinator-v1';
let coordinatorHydration: Promise<void> | null = null;

function runRoomOperation(action: () => Promise<void>): Promise<void> {
  if (roomOperation) return roomOperation;
  const operation = Promise.resolve()
    .then(action)
    .finally(() => {
      if (roomOperation === operation) roomOperation = null;
    });
  roomOperation = operation;
  return operation;
}

function settleLifecycle(error?: Error): void {
  const pending = lifecycleRequest;
  if (!pending) return;
  lifecycleRequest = null;
  clearTimeout(pending.timeout);
  if (error) pending.reject(error);
  else pending.resolve();
}

function requestLifecycle(kind: 'leave' | 'end'): Promise<void> {
  if (lifecycleRequest) return Promise.reject(new Error('A Jam action is already in progress'));
  return new Promise((resolve, reject) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeout = setTimeout(() => {
      if (
        lifecycleRequest?.kind !== kind ||
        lifecycleRequest.requestId !== requestId
      ) {
        return;
      }
      lifecycleRequest = null;
      reject(new Error('The Jam coordinator did not confirm the action'));
    }, LIFECYCLE_CONFIRM_TIMEOUT_MS);
    lifecycleRequest = { kind, requestId, resolve, reject, timeout };
    if (
      send({
        type: kind === 'leave' ? 'session.leave' : 'session.end',
        protocolVersion: 1,
        requestId,
      })
    ) {
      return;
    }
    settleLifecycle(new Error('The Jam connection was lost'));
  });
}

function profileKey(auth: SubsonicAuth | null): string {
  if (!auth) return '';
  return `${auth.urls?.[0] ?? auth.serverUrl}|${auth.username}`;
}

function serverCandidates(auth: SubsonicAuth): string[] {
  return [...new Set([auth.serverUrl, ...(auth.urls ?? [])])];
}

function requiredCoordinatorUrl(value: string): string {
  if (!value.trim()) throw new Error('Enter a Jam coordinator URL');
  try {
    return normalizeListeningSessionCoordinatorUrl(value);
  } catch {
    throw new Error('Enter a valid Jam coordinator URL');
  }
}

function activeOnlineAuth(): SubsonicAuth {
  const { auth, offline } = useAuthStore.getState();
  if (!auth || offline) {
    throw new Error('Listening together requires an online OpenSubsonic server.');
  }
  if (auth.serverType === 'jellyfin') {
    throw new Error('Listening together requires an OpenSubsonic-compatible server.');
  }
  return auth;
}

function send(message: ListeningSessionClientMessage): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

function clearPendingGuestTransport(): void {
  if (!pendingGuestTransport) return;
  clearTimeout(pendingGuestTransport.timeout);
  pendingGuestTransport = null;
}

function clearConnection(): void {
  // Invalidates metadata loads and native source changes already in flight.
  // WebSocket frames are serialized, but the clock and transport fallback
  // timers deliberately reconcile outside that queue and can otherwise finish
  // after a room has ended (overwriting playback the user started afterward).
  connectionGeneration += 1;
  settleLifecycle(new Error('The Jam connection was lost'));
  clearPendingGuestTransport();
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  if (clockFallback) clearTimeout(clockFallback);
  clockFallback = null;
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = null;
  const current = socket;
  socket = null;
  if (current && current.readyState < WebSocket.CLOSING) current.close(1000, 'leaving');
  sessionAuth = null;
  sessionCoordinatorUrl = '';
  sessionLibraryId = '';
  lastGuestState = null;
  songCache.clear();
  songRequests.clear();
  clock.reset();
  clockReady = false;
  lastGuestCorrectionAt = 0;
  latestGuestRevision = -1;
}

function currentHostState(): Omit<
  ListeningSessionPlaybackState,
  'revision' | 'serverTimestamp'
> {
  const player = usePlayerStore.getState();
  return {
    songIds: player.queue.map((song) => song.id),
    currentIndex: player.index,
    positionMs: Math.max(0, Math.round(currentPlaybackPositionSec() * 1000)),
    isPlaying: player.isPlaying,
  };
}

function publishHostState(): void {
  const { room, status } = useListeningSession.getState();
  if (status !== 'connected' || room?.role !== 'host') return;
  send({
    type: 'state.update',
    protocolVersion: 1,
    state: currentHostState(),
  });
}

function scheduleHostPublish(delayMs = 0): void {
  if (publishTimer) clearTimeout(publishTimer);
  publishTimer = setTimeout(() => {
    publishTimer = null;
    publishHostState();
  }, delayMs);
}

function requestControl(control: ListeningSessionControl): boolean {
  const { room, status } = useListeningSession.getState();
  if (!room) return false;
  // Keep guest controls locked while a leave acknowledgement is pending. If
  // the leave is rejected, the local player must still match the room.
  if (status === 'leaving') return room.role === 'guest';
  if (status !== 'connected') return false;
  if (room.role === 'host') {
    // The player applies the local action after this returns. Publish once its
    // synchronous state change has landed (and again from the store subscriber).
    scheduleHostPublish();
    return false;
  }
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const delivered = send({
    type: 'control.request',
    protocolVersion: 1,
    requestId,
    control,
  });
  if (delivered && (control.action === 'play' || control.action === 'pause')) {
    clearPendingGuestTransport();
    const pending: NonNullable<typeof pendingGuestTransport> = {
      isPlaying: control.action === 'play',
      afterRevision: room.state.revision,
      requestId,
      timeout: setTimeout(() => {
        if (pendingGuestTransport?.requestId !== requestId) return;
        pendingGuestTransport = null;
        if (lastGuestState) void applyGuestState(lastGuestState, true);
      }, LIFECYCLE_CONFIRM_TIMEOUT_MS),
    };
    pendingGuestTransport = pending;
    // Flip only the visual transport intent. Native audio changes after the
    // host publishes a newer authoritative revision.
    usePlayerStore.setState({ isPlaying: pending.isPlaying });
  }
  return true;
}

function applyHostControl(control: ListeningSessionControl): void {
  const player = usePlayerStore.getState();
  switch (control.action) {
    case 'play':
      if (!player.isPlaying) player.toggle();
      break;
    case 'pause':
      if (player.isPlaying) player.toggle();
      break;
    case 'next':
      player.next();
      break;
    case 'previous':
      player.previous();
      break;
    case 'seek':
      player.seekTo(control.positionMs / 1000);
      break;
    case 'jump':
      player.jumpTo(control.index);
      break;
  }
  scheduleHostPublish(100);
}

async function resolveSongs(
  auth: SubsonicAuth,
  songIds: string[],
  knownSongs: Song[] = [],
): Promise<Song[]> {
  const songs = new Array<Song>(songIds.length);
  const cachePrefix = `${profileKey(auth)}\0`;
  const requestedIds = new Set(songIds);
  // A participant often already has part (or all) of the host queue. Reuse
  // those server-backed objects instead of turning every join/reorder into one
  // getSong request per item. Besides being faster, this avoids ejecting a
  // client because an unrelated, already-known queue item had a transient
  // lookup failure.
  for (const song of knownSongs) {
    if (requestedIds.has(song.id) && isListeningSessionServerTrack(song)) {
      songCache.set(`${cachePrefix}${song.id}`, song);
    }
  }
  let cursor = 0;

  const resolveOne = (id: string): Promise<Song> => {
    const key = `${cachePrefix}${id}`;
    const cached = songCache.get(key);
    if (cached) return Promise.resolve(cached);
    const pending = songRequests.get(key);
    if (pending) return pending;
    const request = getSong(auth, id)
      .then((song) => {
        songCache.set(key, song);
        return song;
      })
      .finally(() => {
        if (songRequests.get(key) === request) songRequests.delete(key);
      });
    songRequests.set(key, request);
    return request;
  };

  const worker = async () => {
    while (cursor < songIds.length) {
      const index = cursor++;
      songs[index] = await resolveOne(songIds[index]);
    }
  };

  try {
    await Promise.all(
      Array.from({ length: Math.min(8, songIds.length) }, () => worker()),
    );
    return songs;
  } catch {
    throw new Error('One or more tracks in this Jam are unavailable to this profile');
  }
}

async function applyGuestState(
  state: ListeningSessionPlaybackState,
  forceReconcile = false,
): Promise<void> {
  const auth = sessionAuth;
  if (!auth) return;
  const activeRoom = useListeningSession.getState().room;
  if (!activeRoom || activeRoom.role !== 'guest') return;
  const generation = connectionGeneration;
  const roomId = activeRoom.id;
  const revisionIsCurrent = () => state.revision >= latestGuestRevision;
  const stillCurrent = () => {
    const current = useListeningSession.getState();
    return (
      connectionGeneration === generation &&
      sessionAuth === auth &&
      current.room?.id === roomId &&
      current.room.role === 'guest' &&
      (current.status === 'connected' || current.status === 'leaving')
    );
  };
  const stillApplicable = () => stillCurrent() && revisionIsCurrent();
  if (!revisionIsCurrent()) return;
  const previousGuestState = lastGuestState;
  if (!forceReconcile) {
    if (lastGuestState && state.revision <= lastGuestState.revision) return;
    lastGuestState = state;
  }
  if (!clockReady) return;

  if (state.songIds.length === 0) {
    if (!stillApplicable()) return;
    await withListeningSessionBypass(async () => {
      if (!stillApplicable()) return;
      await usePlayerStore.getState().stopAndClear();
    });
    return;
  }

  const player = usePlayerStore.getState();
  const queueChanged =
    player.queue.length !== state.songIds.length ||
    player.queue.some((song, index) => song.id !== state.songIds[index]);
  const targetMs = projectedListeningPositionMs(state, clock.serverNow());
  const stateHasDiscontinuity = listeningSessionStateHasDiscontinuity(
    previousGuestState,
    state,
  );
  const pendingTransport = pendingGuestTransport;
  const waitingForTransportAck =
    !!pendingTransport && state.revision <= pendingTransport.afterRevision;
  const forceTransport =
    !!pendingTransport && state.revision > pendingTransport.afterRevision;
  if (forceTransport) clearPendingGuestTransport();

  if (queueChanged || player.index !== state.currentIndex) {
    let songs: Song[];
    if (!queueChanged) {
      // A skip/jump within the identical queue needs no library lookup at all.
      songs = player.queue;
    } else {
      try {
        songs = await resolveSongs(auth, state.songIds, player.queue);
      } catch {
        if (!stillApplicable()) return;
        // A missing track affects playback, not room membership. Stay joined
        // so a transient server failure can recover on a later heartbeat and
        // so the guest can follow the host to another available queue.
        await withListeningSessionBypass(() => {
          usePlayerStore.getState().setPlayingForListeningSession(false);
        });
        useListeningSession.setState({
          error: 'One or more tracks in this Jam are unavailable to this profile',
        });
        return;
      }
    }
    if (!stillApplicable()) return;
    // A newer state may have arrived while song metadata was loading.
    if (!forceReconcile && lastGuestState !== state) return;
    await withListeningSessionBypass(async () => {
      if (!stillApplicable()) return;
      await usePlayerStore
        .getState()
        .replaceQueueForListeningSession(
          songs,
          state.currentIndex,
          targetMs / 1000,
          state.isPlaying,
          stillApplicable,
        );
    });
    lastGuestCorrectionAt = Date.now();
    if (stillApplicable()) useListeningSession.setState({ error: null });
    return;
  }

  await withListeningSessionBypass(async () => {
    if (!stillApplicable()) return;
    let current = usePlayerStore.getState();
    // A remote pause is transport state, not an in-app gesture. Apply it
    // immediately so a backgrounded timer or the drift seek below cannot
    // cancel the fade before its native pause callback runs.
    if (!waitingForTransportAck && !state.isPlaying) {
      current.setPlayingForListeningSession(false);
    }
    current = usePlayerStore.getState();
    const now = Date.now();
    const correctionIsReady =
      forceReconcile ||
      stateHasDiscontinuity ||
      now - lastGuestCorrectionAt >= LISTENING_SESSION_CORRECTION_COOLDOWN_MS;
    if (
      !current.isBuffering &&
      // The UI store advances on a 500 ms status interval. Comparing that
      // cached value with a real-time room projection makes a healthy player
      // appear over the 250 ms limit on roughly every other heartbeat, which
      // repeatedly flushes Media3's progressive decoder. Sample the native
      // playhead at the same moment as the projected target instead.
      shouldReconcileListeningPosition(currentPlaybackPositionSec() * 1000, targetMs) &&
      correctionIsReady
    ) {
      lastGuestCorrectionAt = now;
      await current.seekForListeningSession(targetMs / 1000);
      if (!stillApplicable()) return;
    }
    current = usePlayerStore.getState();
    if (
      !waitingForTransportAck &&
      state.isPlaying &&
      (forceTransport || !current.isPlaying)
    ) {
      current.setPlayingForListeningSession(true);
    }
  });
}

function updateRoom(patch: Partial<ListeningSessionRoom>): void {
  const room = useListeningSession.getState().room;
  if (room) useListeningSession.setState({ room: { ...room, ...patch } });
}

async function handleServerMessage(message: ListeningSessionServerMessage): Promise<void> {
  switch (message.type) {
    case 'authenticated':
      useListeningSession.setState({
        status: 'connected',
        room: message.room,
        error: null,
      });
      startHeartbeat();
      if (message.room.role === 'guest') {
        await applyGuestState(message.room.state);
        clockFallback = setTimeout(() => {
          clockFallback = null;
          if (clockReady || !lastGuestState) return;
          // Protocol-compliant coordinators answer immediately. If one does
          // not, fall back to the device clock instead of hanging forever.
          clockReady = true;
          void applyGuestState(lastGuestState, true);
        }, 1000);
      }
      break;
    case 'clock.pong':
      {
        const firstClockSample = !clockReady;
        clock.addSample(
          message.clientTimestamp,
          message.serverReceivedTimestamp,
          message.serverSentTimestamp,
          Date.now(),
        );
        clockReady = true;
        if (clockFallback) clearTimeout(clockFallback);
        clockFallback = null;
        // The authenticated state waits for this first offset. Later samples
        // are consumed by the next host state heartbeat; immediately replaying
        // the same state here would race that heartbeat and double the number
        // of corrective seeks without adding synchronization information.
        if (firstClockSample && lastGuestState) {
          await applyGuestState(lastGuestState, true);
        }
      }
      break;
    case 'state': {
      const room = useListeningSession.getState().room;
      if (!room) break;
      updateRoom({ state: message.state });
      if (room.role === 'guest') await applyGuestState(message.state);
      break;
    }
    case 'control.request':
      if (useListeningSession.getState().room?.role === 'host') {
        applyHostControl(message.control);
      }
      break;
    case 'participants':
      updateRoom({ participants: message.participants });
      break;
    case 'session.left':
      if (
        lifecycleRequest?.kind !== 'leave' ||
        lifecycleRequest.requestId !== message.requestId
      ) {
        break;
      }
      settleLifecycle();
      clearConnection();
      useListeningSession.setState({ status: 'idle', room: null, error: null });
      break;
    case 'session.ended':
      {
        const requestedByThisClient =
          lifecycleRequest?.kind === 'end' &&
          lifecycleRequest.requestId === message.requestId;
        settleLifecycle();
        clearConnection();
        useListeningSession.setState({
          status: 'idle',
          room: null,
          error: requestedByThisClient ? null : 'The Jam ended',
        });
      }
      break;
    case 'error': {
      const lifecycleError =
        lifecycleRequest && message.requestId === lifecycleRequest.requestId
        ? new Error(message.message)
        : null;
      if (lifecycleError) settleLifecycle(lifecycleError);
      if (pendingGuestTransport?.requestId === message.requestId) {
        clearPendingGuestTransport();
        if (lastGuestState) void applyGuestState(lastGuestState, true);
      }
      const current = useListeningSession.getState();
      useListeningSession.setState({
        status: lifecycleError && current.room ? 'connected' : current.status,
        error: message.message,
      });
      break;
    }
  }
}

function startHeartbeat(): void {
  if (heartbeat) clearInterval(heartbeat);
  const beat = () => {
    send({
      type: 'clock.ping',
      protocolVersion: 1,
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      clientTimestamp: Date.now(),
    });
    publishHostState();
  };
  beat();
  heartbeat = setInterval(beat, LISTENING_SESSION_HEARTBEAT_MS);
}

function connect(
  access: ListeningSessionAccess,
  auth: SubsonicAuth,
  coordinatorUrl: string,
  libraryId: string,
): Promise<void> {
  clearConnection();
  if (!isSafeListeningSessionConnectionUrl(access.connectionUrl, coordinatorUrl)) {
    return Promise.reject(new Error('The coordinator returned an unsafe Jam connection URL'));
  }
  sessionAuth = auth;
  sessionCoordinatorUrl = coordinatorUrl;
  sessionLibraryId = libraryId;
  useListeningSession.setState({ status: 'connecting', room: access.room, error: null });

  return new Promise((resolve, reject) => {
    let settled = false;
    let messageQueue: Promise<void> = Promise.resolve();
    let pendingStateMessage: Extract<
      ListeningSessionServerMessage,
      { type: 'state' }
    > | null = null;
    let stateCoalesceTimer: ReturnType<typeof setTimeout> | null = null;
    const nextSocket = new WebSocket(access.connectionUrl);
    const authTimeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      nextSocket.close(1008, 'authentication timeout');
      reject(new Error('Could not authenticate with the Jam'));
    }, SOCKET_AUTH_TIMEOUT_MS);
    const rejectOnce = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(authTimeout);
      reject(error);
    };
    const enqueueMessage = (message: ListeningSessionServerMessage) => {
      // WebSocket frames are ordered, but async metadata/source work must not
      // overlap. State bursts are reduced before entering this queue below;
      // all remaining protocol messages retain their wire order here.
      messageQueue = messageQueue
        .then(async () => {
          if (socket !== nextSocket) return;
          await handleServerMessage(message);
          if (socket !== nextSocket) return;
          if (message.type === 'error') {
            rejectOnce(new Error(message.message));
          } else if (message.type === 'authenticated' && !settled) {
            settled = true;
            clearTimeout(authTimeout);
            resolve();
          }
        })
        .catch((cause) => {
          if (socket !== nextSocket) return;
          const error =
            cause instanceof Error
              ? cause
              : new Error('The Jam coordinator sent an invalid message');
          clearConnection();
          useListeningSession.setState({ status: 'error', room: null, error: error.message });
          rejectOnce(error);
        });
    };
    const scheduleLatestState = (
      message: Extract<ListeningSessionServerMessage, { type: 'state' }>,
    ) => {
      pendingStateMessage = message;
      if (stateCoalesceTimer) clearTimeout(stateCoalesceTimer);
      stateCoalesceTimer = setTimeout(() => {
        stateCoalesceTimer = null;
        const latest = pendingStateMessage;
        pendingStateMessage = null;
        if (latest) enqueueMessage(latest);
      }, STATE_BURST_COALESCE_MS);
    };
    socket = nextSocket;
    nextSocket.onopen = () => {
      if (socket !== nextSocket) {
        nextSocket.close(1000, 'superseded');
        return;
      }
      nextSocket.send(
        JSON.stringify({
          type: 'authenticate',
          protocolVersion: 1,
          connectionToken: access.connectionToken,
        }),
      );
    };
    nextSocket.onmessage = (event) => {
      let decoded: unknown;
      try {
        decoded = JSON.parse(String(event.data));
      } catch {
        const error = new Error('The Jam coordinator sent an invalid message');
        clearConnection();
        useListeningSession.setState({ status: 'error', room: null, error: error.message });
        rejectOnce(error);
        return;
      }
      if (
        typeof decoded !== 'object' ||
        decoded === null ||
        !('type' in decoded) ||
        typeof decoded.type !== 'string' ||
        !('protocolVersion' in decoded) ||
        decoded.protocolVersion !== 1
      ) {
        const error = new Error('The Jam coordinator sent an invalid message');
        clearConnection();
        useListeningSession.setState({ status: 'error', room: null, error: error.message });
        rejectOnce(error);
        return;
      }
      if (!isKnownListeningSessionServerMessageType(decoded.type)) return;
      if (!isListeningSessionServerMessage(decoded)) {
        const error = new Error('The Jam coordinator sent an invalid message');
        clearConnection();
        useListeningSession.setState({ status: 'error', room: null, error: error.message });
        rejectOnce(error);
        return;
      }
      const message: ListeningSessionServerMessage = decoded;
      // A burst of host changes can arrive while an older source is still
      // resolving. Record the newest revision before entering the serial
      // handler queue so obsolete revisions become no-ops instead of forcing
      // every intermediate track through Media3.
      if (message.type === 'authenticated') {
        latestGuestRevision = Math.max(latestGuestRevision, message.room.state.revision);
      } else if (message.type === 'state') {
        latestGuestRevision = Math.max(latestGuestRevision, message.state.revision);
      }
      if (message.type === 'state') {
        scheduleLatestState(message);
        return;
      }
      enqueueMessage(message);
    };
    nextSocket.onerror = () => {
      rejectOnce(new Error('Could not connect to the Jam'));
    };
    nextSocket.onclose = (event) => {
      clearTimeout(authTimeout);
      if (stateCoalesceTimer) clearTimeout(stateCoalesceTimer);
      stateCoalesceTimer = null;
      pendingStateMessage = null;
      if (socket !== nextSocket) return;
      clearConnection();
      const normal = event.code === 1000;
      useListeningSession.setState({
        status: normal ? 'idle' : 'error',
        room: null,
        error: normal ? null : 'The Jam connection was lost',
      });
      rejectOnce(new Error('Could not connect to the Jam'));
    };
  });
}

export function listeningSessionServerMatches(auth: SubsonicAuth, sharedServer: string): boolean {
  try {
    const shared = normalizeListeningSessionServerUrl(decodeURIComponent(sharedServer));
    return serverCandidates(auth).some(
      (candidate) => normalizeListeningSessionServerUrl(normalizeUrl(candidate)) === shared,
    );
  } catch {
    return false;
  }
}

export function initListeningSessionIntegration(): void {
  if (initialized) return;
  initialized = true;
  registerListeningSessionBridge(requestControl, () => {
    const { room, status } = useListeningSession.getState();
    return (status === 'connected' || status === 'leaving') && room?.role === 'guest';
  });

  let lastPlayerSignature = '';
  usePlayerStore.subscribe((player) => {
    const signature = `${player.queue.map((song) => song.id).join('\u0000')}|${player.index}|${player.isPlaying}`;
    if (signature === lastPlayerSignature) return;
    lastPlayerSignature = signature;
    scheduleHostPublish();
  });

  let lastProfile = profileKey(useAuthStore.getState().auth);
  useAuthStore.subscribe((authState) => {
    const nextProfile = profileKey(authState.auth);
    if (nextProfile === lastProfile && !authState.offline) return;
    lastProfile = nextProfile;
    supportCoordinator = '';
    useListeningSession.setState({ supported: null });
    if (useListeningSession.getState().room) {
      clearConnection();
      useListeningSession.setState({ status: 'idle', room: null, error: null });
    }
  });
  void useListeningSession.getState().hydrateCoordinator();
}

export const useListeningSession = create<ListeningSessionStore>((set, get) => ({
  status: 'idle',
  supported: null,
  room: null,
  error: null,
  coordinatorUrl: '',
  coordinatorHydrated: false,

  setCoordinatorUrl: (value) => {
    const coordinatorUrl = value.trim();
    supportCoordinator = '';
    set({ coordinatorUrl, supported: null });
    void setItem(COORDINATOR_STORAGE_KEY, coordinatorUrl);
  },

  hydrateCoordinator: async () => {
    if (get().coordinatorHydrated) return;
    if (coordinatorHydration) return coordinatorHydration;
    coordinatorHydration = getItem(COORDINATOR_STORAGE_KEY)
      .then((saved) => {
        set({ coordinatorUrl: saved?.trim() ?? '', coordinatorHydrated: true });
      })
      .catch(() => {
        set({ coordinatorHydrated: true });
      })
      .finally(() => {
        coordinatorHydration = null;
      });
    return coordinatorHydration;
  },

  checkSupport: async (rawCoordinatorUrl, force = false) => {
    activeOnlineAuth();
    let coordinatorUrl: string;
    try {
      coordinatorUrl = requiredCoordinatorUrl(rawCoordinatorUrl ?? get().coordinatorUrl);
    } catch (error) {
      set({
        supported: null,
        status: 'error',
        error: error instanceof Error ? error.message : 'Enter a valid Jam coordinator URL',
      });
      return false;
    }
    if (!force && supportCoordinator === coordinatorUrl && get().supported !== null) {
      return get().supported === true;
    }
    set({ status: 'checking', error: null });
    try {
      await getListeningSessionCapabilities(coordinatorUrl);
      supportCoordinator = coordinatorUrl;
      set({ supported: true, status: 'idle' });
      return true;
    } catch (error) {
      set({
        status: 'error',
        error: error instanceof Error ? error.message : 'Could not check Jam support',
      });
      return false;
    }
  },

  start: () =>
    runRoomOperation(async () => {
      const auth = activeOnlineAuth();
      const coordinatorUrl = requiredCoordinatorUrl(get().coordinatorUrl);
      const supported = await get().checkSupport(coordinatorUrl);
      if (!supported) throw new Error('This Jam coordinator is unavailable');
      const player = usePlayerStore.getState();
      if (player.queue.length === 0) throw new Error('Play something before starting a Jam.');
      if (!player.queue.every(isListeningSessionServerTrack)) {
        throw new Error('A Jam can only include tracks from this OpenSubsonic server');
      }
      set({ status: 'connecting', error: null });
      try {
        const libraryId = await createOpenSubsonicLibraryId(auth.serverUrl);
        const access = await createListeningSession(
          coordinatorUrl,
          { name: 'opensubsonic', version: 1, libraryId },
          auth.username,
        );
        await connect(access, auth, coordinatorUrl, libraryId);
      } catch (error) {
        clearConnection();
        const message = error instanceof Error ? error.message : 'Could not start the Jam';
        set({ status: 'error', room: null, error: message });
        throw error;
      }
    }),

  join: (rawCode, target) =>
    runRoomOperation(async () => {
      const auth = activeOnlineAuth();
      if (target && !listeningSessionServerMatches(auth, target.serverUrl)) {
        throw new Error(
          'This Jam belongs to a different server. Switch to its Resonus profile first.',
        );
      }
      const coordinatorUrl = requiredCoordinatorUrl(
        target?.coordinatorUrl ?? get().coordinatorUrl,
      );
      const supported = await get().checkSupport(coordinatorUrl);
      if (!supported) throw new Error('This Jam coordinator is unavailable');
      const code = normalizeListeningSessionCode(rawCode);
      if (code.length < 4) throw new Error('Enter a valid Jam code');
      set({ status: 'connecting', error: null });
      try {
        const fingerprintedServer = target?.serverUrl ?? auth.serverUrl;
        const calculatedLibraryId = await createOpenSubsonicLibraryId(fingerprintedServer);
        if (target && calculatedLibraryId !== target.libraryId) {
          throw new Error('The Jam invitation has an invalid library ID');
        }
        const libraryId = target?.libraryId ?? calculatedLibraryId;
        const access = await joinListeningSession(
          coordinatorUrl,
          code,
          { name: 'opensubsonic', version: 1, libraryId },
          auth.username,
        );
        await connect(access, auth, coordinatorUrl, libraryId);
      } catch (error) {
        clearConnection();
        const message = error instanceof Error ? error.message : 'Could not join the Jam';
        set({ status: 'error', room: null, error: message });
        throw error;
      }
    }),

  leave: () =>
    runRoomOperation(async () => {
      const room = get().room;
      if (!room || room.role !== 'guest') return;
      set({ status: 'leaving', error: null });
      try {
        await requestLifecycle('leave');
      } catch (error) {
        if (get().room?.id === room.id) {
          set({
            status: 'connected',
            error: error instanceof Error ? error.message : 'Could not leave the Jam',
          });
        }
        throw error;
      }
    }),

  end: () =>
    runRoomOperation(async () => {
      const room = get().room;
      if (!room || room.role !== 'host') return;
      set({ status: 'leaving', error: null });
      try {
        await requestLifecycle('end');
      } catch (error) {
        if (get().room?.id === room.id) {
          set({
            status: 'connected',
            error: error instanceof Error ? error.message : 'Could not end the Jam',
          });
        }
        throw error;
      }
    }),

  shareInvite: () => {
    const room = get().room;
    if (
      !room ||
      room.role !== 'host' ||
      !sessionAuth ||
      !sessionCoordinatorUrl ||
      !sessionLibraryId
    ) {
      return null;
    }
    // The room was created through the active URL. Sharing a different profile
    // alias could point another client at an origin where this room does not
    // exist, even when both aliases normally reach the same music library.
    const server = normalizeListeningSessionServerUrl(normalizeUrl(sessionAuth.serverUrl));
    const invite = createListeningSessionInvite(
      sessionCoordinatorUrl,
      server,
      sessionLibraryId,
      room.code,
    );
    return {
      invite,
      appUrl: listeningSessionInviteUrl(invite),
    };
  },

  clearError: () => set({ error: null, status: get().room ? get().status : 'idle' }),
}));
