/**
 * One socket to an Open Listening Sessions coordinator, from the ticket in to
 * the last frame. Pure on purpose: it takes the socket from whoever creates it,
 * so the app hands it React Native's and `pnpm test` hands it Node's, against
 * a coordinator played by the test.
 *
 * Three things here are about order, and all three were bugs once:
 *  - Messages are handled one at a time. Applying a state waits on the server
 *    (song details) and on the player (loading, seeking), and two of them
 *    running at once is two songs installed in either order.
 *  - Of the states waiting their turn only the newest is handled. A host
 *    skipping five songs sends five states, and a guest that played each one
 *    for a moment on the way to the fifth was heard doing it. No timer does
 *    the collecting: timers stop with the screen off, and a guest's screen is
 *    usually off.
 *  - A state older than one already seen is dropped on arrival, so a late
 *    frame cannot take the room back.
 */
import {
  OLS_HEARTBEAT_MS,
  OlsClock,
  isSafeOlsConnectionUrl,
  olsRequestId,
  parseOlsServerFrame,
  type OlsAccess,
  type OlsClientMessage,
  type OlsRoom,
  type OlsServerMessage,
} from './listeningSessions';

/** The part of a WebSocket this needs; React Native's and Node's both fit. */
export interface OlsSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
}

const OPEN = 1;

/** Why a connection ended without being asked to. */
export type OlsCloseReason = 'closed' | 'lost' | 'invalid';

export class OlsConnectionError extends Error {
  /** A coordinator's error code, or one of this client's: `timeout`, `lost`, `invalid`, `unsafe`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface OlsConnectionEvents {
  /** Every message that passed the checks, one at a time and in order. */
  onMessage(message: OlsServerMessage): void | Promise<void>;
  /** The first time the coordinator's clock is known (or given up on). */
  onClockReady?(): void | Promise<void>;
  /** Every heartbeat, after the clock is asked. */
  onHeartbeat?(): void;
  /** The connection ended by itself. Not called after `close()`. */
  onClose(reason: OlsCloseReason): void;
  /** Something thrown while handling a message. The room carries on. */
  onFault?(error: unknown): void;
}

export interface OlsConnectionOptions {
  authTimeoutMs?: number;
  heartbeatMs?: number;
  /** How long to wait for the first clock answer before trusting the phone's. */
  clockFallbackMs?: number;
  now?: () => number;
}

export class OlsConnection {
  readonly clock = new OlsClock();
  /** The newest revision seen on the wire, handled or not. */
  latestRevision = -1;
  private socket: OlsSocket | null = null;
  private authenticated = false;
  private closedByUs = false;
  private chain: Promise<void> = Promise.resolve();
  private pendingState: OlsServerMessage | null = null;
  private stateQueued = false;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private clockFallback: ReturnType<typeof setTimeout> | null = null;
  private clockAnnounced = false;
  private lastPingAt = 0;
  private lifecycle: {
    requestId: string;
    resolve: () => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  } | null = null;
  private readonly now: () => number;
  private readonly access: OlsAccess;
  private readonly coordinatorUrl: string;
  private readonly createSocket: (url: string) => OlsSocket;
  private readonly events: OlsConnectionEvents;
  private readonly options: OlsConnectionOptions;

  // No parameter properties: Node runs the tests by stripping types, and
  // those are code rather than types.
  constructor(
    access: OlsAccess,
    coordinatorUrl: string,
    createSocket: (url: string) => OlsSocket,
    events: OlsConnectionEvents,
    options: OlsConnectionOptions = {},
  ) {
    this.access = access;
    this.coordinatorUrl = coordinatorUrl;
    this.createSocket = createSocket;
    this.events = events;
    this.options = options;
    this.now = options.now ?? Date.now;
  }

  get isOpen(): boolean {
    return this.authenticated && !this.closedByUs && this.socket?.readyState === OPEN;
  }

  /** Connects and signs in. Resolves with the room once its first message has been handled. */
  open(): Promise<OlsRoom> {
    if (!isSafeOlsConnectionUrl(this.access.connectionUrl, this.coordinatorUrl)) {
      return Promise.reject(
        new OlsConnectionError('unsafe', 'The coordinator sent a connection address that is not its own'),
      );
    }
    return new Promise<OlsRoom>((resolve, reject) => {
      let settled = false;
      const fail = (e: OlsConnectionError) => {
        if (settled) return;
        settled = true;
        clearTimeout(authTimer);
        this.teardown(true);
        reject(e);
      };
      const authTimer = setTimeout(
        () => fail(new OlsConnectionError('timeout', 'The coordinator did not let this client in')),
        this.options.authTimeoutMs ?? 10_000,
      );
      let socket: OlsSocket;
      try {
        socket = this.createSocket(this.access.connectionUrl);
      } catch {
        fail(new OlsConnectionError('lost', 'Could not connect to the coordinator'));
        return;
      }
      this.socket = socket;
      socket.onopen = () => {
        if (this.socket !== socket) return;
        // The ticket goes as the first message and nowhere else: a URL ends up
        // in proxy logs, and this one lets whoever holds it into the room.
        socket.send(
          JSON.stringify({
            type: 'authenticate',
            protocolVersion: 1,
            connectionToken: this.access.connectionToken,
          } satisfies OlsClientMessage),
        );
      };
      socket.onerror = () => {
        if (!this.authenticated) fail(new OlsConnectionError('lost', 'Could not connect to the coordinator'));
      };
      socket.onclose = (ev) => {
        if (this.socket !== socket) return;
        if (!this.authenticated) {
          fail(new OlsConnectionError('lost', 'Could not connect to the coordinator'));
          return;
        }
        this.teardown();
        // After whatever was already waiting: a `session.ended` that came in
        // just before the socket closed is read first, and says why.
        this.enqueue(() => this.events.onClose(ev.code === 1000 ? 'closed' : 'lost'));
      };
      socket.onmessage = (ev) => {
        if (this.socket !== socket) return;
        const receivedAt = this.now();
        const parsed = parseOlsServerFrame(ev.data);
        if (!parsed.ok) {
          if (parsed.unknown) return;
          if (!this.authenticated) {
            fail(new OlsConnectionError('invalid', 'The coordinator sent something that is not OLS'));
          } else {
            this.teardown(true);
            this.enqueue(() => this.events.onClose('invalid'));
          }
          return;
        }
        const message = parsed.message;
        if (!this.authenticated) {
          if (message.type === 'error') {
            fail(new OlsConnectionError(message.code, message.message));
            return;
          }
          if (message.type !== 'authenticated') {
            fail(new OlsConnectionError('invalid', 'The coordinator spoke before letting this client in'));
            return;
          }
          this.authenticated = true;
          this.latestRevision = message.room.state.revision;
          this.enqueue(async () => {
            await this.events.onMessage(message);
            if (settled) return;
            settled = true;
            clearTimeout(authTimer);
            resolve(message.room);
          });
          this.startHeartbeat();
          return;
        }
        this.receive(message, receivedAt);
      };
    });
  }

  private receive(message: OlsServerMessage, receivedAt: number): void {
    switch (message.type) {
      case 'authenticated':
        // Once per socket. A second one is a coordinator that has lost track.
        this.teardown(true);
        this.enqueue(() => this.events.onClose('invalid'));
        return;
      case 'clock.pong':
        if (this.clock.add(
          message.clientTimestamp,
          message.serverReceivedTimestamp,
          message.serverSentTimestamp,
          receivedAt,
        )) {
          this.announceClock();
        }
        return;
      case 'state':
        if (message.state.revision <= this.latestRevision) return;
        this.latestRevision = message.state.revision;
        this.pendingState = message;
        if (this.stateQueued) return;
        this.stateQueued = true;
        this.enqueue(async () => {
          this.stateQueued = false;
          const latest = this.pendingState;
          this.pendingState = null;
          if (latest) await this.events.onMessage(latest);
        });
        return;
      case 'session.left':
      case 'session.ended':
        if (this.lifecycle?.requestId === message.requestId) this.settleLifecycle();
        break;
      case 'error':
        if (message.requestId && this.lifecycle?.requestId === message.requestId) {
          this.settleLifecycle(new OlsConnectionError(message.code, message.message));
        }
        break;
    }
    this.enqueue(() => this.events.onMessage(message));
  }

  private enqueue(task: () => void | Promise<void>): void {
    this.chain = this.chain
      .then(() => (this.closedByUs ? undefined : task()))
      .catch((e: unknown) => this.events.onFault?.(e));
  }

  private announceClock(): void {
    if (this.clockAnnounced) return;
    this.clockAnnounced = true;
    if (this.clockFallback) clearTimeout(this.clockFallback);
    this.clockFallback = null;
    const ready = this.events.onClockReady;
    if (ready) this.enqueue(() => ready.call(this.events));
  }

  private startHeartbeat(): void {
    const beat = () => {
      this.ping();
      this.events.onHeartbeat?.();
    };
    beat();
    this.heartbeat = setInterval(beat, this.options.heartbeatMs ?? OLS_HEARTBEAT_MS);
    // A coordinator answers a ping straight away. One that does not should
    // not leave a guest waiting for ever: the phone's own clock is close
    // enough to start with, and a later answer still corrects it.
    this.clockFallback = setTimeout(() => {
      this.clockFallback = null;
      this.announceClock();
    }, this.options.clockFallbackMs ?? 1000);
  }

  /** Asks the coordinator the time. Cheap to call often: it asks once per heartbeat. */
  ping(force = true): void {
    const now = this.now();
    if (!force && now - this.lastPingAt < (this.options.heartbeatMs ?? OLS_HEARTBEAT_MS)) return;
    this.lastPingAt = now;
    this.send({ type: 'clock.ping', protocolVersion: 1, id: olsRequestId(), clientTimestamp: now });
  }

  send(message: OlsClientMessage): boolean {
    const socket = this.socket;
    if (!this.authenticated || !socket || socket.readyState !== OPEN) return false;
    try {
      socket.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }

  /** Leaves or ends the room and waits for the coordinator to say it is done. */
  request(kind: 'leave' | 'end', timeoutMs = 5000): Promise<void> {
    if (this.lifecycle) {
      return Promise.reject(new OlsConnectionError('busy', 'Already leaving'));
    }
    const requestId = olsRequestId();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.lifecycle?.requestId !== requestId) return;
        this.settleLifecycle(new OlsConnectionError('timeout', 'The coordinator did not answer'));
      }, timeoutMs);
      this.lifecycle = { requestId, resolve, reject, timer };
      const sent = this.send({
        type: kind === 'leave' ? 'session.leave' : 'session.end',
        protocolVersion: 1,
        requestId,
      });
      if (!sent) this.settleLifecycle(new OlsConnectionError('lost', 'The connection was lost'));
    });
  }

  private settleLifecycle(error?: Error): void {
    const pending = this.lifecycle;
    if (!pending) return;
    this.lifecycle = null;
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve();
  }

  /** Hangs up without telling anybody. Nothing else is handled after this. */
  close(): void {
    this.closedByUs = true;
    this.teardown(true);
  }

  /** `hangUp`: close the socket too (always as 1000, the one code every client may send). */
  private teardown(hangUp = false): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
    if (this.clockFallback) clearTimeout(this.clockFallback);
    this.clockFallback = null;
    this.pendingState = null;
    this.settleLifecycle(new OlsConnectionError('lost', 'The connection was lost'));
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onerror = null;
    socket.onclose = null;
    if (hangUp && socket.readyState <= OPEN) {
      try {
        socket.close(1000);
      } catch {
        // Already going.
      }
    }
  }
}
