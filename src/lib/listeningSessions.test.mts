import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ListeningSessionClock,
  createListeningSessionInvite,
  isListeningSessionAccess,
  isListeningSessionCapabilities,
  isKnownListeningSessionServerMessageType,
  isSafeListeningSessionConnectionUrl,
  isListeningSessionServerMessage,
  isListeningSessionServerTrack,
  listeningSessionInviteUrl,
  listeningSessionStateHasDiscontinuity,
  normalizeListeningSessionCode,
  normalizeListeningSessionCoordinatorUrl,
  normalizeListeningSessionServerUrl,
  projectedListeningPositionMs,
  shouldReconcileListeningPosition,
} from './listeningSessions.ts';
import {
  handleListeningSessionControl,
  registerListeningSessionBridge,
  withListeningSessionBypass,
} from './listeningSessionBridge.ts';

test('negotiates Open Listening Sessions v1 with the OpenSubsonic media profile', () => {
  const capabilities = {
    protocol: 'openListeningSessions',
    versions: [1],
    mediaProfiles: [{ name: 'opensubsonic', versions: [1] }],
    limits: { participants: 32, stateBytes: 1_048_576 },
  };
  assert.equal(isListeningSessionCapabilities(capabilities), true);
  assert.equal(isListeningSessionCapabilities({ ...capabilities, versions: [2] }), false);
  assert.equal(
    isListeningSessionCapabilities({
      ...capabilities,
      mediaProfiles: [{ name: 'other', versions: [1] }],
    }),
    false,
  );
});

test('normalizes a human-entered room code', () => {
  assert.equal(normalizeListeningSessionCode(' ab-c 12!xy9 '), 'ABC12XY9');
});

test('accepts only server-resolvable tracks in a version-1 room', () => {
  assert.equal(isListeningSessionServerTrack({ id: 'song-1' }), true);
  assert.equal(isListeningSessionServerTrack({ id: 'radio-1', url: 'https://radio.example' }), false);
  assert.equal(isListeningSessionServerTrack({ id: 'local-1', localUri: 'file:///music.flac' }), false);
  assert.equal(isListeningSessionServerTrack({ id: '' }), false);
});

test('validates untrusted REST bootstrap data before opening a socket', () => {
  const access = {
    room: {
      id: 'room-1',
      code: 'ABC123',
      selfParticipantId: 'participant-1',
      role: 'guest',
      participants: [],
      state: {
        revision: 1,
        songIds: ['song-1'],
        currentIndex: 0,
        positionMs: 500,
        isPlaying: true,
        serverTimestamp: 10_000,
      },
    },
    connectionUrl: 'wss://sessions.example/v1/socket',
    connectionToken: 'single-use-token',
  };
  assert.equal(isListeningSessionAccess(access), true);
  assert.equal(isListeningSessionAccess({ ...access, connectionToken: '' }), false);
  assert.equal(
    isListeningSessionAccess({
      ...access,
      room: { ...access.room, state: { ...access.room.state, currentIndex: 4 } },
    }),
    false,
  );
});

test('builds portable client-neutral invite data', () => {
  const libraryId = `sha256:${'a'.repeat(64)}`;
  assert.deepEqual(
    createListeningSessionInvite(
      'https://sessions.example/',
      'https://music.example/subsonic/',
      libraryId,
      'ab-c123',
    ),
    {
      protocol: 'openListeningSessions',
      version: 1,
      coordinator: 'https://sessions.example',
      code: 'ABC123',
      mediaProfile: {
        name: 'opensubsonic',
        version: 1,
        server: 'https://music.example/subsonic',
        libraryId,
      },
    },
  );
  assert.throws(
    () =>
      createListeningSessionInvite(
        'https://sessions.example',
        'https://listener:secret@music.example',
        libraryId,
        'ABC123',
      ),
    /credential-free/,
  );
  assert.throws(
    () =>
      createListeningSessionInvite(
        'https://sessions.example?apiKey=secret',
        'https://music.example',
        libraryId,
        'ABC123',
      ),
    /credential-free/,
  );
});

test('binds the portable invite to a credential-free Resonus deep link', () => {
  const data = createListeningSessionInvite(
    'https://sessions.example',
    'https://music.example/subsonic',
    `sha256:${'a'.repeat(64)}`,
    'ab-c123',
  );
  const invite = listeningSessionInviteUrl(data);
  assert.equal(
    invite,
    `resonus:///jam?coordinator=https%3A%2F%2Fsessions.example&server=https%3A%2F%2Fmusic.example%2Fsubsonic&libraryId=sha256%3A${'a'.repeat(64)}&code=ABC123`,
  );
  const parsed = new URL(invite);
  assert.equal(parsed.pathname, '/jam');
  assert.equal(parsed.searchParams.get('coordinator'), 'https://sessions.example');
  assert.equal(parsed.searchParams.get('server'), 'https://music.example/subsonic');
  assert.equal(parsed.searchParams.get('libraryId'), `sha256:${'a'.repeat(64)}`);
  assert.equal(parsed.searchParams.get('code'), 'ABC123');
  assert.equal(parsed.username, '');
  assert.equal(parsed.password, '');
});

test('accepts only the credential-free WebSocket mapping of the coordinator endpoint', () => {
  assert.equal(
    isSafeListeningSessionConnectionUrl(
      'wss://sessions.example/v1/socket',
      'https://sessions.example',
    ),
    true,
  );
  assert.equal(
    isSafeListeningSessionConnectionUrl(
      'ws://sessions.example/base/v1/socket',
      'http://sessions.example/base',
    ),
    true,
  );
  assert.equal(
    isSafeListeningSessionConnectionUrl(
      'wss://sessions.example/v1/socket',
      'http://sessions.example',
    ),
    false,
  );
  assert.equal(
    isSafeListeningSessionConnectionUrl(
      'ws://sessions.example/v1/socket',
      'https://sessions.example',
    ),
    false,
  );
  assert.equal(
    isSafeListeningSessionConnectionUrl(
      'wss://other.example/v1/socket',
      'https://sessions.example',
    ),
    false,
  );
  assert.equal(
    isSafeListeningSessionConnectionUrl(
      'wss://sessions.example/v1/socket?connectionToken=secret',
      'https://sessions.example',
    ),
    false,
  );
  assert.equal(
    isSafeListeningSessionConnectionUrl(
      'wss://sessions.example/unrelated',
      'https://sessions.example',
    ),
    false,
  );
});

test('normalizes coordinator and OpenSubsonic URLs without credentials', () => {
  assert.equal(
    normalizeListeningSessionCoordinatorUrl('HTTPS://Sessions.Example:443/base/'),
    'https://sessions.example/base',
  );
  assert.equal(
    normalizeListeningSessionServerUrl('HTTPS://Music.Example:443/rest/'),
    'https://music.example/rest',
  );
  assert.throws(
    () => normalizeListeningSessionServerUrl('https://music.example?token=secret'),
    /credential-free/,
  );
});

test('projects a playing position in coordinator time', () => {
  assert.equal(
    projectedListeningPositionMs(
      {
        revision: 1,
        songIds: ['song-1'],
        currentIndex: 0,
        positionMs: 5000,
        isPlaying: true,
        serverTimestamp: 10_000,
      },
      10_700,
    ),
    5700,
  );
});

test('does not advance a paused position', () => {
  assert.equal(
    projectedListeningPositionMs(
      {
        revision: 1,
        songIds: ['song-1'],
        currentIndex: 0,
        positionMs: 5000,
        isPlaying: false,
        serverTimestamp: 10_000,
      },
      12_000,
    ),
    5000,
  );
});

test('reconciles only beyond the drift threshold', () => {
  assert.equal(shouldReconcileListeningPosition(1000, 1250), false);
  assert.equal(shouldReconcileListeningPosition(1000, 1251), true);
});

test('distinguishes explicit room jumps from routine heartbeat drift', () => {
  const previous = {
    revision: 4,
    songIds: ['one', 'two'],
    currentIndex: 0,
    positionMs: 10_000,
    isPlaying: true,
    serverTimestamp: 20_000,
  };
  assert.equal(
    listeningSessionStateHasDiscontinuity(previous, {
      ...previous,
      revision: 5,
      positionMs: 13_000,
      serverTimestamp: 23_000,
    }),
    false,
  );
  assert.equal(
    listeningSessionStateHasDiscontinuity(previous, {
      ...previous,
      revision: 5,
      positionMs: 80_000,
      serverTimestamp: 23_000,
    }),
    true,
  );
  assert.equal(
    listeningSessionStateHasDiscontinuity(previous, {
      ...previous,
      revision: 5,
      currentIndex: 1,
      positionMs: 0,
      serverTimestamp: 23_000,
    }),
    true,
  );
});

test('limits the authoritative bypass to synchronous mutations', async () => {
  const unregister = registerListeningSessionBridge(() => true, () => true);
  let finish!: () => void;
  try {
    assert.equal(
      withListeningSessionBypass(() =>
        handleListeningSessionControl({ action: 'pause' }),
      ),
      false,
    );
    const nativeWork = withListeningSessionBypass(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    assert.equal(handleListeningSessionControl({ action: 'play' }), true);
    finish();
    await nativeWork;
  } finally {
    unregister();
  }
});

test('keeps the lowest-round-trip clock sample', () => {
  const clock = new ListeningSessionClock();
  assert.equal(clock.addSample(1000, 1110, 1120, 1220), 5);
  // Higher RTT and an intentionally wild offset must not replace it.
  assert.equal(clock.addSample(2000, 2400, 2410, 2810), 5);
  assert.equal(clock.serverNow(3000), 3005);
});

test('ages a stale best clock sample out of the recent window', () => {
  const clock = new ListeningSessionClock();
  assert.equal(clock.addSample(1000, 1110, 1120, 1220), 5);
  for (let index = 0; index < 3; index += 1) {
    const base = 2000 + index * 1000;
    assert.equal(clock.addSample(base, base + 250, base + 260, base + 310), 5);
  }
  // The fourth recent sample evicts the old low-RTT result after a clock shift.
  assert.equal(clock.addSample(5000, 5250, 5260, 5310), 100);
});

test('accepts valid coordinator messages and rejects malformed known messages', () => {
  assert.equal(isKnownListeningSessionServerMessageType('session.ended'), true);
  assert.equal(isKnownListeningSessionServerMessageType('future.message'), false);
  assert.equal(
    isListeningSessionServerMessage({
      type: 'session.ended',
      protocolVersion: 1,
      requestId: 'host-end-1',
    }),
    true,
  );
  assert.equal(
    isListeningSessionServerMessage({ type: 'session.ended', protocolVersion: 1 }),
    false,
  );
  assert.equal(
    isListeningSessionServerMessage({
      type: 'state',
      protocolVersion: 1,
      state: {
        revision: 1,
        songIds: ['song-1'],
        currentIndex: 4,
        positionMs: 0,
        isPlaying: true,
        serverTimestamp: Date.now(),
      },
    }),
    false,
  );
});
