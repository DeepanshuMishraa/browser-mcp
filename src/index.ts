import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { resolve } from 'node:path';
import { z } from 'zod';
import { act, waitForSettle } from './act.ts';
import { Browser, ToolError } from './browser.ts';
import { click, coveredBy, drag, insertText, mouseMove, pointFor, press, target, wheel } from './input.ts';
import { snapshot, subtree } from './snapshot.ts';
import type { Tab } from './tab.ts';
import { trace } from './trace.ts';

const server = new McpServer({ name: 'mini-browser', version: '0.1.0' });

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

async function screenshotOf(tab: Tab, ref?: number) {
  const metrics = await tab.page.send('Page.getLayoutMetrics');
  const vp = metrics.cssVisualViewport;
  const dpr = await tab.page.send('Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true });
  const ratio = typeof dpr.result.value === 'number' ? dpr.result.value : 1;
  let clip = { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: 1 / ratio };
  let note = `screenshot of the viewport, ${Math.round(vp.clientWidth)}x${Math.round(vp.clientHeight)}; image pixels = viewport CSS pixels, so x,y read from it work directly with mouse_click / mouse_drag`;
  if (ref !== undefined) {
    const p = await pointFor(tab, ref);
    const { quads } = await target(tab, ref).session.send('DOM.getContentQuads', { backendNodeId: target(tab, ref).backendNodeId });
    const q = quads[0] ?? [];
    const xs = [q[0], q[2], q[4], q[6]].map(Number);
    const ys = [q[1], q[3], q[5], q[7]].map(Number);
    const w = Math.max(...xs) - Math.min(...xs) + 40;
    const h = Math.max(...ys) - Math.min(...ys) + 40;
    const x = p.x - w / 2;
    const y = p.y - h / 2;
    clip = { x: x + vp.pageX, y: y + vp.pageY, width: w, height: h, scale: 1 / ratio };
    note = `screenshot of [${ref}]; image (0,0) is viewport point (${Math.round(x)}, ${Math.round(y)}) — add that offset for mouse tools`;
  }
  const shot = await tab.page
    .send('Page.captureScreenshot', { format: 'jpeg', quality: 85, clip, captureBeyondViewport: false }, 8000)
    .catch((e) => {
      throw new ToolError(`Screenshot failed (${e instanceof Error ? e.message : String(e)}). Background tabs may not paint; try tab_select with bring_to_front: true.`);
    });
  return { content: [{ type: 'text' as const, text: note }, { type: 'image' as const, data: shot.data, mimeType: 'image/jpeg' }] };
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
      tab.lastSnapshot = snap.lines;
      return text(`opened tab ${b.tabId(targetId)} (${s.kind === 'settled' ? `settled in ${s.ms}ms` : s.kind})\n${snapshotText(tab, snap.header, snap.lines, snap.truncated)}`);
    }),
);

server.registerTool(
  'tab_select',
  {
    description: 'Make a tab the one later tools act on. bring_to_front also shows it to the user (only needed if screenshots of a background tab fail).',
    inputSchema: { tab: z.number().int(), bring_to_front: z.boolean().default(false) },
  },
  ({ tab: tabId, bring_to_front }) =>
    guard(async () => {
      const b = await getBrowser();
      const targetId = b.targetIdFor(tabId);
      b.current = targetId;
      const tab = await b.attach(targetId);
      if (bring_to_front) await tab.page.send('Page.bringToFront');
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
          if (url === 'reload') await tab.page.send('Page.reload');
          else if (url === 'back' || url === 'forward') {
            const h = await tab.page.send('Page.getNavigationHistory');
            const entry = h.entries[h.currentIndex + (url === 'back' ? -1 : 1)];
            if (!entry) throw new ToolError(`Cannot go ${url}: no history entry.`);
            await tab.page.send('Page.navigateToHistoryEntry', { entryId: entry.id });
          } else {
            const r = await tab.page.send('Page.navigate', { url });
            if (r.errorText) throw new ToolError(`Navigation to ${url} failed: ${r.errorText}`);
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
      tab.lastSnapshot = snap.lines;
      if (ref !== undefined) {
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
    description: 'Screenshot the viewport (or one element). Image pixels equal viewport CSS pixels, so coordinates from it can be passed to mouse_click / mouse_drag. Use for canvas apps and visual checks.',
    inputSchema: { tab: tabParam, ref: z.number().int().optional() },
  },
  ({ tab: tabId, ref }) => guard(async () => screenshotOf(await getTab(tabId), ref)),
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
      const start = performance.now();
      for (;;) {
        const snap = await snapshot(tab);
        const all = [...snap.header, ...snap.lines].join('\n').toLowerCase();
        const ok = (!want || all.includes(want.toLowerCase())) && (!gone || !all.includes(gone.toLowerCase()));
        if (ok) {
          tab.lastSnapshot = snap.lines;
          const hits = want ? snap.lines.filter((l) => l.toLowerCase().includes(want.toLowerCase())).slice(0, 10) : [];
          return text([`condition met after ${Math.round(performance.now() - start)}ms`, ...hits.map((l) => l.trim())].join('\n'));
        }
        if (tab.dialog) throw new ToolError(`A ${tab.dialog.type} dialog is blocking the page: "${tab.dialog.message}". Use dialog first.`);
        if (performance.now() - start > timeout_ms) throw new ToolError(`Timed out after ${timeout_ms}ms waiting for ${want ? `"${want}" to appear` : `"${gone}" to disappear`}. The page is unchanged otherwise; snapshot to see its state.`);
        await sleep(500);
      }
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
const stepSchema = z.discriminatedUnion('do', [
  z.object({ do: z.literal('click'), ref: refParam }),
  z.object({ do: z.literal('mouse_click'), x: z.number(), y: z.number(), count: z.number().int().min(1).max(3).default(1) }),
  z.object({ do: z.literal('drag'), path: z.array(pointSchema).min(2) }),
  z.object({ do: z.literal('strokes'), strokes: z.array(z.array(pointSchema).min(2)).min(1) }),
  z.object({ do: z.literal('type'), text: z.string(), ref: z.number().int().optional() }),
  z.object({ do: z.literal('press'), keys: z.string() }),
  z.object({ do: z.literal('eval'), expression: z.string() }),
  z.object({ do: z.literal('wait'), ms: z.number().int().min(0).max(10_000) }),
]);
type Step = z.infer<typeof stepSchema>;

async function runStep(tab: Tab, step: Step) {
  switch (step.do) {
    case 'click':
      await click(tab, await pointFor(tab, step.ref));
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
    case 'type':
      if (step.ref !== undefined) await click(tab, await pointFor(tab, step.ref));
      await insertText(tab, step.text);
      return undefined;
    case 'press':
      await press(tab, step.keys);
      return undefined;
    case 'eval': {
      const r = await tab.page.send('Runtime.evaluate', { expression: step.expression, returnByValue: true, awaitPromise: true, userGesture: true }, 15_000);
      if (r.exceptionDetails) throw new ToolError(`script threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      return r.result.value === undefined ? undefined : `eval → ${JSON.stringify(r.result.value).slice(0, 300)}`;
    }
    case 'wait':
      await sleep(step.ms);
      return undefined;
  }
}

server.registerTool(
  'batch',
  {
    description:
      'Run several steps in one call, in order: click, mouse_click, drag, strokes, type, press, eval, wait. Use it whenever you already know the next few steps (e.g. set a colour with eval, paint strokes, set the next colour, paint more). Stops at the first failing step. screenshot: true attaches a screenshot at the end, so you can check the result without another call.',
    inputSchema: { steps: z.array(stepSchema).min(1).max(200), screenshot: z.boolean().default(false), tab: tabParam },
  },
  ({ steps, screenshot: withShot, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const report = await act(tab, `batch of ${steps.length} steps`, async () => {
        const notes: string[] = [];
        for (const [i, step] of steps.entries()) {
          if (tab.dialog) return [...notes, `stopped before step ${i + 1}: a dialog is open`].join('\n');
          try {
            const note = await runStep(tab, step);
            if (note) notes.push(`step ${i + 1}: ${note}`);
          } catch (e) {
            const msg = (e instanceof Error ? e.message : String(e)).replace(/\.$/, '');
            return [...notes, `step ${i + 1} (${step.do}) failed: ${msg}. Steps before it ran; steps ${i + 1}-${steps.length} did not.`].join('\n');
          }
        }
        return notes.join('\n') || undefined;
      });
      if (!withShot) return text(report);
      const shot = await screenshotOf(tab);
      return { content: [{ type: 'text' as const, text: report }, ...shot.content] };
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
    description: 'Run JavaScript in the page and return the JSON result. Escape hatch for reading data or app state the tree does not show.',
    inputSchema: { expression: z.string(), tab: tabParam },
  },
  ({ expression, tab: tabId }) =>
    guard(async () => {
      const tab = await getTab(tabId);
      const r = await tab.page.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, 15_000);
      if (r.exceptionDetails) throw new ToolError(`Script threw: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
      const v = r.result.value;
      return text(v === undefined ? String(r.result.description ?? 'undefined') : JSON.stringify(v, null, 1).slice(0, 20_000));
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
trace(transport);
