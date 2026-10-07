/**
 * A stand-in Open Listening Sessions coordinator, for tests only.
 *
 * The real one is its own project and Resonus is only ever its client. This is
 * just enough of the version 1 contract, on Node's own `http` with the
 * WebSocket framing written out, to put the client's real connection code
 * against something that answers: rooms, single-use tickets, the clock, host
 * states, guest requests, leaving and ending, the participant limit, and a
 * record of everything it was sent so a test can look for what must never be
 * in it.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

interface Peer {
  id: string;
  room: Room;
  role: 'host' | 'guest';
  displayName: string;
  socket: Duplex | null;
}

interface Room {
  id: string;
  code: string;
  libraryId: string;
  peers: Peer[];
  state: {
    revision: number;
    songIds: string[];
    currentIndex: number;
    positionMs: number;
    isPlaying: boolean;
    serverTimestamp: number;
  };
}

export interface MockCoordinator {
  url: string;
  /** Every request body and socket frame received, as text. */
  traffic: string[];
  rooms: Map<string, Room>;
  /** Sends raw text to every socket (to test what a client does with junk). */
  broadcastRaw(text: string): void;
  /** Drops every socket without a word, like a restart. */
  dropAll(): void;
  close(): Promise<void>;
}

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function frame(text: string): Buffer {
  const payload = Buffer.from(text);
  const len = payload.length;
  const head =
    len < 126
      ? Buffer.from([0x81, len])
      : len < 65536
        ? Buffer.from([0x81, 126, len >> 8, len & 0xff])
        : (() => {
            const b = Buffer.alloc(10);
            b[0] = 0x81;
            b[1] = 127;
            b.writeBigUInt64BE(BigInt(len), 2);
            return b;
          })();
  return Buffer.concat([head, payload]);
}

/** Reads client frames off a socket; unmasked or fragmented ones end it. */
function readFrames(socket: Duplex, onText: (text: string) => void, onClose: () => void) {
  let buf = Buffer.alloc(0);
  socket.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (buf.length < 2) return;
      const fin = (buf[0] & 0x80) !== 0;
      const op = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let at = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        at = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        len = Number(buf.readBigUInt64BE(2));
        at = 10;
      }
      if (!masked || !fin) {
        socket.destroy();
        return;
      }
      if (buf.length < at + 4 + len) return;
      const mask = buf.subarray(at, at + 4);
      const data = Buffer.from(buf.subarray(at + 4, at + 4 + len));
      for (let i = 0; i < data.length; i++) data[i] ^= mask[i % 4];
      buf = buf.subarray(at + 4 + len);
      if (op === 0x8) {
        socket.end(Buffer.from([0x88, 0]));
        onClose();
        return;
      }
      if (op === 0x9) {
        socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data]));
        continue;
      }
      if (op === 0x1) onText(data.toString('utf8'));
    }
  });
  socket.on('close', onClose);
  socket.on('error', () => socket.destroy());
}

export async function startMockCoordinator(
  opts: { participants?: number; stateBytes?: number; ticketMs?: number; port?: number } = {},
): Promise<MockCoordinator> {
  const limit = opts.participants ?? 8;
  const stateBytes = opts.stateBytes ?? 1_048_576;
  const traffic: string[] = [];
  const rooms = new Map<string, Room>();
  const tickets = new Map<string, { peer: Peer; expires: number }>();
  const sockets = new Set<Duplex>();
  let seq = 0;
  const id = (p: string) => `${p}-${++seq}`;
  const code = (): string => {
    const a = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 6; i++) c += a[randomBytes(1)[0] % a.length];
    return rooms.has(c) ? code() : c;
  };
  let base = '';

  const send = (peer: Peer, msg: object) => {
    if (peer.socket && !peer.socket.destroyed) peer.socket.write(frame(JSON.stringify(msg)));
  };
  const broadcast = (room: Room, msg: object) => room.peers.forEach((p) => send(p, msg));
  const participants = (room: Room) =>
    room.peers.map((p) => ({ id: p.id, displayName: p.displayName, role: p.role }));
  const roomFor = (peer: Peer) => ({
    id: peer.room.id,
    code: peer.room.code,
    selfParticipantId: peer.id,
    role: peer.role,
    participants: participants(peer.room),
    state: peer.room.state,
  });
  const access = (peer: Peer) => {
    const token = randomBytes(24).toString('base64url');
    tickets.set(token, { peer, expires: Date.now() + (opts.ticketMs ?? 30_000) });
    return {
      protocolVersion: 1,
      room: roomFor(peer),
      connectionUrl: `${base.replace(/^http/, 'ws')}/v1/socket`,
      connectionToken: token,
    };
  };
  const leaveRoom = (peer: Peer) => {
    const room = peer.room;
    room.peers = room.peers.filter((p) => p !== peer);
    if (peer.role === 'host') {
      broadcast(room, { type: 'session.ended', protocolVersion: 1, requestId: 'host-left' });
      room.peers.forEach((p) => p.socket?.end());
      rooms.delete(room.code);
    } else {
      broadcast(room, { type: 'participants', protocolVersion: 1, participants: participants(room) });
    }
  };

  const json = (res: import('node:http').ServerResponse, status: number, body: object) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const err = (res: import('node:http').ServerResponse, status: number, code: string) =>
    json(res, status, { error: { code, message: code } });

  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 65_536) req.destroy();
    });
    req.on('end', () => {
      traffic.push(`${req.method} ${req.url} ${body}`);
      if (req.method === 'GET' && req.url === '/v1/capabilities') {
        json(res, 200, {
          protocol: 'openListeningSessions',
          versions: [1],
          mediaProfiles: [{ name: 'opensubsonic', versions: [1] }],
          limits: { participants: limit, stateBytes },
        });
        return;
      }
      let b: Record<string, unknown>;
      try {
        b = JSON.parse(body);
      } catch {
        err(res, 400, 'invalid_request');
        return;
      }
      const profile = b.mediaProfile as { name?: string; libraryId?: string } | undefined;
      if (b.protocolVersion !== 1 || profile?.name !== 'opensubsonic' || typeof profile.libraryId !== 'string') {
        err(res, 400, 'invalid_request');
        return;
      }
      const displayName = typeof b.displayName === 'string' ? b.displayName : 'Listener';
      if (req.method === 'POST' && req.url === '/v1/rooms') {
        const room: Room = {
          id: id('room'),
          code: code(),
          libraryId: profile.libraryId,
          peers: [],
          state: { revision: 0, songIds: [], currentIndex: 0, positionMs: 0, isPlaying: false, serverTimestamp: Date.now() },
        };
        rooms.set(room.code, room);
        const peer: Peer = { id: id('p'), room, role: 'host', displayName, socket: null };
        room.peers.push(peer);
        json(res, 200, access(peer));
        return;
      }
      if (req.method === 'POST' && req.url === '/v1/rooms/join') {
        const room = rooms.get(String(b.code));
        if (!room) return err(res, 404, 'room_not_found');
        if (room.libraryId !== profile.libraryId) return err(res, 409, 'library_mismatch');
        if (room.peers.length >= limit) return err(res, 409, 'room_full');
        const peer: Peer = { id: id('p'), room, role: 'guest', displayName, socket: null };
        room.peers.push(peer);
        broadcast(room, { type: 'participants', protocolVersion: 1, participants: participants(room) });
        json(res, 200, access(peer));
        return;
      }
      err(res, 404, 'not_found');
    });
  });

  server.on('upgrade', (req: IncomingMessage, socket: Duplex) => {
    const key = req.headers['sec-websocket-key'];
    if (req.url !== '/v1/socket' || typeof key !== 'string') {
      socket.destroy();
      return;
    }
    sockets.add(socket);
    const accept = createHash('sha1').update(key + GUID).digest('base64');
    socket.write(
      `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    let peer: Peer | null = null;
    readFrames(
      socket,
      (text) => {
        traffic.push(text);
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(text);
        } catch {
          socket.end();
          return;
        }
        if (!peer) {
          const ticket = m.type === 'authenticate' ? tickets.get(String(m.connectionToken)) : undefined;
          // Single use, whatever happens next.
          if (ticket) tickets.delete(String(m.connectionToken));
          if (!ticket || ticket.expires < Date.now() || !rooms.has(ticket.peer.room.code)) {
            socket.write(frame(JSON.stringify({ type: 'error', protocolVersion: 1, code: 'unauthorized', message: 'no' })));
            socket.end();
            return;
          }
          peer = ticket.peer;
          peer.socket = socket;
          send(peer, { type: 'authenticated', protocolVersion: 1, room: roomFor(peer) });
          return;
        }
        const p = peer;
        const room = p.room;
        switch (m.type) {
          case 'clock.ping': {
            const now = Date.now();
            send(p, { type: 'clock.pong', protocolVersion: 1, id: m.id, clientTimestamp: m.clientTimestamp, serverReceivedTimestamp: now, serverSentTimestamp: Date.now() });
            return;
          }
          case 'state.update': {
            if (p.role !== 'host') return send(p, { type: 'error', protocolVersion: 1, code: 'forbidden', message: 'host only' });
            const s = m.state as Room['state'];
            room.state = { ...s, revision: room.state.revision + 1, serverTimestamp: Date.now() };
            broadcast(room, { type: 'state', protocolVersion: 1, state: room.state });
            return;
          }
          case 'control.request': {
            if (p.role !== 'guest') return;
            const hostPeer = room.peers.find((x) => x.role === 'host');
            if (hostPeer) send(hostPeer, { type: 'control.request', protocolVersion: 1, requestId: m.requestId, participantId: p.id, control: m.control });
            return;
          }
          case 'session.leave':
            send(p, { type: 'session.left', protocolVersion: 1, requestId: m.requestId });
            leaveRoom(p);
            peer = null;
            socket.end();
            return;
          case 'session.end':
            if (p.role !== 'host') return;
            broadcast(room, { type: 'session.ended', protocolVersion: 1, requestId: m.requestId });
            room.peers.forEach((x) => x.socket?.end());
            rooms.delete(room.code);
            return;
        }
      },
      () => {
        sockets.delete(socket);
        if (peer && peer.room.peers.includes(peer)) leaveRoom(peer);
        peer = null;
      },
    );
  });

  await new Promise<void>((r) => server.listen(opts.port ?? 0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return {
    url: base,
    traffic,
    rooms,
    broadcastRaw: (text) => sockets.forEach((s) => s.write(frame(text))),
    dropAll: () => sockets.forEach((s) => s.destroy()),
    close: () =>
      new Promise((r) => {
        sockets.forEach((s) => s.destroy());
        server.close(() => r());
      }),
  };
}
