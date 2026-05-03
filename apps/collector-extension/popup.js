const fields = {
  serverUrl: document.querySelector('#serverUrl'),
  authCode: document.querySelector('#authCode'),
  collectorId: document.querySelector('#collectorId'),
  intervalSeconds: document.querySelector('#intervalSeconds'),
  intervalText: document.querySelector('#intervalText'),
  randomJitterSeconds: document.querySelector('#randomJitterSeconds'),
  jitterText: document.querySelector('#jitterText'),
  runningBadge: document.querySelector('#runningBadge'),
  statusText: document.querySelector('#statusText'),
  statusTime: document.querySelector('#statusTime'),
};

let formDirty = false;

document.querySelector('#saveButton').addEventListener('click', saveSettings);
document.querySelector('#startButton').addEventListener('click', start);
document.querySelector('#stopButton').addEventListener('click', stop);
document.querySelector('#runOnceButton').addEventListener('click', runOnce);
document
  .querySelector('#openActiveTabButton')
  .addEventListener('click', openActiveTab);
document
  .querySelector('#retryActiveTabButton')
  .addEventListener('click', retryActiveTab);
fields.intervalSeconds.addEventListener('input', () => {
  fields.intervalText.textContent = fields.intervalSeconds.value;
});
fields.randomJitterSeconds.addEventListener('input', () => {
  fields.jitterText.textContent = fields.randomJitterSeconds.value;
});

[
  fields.serverUrl,
  fields.authCode,
  fields.collectorId,
  fields.intervalSeconds,
  fields.randomJitterSeconds,
].forEach((field) => {
  field.addEventListener('input', () => {
    formDirty = true;
  });
  field.addEventListener('change', saveSettings);
});

loadState();
setInterval(loadState, 2000);

async function loadState() {
  const response = await send({ type: 'getState' });
  if (!response.ok) {
    renderStatus(response.error || '读取状态失败');
    return;
  }

  const { settings, status } = response;
  if (!formDirty && !isEditingForm()) {
    fields.serverUrl.value = settings.serverUrl || '';
    fields.authCode.value = settings.authCode || '';
    fields.collectorId.value = settings.collectorId || '';
    fields.intervalSeconds.value = settings.intervalSeconds || 3;
    fields.intervalText.textContent = fields.intervalSeconds.value;
    fields.randomJitterSeconds.value = settings.randomJitterSeconds || 0;
    fields.jitterText.textContent = fields.randomJitterSeconds.value;
  }

  fields.runningBadge.textContent = settings.running ? '运行中' : '未启动';
  fields.runningBadge.classList.toggle('running', settings.running);
  renderStatus(status.statusText, status.statusUpdatedAt);
}

async function saveSettings() {
  const response = await send({
    type: 'saveSettings',
    settings: readSettings(),
  });
  if (response.ok) {
    formDirty = false;
  }
  renderStatus(response.ok ? '配置已保存' : response.error);
  await loadState();
}

async function start() {
  await saveSettings();
  const response = await send({ type: 'start' });
  renderStatus(response.ok ? '已启动' : response.error);
  await loadState();
}

async function stop() {
  const response = await send({ type: 'stop' });
  renderStatus(response.ok ? '已停止' : response.error);
  await loadState();
}

async function runOnce() {
  await saveSettings();
  renderStatus('正在采集一篇...');
  const response = await send({ type: 'runOnce' });
  renderStatus(response.ok ? '单次采集已触发' : response.error);
  await loadState();
}

async function openActiveTab() {
  const response = await send({ type: 'openActiveTab' });
  renderStatus(response.ok ? '已打开当前采集页' : response.error);
}

async function retryActiveTab() {
  const response = await send({ type: 'retryActiveTab' });
  renderStatus(response.ok ? '当前采集页已重试提交' : response.error);
  await loadState();
}

function readSettings() {
  return {
    serverUrl: fields.serverUrl.value.trim(),
    authCode: fields.authCode.value.trim(),
    collectorId: fields.collectorId.value.trim(),
    intervalSeconds: Number(fields.intervalSeconds.value),
    randomJitterSeconds: Number(fields.randomJitterSeconds.value),
  };
}

function renderStatus(text, timestamp = Date.now()) {
  fields.statusText.textContent = text || '无状态';
  fields.statusTime.textContent = timestamp
    ? new Date(timestamp).toLocaleString()
    : '';
}

function send(message) {
  return chrome.runtime.sendMessage(message);
}

function isEditingForm() {
  return [
    fields.serverUrl,
    fields.authCode,
    fields.collectorId,
    fields.intervalSeconds,
    fields.randomJitterSeconds,
  ].includes(document.activeElement);
}
