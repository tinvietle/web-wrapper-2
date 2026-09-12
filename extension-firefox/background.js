let socket;
let reconnectTimer;
let keepAliveTimer;
let connectionStatus = 'Not configured';
let connectionError = '';
const tabQueues = new Map();
const assignments = new Map();
const captureWaiters = new Map();
let storageLock = Promise.resolve();

const api = globalThis.browser || globalThis.chrome;
const providerFor = (name) => name === 'gemini'
  ? { name: 'gemini', tabUrl: 'https://gemini.google.com/*' }
  : { name: 'chatgpt', tabUrl: 'https://chatgpt.com/*' };
const workerKey = (message) => String(message.metadata?.workerId || 'default');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function config() { return api.storage.sync.get({ relayUrl: 'ws://127.0.0.1:8788', relayToken: '' }); }
async function workerTab(provider, key) {
  const assignmentKey = `${provider.name}:${key}`;
  const saved = assignments.get(assignmentKey);
  if (saved) {
    try { const tab = await api.tabs.get(saved); if (tab.url?.startsWith(provider.name === 'gemini' ? 'https://gemini.google.com/' : 'https://chatgpt.com/')) return tab; } catch {}
    assignments.delete(assignmentKey);
  }
  const used = new Set(assignments.values());
  const tabs = await api.tabs.query({ url: provider.tabUrl });
  const tab = tabs.find((item) => !used.has(item.id) && !item.discarded);
  if (!tab?.id) throw new Error(`Open another authenticated ${provider.name === 'gemini' ? 'Gemini' : 'ChatGPT'} tab for worker ${key}.`);
  assignments.set(assignmentKey, tab.id);
  await api.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  return tab;
}
async function activate(tabId) { const tab = await api.tabs.get(tabId); if (tab.discarded) throw new Error('Assigned tab was discarded.'); if (!tab.active) await api.tabs.update(tabId, { active: true }); }
function queue(tabId, task) {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const scheduled = previous.catch(() => {}).then(task);
  const cleanup = scheduled.finally(() => { if (tabQueues.get(tabId) === cleanup) tabQueues.delete(tabId); });
  tabQueues.set(tabId, cleanup);
  return scheduled;
}
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function waitForCapture(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { captureWaiters.delete(id); reject(new Error('Internal response capture timed out.')); }, timeoutMs);
    captureWaiters.set(id, { resolve, timeout });
  });
}
function settle(message) { const waiter = captureWaiters.get(message.requestId); if (waiter) { captureWaiters.delete(message.requestId); clearTimeout(waiter.timeout); waiter.resolve(message); } }
function updateStorage(key, update) {
  const operation = storageLock.then(async () => { const stored = await api.storage.session.get(key); const value = stored[key] || {}; const result = update(value); await api.storage.session.set({ [key]: value }); return result; });
  storageLock = operation.catch(() => {});
  return operation;
}
async function saveJob(tabId, message, provider) {
  return updateStorage('activeProviderJobs', (jobs) => { jobs[message.requestId] = { requestId: message.requestId, tabId, provider: provider.name, action: message.metadata?.action || 'case', prompt: message.prompt, responseTimeoutMs: Number(message.metadata?.responseTimeoutMs) || 600000, startedAt: Date.now() }; });
}
async function updateJob(requestId, update) { return updateStorage('activeProviderJobs', (jobs) => { if (jobs[requestId]) update(jobs[requestId]); }); }
async function clearJob(requestId) { return updateStorage('activeProviderJobs', (jobs) => { delete jobs[requestId]; }); }
async function queueTerminal(message) { await updateStorage('terminalOutbox', (outbox) => { outbox[message.requestId] = message; }); await flushOutbox(); }
async function flushOutbox() {
  if (socket?.readyState !== WebSocket.OPEN || connectionStatus !== 'Connected') return;
  const { terminalOutbox = {} } = await api.storage.session.get('terminalOutbox');
  for (const message of Object.values(terminalOutbox)) send(message);
}
async function acknowledgeTerminal(requestId) { return updateStorage('terminalOutbox', (outbox) => { delete outbox[requestId]; }); }
async function ensure(tabId, provider) {
  try { return await api.tabs.sendMessage(tabId, { type: 'assistant-state', provider }); }
  catch { await api.scripting.executeScript({ target: { tabId }, files: ['response-state.js', 'content.js'] }); return api.tabs.sendMessage(tabId, { type: 'assistant-state', provider }); }
}
async function freshChat(tabId, message, provider) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await activate(tabId); await api.tabs.sendMessage(tabId, { type: 'new-chat', provider: provider.name });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const state = await ensure(tabId, provider.name).catch(() => null); if (state?.composerAvailable && !state.assistantText) { await queueTerminal({ type: 'response', requestId: message.requestId, response: 'new chat started' }); return; } await sleep(250); }
  }
  throw new Error('Timed out waiting for a fresh provider chat.');
}
async function submit(tabId, message, provider) {
  await activate(tabId); const state = await ensure(tabId, provider.name); if (!state?.composerAvailable) throw new Error('Prompt composer was not found.');
  send({ type: 'accepted', requestId: message.requestId });
  const submitted = await api.tabs.sendMessage(tabId, { type: 'submit-prompt', provider: provider.name, prompt: message.prompt });
  await updateJob(message.requestId, (job) => { job.previousAssistant = submitted.previousAssistant; job.phase = 'capturing'; });
  const responseTimeoutMs = Math.max(15000, Number(message.metadata?.responseTimeoutMs) || 600000);
  const captured = waitForCapture(message.requestId, responseTimeoutMs - 5000);
  await api.tabs.sendMessage(tabId, { type: 'capture-response', provider: provider.name, requestId: message.requestId, previousAssistant: submitted.previousAssistant, captureTimeoutMs: responseTimeoutMs - 10000 });
  try { await captured; } catch (error) { await api.tabs.sendMessage(tabId, { type: 'cancel-capture', requestId: message.requestId }).catch(() => {}); throw error; }
}
async function cancelRequest(requestId) {
  const { activeProviderJobs: jobs = {} } = await api.storage.session.get('activeProviderJobs');
  const job = jobs[requestId];
  if (job) await api.tabs.sendMessage(job.tabId, { type: 'cancel-capture', requestId }).catch(() => {});
  await clearJob(requestId); settle({ requestId });
}
async function recoverActiveJobs() {
  const { activeProviderJobs: jobs = {} } = await api.storage.session.get('activeProviderJobs');
  for (const job of Object.values(jobs)) {
    try {
      if (job.action === 'new_chat' || !job.previousAssistant) throw new Error('request state could not be safely resumed');
      const remaining = job.responseTimeoutMs - (Date.now() - job.startedAt) - 10000;
      if (remaining < 5000) throw new Error('response capture expired during restart');
      await ensure(job.tabId, job.provider);
      await api.tabs.sendMessage(job.tabId, { type: 'capture-response', provider: job.provider, requestId: job.requestId, previousAssistant: job.previousAssistant, captureTimeoutMs: remaining });
      send({ type: 'progress', requestId: job.requestId, state: 'capture_resumed_after_restart' });
    } catch (error) { await queueTerminal({ type: 'error', requestId: job.requestId, error: `Could not resume response capture: ${error.message}` }); await clearJob(job.requestId); }
  }
}
async function connect() {
  clearTimeout(reconnectTimer); if (socket?.readyState === WebSocket.OPEN || socket?.readyState === WebSocket.CONNECTING) return;
  const { relayUrl, relayToken } = await config(); if (!relayToken) { connectionStatus = 'Not configured'; return; }
  const currentSocket = new WebSocket(relayUrl); socket = currentSocket; connectionStatus = 'Connecting';
  currentSocket.addEventListener('open', () => currentSocket.send(JSON.stringify({ type: 'authenticate', role: 'extension', token: relayToken })));
  currentSocket.addEventListener('message', async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'authenticated') { connectionStatus = 'Connected'; clearInterval(keepAliveTimer); keepAliveTimer = setInterval(() => send({ type: 'heartbeat', timestamp: Date.now() }), 20000); await flushOutbox(); await recoverActiveJobs(); return; }
    if (message.type === 'delivery_ack') { await acknowledgeTerminal(message.requestId); return; }
    if (message.type === 'cancel') { await cancelRequest(message.requestId); return; }
    if (message.type !== 'request') return;
    const provider = providerFor(message.provider);
    try {
      const tab = await workerTab(provider, workerKey(message)); await saveJob(tab.id, message, provider);
      queue(tab.id, async () => { try { return message.metadata?.action === 'new_chat' ? await freshChat(tab.id, message, provider) : await submit(tab.id, message, provider); } finally { await clearJob(message.requestId); } }).catch((error) => queueTerminal({ type: 'error', requestId: message.requestId, error: error.message }));
    } catch (error) { await queueTerminal({ type: 'error', requestId: message.requestId, error: error.message }); }
  });
  currentSocket.addEventListener('close', () => { if (socket !== currentSocket) return; clearInterval(keepAliveTimer); socket = null; connectionStatus = 'Disconnected'; reconnectTimer = setTimeout(connect, 3000); });
  currentSocket.addEventListener('error', () => { connectionError = 'Could not connect to the relay.'; currentSocket.close(); });
}
api.runtime.onMessage.addListener((message, sender) => {
  if (['accepted', 'progress'].includes(message?.type)) { if (message.type === 'progress' && message.state === 'response_waiting' && sender.tab?.id) activate(sender.tab.id).catch(() => {}); send(message); return; }
  if (['response', 'error'].includes(message?.type)) { settle(message); return Promise.all([clearJob(message.requestId), queueTerminal(message)]).then(() => ({ accepted: true })).catch((error) => ({ accepted: false, error: error.message })); }
  if (message?.type === 'connection-status') return Promise.resolve({ status: connectionStatus, error: connectionError });
});
api.storage.onChanged.addListener((changes, area) => { if (area === 'sync' && ('relayUrl' in changes || 'relayToken' in changes)) { socket?.close(1000, 'Configuration changed'); connect(); } });
api.alarms.create('relay-reconnect', { periodInMinutes: 0.5 });
api.alarms.onAlarm.addListener(() => { if (socket?.readyState !== WebSocket.OPEN) connect(); });
connect();
