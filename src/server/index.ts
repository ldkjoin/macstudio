import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createServer as createViteServer } from 'vite';
import { ConfigService } from './config.js';
import { Store } from './db.js';
import { MonitorService } from './monitor.js';
import { pidPath, rootDir } from './paths.js';
import type { MonitorConfig } from '../shared/types.js';
import { macStudioOptions } from '../shared/options.js';

const port = Number(process.env.PORT || 4873);
const host = '127.0.0.1';
const crashLogPath = path.join(rootDir, 'logs', 'crash.log');

function crashLog(message: string, error?: unknown) {
  fs.mkdirSync(path.dirname(crashLogPath), { recursive: true });
  const detail = error instanceof Error ? `${error.stack ?? error.message}` : error ? String(error) : '';
  fs.appendFileSync(crashLogPath, `[${new Date().toISOString()}] ${message}${detail ? `\n${detail}` : ''}\n`);
}

process.on('uncaughtException', (error) => {
  crashLog('uncaughtException', error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  crashLog('unhandledRejection', error);
  process.exit(1);
});

process.on('exit', (code) => {
  if (code !== 0) crashLog(`exit ${code}`);
});

const app = express();
const store = new Store();
const configService = new ConfigService(store);
const monitor = new MonitorService(store, configService);

app.use(express.json({ limit: '1mb' }));

app.get('/api/status', (_req, res) => res.json(monitor.status()));
app.get('/api/options', (_req, res) => res.json(macStudioOptions));
app.get('/api/config', (_req, res) => res.json(configService.getMonitorConfig()));
app.put('/api/config', (req, res) => {
  const current = monitor.status();
  if (current.running || current.checking) {
    res.status(409).json({ error: '请先停止定时检测任务，再修改检测配置。保存后后续检测会按新配置执行。' });
    return;
  }
  const input = req.body as MonitorConfig;
  const pushoverRecipients = Array.isArray(input.pushover?.recipients)
    ? input.pushover.recipients.map((item) => String(item || '').trim()).filter(Boolean)
    : [];
  if (input.pushover?.enabled && (!String(input.pushover.apiToken || '').trim() || pushoverRecipients.length === 0)) {
    res.status(400).json({ error: '启用 Pushover 时，请填写 API Token 并至少添加一个接收人。' });
    return;
  }
  res.json(monitor.applyConfig(req.body as MonitorConfig));
});
app.post('/api/monitor/start', (_req, res) => res.json(monitor.start(true)));
app.post('/api/monitor/stop', (_req, res) => res.json(monitor.stop()));
app.post('/api/notify/pushover-test', async (_req, res, next) => {
  try {
    const current = monitor.status();
    if (current.running || current.checking) {
      res.status(409).json({ error: '请先停止定时检测任务，再执行 Pushover 测试。' });
      return;
    }
    const config = configService.getMonitorConfig();
    if (!config.pushover.enabled) {
      res.status(400).json({ error: '请先启用 Pushover。' });
      return;
    }
    if (!config.pushover.apiToken || config.pushover.recipients.length === 0) {
      res.status(400).json({ error: '请先配置 Pushover API Token 和至少一个接收人。' });
      return;
    }
    res.json(await monitor.sendPushoverNotificationTest(config));
  } catch (error) {
    next(error);
  }
});
app.post('/api/check/run-once', async (_req, res, next) => {
  try {
    res.json(await monitor.runOnce());
  } catch (error) {
    next(error);
  }
});
app.get('/api/history', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 100)));
  res.json({
    checks: store.checks(limit),
    events: store.events(limit)
  });
});
app.get('/api/checks/:id/notifications', (req, res) => {
  const checkId = Number(req.params.id);
  if (!Number.isInteger(checkId) || checkId < 1) {
    res.status(400).json({ error: '检测记录 ID 无效。' });
    return;
  }
  res.json({ notifications: store.notificationsForCheck(checkId) });
});

app.use('/api', (_req, res) => {
  res.status(404).json({ error: '接口不存在' });
});

app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
});

if (process.env.NODE_ENV === 'production') {
  const staticDir = path.join(rootDir, 'dist/client');
  app.use(express.static(staticDir));
  app.get('*', (_req, res) => res.sendFile(path.join(staticDir, 'index.html')));
} else {
  const vite = await createViteServer({
    server: { middlewareMode: true },
    appType: 'spa',
    root: rootDir
  });
  app.use(vite.middlewares);
}

const server = app.listen(port, host, () => {
  fs.mkdirSync(path.dirname(pidPath), { recursive: true });
  fs.writeFileSync(pidPath, String(process.pid));
  monitor.restore();
  console.log(`Mac Studio 库存监控已启动：http://${host}:${port}`);
});

server.on('error', (error) => {
  crashLog('server error', error);
});

function shutdown() {
  monitor.stop();
  fs.rmSync(pidPath, { force: true });
  server.close(() => process.exit(0));
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
