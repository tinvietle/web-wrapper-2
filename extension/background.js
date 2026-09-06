let socket;
let reconnectTimer;
let connectionStatus = 'Not configured';
let connectionError = '';
const tabQueues = new Map();
const captureWaiters = new Map();
const intentionalDebuggerDetaches = new Set();
let tabAssignmentLock = Promise.resolve();
let jobStorageLock = Promise.resolve();

async function config() {
  return chrome.storage.sync.get({ relayUrl: 'ws://127.0.0.1:8787', relayToken: '' });
}

function workerKey(message) {
  return String(message.metadata?.workerId || 'default');
}

function isProviderTab(tab, provider) {
  const origin = provider.name === 'gemini' ? 'https://gemini.google.com/' : 'https://chatgpt.com/';
  return Boolean(tab?.id && tab.url?.startsWith(origin) && !tab.discarded);
}

async function activateProviderTab(tabId) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.discarded) throw new Error('Assigned provider tab was discarded.');
  if (!tab.active) await chrome.tabs.update(tabId, { active: true });
}

async function providerTab(provider, key) {
  const storageKey = `providerWorkers:${provider.name}`;
  const { [storageKey]: assignments = {} } = await chrome.storage.session.get(storageKey);
  const assignedTabId = assignments[key];
  if (assignedTabId) {
    try {
      const tab = await chrome.tabs.get(assignedTabId);
      if (isProviderTab(tab, provider)) {
        await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
        return tab;
      }
    } catch {
      // The tab was closed. Reassign this worker below.
    }
    delete assignments[key];
  }

  const assignedIds = new Set(Object.values(assignments));
  const tabs = await chrome.tabs.query({ url: provider.tabUrl });
  const available = tabs.filter((tab) => isProviderTab(tab, provider) && !assignedIds.has(tab.id));
  const tab = available.find((candidate) => candidate.active) || available[0];
  if (!tab?.id) {
    throw new Error(`Open another authenticated ${provider.name === 'gemini' ? 'Gemini' : 'ChatGPT'} tab for worker ${key}.`);
  }
  assignments[key] = tab.id;
  await chrome.storage.session.set({ [storageKey]: assignments });
  await chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
  return tab;
}

function assignProviderTab(provider, key) {
  const assignment = tabAssignmentLock.then(() => providerTab(provider, key));
  tabAssignmentLock = assignment.catch(() => {});
  return assignment;
}

async function forgetWorkerTab(provider, key, expectedTabId) {
  const storageKey = `providerWorkers:${provider.name}`;
  const forget = tabAssignmentLock.then(async () => {
    const { [storageKey]: assignments = {} } = await chrome.storage.session.get(storageKey);
    if (assignments[key] !== expectedTabId) return;
    delete assignments[key];
    await chrome.storage.session.set({ [storageKey]: assignments });
  });
  tabAssignmentLock = forget.catch(() => {});
  return forget;
}

function queueTabJob(tabId, job) {
  const previous = tabQueues.get(tabId) || Promise.resolve();
  const scheduled = previous.catch(() => {}).then(job);
  const cleanup = scheduled.finally(() => {
    if (tabQueues.get(tabId) === cleanup) tabQueues.delete(tabId);
  });
  tabQueues.set(tabId, cleanup);
  return scheduled;
}

function waitForCapture(requestId) {
  return new Promise((resolve) => captureWaiters.set(requestId, resolve));
}

function settleCapture(message) {
  const resolve = captureWaiters.get(message.requestId);
  if (!resolve) return;
  captureWaiters.delete(message.requestId);
  resolve(message);
}

async function saveActiveJob(provider, key, tabId, message) {
  const storageKey = 'activeProviderJobs';
  const jobKey = `${provider.name}:${key}`;
  return updateActiveJobs((jobs) => {
    jobs[jobKey] = {
      requestId: message.requestId,
      provider: provider.name,
      workerId: key,
      tabId,
      action: message.metadata?.action || 'case',
      startedAt: Date.now(),
    };
  });
}

async function clearActiveJob(provider, key, requestId) {
  const jobKey = `${provider.name}:${key}`;
  return updateActiveJobs((jobs) => {
    if (jobs[jobKey]?.requestId === requestId) delete jobs[jobKey];
  });
}

async function failJobsForTab(tabId, error) {
  const failed = await updateActiveJobs((jobs) => {
    const matching = [];
    for (const [jobKey, job] of Object.entries(jobs)) {
      if (job.tabId !== tabId) continue;
      delete jobs[jobKey];
      matching.push(job);
    }
    return matching;
  });
  for (const job of failed) send({ type: 'error', requestId: job.requestId, error });
}

function updateActiveJobs(update) {
  const storageKey = 'activeProviderJobs';
  const operation = jobStorageLock.then(async () => {
    const { [storageKey]: jobs = {} } = await chrome.storage.session.get(storageKey);
    const result = update(jobs);
    await chrome.storage.session.set({ [storageKey]: jobs });
    return result;
  });
  jobStorageLock = operation.catch(() => {});
  return operation;
}

async function forgetTab(tabId, reason) {
  await failJobsForTab(tabId, reason);
  const forget = tabAssignmentLock.then(async () => {
    for (const providerName of ['chatgpt', 'gemini']) {
      const storageKey = `providerWorkers:${providerName}`;
      const { [storageKey]: assignments = {} } = await chrome.storage.session.get(storageKey);
      let changed = false;
      for (const [key, assignedTabId] of Object.entries(assignments)) {
        if (assignedTabId !== tabId) continue;
        delete assignments[key];
        changed = true;
      }
      if (changed) await chrome.storage.session.set({ [storageKey]: assignments });
    }
  });
  tabAssignmentLock = forget.catch(() => {});
  await forget;
}

async function connect() {
  clearTimeout(reconnectTimer);
  const { relayUrl, relayToken } = await config();
  if (!relayToken) {
    connectionStatus = 'Not configured';
    return;
  }
  connectionStatus = 'Connecting';
  connectionError = '';
  socket = new WebSocket(relayUrl);
  socket.addEventListener('open', () => socket.send(JSON.stringify({ type: 'authenticate', role: 'extension', token: relayToken })));
  socket.addEventListener('message', async (event) => {
    const message = JSON.parse(event.data);
    if (message.type === 'authenticated') {
      connectionStatus = 'Connected';
      return;
    }
    if (message.type !== 'request') return;
    const provider = getProvider(message.provider);
    try {
      const tab = await assignProviderTab(provider, workerKey(message));
      const key = workerKey(message);
      const task = async () => {
        await saveActiveJob(provider, key, tab.id, message);
        try {
          if (message.metadata?.action === 'new_chat') return await startNewChat(tab.id, message, provider);
          return await submitRequest(tab.id, message, provider);
        } catch (error) {
          if (message.metadata?.action === 'new_chat') await forgetWorkerTab(provider, key, tab.id);
          throw error;
        } finally {
          await clearActiveJob(provider, key, message.requestId);
        }
      };
      queueTabJob(tab.id, task).catch((error) => send({ type: 'error', requestId: message.requestId, error: error.message }));
    } catch (error) {
      send({ type: 'error', requestId: message.requestId, error: error.message });
    }
  });
  socket.addEventListener('close', () => {
    if (connectionStatus !== 'Connected') connectionStatus = 'Disconnected';
    reconnectTimer = setTimeout(connect, 3000);
  });
  socket.addEventListener('error', () => {
    connectionError = 'Could not connect. Check the relay URL, token, and that the relay is running.';
    socket.close();
  });
}

async function startNewChat(tabId, message, provider) {
  const selector = provider.name === 'gemini'
    ? 'button[aria-label*="new chat" i], a[aria-label*="new chat" i]'
    : 'a[aria-label*="new chat" i], button[aria-label*="new chat" i]';
  let lastError;
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const debuggee = { tabId };
    try {
      await activateProviderTab(tabId);
      await chrome.debugger.attach(debuggee, '1.3');
      const result = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
        expression: `(() => { const control = document.querySelector(${JSON.stringify(selector)}); if (!control) return false; control.click(); return true; })()`,
        returnByValue: true,
      });
      if (!result.result?.value) throw new Error(`Could not find the ${provider.name} New chat control.`);
      await waitForFreshChat(tabId, provider.name);
      send({ type: 'response', requestId: message.requestId, response: 'new chat started' });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        sendProgress(message.requestId, 'priming_retry');
        await sleep(1000);
      }
    } finally {
      await detachDebugger(debuggee);
    }
  }
  throw lastError;
}

async function waitForFreshChat(tabId, provider) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const state = await ensureContentScript(tabId, provider).catch(() => null);
    if (state?.composerAvailable && !state.assistantText) return;
    await sleep(250);
  }
  throw new Error(`Timed out waiting for a fresh ${provider} chat to become ready.`);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function detachDebugger(debuggee) {
  intentionalDebuggerDetaches.add(debuggee.tabId);
  await chrome.debugger.detach(debuggee).catch(() => {});
  setTimeout(() => intentionalDebuggerDetaches.delete(debuggee.tabId), 1000);
}

function getProvider(name) {
  if (name === 'gemini') return { name, tabUrl: 'https://gemini.google.com/*', composerSelector: '.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"]' };
  if (!name || name === 'chatgpt') return { name: 'chatgpt', tabUrl: 'https://chatgpt.com/*', composerSelector: '#prompt-textarea, textarea[name="prompt-textarea"], [contenteditable="true"][role="textbox"]' };
  throw new Error(`Unsupported provider: ${name}`);
}

async function ensureContentScript(tabId, provider) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: 'assistant-state', provider });
  } catch {
    // A tab opened before the extension was loaded has no content script yet.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content.js'] });
    return chrome.tabs.sendMessage(tabId, { type: 'assistant-state', provider });
  }
}

async function composerStillHasText(debuggee, composerSelector) {
  const result = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
    expression: `(() => {
      const input = document.querySelector(${JSON.stringify(composerSelector)});
      if (!input) return false;
      return Boolean((input.value ?? input.innerText ?? input.textContent ?? '').trim());
    })()`,
    returnByValue: true,
  });
  return Boolean(result.result?.value);
}

async function clickSendButton(debuggee) {
  const result = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
    expression: `(() => {
      const button = document.querySelector('[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send" i]');
      if (!button || button.disabled) return false;
      button.click();
      return true;
    })()`,
    returnByValue: true,
  });
  return Boolean(result.result?.value);
}

async function submitRequest(tabId, message, provider) {
  await activateProviderTab(tabId);
  const state = await ensureContentScript(tabId, provider.name);
  if (!state?.composerAvailable) throw new Error('ChatGPT prompt composer was not found.');

  const debuggee = { tabId };
  let attached = false;
  try {
    await chrome.debugger.attach(debuggee, '1.3');
    attached = true;
    send({ type: 'accepted', requestId: message.requestId });
    sendProgress(message.requestId, 'debugger_attached');

    const focused = await chrome.debugger.sendCommand(debuggee, 'Runtime.evaluate', {
      expression: `(() => {
        const input = document.querySelector(${JSON.stringify(provider.composerSelector)});
        if (!input) return false;
        input.focus();
        return true;
      })()`,
      returnByValue: true,
    });
    if (!focused.result?.value) throw new Error('Could not focus the ChatGPT prompt composer.');
    sendProgress(message.requestId, 'composer_focused');

    await chrome.debugger.sendCommand(debuggee, 'Input.insertText', { text: message.prompt });
    sendProgress(message.requestId, 'text_inserted');
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    await chrome.debugger.sendCommand(debuggee, 'Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
    });
    sendProgress(message.requestId, 'enter_sent');
    await sleep(300);
    if (await composerStillHasText(debuggee, provider.composerSelector)) {
      if (!await clickSendButton(debuggee)) throw new Error('ChatGPT kept the prompt in the composer and its Send button was unavailable.');
      sendProgress(message.requestId, 'send_button_clicked');
    }
  } finally {
    if (attached) await detachDebugger(debuggee);
  }

  const captured = waitForCapture(message.requestId);
  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'capture-response', provider: provider.name, requestId: message.requestId, prompt: message.prompt, previousAssistantText: state.assistantText,
    });
  } catch (error) {
    captureWaiters.delete(message.requestId);
    throw error;
  }
  await captured;
}

function sendProgress(requestId, state) {
  send({ type: 'progress', requestId, state });
}

function send(message) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (['accepted', 'progress', 'response', 'error'].includes(message?.type)) {
    if (message.type === 'progress' && message.state === 'response_waiting' && sender.tab?.id) {
      activateProviderTab(sender.tab.id).catch(() => {});
    }
    if (['response', 'error'].includes(message.type)) settleCapture(message);
    send(message);
  }
  if (message?.type === 'connection-status') {
    sendResponse({ status: connectionStatus, error: connectionError });
  }
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'sync' && ('relayUrl' in changes || 'relayToken' in changes)) connect();
});
chrome.debugger.onDetach.addListener((source, reason) => {
  if (intentionalDebuggerDetaches.has(source.tabId)) {
    intentionalDebuggerDetaches.delete(source.tabId);
    return;
  }
  forgetTab(source.tabId, `Debugger detached from this tab (${reason}). Retry after the tab is ready.`).catch(() => {});
});
chrome.tabs.onRemoved.addListener((tabId) => {
  forgetTab(tabId, 'Assigned provider tab was closed. Retry after opening a replacement tab.').catch(() => {});
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  const leftProvider = typeof changeInfo.url === 'string'
    && !changeInfo.url.startsWith('https://chatgpt.com/')
    && !changeInfo.url.startsWith('https://gemini.google.com/');
  if (changeInfo.discarded || leftProvider) {
    forgetTab(tabId, 'Assigned provider tab was reloaded, discarded, or navigated away. Retry after it is ready.').catch(() => {});
  }
});
chrome.alarms.create('relay-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'relay-reconnect' && socket?.readyState !== WebSocket.OPEN) connect();
});
connect();
