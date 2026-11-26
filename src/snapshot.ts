// Accessibility-tree snapshot → compact indented text with stable [ref] numbers.
import type { Protocol } from 'devtools-protocol';
import type { Session } from './cdp.ts';
import type { Tab } from './tab.ts';

type AXNode = Protocol.Accessibility.AXNode;

// Wrapper roles that add tokens but no meaning: their children are promoted.
const FLATTEN = new Set(['generic', 'none', 'presentation', 'InlineTextBox', 'LineBreak', 'LayoutTable', 'LayoutTableRow', 'LayoutTableCell', 'ListMarker', 'Ruby', 'Abbr', 'emphasis', 'strong', 'Section', 'group']);
const SHOW_PROPS = ['focused', 'disabled', 'checked', 'pressed', 'selected', 'expanded', 'required', 'invalid', 'readonly', 'modal', 'valuemin', 'valuemax', 'valuetext'];
const MAX_CHILDREN = 50;
const KEEP_CHILDREN_WHEN_CAPPED = 40;
const MAX_TEXT = 120;

const clip = (s: string, n = MAX_TEXT) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const quote = (s: string) => JSON.stringify(clip(s.replace(/\s+/g, ' ').trim()));

function str(v: Protocol.Accessibility.AXValue | undefined) {
  const x = v?.value;
  return typeof x === 'string' ? x : typeof x === 'number' || typeof x === 'boolean' ? String(x) : '';
}

function props(node: AXNode) {
  const out: string[] = [];
  const value = str(node.value);
  if (value) out.push(`value=${quote(value)}`);
  for (const p of node.properties ?? []) {
    if (!SHOW_PROPS.includes(p.name)) continue;
    const v = p.value.value;
    if (v === false || v === 'false' || v === undefined || v === '') continue;
    out.push(v === true || v === 'true' ? p.name : `${p.name}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  }
  return out;
}

function isFocusable(node: AXNode) {
  return node.properties?.some((p) => p.name === 'focusable' && p.value.value === true) ?? false;
}

type Ctx = { tab: Tab; lines: string[]; max: number; truncated: boolean; capLists: boolean; prefetched: Map<Session, Promise<AXNode[]>> };

const fullTree = (session: Session) => session.send('Accessibility.getFullAXTree', {}).then((r) => r.nodes);

async function renderFrame(ctx: Ctx, session: Session, frameId: string | undefined, depth: number) {
  let nodes: AXNode[];
  try {
    const pre = frameId ? undefined : ctx.prefetched.get(session);
    nodes = pre ? await pre : (await session.send('Accessibility.getFullAXTree', frameId ? { frameId } : {})).nodes;
  } catch (e) {
    ctx.lines.push(`${'  '.repeat(depth)}(frame not readable: ${e instanceof Error ? e.message : String(e)})`);
    return;
  }
  const byId = new Map(nodes.map((n) => [n.nodeId, n]));
  const root = nodes.find((n) => !n.parentId);
  if (root) await walk(ctx, session, byId, root, depth, '');
}

async function walk(ctx: Ctx, session: Session, byId: Map<string, AXNode>, node: AXNode, depth: number, parentName: string) {
  if (ctx.lines.length >= ctx.max) {
    ctx.truncated = true;
    return;
  }
  const role = str(node.role);
  const name = str(node.name).trim();
  const pad = '  '.repeat(depth);
  let childDepth = depth + 1;
  let nameForChildren = parentName;

  if (role === 'ListMarker') return;
  const flatten = role === 'generic' ? !isFocusable(node) : (FLATTEN.has(role) && !name) || role === 'LabelText';
  if (node.ignored || role === 'RootWebArea' || flatten) {
    childDepth = depth;
  } else if (role === 'StaticText') {
    if (name && !parentName.includes(name)) ctx.lines.push(`${pad}text ${quote(name)}`);
    return;
  } else {
    // Unnamed node whose children are only text (list items, paragraphs, cells): put the text on the node's line.
    const kids = (node.childIds ?? []).map((id) => byId.get(id)).filter((n) => n !== undefined);
    const textOnly = !name && kids.length > 0 && kids.every((k) => str(k.role) === 'StaticText' || str(k.role) === 'ListMarker');
    const label = textOnly ? kids.filter((k) => str(k.role) === 'StaticText').map((k) => str(k.name)).join(' ').trim() : name;
    const ref = node.backendDOMNodeId !== undefined ? ctx.tab.refFor(session, node.backendDOMNodeId, role, label) : undefined;
    const parts = [ref !== undefined ? `[${ref}]` : '', role === 'generic' ? 'clickable' : role, label ? quote(label) : '', ...props(node)];
    ctx.lines.push(pad + parts.filter(Boolean).join(' '));
    if (textOnly) return;
    // A filled textbox repeats its value as child text; the value= prop already says it.
    nameForChildren = `${name}\n${str(node.value)}`;

    if (role === 'Iframe' && !(node.childIds?.length) && node.backendDOMNodeId !== undefined) {
      await renderChildFrame(ctx, session, node.backendDOMNodeId, childDepth);
      return;
    }
  }

  const children = node.childIds ?? [];
  const shown = ctx.capLists && children.length > MAX_CHILDREN ? children.slice(0, KEEP_CHILDREN_WHEN_CAPPED) : children;
  for (const id of shown) {
    const child = byId.get(id);
    if (child) await walk(ctx, session, byId, child, childDepth, nameForChildren);
  }
  if (shown.length < children.length) {
    ctx.lines.push(`${'  '.repeat(childDepth)}… ${children.length - shown.length} more items (use find, or scroll and snapshot again)`);
  }
}

async function renderChildFrame(ctx: Ctx, session: Session, ownerBackendNodeId: number, depth: number) {
  try {
    const { node } = await session.send('DOM.describeNode', { backendNodeId: ownerBackendNodeId });
    const frameId = node.frameId;
    if (!frameId) return;
    const oopif = ctx.tab.oopifs.get(frameId);
    if (oopif) await renderFrame(ctx, oopif, undefined, depth);
    else await renderFrame(ctx, session, frameId, depth);
  } catch {
    ctx.lines.push(`${'  '.repeat(depth)}(iframe content not available)`);
  }
}

const PAGE_INFO = `JSON.stringify({
  title: document.title,
  url: location.href,
  w: innerWidth, h: innerHeight,
  sx: Math.round(scrollX), sy: Math.round(scrollY),
  sh: document.documentElement ? document.documentElement.scrollHeight : 0,
  canvases: [...document.querySelectorAll('canvas')].map(c => c.getBoundingClientRect())
    .filter(r => r.width * r.height > 60000 && r.bottom > 0 && r.top < innerHeight)
    .map(r => [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]),
  media: [...document.querySelectorAll('video, audio')].filter(m => m.duration > 0).slice(0, 3)
    .map(m => [m.tagName.toLowerCase(), Math.round(m.currentTime * 10) / 10, isFinite(m.duration) ? Math.round(m.duration * 10) / 10 : -1, m.paused]),
  v: window.__mbMutations ?? -1
})`;

type PageInfo = {
  title: string;
  url: string;
  w: number;
  h: number;
  sx: number;
  sy: number;
  sh: number;
  canvases: [number, number, number, number][];
  media: [string, number, number, boolean][];
  /** DOM mutation count of the top document when this was read. */
  v: number;
};

export async function pageInfo(tab: Tab) {
  const r = await tab.page.send('Runtime.evaluate', { expression: PAGE_INFO, returnByValue: true }, 3000);
  const parsed: PageInfo = JSON.parse(String(r.result.value));
  return parsed;
}

export type Snapshot = { header: string[]; lines: string[]; truncated: boolean; info: PageInfo | undefined };

/** `full` = no line limit and no list capping (for find / wait_for / diffs). */
export async function snapshot(tab: Tab, max: number | 'full' = 'full') {
  if (tab.dialog) {
    // The page cannot answer anything while a JS dialog is open.
    const blocked: Snapshot = { header: [`BLOCKED by ${tab.dialog.type} dialog: ${quote(tab.dialog.message)}. Use dialog to accept or dismiss it first.`], lines: [], truncated: false, info: undefined };
    return blocked;
  }
  // Read info (with the mutation count) before the tree, so a change during the read makes the snapshot look stale, not fresh.
  const info = await pageInfo(tab).catch(() => undefined);
  // Fetch every frame's tree at once; the walk then only waits for ones it has not received yet.
  const prefetched = new Map<Session, Promise<AXNode[]>>();
  for (const s of [tab.page, ...tab.oopifs.values()]) {
    const p = fullTree(s);
    p.catch(() => undefined);
    prefetched.set(s, p);
  }
  const ctx: Ctx = { tab, lines: [], max: max === 'full' ? Number.POSITIVE_INFINITY : max, truncated: false, capLists: max !== 'full', prefetched };
  await renderFrame(ctx, tab.page, undefined, 0);
  const header: string[] = [];
  if (info) {
    header.push(`page ${quote(info.title)} ${info.url}`);
    header.push(`viewport ${info.w}x${info.h}, scrolled to y=${info.sy} of ${info.sh}`);
    for (const [x, y, w, h] of info.canvases) {
      header.push(`canvas x=${x} y=${y} ${w}x${h} (pixels only: screenshot + mouse tools)`);
    }
    for (const [tag, at, duration, paused] of info.media) {
      header.push(`${tag} at ${at}s of ${duration < 0 ? 'live' : `${duration}s`}, ${paused ? 'paused' : 'playing'}`);
    }
  }
  if (tab.fileChooser) header.push('a file picker is waiting: call upload with file paths');
  const snap: Snapshot = { header, lines: ctx.lines, truncated: ctx.truncated, info };
  return snap;
}

const REF_LINE = /^\s*\[(\d+)\] (\S+)(?: ("(?:[^"\\]|\\.)*"))?/;

/** `[12] button "Save" …` → { ref: 12, role: 'button', name: 'Save' }; undefined for text lines. */
export function parseRefLine(line: string) {
  const m = REF_LINE.exec(line);
  if (!m?.[1] || !m[2]) return undefined;
  let name = '';
  if (m[3]) {
    try {
      const v: unknown = JSON.parse(m[3]);
      if (typeof v === 'string') name = v;
    } catch {
      // clipped or malformed quote: treat as unnamed
    }
  }
  return { ref: Number(m[1]), role: m[2], name };
}

/** Keep a full snapshot as the tab's reference point for the next action's diff. */
export function remember(tab: Tab, snap: Snapshot) {
  tab.lastSnapshot = snap.info ? { lines: snap.lines, version: snap.info.v, url: snap.info.url } : undefined;
}

/**
 * At most `max` lines for a page the agent has not seen yet. Plain text lines go first (names of
 * elements already carry most meaning, and find still searches the text); then elements are cut.
 */
export function compactView(lines: string[], max: number) {
  if (lines.length <= max) return lines;
  const elements = lines.filter((l) => REF_LINE.test(l));
  const hidden = lines.length - elements.length;
  if (elements.length + 1 <= max) return [...elements, `… ${hidden} text lines hidden (find searches them)`];
  return [...elements.slice(0, max - 1), `… ${elements.length - (max - 1)} more elements (use find, or snapshot with a ref)`];
}

/** The lines of one ref's subtree (by indentation). */
export function subtree(lines: string[], ref: number) {
  const start = lines.findIndex((l) => l.trimStart().startsWith(`[${ref}] `));
  if (start < 0) return undefined;
  const indent = (l: string) => l.length - l.trimStart().length;
  const base = indent(lines[start] ?? '');
  const out = [lines[start] ?? ''];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i] ?? '';
    if (indent(l) <= base) break;
    out.push(l);
  }
  return out;
}
