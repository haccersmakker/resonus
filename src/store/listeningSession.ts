/**
 * Listening together: a room on an Open Listening Sessions coordinator, and
 * what this phone does about it.
 *
 * The host's player is the room. It says what it is doing whenever that
 * changes and every few seconds besides, and every guest makes its own player
 * agree: the same songs, fetched from its own account on the same server, at
 * the same second. A guest's buttons are requests the host carries out; the
 * host's answer is the next state, which is the only thing a guest obeys.
 *
 * Each guest's music stays the guest's own business in two ways. A guest that
 * stops on its own (headphones out, a call, the sleep timer, the
 * notification's pause) is left stopped while the room plays on, and catches
 * up when it plays again. And nothing a guest's phone does by itself, like
 * crossfading early or growing a mix, gets to move it off the room's queue.
 */
import { AppState } from 'react-native';
import { create } from 'zustand';

import { getSong, type Song, type SubsonicAuth } from '@/api/subsonic';
import { createOlsRoom, getOlsCapabilities, joinOlsRoom, olsLibraryId } from '@/api/listeningSessions';
import { tg } from '@/i18n';
import { registerOlsPlayerHooks } from '@/lib/listeningSessionBridge';
import {
  OlsConnection,
  OlsConnectionError,
  type OlsSocket,
} from '@/lib/listeningSessionConnection';
import {
  OLS_CORRECTION_COOLDOWN_MS,
  OLS_DRIFT_MS,
  OLS_HEARTBEAT_MS,
  OLS_MAX_NAME_CHARS,
  OLS_MAX_SONGS,
  createOlsInvite,
  isOlsCode,
  isOlsServerSong,
  normalizeOlsCode,
  normalizeOlsCoordinatorUrl,
  normalizeOlsServerUrl,
  olsInviteLink,
  olsPositionJumped,
  olsRequestId,
  olsStateIsDiscontinuous,
  planOlsGuest,
  projectOlsPosition,
  type OlsAccess,
  type OlsControl,
  type OlsHostState,
  type OlsInvite,
  type OlsPlaybackState,
  type OlsRole,
  type OlsRoom,
  type OlsServerMessage,
} from '@/lib/listeningSessions';
import { bump, note } from '@/lib/perfLog';
import { isLanUrl, primaryUrl } from '@/lib/serverUrls';
import { getItem, setItem } from '@/lib/storage';
import { useAuthStore } from './auth';
import { isJukeboxActive } from './jukebox';
import {
  livePositionSec,
  olsAdopt,
  olsClear,
  olsInstall,
  olsPlayerReady,
  olsRestoreModes,
  olsSeek,
  olsSeekIsLocal,
  olsSetPlaying,
  currentSong,
  usePlayerStore,
  type RepeatMode,
} from './player';
import { useToast } from './toast';
import { isUpnpConnected } from './upnp';

type Status = 'idle' | 'starting' | 'joining' | 'connected' | 'leaving';

interface ListeningSessionState {
  status: Status;
  room: OlsRoom | null;
  /** English text, translated where it is shown. */
  error: string | null;
  /** The coordinator this person uses, as they typed it (checked when used). */
  coordinatorUrl: string;
  /** What the others see this person called. Not the server's user name. */
  displayName: string;
  hydrated: boolean;
  /** A guest that stopped on its own while the room plays on. */
  heldLocally: boolean;
  /** The last room joined as a guest, for joining it again after losing it. */
  lastJoin: { code: string } | { invite: OlsInvite } | null;
  hydrate: () => Promise<void>;
  setCoordinatorUrl: (url: string) => void;
  setDisplayName: (name: string) => void;
  start: () => Promise<void>;
  join: (target: { code: string } | { invite: OlsInvite }) => Promise<void>;
  leave: () => Promise<void>;
  /** The room's invite, for anybody in it to pass on. */
  invite: () => { invite: OlsInvite; link: string } | null;
  clearError: () => void;
}

const STORAGE_KEY = 'resonus.listening.v1';

// ── Errors, in words ────────────────────────────────────────────────────────

/**
 * What to tell somebody about a failure. Coordinator codes this client knows
 * get a sentence each; anything else is the generic one, since a code nobody
 * has explained is no use on screen.
 */
function messageFor(e: unknown): string {
  const code = e instanceof OlsConnectionError ? e.code : e instanceof Error ? e.message : '';
  switch (code) {
    case 'room_not_found':
    case 'not_found':
    case 'http_404':
      return 'No room with that code. Check it and try again.';
    case 'room_full':
      return 'That room is full.';
    case 'library_mismatch':
      return 'That room plays from another server. Switch to that server’s profile first.';
    case 'rate_limited':
    case 'http_429':
      return 'Too many attempts. Wait a moment and try again.';
    case 'address':
      return 'Enter the address of a listening server.';
    case 'unsupported':
      return 'That server doesn’t speak Open Listening Sessions 1.';
    case 'timeout':
    case 'unreachable':
    case 'lost':
      return 'Couldn’t reach the listening server.';
    case 'invalid':
    case 'unsafe':
      return 'The listening server sent something unexpected.';
    case 'invite':
      return 'That invitation isn’t valid.';
    case 'online':
      return 'Listening together needs a Subsonic server and a connection.';
    case 'casting':
      return 'Stop casting before listening together.';
    case 'speed':
      return 'Set the playback speed back to 1× before listening together.';
    case 'songs':
      return 'Only songs from your server can be played while listening together';
    default:
      return 'Something went wrong with the listening room.';
  }
}

const fail = (code: string) => new OlsConnectionError(code, code);

// ── The session ─────────────────────────────────────────────────────────────

interface Session {
  connection: OlsConnection;
  auth: SubsonicAuth;
  profile: string;
  coordinatorUrl: string;
  serverUrl: string;
  libraryId: string;
  code: string;
  /** The coordinator's limit on a state, so a long queue is sent in part. */
  stateBytes: number;
}

let session: Session | null = null;
let clockReady = false;
/** How a guest was listening before the room took over its player. */
let guestModes: { shuffle: boolean; repeat: RepeatMode } | null = null;

/** The profile a room was joined with: another one is another library. */
function profileOf(auth: SubsonicAuth | null): string {
  return auth ? `${primaryUrl(auth)}|${auth.username}` : '';
}

function requireServer(): SubsonicAuth {
  const { auth, offline } = useAuthStore.getState();
  if (!auth || offline || auth.serverType === 'jellyfin') throw fail('online');
  if (isUpnpConnected() || isJukeboxActive()) throw fail('casting');
  if (usePlayerStore.getState().speed !== 1) throw fail('speed');
  return auth;
}

/**
 * The profile's addresses, the one most likely to be shared with others first:
 * a public name before a home network's. Somebody joining from elsewhere has
 * the domain in their profile, and somebody in the same room usually does too.
 */
function serverCandidates(auth: SubsonicAuth): string[] {
  const all = [...new Set([auth.serverUrl, ...(auth.urls ?? [])])]
    .map((u) => normalizeOlsServerUrl(u))
    .filter((u): u is string => !!u);
  return [...new Set([...all.filter((u) => !isLanUrl(u)), ...all.filter((u) => isLanUrl(u))])];
}

function socketFactory(url: string): OlsSocket {
  return new WebSocket(url) as unknown as OlsSocket;
}

function role(): OlsRole | null {
  const { status, room } = useListeningSession.getState();
  return room && (status === 'connected' || status === 'leaving') ? room.role : null;
}

function updateRoom(patch: Partial<OlsRoom>): void {
  const room = useListeningSession.getState().room;
  if (room) useListeningSession.setState({ room: { ...room, ...patch } });
}

/** Ends this phone's part in the room, however that came about. */
function finish(error: string | null): void {
  const s = session;
  session = null;
  clockReady = false;
  guest.reset();
  host.reset();
  s?.connection.close();
  const wasGuest = useListeningSession.getState().room?.role === 'guest';
  useListeningSession.setState({ status: 'idle', room: null, heldLocally: false, error });
  // The room's music stops with the room for a guest: carrying on alone
  // through somebody else's queue is not what leaving means. The host's
  // carries on, since it was the host's to begin with.
  if (wasGuest && usePlayerStore.getState().isPlaying) olsSetPlaying(false);
  if (wasGuest && guestModes) olsRestoreModes(guestModes);
  guestModes = null;
}

async function connect(access: OlsAccess, ctx: Omit<Session, 'connection'>): Promise<void> {
  const connection: OlsConnection = new OlsConnection(access, ctx.coordinatorUrl, socketFactory, {
    onMessage: (m): Promise<void> => onMessage(connection, m),
    onClockReady: () => {
      if (session?.connection !== connection) return;
      clockReady = true;
      if (role() === 'guest') return guest.schedule(true);
    },
    onHeartbeat: () => {
      if (session?.connection === connection && role() === 'host') host.publishIfDue();
    },
    onClose: (reason) => {
      if (session?.connection !== connection) return;
      bump(`listening · closed (${reason})`);
      finish(
        reason === 'closed'
          ? 'The listening room closed.'
          : 'Lost the connection to the listening room.',
      );
    },
    onFault: (e) => note(`listening · fault: ${e instanceof Error ? e.message : String(e)}`),
  });
  session = { ...ctx, connection };
  await connection.open();
}

async function onMessage(connection: OlsConnection, m: OlsServerMessage): Promise<void> {
  if (session?.connection !== connection) return;
  switch (m.type) {
    case 'authenticated':
      useListeningSession.setState({ status: 'connected', room: m.room, error: null });
      bump(`listening · in as ${m.room.role}`);
      if (m.room.role === 'host') {
        // The room is opened empty, and it is the host's queue from now on.
        host.publish();
      } else {
        const { shuffle, repeat } = usePlayerStore.getState();
        guestModes = { shuffle, repeat };
        guest.received(m.room.state);
        await guest.schedule(true);
      }
      return;
    case 'state':
      updateRoom({ state: m.state });
      if (role() === 'guest') {
        guest.received(m.state);
        await guest.schedule(false);
      }
      return;
    case 'control.request':
      if (role() === 'host') host.apply(m.participantId, m.control);
      return;
    case 'participants':
      updateRoom({ participants: m.participants });
      return;
    case 'session.left':
      finish(null);
      return;
    case 'session.ended':
      finish(role() === 'guest' ? 'The host ended the room.' : null);
      return;
    case 'error':
      bump(`listening · error ${m.code}`);
      guest.refused(m.requestId);
      useListeningSession.setState({ error: messageFor(fail(m.code)) });
      // Whatever was refused was asked from some screen, maybe not this one.
      useToast.getState().show(tg(messageFor(fail(m.code))));
      return;
  }
}

// ── Host ────────────────────────────────────────────────────────────────────

const host = (() => {
  let last: { at: number; positionMs: number; isPlaying: boolean } | null = null;
  /** Where the published window starts in the queue (see `window`). */
  let offset = 0;
  let queued = false;
  /**
   * When the host's player last said it stopped, if that has not been told
   * yet. A player between two sources reads as stopped for a moment (the end
   * of a song, a stream not started), and a room told so pauses everybody and
   * starts them again a beat later. A stop is only news once it has lasted.
   */
  let stoppedAt = 0;
  let stoppedTimer: ReturnType<typeof setTimeout> | null = null;
  const STOP_SETTLE_MS = 450;

  /**
   * The queue as the room gets it. All of it, unless it is longer than a room
   * holds: then a window around the song playing, with more ahead than behind.
   */
  function window(ids: string[], index: number, maxBytes: number): { ids: string[]; start: number } {
    let size = Math.min(ids.length, OLS_MAX_SONGS);
    for (;;) {
      const start = Math.max(0, Math.min(index - Math.floor(size / 4), ids.length - size));
      const slice = ids.slice(start, start + size);
      // Each id costs its length and three characters of JSON around it; the
      // rest of the message is well inside the margin.
      const bytes = slice.reduce((n, id) => n + id.length + 3, 256);
      if (size <= 1 || bytes <= maxBytes) return { ids: slice, start };
      size = Math.floor(size / 2);
    }
  }

  function state(s: Session): OlsHostState {
    const st = usePlayerStore.getState();
    const ids = st.queue.map((x) => x.id);
    const index = Math.min(st.index, Math.max(0, ids.length - 1));
    const w = window(ids, index, s.stateBytes);
    offset = w.start;
    return {
      songIds: w.ids,
      currentIndex: w.ids.length === 0 ? 0 : index - w.start,
      positionMs: Math.max(0, Math.round(livePositionSec() * 1000)),
      isPlaying: st.isPlaying || stoppedAt > 0,
    };
  }

  function publish(): void {
    const s = session;
    if (!s || role() !== 'host') return;
    // Signing out empties the queue on its way, and that is not a thing to
    // tell a room that is about to end anyway.
    if (profileOf(useAuthStore.getState().auth) !== s.profile) return;
    // The player refuses a host other songs only once it is one, so a station
    // or a phone file started while the room was opening ends up here. Its ids
    // mean nothing on the guests' servers: the room ends instead.
    if (!usePlayerStore.getState().queue.every(isOlsServerSong)) {
      if (useListeningSession.getState().status !== 'connected') return;
      void useListeningSession
        .getState()
        .leave()
        .then(() => {
          const error = messageFor(fail('songs'));
          useListeningSession.setState({ error });
          useToast.getState().show(tg(error));
        });
      return;
    }
    const st = state(s);
    if (s.connection.send({ type: 'state.update', protocolVersion: 1, state: st })) {
      last = { at: Date.now(), positionMs: st.positionMs, isPlaying: st.isPlaying };
    }
  }

  return {
    publish,
    /** Once per tick at most: five changes in one go are one message. */
    soon(): void {
      if (queued) return;
      queued = true;
      // A microtask and not a timer: timers stop with the screen off.
      void Promise.resolve().then(() => {
        queued = false;
        publish();
      });
    },
    /**
     * The heartbeat. Not while the host's own stream is stalled: its position
     * standing still would pull every guest back every few seconds. They play
     * on, and the first beat after the stall puts them back with it, once.
     */
    publishIfDue(): void {
      if (last && usePlayerStore.getState().isBuffering) return;
      if (!last || Date.now() - last.at >= OLS_HEARTBEAT_MS - 200) publish();
    },
    /** The player says it started or stopped. */
    transport(playing: boolean): void {
      if (stoppedTimer) clearTimeout(stoppedTimer);
      stoppedTimer = null;
      if (playing) {
        // Told even when the stop never was: the second it started from is
        // what the room needs to be on the beat.
        stoppedAt = 0;
        this.soon();
        return;
      }
      stoppedAt = Date.now();
      // The status beats tell it too (`settleStop`), with the screen off where
      // this timer may not run.
      stoppedTimer = setTimeout(() => this.settleStop(), STOP_SETTLE_MS);
    },
    /** A stop that has lasted is told to the room. */
    settleStop(): void {
      if (!stoppedAt || Date.now() - stoppedAt < STOP_SETTLE_MS) return;
      if (usePlayerStore.getState().isPlaying) return;
      stoppedAt = 0;
      publish();
    },
    /** The player moved on its own: a seek from outside the app, a song repeating. */
    checkJump(): void {
      if (!last || usePlayerStore.getState().isBuffering) return;
      const now = Date.now();
      if (olsPositionJumped(last, livePositionSec() * 1000, now)) this.soon();
    },
    apply(participantId: string, control: OlsControl): void {
      const room = useListeningSession.getState().room;
      if (!room?.participants.some((p) => p.id === participantId && p.role === 'guest')) return;
      bump(`listening · request ${control.action}`);
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
          player.jumpTo(control.index + offset);
          break;
      }
      // A stop asked for is no transient: told now, with nothing to settle.
      if (control.action === 'pause' || control.action === 'play') {
        stoppedAt = 0;
        if (stoppedTimer) clearTimeout(stoppedTimer);
        stoppedTimer = null;
      }
      // Even when nothing changed (play on a room already playing): the guest
      // that asked is waiting on a new revision to know it was heard.
      this.soon();
    },
    reset(): void {
      last = null;
      offset = 0;
      stoppedAt = 0;
      if (stoppedTimer) clearTimeout(stoppedTimer);
      stoppedTimer = null;
    },
  };
})();

// ── Guest ───────────────────────────────────────────────────────────────────

const guest = (() => {
  /** The newest state received. */
  let latest: OlsPlaybackState | null = null;
  /** The last state acted on, to tell what the host did from time passing. */
  let applied: OlsPlaybackState | null = null;
  let lastCorrectionAt = 0;
  /** Until when what the player reports is this store's own doing. */
  let quietUntil = 0;
  /** A play or pause this guest asked for and has not seen answered. */
  let pending: { requestId: string; afterRevision: number; timer: ReturnType<typeof setTimeout> } | null =
    null;
  let chain: Promise<void> = Promise.resolve();
  let queued = false;
  let forceNext = false;
  /** Song details, by id, for this room. */
  const songs = new Map<string, Song>();
  const lookups = new Map<string, Promise<Song | null>>();
  /**
   * When a song that could not be had is worth asking for again. Without it a
   * room with songs this account lacks asked for every one of them on every
   * heartbeat, for as long as the room lasted.
   */
  const missing = new Map<string, number>();
  let lookupFailed = false;

  const quiet = (ms = 2000) => {
    quietUntil = Date.now() + ms;
  };

  /**
   * How long this phone's player takes from being told to play to sounding,
   * learned from each start: aiming that far ahead is what keeps a guest from
   * landing a fixed fifth of a second behind the room every time, which is
   * under the drift that would ever correct it. Never a speed change.
   */
  let leadMs = 0;
  let calibrated = false;

  function serverNow(): number {
    return session ? session.connection.clock.serverNow(Date.now()) : Date.now();
  }

  /**
   * The details of a song the room names, from this person's own account.
   * Each id is asked for once, however many states name it, and a failure is
   * not kept: the next heartbeat asks again.
   */
  function lookup(s: Session, id: string): Promise<Song | null> {
    const known = songs.get(id);
    if (known) return Promise.resolve(known);
    const inFlight = lookups.get(id);
    if (inFlight) return inFlight;
    if ((missing.get(id) ?? 0) > Date.now()) return Promise.resolve(null);
    // The profile's current address: the one the room started on may be the
    // home network the phone has since left.
    const current = useAuthStore.getState().auth;
    const auth = current && profileOf(current) === s.profile ? current : s.auth;
    const p = getSong(auth, id)
      .then((song) => {
        // Only a server song with the id it was asked for: what came back is
        // the server's answer, and it is about to be played.
        if (song && song.id === id && isOlsServerSong(song)) {
          songs.set(id, song);
          missing.delete(id);
          return song;
        }
        missing.set(id, Date.now() + 30_000);
        return null;
      })
      .catch(() => {
        // The server not answering is likelier to pass than a song it lacks.
        lookupFailed = true;
        missing.set(id, Date.now() + 5_000);
        return null;
      })
      .finally(() => lookups.delete(id));
    lookups.set(id, p);
    return p;
  }

  /** Looks up `ids`, six at a time. */
  async function lookupAll(s: Session, ids: string[]): Promise<void> {
    const todo = [...new Set(ids.filter((id) => !songs.has(id)))];
    let next = 0;
    const worker = async () => {
      while (next < todo.length && session === s) await lookup(s, todo[next++]);
    };
    await Promise.all(Array.from({ length: Math.min(6, todo.length) }, worker));
  }

  /** The room's queue as songs; what is not known yet stands in as unavailable. */
  function queueOf(ids: string[]): Song[] {
    return ids.map(
      (id) => songs.get(id) ?? { id, title: tg('Unavailable song'), unavailable: true },
    );
  }

  /**
   * Waits until `ok`, or gives up. Checked on the player's status beats rather
   * than on a timer alone: those keep coming with the screen off, and timers
   * do not.
   */
  function waitFor(stillCurrent: () => boolean, ok: () => boolean, ms: number): Promise<void> {
    const until = Date.now() + ms;
    const done = () => !stillCurrent() || ok() || Date.now() >= until;
    if (done()) return Promise.resolve();
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setInterval> | null = null;
      const finish = () => {
        unsub();
        if (timer) clearInterval(timer);
        resolve();
      };
      const unsub = usePlayerStore.subscribe(() => {
        if (done()) finish();
      });
      timer = setInterval(() => {
        if (done()) finish();
      }, 50);
    });
  }

  const ready = (stillCurrent: () => boolean, ms: number) => waitFor(stillCurrent, olsPlayerReady, ms);

  /**
   * Puts the player where the host is now. Paused while it gets there: the
   * seek is the wait, and starting the sound only once the player has the
   * second in hand is what puts it on the beat instead of a buffer late.
   */
  async function align(state: OlsPlaybackState, stillCurrent: () => boolean): Promise<void> {
    const play = state.isPlaying && !useListeningSession.getState().heldLocally;
    const aim = () => projectOlsPosition(state, serverNow()) + (play ? leadMs : 0);
    quiet(8000);
    if (usePlayerStore.getState().isPlaying) olsSetPlaying(false);
    olsSeek(aim() / 1000);
    await ready(stillCurrent, 4000);
    if (!stillCurrent()) return;
    // The host moved on while this one loaded. A seek inside what is
    // buffered is quick, and worth it; one that asks the server again is not.
    if (Math.abs(livePositionSec() * 1000 - aim()) > OLS_DRIFT_MS && olsSeekIsLocal()) {
      olsSeek(aim() / 1000);
      await ready(stillCurrent, 1500);
      if (!stillCurrent()) return;
    }
    lastCorrectionAt = Date.now();
    if (!play) {
      quiet();
      return;
    }
    olsSetPlaying(true);
    // Measured once it has been sounding for a beat, when the position it
    // reports is the one coming out. Against the newest state rather than
    // this one, since a heartbeat may well arrive in that beat, and only while
    // the room is still on this song: the measure is of this player, not of
    // anything the host did meanwhile.
    const s = session;
    const songId = state.songIds[state.currentIndex];
    const same = () =>
      session === s &&
      role() === 'guest' &&
      !!latest &&
      latest.isPlaying &&
      latest.songIds[latest.currentIndex] === songId &&
      currentSong(usePlayerStore.getState())?.id === songId;
    const started = Date.now();
    await waitFor(same, () => Date.now() - started >= 700 && olsPlayerReady(), 3000);
    quiet();
    if (!same() || !latest || !usePlayerStore.getState().isPlaying) return;
    const late = projectOlsPosition(latest, serverNow()) - livePositionSec() * 1000;
    if (!Number.isFinite(late) || Math.abs(late) > 2000) return;
    leadMs = Math.min(1500, Math.max(0, leadMs + late));
    note(`listening · started ${Math.round(late)} ms late, aiming ${Math.round(leadMs)} ms ahead`);
    // The first start of a room is the one that teaches it, and is otherwise
    // left that far off for as long as it stays under the drift limit.
    if (!calibrated && Math.abs(late) > 50 && olsSeekIsLocal()) {
      calibrated = true;
      await align(latest, same);
    }
    calibrated = true;
  }

  async function apply(force: boolean): Promise<void> {
    const s = session;
    const state = latest;
    if (!s || !state || !clockReady || role() !== 'guest') return;
    const stillCurrent = () =>
      session === s && latest === state && role() === 'guest' && s.connection.latestRevision <= state.revision;
    const held = useListeningSession.getState().heldLocally;
    const player = usePlayerStore.getState();
    const local = {
      // A stand-in is not the song, whatever its id says.
      songIds: player.queue.map((x) => (x.unavailable ? '' : x.id)),
      index: player.index,
      isPlaying: player.isPlaying,
      isBuffering: player.isBuffering,
      positionMs: livePositionSec() * 1000,
      hostSongDurationMs: (player.queue[state.currentIndex]?.duration ?? 0) * 1000,
    };
    const awaitingTransport = !!pending && state.revision <= pending.afterRevision;
    const plan = planOlsGuest(state, local, {
      serverNow: serverNow(),
      discontinuous: force || olsStateIsDiscontinuous(applied, state),
      correctionDue: force || Date.now() - lastCorrectionAt >= OLS_CORRECTION_COOLDOWN_MS,
      awaitingTransport,
    });
    applied = state;
    // What a guest decided, and how far off it was when it seeked: the
    // Diagnostics report is the only record of a room nobody was watching.
    if (plan.queue !== 'keep' || plan.seekMs !== null) {
      bump(`listening · ${plan.queue}${plan.seekMs !== null ? ' + seek' : ''}`);
    }
    if (plan.queue === 'keep' && plan.seekMs !== null) {
      note(`listening · drift ${Math.round(local.positionMs - plan.seekMs)} ms`);
    }
    if (plan.queue === 'wait') return;
    if (plan.queue === 'clear') {
      quiet();
      olsClear();
      return;
    }
    if (plan.queue === 'adopt' || plan.queue === 'load') {
      lookupFailed = false;
      // Songs this phone already has are the same server's songs: no need to
      // ask for them again. Without the marks they carried in the old queue,
      // which would put them under headers of a queue that is gone.
      for (const x of player.queue) {
        if (!x.unavailable && isOlsServerSong(x) && !songs.has(x.id)) {
          songs.set(x.id, { ...x, queued: undefined, fromMix: undefined });
        }
      }
      // What is about to play first, the rest after: a five hundred song queue
      // is a minute of lookups, and the room should be heard in a second.
      const first = state.songIds.slice(state.currentIndex, state.currentIndex + 2);
      await lookupAll(s, first);
      if (!stillCurrent()) return;
      const hostSong = songs.get(state.songIds[state.currentIndex]);
      if (!hostSong) {
        // Not on this account, or the server did not answer. The room goes on
        // without this phone for now; a later state tries again.
        if (usePlayerStore.getState().isPlaying) {
          quiet();
          olsSetPlaying(false);
        }
        const error = lookupFailed
          ? 'Couldn’t load the room’s songs from your server. Trying again…'
          : 'This song isn’t available on your account.';
        if (useListeningSession.getState().error !== error) {
          useListeningSession.setState({ error });
          useToast.getState().show(tg(error));
        }
        return;
      }
      const list = queueOf(state.songIds);
      if (plan.queue === 'adopt') {
        olsAdopt(list, state.currentIndex);
      } else {
        quiet(8000);
        if (!(await olsInstall(list, state.currentIndex)) || !stillCurrent()) return;
        if (!held) await align(state, stillCurrent);
      }
      if (useListeningSession.getState().error) useListeningSession.setState({ error: null });
      // The rest in the background; the queue is swapped again when it is in.
      if (list.some((x) => x.unavailable)) {
        const had = songs.size;
        void lookupAll(s, state.songIds).then(() => {
          if (session === s && songs.size > had) void schedule(false);
        });
      }
      if (plan.queue === 'load') return;
    }
    if (held) {
      // Stopped here on purpose. A pause from the room still lands, so that
      // the end of a call does not start this phone on a room that stopped.
      if (plan.play === false) {
        quiet();
        olsSetPlaying(false);
      }
      return;
    }
    if (plan.seekMs !== null) {
      await align(state, stillCurrent);
      return;
    }
    // Starting again after a pause: the room started a moment ago, and this
    // phone would start a moment later still. Aiming where the room will be
    // once this player sounds, inside what it already holds, costs nothing.
    if (
      plan.play === true &&
      olsSeekIsLocal() &&
      Math.abs(projectOlsPosition(state, serverNow()) + leadMs - local.positionMs) > 50
    ) {
      await align(state, stillCurrent);
      return;
    }
    if (plan.play !== null) {
      quiet();
      olsSetPlaying(plan.play);
    }
  }

  /**
   * Applies the newest state, after whatever is being applied now. Asked for
   * many times while one is running, it runs once more, with the newest.
   */
  function schedule(force: boolean): Promise<void> {
    forceNext = forceNext || force;
    if (queued) return chain;
    queued = true;
    chain = chain
      .then(() => {
        queued = false;
        const f = forceNext;
        forceNext = false;
        return apply(f);
      })
      .catch((e: unknown) => note(`listening · apply failed: ${e instanceof Error ? e.message : e}`));
    return chain;
  }

  function clearPending(): void {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  }

  return {
    schedule,
    received(state: OlsPlaybackState): void {
      if (latest && state.revision <= latest.revision) return;
      latest = state;
      if (pending && state.revision > pending.afterRevision) clearPending();
    },
    /** A request of this guest's was refused: show the room as it is. */
    refused(requestId: string | undefined): void {
      if (!pending || pending.requestId !== requestId) return;
      clearPending();
      void schedule(true);
    },
    request(control: OlsControl): void {
      const s = session;
      if (!s) return;
      const requestId = olsRequestId();
      if (!s.connection.send({ type: 'control.request', protocolVersion: 1, requestId, control })) {
        useToast.getState().show(tg('Couldn’t reach the listening server.'));
        return;
      }
      if (control.action !== 'play' && control.action !== 'pause') return;
      // Heard here at once, not a round trip later; the host's answer either
      // agrees or, after a while, puts it back.
      clearPending();
      pending = {
        requestId,
        afterRevision: latest?.revision ?? -1,
        timer: setTimeout(() => {
          if (pending?.requestId !== requestId) return;
          pending = null;
          void schedule(true);
        }, 5000),
      };
      quiet();
      olsSetPlaying(control.action === 'play');
    },
    /** The player is between sources for a moment: what it reports is not a person. */
    settle(): void {
      quiet();
    },
    toggle(): void {
      const st = useListeningSession.getState();
      if (st.heldLocally) {
        useListeningSession.setState({ heldLocally: false });
        // A room still playing is caught up with; a room that stopped too is
        // asked to start again.
        if (latest?.isPlaying) {
          void schedule(true);
          return;
        }
        this.request({ action: 'play' });
        return;
      }
      this.request({ action: usePlayerStore.getState().isPlaying ? 'pause' : 'play' });
    },
    local(playing: boolean): void {
      if (Date.now() < quietUntil || pending) return;
      if (!playing) {
        if (!useListeningSession.getState().heldLocally) {
          bump('listening · held locally');
          useListeningSession.setState({ heldLocally: true });
        }
        return;
      }
      // Played from outside the app: rejoin the room where it is. If the room
      // is stopped, this stops again; only the app's own button asks the host.
      useListeningSession.setState({ heldLocally: false });
      void schedule(true);
    },
    reset(): void {
      latest = null;
      applied = null;
      lastCorrectionAt = 0;
      quietUntil = 0;
      leadMs = 0;
      calibrated = false;
      clearPending();
      songs.clear();
      lookups.clear();
      missing.clear();
      forceNext = false;
    },
  };
})();

// ── Wiring ──────────────────────────────────────────────────────────────────

let initialized = false;

/** Called once at startup. */
export function initListeningSessions(): void {
  if (initialized) return;
  initialized = true;
  registerOlsPlayerHooks({
    role,
    request: (control) => guest.request(control),
    toggle: () => guest.toggle(),
    local: (playing) => guest.local(playing),
  });
  usePlayerStore.subscribe((st, prev) => {
    const r = role();
    // A guest's own song change (reaching the next one by itself) comes with
    // a few statuses from a player in between sources: not somebody pausing.
    if (r === 'guest' && (st.index !== prev.index || st.queue !== prev.queue)) guest.settle();
    if (r !== 'host') return;
    if (st.isPlaying !== prev.isPlaying) host.transport(st.isPlaying);
    else host.settleStop();
    if (st.queue !== prev.queue || st.index !== prev.index) {
      host.soon();
      return;
    }
    // The status heartbeat goes on with the screen off, where the socket's
    // own timer may not: the host's position keeps reaching the room on it.
    if (st.positionSec !== prev.positionSec) {
      host.checkJump();
      host.publishIfDue();
      session?.connection.ping(false);
    }
  });
  useAuthStore.subscribe((auth) => {
    const s = session;
    if (!s) return;
    if (!auth.offline && profileOf(auth.auth) === s.profile) return;
    // Another profile is another library, and offline there is no server to
    // read the room's songs from. Said on the way out, not waited on.
    s.connection.send({
      type: role() === 'host' ? 'session.end' : 'session.leave',
      protocolVersion: 1,
      requestId: olsRequestId(),
    });
    finish(null);
  });
  AppState.addEventListener('change', (state) => {
    if (state !== 'active' || !session) return;
    // Whatever was missed in the background is behind us: one look at the
    // room as it is now.
    session.connection.ping();
    if (role() === 'host') host.publish();
    else if (role() === 'guest') void guest.schedule(true);
  });
  void useListeningSession.getState().hydrate();
}

let hydrating: Promise<void> | null = null;

function persist(): void {
  const { coordinatorUrl, displayName } = useListeningSession.getState();
  void setItem(STORAGE_KEY, JSON.stringify({ coordinatorUrl, displayName }));
}

export const useListeningSession = create<ListeningSessionState>((set, get) => ({
  status: 'idle',
  room: null,
  error: null,
  coordinatorUrl: '',
  displayName: '',
  hydrated: false,
  heldLocally: false,
  lastJoin: null,

  hydrate: () => {
    if (get().hydrated) return Promise.resolve();
    hydrating ??= (async () => {
      try {
        const raw = await getItem(STORAGE_KEY);
        const saved: unknown = raw ? JSON.parse(raw) : null;
        if (saved && typeof saved === 'object') {
          const { coordinatorUrl, displayName } = saved as Record<string, unknown>;
          set({
            coordinatorUrl: typeof coordinatorUrl === 'string' ? coordinatorUrl.slice(0, 2048) : '',
            displayName:
              typeof displayName === 'string' ? displayName.slice(0, OLS_MAX_NAME_CHARS) : '',
          });
        }
      } catch {
        // Nothing saved worth reading: the fields start empty.
      }
      set({ hydrated: true });
    })();
    return hydrating;
  },

  setCoordinatorUrl: (url) => {
    set({ coordinatorUrl: url.trim().slice(0, 2048) });
    persist();
  },

  setDisplayName: (name) => {
    set({ displayName: name.slice(0, OLS_MAX_NAME_CHARS) });
    persist();
  },

  start: async () => {
    if (get().status !== 'idle') return;
    set({ status: 'starting', error: null });
    try {
      const auth = requireServer();
      if (!usePlayerStore.getState().queue.every(isOlsServerSong)) throw fail('songs');
      const coordinatorUrl = normalizeOlsCoordinatorUrl(get().coordinatorUrl);
      if (!coordinatorUrl) throw fail('address');
      const caps = await getOlsCapabilities(coordinatorUrl);
      const serverUrl = serverCandidates(auth)[0];
      const libraryId = serverUrl ? await olsLibraryId(serverUrl) : null;
      if (!serverUrl || !libraryId) throw fail('online');
      const access = await createOlsRoom(
        coordinatorUrl,
        { name: 'opensubsonic', version: 1, libraryId },
        get().displayName,
      );
      if (access.room.role !== 'host') throw fail('invalid');
      await connect(access, {
        auth,
        profile: profileOf(auth),
        coordinatorUrl,
        serverUrl,
        libraryId,
        code: access.room.code,
        stateBytes: caps.limits.stateBytes,
      });
    } catch (e) {
      bump('listening · start failed');
      finish(messageFor(e));
    }
  },

  join: async (target) => {
    if (get().status !== 'idle') return;
    set({ status: 'joining', error: null });
    try {
      const auth = requireServer();
      const candidates = serverCandidates(auth);
      let coordinatorUrl: string | null;
      let code: string;
      let tries: { serverUrl: string; libraryId: string }[];
      if ('invite' in target) {
        const { invite } = target;
        // The invite names the server; this profile must be on it. Its own
        // fingerprint is checked too: an invite whose two halves disagree was
        // not made by a client, and is not followed.
        if (!candidates.includes(invite.mediaProfile.server)) throw fail('library_mismatch');
        if ((await olsLibraryId(invite.mediaProfile.server)) !== invite.mediaProfile.libraryId) {
          throw fail('invite');
        }
        coordinatorUrl = invite.coordinator;
        code = invite.code;
        tries = [{ serverUrl: invite.mediaProfile.server, libraryId: invite.mediaProfile.libraryId }];
      } else {
        coordinatorUrl = normalizeOlsCoordinatorUrl(get().coordinatorUrl);
        code = normalizeOlsCode(target.code);
        if (!isOlsCode(code)) throw fail('room_not_found');
        // A code says nothing about which of this profile's addresses the
        // host used: each is tried, and only a mismatch moves to the next.
        tries = [];
        for (const serverUrl of candidates.slice(0, 4)) {
          const libraryId = await olsLibraryId(serverUrl);
          if (libraryId) tries.push({ serverUrl, libraryId });
        }
      }
      if (!coordinatorUrl) throw fail('address');
      const caps = await getOlsCapabilities(coordinatorUrl);
      let access: OlsAccess | null = null;
      let chosen = tries[0];
      for (const t of tries) {
        try {
          access = await joinOlsRoom(
            coordinatorUrl,
            code,
            { name: 'opensubsonic', version: 1, libraryId: t.libraryId },
            get().displayName,
          );
          chosen = t;
          break;
        } catch (e) {
          if (!(e instanceof OlsConnectionError) || e.code !== 'library_mismatch') throw e;
        }
      }
      if (!access || !chosen) throw fail('library_mismatch');
      if (access.room.role !== 'guest') throw fail('invalid');
      set({ lastJoin: target });
      await connect(access, {
        auth,
        profile: profileOf(auth),
        coordinatorUrl,
        serverUrl: chosen.serverUrl,
        libraryId: chosen.libraryId,
        code,
        stateBytes: caps.limits.stateBytes,
      });
    } catch (e) {
      bump('listening · join failed');
      finish(messageFor(e));
    }
  },

  leave: async () => {
    const s = session;
    const r = role();
    if (!s || !r || get().status !== 'connected') return;
    set({ status: 'leaving' });
    try {
      await s.connection.request(r === 'host' ? 'end' : 'leave');
    } catch {
      // Out either way: the coordinator sees the socket go, and somebody who
      // asked to leave is not kept in a room because it did not answer.
    }
    if (session === s) finish(null);
  },

  invite: () => {
    const s = session;
    const room = get().room;
    if (!s || !room) return null;
    const invite = createOlsInvite(s.coordinatorUrl, s.serverUrl, s.libraryId, room.code);
    return invite ? { invite, link: olsInviteLink(invite) } : null;
  },

  clearError: () => set({ error: null }),
}));

/** The roles of a room's people, for the screen. */
export function useListeningRole(): OlsRole | null {
  return useListeningSession((s) =>
    s.room && (s.status === 'connected' || s.status === 'leaving') ? s.room.role : null,
  );
}

/** Same check as the room's own, for the invite screen: is this profile on that server? */
export function profileServesInvite(invite: OlsInvite): boolean {
  const { auth } = useAuthStore.getState();
  return !!auth && serverCandidates(auth).includes(invite.mediaProfile.server);
}
