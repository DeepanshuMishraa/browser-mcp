// Find the WebSocket URL of a running Chromium browser.
// Order: CDP_URL env → DevToolsActivePort files (chrome://inspect/#remote-debugging toggle) → localhost:9222.
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAC_DIRS = [
  'Google/Chrome',
  'Google/Chrome Beta',
  'Google/Chrome Canary',
  'Chromium',
  'net.imput.helium',
  'BraveSoftware/Brave-Browser',
  'Microsoft Edge',
];
const LINUX_DIRS = ['google-chrome', 'google-chrome-beta', 'chromium', 'BraveSoftware/Brave-Browser'];

function candidateDirs() {
  const home = homedir();
  if (process.platform === 'darwin') return MAC_DIRS.map((d) => join(home, 'Library/Application Support', d));
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? join(home, 'AppData/Local');
    return [join(local, 'Google/Chrome/User Data'), join(local, 'Chromium/User Data')];
  }
  return LINUX_DIRS.map((d) => join(home, '.config', d));
}

async function fromHttp(base: string) {
  const res = await fetch(new URL('/json/version', base), { signal: AbortSignal.timeout(2000) });
  const json: unknown = await res.json();
  if (typeof json === 'object' && json !== null && 'webSocketDebuggerUrl' in json && typeof json.webSocketDebuggerUrl === 'string') {
    return json.webSocketDebuggerUrl;
  }
  throw new Error(`${base}/json/version has no webSocketDebuggerUrl`);
}

/** Returns candidate browser WebSocket URLs, most specific first. */
export async function discoverBrowserUrls() {
  const env = process.env.CDP_URL;
  if (env) return [env.startsWith('ws') ? env : await fromHttp(env)];

  const urls: string[] = [];
  for (const dir of candidateDirs()) {
    const file = Bun.file(join(dir, 'DevToolsActivePort'));
    if (!(await file.exists())) continue;
    const [port, path] = (await file.text()).split('\n').map((l) => l.trim());
    if (port && path) urls.push(`ws://127.0.0.1:${port}${path}`);
  }
  try {
    urls.push(await fromHttp('http://127.0.0.1:9222'));
  } catch {
    // no browser on the default port
  }
  return urls;
}

export const CONNECT_HELP =
  'No debuggable Chromium browser found. Fix one of: (1) open chrome://inspect/#remote-debugging in your browser and turn on "Allow remote debugging", then accept the prompt; ' +
  '(2) start the browser with --remote-debugging-port=9222 --user-data-dir=<dir>; (3) set CDP_URL to ws://… or http://host:port.';
