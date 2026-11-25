# mini-browser MCP

An MCP server that lets an agent read and act on pages in your running Chromium browser (Chrome, Helium, Brave, Edge). The CDP client is hand-written (`src/cdp.ts`, one WebSocket, flattened sessions). No Playwright or Puppeteer.

## Run

Requires [Bun](https://bun.sh).

```sh
bun install
bun run check   # typecheck
```

### 1. Let the server reach your browser

Pick one:

- **Your everyday browser (recommended):** open `chrome://inspect/#remote-debugging` and turn on "Allow remote debugging". The server finds the browser through its `DevToolsActivePort` file. Accept the "Allow remote debugging?" prompt the first time.
- **A separate instance:** start the browser with `--remote-debugging-port=9222 --user-data-dir=/tmp/agent-profile`.
- **Explicit:** set `CDP_URL` to `ws://…` or `http://host:port`.

### 2. Add it to an agent

Claude Code: the repo ships `.mcp.json`, so starting `claude` in this folder picks it up. From anywhere else:

```sh
claude mcp add mini-browser -- bun /absolute/path/to/mini-browser-task/src/index.ts
```

Other MCP clients (Claude Desktop, Cursor, …):

```json
{ "mcpServers": { "mini-browser": { "command": "bun", "args": ["/absolute/path/to/src/index.ts"] } } }
```

## Tools

| Tool | What it does |
|---|---|
| `tabs`, `tab_open`, `tab_select`, `tab_close` | List tabs (front or background), open in the background, pick the working tab |
| `navigate` | URL, `back`, `forward`, `reload` |
| `snapshot` | Accessibility tree as `[ref] role "name" state`, including iframes (also cross-origin) and closed shadow roots. Long lists are capped. Canvas areas are listed with coordinates |
| `find` | Search the whole page with no cap (large pages, long lists) |
| `screenshot` | Viewport or one element. Image pixels equal CSS pixels, so coordinates go straight to mouse tools |
| `click`, `hover`, `type`, `press`, `select_option`, `scroll` | Act on refs. `type` uses `Input.insertText`, so it works for rich text and code editors |
| `mouse_click`, `mouse_drag`, `mouse_strokes` | Coordinate input for canvas apps, sliders, drag and drop. `mouse_strokes` paints many strokes in one call |
| `batch` | Many steps in one call. `click`/`type`/`hover` take a ref or a `name` (+`role`) resolved when the step runs, so one call can walk a menu → dialog → form. Also `wait_for` and `screenshot` steps. `report: "none"` skips the before/after page read for canvas work |
| `paste` | Synthetic paste of text, HTML or files into the focused element: tab-separated rows fill a spreadsheet range in one call |
| `drop_files` | Drop local files onto an element or point (editors and upload areas that accept drops) |
| `upload` | `<input type=file>`, or a button that opens a picker (the picker is intercepted). The File System Access pickers are removed from pages so apps fall back to this |
| `dialog` | Accept or dismiss alert, confirm, prompt or beforeunload |
| `wait_for` | Wait for text to appear or disappear (exports, uploads) |
| `downloads`, `grant_permissions`, `eval_js` | Download tracking, permission grants, JS escape hatch |

Every action returns what happened: whether the page settled (and how long it took), URL change, focus, changed, added and removed elements, plus events (dialogs, new tabs or popups, downloads, file pickers, page errors).

## Code map

- `src/cdp.ts`: WebSocket CDP client, typed with `devtools-protocol` (types only)
- `src/discover.ts`: finds the browser
- `src/browser.ts`: tabs, front-tab detection, downloads
- `src/tab.ts`: per-tab sessions, OOPIF auto-attach, network tracking, dialogs, stable refs
- `src/snapshot.ts`: accessibility tree to text
- `src/act.ts`: settle detection and action diff
- `src/input.ts`: ref to point, mouse and keyboard, cover check, stale-ref check
- `src/index.ts`: MCP tools
