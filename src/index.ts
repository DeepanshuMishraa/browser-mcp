import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { basename, resolve } from 'node:path';
import { z } from 'zod';
import { act, describeSettle, FULL_SNAPSHOT_LINES, LIST_CAPPED, pageVersion, shouldReread, waitBetweenSteps, waitForSettle } from './act.ts';
import { Browser, ToolError } from './browser.ts';
import { click, coveredBy, drag, insertText, mouseMove, pointFor, press, raceDialog, target, wheel } from './input.ts';
import { compactView, pageInfo, parseRefLine, remember, snapshot, subtree } from './snapshot.ts';
import type { Tab } from './tab.ts';
import { trace } from './trace.ts';

// Clients that load tool schemas lazily (e.g. Claude Code's tool search) show only tool names until a
// tool is picked, but always show these instructions. They say which tools to reach for first.
const INSTRUCTIONS = `Drives the user's real Chrome over CDP. Works on background tabs without switching.
- Read a page with snapshot (accessibility tree with [ref] numbers). Use find on long pages. Use screenshot for canvases and visual checks; scale 0.5 is enough to check progress.
- Act with batch whenever you can plan more than one step: it runs many steps in one call (click/type/hover by ref or by name+role, mouse_click, drag, strokes, scroll, press, eval, wait_for, screenshot). Every call re-sends the whole conversation, so one batch per phase of work is much cheaper than one call per action. Use report "none" for canvas work. Steps wait for the page to settle on their own; don't add wait steps. End a batch with read (query) or eval to get the result back instead of spending a turn on snapshot.
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

// z.number().int() puts ±2^53 bounds in the JSON schema of every integer field; multipleOf(1) validates the same in 14 chars.
const int = () => z.number().multipleOf(1);
const tabParam = int().optional().describe('Tab id from tabs. Default: the selected tab');
const refParam = int().describe('Ref from the snapshot, e.g. 12 for [12]');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function snapshotText(tab: Tab, header: string[], lines: string[], truncated: boolean) {
  return [...header, ...lines, ...(truncated ? ['… snapshot truncated: use find, snapshot with a ref, or scroll'] : [])].join('\n') || '(empty page)';
}

/** What to capture. Coordinates are viewport CSS pixels. */
type ShotArea = { kind: 'viewport' } | { kind: 'canvas' } | { kind: 'ref'; ref: number } | { kind: 'clip'; x: number; y: number; w: number; h: number };

const clipSchema = z.tuple([z.number(), z.number(), z.number().positive(), z.number().positive()]).describe('[x, y, w, h] viewport px');

/** Tool input (ref | region | clip) → one area; more than one is a mistake worth reporting. */
function shotArea(opts: { ref?: number; region?: 'viewport' | 'canvas'; clip?: [number, number, number, number] }): ShotArea {
  const given = [opts.ref !== undefined, opts.region === 'canvas', opts.clip !== undefined].filter(Boolean).length;
  if (given > 1) throw new ToolError('Pass only one of ref, region "canvas" or clip. Nothing was captured.');
  if (opts.ref !== undefined) return { kind: 'ref', ref: opts.ref };
  if (opts.clip) return { kind: 'clip', x: opts.clip[0], y: opts.clip[1], w: opts.clip[2], h: opts.clip[3] };
  return opts.region === 'canvas' ? { kind: 'canvas' } : { kind: 'viewport' };
}

/** `scale` < 1 shrinks the image: image tokens grow with pixel area and stay in context for every later turn. */
async function screenshotOf(tab: Tab, area: ShotArea, scale: number) {
  const metrics = await tab.page.send('Page.getLayoutMetrics');
  const vp = metrics.cssVisualViewport;
  const dpr = await tab.page.send('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true });
  const ratio = typeof dpr.result.value === 'number' ? dpr.result.value : 1;
  // Area in viewport CSS pixels.
  let box = { x: 0, y: 0, w: vp.clientWidth, h: vp.clientHeight };
  let what = 'the viewport';
  if (area.kind === 'ref') {
    const p = await pointFor(tab, area.ref);
    const t = target(tab, area.ref);
    const { quads } = await t.session.send('DOM.getContentQuads', { backendNodeId: t.backendNodeId });
    const q = quads[0] ?? [];
    const xs = [q[0], q[2], q[4], q[6]].map(Number);
    const ys = [q[1], q[3], q[5], q[7]].map(Number);
    const w = Math.max(...xs) - Math.min(...xs) + 40;
    const h = Math.max(...ys) - Math.min(...ys) + 40;
    box = { x: p.x - w / 2, y: p.y - h / 2, w, h };
    what = `[${area.ref}]`;
  } else if (area.kind === 'clip') {
    const x0 = Math.max(0, area.x);
    const y0 = Math.max(0, area.y);
    box = { x: x0, y: y0, w: Math.min(vp.clientWidth, area.x + area.w) - x0, h: Math.min(vp.clientHeight, area.y + area.h) - y0 };
    if (box.w <= 0 || box.h <= 0) throw new ToolError(`clip [${area.x}, ${area.y}, ${area.w}, ${area.h}] is outside the ${vp.clientWidth}x${vp.clientHeight} viewport. Nothing was captured.`);
    what = 'the clip';
  } else if (area.kind === 'canvas') {
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
  // An image identical to the last one from this tab adds tokens to every later turn and says nothing new.
  const key = `${Bun.hash(shot.data)}:${JSON.stringify(clip)}`;
  if (tab.lastShot === key) {
    const same: Content[] = [{ type: 'text', text: `screenshot of ${what}: unchanged since the previous screenshot (image omitted; that one still applies)` }];
    return { content: same };
  }
  tab.lastShot = key;
  const content: Content[] = [{ type: 'text', text: note }, { type: 'image', data: shot.data, mimeType: 'image/jpeg' }];
  return { content };
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
  let last: { version: string | undefined; at: number } | undefined;
  for (;;) {
    if (tab.dialog) throw new ToolError(`A ${tab.dialog.type} dialog is blocking the page: "${tab.dialog.message}". Use dialog first.`);
    // Reading all text walks every element: only do it when the page changed.
    const version = await pageVersion(tab);
    if (shouldReread(version, last, performance.now())) {
      last = { version, at: performance.now() };
      const all = await pageText(tab);
      if ((!want || all.includes(want.toLowerCase())) && (!gone || !all.includes(gone.toLowerCase()))) return Math.round(performance.now() - start);
    }
    if (performance.now() - start > timeoutMs) {
      throw new ToolError(`Timed out after ${timeoutMs}ms waiting for ${want ? `"${want}" to appear` : `"${gone}" to disappear`}. The page is unchanged otherwise; snapshot to see its state.`);
    }
    await sleep(100);
  }
}

// ---- tabs ----

server.registerTool(
  'tabs',
  { description: 'List tabs. * = selected; visible = in front in its window.' },
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
    description: 'Open a URL in a new tab (background by default) and select it.',
    inputSchema: { url: z.string(), background: z.boolean().default(true) },
  },
  ({ url, background }) =>
    guard(async () => {
      const b = await getBrowser();
      const { targetId } = await b.conn.send('Target.createTarget', { url, background });
      b.current = targetId;
      const tab = await b.attach(targetId);
      const s = await waitForSettle(tab, 10_000);
      const snap = await snapshot(tab, LIST_CAPPED);
      return text(`opened tab ${b.tabId(targetId)} (${describeSettle(s)})\n${snapshotText(tab, snap.header, compactView(snap.lines, FULL_SNAPSHOT_LINES), false)}`);
    }),
);

server.registerTool(
  'tab_select',
  {
    description: 'Make a tab the one later tools act on, without bringing it to front.',
    inputSchema: { tab: int() },
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
  { description: 'Close a tab.', inputSchema: { tab: int() } },
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
    description: 'Go to a URL, or back | forward | reload. Returns the loaded page.',
    inputSchema: { url: z.string(), tab: tabParam },
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
    description: 'Read the page as an accessibility tree, one `[ref] role "name" state` line per element, including iframes and shadow DOM. ref: only that subtree.',
    inputSchema: {
      tab: tabParam,
      ref: int().optional(),
      max_lines: int().default(400),
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
        const shot = await screenshotOf(tab, { kind: 'viewport' }, 0.5).catch(() => undefined);
        if (shot) return { content: [{ type: 'text' as const, text: `${body}\n(tree is nearly empty, screenshot attached)` }, ...shot.content] };
      }
      return text(body);
    }),
);

server.registerTool(
  'find',
  {
    description: 'Search the whole page (all frames, untruncated) for elements whose line contains the text.',
    inputSchema: { query: z.string(), tab: tabParam, limit: int().default(30) },
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
      'Screenshot the viewport, an element (ref), the largest canvas (region), or a rectangle (clip). The result says how image pixels map to viewport coordinates. Scale 1 or clip for small text. Identical repeats are omitted.',
    inputSchema: {
      tab: tabParam,
      ref: int().optional(),
      clip: clipSchema.optional(),
      scale: z.number().min(0.2).max(1).default(0.5),
      region: z.enum(['viewport', 'canvas']).default('viewport'),
    },
  },
  ({ tab: tabId, ref, clip, scale, region }) => guard(async () => screenshotOf(await getTab(tabId), shotArea({ ref, region, clip }), scale)),
);

server.registerTool(
  'wait_for',
  {
    description: 'Wait until text appears, or until gone text disappears (slow exports, uploads).',
    inputSchema: {
      text: z.string().optional(),
      gone: z.string().optional(),
      timeout_ms: int().default(15000),
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
    description: 'Click an element by ref.',
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
  { description: 'Move the mouse over an element.', inputSchema: { ref: refParam, tab: tabParam } },
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
    description: 'Type text, clicking ref first if given. Works in inputs, rich text and code editors. clear replaces content; submit presses Enter.',
    inputSchema: {
      text: z.string(),
      ref: int().optional(),
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
    description: 'Press a key or combo on the focused element: Enter, Escape, ArrowDown, Meta+A, Shift+Tab…',
    inputSchema: { keys: z.string(), times: int().min(1).max(100).default(1), tab: tabParam },
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
    description: 'Pick option(s) in a native <select> by value or label. Custom dropdowns: click instead.',
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
    description: 'Scroll ref into view, or by dx/dy pixels at x,y (default viewport centre; positive dy = down; x,y over a panel scrolls it).',
    inputSchema: {
      ref: int().optional(),
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
    description: 'Click at viewport coordinates (canvas apps, places without refs).',
    inputSchema: {
      x: z.number(),
      y: z.number(),
      button: z.enum(['left', 'right', 'middle']).default('left'),
      count: int().min(1).max(3).default(1),
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
    description: 'Press at the first point, move through the rest, release at the last (strokes, sliders, drag and drop). Viewport coordinates.',
    inputSchema: {
      path: z.array(pointSchema).min(2),
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
    description: 'Draw several separate drag paths in one call.',
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
const targetShape = { ref: int().optional(), name: z.string().optional(), role: z.string().optional() };
type TargetSpec = { ref?: number; name?: string; role?: string };

const NAME_WAIT_MS = 3000;

/** ref as given, or the first element whose name matches (exact, then substring; case-insensitive), waiting for it to appear. */
async function resolveRef(tab: Tab, t: TargetSpec) {
  if (t.ref !== undefined) return t.ref;
  if (t.name === undefined) throw new ToolError('Give ref, or name (optionally with role), to say which element');
  const want = t.name.toLowerCase();
  const role = t.role?.toLowerCase();
  const start = performance.now();
  let last: { version: string | undefined; at: number } | undefined;
  for (;;) {
    // A full tree read per poll is heavy on big pages: only re-read when the page changed.
    const version = await pageVersion(tab);
    if (shouldReread(version, last, performance.now())) {
      last = { version, at: performance.now() };
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
    }
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
  z.object({ do: z.literal('mouse_click'), x: z.number(), y: z.number(), count: int().min(1).max(3).default(1) }),
  z.object({ do: z.literal('drag'), path: z.array(pointSchema).min(2) }),
  z.object({ do: z.literal('strokes'), strokes: z.array(z.array(pointSchema).min(2)).min(1) }),
  z.object({ do: z.literal('scroll'), dy: z.number().default(0), dx: z.number().default(0), x: z.number().optional(), y: z.number().optional() }),
  z.object({ do: z.literal('press'), keys: z.string() }),
  z.object({ do: z.literal('eval'), expression: z.string() }),
  z.object({ do: z.literal('wait'), ms: int().min(0).max(10_000) }),
  z.object({ do: z.literal('wait_for'), text: z.string().optional(), gone: z.string().optional(), timeout_ms: int().max(60_000).default(10_000) }),
  z.object({ do: z.literal('screenshot'), scale: z.number().min(0.2).max(1).default(0.5), region: z.enum(['viewport', 'canvas']).default('viewport'), clip: clipSchema.optional() }),
  z.object({
    do: z.literal('read'),
    query: z.string().optional(),
    ref: int().optional(),
    limit: int().min(1).max(100).default(20),
  }),
]);
type Step = z.infer<typeof stepSchema>;

async function runStep(tab: Tab, step: Step, shots: Content[]) {
  switch (step.do) {
    case 'click': {
      const ref = await resolveRef(tab, step);
      const p = await pointFor(tab, ref);
      const cover = await coveredBy(tab, ref, p);
      await click(tab, p, { count: step.double ? 2 : 1 });
      return cover ? `warning: the click point of [${ref}] was covered by ${cover}; the click may have hit that instead` : undefined;
    }
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
    case 'screenshot': {
      const content = (await screenshotOf(tab, shotArea(step), step.scale)).content;
      shots.push(...content);
      return content.some((c) => c.type === 'image') ? 'screenshot attached' : 'screenshot unchanged since the previous one (image omitted)';
    }
    case 'read': {
      if ((step.query === undefined) === (step.ref === undefined)) throw new ToolError('read needs exactly one of query or ref');
      const snap = await snapshot(tab);
      remember(tab, snap);
      if (step.ref !== undefined) {
        const lines = subtree(snap.lines, step.ref);
        if (!lines) throw new ToolError(`[${step.ref}] is not on the page anymore`);
        return ['read:', ...lines.slice(0, step.limit)].join('\n');
      }
      const q = step.query?.toLowerCase() ?? '';
      const hits = snap.lines.filter((l) => l.toLowerCase().includes(q)).map((l) => `  ${l.trim()}`);
      if (!hits.length) return `read: no element contains "${step.query}"`;
      return [`read "${step.query}" (${hits.length} match(es)):`, ...hits.slice(0, step.limit)].join('\n');
    }
  }
}

/** Steps that can open, close or re-render parts of the page; the next step should see the result. */
const SETTLE_AFTER = new Set<Step['do']>(['click', 'type', 'press', 'mouse_click', 'hover']);

server.registerTool(
  'batch',
  {
    description:
      'Run steps in order in one call; plan a whole phase per call. Stops at the first failing step. click/type/hover take ref, or name (+role) resolved when the step runs (waits up to 3s), so one batch can open a menu, pick an item and fill its dialog. After click/type/press/mouse_click/hover it waits for the page to settle, so wait is rarely needed. read returns elements matching query, or ref\'s subtree; eval returns its value (top-level await ok); screenshot is half scale (region "canvas" or clip crops). report "none" skips the before/after diff (canvas work). screenshot: true attaches one at the end.',
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
              // The last step is followed by act's full settle.
              if (i < steps.length - 1 && SETTLE_AFTER.has(step.do)) await waitBetweenSteps(tab);
            } catch (e) {
              const msg = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '');
              return [...notes, `step ${i + 1} (${step.do}) failed: ${msg}. Steps before it ran; steps ${i + 1}-${steps.length} did not.`].join('\n');
            }
          }
          return notes.join('\n') || undefined;
        },
        { report: reportMode },
      );
      if (withShot) shots.push(...(await screenshotOf(tab, { kind: 'viewport' }, 0.5)).content);
      return { content: [{ type: 'text' as const, text: report }, ...shots] };
    }),
);

// ---- browser features ----

server.registerTool(
  'upload',
  {
    description: 'Attach local files. ref: a file input, or a button that opens a picker (intercepted). No ref: answer a picker that already opened.',
    inputSchema: { paths: z.array(z.string()).min(1), ref: int().optional(), tab: tabParam },
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
    description: 'Paste into the focused element (or ref, clicked first) without touching the clipboard. text: tab-separated rows fill a sheet range; html: rich text; files: local paths.',
    inputSchema: {
      text: z.string().optional(),
      html: z.string().optional(),
      files: z.array(z.string()).optional(),
      ref: int().optional(),
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
    description: 'Drop local files on an element (ref) or point (x, y), as if dragged in from the desktop.',
    inputSchema: { paths: z.array(z.string()).min(1), ref: int().optional(), x: z.number().optional(), y: z.number().optional(), tab: tabParam },
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
    description: 'Accept or dismiss an alert/confirm/prompt/beforeunload. text answers a prompt.',
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
      return text(`${accept ? 'accepted' : 'dismissed'} ${d.type} "${d.message}"; ${describeSettle(s)}`);
    }),
);

server.registerTool(
  'downloads',
  { description: 'List downloads with state and file path.' },
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
    description: 'Grant site permissions so no prompt appears.',
    inputSchema: {
      permissions: z.array(z.enum(['geolocation', 'notifications', 'clipboardReadWrite', 'clipboardSanitizedWrite', 'audioCapture', 'videoCapture', 'midi', 'storageAccess', 'windowManagement', 'localFonts'])),
      origin: z.string().optional().describe('Default: the selected tab'),
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
    description: 'Run JavaScript in the page; returns the JSON result (top-level await ok).',
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
