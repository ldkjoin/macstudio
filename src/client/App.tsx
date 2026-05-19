import { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Minus, Moon, Pause, Play, Plus, RotateCw, Save, Sun, X, XCircle } from 'lucide-react';
import { createRoot } from 'react-dom/client';
import type { ChipOption } from '../shared/options.js';
import type { CheckRecord, HistoryResponse, MonitorConfig, NotificationDetailResponse, NotificationLog, ProductSpec, RuntimeStatus, StockStatus } from '../shared/types.js';
import './styles.css';

type Theme = 'light' | 'dark';

const emptyStatus: RuntimeStatus = {
  running: false,
  checking: false,
  nextRunAt: null,
  lastStatus: null,
  lastCheck: null,
  stats: {
    checksTotal: 0,
    checksSuccess: 0,
    checksError: 0,
    inStockCount: 0,
    outOfStockCount: 0
  }
};

function App() {
  const [theme, setTheme] = useState<Theme>(() => initialTheme());
  const [status, setStatus] = useState<RuntimeStatus>(emptyStatus);
  const [config, setConfig] = useState<MonitorConfig | null>(null);
  const [options, setOptions] = useState<ChipOption[]>([]);
  const [history, setHistory] = useState<HistoryResponse>({ checks: [], events: [] });
  const [draftSpec, setDraftSpec] = useState<ProductSpec | null>(null);
  const [workStartTime, setWorkStartTime] = useState('09:00');
  const [workEndTime, setWorkEndTime] = useState('18:00');
  const [workIntervalMinutes, setWorkIntervalMinutes] = useState(5);
  const [offWorkIntervalMinutes, setOffWorkIntervalMinutes] = useState(10);
  const [summaryEnabled, setSummaryEnabled] = useState(true);
  const [summaryTimes, setSummaryTimes] = useState(['09:05', '14:05', '22:05']);
  const [pushoverEnabled, setPushoverEnabled] = useState(false);
  const [pushoverApiToken, setPushoverApiToken] = useState('');
  const [pushoverRecipients, setPushoverRecipients] = useState<string[]>([]);
  const [pushoverRecipientInput, setPushoverRecipientInput] = useState('');
  const [pushoverRecipientError, setPushoverRecipientError] = useState('');
  const [pushoverSendsPerRecipient, setPushoverSendsPerRecipient] = useState(1);
  const [pushoverRetrySeconds, setPushoverRetrySeconds] = useState(60);
  const [pushoverExpireSeconds, setPushoverExpireSeconds] = useState(3600);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [notificationModal, setNotificationModal] = useState<{ check: CheckRecord; notifications: NotificationLog[] } | null>(null);
  const configKey = useRef('');

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    window.localStorage.setItem('macstudio-theme', theme);
  }, [theme]);

  async function refresh(forceConfigSync = false) {
    const [nextStatus, nextConfig, nextOptions, nextHistory] = await Promise.all([
      api<RuntimeStatus>('/api/status'),
      api<MonitorConfig>('/api/config'),
      api<ChipOption[]>('/api/options'),
      api<HistoryResponse>('/api/history?limit=100')
    ]);
    setStatus(nextStatus);
    setConfig(nextConfig);
    setOptions(nextOptions);
    setHistory(nextHistory);
    const key = JSON.stringify(nextConfig);
    if ((forceConfigSync || !dirty || nextStatus.running || nextStatus.checking) && key !== configKey.current) {
      configKey.current = key;
      setDraftSpec(nextConfig.expectedSpec ?? null);
      setWorkStartTime(nextConfig.schedule.workStartTime);
      setWorkEndTime(nextConfig.schedule.workEndTime);
      setWorkIntervalMinutes(nextConfig.schedule.workIntervalMinutes);
      setOffWorkIntervalMinutes(nextConfig.schedule.offWorkIntervalMinutes);
      setSummaryEnabled(nextConfig.summary.enabled);
      setSummaryTimes(normalizeSummaryTimes(nextConfig.summary.times));
      setPushoverEnabled(nextConfig.pushover.enabled);
      setPushoverApiToken(nextConfig.pushover.apiToken);
      setPushoverRecipients(nextConfig.pushover.recipients);
      setPushoverRecipientInput('');
      setPushoverRecipientError('');
      setPushoverSendsPerRecipient(nextConfig.pushover.sendsPerRecipient);
      setPushoverRetrySeconds(nextConfig.pushover.retrySeconds);
      setPushoverExpireSeconds(nextConfig.pushover.expireSeconds);
      if (nextStatus.running || nextStatus.checking) setDirty(false);
    }
  }

  useEffect(() => {
    void refresh();
    const timer = window.setInterval(() => void refresh(), 1500);
    return () => window.clearInterval(timer);
  }, [dirty]);

  async function action<T>(label: string, fn: () => Promise<T>) {
    setBusy(true);
    setNotice('');
    try {
      await fn();
      setNotice(label);
      await refresh();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function toggleMonitor() {
    if (!status.running && dirty) {
      setNotice('当前配置有未保存修改，请先保存配置后再启动定时检测。');
      return;
    }
    await action(status.running ? '定时检测已停止' : '定时检测已启动', () => api(status.running ? '/api/monitor/stop' : '/api/monitor/start', { method: 'POST' }));
    configKey.current = '';
    await refresh(true);
  }

  const locked = status.running || status.checking;
  const spec = draftSpec ?? config?.expectedSpec ?? firstSpec(options);
  const processor = processorFor(options, spec);
  const runningVisual = status.running || status.checking;

  function updateSpec(patch: Partial<ProductSpec>) {
    const next = normalizeClientSpec(options, { ...spec, ...patch });
    setDraftSpec(next);
    setDirty(true);
  }

  function addRecipient() {
    const normalized = normalizePushoverRecipient(pushoverRecipientInput);
    if (!pushoverRecipientInput.trim()) {
      setPushoverRecipientError('请输入 User Key 或 Group Key。');
      return;
    }
    if (!normalized) {
      setPushoverRecipientError('接收人 Key 不能包含空白字符。');
      return;
    }
    if (pushoverRecipients.includes(normalized)) {
      setPushoverRecipientError('这个接收人已经添加过。');
      setPushoverRecipientInput('');
      return;
    }
    setPushoverRecipients([...pushoverRecipients, normalized]);
    setPushoverRecipientInput('');
    setPushoverRecipientError('');
    setDirty(true);
  }

  function removeRecipient(value: string) {
    setPushoverRecipients(pushoverRecipients.filter((item) => item !== value));
    setPushoverRecipientError('');
    setDirty(true);
  }

  function updateSummaryTime(index: number, value: string) {
    setSummaryTimes((items) => items.map((item, itemIndex) => (itemIndex === index ? value : item)));
    setDirty(true);
  }

  function updatePushoverSendsPerRecipient(delta: number) {
    setPushoverSendsPerRecipient((value) => clamp(value + delta, 1, 5));
    setDirty(true);
  }

  async function sendPushoverTest() {
    await action('Pushover 测试通知已发送', () => api('/api/notify/pushover-test', { method: 'POST' }));
  }

  async function openNotificationDetails(check: CheckRecord) {
    setBusy(true);
    setNotice('');
    try {
      const detail = await api<NotificationDetailResponse>(`/api/checks/${check.id}/notifications`);
      setNotificationModal({ check, notifications: detail.notifications });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function saveConfig() {
    if (!config) return;
    const normalizedPushoverRecipients = normalizePushoverRecipientList(pushoverRecipients);
    if (pushoverEnabled && (!pushoverApiToken.trim() || normalizedPushoverRecipients.length === 0)) {
      setNotice('启用 Pushover 时，请填写 API Token 并至少添加一个接收人。');
      return;
    }
    const next: MonitorConfig = {
      ...config,
      expectedSpec: spec,
      checkIntervalMinutes: currentIntervalForSchedule(workStartTime, workEndTime, workIntervalMinutes, offWorkIntervalMinutes),
      schedule: {
        workStartTime,
        workEndTime,
        workIntervalMinutes,
        offWorkIntervalMinutes
      },
      summary: {
        enabled: summaryEnabled,
        times: normalizeSummaryTimes(summaryTimes)
      },
      monitorEnabled: false,
      chromeHeadless: true,
      pushover: {
        enabled: pushoverEnabled,
        apiToken: pushoverApiToken.trim(),
        recipients: normalizedPushoverRecipients,
        sendsPerRecipient: pushoverSendsPerRecipient,
        retrySeconds: pushoverRetrySeconds,
        expireSeconds: pushoverExpireSeconds
      }
    };
    setBusy(true);
    setNotice('');
    try {
      await api('/api/config', { method: 'PUT', body: JSON.stringify(next) });
      setDirty(false);
      await api('/api/check/run-once', { method: 'POST' });
      setNotice('配置已保存，并已按当前配置完成一次检测');
      configKey.current = '';
      await refresh(true);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  const lastCheckMatchesCurrent = Boolean(status.lastCheck?.detail.expectedSpec && specsEqual(spec, status.lastCheck.detail.expectedSpec) && !dirty);
  const displayedStatus = lastCheckMatchesCurrent ? status.lastStatus : null;
  const saveDisabled = locked || busy || !dirty || (pushoverEnabled && (!pushoverApiToken.trim() || pushoverRecipients.length === 0));
  const staleReason = dirty
    ? '当前配置有未保存修改。保存后会自动按新配置检测。'
    : '当前配置尚未产生检测结果。保存配置或点击立即检测后，这里才显示结论。';

  return (
    <main className="page">
      <section className="hero">
        <div className="heroCopy">
          <div className="kicker">Mac Studio Inventory Monitor</div>
          <h1>库存检测控制台</h1>
          <p>通过精确配置页、配置汇总和购买流程按钮判断库存。配置全部由下拉选项生成，避免 URL 与规格错配。</p>
        </div>
        <div className="heroTools">
          <button
            className="themeButton"
            onClick={() => setTheme((value) => (value === 'dark' ? 'light' : 'dark'))}
            aria-label={theme === 'dark' ? '切换到日间模式' : '切换到暗夜模式'}
          >
            {theme === 'dark' ? <Sun size={17} /> : <Moon size={17} />}
            {theme === 'dark' ? '日间' : '暗夜'}
          </button>
          <Radar running={runningVisual} />
        </div>
      </section>

      {notice && <div className="notice">{notice}</div>}

      <section className="topStrip">
        <StatusPill status={displayedStatus} pending={!lastCheckMatchesCurrent} />
        <div className="stripItem">
          <span>定时</span>
          <strong>{status.running ? '运行中' : '已停止'}</strong>
        </div>
        <div className="stripItem">
          <span>下次检测</span>
          <strong>{formatDate(status.nextRunAt)}</strong>
        </div>
        <div className="controls">
          <button
            className={status.running ? 'dangerButton' : 'primaryButton'}
            disabled={busy}
            onClick={() => void toggleMonitor()}
          >
            {status.running ? <Pause size={17} /> : <Play size={17} />}
            {status.running ? '停止' : '启动'}
          </button>
          <button className="secondaryButton" disabled={busy || status.checking || dirty} onClick={() => void action('检测完成', () => api('/api/check/run-once', { method: 'POST' }))}>
            <RotateCw size={17} />
            {status.checking ? '检测中' : '立即检测'}
          </button>
        </div>
      </section>

      <section className="grid">
        <section className="panel configPanel">
          <Header title="检测配置" meta={locked ? '先停止定时任务才能修改' : dirty ? '有未保存修改' : '已保存'} />
          <div className="formStack">
            <label>
              芯片
              <select disabled={locked} value={spec.chip} onChange={(event) => updateSpec({ chip: event.target.value })}>
                {options.map((item) => <option key={item.chip} value={item.chip}>{item.chip}</option>)}
              </select>
            </label>
            <label>
              处理器
              <select disabled={locked} value={`${spec.cpu}/${spec.gpu}`} onChange={(event) => {
                const [cpu, gpu] = event.target.value.split('/');
                updateSpec({ cpu, gpu });
              }}>
                {chipFor(options, spec.chip)?.processors.map((item) => <option key={item.label} value={`${item.cpu}/${item.gpu}`}>{item.label}</option>)}
              </select>
            </label>
            <div className="twoCols">
              <label>
                统一内存
                <select disabled={locked} value={spec.memory} onChange={(event) => updateSpec({ memory: event.target.value })}>
                  {processor?.memory.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
              <label>
                存储
                <select disabled={locked} value={spec.storage} onChange={(event) => updateSpec({ storage: event.target.value })}>
                  {processor?.storage.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </label>
            </div>
            <div className="twoCols">
              <label>
                上班开始
                <input disabled={locked} type="time" value={workStartTime} onChange={(event) => {
                  setWorkStartTime(event.target.value);
                  setDirty(true);
                }} />
              </label>
              <label>
                上班结束
                <input disabled={locked} type="time" value={workEndTime} onChange={(event) => {
                  setWorkEndTime(event.target.value);
                  setDirty(true);
                }} />
              </label>
            </div>
            <div className="twoCols">
              <label>
                上班频率，分钟
                <input disabled={locked} type="number" min={1} max={1440} value={workIntervalMinutes} onChange={(event) => {
                  setWorkIntervalMinutes(Number(event.target.value));
                  setDirty(true);
                }} />
              </label>
              <label>
                下班频率，分钟
                <input disabled={locked} type="number" min={1} max={1440} value={offWorkIntervalMinutes} onChange={(event) => {
                  setOffWorkIntervalMinutes(Number(event.target.value));
                  setDirty(true);
                }} />
              </label>
            </div>
          </div>

          <div className="specSummary">
            {specKeywords(spec).map((item) => <span key={item}>{item}</span>)}
            <span>{workStartTime}-{workEndTime} 每 {workIntervalMinutes} 分钟</span>
            <span>其余时间每 {offWorkIntervalMinutes} 分钟</span>
          </div>
          <button className="primaryButton saveButton" disabled={saveDisabled} onClick={() => void saveConfig()}>
            <Save size={17} />
            保存配置
          </button>
        </section>

        <section className="panel resultPanel">
          <Header title="检测结果" meta={lastCheckMatchesCurrent && status.lastCheck ? formatDate(status.lastCheck.timestamp) : '待检测'} />
          <ResultCard check={lastCheckMatchesCurrent ? status.lastCheck : null} currentSpec={spec} staleReason={staleReason} />
        </section>
      </section>

      <section className="panel notifyPanel">
        <Header title="通知配置" meta={locked ? '先停止定时任务才能修改' : dirty ? '有未保存修改' : '已保存'} />
        <div className="notifyChannelHead">
          <label className="toggleInline">
            <input
              disabled={locked}
              type="checkbox"
              checked={pushoverEnabled}
              onChange={(event) => {
                setPushoverEnabled(event.target.checked);
                setDirty(true);
              }}
            />
            <span>启用 Pushover</span>
          </label>
          <div className="notifyMetrics">
            <span><strong>{pushoverRecipients.length}</strong> 接收人</span>
            <span><strong>{pushoverSendsPerRecipient}</strong> 条/接收人</span>
            <span>Emergency {pushoverRetrySeconds}s / {pushoverExpireSeconds}s</span>
          </div>
        </div>
        <div className="notifyFormGrid">
          <label className="pushoverTokenField">
            API Token
            <input disabled={locked || !pushoverEnabled} type="password" value={pushoverApiToken} onChange={(event) => {
              setPushoverApiToken(event.target.value);
              setDirty(true);
            }} />
          </label>
          <label className="pushoverRecipientsField">
            接收人
            <div className="recipientBox">
              <div className="recipientInputRow">
                <input
                  disabled={locked || !pushoverEnabled}
                  value={pushoverRecipientInput}
                  placeholder="User Key 或 Group Key"
                  onChange={(event) => {
                    setPushoverRecipientInput(event.target.value);
                    if (pushoverRecipientError) setPushoverRecipientError('');
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') {
                      event.preventDefault();
                      addRecipient();
                    }
                  }}
                />
                <button className="secondaryButton iconTextButton" disabled={locked || !pushoverEnabled} onClick={addRecipient}>
                  <Plus size={16} />
                  添加
                </button>
              </div>
              {pushoverRecipientError && <div className="fieldError">{pushoverRecipientError}</div>}
              <div className="recipientChips">
                {pushoverRecipients.length === 0
                  ? <span className="emptyChip">还没有接收人</span>
                  : pushoverRecipients.map((item) => (
                    <span className="recipientChip" key={item}>
                      {item}
                      <button disabled={locked || !pushoverEnabled} onClick={() => removeRecipient(item)} aria-label={`删除 ${item}`}>
                        <X size={14} />
                      </button>
                    </span>
                  ))}
              </div>
            </div>
          </label>
        </div>
        <div className="notifyGroups">
          <section className="notifyGroup">
            <div className="notifyGroupTitle">
              <strong>有货强提醒</strong>
              <span>Pushover emergency</span>
            </div>
            <div className="emergencyControls">
              <label>
                推送条数
                <div className="stepper compactStepper">
                  <button className="secondaryButton iconButton" disabled={locked || !pushoverEnabled || pushoverSendsPerRecipient <= 1} onClick={() => updatePushoverSendsPerRecipient(-1)} aria-label="减少推送条数">
                    <Minus size={17} />
                  </button>
                  <strong>{pushoverSendsPerRecipient}</strong>
                  <button className="secondaryButton iconButton" disabled={locked || !pushoverEnabled || pushoverSendsPerRecipient >= 5} onClick={() => updatePushoverSendsPerRecipient(1)} aria-label="增加推送条数">
                    <Plus size={17} />
                  </button>
                  <span>条/接收人</span>
                </div>
              </label>
              <label>
                重复间隔，秒
                <input disabled={locked || !pushoverEnabled} type="number" min={30} max={3600} value={pushoverRetrySeconds} onChange={(event) => {
                  setPushoverRetrySeconds(Number(event.target.value));
                  setDirty(true);
                }} />
              </label>
              <label>
                过期时间，秒
                <input disabled={locked || !pushoverEnabled} type="number" min={300} max={86400} value={pushoverExpireSeconds} onChange={(event) => {
                  setPushoverExpireSeconds(Number(event.target.value));
                  setDirty(true);
                }} />
              </label>
            </div>
          </section>
          <section className="notifyGroup summaryGroup">
            <div className="notifyGroupTitle">
              <label className="toggleInline">
                <input
                  disabled={locked}
                  type="checkbox"
                  checked={summaryEnabled}
                  onChange={(event) => {
                    setSummaryEnabled(event.target.checked);
                    setDirty(true);
                  }}
                />
                <strong>状态总结</strong>
              </label>
              <span>Pushover 普通通知</span>
            </div>
            <div className="summaryTimeGrid">
              {summaryTimes.map((time, index) => (
                <label key={index}>
                  总结时间 {index + 1}
                  <input disabled={locked || !summaryEnabled} type="time" value={time} onChange={(event) => updateSummaryTime(index, event.target.value)} />
                </label>
              ))}
            </div>
          </section>
        </div>
        <div className="controls leftControls">
          <button
            className="secondaryButton"
            disabled={busy || locked || dirty || !config?.pushover.enabled || config.pushover.recipients.length === 0 || !config.pushover.apiToken}
            onClick={() => void sendPushoverTest()}
          >
            <RotateCw size={17} />
            测试 Pushover
          </button>
        </div>
      </section>

      <section className="panel historyPanel">
        <Header title="检测历史" meta={`最近 ${history.checks.length} 条`} />
        <div className="historyTable">
          <div className="historyHead">
            <span>时间</span>
            <span>型号配置</span>
            <span>结果</span>
            <span>通知</span>
            <span>判定摘要</span>
          </div>
          {history.checks.length === 0 ? <div className="empty">暂无记录</div> : history.checks.map((item) => <HistoryRow key={item.id} item={item} onDetails={openNotificationDetails} />)}
        </div>
      </section>

      {notificationModal && <NotificationModal data={notificationModal} onClose={() => setNotificationModal(null)} />}
    </main>
  );
}

function initialTheme(): Theme {
  const saved = window.localStorage.getItem('macstudio-theme');
  if (saved === 'dark' || saved === 'light') return saved;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function Header({ title, meta }: { title: string; meta: string }) {
  return (
    <div className="panelHeader">
      <h2>{title}</h2>
      <span>{meta}</span>
    </div>
  );
}

function Radar({ running }: { running: boolean }) {
  return (
    <div className={running ? 'radar active' : 'radar'}>
      <div className="radarSweep" />
      <div className="radarCore" />
    </div>
  );
}

function StatusPill({ status, pending }: { status: StockStatus | null; pending: boolean }) {
  return (
    <div className={`statusPill ${pending ? 'pending' : status ?? 'unknown'}`}>
      {status === 'in_stock' && !pending ? <CheckCircle2 size={18} /> : <XCircle size={18} />}
      <span>{pending ? '待检测' : statusText(status)}</span>
    </div>
  );
}

function ResultCard({ check, currentSpec, staleReason }: { check: CheckRecord | null; currentSpec: ProductSpec; staleReason: string }) {
  const detail = check?.detail;
  return (
    <div className="resultStack">
      <div className={`bigStatus ${check?.status ?? 'pending'}`}>{check ? statusText(check.status) : '待检测'}</div>
      <dl className="detailGrid">
        <dt>当前配置</dt>
        <dd>{specLabel(currentSpec)}</dd>
        <dt>检测记录</dt>
        <dd>{check ? specLabel(detail?.expectedSpec) : '尚无当前配置检测记录'}</dd>
        <dt>最终 URL</dt>
        <dd className={check && detail?.finalUrlMatched ? 'ok' : 'bad'}>{check ? (detail?.finalUrlMatched ? '匹配精确配置页' : '回退或不匹配') : '待检测'}</dd>
        <dt>规格匹配</dt>
        <dd className={check && detail && detail.missingKeywords.length === 0 ? 'ok' : 'bad'}>{check ? (detail?.missingKeywords.length ? `缺失 ${detail.missingKeywords.join('、')}` : '完整匹配') : '待检测'}</dd>
        <dt>购买流程</dt>
        <dd className={check && detail?.continueEnabled ? 'ok' : 'bad'}>{check ? (detail?.continueEnabled ? '继续按钮可点击' : '继续按钮不可点击') : '待检测'}</dd>
      </dl>
      <div className="reasonList">
        {check
          ? (detail?.decisionReasons?.length ? detail.decisionReasons : ['暂无检测结果']).map((item) => <p key={item}>{item}</p>)
          : <p>{staleReason}</p>}
      </div>
    </div>
  );
}

function HistoryRow({ item, onDetails }: { item: CheckRecord; onDetails: (item: CheckRecord) => void }) {
  const summary = item.notificationSummary ?? { total: 0, success: 0, failed: 0 };
  return (
    <div className="historyRow">
      <span>{formatDate(item.timestamp)}</span>
      <span>{specLabel(item.detail.expectedSpec)}</span>
      <span className={item.status}>{statusText(item.status)}</span>
      <span className="notifyCell">
        {notificationText(summary)}
        <button className="miniButton" disabled={summary.total === 0} onClick={() => onDetails(item)}>详情</button>
      </span>
      <span>{item.detail.decisionReasons?.[0] ?? item.error ?? '检测完成'}</span>
    </div>
  );
}

function NotificationModal({ data, onClose }: { data: { check: CheckRecord; notifications: NotificationLog[] }; onClose: () => void }) {
  return (
    <div className="modalBackdrop" role="dialog" aria-modal="true">
      <div className="modal">
        <div className="modalHeader">
          <div>
            <h2>通知详情</h2>
            <p>{formatDate(data.check.timestamp)} · {specLabel(data.check.detail.expectedSpec)}</p>
          </div>
          <button className="miniButton" onClick={onClose}>关闭</button>
        </div>
        <div className="notificationList">
          {data.notifications.length === 0 ? <div className="empty">该检测未发送通知</div> : data.notifications.map((item) => <NotificationItem key={item.id} item={item} />)}
        </div>
      </div>
    </div>
  );
}

function NotificationItem({ item }: { item: NotificationLog }) {
  return (
    <div className="notificationItem">
      <div className="notificationMeta">
        <span>{formatDate(item.timestamp)}</span>
        <span>{item.recipient}</span>
        <span className={item.success ? 'ok' : 'bad'}>{item.success ? '发送成功' : '发送失败'}</span>
      </div>
      <pre>{item.message}</pre>
      {item.error && <p className="bad">{item.error}</p>}
    </div>
  );
}

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败：${response.status}`);
  return data as T;
}

function firstSpec(options: ChipOption[]): ProductSpec {
  const chip = options[0];
  const processor = chip?.processors[0];
  return {
    chip: chip?.chip ?? 'M3 Ultra',
    cpu: processor?.cpu ?? '32核',
    gpu: processor?.gpu ?? '80核',
    memory: processor?.memory[0] ?? '96GB',
    storage: processor?.storage[0] ?? '16TB'
  };
}

function chipFor(options: ChipOption[], chip: string) {
  return options.find((item) => item.chip === chip) ?? options[0];
}

function processorFor(options: ChipOption[], spec: ProductSpec) {
  const chip = chipFor(options, spec.chip);
  return chip?.processors.find((item) => item.cpu === spec.cpu && item.gpu === spec.gpu) ?? chip?.processors[0];
}

function normalizeClientSpec(options: ChipOption[], spec: ProductSpec): ProductSpec {
  const chip = chipFor(options, spec.chip);
  const processor = chip?.processors.find((item) => item.cpu === spec.cpu && item.gpu === spec.gpu) ?? chip?.processors[0];
  return {
    chip: chip?.chip ?? spec.chip,
    cpu: processor?.cpu ?? spec.cpu,
    gpu: processor?.gpu ?? spec.gpu,
    memory: processor?.memory.includes(spec.memory) ? spec.memory : processor?.memory[0] ?? spec.memory,
    storage: processor?.storage.includes(spec.storage) ? spec.storage : processor?.storage[0] ?? spec.storage
  };
}

function specKeywords(spec: ProductSpec): string[] {
  return [spec.chip, spec.cpu, spec.gpu, spec.memory, spec.storage];
}

function specLabel(spec?: ProductSpec): string {
  return spec ? specKeywords(spec).join(' / ') : '暂无';
}

function specsEqual(left?: ProductSpec, right?: ProductSpec): boolean {
  if (!left || !right) return false;
  return left.chip === right.chip && left.cpu === right.cpu && left.gpu === right.gpu && left.memory === right.memory && left.storage === right.storage;
}

function statusText(status: StockStatus | null): string {
  if (!status) return '暂无';
  return {
    in_stock: '有货',
    out_of_stock: '无货',
    unknown: '未知',
    error: '错误'
  }[status];
}

function notificationText(summary: { total: number; success: number; failed: number }): string {
  if (summary.total === 0) return '未触发';
  if (summary.failed === 0) return `已发送 ${summary.success} 条`;
  if (summary.success === 0) return `失败 ${summary.failed} 条`;
  return `成功 ${summary.success} / 失败 ${summary.failed}`;
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '暂无';
  return new Date(value).toLocaleString('zh-CN', { hour12: false });
}

function currentIntervalForSchedule(workStartTime: string, workEndTime: string, workIntervalMinutes: number, offWorkIntervalMinutes: number): number {
  return isWorkTime(workStartTime, workEndTime, new Date()) ? workIntervalMinutes : offWorkIntervalMinutes;
}

function isWorkTime(workStartTime: string, workEndTime: string, now: Date): boolean {
  const current = now.getHours() * 60 + now.getMinutes();
  const start = minutesFromTime(workStartTime);
  const end = minutesFromTime(workEndTime);
  if (start === end) return true;
  if (start < end) return current >= start && current < end;
  return current >= start || current < end;
}

function minutesFromTime(value: string): number {
  const [hour, minute] = value.split(':').map(Number);
  return hour * 60 + minute;
}

function normalizePushoverRecipientList(value: string[]): string[] {
  const unique = new Set<string>();
  for (const item of value) {
    const normalized = normalizePushoverRecipient(item);
    if (normalized) unique.add(normalized);
  }
  return [...unique];
}

function normalizeSummaryTimes(value: string[]): string[] {
  const defaults = ['09:05', '14:05', '22:05'];
  const unique = new Set<string>();
  for (const item of [...value, ...defaults]) {
    const normalized = item.trim();
    if (/^\d{2}:\d{2}$/.test(normalized)) unique.add(normalized);
    if (unique.size === 3) break;
  }
  return [...unique];
}

function normalizePushoverRecipient(value: string): string {
  const normalized = value.trim();
  return /^\S+$/.test(normalized) ? normalized : '';
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

createRoot(document.getElementById('root')!).render(<App />);
