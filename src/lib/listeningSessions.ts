/**
 * Resonus client contract for Open Listening Sessions. The coordinator is a
 * separate service: OpenSubsonic servers remain unchanged and every
 * participant streams with their own existing server credentials.
 */

export const LISTENING_SESSIONS_PROTOCOL = 'openListeningSessions';
export const LISTENING_SESSIONS_VERSION = 1;
export const LISTENING_SESSION_HEARTBEAT_MS = 3000;
export const LISTENING_SESSION_DRIFT_MS = 250;
export const LISTENING_SESSION_CORRECTION_COOLDOWN_MS = 9000;

export interface ListeningSessionMediaProfile {
  name: 'opensubsonic';
  version: 1;
  libraryId: string;
}

export interface ListeningSessionCapabilities {
  protocol: typeof LISTENING_SESSIONS_PROTOCOL;
  versions: number[];
  mediaProfiles: { name: string; versions: number[] }[];
  limits: { participants: number; stateBytes: number };
}

export type ListeningSessionRole = 'host' | 'guest';

export interface ListeningSessionParticipant {
  id: string;
  displayName: string;
  role: ListeningSessionRole;
}

export interface ListeningSessionPlaybackState {
  revision: number;
  songIds: string[];
  currentIndex: number;
  positionMs: number;
  isPlaying: boolean;
  /** Coordinator time (Unix epoch milliseconds) at which positionMs applies. */
  serverTimestamp: number;
}

export interface ListeningSessionRoom {
  id: string;
  code: string;
  /** This connection's participant. Authorization remains socket-bound. */
  selfParticipantId: string;
  role: ListeningSessionRole;
  participants: ListeningSessionParticipant[];
  state: ListeningSessionPlaybackState;
}

/** Credentials returned by the authenticated REST API for one room only. */
export interface ListeningSessionAccess {
  room: ListeningSessionRoom;
  connectionUrl: string;
  connectionToken: string;
}

/** Portable invite data. URL/deep-link transport is deliberately client-specific. */
export interface ListeningSessionInvite {
  protocol: typeof LISTENING_SESSIONS_PROTOCOL;
  version: typeof LISTENING_SESSIONS_VERSION;
  coordinator: string;
  code: string;
  mediaProfile: ListeningSessionMediaProfile & { server: string };
}

export type ListeningSessionControl =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'next' }
  | { action: 'previous' }
  | { action: 'seek'; positionMs: number }
  | { action: 'jump'; index: number };

export type ListeningSessionClientMessage =
  | {
      type: 'authenticate';
      protocolVersion: 1;
      connectionToken: string;
    }
  | { type: 'clock.ping'; protocolVersion: 1; id: string; clientTimestamp: number }
  | {
      type: 'state.update';
      protocolVersion: 1;
      state: Omit<ListeningSessionPlaybackState, 'revision' | 'serverTimestamp'>;
    }
  | {
      type: 'control.request';
      protocolVersion: 1;
      requestId: string;
      control: ListeningSessionControl;
    }
  | { type: 'session.leave'; protocolVersion: 1; requestId: string }
  | { type: 'session.end'; protocolVersion: 1; requestId: string };

export type ListeningSessionServerMessage =
  | { type: 'authenticated'; protocolVersion: 1; room: ListeningSessionRoom }
  | {
      type: 'clock.pong';
      protocolVersion: 1;
      id: string;
      clientTimestamp: number;
      serverReceivedTimestamp: number;
      serverSentTimestamp: number;
    }
  | { type: 'state'; protocolVersion: 1; state: ListeningSessionPlaybackState }
  | {
      type: 'control.request';
      protocolVersion: 1;
      requestId: string;
      participantId: string;
      control: ListeningSessionControl;
    }
  | {
      type: 'participants';
      protocolVersion: 1;
      participants: ListeningSessionParticipant[];
    }
  | { type: 'session.left'; protocolVersion: 1; requestId: string }
  | { type: 'session.ended'; protocolVersion: 1; requestId: string }
  | {
      type: 'error';
      protocolVersion: 1;
      code: string;
      message: string;
      requestId?: string;
    };

const SERVER_MESSAGE_TYPES = new Set([
  'authenticated',
  'clock.pong',
  'state',
  'control.request',
  'participants',
  'session.left',
  'session.ended',
  'error',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isParticipant(value: unknown): value is ListeningSessionParticipant {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.displayName === 'string' &&
    value.displayName.length <= 128 &&
    (value.role === 'host' || value.role === 'guest')
  );
}

function isPlaybackState(value: unknown): value is ListeningSessionPlaybackState {
  if (
    !isRecord(value) ||
    !isNonNegativeInteger(value.revision) ||
    !Array.isArray(value.songIds) ||
    !value.songIds.every(isNonEmptyString) ||
    !isNonNegativeInteger(value.currentIndex) ||
    !isNonNegativeInteger(value.positionMs) ||
    typeof value.isPlaying !== 'boolean' ||
    !isNonNegativeInteger(value.serverTimestamp)
  ) {
    return false;
  }
  return value.songIds.length === 0
    ? value.currentIndex === 0
    : value.currentIndex < value.songIds.length;
}

function isControl(value: unknown): value is ListeningSessionControl {
  if (!isRecord(value) || typeof value.action !== 'string') return false;
  if (['play', 'pause', 'next', 'previous'].includes(value.action)) return true;
  if (value.action === 'seek') return isNonNegativeInteger(value.positionMs);
  return value.action === 'jump' && isNonNegativeInteger(value.index);
}

function isRoom(value: unknown): value is ListeningSessionRoom {
  return (
    isRecord(value) &&
    isNonEmptyString(value.id) &&
    typeof value.code === 'string' &&
    /^[A-Z0-9]{4,12}$/.test(value.code) &&
    isNonEmptyString(value.selfParticipantId) &&
    (value.role === 'host' || value.role === 'guest') &&
    Array.isArray(value.participants) &&
    value.participants.every(isParticipant) &&
    isPlaybackState(value.state)
  );
}

/** Runtime boundary for the authenticated REST create/join response. */
export function isListeningSessionAccess(value: unknown): value is ListeningSessionAccess {
  return (
    isRecord(value) &&
    isRoom(value.room) &&
    isNonEmptyString(value.connectionUrl) &&
    isNonEmptyString(value.connectionToken)
  );
}

/**
 * Version 1 shares server-local song IDs. Internet radio and device-local
 * items cannot be resolved through OpenSubsonic getSong by another client.
 */
export function isListeningSessionServerTrack(track: {
  id: unknown;
  url?: unknown;
  localUri?: unknown;
}): boolean {
  return isNonEmptyString(track.id) && !track.url && !track.localUri;
}

export function isKnownListeningSessionServerMessageType(type: string): boolean {
  return SERVER_MESSAGE_TYPES.has(type);
}

/** Runtime boundary for untrusted coordinator messages. */
export function isListeningSessionServerMessage(
  value: unknown,
): value is ListeningSessionServerMessage {
  if (!isRecord(value) || value.protocolVersion !== 1 || typeof value.type !== 'string') {
    return false;
  }
  switch (value.type) {
    case 'authenticated':
      return isRoom(value.room);
    case 'clock.pong':
      return (
        isNonEmptyString(value.id) &&
        isNonNegativeInteger(value.clientTimestamp) &&
        isNonNegativeInteger(value.serverReceivedTimestamp) &&
        isNonNegativeInteger(value.serverSentTimestamp)
      );
    case 'state':
      return isPlaybackState(value.state);
    case 'control.request':
      return (
        isNonEmptyString(value.requestId) &&
        isNonEmptyString(value.participantId) &&
        isControl(value.control)
      );
    case 'participants':
      return Array.isArray(value.participants) && value.participants.every(isParticipant);
    case 'session.left':
    case 'session.ended':
      return isNonEmptyString(value.requestId);
    case 'error':
      return (
        isNonEmptyString(value.code) &&
        typeof value.message === 'string' &&
        (value.requestId === undefined || isNonEmptyString(value.requestId))
      );
    default:
      return false;
  }
}

export function isListeningSessionCapabilities(
  value: unknown,
): value is ListeningSessionCapabilities {
  return (
    isRecord(value) &&
    value.protocol === LISTENING_SESSIONS_PROTOCOL &&
    Array.isArray(value.versions) &&
    value.versions.includes(LISTENING_SESSIONS_VERSION) &&
    Array.isArray(value.mediaProfiles) &&
    value.mediaProfiles.some(
      (profile) =>
        isRecord(profile) &&
        profile.name === 'opensubsonic' &&
        Array.isArray(profile.versions) &&
        profile.versions.includes(1),
    ) &&
    isRecord(value.limits) &&
    Number.isSafeInteger(value.limits.participants) &&
    Number(value.limits.participants) > 0 &&
    Number.isSafeInteger(value.limits.stateBytes) &&
    Number(value.limits.stateBytes) > 0
  );
}

export function normalizeListeningSessionCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

function normalizeCredentialFreeHttpUrl(value: string, label: string): string {
  const parsed = new URL(value.trim());
  if (
    !['http:', 'https:'].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error(`${label} requires a credential-free HTTP or HTTPS URL`);
  }
  const pathname = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.protocol}//${parsed.host}${pathname}`;
}

/** Normative OpenSubsonic media-profile URL normalization. */
export function normalizeListeningSessionServerUrl(value: string): string {
  return normalizeCredentialFreeHttpUrl(value, 'A Jam invite');
}

export function normalizeListeningSessionCoordinatorUrl(value: string): string {
  return normalizeCredentialFreeHttpUrl(value, 'A Jam coordinator');
}

/**
 * Validates the credential-free socket URL returned by the REST bootstrap.
 * Version 1 deliberately keeps this on the exact authenticated origin and
 * maps HTTP to WS (or HTTPS to WSS) without allowing a protocol upgrade that
 * would make different clients interpret the origin rule differently.
 */
export function isSafeListeningSessionConnectionUrl(
  connectionUrl: string,
  coordinatorUrl: string,
): boolean {
  try {
    const connection = new URL(connectionUrl);
    const coordinator = new URL(normalizeListeningSessionCoordinatorUrl(coordinatorUrl));
    const expectedProtocol =
      coordinator.protocol === 'http:'
        ? 'ws:'
        : coordinator.protocol === 'https:'
          ? 'wss:'
          : null;
    const expectedPath = `${coordinator.pathname.replace(/\/+$/, '')}/v1/socket`;
    return (
      expectedProtocol !== null &&
      connection.protocol === expectedProtocol &&
      connection.host === coordinator.host &&
      connection.pathname === expectedPath &&
      !connection.username &&
      !connection.password &&
      !connection.search &&
      !connection.hash
    );
  } catch {
    return false;
  }
}

export function createListeningSessionInvite(
  coordinatorUrl: string,
  serverUrl: string,
  libraryId: string,
  code: string,
): ListeningSessionInvite {
  const coordinator = normalizeListeningSessionCoordinatorUrl(coordinatorUrl);
  const server = normalizeListeningSessionServerUrl(serverUrl);
  if (!/^sha256:[a-f0-9]{64}$/.test(libraryId)) {
    throw new Error('A Jam invite requires a valid OpenSubsonic library ID');
  }
  const normalizedCode = normalizeListeningSessionCode(code);
  if (normalizedCode.length < 4) throw new Error('A Jam invite requires a valid room code');
  return {
    protocol: LISTENING_SESSIONS_PROTOCOL,
    version: LISTENING_SESSIONS_VERSION,
    coordinator,
    code: normalizedCode,
    mediaProfile: { name: 'opensubsonic', version: 1, server, libraryId },
  };
}

export function listeningSessionInviteUrl(invite: ListeningSessionInvite): string {
  const params = new URLSearchParams({
    coordinator: invite.coordinator,
    server: invite.mediaProfile.server,
    libraryId: invite.mediaProfile.libraryId,
    code: invite.code,
  });
  return `resonus:///jam?${params.toString()}`;
}

/** Position the host should have now, expressed in coordinator time. */
export function projectedListeningPositionMs(
  state: ListeningSessionPlaybackState,
  estimatedServerNow: number,
): number {
  if (!state.isPlaying) return Math.max(0, state.positionMs);
  return Math.max(0, state.positionMs + estimatedServerNow - state.serverTimestamp);
}

export function shouldReconcileListeningPosition(
  localPositionMs: number,
  targetPositionMs: number,
  thresholdMs = LISTENING_SESSION_DRIFT_MS,
): boolean {
  return Math.abs(localPositionMs - targetPositionMs) > thresholdMs;
}

/**
 * True when a state is an explicit transport/queue jump rather than ordinary
 * clock drift. These changes must not wait behind the routine seek cooldown.
 */
export function listeningSessionStateHasDiscontinuity(
  previous: ListeningSessionPlaybackState | null,
  next: ListeningSessionPlaybackState,
  positionThresholdMs = 1000,
): boolean {
  if (!previous) return true;
  if (
    previous.currentIndex !== next.currentIndex ||
    previous.isPlaying !== next.isPlaying ||
    previous.songIds.length !== next.songIds.length ||
    previous.songIds.some((id, index) => id !== next.songIds[index])
  ) {
    return true;
  }
  const expectedPosition = projectedListeningPositionMs(previous, next.serverTimestamp);
  return Math.abs(expectedPosition - next.positionMs) > positionThresholdMs;
}

/**
 * NTP-style clock estimate. The lowest-round-trip recent sample is preferred
 * because it contains the least unknown network delay. Keeping the window
 * bounded lets the estimate recover if Android corrects its wall clock after
 * joining. No playback-rate correction is used, preserving Original-quality
 * bit-perfect output.
 */
export class ListeningSessionClock {
  private samples: { roundTripMs: number; offsetMs: number }[] = [];
  private offsetMs = 0;

  addSample(
    clientSentTimestamp: number,
    serverReceivedTimestamp: number,
    serverSentTimestamp: number,
    clientReceivedTimestamp: number,
  ): number {
    const roundTripMs =
      clientReceivedTimestamp -
      clientSentTimestamp -
      (serverSentTimestamp - serverReceivedTimestamp);
    const offsetMs =
      (serverReceivedTimestamp - clientSentTimestamp +
        (serverSentTimestamp - clientReceivedTimestamp)) /
      2;
    this.samples.push({ roundTripMs, offsetMs });
    if (this.samples.length > 4) this.samples.shift();
    this.offsetMs = this.samples.reduce((best, sample) =>
      sample.roundTripMs < best.roundTripMs ? sample : best,
    ).offsetMs;
    return this.offsetMs;
  }

  serverNow(clientTimestamp = Date.now()): number {
    return clientTimestamp + this.offsetMs;
  }

  reset(): void {
    this.samples = [];
    this.offsetMs = 0;
  }
}
