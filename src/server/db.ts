import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dataDir, dbPath, logsDir, screenshotsDir, chromeProfileDir } from './paths.js';
import type { CheckDetail, CheckRecord, CheckTrigger, NotificationLog, NotificationSummary, NotificationType, StockEvent, StockStatus } from '../shared/types.js';

type SettingRow = { key: string; value: string };
const historyLimit = 100;

export class Store {
  private db: DatabaseSync;

  constructor() {
    for (const dir of [dataDir, logsDir, screenshotsDir, chromeProfileDir]) {
      fs.mkdirSync(dir, { recursive: true });
    }
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS check_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        status TEXT NOT NULL,
        trigger TEXT NOT NULL DEFAULT 'manual',
        duration_ms INTEGER NOT NULL,
        detail_json TEXT NOT NULL,
        error TEXT
      );

      CREATE TABLE IF NOT EXISTS stock_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS notification_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        check_id INTEGER,
        timestamp TEXT NOT NULL,
        type TEXT NOT NULL,
        recipient TEXT NOT NULL,
        message TEXT NOT NULL,
        success INTEGER NOT NULL,
        error TEXT
      );
    `);
    this.ensureColumn('check_history', 'trigger', "TEXT NOT NULL DEFAULT 'manual'");
    this.pruneHistory();
  }

  getJson<T>(key: string, fallback: T): T {
    const row = this.db.prepare('SELECT key, value FROM settings WHERE key = ?').get(key) as SettingRow | undefined;
    if (!row) return fallback;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return fallback;
    }
  }

  setJson(key: string, value: unknown): void {
    this.db
      .prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value));
  }

  insertCheck(input: {
    timestamp: string;
    status: StockStatus;
    trigger: CheckTrigger;
    durationMs: number;
    detail: CheckDetail;
    error?: string;
  }): CheckRecord {
    const result = this.db
      .prepare('INSERT INTO check_history (timestamp, status, trigger, duration_ms, detail_json, error) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.timestamp, input.status, input.trigger, input.durationMs, JSON.stringify(input.detail), input.error ?? null);
    this.pruneHistory();
    return {
      id: Number(result.lastInsertRowid),
      timestamp: input.timestamp,
      status: input.status,
      trigger: input.trigger,
      durationMs: input.durationMs,
      detail: input.detail,
      error: input.error
    };
  }

  insertStockEvent(input: Omit<StockEvent, 'id'>): StockEvent {
    const result = this.db
      .prepare('INSERT INTO stock_events (timestamp, from_status, to_status) VALUES (?, ?, ?)')
      .run(input.timestamp, input.fromStatus ?? null, input.toStatus);
    this.pruneStockEvents();
    return { ...input, id: Number(result.lastInsertRowid) };
  }

  insertNotification(input: Omit<NotificationLog, 'id'>): NotificationLog {
    const result = this.db
      .prepare('INSERT INTO notification_logs (check_id, timestamp, type, recipient, message, success, error) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(input.checkId, input.timestamp, input.type, input.recipient, input.message, input.success ? 1 : 0, input.error ?? null);
    this.pruneNotificationLogs();
    return { ...input, id: Number(result.lastInsertRowid) };
  }

  latestCheck(): CheckRecord | null {
    const row = this.db.prepare('SELECT * FROM check_history ORDER BY id DESC LIMIT 1').get() as DbCheckRow | undefined;
    return row ? mapCheckRow(row) : null;
  }

  checks(limit = 100): CheckRecord[] {
    const rows = this.db.prepare('SELECT * FROM check_history ORDER BY id DESC LIMIT ?').all(Math.min(limit, historyLimit)) as DbCheckRow[];
    return rows.map((row) => ({ ...mapCheckRow(row), notificationSummary: this.notificationSummaryForCheck(row.id) }));
  }

  events(limit = 100): StockEvent[] {
    const rows = this.db.prepare('SELECT * FROM stock_events ORDER BY id DESC LIMIT ?').all(Math.min(limit, historyLimit)) as DbEventRow[];
    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      fromStatus: (row.from_status as StockStatus | null) ?? null,
      toStatus: row.to_status as StockStatus
    }));
  }

  notificationsForCheck(checkId: number): NotificationLog[] {
    const rows = this.db.prepare('SELECT * FROM notification_logs WHERE check_id = ? ORDER BY id ASC').all(checkId) as DbNotificationRow[];
    return rows.map(mapNotificationRow);
  }

  checkStatsSince(sinceIso: string) {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN status != 'error' THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS failed,
          SUM(CASE WHEN status = 'in_stock' THEN 1 ELSE 0 END) AS inStock,
          SUM(CASE WHEN status = 'out_of_stock' THEN 1 ELSE 0 END) AS outOfStock
        FROM check_history
        WHERE timestamp >= ?
        AND trigger = 'scheduled'`
      )
      .get(sinceIso) as { total: number; success: number | null; failed: number | null; inStock: number | null; outOfStock: number | null };
    return {
      total: row.total,
      success: row.success ?? 0,
      failed: row.failed ?? 0,
      inStock: row.inStock ?? 0,
      outOfStock: row.outOfStock ?? 0
    };
  }

  stats() {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) AS checksTotal,
          SUM(CASE WHEN status != 'error' THEN 1 ELSE 0 END) AS checksSuccess,
          SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS checksError,
          SUM(CASE WHEN status = 'in_stock' THEN 1 ELSE 0 END) AS inStockCount,
          SUM(CASE WHEN status = 'out_of_stock' THEN 1 ELSE 0 END) AS outOfStockCount
        FROM check_history`
      )
      .get() as { checksTotal: number; checksSuccess: number | null; checksError: number | null; inStockCount: number | null; outOfStockCount: number | null };

    return {
      checksTotal: row.checksTotal,
      checksSuccess: row.checksSuccess ?? 0,
      checksError: row.checksError ?? 0,
      inStockCount: row.inStockCount ?? 0,
      outOfStockCount: row.outOfStockCount ?? 0
    };
  }

  private pruneHistory(): void {
    const rows = this.db
      .prepare(
        `SELECT id, detail_json
         FROM check_history
         WHERE id NOT IN (
           SELECT id FROM check_history ORDER BY id DESC LIMIT ?
         )`
      )
      .all(historyLimit) as Array<{ id: number; detail_json: string }>;

    for (const row of rows) {
      removeScreenshot(row.detail_json);
    }

    this.db
      .prepare(
        `DELETE FROM check_history
         WHERE id NOT IN (
           SELECT id FROM check_history ORDER BY id DESC LIMIT ?
         )`
      )
      .run(historyLimit);
    this.db
      .prepare(
        `DELETE FROM notification_logs
         WHERE check_id IS NOT NULL
         AND check_id NOT IN (
           SELECT id FROM check_history
         )`
      )
      .run();
    this.pruneStockEvents();
    this.pruneNotificationLogs();
  }

  private pruneStockEvents(): void {
    this.db
      .prepare(
        `DELETE FROM stock_events
         WHERE id NOT IN (
           SELECT id FROM stock_events ORDER BY id DESC LIMIT ?
         )`
      )
      .run(historyLimit);
  }

  private pruneNotificationLogs(): void {
    this.db
      .prepare(
        `DELETE FROM notification_logs
         WHERE check_id IS NULL
         AND id NOT IN (
           SELECT id FROM notification_logs WHERE check_id IS NULL ORDER BY id DESC LIMIT ?
         )`
      )
      .run(historyLimit);
  }

  private notificationSummaryForCheck(checkId: number): NotificationSummary {
    const row = this.db
      .prepare(
        `SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) AS success,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS failed
        FROM notification_logs
        WHERE check_id = ?`
      )
      .get(checkId) as { total: number; success: number | null; failed: number | null };
    return {
      total: row.total,
      success: row.success ?? 0,
      failed: row.failed ?? 0
    };
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    const columns = this.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (columns.some((item) => item.name === column)) return;
    this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

type DbCheckRow = {
  id: number;
  timestamp: string;
  status: StockStatus;
  trigger: CheckTrigger;
  duration_ms: number;
  detail_json: string;
  error: string | null;
};

type DbEventRow = {
  id: number;
  timestamp: string;
  from_status: string | null;
  to_status: string;
};

type DbNotificationRow = {
  id: number;
  check_id: number | null;
  timestamp: string;
  type: string;
  recipient: string;
  message: string;
  success: number;
  error: string | null;
};

function mapCheckRow(row: DbCheckRow): CheckRecord {
  return {
    id: row.id,
    timestamp: row.timestamp,
    status: row.status,
    trigger: row.trigger ?? 'manual',
    durationMs: row.duration_ms,
    detail: JSON.parse(row.detail_json) as CheckDetail,
    error: row.error ?? undefined
  };
}

function mapNotificationRow(row: DbNotificationRow): NotificationLog {
  return {
    id: row.id,
    checkId: row.check_id,
    timestamp: row.timestamp,
    type: row.type as NotificationType,
    recipient: row.recipient,
    message: row.message,
    success: Boolean(row.success),
    error: row.error ?? undefined
  };
}

function removeScreenshot(detailJson: string): void {
  try {
    const detail = JSON.parse(detailJson) as CheckDetail;
    if (detail.screenshotPath?.startsWith(screenshotsDir)) {
      fs.rmSync(detail.screenshotPath, { force: true });
    }
  } catch {
    // Ignore malformed historical rows; the database cleanup should continue.
  }
}
