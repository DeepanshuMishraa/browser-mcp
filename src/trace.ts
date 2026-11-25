// Logs every MCP tool call and its result to logs/<start time>.jsonl, so a test run can be reviewed afterwards.
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

const dir = join(import.meta.dir, '..', 'logs');
const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.jsonl`);
const started = new Map<string | number, { tool: string; args: unknown; at: number }>();

function write(entry: Record<string, unknown>) {
  mkdir(dir, { recursive: true })
    .then(() => appendFile(file, `${JSON.stringify(entry)}\n`))
    .catch(() => undefined);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/** Shorten tool output for the log: images become their size, long text is clipped. */
function summarize(content: unknown) {
  if (!Array.isArray(content)) return content;
  return content.map((c) => {
    if (!isRecord(c)) return c;
    if (c.type === 'image' && typeof c.data === 'string') return `[image ${Math.round((c.data.length * 3) / 4 / 1024)}KB]`;
    if (c.type === 'text' && typeof c.text === 'string') return c.text.length > 4000 ? `${c.text.slice(0, 4000)}… (${c.text.length} chars)` : c.text;
    return c;
  });
}

export function trace(transport: Transport) {
  const onmessage = transport.onmessage;
  transport.onmessage = (msg, extra) => {
    if ('method' in msg && msg.method === 'tools/call' && 'id' in msg && 'params' in msg && isRecord(msg.params)) {
      started.set(msg.id, { tool: String(msg.params.name), args: msg.params.arguments, at: performance.now() });
    }
    onmessage?.(msg, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = (msg, options) => {
    if (isRecord(msg) && 'id' in msg && (typeof msg.id === 'string' || typeof msg.id === 'number')) {
      const call = started.get(msg.id);
      if (call) {
        started.delete(msg.id);
        const result = 'result' in msg && isRecord(msg.result) ? msg.result : undefined;
        write({
          time: new Date().toISOString(),
          tool: call.tool,
          args: call.args,
          ms: Math.round(performance.now() - call.at),
          error: result?.isError === true || 'error' in msg,
          result: summarize(result?.content) ?? msg,
        });
      }
    }
    return send(msg, options);
  };
}
