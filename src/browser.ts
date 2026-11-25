// Browser-level state: connection, tab list, which tab the agent is working on, downloads.
import type { Protocol } from 'devtools-protocol';
import { CdpConnection } from './cdp.ts';
import { CONNECT_HELP, discoverBrowserUrls } from './discover.ts';
import { Tab } from './tab.ts';

export class ToolError extends Error {}

type Download = { guid: string; url: string; filename: string; state: string; path: string | undefined; tabId: number | undefined };

export class Browser {
  readonly targets = new Map<string, Protocol.Target.TargetInfo>();
  readonly #tabIds = new Map<string, number>();
  readonly #attached = new Map<string, Tab>();
  readonly downloads = new Map<string, Download>();
  #nextTabId = 1;
  current: string | undefined;

  private constructor(readonly conn: CdpConnection) {}

  static async connect() {
    const urls = await discoverBrowserUrls();
    if (urls.length === 0) throw new ToolError(CONNECT_HELP);
    const errors: string[] = [];
    for (const url of urls) {
      try {
        const conn = await CdpConnection.connect(url, 30_000);
        const b = new Browser(conn);
        await b.#init();
        return b;
      } catch (e) {
        errors.push(`${url}: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    throw new ToolError(`${CONNECT_HELP}\nTried:\n${errors.join('\n')}`);
  }

  async #init() {
    const c = this.conn;
    c.on('Target.targetCreated', ({ targetInfo: t }) => {
      if (t.type !== 'page') return;
      this.targets.set(t.targetId, t);
      const id = this.tabId(t.targetId);
      const opener = t.openerId ? this.#attached.get(t.openerId) : undefined;
      opener?.log(`new tab opened by this page: tab ${id} ${t.url || '(loading)'} (use tab_select to work in it)`);
    });
    c.on('Target.targetInfoChanged', ({ targetInfo: t }) => {
      if (this.targets.has(t.targetId)) this.targets.set(t.targetId, t);
    });
    c.on('Target.targetDestroyed', ({ targetId }) => {
      this.targets.delete(targetId);
      this.#attached.delete(targetId);
      if (this.current === targetId) this.current = undefined;
    });
    c.on('Target.detachedFromTarget', (p) => {
      for (const [targetId, tab] of this.#attached) if (tab.page.id === p.sessionId) this.#attached.delete(targetId);
    });
    c.on('Browser.downloadWillBegin', (p) => {
      const tab = this.#attached.get(p.frameId);
      const d: Download = { guid: p.guid, url: p.url, filename: p.suggestedFilename, state: 'started', path: undefined, tabId: tab ? this.tabId(p.frameId) : undefined };
      this.downloads.set(p.guid, d);
      (tab ?? this.#currentTab())?.log(`download started: ${p.suggestedFilename}`);
    });
    c.on('Browser.downloadProgress', (p) => {
      const d = this.downloads.get(p.guid);
      if (!d || p.state === 'inProgress') return;
      d.state = p.state;
      if ('filePath' in p && typeof p.filePath === 'string') d.path = p.filePath;
      const tab = this.#currentTab();
      tab?.log(`download ${p.state}: ${d.filename}${d.path ? ` → ${d.path}` : ''}`);
    });

    await c.send('Target.setDiscoverTargets', { discover: true });
    // 'default' keeps the user's own download settings; we only want the events.
    await c.send('Browser.setDownloadBehavior', { behavior: 'default', eventsEnabled: true }).catch(() => undefined);
    const { targetInfos } = await c.send('Target.getTargets');
    for (const t of targetInfos) if (t.type === 'page') {
      this.targets.set(t.targetId, t);
      this.tabId(t.targetId);
    }
  }

  tabId(targetId: string) {
    let id = this.#tabIds.get(targetId);
    if (id === undefined) {
      id = this.#nextTabId++;
      this.#tabIds.set(targetId, id);
    }
    return id;
  }

  targetIdFor(tabId: number) {
    for (const [targetId, id] of this.#tabIds) if (id === tabId && this.targets.has(targetId)) return targetId;
    throw new ToolError(`No tab ${tabId}. Call tabs to see open tabs.`);
  }

  #currentTab() {
    return this.current ? this.#attached.get(this.current) : undefined;
  }

  async attach(targetId: string) {
    const existing = this.#attached.get(targetId);
    if (existing) return existing;
    const { sessionId } = await this.conn.send('Target.attachToTarget', { targetId, flatten: true });
    const tab = new Tab(this.conn, targetId, sessionId);
    this.#attached.set(targetId, tab);
    await tab.init();
    return tab;
  }

  /** Visibility of each tab: attaches briefly to tabs we are not already attached to. */
  async visibility() {
    const result = new Map<string, { visible: boolean; focused: boolean }>();
    await Promise.all(
      [...this.targets.keys()].map(async (targetId) => {
        try {
          const tab = this.#attached.get(targetId);
          let sessionId = tab?.page.id;
          if (!sessionId) sessionId = (await this.conn.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
          const r = await this.conn.send(
            'Runtime.evaluate',
            { expression: 'JSON.stringify([document.visibilityState === "visible", document.hasFocus()])', returnByValue: true },
            sessionId,
            2000,
          );
          if (!tab) await this.conn.send('Target.detachFromTarget', { sessionId }).catch(() => undefined);
          const v: unknown = JSON.parse(String(r.result.value));
          if (Array.isArray(v)) result.set(targetId, { visible: v[0] === true, focused: v[1] === true });
        } catch {
          // tab is busy (dialog, frozen) — leave unknown
        }
      }),
    );
    return result;
  }

  /** The tab to act on: explicit tab id, else the selected tab, else the tab in front. */
  async tab(tabId?: number) {
    if (tabId !== undefined) return this.attach(this.targetIdFor(tabId));
    if (this.current && this.targets.has(this.current)) return this.attach(this.current);
    const vis = await this.visibility();
    const pages = [...this.targets.keys()];
    const front = pages.find((id) => vis.get(id)?.focused) ?? pages.find((id) => vis.get(id)?.visible) ?? pages[0];
    if (!front) throw new ToolError('The browser has no open tabs. Call tab_open with a URL.');
    this.current = front;
    return this.attach(front);
  }
}
