#!/usr/bin/env node

const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULTS = Object.freeze({
  inputDir: path.resolve(process.cwd(), process.env.INPUT_DIR || 'input'),
  outputDir: path.resolve(process.cwd(), process.env.OUTPUT_DIR || 'output'),
  promptFile: path.resolve(process.cwd(), process.env.PROMPT_FILE || 'prompt.txt'),
  relayUrl: process.env.APIBEAM_RELAY_URL || 'ws://127.0.0.1:8787',
  relayToken: process.env.APIBEAM_RELAY_TOKEN || '',
  provider: process.env.APIBEAM_PROVIDER || 'chatgpt',
  responseTimeoutMs: positiveInteger(process.env.RESPONSE_TIMEOUT_MS, 600000),
  connectTimeoutMs: positiveInteger(process.env.CONNECT_TIMEOUT_MS, 30000),
  interRequestDelayMs: nonNegativeInteger(process.env.INTER_REQUEST_DELAY_MS, 5000),
  retryAttempts: positiveInteger(process.env.RETRY_ATTEMPTS, 3),
  retryBaseDelayMs: positiveInteger(process.env.RETRY_BASE_DELAY_MS, 5000),
  chatBatchSize: positiveInteger(process.env.CHAT_BATCH_SIZE, 20),
  parallelTabs: positiveInteger(process.env.PARALLEL_TABS, 1),
  limit: 0,
  allowUnauthenticatedLocal: false,
  resume: true,
  dryRun: false,
});

function printHelp() {
  console.log(`Usage: node scripts/apibeam-batch.js [options]

Sends cases to a self-hosted, ApiBeam-compatible WebSocket relay and writes the
raw response to a same-named file in the output directory.

Options:
  --input-dir <path>                Input directory
  --output-dir <path>               Output directory
  --prompt-file <path>              Instructions prepended to every independent case
  --relay-url <ws(s)://url>         Self-hosted relay WebSocket URL
  --relay-token <token>             Shared relay token (or APIBEAM_RELAY_TOKEN)
  --provider <name>                 Provider routing label, default: chatgpt
  --response-timeout-ms <ms>        Max wait for a response
  --connect-timeout-ms <ms>         Max wait for relay connection
  --inter-request-delay-ms <ms>     Cooldown between completed cases
  --retry-attempts <n>              Attempts per case, default: 3
  --retry-base-delay-ms <ms>        Initial retry delay; doubles per attempt
  --limit <n>                       Process at most n pending cases
  --chat-batch-size <n>             Cases per fresh provider chat, default: 20
  --parallel-tabs <n>               Dedicated provider tabs to use, default: 1
  --allow-unauthenticated-local     Allow ws://127.0.0.1 without a relay token
  --resume                          Skip existing outputs (default)
  --force                           Re-run every input file
  --dry-run                         Print the plan without connecting
  --help                            Show this help text
`);
}

function buildOptions(argv) {
  const options = { ...DEFAULTS };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--help': case '-h': options.help = true; break;
      case '--dry-run': options.dryRun = true; break;
      case '--force': options.resume = false; break;
      case '--resume': options.resume = true; break;
      case '--allow-unauthenticated-local': options.allowUnauthenticatedLocal = true; break;
      case '--input-dir': options.inputDir = resolveValue(flag, argv[++index]); break;
      case '--output-dir': options.outputDir = resolveValue(flag, argv[++index]); break;
      case '--prompt-file': options.promptFile = resolveValue(flag, argv[++index]); break;
      case '--relay-url': options.relayUrl = requireValue(flag, argv[++index]); break;
      case '--relay-token': options.relayToken = requireValue(flag, argv[++index]); break;
      case '--provider': options.provider = requireValue(flag, argv[++index]); break;
      case '--response-timeout-ms': options.responseTimeoutMs = requirePositiveInteger(flag, argv[++index]); break;
      case '--connect-timeout-ms': options.connectTimeoutMs = requirePositiveInteger(flag, argv[++index]); break;
      case '--inter-request-delay-ms': options.interRequestDelayMs = requireNonNegativeInteger(flag, argv[++index]); break;
      case '--retry-attempts': options.retryAttempts = requirePositiveInteger(flag, argv[++index]); break;
      case '--retry-base-delay-ms': options.retryBaseDelayMs = requirePositiveInteger(flag, argv[++index]); break;
      case '--limit': options.limit = requirePositiveInteger(flag, argv[++index]); break;
      case '--chat-batch-size': options.chatBatchSize = requirePositiveInteger(flag, argv[++index]); break;
      case '--parallel-tabs': options.parallelTabs = requirePositiveInteger(flag, argv[++index]); break;
      default: throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

function requireValue(flag, value) {
  if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
  return value;
}

function resolveValue(flag, value) { return path.resolve(requireValue(flag, value)); }

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
  const parsed = Number.parseInt(String(value), 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function requirePositiveInteger(flag, value) {
  const parsed = positiveInteger(value, 0);
  if (!parsed) throw new Error(`${flag} requires a positive integer`);
  return parsed;
}

function requireNonNegativeInteger(flag, value) {
  const parsed = nonNegativeInteger(value, -1);
  if (parsed < 0) throw new Error(`${flag} requires a non-negative integer`);
  return parsed;
}

function validateRelayConfiguration(options) {
  let relay;
  try { relay = new URL(options.relayUrl); } catch { throw new Error('--relay-url must be a valid ws:// or wss:// URL'); }
  if (!['ws:', 'wss:'].includes(relay.protocol)) throw new Error('--relay-url must use ws:// or wss://');
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(relay.hostname);
  if (!options.relayToken && !(isLoopback && options.allowUnauthenticatedLocal)) {
    throw new Error('Set APIBEAM_RELAY_TOKEN or pass --relay-token. For a local prototype only, add --allow-unauthenticated-local.');
  }
  if (!isLoopback && relay.protocol !== 'wss:') throw new Error('A non-local relay must use wss:// to protect prompts and responses in transit.');
}

function buildCasePrompt(caseText) {
  return caseText.trim();
}

class RelayClient {
  constructor(options) { this.options = options; this.socket = null; this.pending = new Map(); }

  async connect() {
    if (this.socket?.readyState === WebSocket.OPEN) return;
    this.socket = new WebSocket(this.options.relayUrl);
    this.socket.addEventListener('message', (event) => this.handleMessage(event.data));
    this.socket.addEventListener('close', () => this.failPending(new Error('Relay connection closed.')));
    this.socket.addEventListener('error', () => this.failPending(new Error('Relay connection failed.')));
    await waitForSocketOpen(this.socket, this.options.connectTimeoutMs);
    await this.authenticate();
  }

  authenticate() {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => finish(new Error('Relay authentication timed out.')), this.options.connectTimeoutMs);
      const onMessage = (event) => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.type === 'authenticated' && message.role === 'client') finish();
        if (message.type === 'error') finish(new Error(message.error || 'Relay authentication failed.'));
      };
      const finish = (error) => {
        clearTimeout(timeout);
        this.socket.removeEventListener('message', onMessage);
        this.socket.removeEventListener('close', onClose);
        if (error) reject(error); else resolve();
      };
      const onClose = (event) => finish(new Error(`Relay authentication failed: ${event.reason || `connection closed (${event.code})`}.`));
      this.socket.addEventListener('message', onMessage);
      this.socket.addEventListener('close', onClose, { once: true });
      this.socket.send(JSON.stringify({ type: 'authenticate', role: 'client', token: this.options.relayToken }));
    });
  }

  async request({ prompt, fileName, action = 'case', workerId = 'default' }) {
    await this.connect();
    const requestId = randomUUID();
    const payload = { type: 'request', requestId, token: this.options.relayToken || undefined, provider: this.options.provider, prompt, metadata: { fileName, action, workerId, responseTimeoutMs: this.options.responseTimeoutMs } };
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify({ type: 'cancel', requestId }));
        reject(new Error(`Timed out waiting for relay response after ${this.options.responseTimeoutMs}ms.`));
      }, this.options.responseTimeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout, state: 'sent' });
      this.socket.send(JSON.stringify(payload));
    });
  }

  handleMessage(rawMessage) {
    let message;
    try { message = JSON.parse(String(rawMessage)); } catch { return; }
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (message.type === 'accepted' || message.type === 'progress') {
      const state = message.type === 'accepted' ? 'accepted_by_extension' : message.state;
      if (state && state !== pending.state) {
        pending.state = state;
        console.log(`  Relay state: ${state}`);
      }
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.requestId);
    if (message.type === 'response' && typeof message.response === 'string') return pending.resolve(message.response);
    pending.reject(new Error(message.error || 'Relay returned an invalid response message.'));
  }

  failPending(error) {
    for (const pending of this.pending.values()) { clearTimeout(pending.timeout); pending.reject(error); }
    this.pending.clear();
  }

  close() { this.socket?.close(); }
}

function waitForSocketOpen(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out connecting to relay after ${timeoutMs}ms.`)), timeoutMs);
    const onOpen = () => finish();
    const onError = () => finish(new Error('Could not connect to relay.'));
    const finish = (error) => {
      clearTimeout(timeout);
      socket.removeEventListener('open', onOpen);
      socket.removeEventListener('error', onError);
      if (error) reject(error); else resolve();
    };
    socket.addEventListener('open', onOpen, { once: true });
    socket.addEventListener('error', onError, { once: true });
  });
}

async function listInputFiles(inputDir) {
  const entries = await fs.readdir(inputDir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => path.join(inputDir, entry.name)).sort();
}

async function hasOutput(outputFile) {
  try { await fs.access(outputFile); return true; } catch { return false; }
}

async function retryCase(client, request, options) {
  let lastError;
  for (let attempt = 1; attempt <= options.retryAttempts; attempt += 1) {
    try {
      return await client.request(request);
    } catch (error) {
      lastError = error;
      if (attempt < options.retryAttempts) {
        const delayMs = options.retryBaseDelayMs * 2 ** (attempt - 1);
        console.error(`  Attempt ${attempt}/${options.retryAttempts} failed: ${error.message}. Retrying in ${delayMs}ms.`);
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

function sleep(milliseconds) { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function formatDuration(milliseconds) {
  const totalSeconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

function formatProgress({ completed, total, succeeded, failed, startedAt }) {
  const elapsedMs = Date.now() - startedAt;
  const averageMs = completed ? elapsedMs / completed : 0;
  const remainingMs = averageMs * (total - completed);
  const width = 24;
  const filled = total ? Math.round((completed / total) * width) : 0;
  const bar = `${'#'.repeat(filled)}${'-'.repeat(width - filled)}`;
  const percentage = total ? ((completed / total) * 100).toFixed(1) : '0.0';
  return `Progress: [${bar}] ${completed}/${total} (${percentage}%) | ${succeeded} succeeded, ${failed} failed | ${averageMs ? `${(averageMs / 1000).toFixed(1)}s/case` : 'calculating rate'} | elapsed ${formatDuration(elapsedMs)} | ETA ${completed ? formatDuration(remainingMs) : 'calculating'}`;
}

async function filterPendingFiles(inputFiles, outputDir) {
  const pending = [];
  for (const inputFile of inputFiles) {
    if (!(await hasOutput(path.join(outputDir, path.basename(inputFile)))) ) pending.push(inputFile);
  }
  return pending;
}

function distributeFiles(files, workerCount) {
  const workers = Array.from({ length: workerCount }, () => []);
  for (let index = 0; index < files.length; index += 1) workers[index % workerCount].push(files[index]);
  return workers;
}

async function processWorker({ workerId, files, instructions, options, progress, startedAt }) {
  const client = new RelayClient(options);
  let succeeded = 0;
  let failed = 0;
  try {
    for (let index = 0; index < files.length; index += 1) {
      const inputFile = files[index];
      const fileName = path.basename(inputFile);
      if (index % options.chatBatchSize === 0) {
        const chatNumber = Math.floor(index / options.chatBatchSize) + 1;
        console.log(`[${workerId}] Starting fresh chat ${chatNumber} and priming ${path.basename(options.promptFile)}.`);
        await retryCase(client, { action: 'new_chat', fileName: 'new-chat', prompt: '', workerId }, options);
        await sleep(1000);
        await retryCase(client, { action: 'prime', fileName: path.basename(options.promptFile), prompt: instructions, workerId }, options);
        await sleep(options.interRequestDelayMs);
      }
      console.log(`[${workerId}] Processing ${index + 1}/${files.length}: ${fileName}`);
      try {
        const caseText = await fs.readFile(inputFile, 'utf8');
        const response = await retryCase(client, { fileName, prompt: buildCasePrompt(caseText), workerId }, options);
        await fs.writeFile(path.join(options.outputDir, fileName), `${response.trim()}\n`, 'utf8');
        succeeded += 1;
        progress.succeeded += 1;
      } catch (error) {
        failed += 1;
        progress.failed += 1;
        console.error(`  [${workerId}] Failed ${fileName}: ${error.message}`);
      }
      progress.completed += 1;
      console.log(formatProgress({ ...progress, total: progress.total, startedAt }));
      if (index < files.length - 1 && options.interRequestDelayMs > 0) await sleep(options.interRequestDelayMs);
    }
  } finally {
    client.close();
  }
  return { succeeded, failed };
}

async function main() {
  const options = buildOptions(process.argv.slice(2));
  if (options.help) return printHelp();
  validateRelayConfiguration(options);
  await fs.mkdir(options.outputDir, { recursive: true });
  const [instructions, inputFiles] = await Promise.all([fs.readFile(options.promptFile, 'utf8'), listInputFiles(options.inputDir)]);
  if (!inputFiles.length) throw new Error(`No input files found in ${options.inputDir}`);
  const allPendingFiles = options.resume ? await filterPendingFiles(inputFiles, options.outputDir) : inputFiles;
  const pendingFiles = options.limit ? allPendingFiles.slice(0, options.limit) : allPendingFiles;
  console.log(`Relay: ${options.relayUrl}`);
  console.log(`Provider: ${options.provider}`);
  console.log(`Parallel tabs: ${options.parallelTabs}`);
  console.log('Validation: disabled (raw responses are saved)');
  console.log(`Pending files: ${pendingFiles.length}/${allPendingFiles.length} selected (${inputFiles.length} total)`);
  if (options.dryRun || !pendingFiles.length) return;
  const startedAt = Date.now();
  const workerCount = Math.min(options.parallelTabs, pendingFiles.length);
  const progress = { completed: 0, succeeded: 0, failed: 0, total: pendingFiles.length };
  const results = await Promise.all(distributeFiles(pendingFiles, workerCount).map((files, index) => processWorker({
    workerId: `worker-${index + 1}`,
    files,
    instructions,
    options,
    progress,
    startedAt,
  })));
  const succeeded = results.reduce((sum, result) => sum + result.succeeded, 0);
  const failed = results.reduce((sum, result) => sum + result.failed, 0);
  const elapsedMs = Date.now() - startedAt;
  const averageMs = pendingFiles.length ? elapsedMs / pendingFiles.length : 0;
  console.log(`Run complete: ${succeeded} succeeded, ${failed} failed | elapsed ${formatDuration(elapsedMs)} | average ${(averageMs / 1000).toFixed(1)}s/case.`);
  if (failed) process.exitCode = 1;
}

module.exports = { buildCasePrompt, buildOptions, formatDuration, formatProgress, validateRelayConfiguration };

if (require.main === module) {
  main().catch((error) => { console.error(error.message); process.exit(1); });
}
