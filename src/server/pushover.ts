import type { CheckRecord, MonitorConfig, NotificationLog, ProductSpec } from '../shared/types.js';

export type NotificationDraft = Omit<NotificationLog, 'id' | 'timestamp'>;

const pushoverEndpoint = 'https://api.pushover.net/1/messages.json';
const pushoverRepeatDelayMs = 1000;

export async function sendPushoverStockNotification(config: MonitorConfig, record: CheckRecord): Promise<NotificationDraft[]> {
  if (!isPushoverReady(config)) return [];
  const message = buildStockMessage(record.detail.expectedSpec ?? config.expectedSpec, record.timestamp, config.targetUrl);
  return sendPushoverToRecipients(config, 'Mac Studio 检测到有货', message, 'stock', record.id, true, configuredSendCount(config));
}

export async function sendPushoverSummaryNotification(config: MonitorConfig, message: string): Promise<NotificationDraft[]> {
  if (!isPushoverReady(config)) return [];
  return sendPushoverToRecipients(config, 'Mac Studio 服务状态总结', message, 'summary', null, false);
}

export async function sendPushoverTestNotification(config: MonitorConfig): Promise<NotificationDraft[]> {
  if (!config.pushover.enabled) {
    throw new Error('请先启用 Pushover。');
  }
  if (!config.pushover.apiToken || config.pushover.recipients.length === 0) {
    throw new Error('请先配置 Pushover API Token 和至少一个接收人。');
  }
  const message = [
    'Mac Studio Pushover 测试通知',
    `型号配置：${formatSpec(config.expectedSpec)}`,
    `购买地址：${config.targetUrl}`,
    `发送时间：${formatDateTime(new Date())}`
  ].join('\n');
  return sendPushoverToRecipients(config, 'Mac Studio 通知测试', message, 'test', null, false, configuredSendCount(config));
}

function isPushoverReady(config: MonitorConfig): boolean {
  return Boolean(config.pushover.enabled && config.pushover.apiToken && config.pushover.recipients.length > 0);
}

async function sendPushoverToRecipients(
  config: MonitorConfig,
  title: string,
  message: string,
  type: NotificationDraft['type'],
  checkId: number | null,
  emergency: boolean,
  repeat = 1
): Promise<NotificationDraft[]> {
  const results: NotificationDraft[] = [];
  const sendCount = clampSendCount(repeat);
  for (const recipient of config.pushover.recipients) {
    for (let index = 0; index < sendCount; index += 1) {
      results.push(await sendPushover(
        config,
        recipient,
        sequenceTitle(title, index, sendCount),
        sequenceMessage(message, index, sendCount),
        type,
        checkId,
        emergency
      ));
      if (index < sendCount - 1) {
        await delay(pushoverRepeatDelayMs);
      }
    }
  }
  return results;
}

async function sendPushover(
  config: MonitorConfig,
  recipient: string,
  title: string,
  message: string,
  type: NotificationDraft['type'],
  checkId: number | null,
  emergency: boolean
): Promise<NotificationDraft> {
  try {
    const body = new URLSearchParams({
      token: config.pushover.apiToken,
      user: recipient,
      title,
      message,
      priority: emergency ? '2' : '0',
      url: config.targetUrl,
      url_title: '打开 Apple 购买页'
    });
    if (emergency) {
      body.set('retry', String(config.pushover.retrySeconds));
      body.set('expire', String(config.pushover.expireSeconds));
    }

    const response = await fetch(pushoverEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    });
    const data = await response.json().catch(() => ({})) as { errors?: string[] };
    if (!response.ok) {
      throw new Error(data.errors?.join('；') || `Pushover 请求失败：${response.status}`);
    }
    return { checkId, type, recipient, message, success: true };
  } catch (error) {
    return {
      checkId,
      type,
      recipient,
      message,
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

function buildStockMessage(spec: ProductSpec | undefined, timestamp: string, purchaseUrl: string): string {
  return [
    '检测到目标 Mac Studio 有货',
    `型号配置：${formatSpec(spec)}`,
    `检测时间：${formatDateTime(new Date(timestamp))}`,
    `购买地址：${purchaseUrl}`,
    '这是 Pushover emergency 强提醒，会重复提醒直到确认或过期。'
  ].join('\n');
}

function configuredSendCount(config: MonitorConfig): number {
  return clampSendCount(config.pushover.sendsPerRecipient);
}

function clampSendCount(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(1, Math.min(5, Math.floor(value)));
}

function sequenceTitle(title: string, index: number, total: number): string {
  return total > 1 ? `${title} ${index + 1}/${total}` : title;
}

function sequenceMessage(message: string, index: number, total: number): string {
  return total > 1 ? `${message}\n推送序号：${index + 1}/${total}` : message;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatSpec(spec?: ProductSpec): string {
  return spec ? [spec.chip, spec.cpu, spec.gpu, spec.memory, spec.storage].join(' / ') : '暂无配置';
}

function formatDateTime(date: Date): string {
  return date.toLocaleString('zh-CN', { hour12: false });
}
