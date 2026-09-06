let socket;
let reconnectTimer;
let connectionStatus = 'Not configured';
let connectionError = '';
const tabQueues = new Map();
const assignments = new Map();
const captureWaiters = new Map();

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
function queue(tabId, task) { const previous = tabQueues.get(tabId) || Promise.resolve(); const next = previous.catch(() => {}).then(task); tabQueues.set(tabId, next.finally(() => { if (tabQueues.get(tabId) === next) tabQueues.delete(tabId); })); return next; }
function send(message) { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message)); }
function waitForCapture(id) { return new Promise((resolve) => captureWaiters.set(id, resolve)); }
function settle(message) { const resolve = captureWaiters.get(message.requestId); if (resolve) { captureWaiters.delete(message.requestId); resolve(); } }
async function ensure(tabId) { try { return await api.tabs.sendMessage(tabId, { type: 'assistant-state', provider: 'chatgpt' }); } catch { await api.scripting.executeScript({ target: { tabId }, files: ['content.js'] }); return api.tabs.sendMessage(tabId, { type: 'assistant-state', provider: 'chatgpt' }); } }
async function freshChat(tabId, message, provider) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await activate(tabId); await api.tabs.sendMessage(tabId, { type: 'new-chat', provider: provider.name });
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) { const state = await ensure(tabId).catch(() => null); if (state?.composerAvailable && !state.assistantText) { send({ type: 'response', requestId: message.requestId, response: 'new chat started' }); return; } await sleep(250); }
  }
  throw new Error('Timed out waiting for a fresh provider chat.');
}
async function submit(tabId, message, provider) {
  await activate(tabId); const state = await ensure(tabId); if (!state?.composerAvailable) throw new Error('Prompt composer was not found.');
  send({ type: 'accepted', requestId: message.requestId });
  const submitted = await api.tabs.sendMessage(tabId, { type: 'submit-prompt', provider: provider.name, prompt: message.prompt });
  const captured = waitForCapture(message.requestId);
  await api.tabs.sendMessage(tabId, { type: 'capture-response', provider: provider.name, requestId: message.requestId, previousAssistantText: submitted.previousAssistantText });
  await captured;
}
async function connect() {
  clearTimeout(reconnectTimer); const { relayUrl, relayToken } = await config(); if (!relayToken) { connectionStatus = 'Not configured'; return; }
  socket = new WebSocket(relayUrl); connectionStatus = 'Connecting';
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'authenticate', role: 'extension', token: relayToken })));
  socket.addEventListener('message', async ({ data }) => { const message = JSON.parse(data); if (message.type === 'authenticated') { connectionStatus = 'Connected'; return; } if (message.type !== 'request') return; const provider = providerFor(message.provider); try { const tab = await workerTab(provider, workerKey(message)); queue(tab.id, () => message.metadata?.action === 'new_chat' ? freshChat(tab.id, message, provider) : submit(tab.id, message, provider)).catch((error) => send({ type: 'error', requestId: message.requestId, error: error.message })); } catch (error) { send({ type: 'error', requestId: message.requestId, error: error.message }); } });
  socket.addEventListener('close', () => { connectionStatus = 'Disconnected'; reconnectTimer = setTimeout(connect, 3000); });
  socket.addEventListener('error', () => { connectionError = 'Could not connect to the relay.'; socket.close(); });
}
api.runtime.onMessage.addListener((message, sender) => { if (['accepted', 'progress', 'response', 'error'].includes(message?.type)) { if (message.type === 'progress' && message.state === 'response_waiting' && sender.tab?.id) activate(sender.tab.id).catch(() => {}); if (['response', 'error'].includes(message.type)) settle(message); send(message); } if (message?.type === 'connection-status') return Promise.resolve({ status: connectionStatus, error: connectionError }); });
api.storage.onChanged.addListener((changes, area) => { if (area === 'sync' && ('relayUrl' in changes || 'relayToken' in changes)) connect(); });
api.alarms.create('relay-reconnect', { periodInMinutes: 0.5 }); api.alarms.onAlarm.addListener(() => { if (socket?.readyState !== WebSocket.OPEN) connect(); }); connect();
