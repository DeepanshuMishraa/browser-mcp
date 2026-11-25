// One attached tab: its page session, out-of-process iframe sessions, and everything we observe on it.
import type { Protocol } from 'devtools-protocol';
import { type CdpConnection, Session } from './cdp.ts';

export const MUTATION_SCRIPT = `(() => {
  if (window.__mbLastMutation !== undefined) return;
  window.__mbLastMutation = performance.now();
  const bump = () => { window.__mbLastMutation = performance.now(); };
  const start = () => new MutationObserver(bump).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})()`;

/** Where a ref points: a DOM node inside a specific session (page or OOPIF). */
export type RefTarget = { session: Session; backendNodeId: number; role: string; name: string };

export type PendingDialog = { type: string; message: string; defaultPrompt: string | undefined };

type Request = { startedAt: number; type: string | undefined; url: string };

// Requests that never "finish" in a useful sense; counting them would mean the page never settles.
const IGNORED_REQUEST_TYPES = new Set(['WebSocket', 'EventSource', 'Media', 'Ping', 'Preflight']);
const LONG_REQUEST_MS = 5_000;

export class Tab {
  readonly page: Session;
  /** OOPIF sessions keyed by frameId (== the iframe target's targetId). */
  readonly oopifs = new Map<string, Session>();
  readonly refs = new Map<number, RefTarget>();
  readonly #refByNode = new Map<string, number>();
  #nextRef = 1;

  readonly #requests = new Map<string, Request>();
  lastNetworkChange = performance.now();
  dialog: PendingDialog | undefined;
  /** backendNodeId of an <input type=file> whose picker was intercepted. */
  fileChooser: { backendNodeId: number; multiple: boolean } | undefined;
  /** Things that happened since the last action report (dialogs, popups, downloads, errors). */
  events: string[] = [];
  /** Lines of the last full snapshot, used for diffs. */
  lastSnapshot: string[] | undefined;

  constructor(
    readonly conn: CdpConnection,
    readonly targetId: string,
    sessionId: string,
  ) {
    this.page = new Session(conn, sessionId);
  }

  async init() {
    await this.#initSession(this.page, true);
  }

  async #initSession(s: Session, isPage: boolean) {
    s.on('Network.requestWillBeSent', (p) => this.#requestStarted(p.requestId, p.type, p.request.url));
    s.on('Network.loadingFinished', (p) => this.#requestDone(p.requestId));
    s.on('Network.loadingFailed', (p) => this.#requestDone(p.requestId));
    s.on('Runtime.exceptionThrown', (p) => {
      const d = p.exceptionDetails;
      this.#log(`page error: ${(d.exception?.description ?? d.text).split('\n')[0]}`);
    });
    s.on('Target.attachedToTarget', (p) => {
      if (p.targetInfo.type !== 'iframe') return;
      // Its document request may finish before we enable Network on the new session; stop waiting for it.
      for (const [id, r] of this.#requests) if (r.type === 'Document' && r.url === p.targetInfo.url) this.#requestDone(id);
      const child = new Session(this.conn, p.sessionId);
      this.oopifs.set(p.targetInfo.targetId, child);
      this.#initSession(child, false).catch(() => this.oopifs.delete(p.targetInfo.targetId));
    });
    s.on('Target.detachedFromTarget', (p) => {
      for (const [frameId, child] of this.oopifs) if (child.id === p.sessionId) this.oopifs.delete(frameId);
    });

    if (isPage) {
      s.on('Page.javascriptDialogOpening', (p) => {
        this.dialog = { type: p.type, message: p.message, defaultPrompt: p.defaultPrompt };
        this.#log(`${p.type} dialog opened: "${p.message}" (blocks the page; use dialog to accept or dismiss)`);
      });
      s.on('Page.javascriptDialogClosed', () => {
        this.dialog = undefined;
      });
      s.on('Page.fileChooserOpened', (p) => {
        if (p.backendNodeId === undefined) return;
        this.fileChooser = { backendNodeId: p.backendNodeId, multiple: p.mode === 'selectMultiple' };
        this.#log('file picker opened (intercepted): call upload with file paths');
      });
      s.on('Page.frameNavigated', (p) => {
        if (!p.frame.parentId) this.#requests.clear();
      });
    }

    const enable: Promise<unknown>[] = [
      s.send('Runtime.enable'),
      s.send('Network.enable'),
      s.send('DOM.enable'),
      s.send('Page.enable'),
      s.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }),
      s.send('Page.addScriptToEvaluateOnNewDocument', { source: MUTATION_SCRIPT }),
      s.send('Runtime.evaluate', { expression: MUTATION_SCRIPT }),
    ];
    if (isPage) {
      enable.push(
        s.send('Page.setInterceptFileChooserDialog', { enabled: true }),
        // Lets a background tab believe it has focus, so focus-dependent widgets keep working.
        s.send('Emulation.setFocusEmulationEnabled', { enabled: true }),
      );
    }
    await Promise.allSettled(enable);
  }

  // Keyed by requestId alone: an iframe's document request starts in the parent session
  // but finishes in the iframe's own session once it becomes an OOPIF.
  #requestStarted(requestId: string, type: Protocol.Network.ResourceType | undefined, url: string) {
    if (type && IGNORED_REQUEST_TYPES.has(type)) return;
    this.#requests.set(requestId, { startedAt: performance.now(), type, url });
    this.lastNetworkChange = performance.now();
  }

  #requestDone(requestId: string) {
    if (this.#requests.delete(requestId)) this.lastNetworkChange = performance.now();
  }

  /** Requests still in flight, ignoring long-lived ones (long-polling, streaming). */
  inflight() {
    const now = performance.now();
    return [...this.#requests.values()].filter((r) => now - r.startedAt < LONG_REQUEST_MS).map((r) => `${r.type ?? '?'} ${r.url.slice(0, 80)}`);
  }

  #log(event: string) {
    this.events.push(event);
    if (this.events.length > 30) this.events.shift();
  }

  log(event: string) {
    this.#log(event);
  }

  takeEvents() {
    const e = this.events;
    this.events = [];
    return e;
  }

  /** Stable ref for a node: the same element keeps the same number across snapshots; numbers are never reused. */
  refFor(session: Session, backendNodeId: number, role: string, name: string) {
    const key = `${session.id}:${backendNodeId}`;
    let ref = this.#refByNode.get(key);
    if (ref === undefined) {
      ref = this.#nextRef++;
      this.#refByNode.set(key, ref);
    }
    this.refs.set(ref, { session, backendNodeId, role, name });
    return ref;
  }

  sessionForFrame(frameId: string) {
    return this.oopifs.get(frameId) ?? this.page;
  }
}
