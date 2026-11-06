/**
 * Tiny node:http helpers. Duplicated from agent/src/http.ts on purpose: each
 * folder in this repo must stand alone, because the owner's agent merges them
 * separately into the real codebase.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    ...headers,
  });
  res.end(payload);
}

export async function readBody(req: IncomingMessage, limitBytes = 256 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limitBytes) throw new Error('request body too large');
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseJson(raw: string): unknown {
  if (!raw.trim()) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

export const log = {
  info: (msg: string, extra?: Record<string, unknown>) =>
    console.log(JSON.stringify({ level: 'info', msg, ...extra })),
  warn: (msg: string, extra?: Record<string, unknown>) =>
    console.warn(JSON.stringify({ level: 'warn', msg, ...extra })),
  error: (msg: string, extra?: Record<string, unknown>) =>
    console.error(JSON.stringify({ level: 'error', msg, ...extra })),
};
