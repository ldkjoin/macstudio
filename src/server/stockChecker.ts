import path from 'node:path';
import { chromium, type Page } from 'playwright-core';
import type { CheckDetail, MonitorConfig, ProductSpec, StockStatus } from '../shared/types.js';
import { specKeywords } from '../shared/options.js';
import { chromeProfileDir, screenshotsDir } from './paths.js';

export interface StockCheckResult {
  status: StockStatus;
  detail: CheckDetail;
  durationMs: number;
  error?: string;
}

export async function runStockCheck(config: MonitorConfig): Promise<StockCheckResult> {
  const started = Date.now();
  const expectedSpec = config.expectedSpec ?? specFromUrl(config.targetUrl);
  const detail: CheckDetail = {
    expectedSpec,
    matchedKeywords: [],
    missingKeywords: [],
    availableSignals: [],
    unavailableSignals: [],
    decisionReasons: []
  };

  let context;
  try {
    context = await chromium.launchPersistentContext(chromeProfileDir, {
      channel: 'chrome',
      headless: true,
      viewport: { width: 1440, height: 1200 },
      locale: 'zh-CN',
      args: ['--disable-notifications']
    });
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(config.targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(() => undefined);

    detail.pageTitle = await page.title().catch(() => undefined);
    detail.finalUrl = page.url();
    detail.finalUrlMatched = isExactConfigUrl(config.targetUrl, detail.finalUrl);

    const bodyText = await page.locator('body').innerText({ timeout: 15000 });
    const normalizedBody = normalizeSpaces(bodyText);
    const summaryText = extractSummary(normalizedBody);
    detail.summaryText = summaryText;
    detail.summaryMatched = Boolean(summaryText);

    const expectedKeywords = expectedSpec ? specKeywords(expectedSpec) : config.keywords;
    const comparableSummary = normalizeComparable(summaryText);
    detail.matchedKeywords = expectedKeywords.filter((keyword) => comparableSummary.includes(normalizeComparable(keyword)));
    detail.missingKeywords = expectedKeywords.filter((keyword) => !comparableSummary.includes(normalizeComparable(keyword)));

    if (!detail.finalUrlMatched) {
      detail.decisionReasons?.push('最终 URL 回退到通用购买页，目标精确配置页不可用。');
      detail.unavailableSignals.push('final-url-mismatch');
    }
    if (!summaryText) {
      detail.decisionReasons?.push('页面没有出现“你的新 Mac Studio”目标配置汇总。');
      detail.unavailableSignals.push('summary-missing');
    }
    if (detail.missingKeywords.length > 0) {
      detail.decisionReasons?.push(`目标配置汇总缺失：${detail.missingKeywords.join('、')}`);
      detail.unavailableSignals.push('summary-spec-mismatch');
    }

    detail.requiredChoiceApplied = await chooseNoTradeIn(page);
    if (detail.requiredChoiceApplied) {
      detail.availableSignals.push('已选择“不折抵换购”');
    } else {
      detail.decisionReasons?.push('未能确认必选项“不折抵换购”。');
      detail.unavailableSignals.push('required-choice-not-applied');
    }

    detail.continueEnabled = await isContinueEnabled(page);
    if (detail.continueEnabled) {
      detail.availableSignals.push('继续按钮可点击');
    } else {
      detail.decisionReasons?.push('继续按钮不可点击。');
      detail.unavailableSignals.push('continue-disabled');
    }

    const screenshotPath = path.join(screenshotsDir, `check-${Date.now()}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false }).catch(() => undefined);
    detail.screenshotPath = screenshotPath;

    const status = decideStatus(detail);
    if (status === 'in_stock') {
      detail.decisionReasons?.push('目标精确配置页、配置汇总和购买流程 CTA 均验证通过。');
    }
    return { status, detail, durationMs: Date.now() - started };
  } catch (error) {
    return {
      status: 'error',
      detail,
      durationMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    await context?.close().catch(() => undefined);
  }
}

function decideStatus(detail: CheckDetail): StockStatus {
  return detail.finalUrlMatched && detail.summaryMatched && detail.missingKeywords.length === 0 && detail.requiredChoiceApplied && detail.continueEnabled
    ? 'in_stock'
    : 'out_of_stock';
}

function isExactConfigUrl(targetUrl: string, finalUrl = ''): boolean {
  const target = normalizeUrlPath(targetUrl);
  const actual = normalizeUrlPath(finalUrl);
  return actual === target;
}

function normalizeUrlPath(value: string): string {
  try {
    const url = new URL(value);
    return url.pathname.replace(/\/$/, '').toLowerCase();
  } catch {
    return value.replace(/\/$/, '').toLowerCase();
  }
}

function extractSummary(text: string): string {
  const start = text.indexOf('你的新 Mac Studio');
  if (start < 0) return '';
  const endCandidates = ['还拿不定主意？', '包装内容', 'Specialist 专家'];
  const end = endCandidates
    .map((candidate) => text.indexOf(candidate, start))
    .filter((index) => index > start)
    .sort((a, b) => a - b)[0];
  return text.slice(start, end || start + 900);
}

async function chooseNoTradeIn(page: Page): Promise<boolean> {
  const noTradeIn = page.getByText('不折抵换购', { exact: true });
  const count = await noTradeIn.count().catch(() => 0);
  if (count === 0) return false;
  await noTradeIn.first().click({ timeout: 5000 }).catch(() => undefined);
  await page.waitForTimeout(800);
  return true;
}

async function isContinueEnabled(page: Page): Promise<boolean> {
  const buttons = page.locator('button').filter({ hasText: '继续' });
  const count = await buttons.count().catch(() => 0);
  if (count === 0) return false;
  return buttons.last().isEnabled().catch(() => false);
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

function normalizeSpaces(value: string): string {
  return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeComparable(value: string): string {
  return normalizeSpaces(value).replace(/\s+/g, '').toLowerCase();
}
