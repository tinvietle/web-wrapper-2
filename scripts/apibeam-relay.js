#!/usr/bin/env node

const http = require('node:http');
const { timingSafeEqual } = require('node:crypto');
const { WebSocketServer, WebSocket } = require('ws');

const port = Number.parseInt(process.env.APIBEAM_RELAY_PORT || '8787', 10);
const host = process.env.APIBEAM_RELAY_HOST || '127.0.0.1';
const token = process.env.APIBEAM_RELAY_TOKEN || '';

if (!token) {
  console.error('Set APIBEAM_RELAY_TOKEN before starting the relay.');
  process.exit(1);
}

function matchesToken(value) {
  const received = Buffer.from(String(value || ''));
  const expected = Buffer.from(token);
  return received.length === expected.length && timingSafeEqual(received, expected);
}

const server = http.createServer((request, response) => {
  if (request.url !== '/health') {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({
    status: 'ok',
    extensionConnected: Boolean(extensionSocket),
    pendingRequests: [...requests.entries()].map(([requestId, request]) => ({
      requestId,
      state: request.state,
      ageMs: Date.now() - request.startedAt,
    })),
  }));
});
const sockets = new WebSocketServer({ server });
let extensionSocket = null;
const requests = new Map();

function send(socket, message) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}

sockets.on('connection', (socket) => {
  socket.role = null;
  socket.on('message', (raw) => {
    let message;
    try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: 'error', error: 'Invalid JSON message.' }); }

    if (!socket.role) {
      if (message.type !== 'authenticate' || !['client', 'extension'].includes(message.role) || !matchesToken(message.token)) {
        socket.close(1008, 'Authentication required');
        return;
      }
      socket.role = message.role;
      if (socket.role === 'extension') {
        if (extensionSocket && extensionSocket !== socket) extensionSocket.close(1000, 'Replaced by a newer extension connection');
        extensionSocket = socket;
      }
      return send(socket, { type: 'authenticated', role: socket.role });
    }

    if (socket.role === 'client' && message.type === 'request') {
      if (!message.requestId || typeof message.prompt !== 'string') return send(socket, { type: 'error', requestId: message.requestId, error: 'requestId and prompt are required.' });
      if (!extensionSocket) return send(socket, { type: 'error', requestId: message.requestId, error: 'No authenticated browser extension is connected.' });
      requests.set(message.requestId, { client: socket, state: 'forwarded', startedAt: Date.now() });
      return send(extensionSocket, { type: 'request', requestId: message.requestId, provider: message.provider, prompt: message.prompt, metadata: message.metadata || {} });
    }

    if (socket.role === 'extension' && message.type === 'accepted') {
      const request = requests.get(message.requestId);
      if (request) request.state = 'accepted_by_extension';
      return;
    }

    if (socket.role === 'extension' && message.type === 'progress') {
      const request = requests.get(message.requestId);
      if (request && typeof message.state === 'string') request.state = message.state;
      return;
    }

    if (socket.role === 'extension' && ['response', 'error'].includes(message.type)) {
      const request = requests.get(message.requestId);
      requests.delete(message.requestId);
      if (request) send(request.client, message);
    }
  });

  socket.on('close', () => {
    if (extensionSocket === socket) {
      extensionSocket = null;
      for (const [requestId, request] of requests) {
        requests.delete(requestId);
        send(request.client, {
          type: 'error',
          requestId,
          error: 'Browser extension disconnected before returning a response.',
        });
      }
    }
    for (const [requestId, request] of requests) {
      if (request.client === socket) requests.delete(requestId);
    }
  });
});

server.listen(port, host, () => console.log(`ApiBeam-style relay listening at ws://${host}:${port}`));
