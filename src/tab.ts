// One attached tab: its page session, out-of-process iframe sessions, and everything we observe on it.
import type { Protocol } from 'devtools-protocol';
import { type CdpConnection, Session } from './cdp.ts';
import type { Point } from './human.ts';

export const MUTATION_SCRIPT = `(() => {
  if (window.__mbLastMutation !== undefined) return;
  window.__mbLastMutation = performance.now();
  window.__mbMutations = 0;
  const bump = () => { window.__mbLastMutation = performance.now(); window.__mbMutations++; };
  const start = () => new MutationObserver(bump).observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  if (document.documentElement) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
})()`;

// The File System Access pickers open a native OS dialog that CDP cannot answer. Without them, apps
// (Photopea, Excalidraw, …) fall back to <input type=file> and <a download>, which we can intercept.
const NO_FS_PICKERS_SCRIPT = `(() => {
  for (const n of ['showOpenFilePicker', 'showSaveFilePicker', 'showDirectoryPicker']) {
    try { delete window[n]; } catch {}
    try { delete Window.prototype[n]; } catch {}
  }
})()`;

/** Where a ref points: a DOM node inside a specific session (page or OOPIF). */
export type RefTarget = { session: Session; backendNodeId: number; role: string; name: string };

export type PendingDialog = { type: string; message: string; defaultPrompt: string | undefined };

type Request = { startedAt: number; type: string | undefined; url: string };

// Requests that never "finish" in a useful sense; counting them would mean the page never settles.
// Images and fonts only repaint what is already in the tree, so waiting for them delays every action
// on icon-heavy pages (Gmail, Docs) without changing the result.
const IGNORED_REQUEST_TYPES = new Set(['WebSocket', 'EventSource', 'Media', 'Ping', 'Preflight', 'Image', 'Font']);
// Telemetry and long-poll endpoints fire on their own and say nothing about the action's result.
const IGNORED_REQUEST_URL = /\/(log|logs|gen_204|collect|beacon|analytics|telemetry|metrics|ping|heartbeat|stats|ptracking|jserror|csi)\b|google-analytics|googletagmanager|doubleclick|sentry\.io|segment\.(io|com)|mixpanel|amplitude|hotjar|clarity\.ms/i;
// Static images and fonts fetched by script (typed Fetch/XHR) by their path's extension.
const STATIC_ASSET_PATH = /\.(png|jpe?g|gif|webp|avif|svg|ico|woff2?|ttf|otf)$/i;

/** Requests that say nothing about whether an action's result has arrived. */
export function isNoiseRequest(type: string | undefined, url: string) {
  if ((type && IGNORED_REQUEST_TYPES.has(type)) || IGNORED_REQUEST_URL.test(url)) return true;
  try {
    return STATIC_ASSET_PATH.test(new URL(url).pathname);
  } catch {
    return false;
  }
}
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
  /** The last full snapshot and the page's mutation count when it was read; reused as an action's "before" if nothing changed since. */
  lastSnapshot: { lines: string[]; version: number; url: string } | undefined;
  /** Hash and clip of the last screenshot returned for this tab, to omit an identical one. */
  lastShot: string | undefined;
  /** Where our last mouse event left the pointer (viewport CSS px); human-like moves start here. */
  pointer: Point | undefined;
  /** performance.now() of the last key release, to space key presses. */
  lastKeyAt = 0;
  /** performance.now() of the last top-level document navigation (not same-document history changes). */
  mainNavigatedAt = 0;

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
        if (p.frame.parentId) return;
        this.#requests.clear();
        this.mainNavigatedAt = performance.now();
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
      s.send('Page.addScriptToEvaluateOnNewDocument', { source: NO_FS_PICKERS_SCRIPT }),
      s.send('Runtime.evaluate', { expression: NO_FS_PICKERS_SCRIPT }),
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
    if (isNoiseRequest(type, url)) return;
    this.#requests.set(requestId, { startedAt: performance.now(), type, url });
    this.lastNetworkChange = performance.now();
  }

  #requestDone(requestId: string) {
    if (this.#requests.delete(requestId)) this.lastNetworkChange = performance.now();
  }

  /** Requests still in flight, ignoring long-lived ones (long-polling, streaming). `since`: only requests started at or after this time. */
  inflight(since = 0) {
    const now = performance.now();
    return [...this.#requests.values()]
      .filter((r) => r.startedAt >= since && now - r.startedAt < LONG_REQUEST_MS)
      .map((r) => `${r.type ?? '?'} ${r.url.slice(0, 80)}`);
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
