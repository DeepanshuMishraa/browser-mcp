import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { act, waitForSettle } from './act.ts';
import { Browser, ToolError } from './browser.ts';
import { click, coveredBy, drag, insertText, mouseMove, pointFor, press, raceDialog, target, wheel } from './input.ts';
import { pageInfo, parseRefLine, remember, snapshot, subtree } from './snapshot.ts';
import type { Tab } from './tab.ts';
import { trace } from './trace.ts';

// Clients that load tool schemas lazily (e.g. Claude Code's tool search) show only tool names until a
// tool is picked, but always show these instructions. They say which tools to reach for first.
const INSTRUCTIONS = `Drives the user's real Chrome over CDP. Works on background tabs without switching.
- Read a page with snapshot (accessibility tree with [ref] numbers). Use find on long pages. Use screenshot for canvases and visual checks; scale 0.5 is enough to check progress.
- Act with batch whenever you can plan more than one step: it runs many steps in one call (click/type/hover by ref or by name+role, mouse_click, drag, strokes, scroll, press, eval, wait_for, screenshot). Every call re-sends the whole conversation, so one batch per phase of work is much cheaper than one call per action. Use report "none" for canvas work.
- Every action returns what changed (diff, URL, dialogs, new tabs, downloads), so you rarely need a snapshot after acting.
- paste fills spreadsheets (tab-separated rows) and editors in one call; upload and drop_files attach local files; dialog answers alert/confirm/prompt; wait_for waits for slow results like exports.`;

const server = new McpServer({ name: 'mini-browser', version: '0.1.0' }, { instructions: INSTRUCTIONS });

// ---- connection ----

let browser: Browser | undefined;
async function getBrowser() {
  if (!browser || browser.conn.closed) browser = await Browser.connect();
  return browser;
}
async function getTab(tabId?: number) {
  return (await getBrowser()).tab(tabId);
}

// ---- tool plumbing ----

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
const text = (t: string) => ({ content: [{ type: 'text' as const, text: t }] });

async function guard(run: () => Promise<{ content: Content[] }>) {
  try {
    return await run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { content: [{ type: 'text' as const, text: e instanceof ToolError ? msg : `Unexpected browser error: ${msg}` }], isError: true };
  }
}

const tabParam = z.number().int().optional().describe('Tab id from `tabs`. Omit to use the selected tab (defaults to the tab in front). Works on background tabs without switching.');
const refParam = z.number().int().describe('Element ref number from the snapshot, e.g. 12 for [12]');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function snapshotText(tab: Tab, header: string[], lines: string[], truncated: boolean) {
  return [...header, ...lines, ...(truncated ? ['… snapshot truncated: use find, snapshot with a ref, or scroll'] : [])].join('\n') || '(empty page)';
}

/** Screenshot options. `scale` < 1 shrinks the image (image tokens grow with pixel area); `region: 'canvas'` crops to the largest visible canvas. */
type ShotOpts = { ref?: number; scale?: number; region?: 'viewport' | 'canvas' };

async function screenshotOf(tab: Tab, opts: ShotOpts = {}) {
  const scale = opts.scale ?? 1;
  const metrics = await tab.page.send('Page.getLayoutMetrics');
  const vp = metrics.cssVisualViewport;
  const dpr = await tab.page.send('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true });
  const ratio = typeof dpr.result.value === 'number' ? dpr.result.value : 1;
  // Area in viewport CSS pixels.
  let box = { x: 0, y: 0, w: vp.clientWidth, h: vp.clientHeight };
  let what = 'the viewport';
  if (opts.ref !== undefined) {
    const p = await pointFor(tab, opts.ref);
    const { quads } = await target(tab, opts.ref).session.send('DOM.getContentQuads', { backendNodeId: target(tab, opts.ref).backendNodeId });
    const q = quads[0] ?? [];
    const xs = [q[0], q[2], q[4], q[6]].map(Number);
    const ys = [q[1], q[3], q[5], q[7]].map(Number);
    const w = Math.max(...xs) - Math.min(...xs) + 40;
    const h = Math.max(...ys) - Math.min(...ys) + 40;
    box = { x: p.x - w / 2, y: p.y - h / 2, w, h };
    what = `[${opts.ref}]`;
  } else if (opts.region === 'canvas') {
    const info = await pageInfo(tab).catch(() => undefined);
    const biggest = info?.canvases.toSorted((a, b) => b[2] * b[3] - a[2] * a[3])[0];
    if (biggest) {
      const [x, y, w, h] = biggest;
      const x0 = Math.max(0, x);
      const y0 = Math.max(0, y);
      box = { x: x0, y: y0, w: Math.min(vp.clientWidth, x + w) - x0, h: Math.min(vp.clientHeight, y + h) - y0 };
      what = 'the largest canvas';
    }
  }
  const clip = { x: box.x + vp.pageX, y: box.y + vp.pageY, width: box.w, height: box.h, scale: scale / ratio };
  const ox = Math.round(box.x);
  const oy = Math.round(box.y);
  const mapping =
    ox === 0 && oy === 0 && scale === 1
      ? 'image pixels = viewport CSS pixels, so x,y read from it work directly with mouse tools'
      : `for mouse tools, viewport x = ${ox ? `${ox} + ` : ''}image x${scale === 1 ? '' : ` / ${scale}`}, viewport y = ${oy ? `${oy} + ` : ''}image y${scale === 1 ? '' : ` / ${scale}`}`;
  const note = `screenshot of ${what}, ${Math.round(box.w * scale)}x${Math.round(box.h * scale)}; ${mapping}`;
  const shot = await tab.page
    .send('Page.captureScreenshot', { format: 'jpeg', quality: scale < 1 ? 70 : 85, clip, captureBeyondViewport: false }, 8000)
    .catch((e) => {
      throw new ToolError(`Screenshot failed (${e instanceof Error ? e.message : String(e)}). The page itself is unchanged. A tab in a minimized window may not paint: snapshot still works, or ask the user to un-minimize the window.`);
    });
  return { content: [{ type: 'text' as const, text: note }, { type: 'image' as const, data: shot.data, mimeType: 'image/jpeg' }] };
}

// Visible text of a document, including open shadow roots, same-origin iframes and form values.
// Much cheaper than an accessibility snapshot, so wait_for can poll it often.
const PAGE_TEXT = `(() => {
  const parts = [document.title];
  const visit = (root) => {
    if (root.body) parts.push(root.body.innerText);
    else for (const c of root.children) parts.push(c.innerText ?? c.textContent ?? '');
    for (const el of root.querySelectorAll('*')) {
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') parts.push(el.value);
      if (el.shadowRoot) visit(el.shadowRoot);
      if (el.tagName === 'IFRAME') { try { if (el.contentDocument) visit(el.contentDocument); } catch {} }
    }
  };
  visit(document);
  return parts.join('\\n');
})()`;

async function pageText(tab: Tab) {
  const texts = await Promise.all(
    [tab.page, ...tab.oopifs.values()].map((s) =>
      s.send('Runtime.evaluate', { expression: PAGE_TEXT, returnByValue: true }, 2000).then(
        (r) => String(r.result.value ?? ''),
        () => '',
      ),
    ),
  );
  return texts.join('\n').toLowerCase();
}

/** Polls page text until `want` is present and `gone` is absent. Returns elapsed ms, or throws on timeout/dialog. */
async function waitForText(tab: Tab, want: string | undefined, gone: string | undefined, timeoutMs: number) {
  const start = performance.now();
  for (;;) {
    if (tab.dialog) throw new ToolError(`A ${tab.dialog.type} dialog is blocking the page: "${tab.dialog.message}". Use dialog first.`);
    const all = await pageText(tab);
    if ((!want || all.includes(want.toLowerCase())) && (!gone || !all.includes(gone.toLowerCase()))) return Math.round(performance.now() - start);
    if (performance.now() - start > timeoutMs) {
      throw new ToolError(`Timed out after ${timeoutMs}ms waiting for ${want ? `"${want}" to appear` : `"${gone}" to disappear`}. The page is unchanged otherwise; snapshot to see its state.`);
    }
    await sleep(100);
  }
}

// ---- tabs ----

server.registerTool(
  'tabs',
  { description: 'List open tabs. The selected tab is marked with *. Visible tabs are in front in their window.' },
  () =>
    guard(async () => {
      const b = await getBrowser();
      const vis = await b.visibility();
      const lines = [...b.targets.values()].map((t) => {
        const v = vis.get(t.targetId);
        const flags = [b.current === t.targetId ? '*' : ' ', v?.visible ? 'visible' : 'background'];
        return `${flags[0]} tab ${b.tabId(t.targetId)} [${flags[1]}] ${JSON.stringify(t.title)} ${t.url}`;
      });
      return text(lines.join('\n') || 'no tabs');
    }),
);

server.registerTool(
  'tab_open',
  {
    description: 'Open a URL in a new tab and select it. By default it opens in the background so the user is not interrupted.',
    inputSchema: { url: z.string(), background: z.boolean().default(true) },
  },
  ({ url, background }) =>
    guard(async () => {
      const b = await getBrowser();
      const { targetId } = await b.conn.send('Target.createTarget', { url, background });
      b.current = targetId;
      const tab = await b.attach(targetId);
      const s = await waitForSettle(tab, 10_000);
      const snap = await snapshot(tab, 300);
      return text(`opened tab ${b.tabId(targetId)} (${s.kind === 'settled' ? `settled in ${s.ms}ms` : s.kind})\n${snapshotText(tab, snap.header, snap.lines, snap.truncated)}`);
    }),
);

server.registerTool(
  'tab_select',
  {
    description: 'Make a tab the one later tools act on. It stays where it is: the user keeps the tab they are looking at.',
    inputSchema: { tab: z.number().int() },
  },
  ({ tab: tabId }) =>
    guard(async () => {
      const b = await getBrowser();
      const targetId = b.targetIdFor(tabId);
      b.current = targetId;
      await b.attach(targetId);
      return text(`selected tab ${tabId}`);
    }),
);

server.registerTool(
  'tab_close',
  { description: 'Close a tab.', inputSchema: { tab: z.number().int() } },
  ({ tab: tabId }) =>
    guard(async () => {
      const b = await getBrowser();
      await b.conn.send('Target.closeTarget', { targetId: b.targetIdFor(tabId) });
      return text(`closed tab ${tabId}`);
    }),
);

server.registerTool(
  'navigate',
  {
    description: 'Go to a URL in the tab, or "back", "forward", "reload". Returns what the page looks like after it loads.',
    inputSchema: { url: z.string().describe('URL, or back | forward | reload'), tab: tabParam },
  },
  ({ url, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      return text(
        await act(tab, `navigate ${url}`, async () => {
          // A beforeunload dialog holds the navigation until answered: raceDialog returns as soon as it opens.
          if (url === 'reload') await raceDialog(tab, tab.page.send('Page.reload'));
          else if (url === 'back' || url === 'forward') {
            const h = await tab.page.send('Page.getNavigationHistory');
            const entry = h.entries[h.currentIndex + (url === 'back' ? -1 : 1)];
            if (!entry) throw new ToolError(`Cannot go ${url}: no history entry.`);
            await raceDialog(tab, tab.page.send('Page.navigateToHistoryEntry', { entryId: entry.id }));
          } else {
            const r = await raceDialog(tab, tab.page.send('Page.navigate', { url }));
            if (r?.errorText) throw new ToolError(`Navigation to ${url} failed: ${r.errorText}`);
          }
          return undefined;
        }),
      );
    }),
);

// ---- reading ----

server.registerTool(
  'snapshot',
  {
    description:
      'Read the page as an accessibility tree: one line per element, `[ref] role "name" state`. Use refs with click/type/etc. Includes iframes and shadow DOM. Canvas areas are listed with coordinates; use screenshot for them.',
    inputSchema: {
      tab: tabParam,
      ref: z.number().int().optional().describe('Only show this element and its children'),
      max_lines: z.number().int().default(400),
    },
  },
  ({ tab: tabId, ref, max_lines }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const snap = await snapshot(tab, ref === undefined ? max_lines : 'full');
      if (ref !== undefined) {
        remember(tab, snap);
        const lines = subtree(snap.lines, ref);
        if (!lines) throw new ToolError(`[${ref}] is not on the page anymore. Call snapshot without ref.`);
        return text(lines.slice(0, max_lines).join('\n'));
      }
      const body = snapshotText(tab, snap.header, snap.lines, snap.truncated);
      // Design rule: when the tree has almost nothing to say, add a screenshot automatically.
      if (snap.lines.length < 5 && !tab.dialog) {
        const shot = await screenshotOf(tab).catch(() => undefined);
        if (shot) return { content: [{ type: 'text' as const, text: `${body}\n(tree is nearly empty, screenshot attached)` }, ...shot.content] };
      }
      return text(body);
    }),
);

server.registerTool(
  'find',
  {
    description: 'Search the whole page (all frames, no truncation) for elements whose line contains the text. Use on long or large pages.',
    inputSchema: { query: z.string(), tab: tabParam, limit: z.number().int().default(30) },
  },
  ({ query, tab: tabId, limit }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const snap = await snapshot(tab);
      const q = query.toLowerCase();
      const hits = snap.lines.filter((l) => l.toLowerCase().includes(q)).map((l) => l.trim());
      return text(hits.length ? [`${hits.length} match(es):`, ...hits.slice(0, limit)].join('\n') : `no element contains "${query}"`);
    }),
);

server.registerTool(
  'screenshot',
  {
    description:
      'Screenshot the viewport, one element (ref), or the largest canvas (region "canvas"). At scale 1 over the viewport, image pixels equal viewport CSS pixels for mouse tools; otherwise the result says how to convert. Images cost tokens by area and stay in context: use scale 0.5 for checking progress, 1 when reading exact coordinates.',
    inputSchema: {
      tab: tabParam,
      ref: z.number().int().optional(),
      scale: z.number().min(0.2).max(1).default(1),
      region: z.enum(['viewport', 'canvas']).default('viewport'),
    },
  },
  ({ tab: tabId, ref, scale, region }) => guard(async () => screenshotOf(await getTab(tabId), { ref, scale, region })),
);

server.registerTool(
  'wait_for',
  {
    description: 'Wait until text appears (or disappears) in the page, e.g. "Export complete". Use when an action starts something slow.',
    inputSchema: {
      text: z.string().optional(),
      gone: z.string().optional().describe('Wait until this text is no longer on the page'),
      timeout_ms: z.number().int().default(15000),
      tab: tabParam,
    },
  },
  ({ text: want, gone, timeout_ms, tab: tabId }) =>
    guard(async () => {
      if (!want && !gone) throw new ToolError('Pass text or gone.');
      const tab = await getTab(tabId);
      const ms = await waitForText(tab, want, gone, timeout_ms);
      if (!want) return text(`condition met after ${ms}ms`);
      // One tree read to hand back refs for what appeared.
      const snap = await snapshot(tab);
      remember(tab, snap);
      const hits = snap.lines.filter((l) => l.toLowerCase().includes(want.toLowerCase())).slice(0, 10);
      return text([`condition met after ${ms}ms`, ...hits.map((l) => l.trim())].join('\n'));
    }),
);

// ---- acting on elements ----

server.registerTool(
  'click',
  {
    description: 'Click an element by ref. Returns what changed on the page (diff, URL change, dialogs, new tabs, downloads).',
    inputSchema: {
      ref: refParam,
      button: z.enum(['left', 'right', 'middle']).default('left'),
      double: z.boolean().default(false),
      tab: tabParam,
    },
  },
  ({ ref, button, double, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const t = target(tab, ref);
      return text(
        await act(tab, `clicked [${ref}] ${t.role} "${t.name}"`, async () => {
          const p = await pointFor(tab, ref);
          const cover = await coveredBy(tab, ref, p);
          await click(tab, p, { button, count: double ? 2 : 1 });
          return cover ? `warning: the click point was covered by ${cover}; the click may have hit that instead` : undefined;
        }),
      );
    }),
);

server.registerTool(
  'hover',
  { description: 'Move the mouse over an element (menus, tooltips).', inputSchema: { ref: refParam, tab: tabParam } },
  ({ ref, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const t = target(tab, ref);
      return text(await act(tab, `hovered [${ref}] ${t.role} "${t.name}"`, async () => (await mouseMove(tab, await pointFor(tab, ref)), undefined)));
    }),
);

server.registerTool(
  'type',
  {
    description:
      'Type text. With ref, clicks the element first to focus it. Works for inputs, textareas, rich text and code editors. clear replaces existing content; submit presses Enter after.',
    inputSchema: {
      text: z.string(),
      ref: z.number().int().optional(),
      clear: z.boolean().default(false),
      submit: z.boolean().default(false),
      tab: tabParam,
    },
  },
  ({ text: value, ref, clear, submit, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const label = ref === undefined ? 'typed into the focused element' : `typed into [${ref}] ${target(tab, ref).role} "${target(tab, ref).name}"`;
      return text(
        await act(tab, label, async () => {
          if (ref !== undefined) {
            const t = target(tab, ref);
            await t.session.send('DOM.focus', { backendNodeId: t.backendNodeId }).catch(() => undefined);
            await click(tab, await pointFor(tab, ref));
          }
          if (clear) {
            await press(tab, process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
            await press(tab, 'Backspace');
          }
          await insertText(tab, value);
          if (submit) await press(tab, 'Enter');
          return undefined;
        }),
      );
    }),
);

server.registerTool(
  'press',
  {
    description: 'Press a key or shortcut on the focused element: Enter, Escape, Tab, ArrowDown, Backspace, Meta+A, Shift+Tab, Control+Z…',
    inputSchema: { keys: z.string(), times: z.number().int().min(1).max(100).default(1), tab: tabParam },
  },
  ({ keys, times, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      return text(
        await act(tab, `pressed ${keys}${times > 1 ? ` ×${times}` : ''}`, async () => {
          for (let i = 0; i < times; i++) await press(tab, keys);
          return undefined;
        }),
      );
    }),
);

server.registerTool(
  'select_option',
  {
    description: 'Choose option(s) in a native <select> by value or visible label. For custom dropdowns, click them and click the option instead.',
    inputSchema: { ref: refParam, values: z.array(z.string()).min(1), tab: tabParam },
  },
  ({ ref, values, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const t = target(tab, ref);
      return text(
        await act(tab, `select in [${ref}] ${t.role} "${t.name}"`, async () => {
          const { object } = await t.session.send('DOM.resolveNode', { backendNodeId: t.backendNodeId });
          if (!object.objectId) throw new ToolError(`[${ref}] could not be resolved. Call snapshot.`);
          const r = await t.session.send('Runtime.callFunctionOn', {
            objectId: object.objectId,
            arguments: [{ value: values }],
            returnByValue: true,
            functionDeclaration: `function(values) {
              if (this.tagName !== 'SELECT') return 'not a native <select>: click it, then click the option';
              const matched = [];
              for (const o of this.options) {
                const hit = values.some(v => v === o.value || v === o.label.trim() || v === o.textContent.trim());
                if (this.multiple) o.selected = hit; else if (hit && !matched.length) this.value = o.value;
                if (hit) matched.push(o.label.trim());
              }
              if (!matched.length) return 'no option matches; options are: ' + [...this.options].map(o => o.label.trim()).join(' | ');
              this.dispatchEvent(new Event('input', { bubbles: true }));
              this.dispatchEvent(new Event('change', { bubbles: true }));
              return 'ok: selected ' + matched.join(', ');
            }`,
          });
          const msg = String(r.result.value);
          if (!msg.startsWith('ok')) throw new ToolError(`[${ref}] ${msg}. Nothing was changed.`);
          return msg;
        }),
      );
    }),
);

server.registerTool(
  'scroll',
  {
    description: 'Scroll an element into view (ref), or scroll by dy/dx pixels at a point (default: centre of the viewport). Positive dy scrolls down. Works inside scrollable panels when x,y is over them.',
    inputSchema: {
      ref: z.number().int().optional(),
      dy: z.number().default(0),
      dx: z.number().default(0),
      x: z.number().optional(),
      y: z.number().optional(),
      tab: tabParam,
    },
  },
  ({ ref, dx, dy, x, y, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      return text(
        await act(tab, ref !== undefined ? `scrolled [${ref}] into view` : `scrolled by ${dx},${dy}`, async () => {
          if (ref !== undefined) {
            await pointFor(tab, ref);
            return undefined;
          }
          const m = await tab.page.send('Page.getLayoutMetrics');
          await wheel(tab, { x: x ?? m.cssVisualViewport.clientWidth / 2, y: y ?? m.cssVisualViewport.clientHeight / 2 }, dx, dy);
          return undefined;
        }),
      );
    }),
);

// ---- raw mouse: canvas apps, sliders, drag and drop ----

const pointSchema = z.tuple([z.number(), z.number()]);
const modifiersSchema = z.array(z.enum(['Shift', 'Alt', 'Control', 'Meta'])).default([]);
const modBits = (mods: string[]) => mods.reduce((acc, m) => acc | ({ Alt: 1, Control: 2, Meta: 4, Shift: 8 }[m] ?? 0), 0);

server.registerTool(
  'mouse_click',
  {
    description: 'Click at viewport coordinates (from a screenshot). For canvas apps and places without refs.',
    inputSchema: {
      x: z.number(),
      y: z.number(),
      button: z.enum(['left', 'right', 'middle']).default('left'),
      count: z.number().int().min(1).max(3).default(1),
      modifiers: modifiersSchema,
      tab: tabParam,
    },
  },
  ({ x, y, button, count, modifiers, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      return text(await act(tab, `clicked at (${x}, ${y})`, async () => (await click(tab, { x, y }, { button, count, modifiers: modBits(modifiers) }), undefined)));
    }),
);

server.registerTool(
  'mouse_drag',
  {
    description:
      'Press at the first point, move through the others, release at the last. Use for drawing strokes on a canvas (many points = a curve), sliders, resizing and drag-and-drop. Viewport coordinates.',
    inputSchema: {
      path: z.array(pointSchema).min(2).describe('[[x,y], [x,y], ...]'),
      button: z.enum(['left', 'right', 'middle']).default('left'),
      modifiers: modifiersSchema,
      tab: tabParam,
    },
  },
  ({ path, button, modifiers, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const pts = path.map(([x, y]) => ({ x, y }));
      return text(await act(tab, `dragged through ${pts.length} points`, async () => (await drag(tab, pts, { button, modifiers: modBits(modifiers) }), undefined)));
    }),
);

server.registerTool(
  'mouse_strokes',
  {
    description: 'Draw several separate strokes in one call (each stroke is a drag path). Much cheaper than many mouse_drag calls when painting.',
    inputSchema: { strokes: z.array(z.array(pointSchema).min(2)).min(1), tab: tabParam },
  },
  ({ strokes, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      return text(
        await act(tab, `drew ${strokes.length} strokes`, async () => {
          for (const s of strokes) await drag(tab, s.map(([x, y]) => ({ x, y })));
          return undefined;
        }),
      );
    }),
);

// Every model turn re-sends the whole conversation, so cost grows with the number of calls.
// batch lets the agent do a known sequence (pick colour → paint → pick colour → paint → look) in one call.
// Steps can name their target instead of using a ref, so one batch can walk through elements that
// earlier steps create (open menu → click item → fill dialog) without a snapshot turn in between.
const targetShape = { ref: z.number().int().optional(), name: z.string().optional(), role: z.string().optional() };
type TargetSpec = { ref?: number; name?: string; role?: string };

const NAME_WAIT_MS = 3000;

/** ref as given, or the first element whose name matches (exact, then substring; case-insensitive), waiting for it to appear. */
async function resolveRef(tab: Tab, t: TargetSpec) {
  if (t.ref !== undefined) return t.ref;
  if (t.name === undefined) throw new ToolError('Give ref, or name (optionally with role), to say which element');
  const want = t.name.toLowerCase();
  const role = t.role?.toLowerCase();
  const start = performance.now();
  for (;;) {
    const snap = await snapshot(tab);
    remember(tab, snap);
    let partial: number | undefined;
    for (const l of snap.lines) {
      const p = parseRefLine(l);
      if (!p?.name) continue;
      if (role && p.role.toLowerCase() !== role) continue;
      const name = p.name.toLowerCase();
      if (name === want) return p.ref;
      if (partial === undefined && name.includes(want)) partial = p.ref;
    }
    if (partial !== undefined) return partial;
    if (performance.now() - start > NAME_WAIT_MS) {
      throw new ToolError(`no element${role ? ` with role ${role}` : ''} named "${t.name}" appeared within ${NAME_WAIT_MS}ms; use find or snapshot to see what is there`);
    }
    await sleep(150);
  }
}

async function evaluate(tab: Tab, expression: string) {
  // replMode allows top-level await (and re-declaring let/const across calls).
  const r = await tab.page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true, replMode: true }, 15_000);
  if (r.exceptionDetails) throw new ToolError(`Script threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
  return r.result;
}

const stepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('click'), ...targetShape, double: z.boolean().default(false) }),
  z.object({ do: z.literal('type'), text: z.string(), ...targetShape, clear: z.boolean().default(false), submit: z.boolean().default(false) }),
  z.object({ do: z.literal('hover'), ...targetShape }),
  z.object({ do: z.literal('mouse_click'), x: z.number(), y: z.number(), count: z.number().int().min(1).max(3).default(1) }),
  z.object({ do: z.literal('drag'), path: z.array(pointSchema).min(2) }),
  z.object({ do: z.literal('strokes'), strokes: z.array(z.array(pointSchema).min(2)).min(1) }),
  z.object({ do: z.literal('scroll'), dy: z.number().default(0), dx: z.number().default(0), x: z.number().optional(), y: z.number().optional() }),
  z.object({ do: z.literal('press'), keys: z.string() }),
  z.object({ do: z.literal('eval'), expression: z.string() }),
  z.object({ do: z.literal('wait'), ms: z.number().int().min(0).max(10_000) }),
  z.object({ do: z.literal('wait_for'), text: z.string().optional(), gone: z.string().optional(), timeout_ms: z.number().int().max(60_000).default(10_000) }),
  z.object({ do: z.literal('screenshot'), scale: z.number().min(0.2).max(1).default(0.5), region: z.enum(['viewport', 'canvas']).default('viewport') }),
]);
type Step = z.infer<typeof stepSchema>;

async function runStep(tab: Tab, step: Step, shots: Content[]) {
  switch (step.do) {
    case 'click':
      await click(tab, await pointFor(tab, await resolveRef(tab, step)), { count: step.double ? 2 : 1 });
      return undefined;
    case 'type': {
      if (step.ref !== undefined || step.name !== undefined) {
        const ref = await resolveRef(tab, step);
        const t = target(tab, ref);
        await t.session.send('DOM.focus', { backendNodeId: t.backendNodeId }).catch(() => undefined);
        await click(tab, await pointFor(tab, ref));
      }
      if (step.clear) {
        await press(tab, process.platform === 'darwin' ? 'Meta+a' : 'Control+a');
        await press(tab, 'Backspace');
      }
      await insertText(tab, step.text);
      if (step.submit) await press(tab, 'Enter');
      return undefined;
    }
    case 'hover':
      await mouseMove(tab, await pointFor(tab, await resolveRef(tab, step)));
      return undefined;
    case 'mouse_click':
      await click(tab, { x: step.x, y: step.y }, { count: step.count });
      return undefined;
    case 'drag':
      await drag(tab, step.path.map(([x, y]) => ({ x, y })));
      return undefined;
    case 'strokes':
      for (const s of step.strokes) await drag(tab, s.map(([x, y]) => ({ x, y })));
      return undefined;
    case 'scroll': {
      const m = await tab.page.send('Page.getLayoutMetrics');
      await wheel(tab, { x: step.x ?? m.cssVisualViewport.clientWidth / 2, y: step.y ?? m.cssVisualViewport.clientHeight / 2 }, step.dx, step.dy);
      return undefined;
    }
    case 'press':
      await press(tab, step.keys);
      return undefined;
    case 'eval': {
      const v = (await evaluate(tab, step.expression)).value;
      return v === undefined ? undefined : `eval → ${JSON.stringify(v).slice(0, 300)}`;
    }
    case 'wait':
      await sleep(step.ms);
      return undefined;
    case 'wait_for': {
      if (!step.text && !step.gone) throw new ToolError('wait_for needs text or gone');
      return `waited ${await waitForText(tab, step.text, step.gone, step.timeout_ms)}ms`;
    }
    case 'screenshot':
      shots.push(...(await screenshotOf(tab, { scale: step.scale, region: step.region })).content);
      return 'screenshot attached';
  }
}

server.registerTool(
  'batch',
  {
    description:
      'Run steps in order in one call. Every call re-sends the whole conversation, so plan big batches: a whole phase of work per call (fill a whole form, walk a whole menu flow, do all edits of one kind), not one or two steps. click / type / hover take a ref, or a name (+ optional role) resolved when the step runs (waits up to 3s for it to appear), so one batch can open a menu, pick an item and fill the dialog it opens. Pointer: mouse_click, drag, strokes (many drag paths). Also: scroll, press, eval (top-level await ok), wait (ms), wait_for (text appears or is gone), screenshot (half scale by default; region "canvas" crops to the canvas). Stops at the first failing step. report "none" skips reading the page before and after (faster; for canvas work). screenshot: true attaches a half-scale screenshot at the end; images cost tokens and stay in context, so take one per phase, not per batch.',
    inputSchema: {
      steps: z.array(stepSchema).min(1).max(200),
      screenshot: z.boolean().default(false),
      report: z.enum(['diff', 'none']).default('diff'),
      tab: tabParam,
    },
  },
  ({ steps, screenshot: withShot, report: reportMode, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const shots: Content[] = [];
      const report = await act(
        tab,
        `batch of ${steps.length} steps`,
        async () => {
          const notes: string[] = [];
          for (const [i, step] of steps.entries()) {
            if (tab.dialog) return [...notes, `stopped before step ${i + 1}: a dialog is open`].join('\n');
            try {
              const note = await runStep(tab, step, shots);
              if (note) notes.push(`step ${i + 1}: ${note}`);
            } catch (e) {
              const msg = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '');
              return [...notes, `step ${i + 1} (${step.do}) failed: ${msg}. Steps before it ran; steps ${i + 1}-${steps.length} did not.`].join('\n');
            }
          }
          return notes.join('\n') || undefined;
        },
        { report: reportMode },
      );
      if (withShot) shots.push(...(await screenshotOf(tab, { scale: 0.5 })).content);
      return { content: [{ type: 'text' as const, text: report }, ...shots] };
    }),
);

// ---- browser features ----

server.registerTool(
  'upload',
  {
    description:
      'Attach local files. With ref: the <input type=file>, or a button that opens a file picker (it is clicked and the picker intercepted). Without ref: answers a file picker that already opened.',
    inputSchema: { paths: z.array(z.string()).min(1), ref: z.number().int().optional(), tab: tabParam },
  },
  ({ paths, ref, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const files = paths.map((p) => resolve(p));
      for (const f of files) if (!(await Bun.file(f).exists())) throw new ToolError(`File not found: ${f}. Nothing was uploaded.`);
      return text(
        await act(tab, `uploaded ${files.length} file(s)`, async () => {
          let backendNodeId: number | undefined;
          if (ref !== undefined) {
            const t = target(tab, ref);
            const { node } = await t.session.send('DOM.describeNode', { backendNodeId: t.backendNodeId });
            const attrs = node.attributes ?? [];
            const isFileInput = node.nodeName === 'INPUT' && attrs.some((a, i) => i % 2 === 0 && a === 'type' && attrs[i + 1] === 'file');
            if (isFileInput) {
              await t.session.send('DOM.setFileInputFiles', { files, backendNodeId: t.backendNodeId });
              return undefined;
            }
            tab.fileChooser = undefined;
            await click(tab, await pointFor(tab, ref));
            for (let i = 0; i < 20 && !tab.fileChooser; i++) await sleep(100);
          }
          backendNodeId = tab.fileChooser?.backendNodeId;
          if (backendNodeId === undefined) throw new ToolError('No file picker is open. Pass the ref of the file input or of the button that opens the picker.');
          await tab.page.send('DOM.setFileInputFiles', { files, backendNodeId });
          tab.fileChooser = undefined;
          return undefined;
        }),
      );
    }),
);

// Dispatches a synthetic paste on the deepest focused element (through shadow roots and same-origin iframes).
// The page's own paste handler does the work, so one call fills a spreadsheet range or inserts rich content.
const PASTE_FN = `(text, html, files) => {
  let el = document.activeElement;
  for (;;) {
    if (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    else if (el && el.tagName === 'IFRAME') { try { const d = el.contentDocument; if (!d || !d.activeElement) break; el = d.activeElement; } catch { break; } }
    else break;
  }
  el = el || document.body;
  const dt = new DataTransfer();
  if (text) dt.setData('text/plain', text);
  if (html) dt.setData('text/html', html);
  for (const f of files) {
    const bin = atob(f.data);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type }));
  }
  const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true, composed: true });
  el.dispatchEvent(ev);
  return JSON.stringify({ handled: ev.defaultPrevented, editable: !!(el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA'), tag: el.tagName.toLowerCase() });
}`;

async function readFiles(paths: string[]) {
  return Promise.all(
    paths.map(async (p) => {
      const path = resolve(p);
      const f = Bun.file(path);
      if (!(await f.exists())) throw new ToolError(`File not found: ${path}. Nothing was done.`);
      return { path, name: basename(path), type: f.type, data: Buffer.from(await f.arrayBuffer()).toString('base64') };
    }),
  );
}

server.registerTool(
  'paste',
  {
    description:
      'Paste like Cmd+V into the focused element (or ref, which is clicked first), without touching the real clipboard. text: tab-separated rows fill a spreadsheet range in one call. html: rich text for docs and editors. files: local paths, e.g. an image into a canvas or design app.',
    inputSchema: {
      text: z.string().optional(),
      html: z.string().optional(),
      files: z.array(z.string()).optional(),
      ref: z.number().int().optional(),
      tab: tabParam,
    },
  },
  ({ text: plain, html, files: paths, ref, tab: tabId }) =>
    guard(async () => {
      if (!plain && !html && !paths?.length) throw new ToolError('Pass text, html or files.');
      const tab = await getTab(tabId);
      const files = await readFiles(paths ?? []);
      return text(
        await act(tab, `pasted ${[plain ? 'text' : '', html ? 'html' : '', files.length ? `${files.length} file(s)` : ''].filter(Boolean).join(' + ')}`, async () => {
          const session = ref === undefined ? tab.page : target(tab, ref).session;
          if (ref !== undefined) await click(tab, await pointFor(tab, ref));
          const args = [plain ?? '', html ?? '', files.map(({ name, type, data }) => ({ name, type, data }))].map((a) => JSON.stringify(a)).join(', ');
          const r = await session.send('Runtime.evaluate', { expression: `(${PASTE_FN})(${args})`, returnByValue: true }, 15_000);
          if (r.exceptionDetails) throw new ToolError(`Paste failed in the page: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}. Nothing was pasted.`);
          const res: unknown = JSON.parse(String(r.result.value));
          const handled = typeof res === 'object' && res !== null && 'handled' in res && res.handled === true;
          const editable = typeof res === 'object' && res !== null && 'editable' in res && res.editable === true;
          if (handled) return 'the page handled the paste';
          // A synthetic paste has no default action: plain fields need the text inserted for them.
          if (editable && plain) {
            await insertText(tab, plain);
            return 'the page ignored the paste event; inserted the text instead';
          }
          return 'warning: nothing handled the paste (no focused editor?). Click the target first or pass ref.';
        }),
      );
    }),
);

server.registerTool(
  'drop_files',
  {
    description: 'Drag local files from outside the browser and drop them on an element (ref) or a point (x, y). Opens files in apps that accept drops: image and video editors, design tools, upload areas.',
    inputSchema: { paths: z.array(z.string()).min(1), ref: z.number().int().optional(), x: z.number().optional(), y: z.number().optional(), tab: tabParam },
  },
  ({ paths, ref, x, y, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const files = (await readFiles(paths)).map((f) => f.path);
      return text(
        await act(tab, `dropped ${files.length} file(s)`, async () => {
          const p = ref !== undefined ? await pointFor(tab, ref) : x !== undefined && y !== undefined ? { x, y } : undefined;
          if (!p) throw new ToolError('Pass ref, or both x and y, for where to drop. Nothing was dropped.');
          const data = { items: [], files, dragOperationsMask: 1 };
          for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
            await tab.page.send('Input.dispatchDragEvent', { type, x: p.x, y: p.y, data });
          }
          return undefined;
        }),
      );
    }),
);

server.registerTool(
  'dialog',
  {
    description: 'Accept or dismiss an alert / confirm / prompt / beforeunload dialog. text answers a prompt.',
    inputSchema: { accept: z.boolean(), text: z.string().optional(), tab: tabParam },
  },
  ({ accept, text: promptText, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      if (!tab.dialog) throw new ToolError('No dialog is open on this tab.');
      const d = tab.dialog;
      await tab.page.send('Page.handleJavaScriptDialog', { accept, promptText });
      tab.dialog = undefined;
      const s = await waitForSettle(tab);
      return text(`${accept ? 'accepted' : 'dismissed'} ${d.type} "${d.message}"; ${s.kind === 'settled' ? `page settled in ${s.ms}ms` : s.kind}`);
    }),
);

server.registerTool(
  'downloads',
  { description: 'List downloads seen since the server connected, with state and file path.' },
  () =>
    guard(async () => {
      const b = await getBrowser();
      const lines = [...b.downloads.values()].map((d) => `${d.state} ${d.filename}${d.path ? ` → ${d.path}` : ''} (from ${d.url.slice(0, 100)})`);
      return text(lines.join('\n') || 'no downloads yet');
    }),
);

server.registerTool(
  'grant_permissions',
  {
    description: 'Grant site permissions so the browser does not show a prompt: geolocation, notifications, clipboardReadWrite, audioCapture, videoCapture, etc.',
    inputSchema: {
      permissions: z.array(z.enum(['geolocation', 'notifications', 'clipboardReadWrite', 'clipboardSanitizedWrite', 'audioCapture', 'videoCapture', 'midi', 'storageAccess', 'windowManagement', 'localFonts'])),
      origin: z.string().optional().describe('Defaults to the origin of the selected tab'),
      tab: tabParam,
    },
  },
  ({ permissions, origin, tab: tabId }) =>
    guard(async () => {
      const b = await getBrowser();
      const tab = await b.tab(tabId);
      const url = origin ?? (await tab.page.send('Runtime.evaluate', { expression: 'location.origin', returnByValue: true })).result.value;
      if (typeof url !== 'string') throw new ToolError('Could not read the tab origin; pass origin.');
      await b.conn.send('Browser.grantPermissions', { permissions, origin: url });
      return text(`granted ${permissions.join(', ')} to ${url}`);
    }),
);

server.registerTool(
  'eval_js',
  {
    description: 'Run JavaScript in the page and return the JSON result (top-level await ok). Escape hatch for reading data or app state the tree does not show.',
    inputSchema: { expression: z.string(), tab: tabParam },
  },
  ({ expression, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const r = await evaluate(tab, expression);
      const v = r.value;
      return text(v === undefined ? String(r.description ?? 'undefined') : JSON.stringify(v, null, 1).slice(0, 20_000));
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
trace(transport);
