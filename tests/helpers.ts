import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MOCK_REPO = path.resolve(HERE, '../../track-api-mock');
export const FIXTURES = path.join(MOCK_REPO, 'fixtures');

let child: ChildProcess | null = null;

export async function startServer(port: number, calm: boolean): Promise<string> {
  child = spawn(process.execPath, [path.join(MOCK_REPO, 'server.js')], {
    env: { ...process.env, PORT: String(port), FIXTURES, ...(calm ? { SM_CALM: '1' } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) {
    try {
      const r = await fetch(`${base}/v1/health`);
      if (r.ok) return base;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('mock server did not start');
}

export function stopServer() {
  child?.kill('SIGKILL');
  child = null;
}
