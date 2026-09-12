const test = require('node:test');
const assert = require('node:assert/strict');
const { createCaptureState, observeCapture } = require('../extension/response-state');

test('accepts an identical answer when it belongs to a new assistant turn', () => {
  const state = createCaptureState({ text: 'same answer', key: 'turn-1', count: 1 }, 1000);
  assert.equal(observeCapture(state, { text: 'same answer', key: 'turn-2', count: 2 }, false, 0).complete, false);
  const result = observeCapture(state, { text: 'same answer', key: 'turn-2', count: 2 }, false, 1000);
  assert.equal(result.complete, true);
  assert.equal(result.response, 'same answer');
});

test('does not finish while the provider is still generating', () => {
  const state = createCaptureState({ text: '', key: '', count: 0 }, 1000);
  observeCapture(state, { text: 'partial', key: 'turn-1', count: 1 }, true, 0);
  assert.equal(observeCapture(state, { text: 'partial', key: 'turn-1', count: 1 }, true, 5000).complete, false);
  assert.equal(observeCapture(state, { text: 'partial', key: 'turn-1', count: 1 }, false, 5000).complete, true);
});

test('resets the quiet period whenever response text changes', () => {
  const state = createCaptureState({ text: '', key: '', count: 0 }, 1000);
  observeCapture(state, { text: 'first', key: 'turn-1', count: 1 }, false, 0);
  observeCapture(state, { text: 'second', key: 'turn-1', count: 1 }, false, 900);
  assert.equal(observeCapture(state, { text: 'second', key: 'turn-1', count: 1 }, false, 1500).complete, false);
  assert.equal(observeCapture(state, { text: 'second', key: 'turn-1', count: 1 }, false, 1900).complete, true);
});

test('keeps tracking a new turn if its final text equals the baseline', () => {
  const state = createCaptureState({ text: 'final', key: '', count: 1 }, 1000);
  observeCapture(state, { text: 'f', key: '', count: 1 }, false, 0);
  observeCapture(state, { text: 'final', key: '', count: 1 }, false, 500);
  assert.equal(observeCapture(state, { text: 'final', key: '', count: 1 }, false, 1500).complete, true);
});

test('waits for a closing think tag and returns the complete raw response', () => {
  const state = createCaptureState({ text: '', key: '', count: 0 }, 1000);
  assert.equal(observeCapture(state, { text: '<think>work', key: 'turn-1', count: 1 }, false, 0).complete, false);
  observeCapture(state, { text: '<think>work</think>answer', key: 'turn-1', count: 1 }, false, 1000);
  const result = observeCapture(state, { text: '<think>work</think>answer', key: 'turn-1', count: 1 }, false, 2000);
  assert.equal(result.complete, true);
  assert.equal(result.response, '<think>work</think>answer');
});
