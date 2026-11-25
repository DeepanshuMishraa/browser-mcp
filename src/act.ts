// Run an action, wait for the page to settle, and report what changed.
import { snapshot } from './snapshot.ts';
import { MUTATION_SCRIPT, type Tab } from './tab.ts';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type Settle =
  | { kind: 'settled'; ms: number }
  | { kind: 'dialog'; ms: number }
  | { kind: 'timeout'; ms: number; reason: string };

// Quiet windows are counted from the action, not from the page's last change: a click whose handler
// uses a short timer (debounce, setTimeout(…, 400)) shows nothing at first, and must still be waited for.
const NETWORK_QUIET_MS = 500;
const DOM_QUIET_MS = 500;
const MIN_WAIT_MS = 100;

/** Settled = no network requests AND no DOM mutations for 500ms since the action. Gives up after `timeoutMs`. */
export async function waitForSettle(tab: Tab, timeoutMs = 5000): Promise<Settle> {
  const start = performance.now();
  await sleep(MIN_WAIT_MS);
  let reason = 'page still changing';
  for (;;) {
    const ms = Math.round(performance.now() - start);
    if (tab.dialog) return { kind: 'dialog', ms };
    const net = tab.inflight();
    const netQuiet = net.length === 0 && performance.now() - Math.max(tab.lastNetworkChange, start) >= NETWORK_QUIET_MS;
    let domQuiet = false;
    try {
      const r = await tab.page.send(
        'Runtime.evaluate',
        { expression: `(${MUTATION_SCRIPT}, performance.now() - window.__mbLastMutation)`, returnByValue: true },
        1000,
      );
      domQuiet = typeof r.result.value === 'number' && Math.min(r.result.value, performance.now() - start) >= DOM_QUIET_MS;
    } catch {
      // navigating: no execution context yet
    }
    if (netQuiet && domQuiet) return { kind: 'settled', ms };
    reason = !netQuiet ? `${net.length} network request(s) still loading: ${net.slice(0, 3).join(', ')}` : 'DOM still changing (animation or live content)';
    if (ms > timeoutMs) return { kind: 'timeout', ms, reason };
    await sleep(100);
  }
}

function describeSettle(s: Settle) {
  if (s.kind === 'settled') return `page settled after ${s.ms}ms`;
  if (s.kind === 'dialog') return `a dialog opened after ${s.ms}ms and is blocking the page`;
  return `page did not settle within ${s.ms}ms (${s.reason}); result below may be incomplete — wait_for or snapshot again if needed`;
}

const MAX_DIFF_LINES = 40;
const FULL_SNAPSHOT_LINES = 300;

/**
 * Wraps an action: snapshot before, run, settle, snapshot after, report the diff and browser events.
 * The agent learns what its action did without a separate snapshot call.
 */
export async function act(tab: Tab, label: string, run: () => Promise<string | undefined>) {
  // Fresh "before" (not the agent's last snapshot) so the diff shows only what this action caused.
  const snapBefore = tab.dialog ? undefined : await snapshot(tab).catch(() => undefined);
  const before = snapBefore?.lines;
  const urlBefore = snapBefore?.info?.url;
  tab.takeEvents();

  const note = await run();
  const settle = await waitForSettle(tab);
  const out = [label, ...(note ? [note] : []), describeSettle(settle)];

  if (settle.kind !== 'dialog') {
    const after = await snapshot(tab).catch(() => undefined);
    if (after) {
      tab.lastSnapshot = after.lines;
      const urlAfter = after.info?.url;
      const navigated = urlBefore !== undefined && urlAfter !== undefined && urlBefore !== urlAfter;
      if (navigated) out.push(`url: ${urlBefore} → ${urlAfter}`);
      const d = diff(before, after.lines, navigated);
      if (d === 'full') {
        const view = await snapshot(tab, FULL_SNAPSHOT_LINES);
        out.push('new snapshot:', ...view.header, ...view.lines, ...(view.truncated ? ['… truncated (use snapshot with a ref, find, or scroll)'] : []));
      } else out.push(...d);
    }
  }
  const events = tab.takeEvents();
  if (events.length) out.push('events:', ...events.map((e) => `  ${e}`));
  return out.join('\n');
}

function diff(before: string[] | undefined, after: string[], navigated: boolean): string[] | 'full' {
  if (!before || navigated) return 'full';
  // Elements are matched by ref (same element keeps its ref), text lines by content.
  // Focus moving is reported once instead of as two changed elements.
  const refOf = (l: string) => /^\s*\[(\d+)\]/.exec(l)?.[1];
  const unfocused = (l: string) => l.trim().replace(/ focused\b/, '');
  const index = (lines: string[]) => new Map(lines.map((l) => [refOf(l) ?? `text:${l.trim()}`, l]));
  const b = index(before);
  const a = index(after);
  const added: string[] = [];
  const changed: string[] = [];
  const removed: string[] = [];
  let focus: string | undefined;
  for (const [key, line] of a) {
    if (/ focused\b/.test(line) && !(b.get(key) ?? '').includes(' focused')) focus = unfocused(line);
    const prev = b.get(key);
    if (prev === undefined) added.push(line.trim());
    else if (unfocused(prev) !== unfocused(line)) changed.push(`${unfocused(line)}   (was: ${unfocused(prev)})`);
  }
  for (const [key, line] of b) if (!a.has(key)) removed.push(line.trim());

  if (!added.length && !changed.length && !removed.length) {
    return [
      ...(focus ? [`focus: ${focus}`] : []),
      'no other change in the page structure. If you acted on a canvas, take a screenshot to check; otherwise the action may have had no effect.',
    ];
  }
  if (added.length > after.length * 0.6 && after.length > 20) return 'full';
  const show = (title: string, lines: string[]) =>
    lines.length ? [`${title} (${lines.length}):`, ...lines.slice(0, MAX_DIFF_LINES).map((l) => `  ${l}`), ...(lines.length > MAX_DIFF_LINES ? [`  … ${lines.length - MAX_DIFF_LINES} more`] : [])] : [];
  return [...(focus ? [`focus: ${focus}`] : []), ...show('changed', changed), ...show('added', added), ...show('removed', removed.slice(0, 15))];
}
