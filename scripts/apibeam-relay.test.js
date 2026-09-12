const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { WebSocket } = require('ws');

const port = 18787;
const relayUrl = `ws://127.0.0.1:${port}`;
const token = 'relay-test-token';

function nextMessage(socket, predicate = () => true, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error('Timed out waiting for WebSocket message.')), timeoutMs);
    const onMessage = (raw) => {
      const message = JSON.parse(raw.toString());
      if (predicate(message)) finish(null, message);
    };
    const finish = (error, message) => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      if (error) reject(error); else resolve(message);
    };
    socket.on('message', onMessage);
  });
}

async function connect(role) {
  const socket = new WebSocket(relayUrl);
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  socket.send(JSON.stringify({ type: 'authenticate', role, token }));
  await nextMessage(socket, (message) => message.type === 'authenticated');
  return socket;
}

test('keeps requests through an extension reconnect and acknowledges terminal delivery', async (t) => {
  const relay = spawn(process.execPath, ['scripts/apibeam-relay.js'], {
    cwd: process.cwd(),
    env: { ...process.env, APIBEAM_RELAY_PORT: String(port), APIBEAM_RELAY_TOKEN: token, EXTENSION_RECONNECT_GRACE_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => relay.kill());
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Relay did not start.')), 3000);
    relay.stdout.on('data', (chunk) => { if (chunk.toString().includes('listening')) { clearTimeout(timeout); resolve(); } });
    relay.once('exit', (code) => reject(new Error(`Relay exited early (${code}).`)));
  });

  const extension = await connect('extension');
  const client = await connect('client');
  t.after(() => { extension.close(); client.close(); });
  client.send(JSON.stringify({ type: 'request', requestId: 'reconnect-1', prompt: 'hello' }));
  await nextMessage(extension, (message) => message.type === 'request');
  extension.close();

  const replacement = await connect('extension');
  t.after(() => replacement.close());
  replacement.send(JSON.stringify({ type: 'response', requestId: 'reconnect-1', response: 'done' }));
  const [response, acknowledgement] = await Promise.all([
    nextMessage(client, (message) => message.type === 'response'),
    nextMessage(replacement, (message) => message.type === 'delivery_ack'),
  ]);
  assert.equal(response.response, 'done');
  assert.equal(acknowledgement.requestId, 'reconnect-1');

  client.send(JSON.stringify({ type: 'request', requestId: 'cancel-1', prompt: 'slow' }));
  await nextMessage(replacement, (message) => message.type === 'request' && message.requestId === 'cancel-1');
  client.send(JSON.stringify({ type: 'cancel', requestId: 'cancel-1' }));
  const cancellation = await nextMessage(replacement, (message) => message.type === 'cancel');
  assert.equal(cancellation.requestId, 'cancel-1');
});
