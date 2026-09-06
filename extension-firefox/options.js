const relayUrl = document.querySelector('#relayUrl');
const relayToken = document.querySelector('#relayToken');
const status = document.querySelector('#status');

chrome.storage.sync.get({ relayUrl: 'ws://127.0.0.1:8788', relayToken: '' }).then((settings) => {
  relayUrl.value = settings.relayUrl;
  relayToken.value = settings.relayToken;
});
async function refreshStatus() {
  const result = await chrome.runtime.sendMessage({ type: 'connection-status' });
  status.textContent = ` ${result.status}${result.error ? `: ${result.error}` : ''}`;
}

document.querySelector('#save').addEventListener('click', async () => {
  await chrome.storage.sync.set({ relayUrl: relayUrl.value.trim(), relayToken: relayToken.value });
  status.textContent = ' Saved. Reconnecting...';
});
document.querySelector('#refresh').addEventListener('click', refreshStatus);
refreshStatus();
