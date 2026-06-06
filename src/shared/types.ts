export type StockStatus = 'in_stock' | 'out_of_stock' | 'unknown' | 'error';
export type CheckTrigger = 'manual' | 'scheduled';

export interface MonitorConfig {
  targetUrl: string;
  productName: string;
  keywords: string[];
  checkIntervalMinutes: number;
  schedule: DetectionSchedule;
  summary: SummaryConfig;
  monitorEnabled: boolean;
  chromeHeadless: boolean;
  expectedSpec?: ProductSpec;
  pushover: PushoverConfig;
}

export interface DetectionSchedule {
  workStartTime: string;
  workEndTime: string;
  workIntervalMinutes: number;
  offWorkIntervalMinutes: number;
}

export interface SummaryConfig {
  enabled: boolean;
  times: string[];
}

export interface PushoverConfig {
  enabled: boolean;
  apiToken: string;
  recipients: string[];
  sendsPerRecipient: number;
  retrySeconds: number;
  expireSeconds: number;
}

export interface ProductSpec {
  chip: string;
  cpu: string;
  gpu: string;
  memory: string;
  storage: string;
}

export interface CheckDetail {
  expectedSpec?: ProductSpec;
  matchedKeywords: string[];
  missingKeywords: string[];
  availableSignals: string[];
  unavailableSignals: string[];
  decisionReasons?: string[];
  summaryText?: string;
  summaryMatched?: boolean;
  finalUrlMatched?: boolean;
  requiredChoiceApplied?: boolean;
  continueEnabled?: boolean;
  pageTitle?: string;
  finalUrl?: string;
  screenshotPath?: string;
}

export interface CheckRecord {
  id: number;
  timestamp: string;
  status: StockStatus;
  durationMs: number;
  trigger: CheckTrigger;
  detail: CheckDetail;
  error?: string;
  notificationSummary?: NotificationSummary;
}

export interface StockEvent {
  id: number;
  timestamp: string;
  fromStatus: StockStatus | null;
  toStatus: StockStatus;
}

export interface RuntimeStatus {
  running: boolean;
  checking: boolean;
  nextRunAt: string | null;
  lastStatus: StockStatus | null;
  lastCheck: CheckRecord | null;
  stats: {
    checksTotal: number;
    checksSuccess: number;
    checksError: number;
    inStockCount: number;
    outOfStockCount: number;
  };
}

export interface HistoryResponse {
  checks: CheckRecord[];
  events: StockEvent[];
}

export type NotificationType = 'stock' | 'summary' | 'test' | 'failure';

export interface NotificationLog {
  id: number;
  checkId: number | null;
  timestamp: string;
  type: NotificationType;
  recipient: string;
  message: string;
  success: boolean;
  error?: string;
}

export interface NotificationSummary {
  total: number;
  success: number;
  failed: number;
}

export interface NotificationDetailResponse {
  notifications: NotificationLog[];
}
