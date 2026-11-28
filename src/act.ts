// Run an action, wait for the page to settle, and report what changed.
import { describeChallenge, detectChallenge } from './challenge.ts';
import { compactView, remember, snapshot } from './snapshot.ts';
import { MUTATION_SCRIPT, type Tab } from './tab.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Settle =
  | { kind: 'settled'; ms: number }
  /** DOM went quiet but some requests were still loading; they are listed, not waited for. */
  | { kind: 'quiet'; ms: number; pending: string[] }
  | { kind: 'dialog'; ms: number }
  | { kind: 'timeout'; ms: number; reason: string };

// Quiet windows are counted from the action, not from the page's last change: a click whose handler
// uses a short timer shows nothing at first, and must still be waited for (up to DOM_QUIET_MS).
const NETWORK_QUIET_MS = 300;
const DOM_QUIET_MS = 250;
const MIN_WAIT_MS = 50;
// A page that was already mutating before the action (video, live cursors, timers) never goes quiet.
// For those, DOM quiet is replaced by a fixed minimum wait; network quiet still applies.
const LIVE_IDLE_MS = 100;
const LIVE_MIN_WAIT_MS = 300;

type PageState = { version: number; idle: number; url: string };

const PAGE_STATE = `(${MUTATION_SCRIPT}, JSON.stringify([window.__mbMutations ?? -1, performance.now() - window.__mbLastMutation, location.href]))`;

async function pageState(tab: Tab): Promise<PageState | undefined> {
  try {
    const r = await tab.page.send('Runtime.evaluate', { expression: PAGE_STATE, returnByValue: true }, 1000);
    const v: unknown = JSON.parse(String(r.result.value));
    if (Array.isArray(v) && typeof v[0] === 'number' && typeof v[1] === 'number' && typeof v[2] === 'string') return { version: v[0], idle: v[1], url: v[2] };
  } catch {
    // navigating, or blocked by a dialog
  }
  return undefined;
}

// Pages with background fetches (icons, prefetch, iframes) keep the network busy long after the
// visible result is in. Once the DOM has been quiet this long, stop waiting for the network tail.
const TAIL_DOM_QUIET_MS = 500;
const TAIL_MIN_ELAPSED_MS = 1500;

/** One observation of the page while waiting. Times are ms; `domQuietFor` is undefined when the page could not be read (navigating). */
export type SettleProbe = { elapsed: number; pending: string[]; netQuietFor: number; domQuietFor: number | undefined; domQuietNeeded: number };

/** Decides from one probe whether the page has settled, should be waited on, or has run out of time. */
export function settleVerdict(p: SettleProbe, timeoutMs: number): Settle | { kind: 'wait' } {
  const ms = Math.round(p.elapsed);
  const netQuiet = p.pending.length === 0 && p.netQuietFor >= NETWORK_QUIET_MS;
  const domQuiet = p.domQuietFor !== undefined && p.domQuietFor >= p.domQuietNeeded;
  if (netQuiet && domQuiet) return { kind: 'settled', ms };
  if (domQuiet && p.domQuietFor !== undefined && p.domQuietFor >= TAIL_DOM_QUIET_MS && p.elapsed >= TAIL_MIN_ELAPSED_MS) {
    return { kind: 'quiet', ms, pending: p.pending };
  }
  if (p.elapsed > timeoutMs) {
    const reason = !netQuiet ? `${p.pending.length} network request(s) still loading: ${p.pending.slice(0, 3).join(', ')}` : 'DOM still changing (animation or live content)';
    return { kind: 'timeout', ms, reason };
  }
  return { kind: 'wait' };
}

type SettleOpts = {
  /** The page was already mutating before the action: DOM quiet becomes a fixed minimum wait. */
  live?: boolean;
  /** false = only wait for the DOM (between batch steps). */
  network?: boolean;
  domQuietMs?: number;
};

/** Top document's mutation count and URL, or undefined while navigating. Cheap: one small evaluate. */
export async function pageVersion(tab: Tab) {
  const s = await pageState(tab);
  return s && `${s.version}:${s.url}`;
}

/**
 * True when a poll should re-read the page: it changed since `last`, or `forceMs` passed.
 * The mutation counter only sees the top document, so iframe-only changes are caught by the forced read.
 */
export function shouldReread(current: string | undefined, last: { version: string | undefined; at: number } | undefined, now: number, forceMs = 1000) {
  return !last || current === undefined || current !== last.version || now - last.at >= forceMs;
}

/** Settled = no new network requests and no DOM mutations for a short window since the action. Gives up after `timeoutMs`. */
export async function waitForSettle(tab: Tab, timeoutMs = 5000, opts: SettleOpts = {}): Promise<Settle> {
  const start = performance.now();
  const network = opts.network ?? true;
  const domQuietNeeded = opts.domQuietMs ?? (opts.live ? LIVE_MIN_WAIT_MS : DOM_QUIET_MS);
  await sleep(MIN_WAIT_MS);
  for (;;) {
    if (tab.dialog) return { kind: 'dialog', ms: Math.round(performance.now() - start) };
    let domQuietFor: number | undefined;
    if (opts.live) domQuietFor = performance.now() - start;
    else {
      const s = await pageState(tab);
      domQuietFor = s === undefined ? undefined : Math.min(s.idle, performance.now() - start);
    }
    const now = performance.now();
    const v = settleVerdict(
      {
        elapsed: now - start,
        pending: network ? tab.inflight(start) : [],
        netQuietFor: !network || tab.lastNetworkChange < start ? Number.POSITIVE_INFINITY : now - tab.lastNetworkChange,
        domQuietFor,
        domQuietNeeded,
      },
      timeoutMs,
    );
    if (v.kind !== 'wait') return v;
    await sleep(50);
  }
}

const STEP_DOM_QUIET_MS = 150;
const STEP_LIVE_WAIT_MS = 100;
const STEP_TIMEOUT_MS = 1500;

/** Short DOM-only wait between batch steps, so the next step sees what the last one opened. */
export async function waitBetweenSteps(tab: Tab) {
  const pre = await pageState(tab);
  const live = pre !== undefined && pre.idle < LIVE_IDLE_MS;
  return waitForSettle(tab, STEP_TIMEOUT_MS, { network: false, live, domQuietMs: live ? STEP_LIVE_WAIT_MS : STEP_DOM_QUIET_MS });
}

export function describeSettle(s: Settle) {
  if (s.kind === 'settled') return `settled ${s.ms}ms`;
  if (s.kind === 'quiet') return `settled ${s.ms}ms; still loading in background: ${s.pending.slice(0, 2).join(', ') || 'requests'}`;
  if (s.kind === 'dialog') return `a dialog opened after ${s.ms}ms and is blocking the page`;
  return `page did not settle within ${s.ms}ms (${s.reason}); result below may be incomplete — wait_for or snapshot again if needed`;
}

const MAX_DIFF_LINES = 60;
const MAX_REMOVED_LINES = 15;
export const FULL_SNAPSHOT_LINES = 150;
/** A line limit high enough that only list capping applies. */
export const LIST_CAPPED = 2000;

/** `diff`: report what changed (reads the page before and after). `none`: only settle and events (fast; for canvas work). */
export type Report = 'diff' | 'none';

/**
 * Wraps an action: snapshot before, run, settle, snapshot after, report the diff and browser events.
 * The agent learns what its action did without a separate snapshot call.
 */
export async function act(tab: Tab, label: string, run: () => Promise<string | undefined>, opts: { report?: Report } = {}) {
  const report = opts.report ?? 'diff';
  const pre = tab.dialog ? undefined : await pageState(tab);
  const live = pre !== undefined && pre.idle < LIVE_IDLE_MS;

  let before: string[] | undefined;
  let urlBefore: string | undefined;
  if (report === 'diff' && pre) {
    // Reuse the last snapshot as "before" when the page has not changed since it was read: saves a full tree read per action.
    const last = tab.lastSnapshot;
    if (last && last.version === pre.version && last.url === pre.url) {
      before = last.lines;
      urlBefore = last.url;
    } else {
      const snap = await snapshot(tab).catch(() => undefined);
      before = snap?.lines;
      urlBefore = snap?.info?.url;
    }
  }
  tab.takeEvents();

  const started = performance.now();
  const note = await run();
  let settle = await waitForSettle(tab, 5000, { live });
  // After a document navigation, check for a bot challenge; an auto check is waited out before reading the page.
  const challenge = tab.mainNavigatedAt >= started ? await detectChallenge(tab) : undefined;
  if (challenge?.status === 'cleared') settle = await waitForSettle(tab, 5000);
  const out = [`${label} (${describeSettle(settle)})`, ...(note ? [note] : [])];
  if (challenge) out.push(describeChallenge(challenge, (await pageState(tab))?.url ?? ''));

  if (report === 'diff' && settle.kind !== 'dialog') {
    const after = await snapshot(tab).catch(() => undefined);
    if (after) {
      remember(tab, after);
      const urlAfter = after.info?.url;
      const navigated = urlBefore !== undefined && urlAfter !== undefined && urlBefore !== urlAfter;
      if (navigated) out.push(`url: ${urlBefore} → ${urlAfter}`);
      const d = diff(before, after.lines, navigated);
      if (d === 'full') {
        // Long lists capped at 40 items, then only elements if text does not fit: a new page is mostly chrome.
        const view = after.lines.length > FULL_SNAPSHOT_LINES ? await snapshot(tab, LIST_CAPPED) : after;
        out.push('new snapshot:', ...view.header, ...compactView(view.lines, FULL_SNAPSHOT_LINES));
      } else out.push(...d);
    }
  }
  const events = tab.takeEvents();
  if (events.length) out.push('events:', ...events.map((e) => `  ${e}`));
  return out.join('\n');
}

const refOf = (l: string) => /^\s*\[(\d+)\]/.exec(l)?.[1];
const unfocused = (l: string) => l.trim().replace(/ focused\b/, '');
// A token is a bare word, a quoted string, or key="quoted value".
const TOKEN = /[^\s"]*"(?:[^"\\]|\\.)*"|\S+/g;

/** Only what changed on an element's line: `[12] textbox "Email" value="a@b.c" (was value="")`. */
function changeOf(prev: string, next: string) {
  const tokens = (l: string) => Array.from(unfocused(l).matchAll(TOKEN), (m) => m[0]);
  const a = tokens(prev);
  const b = tokens(next);
  const nameKept = b[2] !== undefined && b[2].startsWith('"') && a[2] === b[2];
  const head = b.slice(0, nameKept ? 3 : 2);
  const rest = (t: string[]) => t.slice(nameKept ? 3 : 2);
  const now = rest(b).filter((t) => !a.includes(t));
  const was = rest(a).filter((t) => !b.includes(t));
  return [...head, ...now, ...(was.length ? [`(was ${was.join(' ')})`] : [])].join(' ');
}

/** Lines keyed by element ref; text lines by content plus occurrence number, so repeated text is not merged. */
function index(lines: string[]) {
  const m = new Map<string, string>();
  const seen = new Map<string, number>();
  for (const l of lines) {
    const ref = refOf(l);
    if (ref) {
      m.set(ref, l);
      continue;
    }
    const t = l.trim();
    const n = (seen.get(t) ?? 0) + 1;
    seen.set(t, n);
    m.set(`text:${t}#${n}`, l);
  }
  return m;
}

/** Keep the tree shape of added lines, shifted left so the shallowest is at column 2. */
function dedent(lines: string[]) {
  const indent = (l: string) => l.length - l.trimStart().length;
  const min = Math.min(...lines.map(indent));
  return lines.map((l) => `  ${l.slice(min)}`);
}

function diff(before: string[] | undefined, after: string[], navigated: boolean): string[] | 'full' {
  if (!before || navigated) return 'full';
  const b = index(before);
  const a = index(after);
  const added: string[] = [];
  const changed: string[] = [];
  const removedRefs: string[] = [];
  let removedText = 0;
  let focus: string | undefined;
  for (const [key, line] of a) {
    if (/ focused\b/.test(line) && !(b.get(key) ?? '').includes(' focused')) focus = unfocused(line);
    const prev = b.get(key);
    if (prev === undefined) added.push(line);
    else if (unfocused(prev) !== unfocused(line)) changed.push(changeOf(prev, line));
  }
  for (const [key, line] of b) {
    if (a.has(key)) continue;
    if (refOf(line)) removedRefs.push(line.trim());
    else removedText++;
  }

  if (!added.length && !changed.length && !removedRefs.length && !removedText) {
    return [...(focus ? [`focus: ${focus}`] : []), 'no change in the page structure (on a canvas, screenshot to check)'];
  }
  if (added.length > after.length * 0.8 && after.length > 40) return 'full';
  const out = focus ? [`focus: ${focus}`] : [];
  if (changed.length) out.push(`changed (${changed.length}):`, ...changed.slice(0, MAX_DIFF_LINES).map((l) => `  ${l}`));
  if (changed.length > MAX_DIFF_LINES) out.push(`  … ${changed.length - MAX_DIFF_LINES} more`);
  if (added.length) out.push(`added (${added.length}):`, ...dedent(added.slice(0, MAX_DIFF_LINES)));
  if (added.length > MAX_DIFF_LINES) out.push(`  … ${added.length - MAX_DIFF_LINES} more`);
  if (removedRefs.length || removedText) {
    out.push(`removed (${removedRefs.length} elements${removedText ? `, ${removedText} text lines` : ''}):`, ...removedRefs.slice(0, MAX_REMOVED_LINES).map((l) => `  ${l}`));
  }
  return out;
}
