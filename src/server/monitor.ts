import type { CheckRecord, CheckTrigger, MonitorConfig, NotificationLog, ProductSpec, RuntimeStatus, StockStatus } from '../shared/types.js';
import { ConfigService } from './config.js';
import { Store } from './db.js';
import { logEvent } from './logger.js';
import { sendPushoverStockNotification, sendPushoverSummaryNotification, sendPushoverTestNotification, type NotificationDraft } from './pushover.js';
import { runStockCheck } from './stockChecker.js';

const lastSummarySentAtKey = 'lastSummarySentAt';

export class MonitorService {
  private timer: NodeJS.Timeout | null = null;
  private summaryTimer: NodeJS.Timeout | null = null;
  private nextRunAt: string | null = null;
  private checking = false;

  constructor(
    private store: Store,
    private configService: ConfigService
  ) {}

  restore(): void {
    const config = this.configService.getMonitorConfig();
    if (config.monitorEnabled) {
      this.start(false);
    }
  }

  start(runSoon = true): RuntimeStatus {
    const config = this.configService.getMonitorConfig();
    this.configService.setMonitorConfig({ ...config, monitorEnabled: true });
    this.schedule(runSoon ? 1000 : detectionIntervalMs(config));
    this.scheduleSummary();
    return this.status();
  }

  stop(): RuntimeStatus {
    if (this.timer) clearTimeout(this.timer);
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    this.timer = null;
    this.summaryTimer = null;
    this.nextRunAt = null;
    const config = this.configService.getMonitorConfig();
    this.configService.setMonitorConfig({ ...config, monitorEnabled: false });
    return this.status();
  }

  applyConfig(config: MonitorConfig): RuntimeStatus {
    const saved = this.configService.setMonitorConfig(config);
    if (saved.monitorEnabled) {
      this.schedule(detectionIntervalMs(saved));
      this.scheduleSummary();
    } else {
      this.stop();
    }
    return this.status();
  }

  async runOnce(): Promise<CheckRecord> {
    return this.executeCheck('manual');
  }

  async sendPushoverNotificationTest(config: MonitorConfig): Promise<{ sent: number }> {
    const results = await sendPushoverTestNotification(config);
    this.persistNotifications(results);
    return notificationCounts(results);
  }

  status(): RuntimeStatus {
    const lastCheck = this.store.latestCheck();
    return {
      running: this.configService.getMonitorConfig().monitorEnabled,
      checking: this.checking,
      nextRunAt: this.nextRunAt,
      lastStatus: this.store.getJson<StockStatus | null>('lastStockStatus', null),
      lastCheck,
      stats: this.store.stats()
    };
  }

  private schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    const delay = Math.max(1000, delayMs);
    this.nextRunAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      void this.executeCheck('scheduled').finally(() => {
        const config = this.configService.getMonitorConfig();
        if (config.monitorEnabled) {
          this.schedule(detectionIntervalMs(config));
        }
      });
    }, delay);
  }

  private scheduleSummary(): void {
    if (this.summaryTimer) clearTimeout(this.summaryTimer);
    const config = this.configService.getMonitorConfig();
    if (!config.monitorEnabled || !config.summary.enabled) return;
    const delay = delayUntilNextSummary(new Date(), config.summary.times);
    this.summaryTimer = setTimeout(() => {
      void this.sendSummary().finally(() => this.scheduleSummary());
    }, delay);
  }

  private async executeCheck(trigger: CheckTrigger): Promise<CheckRecord> {
    if (this.checking) {
      const latest = this.store.latestCheck();
      if (latest) return latest;
      throw new Error('检测正在运行');
    }
    this.checking = true;
    try {
      const config = this.configService.getMonitorConfig();
      const result = await runStockCheck(config);
      const record = this.store.insertCheck({
        timestamp: new Date().toISOString(),
        status: result.status,
        trigger,
        durationMs: result.durationMs,
        detail: result.detail,
        error: result.error
      });
      await this.handleStatusTransition(record);
      await this.handleStockNotification(record, config);
      logEvent('check', { status: record.status, checkId: record.id, error: record.error });
      return record;
    } finally {
      this.checking = false;
    }
  }

  private async handleStatusTransition(record: CheckRecord): Promise<void> {
    if (record.status === 'unknown' || record.status === 'error') return;
    const previous = this.store.getJson<StockStatus | null>('lastStockStatus', null);
    if (previous !== record.status) {
      this.store.insertStockEvent({
        timestamp: record.timestamp,
        fromStatus: previous,
        toStatus: record.status
      });
    }
    this.store.setJson('lastStockStatus', record.status);
  }

  private async handleStockNotification(record: CheckRecord, config: MonitorConfig): Promise<void> {
    if (record.status !== 'in_stock') return;
    try {
      const results = await sendPushoverStockNotification(config, record);
      this.persistNotifications(results);
      const counts = notificationCounts(results);
      logEvent(results.length > 0 ? 'pushover' : 'pushover_skipped', { checkId: record.id, sent: counts.success, failed: counts.failed });
    } catch (error) {
      logEvent('pushover_error', {
        checkId: record.id,
        message: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async sendSummary(): Promise<void> {
    const config = this.configService.getMonitorConfig();
    if (!config.monitorEnabled || !config.summary.enabled) return;
    const now = new Date();
    const dayStart = startOfDay(now);
    const lastSummaryAt = new Date(this.store.getJson<string | null>(lastSummarySentAtKey, null) ?? dayStart.toISOString());
    const incrementSince = lastSummaryAt > dayStart && lastSummaryAt < now ? lastSummaryAt : dayStart;
    const dailyStats = this.store.checkStatsSince(dayStart.toISOString());
    const incrementStats = this.store.checkStatsSince(incrementSince.toISOString());
    const message = buildSummaryMessage(dayStart, incrementSince, now, dailyStats, incrementStats, config);
    const results = await sendPushoverSummaryNotification(config, message);
    this.persistNotifications(results);
    const counts = notificationCounts(results);
    if (counts.success > 0) {
      this.store.setJson(lastSummarySentAtKey, now.toISOString());
    }
    logEvent(results.length > 0 ? 'pushover_summary' : 'pushover_summary_skipped', { sent: counts.success, failed: counts.failed, checks: dailyStats.total, incrementChecks: incrementStats.total });
  }

  private persistNotifications(results: NotificationDraft[]): NotificationLog[] {
    const timestamp = new Date().toISOString();
    return results.map((result) => this.store.insertNotification({ ...result, timestamp }));
  }
}

function notificationCounts(results: NotificationDraft[]): { sent: number; success: number; failed: number } {
  const success = results.filter((item) => item.success).length;
  const failed = results.length - success;
  return { sent: success, success, failed };
}

function detectionIntervalMs(config: MonitorConfig, now = new Date()): number {
  return currentIntervalMinutes(config, now) * 60 * 1000;
}

function currentIntervalMinutes(config: MonitorConfig, now: Date): number {
  return isWorkTime(config.schedule, now) ? config.schedule.workIntervalMinutes : config.schedule.offWorkIntervalMinutes;
}

function isWorkTime(schedule: MonitorConfig['schedule'], now: Date): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutesFromTime(schedule.workStartTime);
  const end = minutesFromTime(schedule.workEndTime);
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

function minutesFromTime(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function delayUntilNextSummary(now: Date, times: string[]): number {
  const next = nextSummaryTime(now, times);
  return Math.max(1000, next.getTime() - now.getTime());
}

function nextSummaryTime(now: Date, times: string[]): Date {
  return times
    .map((time) => {
      const candidate = new Date(now);
      const [hour, minute] = time.split(':').map(Number);
      candidate.setHours(hour, minute, 0, 0);
      if (candidate <= now) candidate.setDate(candidate.getDate() + 1);
      return candidate;
    })
    .sort((left, right) => left.getTime() - right.getTime())[0];
}

function startOfDay(date: Date): Date {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

type SummaryStats = { total: number; success: number; failed: number; inStock: number; outOfStock: number };

function buildSummaryMessage(
  dayStart: Date,
  incrementSince: Date,
  now: Date,
  dailyStats: SummaryStats,
  incrementStats: SummaryStats,
  config: MonitorConfig
): string {
  const spec = formatSpec(config.expectedSpec);
  const purchaseUrl = config.targetUrl;
  const dailyPeriod = `${formatTime(dayStart)} - ${formatTime(now)}`;
  const incrementPeriod = `${formatTime(incrementSince)} - ${formatTime(now)}`;
  const variant = now.getHours() % 3;
  if (variant === 0) {
    return [
      'Mac Studio 服务状态总结',
      `发送时间：${formatTime(now)}`,
      `型号配置：${spec}`,
      `购买地址：${purchaseUrl}`,
      `今日累计：执行 ${dailyStats.total} 次，成功 ${dailyStats.success} 次，失败 ${dailyStats.failed} 次，有货 ${dailyStats.inStock} 次，无货 ${dailyStats.outOfStock} 次`,
      `上次总结后：执行 ${incrementStats.total} 次，成功 ${incrementStats.success} 次，失败 ${incrementStats.failed} 次，有货 ${incrementStats.inStock} 次，无货 ${incrementStats.outOfStock} 次`
    ].join('\n');
  }
  if (variant === 1) {
    return [
      '库存监控心跳',
      `型号配置：${spec}`,
      `购买地址：${purchaseUrl}`,
      `今日窗口：${dailyPeriod}`,
      `今日检测：${dailyStats.total} 次，成功/失败 ${dailyStats.success}/${dailyStats.failed}，有货/无货 ${dailyStats.inStock}/${dailyStats.outOfStock}`,
      `增量窗口：${incrementPeriod}`,
      `增量检测：${incrementStats.total} 次，成功/失败 ${incrementStats.success}/${incrementStats.failed}，有货/无货 ${incrementStats.inStock}/${incrementStats.outOfStock}`
    ].join('\n');
  }
  return [
    'Mac Studio 监控服务仍在运行',
    `发送时间：${formatTime(now)}`,
    `型号配置：${spec}`,
    `今日累计统计：${dailyPeriod}`,
    `执行 ${dailyStats.total} 次；成功 ${dailyStats.success} 次；失败 ${dailyStats.failed} 次；有货 ${dailyStats.inStock} 次；无货 ${dailyStats.outOfStock} 次`,
    `上次总结后统计：${incrementPeriod}`,
    `执行 ${incrementStats.total} 次；成功 ${incrementStats.success} 次；失败 ${incrementStats.failed} 次；有货 ${incrementStats.inStock} 次；无货 ${incrementStats.outOfStock} 次`,
    `购买地址：${purchaseUrl}`
  ].join('\n');
}

function formatTime(date: Date): string {
  return date.toLocaleString('zh-CN', { hour12: false });
}

function formatSpec(spec?: ProductSpec): string {
  return spec ? [spec.chip, spec.cpu, spec.gpu, spec.memory, spec.storage].join(' / ') : '暂无配置';
}
