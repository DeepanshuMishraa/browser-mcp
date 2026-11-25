// Run an action, wait for the page to settle, and report what changed.
import { remember, snapshot } from './snapshot.ts';
import { MUTATION_SCRIPT, type Tab } from './tab.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Settle =
  | { kind: 'settled'; ms: number }
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

/** Settled = no new network requests and no DOM mutations for a short window since the action. Gives up after `timeoutMs`. */
export async function waitForSettle(tab: Tab, timeoutMs = 5000, opts: { live?: boolean } = {}): Promise<Settle> {
  const start = performance.now();
  await sleep(MIN_WAIT_MS);
  let reason = 'page still changing';
  for (;;) {
    const now = performance.now();
    const ms = Math.round(now - start);
    if (tab.dialog) return { kind: 'dialog', ms };
    const net = tab.inflight(start);
    const netQuiet = net.length === 0 && (tab.lastNetworkChange < start || now - tab.lastNetworkChange >= NETWORK_QUIET_MS);
    let domQuiet = false;
    if (opts.live) domQuiet = now - start >= LIVE_MIN_WAIT_MS;
    else {
      const s = await pageState(tab);
      domQuiet = s !== undefined && Math.min(s.idle, performance.now() - start) >= DOM_QUIET_MS;
    }
    if (netQuiet && domQuiet) return { kind: 'settled', ms };
    reason = !netQuiet ? `${net.length} network request(s) still loading: ${net.slice(0, 3).join(', ')}` : 'DOM still changing (animation or live content)';
    if (ms > timeoutMs) return { kind: 'timeout', ms, reason };
    await sleep(50);
  }
}

function describeSettle(s: Settle) {
  if (s.kind === 'settled') return `settled ${s.ms}ms`;
  if (s.kind === 'dialog') return `a dialog opened after ${s.ms}ms and is blocking the page`;
  return `page did not settle within ${s.ms}ms (${s.reason}); result below may be incomplete — wait_for or snapshot again if needed`;
}

const MAX_DIFF_LINES = 60;
const MAX_REMOVED_LINES = 15;
const FULL_SNAPSHOT_LINES = 300;

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

  const note = await run();
  const settle = await waitForSettle(tab, 5000, { live });
  const out = [`${label} (${describeSettle(settle)})`, ...(note ? [note] : [])];

  if (report === 'diff' && settle.kind !== 'dialog') {
    const after = await snapshot(tab).catch(() => undefined);
    if (after) {
      remember(tab, after);
      const urlAfter = after.info?.url;
      const navigated = urlBefore !== undefined && urlAfter !== undefined && urlBefore !== urlAfter;
      if (navigated) out.push(`url: ${urlBefore} → ${urlAfter}`);
      const d = diff(before, after.lines, navigated);
      if (d === 'full') {
        const view = after.lines.length > FULL_SNAPSHOT_LINES ? await snapshot(tab, FULL_SNAPSHOT_LINES) : after;
        out.push('new snapshot:', ...view.header, ...view.lines, ...(view.truncated ? ['… truncated (use snapshot with a ref, find, or scroll)'] : []));
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
