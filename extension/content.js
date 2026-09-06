if (!globalThis.__localAiRelayContentLoaded) {
  globalThis.__localAiRelayContentLoaded = true;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

function composer(provider = 'chatgpt') {
  return document.querySelector(provider === 'gemini'
    ? '.ql-editor[contenteditable="true"], rich-textarea [contenteditable="true"]'
    : '#prompt-textarea, textarea[name="prompt-textarea"], [contenteditable="true"][role="textbox"]');
}

function assistantText(provider = 'chatgpt') {
  const messages = document.querySelectorAll(provider === 'gemini' ? 'model-response .model-response-text, model-response message-content, .model-response-text' : '[data-message-author-role="assistant"]');
  return messages.length ? messages[messages.length - 1].innerText.trim() : '';
}

function isIncompleteThinking(text) {
  const opening = text.indexOf('<think>');
  return opening >= 0 && text.indexOf('</think>', opening) < 0;
}

function finalAnswerText(text) {
  return text.replace(/^<think>\s*[\s\S]*?<\/think>\s*/, '').trim();
}

function setComposerText(input, text) {
  input.focus();
  if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')?.set;
    setter?.call(input, text);
  } else {
    input.textContent = text;
  }
  input.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
}

function submitPrompt(provider, text) {
  const input = composer(provider);
  if (!input) throw new Error('Prompt composer was not found.');
  const previousAssistantText = assistantText(provider);
  setComposerText(input, text);
  const sendButton = document.querySelector('[data-testid="send-button"], #composer-submit-button, button[aria-label*="Send" i]');
  if (!sendButton || sendButton.disabled) throw new Error('Send button was not available.');
  sendButton.click();
  return { previousAssistantText };
}

async function captureResponse(message) {
  const previous = message.previousAssistantText || '';
  const deadline = Date.now() + 600000;
  let stable = 0;
  let last = '';
  let lastHeartbeat = 0;
  while (Date.now() < deadline) {
    if (Date.now() - lastHeartbeat >= 20000) {
      chrome.runtime.sendMessage({ type: 'progress', requestId: message.requestId, state: 'response_waiting' });
      lastHeartbeat = Date.now();
    }
    const current = assistantText(message.provider || 'chatgpt');
    if (isIncompleteThinking(current)) {
      stable = 0;
      last = '';
      await sleep(500);
      continue;
    }
    const answer = finalAnswerText(current);
    if (answer && current !== previous && !last) {
      chrome.runtime.sendMessage({ type: 'progress', requestId: message.requestId, state: 'response_started' });
    }
    if (answer && current !== previous && answer === last) stable += 1;
    else stable = 0;
    last = answer;
    if (stable >= 4 && !document.querySelector('button[aria-label*="Stop" i]')) {
      // Preserve the complete assistant response, including any <think>...</think>
      // reasoning section. `answer` is still used above for stability detection.
      return current.trim();
    }
    await sleep(500);
  }
  throw new Error('Timed out waiting for ChatGPT response.');
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'assistant-state') {
    sendResponse({ composerAvailable: Boolean(composer(message.provider)), assistantText: assistantText(message.provider) });
    return;
  }
  if (message?.type === 'new-chat') {
    const selector = message.provider === 'gemini'
      ? 'button[aria-label*="new chat" i], a[aria-label*="new chat" i]'
      : 'a[aria-label*="new chat" i], button[aria-label*="new chat" i]';
    const control = document.querySelector(selector);
    if (!control) throw new Error('New chat control was not found.');
    control.click();
    sendResponse({ started: true });
    return;
  }
  if (message?.type === 'submit-prompt') {
    sendResponse(submitPrompt(message.provider || 'chatgpt', message.prompt || ''));
    return;
  }
  if (message?.type !== 'capture-response') return;
  captureResponse(message)
    .then((response) => chrome.runtime.sendMessage({ type: 'response', requestId: message.requestId, response }))
    .catch((error) => chrome.runtime.sendMessage({ type: 'error', requestId: message.requestId, error: error.message }));
});
}
