/**
 * Listening together: the Open Listening Sessions rules (src/lib/listeningSessions.ts)
 * and the socket client (src/lib/listeningSessionConnection.ts), the second
 * against the stand-in coordinator in `support/`.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import {
  OlsConnection,
  OlsConnectionError,
  type OlsSocket,
} from '@/lib/listeningSessionConnection';
import {
  OLS_MAX_MESSAGE_CHARS,
  OlsClock,
  createOlsInvite,
  isOlsAccess,
  isOlsCapabilities,
  isOlsServerSong,
  isSafeOlsConnectionUrl,
  normalizeOlsCode,
  normalizeOlsServerUrl,
  olsInviteFromLinkParams,
  olsInviteLink,
  olsPositionJumped,
  olsStateIsDiscontinuous,
  parseOlsInviteText,
  parseOlsServerFrame,
  planOlsGuest,
  projectOlsPosition,
  type OlsAccess,
  type OlsGuestLocal,
  type OlsPlaybackState,
  type OlsServerMessage,
} from '@/lib/listeningSessions';
import { startMockCoordinator, type MockCoordinator } from './support/olsCoordinator';

const LIB = `sha256:${'a'.repeat(64)}`;
const sha = (s: string) => `sha256:${createHash('sha256').update(s).digest('hex')}`;

describe('Addresses', () => {
  it('normalises the way a WHATWG URL does, for one fingerprint everywhere', () => {
    for (const [input, want] of [
      ['https://Music.Example.com/', 'https://music.example.com'],
      ['HTTPS://music.example.com:443/navidrome//', 'https://music.example.com/navidrome'],
      ['http://192.168.1.5:4533', 'http://192.168.1.5:4533'],
      ['http://nas.local:80/', 'http://nas.local'],
      ['  https://music.example  ', 'https://music.example'],
      ['http://[::1]:4533/', 'http://[::1]:4533'],
    ]) {
      assert.equal(normalizeOlsServerUrl(input), want, input);
      // And the same answer Node's own URL gives, where it gives one at all.
      const u = new URL(input.trim());
      assert.equal(want, `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`, input);
    }
  });

  it('refuses anything carrying a credential, and anything it would have to guess at', () => {
    for (const bad of [
      'https://user:pass@music.example',
      'https://user@music.example',
      'https://music.example/rest/stream?u=me&t=abc&s=salt',
      'https://music.example/#x',
      'ftp://music.example',
      'music.example',
      'https://music.example/a/../b',
      'https://müsic.example',
      'https://music example',
      'https://music.example:0',
      'https://music.example:70000',
      'javascript:alert(1)',
      '',
    ]) {
      assert.equal(normalizeOlsServerUrl(bad), null, bad);
    }
  });

  it('the library id is the SHA-256 of the normalised address', () => {
    // What `olsLibraryId` computes on the phone, through expo-crypto.
    const normal = normalizeOlsServerUrl('https://Music.Example.com:443/');
    assert.equal(sha(normal!), sha('https://music.example.com'));
    assert.match(sha(normal!), /^sha256:[a-f0-9]{64}$/);
  });

  it('only lets a ticket go down a socket on the coordinator it came from', () => {
    const c = 'https://sessions.example/ols';
    assert.equal(isSafeOlsConnectionUrl('wss://sessions.example/ols/v1/socket', c), true);
    assert.equal(isSafeOlsConnectionUrl('wss://SESSIONS.example:443/ols/v1/socket', c), true);
    assert.equal(isSafeOlsConnectionUrl('ws://sessions.example/ols/v1/socket', c), false);
    assert.equal(isSafeOlsConnectionUrl('wss://evil.example/ols/v1/socket', c), false);
    assert.equal(isSafeOlsConnectionUrl('wss://sessions.example.evil.example/ols/v1/socket', c), false);
    assert.equal(isSafeOlsConnectionUrl('wss://sessions.example:8443/ols/v1/socket', c), false);
    assert.equal(isSafeOlsConnectionUrl('wss://sessions.example/v1/socket', c), false);
    assert.equal(isSafeOlsConnectionUrl('wss://sessions.example/ols/v1/socket?token=x', c), false);
    assert.equal(isSafeOlsConnectionUrl('wss://a:b@sessions.example/ols/v1/socket', c), false);
    assert.equal(isSafeOlsConnectionUrl('ws://127.0.0.1:9000/v1/socket', 'http://127.0.0.1:9000'), true);
    assert.equal(isSafeOlsConnectionUrl('wss://127.0.0.1:9000/v1/socket', 'http://127.0.0.1:9000'), false);
  });
});

describe('Invites', () => {
  const server = 'https://music.example';
  const lib = sha(server);
  const invite = createOlsInvite('https://sessions.example', server, lib, 'abc-234')!;

  it('carry the client-neutral values, and the app link wraps exactly those', () => {
    assert.deepEqual(invite, {
      protocol: 'openListeningSessions',
      version: 1,
      coordinator: 'https://sessions.example',
      code: 'ABC234',
      mediaProfile: { name: 'opensubsonic', version: 1, server, libraryId: lib },
    });
    const link = olsInviteLink(invite);
    assert.match(link, /^resonus:\/\/listen-together\?/);
    assert.deepEqual(parseOlsInviteText(link), { invite });
    assert.deepEqual(parseOlsInviteText(JSON.stringify(invite)), { invite });
    // The whole message the share sheet sends.
    assert.deepEqual(parseOlsInviteText(`Join me:\n${JSON.stringify(invite)}\n${link}`), { invite });
  });

  it('a pasted code is just a code', () => {
    assert.deepEqual(parseOlsInviteText(' abc-234 '), { code: 'ABC234' });
    assert.equal(normalizeOlsCode(' ab-c 12!xy9 '), 'ABC12XY9');
    assert.equal(parseOlsInviteText('hello there, this is not a code'), null);
  });

  it('refuses one that is incomplete, malformed, carries credentials or is not in normal form', () => {
    const p = { coordinator: invite.coordinator, server, libraryId: lib, code: 'ABC234' };
    assert.deepEqual(olsInviteFromLinkParams(p), invite);
    for (const bad of [
      { ...p, code: undefined },
      { ...p, code: 'AB' },
      { ...p, code: 'abc234' },
      { ...p, libraryId: 'sha256:xyz' },
      { ...p, libraryId: lib.toUpperCase() },
      { ...p, server: 'https://me:secret@music.example' },
      { ...p, server: 'https://music.example/?u=me&p=secret' },
      { ...p, server: 'https://Music.example' },
      { ...p, coordinator: 'https://sessions.example/' },
      { ...p, coordinator: ['https://sessions.example'] },
    ]) {
      assert.equal(olsInviteFromLinkParams(bad), null, JSON.stringify(bad));
    }
    assert.equal(parseOlsInviteText(JSON.stringify({ ...invite, version: 2 })), null);
    assert.equal(
      parseOlsInviteText(JSON.stringify({ ...invite, mediaProfile: { ...invite.mediaProfile, name: 'jellyfin' } })),
      null,
    );
    assert.equal(parseOlsInviteText('{"protocol": '), null);
    assert.equal(parseOlsInviteText('x'.repeat(10_000)), null);
  });

  it('decodes a link once and only once', () => {
    // `%2541` is a literal "%41" in the code, which no code contains.
    const link = olsInviteLink(invite).replace('code=ABC234', 'code=ABC%2541');
    assert.equal(parseOlsInviteText(link), null);
  });
});

describe('What may be shared with a room', () => {
  it('only the server’s own songs, by id', () => {
    assert.equal(isOlsServerSong({ id: 'tr-1' }), true);
    assert.equal(isOlsServerSong({ id: 'radio-1', url: 'https://stream.example' }), false);
    assert.equal(isOlsServerSong({ id: 'local:content://x' }), false);
    assert.equal(isOlsServerSong({ id: '' }), false);
  });
});

const state = (patch: Partial<OlsPlaybackState> = {}): OlsPlaybackState => ({
  revision: 1,
  songIds: ['a', 'b', 'c'],
  currentIndex: 0,
  positionMs: 10_000,
  isPlaying: true,
  serverTimestamp: 1_000_000,
  ...patch,
});

describe('Checking what the coordinator sends', () => {
  const frame = (m: object) => JSON.stringify({ protocolVersion: 1, ...m });

  it('accepts the version 1 messages', () => {
    const r = parseOlsServerFrame(frame({ type: 'state', state: state() }));
    assert.equal(r.ok, true);
  });

  it('refuses malformed, out of range and oversized ones', () => {
    for (const bad of [
      'not json',
      JSON.stringify({ type: 'state', state: state() }),
      frame({ type: 'state', state: state({ currentIndex: 3 }) }),
      frame({ type: 'state', state: state({ positionMs: -1 }) }),
      frame({ type: 'state', state: state({ songIds: ['a', ''], currentIndex: 0 }) }),
      frame({ type: 'state', state: state({ songIds: [], currentIndex: 1 }) }),
      frame({ type: 'state', state: { ...state(), revision: 1.5 } }),
      frame({ type: 'control.request', requestId: 'r', participantId: 'p', control: { action: 'seek' } }),
      frame({ type: 'control.request', requestId: 'r', participantId: 'p', control: { action: 'shuffle' } }),
      frame({ type: 'participants', participants: [{ id: 'p', displayName: 'x', role: 'admin' }] }),
      frame({ type: 'state', state: state({ songIds: Array(6000).fill('x'), currentIndex: 0 }) }),
      `${frame({ type: 'clock.pong', id: 'x' })}`,
      'x'.repeat(OLS_MAX_MESSAGE_CHARS + 1),
      42,
    ]) {
      const r = parseOlsServerFrame(bad);
      assert.deepEqual(r, { ok: false, unknown: false }, String(bad).slice(0, 80));
    }
  });

  it('skips a well-formed message from a later version of the protocol', () => {
    assert.deepEqual(parseOlsServerFrame(frame({ type: 'reaction', emoji: '🎉' })), { ok: false, unknown: true });
  });

  it('keeps a coordinator’s error short', () => {
    const r = parseOlsServerFrame(frame({ type: 'error', code: 'x', message: 'y'.repeat(5000) }));
    assert.ok(r.ok && r.message.type === 'error' && r.message.message.length === 300);
  });

  it('checks the bootstrap answer and the capabilities', () => {
    const access = {
      protocolVersion: 1,
      room: { id: 'r', code: 'ABC234', selfParticipantId: 'p', role: 'host', participants: [], state: state() },
      connectionUrl: 'wss://sessions.example/v1/socket',
      connectionToken: 't',
    };
    assert.equal(isOlsAccess(access), true);
    assert.equal(isOlsAccess({ ...access, protocolVersion: 2 }), false);
    assert.equal(isOlsAccess({ ...access, connectionToken: '' }), false);
    assert.equal(isOlsAccess({ ...access, room: { ...access.room, code: 'abc' } }), false);
    const caps = {
      protocol: 'openListeningSessions',
      versions: [1],
      mediaProfiles: [{ name: 'opensubsonic', versions: [1] }],
      limits: { participants: 8, stateBytes: 65536 },
    };
    assert.equal(isOlsCapabilities(caps), true);
    assert.equal(isOlsCapabilities({ ...caps, versions: [2] }), false);
    assert.equal(isOlsCapabilities({ ...caps, mediaProfiles: [{ name: 'jellyfin', versions: [1] }] }), false);
    assert.equal(isOlsCapabilities({ ...caps, limits: { participants: 0, stateBytes: 1 } }), false);
  });
});

describe('Time', () => {
  it('estimates the coordinator’s clock from the shortest round trip', () => {
    const c = new OlsClock();
    // Coordinator 5000 ms ahead; 100 ms each way, then 10 ms each way.
    assert.equal(c.add(0, 5100, 5100, 200), true);
    assert.equal(c.add(1000, 6010, 6010, 1020), true);
    assert.equal(c.serverNow(2000), 7000);
    assert.equal(c.add(5000, 1, 1, 4000), false, 'a reply before the question');
    assert.equal(c.serverNow(2000), 7000);
  });

  it('projects the host forward while playing and not while paused', () => {
    assert.equal(projectOlsPosition(state(), 1_003_000), 13_000);
    assert.equal(projectOlsPosition(state({ isPlaying: false }), 1_003_000), 10_000);
  });

  it('tells what the host did from time passing', () => {
    const a = state();
    assert.equal(olsStateIsDiscontinuous(null, a), true);
    assert.equal(olsStateIsDiscontinuous(a, state({ revision: 2, positionMs: 13_000, serverTimestamp: 1_003_000 })), false);
    assert.equal(olsStateIsDiscontinuous(a, state({ revision: 2, positionMs: 60_000, serverTimestamp: 1_003_000 })), true);
    assert.equal(olsStateIsDiscontinuous(a, state({ revision: 2, isPlaying: false })), true);
    assert.equal(olsStateIsDiscontinuous(a, state({ revision: 2, currentIndex: 1 })), true);
    assert.equal(olsStateIsDiscontinuous(a, state({ revision: 2, songIds: ['a', 'c', 'b'] })), true);
  });

  it('notices a host seeking outside the app, or a song starting over', () => {
    const last = { positionMs: 10_000, isPlaying: true, at: 0 };
    assert.equal(olsPositionJumped(last, 13_000, 3000), false);
    assert.equal(olsPositionJumped(last, 0, 3000), true);
    assert.equal(olsPositionJumped({ ...last, isPlaying: false }, 10_000, 30_000), false);
  });
});

describe('What a guest does with a state', () => {
  const local = (patch: Partial<OlsGuestLocal> = {}): OlsGuestLocal => ({
    songIds: ['a', 'b', 'c'],
    index: 0,
    isPlaying: true,
    isBuffering: false,
    positionMs: 13_000,
    hostSongDurationMs: 200_000,
    ...patch,
  });
  const opts = { serverNow: 1_003_000, discontinuous: false, correctionDue: true, awaitingTransport: false };

  it('leaves a guest in step alone', () => {
    assert.deepEqual(planOlsGuest(state(), local(), opts), { queue: 'keep', seekMs: null, play: null });
    assert.deepEqual(planOlsGuest(state(), local({ positionMs: 13_200 }), opts), { queue: 'keep', seekMs: null, play: null });
  });

  it('corrects drift, but not more often than the cooldown, and not while buffering', () => {
    assert.equal(planOlsGuest(state(), local({ positionMs: 12_000 }), opts).seekMs, 13_000);
    assert.equal(planOlsGuest(state(), local({ positionMs: 12_000 }), { ...opts, correctionDue: false }).seekMs, null);
    assert.equal(planOlsGuest(state(), local({ positionMs: 12_000, isBuffering: true }), opts).seekMs, null);
    // Unless the host itself jumped.
    assert.equal(
      planOlsGuest(state(), local({ positionMs: 12_000, isBuffering: true }), { ...opts, correctionDue: false, discontinuous: true }).seekMs,
      13_000,
    );
  });

  it('follows play and pause, unless its own request is on the way', () => {
    assert.equal(planOlsGuest(state({ isPlaying: false }), local(), opts).play, false);
    assert.equal(planOlsGuest(state(), local({ isPlaying: false }), opts).play, true);
    assert.deepEqual(planOlsGuest(state(), local({ isPlaying: false, positionMs: 1 }), { ...opts, awaitingTransport: true }), {
      queue: 'keep',
      seekMs: null,
      play: null,
    });
  });

  it('swaps a queue that changed around the same song without reloading it', () => {
    const p = planOlsGuest(state({ songIds: ['a', 'x', 'b', 'c'] }), local(), opts);
    assert.equal(p.queue, 'adopt');
    // Same song, moved: still the same sound.
    assert.equal(planOlsGuest(state({ songIds: ['z', 'a'], currentIndex: 1 }), local(), opts).queue, 'adopt');
  });

  it('loads another song where the host is, playing or not', () => {
    assert.deepEqual(planOlsGuest(state({ currentIndex: 2 }), local(), opts), { queue: 'load', seekMs: 13_000, play: true });
    assert.deepEqual(planOlsGuest(state({ songIds: ['q'], isPlaying: false }), local(), opts), {
      queue: 'load',
      seekMs: 10_000,
      play: false,
    });
    // A song that never arrived stands in with no id, and is loaded.
    assert.equal(planOlsGuest(state(), local({ songIds: ['', 'b', 'c'] }), opts).queue, 'load');
  });

  it('waits when it reached the next song a moment before the host', () => {
    const nearEnd = state({ positionMs: 198_500 });
    const ahead = local({ index: 1, positionMs: 200 });
    assert.equal(planOlsGuest(nearEnd, ahead, opts).queue, 'wait');
    // A host that says it stopped at the very end is between two songs.
    assert.equal(planOlsGuest(state({ positionMs: 199_500, isPlaying: false }), ahead, opts).queue, 'wait');
    // Not in the middle of the song, and not when the host paused before the end.
    assert.equal(planOlsGuest(state(), ahead, opts).queue, 'load');
    assert.equal(planOlsGuest(state({ positionMs: 197_000, isPlaying: false }), ahead, opts).queue, 'load');
  });

  it('plays its own last second out when the host stops at the end of the song', () => {
    const end = state({ positionMs: 199_200, isPlaying: false });
    assert.equal(planOlsGuest(end, local({ positionMs: 199_000 }), opts).play, null);
    assert.equal(planOlsGuest(state({ positionMs: 120_000, isPlaying: false }), local({ positionMs: 120_000 }), opts).play, false);
  });

  it('empties when the host does', () => {
    assert.equal(planOlsGuest(state({ songIds: [], currentIndex: 0 }), local(), opts).queue, 'clear');
  });
});

// ── Against a coordinator ───────────────────────────────────────────────────

const socket = (url: string) => new WebSocket(url) as unknown as OlsSocket;

async function post(base: string, path: string, body: object): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

const profile = (libraryId = LIB) => ({ name: 'opensubsonic', version: 1, libraryId });

interface Client {
  conn: OlsConnection;
  messages: OlsServerMessage[];
  closes: string[];
  access: OlsAccess;
}

async function client(
  coord: MockCoordinator,
  access: OlsAccess,
  onMessage?: (m: OlsServerMessage) => void | Promise<void>,
): Promise<Client> {
  const messages: OlsServerMessage[] = [];
  const closes: string[] = [];
  const conn = new OlsConnection(access, coord.url, socket, {
    onMessage: async (m) => {
      messages.push(m);
      await onMessage?.(m);
    },
    onClose: (r) => closes.push(r),
  });
  await conn.open();
  return { conn, messages, closes, access };
}

async function host(coord: MockCoordinator, onMessage?: (m: OlsServerMessage) => void | Promise<void>) {
  const r = await post(coord.url, '/v1/rooms', { protocolVersion: 1, displayName: 'Host', mediaProfile: profile() });
  assert.equal(r.status, 200);
  assert.ok(isOlsAccess(r.body));
  return client(coord, r.body, onMessage);
}

async function joinAccess(coord: MockCoordinator, code: string, libraryId = LIB) {
  return post(coord.url, '/v1/rooms/join', { protocolVersion: 1, code, mediaProfile: profile(libraryId) });
}

async function guest(coord: MockCoordinator, code: string, onMessage?: (m: OlsServerMessage) => void | Promise<void>) {
  const r = await joinAccess(coord, code);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(isOlsAccess(r.body));
  return client(coord, r.body, onMessage);
}

const until = async (check: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
};

const hostState = (ids: string[], index = 0, positionMs = 0, isPlaying = true) => ({
  type: 'state.update' as const,
  protocolVersion: 1 as const,
  state: { songIds: ids, currentIndex: index, positionMs, isPlaying },
});

describe('A room, end to end', () => {
  let coord: MockCoordinator;
  before(async () => {
    coord = await startMockCoordinator({ participants: 4 });
  });
  after(() => coord.close());

  it('the host shares its queue; a guest that joins gets it, and the clock', async () => {
    const h = await host(coord);
    assert.ok(h.conn.send(hostState(['s1', 's2'], 1, 5000)));
    const g = await guest(coord, h.access.room.code);
    const auth = g.messages[0];
    assert.equal(auth.type, 'authenticated');
    assert.ok(auth.type === 'authenticated' && auth.room.role === 'guest');
    assert.deepEqual(auth.type === 'authenticated' && auth.room.state.songIds, ['s1', 's2']);
    await until(() => g.conn.clock.ready);
    h.conn.close();
    g.conn.close();
  });

  it('a ticket works once', async () => {
    const r = await post(coord.url, '/v1/rooms', { protocolVersion: 1, mediaProfile: profile() });
    const access = r.body as OlsAccess;
    const first = await client(coord, access);
    await assert.rejects(client(coord, access), (e: unknown) => e instanceof OlsConnectionError && e.code === 'unauthorized');
    first.conn.close();
  });

  it('an expired ticket is refused', async () => {
    const short = await startMockCoordinator({ ticketMs: 1 });
    const r = await post(short.url, '/v1/rooms', { protocolVersion: 1, mediaProfile: profile() });
    await new Promise((res) => setTimeout(res, 20));
    await assert.rejects(client(short, r.body as OlsAccess), OlsConnectionError);
    await short.close();
  });

  it('refuses a socket address that is not the coordinator’s, before connecting', async () => {
    const r = await post(coord.url, '/v1/rooms', { protocolVersion: 1, mediaProfile: profile() });
    const access = { ...(r.body as OlsAccess), connectionUrl: 'ws://127.0.0.1:1/v1/socket' };
    let created = false;
    const conn = new OlsConnection(access, coord.url, (u) => ((created = true), socket(u)), {
      onMessage: () => {},
      onClose: () => {},
    });
    await assert.rejects(conn.open(), (e: unknown) => e instanceof OlsConnectionError && e.code === 'unsafe');
    assert.equal(created, false);
  });

  it('says clearly when a room is missing, full or on another library', async () => {
    assert.deepEqual((await joinAccess(coord, 'ZZZZZZ')).body, { error: { code: 'room_not_found', message: 'room_not_found' } });
    const h = await host(coord);
    const code = h.access.room.code;
    assert.equal(((await joinAccess(coord, code, sha('https://other.example'))).body as { error: { code: string } }).error.code, 'library_mismatch');
    const guests = [await guest(coord, code), await guest(coord, code), await guest(coord, code)];
    assert.equal(((await joinAccess(coord, code)).body as { error: { code: string } }).error.code, 'room_full');
    for (const g of guests) g.conn.close();
    h.conn.close();
  });

  it('only the newest of a burst of states is handled, and never two at once', async () => {
    const h = await host(coord);
    let busy = 0;
    let overlapped = false;
    const handled: number[] = [];
    const g = await guest(coord, h.access.room.code, async (m) => {
      if (m.type !== 'state') return;
      busy++;
      if (busy > 1) overlapped = true;
      handled.push(m.state.revision);
      // Applying a state waits on the server and the player.
      await new Promise((r) => setTimeout(r, 60));
      busy--;
    });
    for (let i = 0; i < 20; i++) h.conn.send(hostState([`s${i}`], 0, i * 100));
    await until(() => handled.length > 0 && handled[handled.length - 1] === g.conn.latestRevision);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(overlapped, false);
    assert.ok(handled.length < 20, `handled ${handled.length} of 20`);
    assert.deepEqual([...handled].sort((a, b) => a - b), handled, 'in order');
    const last = g.messages.filter((m) => m.type === 'state').pop();
    assert.ok(last?.type === 'state' && last.state.songIds[0] === 's19');
    h.conn.close();
    g.conn.close();
  });

  it('a guest’s requests reach the host, and only the host’s state moves the room', async () => {
    const requests: string[] = [];
    const h = await host(coord, (m) => {
      if (m.type === 'control.request') requests.push(m.control.action);
    });
    const g = await guest(coord, h.access.room.code);
    const g2 = await guest(coord, h.access.room.code);
    for (const c of [g, g2]) {
      c.conn.send({ type: 'control.request', protocolVersion: 1, requestId: 'a', control: { action: 'next' } });
      c.conn.send({ type: 'control.request', protocolVersion: 1, requestId: 'b', control: { action: 'seek', positionMs: 1000 } });
    }
    // A guest cannot publish a state.
    g.conn.send(hostState(['evil']));
    await until(() => requests.length === 4);
    await until(() => g.messages.some((m) => m.type === 'error'));
    assert.equal(g.messages.some((m) => m.type === 'state'), false);
    for (const c of [h, g, g2]) c.conn.close();
  });

  it('a guest leaves; the host ends the room for everybody', async () => {
    const h = await host(coord);
    const g = await guest(coord, h.access.room.code);
    const g2 = await guest(coord, h.access.room.code);
    await g.conn.request('leave');
    await until(() => h.messages.some((m) => m.type === 'participants' && m.participants.length === 2));
    await h.conn.request('end');
    await until(() => g2.messages.some((m) => m.type === 'session.ended'));
    await until(() => g2.closes.length === 1);
    assert.equal(coord.rooms.has(h.access.room.code), false);
  });

  it('a coordinator going away is a lost connection, said once', async () => {
    const h = await host(coord);
    const g = await guest(coord, h.access.room.code);
    coord.dropAll();
    await until(() => h.closes.length === 1 && g.closes.length === 1);
    assert.deepEqual(g.closes, ['lost']);
    assert.equal(g.conn.send(hostState([])), false);
  });

  it('junk from the coordinator ends the connection; a newer message type does not', async () => {
    const h = await host(coord);
    coord.broadcastRaw(JSON.stringify({ type: 'reaction', protocolVersion: 1 }));
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(h.closes, []);
    coord.broadcastRaw(JSON.stringify({ type: 'state', protocolVersion: 1, state: { revision: -1 } }));
    await until(() => h.closes.length === 1);
    assert.deepEqual(h.closes, ['invalid']);
  });

  it('an oversized frame ends the connection', async () => {
    const h = await host(coord);
    coord.broadcastRaw(JSON.stringify({ type: 'participants', protocolVersion: 1, participants: [], pad: 'x'.repeat(OLS_MAX_MESSAGE_CHARS) }));
    await until(() => h.closes.length === 1);
    assert.deepEqual(h.closes, ['invalid']);
  });

  it('a stale or repeated state never takes the room back', async () => {
    const h = await host(coord);
    const g = await guest(coord, h.access.room.code);
    h.conn.send(hostState(['new']));
    await until(() => g.messages.some((m) => m.type === 'state'));
    const before = g.messages.length;
    coord.broadcastRaw(JSON.stringify({ type: 'state', protocolVersion: 1, state: { ...state({ revision: 0, songIds: ['old'] }) } }));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(g.messages.length, before);
    h.conn.close();
    g.conn.close();
  });
});

describe('Up to the participant limit', () => {
  it('every guest gets every change, and the room says who is in it', async () => {
    const LIMIT = 32;
    const coord = await startMockCoordinator({ participants: LIMIT });
    const h = await host(coord);
    const guests = await Promise.all(
      Array.from({ length: LIMIT - 1 }, () => guest(coord, h.access.room.code)),
    );
    assert.equal((await joinAccess(coord, h.access.room.code)).status, 409);
    for (let i = 0; i < 10; i++) h.conn.send(hostState(['a', 'b', 'c'], i % 3, i * 1000));
    await until(() => guests.every((g) => g.conn.latestRevision >= 10), 5000);
    for (const g of guests) {
      const last = g.messages.filter((m) => m.type === 'state').pop();
      assert.ok(last?.type === 'state' && last.state.positionMs === 9000);
    }
    await until(() =>
      h.messages.some((m) => m.type === 'participants' && m.participants.length === LIMIT),
    );
    await h.conn.request('end');
    await until(() => guests.every((g) => g.closes.length === 1), 5000);
    await coord.close();
  });

  it('nothing a client sends carries a credential, an address of the music server or a stream', async () => {
    const coord = await startMockCoordinator();
    const h = await host(coord);
    const g = await guest(coord, h.access.room.code);
    h.conn.send(hostState(['tr-1', 'tr-2'], 1, 1234));
    g.conn.send({ type: 'control.request', protocolVersion: 1, requestId: 'x', control: { action: 'pause' } });
    await new Promise((r) => setTimeout(r, 100));
    const all = coord.traffic.join('\n');
    assert.doesNotMatch(all, /\b(u|t|s|p)=|token=|password|salt|\/rest\/|stream|music\.example|https?:\/\//i);
    // The ticket itself only ever travels in the socket's first message.
    for (const line of coord.traffic.filter((l) => l.includes('connectionToken'))) {
      assert.equal(JSON.parse(line).type, 'authenticate');
    }
    h.conn.close();
    g.conn.close();
    await coord.close();
  });
});
