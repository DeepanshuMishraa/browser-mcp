// Turning refs into screen points, and sending mouse/keyboard input through CDP.
// Input always goes to the top-level page session in viewport CSS pixels; this works for background tabs too.
import { CdpError } from './cdp.ts';
import { ToolError } from './browser.ts';
import type { RefTarget, Tab } from './tab.ts';

export type Point = { x: number; y: number };

export function target(tab: Tab, ref: number) {
  const t = tab.refs.get(ref);
  if (!t) throw new ToolError(`Unknown ref [${ref}]. Refs come from the latest snapshot; call snapshot.`);
  return t;
}

/** Is the node still attached to a live document? Detached or garbage-collected nodes count as gone. */
async function isConnected(t: RefTarget) {
  try {
    const { object } = await t.session.send('DOM.resolveNode', { backendNodeId: t.backendNodeId });
    if (!object.objectId) return false;
    const r = await t.session.send('Runtime.callFunctionOn', { objectId: object.objectId, functionDeclaration: 'function() { return this.isConnected; }', returnByValue: true });
    return r.result.value === true;
  } catch {
    return false;
  }
}

async function stale(t: RefTarget, ref: number, e: unknown): Promise<never> {
  if (!(e instanceof CdpError)) throw e;
  if (!(await isConnected(t))) {
    throw new ToolError(`[${ref}] ${t.role} "${t.name}" is no longer on the page (it changed since your snapshot). Nothing was done. Call snapshot to get fresh refs.`);
  }
  throw new ToolError(`[${ref}] ${t.role} "${t.name}" is on the page but has no clickable box (hidden, display:none, or zero size). Nothing was done. Open the menu/section that contains it first.`);
}

/** Offset of an out-of-process iframe's viewport inside the top-level page. */
async function frameOffset(tab: Tab, t: RefTarget) {
  if (t.session === tab.page) return { x: 0, y: 0 };
  let frameId: string | undefined;
  for (const [id, s] of tab.oopifs) if (s === t.session) frameId = id;
  if (!frameId) return { x: 0, y: 0 };
  // The <iframe> element lives in the parent frame's session: try the page first, then other OOPIFs.
  for (const s of [tab.page, ...tab.oopifs.values()]) {
    if (s === t.session) continue;
    try {
      const { backendNodeId } = await s.send('DOM.getFrameOwner', { frameId });
      const { model } = await s.send('DOM.getBoxModel', { backendNodeId });
      const [x = 0, y = 0] = model.content;
      return { x, y };
    } catch {
      // not the owner session
    }
  }
  return { x: 0, y: 0 };
}

/** Scrolls the element into view and returns the centre of its first visible box. */
export async function pointFor(tab: Tab, ref: number) {
  const t = target(tab, ref);
  try {
    await t.session.send('DOM.scrollIntoViewIfNeeded', { backendNodeId: t.backendNodeId }).catch(() => undefined);
    const { quads } = await t.session.send('DOM.getContentQuads', { backendNodeId: t.backendNodeId });
    const quad = quads.find((q) => Math.abs((q[4] ?? 0) - (q[0] ?? 0)) > 1 && Math.abs((q[5] ?? 0) - (q[1] ?? 0)) > 1);
    if (!quad) throw new ToolError(`[${ref}] ${t.role} "${t.name}" has no visible size (hidden or collapsed). Nothing was done.`);
    const xs = [quad[0], quad[2], quad[4], quad[6]].map(Number);
    const ys = [quad[1], quad[3], quad[5], quad[7]].map(Number);
    const off = await frameOffset(tab, t);
    return { x: (Math.min(...xs) + Math.max(...xs)) / 2 + off.x, y: (Math.min(...ys) + Math.max(...ys)) / 2 + off.y };
  } catch (e) {
    if (e instanceof ToolError) throw e;
    return stale(t, ref, e);
  }
}

/** If something else sits on top of the element at `p`, describe it. */
export async function coveredBy(tab: Tab, ref: number, p: Point) {
  const t = target(tab, ref);
  if (t.session !== tab.page) return undefined;
  try {
    const hit = await tab.page.send('DOM.getNodeForLocation', { x: Math.round(p.x), y: Math.round(p.y), includeUserAgentShadowDOM: false, ignorePointerEventsNone: true });
    if (hit.backendNodeId === t.backendNodeId) return undefined;
    const [{ object: self }, { object: other }] = await Promise.all([
      tab.page.send('DOM.resolveNode', { backendNodeId: t.backendNodeId }),
      tab.page.send('DOM.resolveNode', { backendNodeId: hit.backendNodeId }),
    ]);
    if (!self.objectId || !other.objectId) return undefined;
    const r = await tab.page.send('Runtime.callFunctionOn', {
      objectId: self.objectId,
      arguments: [{ objectId: other.objectId }],
      returnByValue: true,
      functionDeclaration: `function(hit) {
        const up = (n) => n.parentNode || n.host;
        for (let n = hit; n; n = up(n)) if (n === this) return null;
        for (let n = this; n; n = up(n)) if (n === hit) return null;
        if (this.labels) for (const l of this.labels) if (l.contains(hit)) return null;
        const el = hit.nodeType === 1 ? hit : hit.parentElement;
        return el ? (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' ' + JSON.stringify((el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 60))) : 'another element';
      }`,
    });
    const v = r.result.value;
    return typeof v === 'string' ? v : undefined;
  } catch {
    return undefined;
  }
}

type Button = 'left' | 'right' | 'middle';

export async function mouseMove(tab: Tab, p: Point, button: Button | 'none' = 'none', modifiers = 0) {
  await tab.page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button, buttons: button === 'none' ? 0 : 1, modifiers });
}

export async function click(tab: Tab, p: Point, opts: { button?: Button; count?: number; modifiers?: number } = {}) {
  const button = opts.button ?? 'left';
  const count = opts.count ?? 1;
  const modifiers = opts.modifiers ?? 0;
  await mouseMove(tab, p, 'none', modifiers);
  for (let i = 1; i <= count; i++) {
    await tab.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: p.x, y: p.y, button, buttons: 1, clickCount: i, modifiers });
    // A click that opens alert()/confirm() does not get a reply until the dialog closes: stop waiting once it opens.
    const released = tab.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: p.x, y: p.y, button, buttons: 0, clickCount: i, modifiers });
    await raceDialog(tab, released);
    if (tab.dialog) return;
  }
}

/** Waits for `p`, unless a JS dialog opens first (then returns without waiting; `p` resolves once the dialog closes). */
async function raceDialog(tab: Tab, p: Promise<unknown>) {
  let done = false;
  p.then(
    () => (done = true),
    () => (done = true),
  );
  while (!done && !tab.dialog) await new Promise((r) => setTimeout(r, 20));
  if (!tab.dialog) await p;
}

/** Press at the first point, move through the rest (interpolated), release at the last. For drawing, sliders, drag-and-drop. */
export async function drag(tab: Tab, path: Point[], opts: { button?: Button; modifiers?: number; stepPx?: number } = {}) {
  const [first, ...rest] = path;
  if (!first) return;
  const button = opts.button ?? 'left';
  const modifiers = opts.modifiers ?? 0;
  const step = opts.stepPx ?? 6;
  await mouseMove(tab, first, 'none', modifiers);
  await tab.page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: first.x, y: first.y, button, buttons: 1, clickCount: 1, modifiers });
  // CDP handles commands in order, so moves are pipelined and awaited together (much faster strokes).
  const moves: Promise<void>[] = [];
  let prev = first;
  for (const p of rest) {
    const n = Math.max(1, Math.ceil(Math.hypot(p.x - prev.x, p.y - prev.y) / step));
    for (let i = 1; i <= n; i++) {
      moves.push(mouseMove(tab, { x: prev.x + ((p.x - prev.x) * i) / n, y: prev.y + ((p.y - prev.y) * i) / n }, button, modifiers));
    }
    prev = p;
  }
  await Promise.all(moves);
  await tab.page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: prev.x, y: prev.y, button, buttons: 0, clickCount: 1, modifiers });
}

export async function wheel(tab: Tab, p: Point, dx: number, dy: number) {
  await tab.page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: p.x, y: p.y, deltaX: dx, deltaY: dy });
}

// ---- keyboard ----

const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };

type KeyDef = { key: string; code: string; keyCode: number; text?: string };

const NAMED: Record<string, KeyDef> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
};
for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = { key: `F${i}`, code: `F${i}`, keyCode: 111 + i };

function keyDef(name: string): KeyDef {
  const named = NAMED[name];
  if (named) return named;
  if (name.length === 1) {
    const upper = name.toUpperCase();
    const code = /[a-z]/i.test(name) ? `Key${upper}` : /[0-9]/.test(name) ? `Digit${name}` : '';
    return { key: name, code, keyCode: upper.charCodeAt(0), text: name };
  }
  throw new ToolError(`Unknown key "${name}". Use names like Enter, Tab, Escape, ArrowDown, a, 1, or combos like Meta+A, Shift+Tab.`);
}

// On macOS, editing shortcuts are OS key bindings that synthetic events do not trigger; pass the command explicitly.
const MAC_COMMANDS: Record<string, string> = { a: 'selectAll', c: 'copy', x: 'cut', v: 'paste', z: 'undo' };

/** Press a key or combo like "Enter", "Meta+A", "Shift+Tab". */
export async function press(tab: Tab, combo: string) {
  const parts = combo.split('+').map((s) => s.trim()).filter(Boolean);
  const keyName = parts.pop();
  if (!keyName) throw new ToolError(`Empty key combo "${combo}".`);
  let modifiers = 0;
  for (const m of parts) {
    const bit = MODIFIER_BITS[m];
    if (bit === undefined) throw new ToolError(`Unknown modifier "${m}" in "${combo}". Use Shift, Control, Alt, Meta.`);
    modifiers |= bit;
  }
  const def = keyDef(keyName);
  const hasCmd = (modifiers & (4 | 2)) !== 0;
  const text = hasCmd ? undefined : def.text;
  const command = process.platform === 'darwin' && modifiers & 4 ? MAC_COMMANDS[def.key.toLowerCase()] : undefined;
  const commands = command ? [modifiers & 8 && command === 'undo' ? 'redo' : command] : undefined;
  const base = { key: def.key, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers };
  const down = tab.page.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, text, unmodifiedText: text, commands });
  await raceDialog(tab, down);
  if (tab.dialog) return;
  await tab.page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

export async function insertText(tab: Tab, text: string) {
  await tab.page.send('Input.insertText', { text });
}
