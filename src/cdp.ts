// Minimal Chrome DevTools Protocol client over one WebSocket.
// All tabs/frames share the browser connection via flattened sessions (Target.attachToTarget flatten:true).
import type { ProtocolMapping } from 'devtools-protocol/types/protocol-mapping.js';

type Commands = ProtocolMapping.Commands;
type Events = ProtocolMapping.Events;

export type CommandName = keyof Commands;
export type EventName = keyof Events;

type ParamsTuple<M extends CommandName> = Commands[M]['paramsType'];
export type ParamsOf<M extends CommandName> =
  ParamsTuple<M> extends []
    ? undefined
    : ParamsTuple<M> extends [infer P]
      ? P
      : ParamsTuple<M> extends [(infer P)?]
        ? P | undefined
        : never;
export type ResultOf<M extends CommandName> = Commands[M]['returnType'];
export type EventParams<E extends EventName> = Events[E] extends [infer P] ? P : undefined;

type Pending = {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type Listener = { event: string; sessionId: string | undefined; handler: (params: unknown) => void };

export class CdpError extends Error {
  constructor(
    readonly method: string,
    readonly code: number | undefined,
    message: string,
  ) {
    super(`${method}: ${message}`);
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;

export class CdpConnection {
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #listeners = new Set<Listener>();
  #closeHandlers = new Set<() => void>();
  closed = false;

  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener('message', (ev) => this.#onMessage(String(ev.data)));
    ws.addEventListener('close', () => {
      this.closed = true;
      for (const p of this.#pending.values()) {
        clearTimeout(p.timer);
        p.reject(new CdpError(p.method, undefined, 'browser connection closed'));
      }
      this.#pending.clear();
      for (const h of this.#closeHandlers) h();
    });
  }

  static connect(url: string, timeoutMs = 10_000) {
    return new Promise<CdpConnection>((resolve, reject) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
        reject(new Error(`Timed out after ${timeoutMs}ms connecting to ${url}. If the browser shows an "Allow remote debugging?" prompt, accept it.`));
      }, timeoutMs);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve(new CdpConnection(ws));
      });
      ws.addEventListener('error', () => {
        clearTimeout(timer);
        reject(new Error(`Could not open WebSocket ${url}`));
      });
    });
  }

  send<M extends CommandName>(method: M, params?: ParamsOf<M>, sessionId?: string, timeoutMs = DEFAULT_TIMEOUT_MS) {
    if (this.closed) return Promise.reject(new CdpError(method, undefined, 'browser connection closed'));
    const id = this.#nextId++;
    const message = JSON.stringify({ id, method, params: params ?? {}, ...(sessionId ? { sessionId } : {}) });
    return new Promise<ResultOf<M>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new CdpError(method, undefined, `no reply after ${timeoutMs}ms (page may be blocked by a dialog or frozen)`));
      }, timeoutMs);
      this.#pending.set(id, {
        method,
        // Trust boundary: Chrome's reply shape is defined by the protocol typings for `method`.
        resolve: (value) => resolve(value as ResultOf<M>),
        reject,
        timer,
      });
      this.ws.send(message);
    });
  }

  on<E extends EventName>(event: E, handler: (params: EventParams<E>) => void, sessionId?: string) {
    // Trust boundary: event payload shape is defined by the protocol typings for `event`.
    const listener: Listener = { event, sessionId, handler: (p) => handler(p as EventParams<E>) };
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  onClose(handler: () => void) {
    this.#closeHandlers.add(handler);
  }

  close() {
    this.ws.close();
  }

  #onMessage(raw: string) {
    let msg: { id?: number; method?: string; params?: unknown; sessionId?: string; result?: unknown; error?: { code: number; message: string } };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (typeof msg.id === 'number') {
      const p = this.#pending.get(msg.id);
      if (!p) return;
      this.#pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new CdpError(p.method, msg.error.code, msg.error.message));
      else p.resolve(msg.result ?? {});
      return;
    }
    if (!msg.method) return;
    for (const l of this.#listeners) {
      if (l.event === msg.method && l.sessionId === msg.sessionId) l.handler(msg.params);
    }
  }
}

/** A CDP session bound to one target (tab or out-of-process iframe). */
export class Session {
  constructor(
    readonly conn: CdpConnection,
    readonly id: string,
  ) {}

  send<M extends CommandName>(method: M, params?: ParamsOf<M>, timeoutMs?: number) {
    return this.conn.send(method, params, this.id, timeoutMs);
  }

  on<E extends EventName>(event: E, handler: (params: EventParams<E>) => void) {
    return this.conn.on(event, handler, this.id);
  }
}
