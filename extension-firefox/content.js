if (!globalThis.__localAiRelayContentLoaded) {
  globalThis.__localAiRelayContentLoaded = true;

const api = globalThis.browser || globalThis.chrome;
const captures = new Map();
const { createCaptureState, observeCapture } = globalThis.LocalAiResponseState;
function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function composer(provider = 'chatgpt') { return document.querySelector(provider === 'gemini' ? '.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"]' : '#prompt-textarea, textarea[name="prompt-textarea"], [contenteditable="true"][role="textbox"]'); }
function assistantElements(provider = 'chatgpt') { return [...document.querySelectorAll(provider === 'gemini' ? 'model-response .model-response-text, model-response message-content, .model-response-text' : '[data-message-author-role="assistant"]')]; }
function assistantSnapshot(provider = 'chatgpt') {
  const messages = assistantElements(provider); const element = messages[messages.length - 1]; const keyed = element?.closest('[data-message-id]') || element;
  return { text: element?.innerText?.trim() || '', count: messages.length, key: keyed?.getAttribute?.('data-message-id') || keyed?.id || '' };
}
function isVisible(element) { if (!element) return false; const style = getComputedStyle(element); return style.display !== 'none' && style.visibility !== 'hidden' && element.getClientRects().length > 0; }
function generationActive(provider = 'chatgpt') {
  const input = composer(provider); const root = input?.closest('form') || input?.parentElement?.parentElement || document;
  const selector = provider === 'gemini' ? 'button[aria-label="Stop response" i], button[aria-label="Stop generating" i]' : '[data-testid="stop-button"], button[aria-label="Stop streaming" i], button[aria-label="Stop generating" i]';
  const controls = [...root.querySelectorAll(selector)]; if (root !== document && provider === 'chatgpt') controls.push(...document.querySelectorAll('[data-testid="stop-button"]'));
  return controls.some(isVisible);
}
function setComposerText(input, text) {
  input.focus();
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) { const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set; setter?.call(input, text); } else input.textContent = text;
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}
function submitPrompt(provider, text) {
  const input = composer(provider); if (!input) throw new Error('Prompt composer was not found.'); const previousAssistant = assistantSnapshot(provider); setComposerText(input, text);
  const sendButton = document.querySelector('[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send" i]'); if (!sendButton || sendButton.disabled) throw new Error('Send button was not available.'); sendButton.click(); return { previousAssistant };
}
function captureResponse(message, signal) {
  const provider = message.provider || 'chatgpt'; const baseline = message.previousAssistant || { text: message.previousAssistantText || '', count: 0, key: '' }; const state = createCaptureState(baseline); const timeoutMs = Math.max(5000, Number(message.captureTimeoutMs) || 590000);
  return new Promise((resolve, reject) => {
    let finished = false; let lastHeartbeat = 0; let evaluationQueued = false;
    const finish = (error, response) => { if (finished) return; finished = true; observer.disconnect(); clearInterval(watchdog); clearTimeout(timeout); signal.removeEventListener('abort', onAbort); if (error) reject(error); else resolve(response); };
    const evaluate = () => { evaluationQueued = false; if (finished) return; const now = Date.now(); if (now - lastHeartbeat >= 20000) { api.runtime.sendMessage({ type: 'progress', requestId: message.requestId, state: 'response_waiting' }).catch(() => {}); lastHeartbeat = now; } const result = observeCapture(state, assistantSnapshot(provider), generationActive(provider), now); if (result.startedNow) api.runtime.sendMessage({ type: 'progress', requestId: message.requestId, state: 'response_started' }).catch(() => {}); if (result.complete) finish(null, result.response); };
    const scheduleEvaluation = () => { if (evaluationQueued || finished) return; evaluationQueued = true; queueMicrotask(evaluate); };
    const onAbort = () => finish(new Error('Response capture was cancelled.'));
    const observer = new MutationObserver(scheduleEvaluation); observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    const watchdog = setInterval(evaluate, 1000); const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${provider} response.`)), timeoutMs); signal.addEventListener('abort', onAbort, { once: true }); evaluate();
  });
}
async function deliverTerminal(message) { let delayMs = 250; for (;;) { try { const acknowledgement = await api.runtime.sendMessage(message); if (acknowledgement?.accepted) return; } catch {} await sleep(delayMs); delayMs = Math.min(delayMs * 2, 5000); } }
api.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'assistant-state') { const snapshot = assistantSnapshot(message.provider); sendResponse({ composerAvailable: Boolean(composer(message.provider)), assistantText: snapshot.text, assistantSnapshot: snapshot }); return; }
  if (message?.type === 'new-chat') { const selector = message.provider === 'gemini' ? 'button[aria-label*="new chat" i], a[aria-label*="new chat" i]' : 'a[aria-label*="new chat" i], button[aria-label*="new chat" i]'; const control = document.querySelector(selector); if (!control) throw new Error('New chat control was not found.'); control.click(); sendResponse({ started: true }); return; }
  if (message?.type === 'submit-prompt') { sendResponse(submitPrompt(message.provider || 'chatgpt', message.prompt || '')); return; }
  if (message?.type === 'cancel-capture') { captures.get(message.requestId)?.abort(); sendResponse({ cancelled: true }); return; }
  if (message?.type !== 'capture-response') return;
  if (captures.has(message.requestId)) { sendResponse({ started: true, duplicate: true }); return; }
  const controller = new AbortController(); captures.set(message.requestId, controller); sendResponse({ started: true });
  captureResponse(message, controller.signal).then((response) => deliverTerminal({ type: 'response', requestId: message.requestId, response })).catch((error) => deliverTerminal({ type: 'error', requestId: message.requestId, error: error.message })).finally(() => captures.delete(message.requestId));
});
}
