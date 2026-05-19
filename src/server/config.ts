import type { MonitorConfig, ProductSpec } from '../shared/types.js';
import { defaultSpec, normalizeSpecToOptions, productNameFromSpec, specKeywords, urlFromSpec } from '../shared/options.js';
import { Store } from './db.js';

const monitorDefaults: MonitorConfig = {
  targetUrl: urlFromSpec(defaultSpec()),
  productName: productNameFromSpec(defaultSpec()),
  keywords: specKeywords(defaultSpec()),
  checkIntervalMinutes: 5,
  schedule: {
    workStartTime: '09:00',
    workEndTime: '18:00',
    workIntervalMinutes: 5,
    offWorkIntervalMinutes: 10
  },
  summary: {
    enabled: true,
    times: ['09:05', '14:05', '22:05']
  },
  monitorEnabled: false,
  chromeHeadless: true,
  expectedSpec: defaultSpec(),
  pushover: {
    enabled: false,
    apiToken: '',
    recipients: [],
    sendsPerRecipient: 1,
    retrySeconds: 60,
    expireSeconds: 3600
  }
};

export class ConfigService {
  constructor(private store: Store) {}

  getMonitorConfig(): MonitorConfig {
    return normalizeMonitorConfig(this.store.getJson('monitorConfig', monitorDefaults));
  }

  setMonitorConfig(config: MonitorConfig): MonitorConfig {
    const normalized = normalizeMonitorConfig(config);
    this.store.setJson('monitorConfig', normalized);
    return normalized;
  }
}

function normalizeMonitorConfig(input: MonitorConfig): MonitorConfig {
  const legacyPushover = input.pushover as MonitorConfig['pushover'] & { userKey?: string } | undefined;
  const expectedSpec = normalizeSpecToOptions(normalizeSpec(input.expectedSpec ?? specFromUrl(input.targetUrl) ?? specFromKeywords(input.keywords)) ?? defaultSpec());
  const keywords = specKeywords(expectedSpec);
  const schedule = normalizeSchedule(input);
  const summary = normalizeSummary(input);
  const pushoverRecipients = normalizePushoverRecipients([
    ...(Array.isArray(legacyPushover?.recipients) ? legacyPushover.recipients : []),
    legacyPushover?.userKey ?? ''
  ]);
  return {
    targetUrl: urlFromSpec(expectedSpec),
    productName: productNameFromSpec(expectedSpec),
    keywords,
    checkIntervalMinutes: currentIntervalMinutes(schedule, new Date()),
    schedule,
    summary,
    monitorEnabled: Boolean(input.monitorEnabled),
    chromeHeadless: true,
    expectedSpec,
    pushover: {
      enabled: Boolean(input.pushover?.enabled),
      apiToken: String(input.pushover?.apiToken ?? '').trim(),
      recipients: pushoverRecipients,
      sendsPerRecipient: clamp(Number(input.pushover?.sendsPerRecipient || monitorDefaults.pushover.sendsPerRecipient), 1, 5),
      retrySeconds: clamp(Number(input.pushover?.retrySeconds || monitorDefaults.pushover.retrySeconds), 30, 3600),
      expireSeconds: clamp(Number(input.pushover?.expireSeconds || monitorDefaults.pushover.expireSeconds), 300, 86400)
    }
  };
}

function normalizeSchedule(input: MonitorConfig) {
  const legacyInterval = clamp(Number(input.checkIntervalMinutes || monitorDefaults.checkIntervalMinutes), 1, 1440);
  const raw = input.schedule;
  return {
    workStartTime: normalizeTime(raw?.workStartTime, monitorDefaults.schedule.workStartTime),
    workEndTime: normalizeTime(raw?.workEndTime, monitorDefaults.schedule.workEndTime),
    workIntervalMinutes: clamp(Number(raw?.workIntervalMinutes || legacyInterval || monitorDefaults.schedule.workIntervalMinutes), 1, 1440),
    offWorkIntervalMinutes: clamp(Number(raw?.offWorkIntervalMinutes || monitorDefaults.schedule.offWorkIntervalMinutes), 1, 1440)
  };
}

function normalizeTime(value: unknown, fallback: string): string {
  const match = String(value || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return fallback;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour > 23 || minute < 0 || minute > 59) return fallback;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function normalizeSummary(input: MonitorConfig) {
  const raw = input.summary;
  const times = Array.isArray(raw?.times)
    ? raw.times.map((item) => normalizeTime(item, '')).filter(Boolean)
    : monitorDefaults.summary.times;
  const uniqueTimes = [...new Set(times)].sort();
  return {
    enabled: raw?.enabled !== false,
    times: uniqueTimes.length > 0 ? uniqueTimes.slice(0, 6) : monitorDefaults.summary.times
  };
}

function currentIntervalMinutes(schedule: MonitorConfig['schedule'], now: Date): number {
  return isWorkTime(schedule, now) ? schedule.workIntervalMinutes : schedule.offWorkIntervalMinutes;
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

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

function normalizeSpec(input?: ProductSpec | null): ProductSpec | undefined {
  if (!input) return undefined;
  const spec = {
    chip: String(input.chip || '').trim(),
    cpu: normalizeCore(input.cpu),
    gpu: normalizeCore(input.gpu),
    memory: normalizeCapacity(input.memory),
    storage: normalizeCapacity(input.storage)
  };
  return spec.chip && spec.cpu && spec.gpu && spec.memory && spec.storage ? spec : undefined;
}

function specFromUrl(url: string): ProductSpec | undefined {
  const lower = String(url || '').toLowerCase();
  const chip = lower.includes('m3-ultra') ? 'M3 Ultra' : lower.includes('m4-max') ? 'M4 Max' : '';
  const cpu = lower.match(/(\d+)-core-cpu/)?.[1];
  const gpu = lower.match(/(\d+)-core-gpu/)?.[1];
  const memory = lower.match(/(\d+)(gb|tb)-memory/);
  const storage = lower.match(/(\d+)(gb|tb)-storage/);
  if (!chip || !cpu || !gpu || !memory || !storage) return undefined;
  return {
    chip,
    cpu: `${cpu}核`,
    gpu: `${gpu}核`,
    memory: `${memory[1]}${memory[2].toUpperCase()}`,
    storage: `${storage[1]}${storage[2].toUpperCase()}`
  };
}

function specFromKeywords(keywords: string[]): ProductSpec | undefined {
  if (!Array.isArray(keywords)) return undefined;
  const joined = keywords.join(' ');
  const chip = joined.includes('M3 Ultra') ? 'M3 Ultra' : joined.includes('M4 Max') ? 'M4 Max' : '';
  const cores = keywords.map(normalizeCore).filter(Boolean);
  const capacities = keywords.map(normalizeCapacity).filter(Boolean);
  if (!chip || cores.length < 2 || capacities.length < 2) return undefined;
  return {
    chip,
    cpu: cores[0],
    gpu: cores[1],
    memory: capacities[0],
    storage: capacities[1]
  };
}

function normalizeCore(value: unknown): string {
  const match = String(value || '').match(/(\d+)\s*核/);
  return match ? `${match[1]}核` : '';
}

function normalizeCapacity(value: unknown): string {
  const match = String(value || '').match(/(\d+)\s*(GB|TB)/i);
  return match ? `${match[1]}${match[2].toUpperCase()}` : '';
}

function normalizePushoverRecipients(value: unknown[]): string[] {
  if (!Array.isArray(value)) return [];
  const unique = new Set<string>();
  for (const raw of value) {
    const normalized = normalizePushoverRecipient(raw);
    if (normalized) unique.add(normalized);
  }
  return [...unique].slice(0, 20);
}

function normalizePushoverRecipient(value: unknown): string {
  const text = String(value || '').trim();
  if (!text) return '';
  return /^\S+$/.test(text) ? text : '';
}
