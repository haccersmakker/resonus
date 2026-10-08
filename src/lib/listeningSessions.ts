/**
 * Open Listening Sessions (OLS) version 1, the client side, as pure values.
 *
 * The coordinator is a separate service, not part of any music server: it
 * relays a room's queue and playhead and never touches audio. Every listener
 * signs in to the same OpenSubsonic server with their own profile and streams
 * from it directly, so nothing here carries a credential, a stream address or
 * a song's title. A room is a list of the server's own song ids and a clock.
 *
 * Everything that comes off the network is checked here before the app looks
 * at it, and the checks run the same in the app and under `pnpm test`. That is
 * also why addresses are parsed by hand below: React Native's `URL` is a few
 * regular expressions, it reads no host at all out of `wss://`, and a rule
 * that passes its tests in Node and refuses every socket on the phone is worse
 * than no rule.
 */

export const OLS_PROTOCOL = 'openListeningSessions';
export const OLS_VERSION = 1;
/** How often the host restates where it is, and guests ask the time. */
export const OLS_HEARTBEAT_MS = 3000;
/** A guest further than this from the host's projected playhead seeks. */
export const OLS_DRIFT_MS = 250;
/**
 * Routine drift is corrected at most this often. Every seek flushes the
 * decoder and, on a stream, reconnects, so a guest that seeks on every
 * heartbeat stutters more than one that is a quarter of a second late.
 * Anything the host actually did (a seek, a skip, a pause) is not drift and
 * does not wait.
 */
export const OLS_CORRECTION_COOLDOWN_MS = 9000;
/** A host position this far from where its own clock says it should be is a seek. */
export const OLS_JUMP_MS = 1500;
/**
 * A guest that reached the next song a moment before the host is not lost:
 * the host's change is on its way. Only near the end of the song, though.
 */
export const OLS_NATURAL_END_WINDOW_MS = 3000;

/** The most the app reads from one frame or one HTTP answer. */
export const OLS_MAX_MESSAGE_CHARS = 1_048_576;
/** Bounds on what a room may hold, whatever the coordinator says. */
export const OLS_MAX_SONGS = 5000;
const MAX_ID_CHARS = 256;
const MAX_PARTICIPANTS = 256;
export const OLS_MAX_NAME_CHARS = 64;
const MAX_ERROR_CHARS = 300;
const LIBRARY_ID = /^sha256:[a-f0-9]{64}$/;
const ROOM_CODE = /^[A-Z0-9]{4,12}$/;

export interface OlsMediaProfile {
  name: 'opensubsonic';
  version: 1;
  libraryId: string;
}

export interface OlsCapabilities {
  protocol: typeof OLS_PROTOCOL;
  versions: number[];
  mediaProfiles: { name: string; versions: number[] }[];
  limits: { participants: number; stateBytes: number };
}

export type OlsRole = 'host' | 'guest';

export interface OlsParticipant {
  id: string;
  displayName: string;
  role: OlsRole;
}

export interface OlsPlaybackState {
  revision: number;
  songIds: string[];
  currentIndex: number;
  positionMs: number;
  isPlaying: boolean;
  /** Coordinator time (Unix epoch ms) at which `positionMs` was true. */
  serverTimestamp: number;
}

/** What the host sends; the coordinator stamps the revision and the time. */
export type OlsHostState = Omit<OlsPlaybackState, 'revision' | 'serverTimestamp'>;

export interface OlsRoom {
  id: string;
  code: string;
  selfParticipantId: string;
  role: OlsRole;
  participants: OlsParticipant[];
  state: OlsPlaybackState;
}

/** The answer to creating or joining a room: where to connect, and the ticket in. */
export interface OlsAccess {
  protocolVersion: 1;
  room: OlsRoom;
  connectionUrl: string;
  /** Single use and short lived. Sent as the socket's first message, never in a URL. */
  connectionToken: string;
}

/** The invite any client can read. A Resonus link wraps the same values. */
export interface OlsInvite {
  protocol: typeof OLS_PROTOCOL;
  version: typeof OLS_VERSION;
  coordinator: string;
  code: string;
  mediaProfile: OlsMediaProfile & { server: string };
}

export type OlsControl =
  | { action: 'play' }
  | { action: 'pause' }
  | { action: 'next' }
  | { action: 'previous' }
  | { action: 'seek'; positionMs: number }
  | { action: 'jump'; index: number };

export type OlsClientMessage =
  | { type: 'authenticate'; protocolVersion: 1; connectionToken: string }
  | { type: 'clock.ping'; protocolVersion: 1; id: string; clientTimestamp: number }
  | { type: 'state.update'; protocolVersion: 1; state: OlsHostState }
  | { type: 'control.request'; protocolVersion: 1; requestId: string; control: OlsControl }
  | { type: 'session.leave'; protocolVersion: 1; requestId: string }
  | { type: 'session.end'; protocolVersion: 1; requestId: string };

export type OlsServerMessage =
  | { type: 'authenticated'; protocolVersion: 1; room: OlsRoom }
  | {
      type: 'clock.pong';
      protocolVersion: 1;
      id: string;
      clientTimestamp: number;
      serverReceivedTimestamp: number;
      serverSentTimestamp: number;
    }
  | { type: 'state'; protocolVersion: 1; state: OlsPlaybackState }
  | {
      type: 'control.request';
      protocolVersion: 1;
      requestId: string;
      participantId: string;
      control: OlsControl;
    }
  | { type: 'participants'; protocolVersion: 1; participants: OlsParticipant[] }
  | { type: 'session.left'; protocolVersion: 1; requestId: string }
  | { type: 'session.ended'; protocolVersion: 1; requestId: string }
  | { type: 'error'; protocolVersion: 1; code: string; message: string; requestId?: string };

// ── Checking what comes in ──────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isId(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_ID_CHARS;
}

function isCount(v: unknown): v is number {
  return Number.isSafeInteger(v) && (v as number) >= 0;
}

function isParticipant(v: unknown): v is OlsParticipant {
  return (
    isRecord(v) &&
    isId(v.id) &&
    typeof v.displayName === 'string' &&
    v.displayName.length <= 128 &&
    (v.role === 'host' || v.role === 'guest')
  );
}

function isParticipants(v: unknown): v is OlsParticipant[] {
  return Array.isArray(v) && v.length <= MAX_PARTICIPANTS && v.every(isParticipant);
}

export function isOlsPlaybackState(v: unknown): v is OlsPlaybackState {
  if (
    !isRecord(v) ||
    !isCount(v.revision) ||
    !Array.isArray(v.songIds) ||
    v.songIds.length > OLS_MAX_SONGS ||
    !v.songIds.every(isId) ||
    !isCount(v.currentIndex) ||
    !isCount(v.positionMs) ||
    typeof v.isPlaying !== 'boolean' ||
    !isCount(v.serverTimestamp)
  ) {
    return false;
  }
  return v.songIds.length === 0 ? v.currentIndex === 0 : v.currentIndex < v.songIds.length;
}

function isControl(v: unknown): v is OlsControl {
  if (!isRecord(v)) return false;
  switch (v.action) {
    case 'play':
    case 'pause':
    case 'next':
    case 'previous':
      return true;
    case 'seek':
      return isCount(v.positionMs);
    case 'jump':
      return isCount(v.index);
    default:
      return false;
  }
}

function isRoom(v: unknown): v is OlsRoom {
  return (
    isRecord(v) &&
    isId(v.id) &&
    typeof v.code === 'string' &&
    ROOM_CODE.test(v.code) &&
    isId(v.selfParticipantId) &&
    (v.role === 'host' || v.role === 'guest') &&
    isParticipants(v.participants) &&
    isOlsPlaybackState(v.state)
  );
}

/** The create/join answer. The token is checked for shape only: it is opaque. */
export function isOlsAccess(v: unknown): v is OlsAccess {
  return (
    isRecord(v) &&
    v.protocolVersion === 1 &&
    isRoom(v.room) &&
    typeof v.connectionUrl === 'string' &&
    v.connectionUrl.length <= 2048 &&
    typeof v.connectionToken === 'string' &&
    v.connectionToken.length > 0 &&
    v.connectionToken.length <= 4096
  );
}

export function isOlsCapabilities(v: unknown): v is OlsCapabilities {
  return (
    isRecord(v) &&
    v.protocol === OLS_PROTOCOL &&
    Array.isArray(v.versions) &&
    v.versions.includes(OLS_VERSION) &&
    Array.isArray(v.mediaProfiles) &&
    v.mediaProfiles.some(
      (p) =>
        isRecord(p) &&
        p.name === 'opensubsonic' &&
        Array.isArray(p.versions) &&
        p.versions.includes(1),
    ) &&
    isRecord(v.limits) &&
    Number.isSafeInteger(v.limits.participants) &&
    (v.limits.participants as number) > 0 &&
    Number.isSafeInteger(v.limits.stateBytes) &&
    (v.limits.stateBytes as number) > 0
  );
}

/**
 * A frame off the socket, or null when it is not one this client may act on.
 * `unknown` is a well-formed message of a type that came after version 1: it
 * is skipped rather than treated as an attack, so a coordinator can grow.
 */
export function parseOlsServerFrame(
  data: unknown,
): { ok: true; message: OlsServerMessage } | { ok: false; unknown: boolean } {
  if (typeof data !== 'string' || data.length > OLS_MAX_MESSAGE_CHARS) {
    return { ok: false, unknown: false };
  }
  let v: unknown;
  try {
    v = JSON.parse(data);
  } catch {
    return { ok: false, unknown: false };
  }
  if (!isRecord(v) || v.protocolVersion !== 1 || typeof v.type !== 'string') {
    return { ok: false, unknown: false };
  }
  const bad = { ok: false as const, unknown: false };
  switch (v.type) {
    case 'authenticated':
      return isRoom(v.room) ? { ok: true, message: v as OlsServerMessage } : bad;
    case 'clock.pong':
      return isId(v.id) &&
        isCount(v.clientTimestamp) &&
        isCount(v.serverReceivedTimestamp) &&
        isCount(v.serverSentTimestamp)
        ? { ok: true, message: v as OlsServerMessage }
        : bad;
    case 'state':
      return isOlsPlaybackState(v.state) ? { ok: true, message: v as OlsServerMessage } : bad;
    case 'control.request':
      return isId(v.requestId) && isId(v.participantId) && isControl(v.control)
        ? { ok: true, message: v as OlsServerMessage }
        : bad;
    case 'participants':
      return isParticipants(v.participants) ? { ok: true, message: v as OlsServerMessage } : bad;
    case 'session.left':
    case 'session.ended':
      return isId(v.requestId) ? { ok: true, message: v as OlsServerMessage } : bad;
    case 'error':
      return isId(v.code) &&
        typeof v.message === 'string' &&
        (v.requestId === undefined || isId(v.requestId))
        ? {
            ok: true,
            message: {
              type: 'error',
              protocolVersion: 1,
              code: v.code,
              // Shown to a person: a coordinator gets a sentence, not a page.
              message: v.message.slice(0, MAX_ERROR_CHARS),
              ...(v.requestId === undefined ? {} : { requestId: v.requestId }),
            },
          }
        : bad;
    default:
      return { ok: false, unknown: true };
  }
}

/** The `{ error: { code } }` body a coordinator answers a refused request with. */
export function olsErrorCode(body: unknown): string | null {
  if (!isRecord(body) || !isRecord(body.error)) return null;
  return isId(body.error.code) ? body.error.code : null;
}

// ── Addresses ───────────────────────────────────────────────────────────────

const HOST_LABEL = /^[a-z0-9_]([a-z0-9_-]{0,61}[a-z0-9_])?$/;
const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

/**
 * An IPv6 literal (without its brackets) in the one form a WHATWG `URL` writes
 * it: lower case, no leading zeros, the longest run of zero groups (the first
 * of equal ones, and only a run of two or more) written as `::`. Null when it
 * is not one. Embedded IPv4 forms are refused rather than rewritten.
 */
function canonicalIpv6(text: string): string | null {
  if (!/^[0-9a-f:]+$/.test(text) || text.includes(':::')) return null;
  const halves = text.split('::');
  if (halves.length > 2) return null;
  const part = (h: string) => (h === '' ? [] : h.split(':'));
  const head = part(halves[0]);
  const tail = halves.length === 2 ? part(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill('0'), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  const values = groups.map((g) => parseInt(g, 16).toString(16));
  let best = -1;
  let bestLen = 1;
  for (let i = 0; i < 8; ) {
    let j = i;
    while (j < 8 && values[j] === '0') j++;
    if (j - i > bestLen) {
      best = i;
      bestLen = j - i;
    }
    i = j === i ? i + 1 : j;
  }
  if (best === -1) return values.join(':');
  return `${values.slice(0, best).join(':')}::${values.slice(best + bestLen).join(':')}`;
}
const PATH = /^(\/([A-Za-z0-9\-._~!$&'()*+,;=:@]|%[0-9A-Fa-f]{2})*)*$/;
const DEFAULT_PORT: Record<string, string> = { http: '80', https: '443', ws: '80', wss: '443' };

interface ParsedUrl {
  scheme: string;
  /** Lower case, with the default port left out. */
  host: string;
  /** No trailing slash; empty for the root. */
  path: string;
}

/**
 * A strict reading of an absolute URL: one of `schemes`, a host, an optional
 * port and a path, and nothing else. A user name, a password, a query or a
 * fragment is refused rather than dropped: an address that carries one of
 * those is not the one somebody meant to share.
 *
 * What comes out is the form a WHATWG `URL` gives the same input (lower case
 * scheme and host, no default port, no trailing slash), so that another client
 * normalising with one arrives at the same library fingerprint. Anything that
 * form would rewrite in a less obvious way (dot segments, spaces, non-ASCII
 * hosts) is refused instead of guessed at.
 */
function parseUrl(input: string, schemes: readonly string[]): ParsedUrl | null {
  const value = input.trim();
  if (value.length === 0 || value.length > 2048) return null;
  // Control characters, spaces and backslashes are all things a browser would
  // quietly reinterpret.
  if (/[\s\\\u0000-\u001f\u007f]/.test(value)) return null;
  const m = value.match(/^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)$/);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (!schemes.includes(scheme)) return null;
  const authority = m[2];
  if (authority.includes('@')) return null;
  const hp = authority.match(/^(\[[0-9A-Fa-f:.]+\]|[^:[\]]+)(?::(\d{1,5}))?$/);
  if (!hp) return null;
  const hostname = hp[1].toLowerCase();
  if (hostname.startsWith('[')) {
    // Only in the form a URL would write it: another spelling of the same
    // address would be another library.
    if (canonicalIpv6(hostname.slice(1, -1)) !== hostname.slice(1, -1)) return null;
  } else {
    const labels = hostname.split('.');
    if (!labels.every((l) => HOST_LABEL.test(l))) return null;
    // A name ending in a number is an IPv4 address to a URL, which rewrites
    // `127.1` or `0x7f.0.0.1`; only the plain four-number form is taken.
    const last = labels[labels.length - 1];
    if ((/^\d+$/.test(last) || /^0x/.test(last)) && !IPV4.test(hostname)) return null;
  }
  let port: string | undefined = hp[2];
  if (port !== undefined) {
    const n = Number(port);
    if (n < 1 || n > 65535) return null;
    port = String(n) === DEFAULT_PORT[scheme] ? undefined : String(n);
  }
  const rawPath = m[3];
  if (!PATH.test(rawPath)) return null;
  // `%2e` is a dot to a URL too, and `/a/%2e%2e/b` is `/b`.
  const dots = (seg: string) => seg.replace(/%2e/gi, '.');
  if (rawPath.split('/').some((seg) => dots(seg) === '.' || dots(seg) === '..')) return null;
  return {
    scheme,
    host: port ? `${hostname}:${port}` : hostname,
    path: rawPath.replace(/\/+$/, ''),
  };
}

const formatUrl = (u: ParsedUrl) => `${u.scheme}://${u.host}${u.path}`;

/**
 * The music server's base URL as OLS fingerprints it, or null if it is not a
 * plain HTTP(S) address. A Subsonic URL with `?u=…&t=…` is refused here, which
 * is the point: those are credentials.
 */
export function normalizeOlsServerUrl(value: string): string | null {
  const u = parseUrl(value, ['http', 'https']);
  return u ? formatUrl(u) : null;
}

/** The coordinator's base URL, or null. Same rules as the music server's. */
export function normalizeOlsCoordinatorUrl(value: string): string | null {
  return normalizeOlsServerUrl(value);
}

/**
 * Whether the socket URL a coordinator handed back is that same coordinator:
 * same host and port, `ws` for `http` and `wss` for `https` (never a step
 * down, and never a step up that clients might disagree about), the protocol's
 * own path under the coordinator's, and nothing else. The ticket in is sent
 * down this socket, so it must not be somebody else's.
 */
export function isSafeOlsConnectionUrl(connectionUrl: string, coordinatorUrl: string): boolean {
  const coordinator = parseUrl(coordinatorUrl, ['http', 'https']);
  const socket = parseUrl(connectionUrl, ['ws', 'wss']);
  if (!coordinator || !socket) return false;
  return (
    socket.scheme === (coordinator.scheme === 'https' ? 'wss' : 'ws') &&
    socket.host === coordinator.host &&
    socket.path === `${coordinator.path}/v1/socket`
  );
}

export function isOlsLibraryId(v: unknown): v is string {
  return typeof v === 'string' && LIBRARY_ID.test(v);
}

/** What somebody typed or pasted as a room code, as the coordinator spells it. */
export function normalizeOlsCode(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
}

export function isOlsCode(value: string): boolean {
  return ROOM_CODE.test(value);
}

// ── Invites ─────────────────────────────────────────────────────────────────

/** The app's own link. Its query holds the invite's values, nothing more. */
export const OLS_LINK_PATH = 'listen-together';

export function createOlsInvite(
  coordinatorUrl: string,
  serverUrl: string,
  libraryId: string,
  code: string,
): OlsInvite | null {
  const coordinator = normalizeOlsCoordinatorUrl(coordinatorUrl);
  const server = normalizeOlsServerUrl(serverUrl);
  const c = normalizeOlsCode(code);
  if (!coordinator || !server || !isOlsLibraryId(libraryId) || !isOlsCode(c)) return null;
  return {
    protocol: OLS_PROTOCOL,
    version: OLS_VERSION,
    coordinator,
    code: c,
    mediaProfile: { name: 'opensubsonic', version: 1, server, libraryId },
  };
}

export function olsInviteLink(invite: OlsInvite): string {
  const q = [
    ['coordinator', invite.coordinator],
    ['server', invite.mediaProfile.server],
    ['libraryId', invite.mediaProfile.libraryId],
    ['code', invite.code],
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join('&');
  return `resonus://${OLS_LINK_PATH}?${q}`;
}

/**
 * The invite from the link's values, as the router hands them over (already
 * decoded once; they are not decoded again, or `%2541` would turn into `A`).
 * Anything missing, malformed or carrying a credential gives null: a link that
 * is only half right is not followed half way.
 */
export function olsInviteFromLinkParams(p: {
  coordinator?: unknown;
  server?: unknown;
  libraryId?: unknown;
  code?: unknown;
}): OlsInvite | null {
  if (
    typeof p.coordinator !== 'string' ||
    typeof p.server !== 'string' ||
    typeof p.libraryId !== 'string' ||
    typeof p.code !== 'string'
  ) {
    return null;
  }
  // Exact, not tidied: an invite is the host's word, and a code with dashes
  // in it is not what any client writes.
  if (!isOlsCode(p.code)) return null;
  const invite = createOlsInvite(p.coordinator, p.server, p.libraryId, p.code);
  // The values must already be in their normal form. A link whose server reads
  // differently from what its fingerprint was taken over cannot be checked.
  if (
    !invite ||
    invite.coordinator !== p.coordinator ||
    invite.mediaProfile.server !== p.server
  ) {
    return null;
  }
  return invite;
}

/**
 * The invite the link screen was opened with. expo-router decodes a query value
 * twice (reading the URL, then again in `useLocalSearchParams`), which turns a
 * `%20` in an address into a space, or `%7E` into a `~` that still reads as an
 * address, only not the host's. So the link the app was opened with is read
 * first, once, and taken if it is the one those values came from; the values
 * alone only when it is not.
 */
export function olsInviteFromRoute(
  params: Record<string, unknown>,
  linkingUrl: string | null,
): OlsInvite | null {
  const parsed = linkingUrl ? parseOlsInviteText(linkingUrl) : null;
  if (parsed && 'invite' in parsed) {
    const { invite } = parsed;
    const twice = (v: string) => {
      try {
        return decodeURIComponent(v);
      } catch {
        return v;
      }
    };
    if (
      params.coordinator === twice(invite.coordinator) &&
      params.server === twice(invite.mediaProfile.server) &&
      params.libraryId === invite.mediaProfile.libraryId &&
      params.code === invite.code
    ) {
      return invite;
    }
  }
  return olsInviteFromLinkParams(params);
}

/**
 * What somebody pasted into the code field: the JSON invite, the app's link,
 * the whole message the share sheet sent (both of those inside some text), or
 * just a code. Null when it is none of them.
 */
export function parseOlsInviteText(
  text: string,
): { invite: OlsInvite } | { code: string } | null {
  if (text.length > 8192) return null;
  const trimmed = text.trim();
  const link = trimmed.match(/resonus:\/\/listen-together\?([^\s"]+)/);
  if (link) {
    const params: Record<string, string> = {};
    for (const pair of link[1].split('&')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      try {
        params[pair.slice(0, eq)] = decodeURIComponent(pair.slice(eq + 1));
      } catch {
        return null;
      }
    }
    const invite = olsInviteFromLinkParams(params);
    return invite ? { invite } : null;
  }
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start !== -1 && end > start) {
    let v: unknown;
    try {
      v = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      return null;
    }
    const invite = isRecord(v) ? olsInviteFromJson(v) : null;
    return invite ? { invite } : null;
  }
  if (/^[A-Za-z0-9 -]{4,20}$/.test(trimmed)) {
    const code = normalizeOlsCode(trimmed);
    return isOlsCode(code) ? { code } : null;
  }
  return null;
}

function olsInviteFromJson(v: Record<string, unknown>): OlsInvite | null {
  if (v.protocol !== OLS_PROTOCOL || v.version !== OLS_VERSION || !isRecord(v.mediaProfile)) {
    return null;
  }
  const m = v.mediaProfile;
  if (m.name !== 'opensubsonic' || m.version !== 1) return null;
  return olsInviteFromLinkParams({
    coordinator: v.coordinator,
    server: m.server,
    libraryId: m.libraryId,
    code: v.code,
  });
}

// ── Time ────────────────────────────────────────────────────────────────────

/**
 * NTP's estimate of how far the coordinator's clock is from this one. Of the
 * last few round trips the shortest wins, since it has the least unknown
 * network delay in it; keeping only a few lets the estimate follow the phone
 * correcting its own clock after the room started. Playback speed is never
 * used to close a gap: Original quality means the samples as they are.
 */
export class OlsClock {
  private samples: { rtt: number; offset: number }[] = [];
  private offset = 0;

  /** Returns false for a sample that cannot be right (it is then ignored). */
  add(clientSent: number, serverReceived: number, serverSent: number, clientReceived: number) {
    const rtt = clientReceived - clientSent - (serverSent - serverReceived);
    if (!Number.isFinite(rtt) || rtt < 0 || rtt > 10_000) return false;
    const offset = (serverReceived - clientSent + (serverSent - clientReceived)) / 2;
    this.samples.push({ rtt, offset });
    if (this.samples.length > 4) this.samples.shift();
    this.offset = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a)).offset;
    return true;
  }

  get ready(): boolean {
    return this.samples.length > 0;
  }

  serverNow(clientNow: number): number {
    return clientNow + this.offset;
  }
}

/** Where the host is now, on the coordinator's clock. */
export function projectOlsPosition(state: OlsPlaybackState, serverNow: number): number {
  if (!state.isPlaying) return state.positionMs;
  return Math.max(0, state.positionMs + serverNow - state.serverTimestamp);
}

/**
 * Whether `next` is something the host did rather than time passing: another
 * queue or song, play or pause, or a position the last state does not account
 * for. Those are applied at once, without waiting out the cooldown.
 */
export function olsStateIsDiscontinuous(
  previous: OlsPlaybackState | null,
  next: OlsPlaybackState,
): boolean {
  if (!previous) return true;
  if (
    previous.currentIndex !== next.currentIndex ||
    previous.isPlaying !== next.isPlaying ||
    !sameIds(previous.songIds, next.songIds)
  ) {
    return true;
  }
  return Math.abs(projectOlsPosition(previous, next.serverTimestamp) - next.positionMs) > 1000;
}

export function sameIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, i) => id === b[i]);
}

/**
 * Whether the host's playhead is no longer where the last state put it: a
 * seek from the notification or the car, which never passes through the app,
 * or a song repeating itself. Worth telling the room at once, not in three
 * seconds.
 */
export function olsPositionJumped(
  last: { positionMs: number; isPlaying: boolean; at: number },
  positionMs: number,
  now: number,
): boolean {
  const expected = last.isPlaying ? last.positionMs + (now - last.at) : last.positionMs;
  return Math.abs(expected - positionMs) > OLS_JUMP_MS;
}

// ── What a guest does with a state ──────────────────────────────────────────

/** What the guest's player is doing, read at the moment a state is applied. */
export interface OlsGuestLocal {
  songIds: readonly string[];
  index: number;
  isPlaying: boolean;
  isBuffering: boolean;
  /** Read from the player itself, not from the half-second status. */
  positionMs: number;
  /** Length of the song at the host's index in the guest's queue, 0 if unknown. */
  hostSongDurationMs: number;
}

export interface OlsGuestPlan {
  /**
   * `keep`: the queue and the song are already right. `adopt`: the song
   * playing is the right one, the queue around it changed, so the list is
   * swapped without touching the sound. `load`: another song. `clear`: the
   * host emptied the queue. `wait`: this guest got to the next song on its
   * own a moment before the host did; the host's change is on its way.
   */
  queue: 'keep' | 'adopt' | 'load' | 'clear' | 'wait';
  /** Where to go, on the coordinator's projected clock; null to stay. */
  seekMs: number | null;
  /** Start or stop; null to leave as it is. */
  play: boolean | null;
}

export function planOlsGuest(
  state: OlsPlaybackState,
  local: OlsGuestLocal,
  opts: {
    serverNow: number;
    discontinuous: boolean;
    /** The cooldown has passed, or the caller wants the room re-read anyway. */
    correctionDue: boolean;
    /** A play/pause this guest asked for is pending: its button stays as pressed. */
    awaitingTransport: boolean;
  },
): OlsGuestPlan {
  if (state.songIds.length === 0) return { queue: 'clear', seekMs: null, play: null };
  const target = projectOlsPosition(state, opts.serverNow);
  const hostId = state.songIds[state.currentIndex];
  const sameQueue = sameIds(local.songIds, state.songIds);
  // At the end of its song a host may say it stopped for the instant before
  // the next one starts: that is not a pause to follow.
  const hostAtEnd =
    local.hostSongDurationMs > 0 && target >= local.hostSongDurationMs - OLS_NATURAL_END_WINDOW_MS;
  const hostEnded = local.hostSongDurationMs > 0 && target >= local.hostSongDurationMs - 1500;
  if (local.songIds[local.index] !== hostId) {
    if (
      sameQueue &&
      local.index === state.currentIndex + 1 &&
      (state.isPlaying || hostEnded) &&
      local.isPlaying &&
      hostAtEnd &&
      local.positionMs < OLS_NATURAL_END_WINDOW_MS
    ) {
      return { queue: 'wait', seekMs: null, play: null };
    }
    return { queue: 'load', seekMs: target, play: state.isPlaying };
  }
  const queue = sameQueue && local.index === state.currentIndex ? 'keep' : 'adopt';
  const far = Math.abs(local.positionMs - target) > OLS_DRIFT_MS;
  // Buffering, the player's position says nothing yet; a jump the host made
  // still has to be followed, and that is what `discontinuous` says.
  // Nor while a play or pause of this guest's is on its way: it is standing
  // still or moving on purpose until the host answers.
  const seek =
    far && !opts.awaitingTransport && (opts.discontinuous || (opts.correctionDue && !local.isBuffering))
      ? target
      : null;
  let play: boolean | null = null;
  if (!opts.awaitingTransport) {
    if (state.isPlaying && !local.isPlaying) play = true;
    // Its last second is this guest's to hear: the host stopping there is
    // the song ending, not a pause.
    else if (!state.isPlaying && local.isPlaying && !hostEnded) play = false;
  }
  return { queue, seekMs: seek, play };
}

/**
 * The queue as a host's state carries it. All of it, unless it is longer than
 * a room holds: then a window around the song playing, with more ahead than
 * behind. `from` is where the last one started; it stays there while the song
 * playing is well inside it, since a window that moved with every song would
 * move under a guest's tap, and the song asked for would not be the one played.
 */
export function olsQueueWindow(
  ids: readonly string[],
  index: number,
  maxBytes: number,
  from: number,
): { ids: string[]; start: number } {
  let size = Math.min(ids.length, OLS_MAX_SONGS);
  for (;;) {
    const inside = index >= from + Math.floor(size / 8) && index < from + size - Math.floor(size / 4);
    const start = Math.max(0, Math.min(inside ? from : index - Math.floor(size / 4), ids.length - size));
    const slice = ids.slice(start, start + size);
    // Each id costs its length and three characters of JSON around it; the
    // rest of the message is well inside the margin.
    const bytes = slice.reduce((n, id) => n + id.length + 3, 256);
    if (size <= 1 || bytes <= maxBytes) return { ids: slice, start };
    size = Math.floor(size / 2);
  }
}

/** Whether a song can be named to a room: the server's own, by id. */
export function isOlsServerSong(song: { id: unknown; url?: unknown }): boolean {
  // A station or a podcast episode is an address, and a song of the phone's
  // own library is a file; nobody else's server knows either of them.
  return isId(song.id) && !song.url && !(song.id as string).startsWith('local:');
}

/** A request id: unique enough within one socket, and nothing about the person. */
export function olsRequestId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
