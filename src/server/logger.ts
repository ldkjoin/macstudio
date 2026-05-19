import fs from 'node:fs';
import path from 'node:path';
import { logsDir } from './paths.js';

export function logEvent(event: string, payload: Record<string, unknown>): void {
  fs.mkdirSync(logsDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  const line = JSON.stringify({ timestamp: new Date().toISOString(), event, ...payload }) + '\n';
  fs.appendFileSync(path.join(logsDir, `${day}.log`), line);
  cleanupOldLogs();
}

function cleanupOldLogs(): void {
  const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
  for (const file of fs.readdirSync(logsDir)) {
    if (!file.endsWith('.log')) continue;
    const fullPath = path.join(logsDir, file);
    const stat = fs.statSync(fullPath);
    if (stat.mtimeMs < cutoff) {
      fs.rmSync(fullPath, { force: true });
    }
  }
}
