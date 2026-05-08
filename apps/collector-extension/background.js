const DEFAULT_SETTINGS = {
  serverUrl: '',
  authCode: '',
  collectorId: '',
  intervalSeconds: 3,
  randomJitterSeconds: 0,
  running: false,
};

const VERIFY_MARKERS = [
  '\u73af\u5883\u5f02\u5e38',
  '\u53bb\u9a8c\u8bc1',
  '\u5b8c\u6210\u9a8c\u8bc1\u540e\u5373\u53ef\u7ee7\u7eed\u8bbf\u95ee',
];
const MIN_CONTENT_LENGTH = 120;
const WATCHDOG_ALARM = 'collector-watchdog';
const ACTIVE_STATE_KEY = 'activeCollection';
const ACTIVE_TTL_MS = 10 * 60 * 1000;

let loopTimer = null;
let processing = false;

chrome.runtime.onInstalled.addListener(async () => {
  const settings = await getSettings();
  if (!settings.collectorId) {
    await chrome.storage.local.set({
      collectorId: `collector-${crypto.randomUUID()}`,
    });
  }
});

chrome.runtime.onStartup.addListener(async () => {
  const settings = await getSettings();
  if (settings.running) {
    ensureWatchdog();
    scheduleNext(1);
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== WATCHDOG_ALARM) {
    return;
  }

  const settings = await getSettings();
  if (!settings.running || processing) {
    return;
  }

  scheduleNext(0);
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  handleMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }));
  return true;
});

async function handleMessage(message) {
  if (message?.type === 'getState') {
    return {
      ok: true,
      settings: await getSettings(),
      status: await getStatus(),
    };
  }

  if (message?.type === 'saveSettings') {
    const next = normalizeSettings(message.settings || {});
    await chrome.storage.local.set(next);
    return { ok: true, settings: await getSettings() };
  }

  if (message?.type === 'start') {
    await chrome.storage.local.set({ running: true });
    ensureWatchdog();
    scheduleNext(0);
    return { ok: true, settings: await getSettings() };
  }

  if (message?.type === 'stop') {
    await chrome.storage.local.set({ running: false });
    clearLoop();
    await chrome.alarms.clear(WATCHDOG_ALARM);
    await setStatus('stopped');
    return { ok: true, settings: await getSettings() };
  }

  if (message?.type === 'runOnce') {
    await runOnce();
    return { ok: true, status: await getStatus() };
  }

  if (message?.type === 'openActiveTab') {
    const active = await getActiveCollection();
    if (!active?.tabId) {
      return { ok: false, error: 'no active collection tab' };
    }
    const tab = await getTab(active.tabId);
    if (!tab) {
      await clearActiveCollection();
      return { ok: false, error: 'active collection tab not found' };
    }
    await bringTabToFront(tab);
    return { ok: true };
  }

  if (message?.type === 'retryActiveTab') {
    await retryActiveTab();
    return { ok: true, status: await getStatus() };
  }

  return { ok: false, error: 'Unknown message type' };
}

async function runLoop() {
  clearLoop();
  const settings = await getSettings();
  if (!settings.running || processing) {
    return;
  }

  const active = await getActiveCollection();
  if (active && Date.now() - active.startedAt < ACTIVE_TTL_MS) {
    const activeTab = await getTab(active.tabId);
    if (
      activeTab?.url &&
      activeTab.url.startsWith('https://mp.weixin.qq.com/s/')
    ) {
      await setStatus(`still processing: ${active.title || active.articleId}`);
      scheduleNext(nextDelaySeconds(settings));
      return;
    }
    await clearActiveCollection();
  }

  processing = true;
  try {
    await runOnce();
  } catch (error) {
    await setStatus(`run failed: ${error.message}`);
  } finally {
    processing = false;
    const latest = await getSettings();
    if (latest.running) {
      scheduleNext(nextDelaySeconds(latest));
    }
  }
}

async function runOnce() {
  const settings = await getSettings();
  validateSettings(settings);
  ensureWatchdog();
  await setStatus('claiming job');

  const job = await claimJob(settings);
  if (!job) {
    await setStatus('no pending jobs');
    return;
  }
  validateJob(job);

  await setStatus(`collecting: ${job.title || job.articleId}`);
  const result = await collectArticle(job, settings);

  if (result.status === 'success') {
    await submitContent(settings, job, result);
    await setStatus(`success: ${result.contentLength} chars`);
    return;
  }

  await failJob(settings, job, result.status, result.reason || 'collect failed');
  await setStatus(`failed: ${result.reason || result.status}`);
}

async function collectArticle(job, settings) {
  const previous = await getActiveTab();
  const tab = await chrome.tabs.create({
    url: job.sourceUrl,
    active: false,
  });
  await setActiveCollection({
    jobId: job.jobId,
    articleId: job.articleId,
    title: job.title,
    tabId: tab.id,
    startedAt: Date.now(),
  });

  try {
    await waitForTabLoaded(tab.id);
    await sleep(1500);

    let extracted = await extractFromTab(tab.id);
    if (isGoodContent(extracted)) {
      return toSuccess(extracted);
    }

    if (extracted.isVerifyPage) {
      await setStatus('verification required, switched to foreground');
      await bringTabToFront(tab);

      extracted = await waitForManualVerification(tab.id);
      await restorePreviousTab(previous);

      if (isGoodContent(extracted)) {
        return toSuccess(extracted);
      }

      return {
        status: 'verify_required',
        reason: extracted.isVerifyPage
          ? 'no article content after verification'
          : 'empty article content after verification',
        ...extracted,
      };
    }

    return {
      status: extracted.contentLength ? 'failed' : 'empty',
      reason: extracted.contentLength
        ? 'content too short'
        : 'article content node not found',
      ...extracted,
    };
  } finally {
    await safeRemoveTab(tab.id);
    await clearActiveCollection();
    await restorePreviousTab(previous);
  }
}

async function retryActiveTab() {
  const active = await getActiveCollection();
  if (!active?.tabId || !active?.jobId || !active?.articleId) {
    throw new Error('no active collection');
  }
  const tab = await getTab(active.tabId);
  if (!tab) {
    await clearActiveCollection();
    throw new Error('active collection tab not found');
  }

  const settings = await getSettings();
  const extracted = await extractFromTab(active.tabId);
  if (!isGoodContent(extracted)) {
    throw new Error(
      extracted.isVerifyPage
        ? 'page still looks like verification'
        : `content too short: ${extracted.contentLength || 0}`,
    );
  }

  await submitContent(
    settings,
    {
      jobId: active.jobId,
      articleId: active.articleId,
      title: active.title,
    },
    toSuccess(extracted),
  );
  await safeRemoveTab(active.tabId);
  await clearActiveCollection();
  await setStatus(`success by retry: ${extracted.contentLength} chars`);
}

async function waitForManualVerification(tabId) {
  const deadline = Date.now() + 5 * 60 * 1000;
  let last = null;

  while (Date.now() < deadline) {
    await sleep(2000);
    if (!(await getTab(tabId))) {
      return {
        status: 'failed',
        reason: 'collection tab was closed during verification',
        contentLength: 0,
        isVerifyPage: false,
      };
    }
    last = await extractFromTab(tabId).catch((error) => ({
      status: 'failed',
      reason: error.message,
      contentLength: 0,
      isVerifyPage: false,
    }));

    if (isGoodContent(last)) {
      return last;
    }
  }

  return (
    last || {
      status: 'verify_required',
      reason: 'manual verification timeout',
      contentLength: 0,
      isVerifyPage: true,
    }
  );
}

async function bringTabToFront(tab) {
  await chrome.windows.update(tab.windowId, { focused: true });
  await chrome.tabs.update(tab.id, { active: true });
}

async function extractFromTab(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: extractWechatArticle,
  });
  return injection.result;
}

function extractWechatArticle() {
  const text = (selector) =>
    document.querySelector(selector)?.textContent?.replace(/\s+/g, ' ').trim() ||
    '';

  const html = (selector) =>
    document.querySelector(selector)?.innerHTML || '';

  const bodyText = document.body?.innerText || '';
  const verifyMarkers = [
    '\u73af\u5883\u5f02\u5e38',
    '\u53bb\u9a8c\u8bc1',
    '\u5b8c\u6210\u9a8c\u8bc1\u540e\u5373\u53ef\u7ee7\u7eed\u8bbf\u95ee',
  ];
  const isVerifyPage = verifyMarkers.some((marker) => bodyText.includes(marker));
  const content = text('#js_content') || text('.rich_media_content');
  const contentHtml = html('#js_content') || html('.rich_media_content');

  return {
    title: text('#activity-name') || document.title || '',
    author: text('#js_name'),
    content,
    contentHtml,
    contentLength: content.length,
    isVerifyPage,
    bodyStart: bodyText.replace(/\s+/g, ' ').trim().slice(0, 300),
    url: location.href,
  };
}

function isGoodContent(extracted) {
  return extracted && extracted.contentLength >= MIN_CONTENT_LENGTH;
}

function toSuccess(extracted) {
  return {
    status: 'success',
    title: extracted.title,
    author: extracted.author,
    content: extracted.content,
    contentHtml: extracted.contentHtml,
    contentLength: extracted.contentLength,
    url: extracted.url,
  };
}

async function claimJob(settings) {
  const data = await trpcMutation(settings, 'rag.claimContentJob', {
    collectorId: settings.collectorId,
  });
  return data || null;
}

function validateJob(job) {
  if (!job || !job.jobId || !job.articleId) {
    throw new Error('invalid job payload');
  }
  if (
    !job.sourceUrl ||
    typeof job.sourceUrl !== 'string' ||
    !job.sourceUrl.startsWith('https://mp.weixin.qq.com/s/')
  ) {
    throw new Error(`invalid article URL: ${job.sourceUrl || ''}`);
  }
}

async function submitContent(settings, job, result) {
  return trpcMutation(settings, 'rag.submitArticleContent', {
    jobId: job.jobId,
    articleId: job.articleId,
    title: result.title || job.title,
    author: result.author || '',
    content: result.content,
    contentHtml: result.contentHtml,
    contentLength: result.contentLength,
    collectorId: settings.collectorId,
  });
}

async function failJob(settings, job, status, reason) {
  return trpcMutation(settings, 'rag.failContentJob', {
    jobId: job.jobId,
    articleId: job.articleId,
    status,
    reason,
    collectorId: settings.collectorId,
  });
}

async function trpcMutation(settings, path, payload) {
  const response = await fetch(`${settings.serverUrl}/trpc/${path}`, {
    method: 'POST',
    headers: {
      Authorization: settings.authCode,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  const text = await response.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(text || `HTTP ${response.status}`);
  }

  if (!response.ok || data?.error) {
    throw new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
  }

  return unwrapTrpcData(data);
}

function unwrapTrpcData(data) {
  if (
    data?.result &&
    Object.prototype.hasOwnProperty.call(data.result, 'data')
  ) {
    const payload = data.result.data;
    if (
      payload &&
      typeof payload === 'object' &&
      Object.prototype.hasOwnProperty.call(payload, 'json')
    ) {
      return payload.json;
    }
    return payload;
  }

  if (
    data &&
    typeof data === 'object' &&
    Object.prototype.hasOwnProperty.call(data, 'json')
  ) {
    return data.json;
  }

  return data;
}

async function waitForTabLoaded(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.status === 'complete') {
    return;
  }

  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error('page load timeout'));
    }, 60_000);

    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };

    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });
  return tab
    ? {
        id: tab.id,
        windowId: tab.windowId,
      }
    : null;
}

async function getActiveCollection() {
  const data = await chrome.storage.local.get({ [ACTIVE_STATE_KEY]: null });
  return data[ACTIVE_STATE_KEY];
}

async function setActiveCollection(value) {
  await chrome.storage.local.set({ [ACTIVE_STATE_KEY]: value });
}

async function clearActiveCollection() {
  await chrome.storage.local.remove(ACTIVE_STATE_KEY);
}

async function getTab(tabId) {
  if (!tabId) {
    return null;
  }
  return chrome.tabs
    .get(tabId)
    .then((tab) => tab)
    .catch(() => null);
}

async function restorePreviousTab(previous) {
  if (!previous?.id) {
    return;
  }
  await chrome.tabs
    .update(previous.id, { active: true })
    .then(() => chrome.windows.update(previous.windowId, { focused: true }))
    .catch(() => undefined);
}

async function safeRemoveTab(tabId) {
  await chrome.tabs.remove(tabId).catch(() => undefined);
}

function scheduleNext(seconds) {
  clearLoop();
  loopTimer = setTimeout(runLoop, Math.max(0, seconds) * 1000);
}

function ensureWatchdog() {
  chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
}

function nextDelaySeconds(settings) {
  const base = Math.max(1, Number(settings.intervalSeconds || 1));
  const jitter = Math.max(0, Number(settings.randomJitterSeconds || 0));
  return base + Math.random() * jitter;
}

function clearLoop() {
  if (loopTimer) {
    clearTimeout(loopTimer);
    loopTimer = null;
  }
}

async function getSettings() {
  const stored = await chrome.storage.local.get(DEFAULT_SETTINGS);
  return normalizeSettings(stored);
}

function normalizeSettings(settings) {
  const interval = Number(settings.intervalSeconds || DEFAULT_SETTINGS.intervalSeconds);
  return {
    serverUrl: String(settings.serverUrl || DEFAULT_SETTINGS.serverUrl).replace(/\/$/, ''),
    authCode: String(settings.authCode || ''),
    collectorId: String(settings.collectorId || DEFAULT_SETTINGS.collectorId),
    intervalSeconds: Math.min(5, Math.max(1, interval)),
    randomJitterSeconds: Math.min(
      60,
      Math.max(0, Number(settings.randomJitterSeconds || 0)),
    ),
    running: Boolean(settings.running),
  };
}

function validateSettings(settings) {
  if (!settings.serverUrl) {
    throw new Error('server URL is required');
  }
  if (!settings.authCode) {
    throw new Error('auth code is required');
  }
  if (!settings.collectorId) {
    throw new Error('collector ID is required');
  }
}

async function setStatus(text) {
  await chrome.storage.local.set({
    statusText: text,
    statusUpdatedAt: Date.now(),
  });
}

async function getStatus() {
  const data = await chrome.storage.local.get({
    statusText: 'not started',
    statusUpdatedAt: 0,
  });
  return data;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
