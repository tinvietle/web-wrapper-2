(function exposeResponseState(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.LocalAiResponseState = api;
})(typeof globalThis === 'object' ? globalThis : this, () => {
  const DEFAULT_QUIET_MS = 2500;
  function isIncompleteThinking(text) { const opening = text.indexOf('<think>'); return opening >= 0 && text.indexOf('</think>', opening) < 0; }
  function finalAnswerText(text) { return text.replace(/^<think>\s*[\s\S]*?<\/think>\s*/, '').trim(); }
  function isNewAssistant(snapshot, baseline) {
    if (!snapshot.text) return false;
    if (snapshot.key && baseline.key && snapshot.key !== baseline.key) return true;
    if (snapshot.count > baseline.count) return true;
    return snapshot.text !== baseline.text;
  }
  function createCaptureState(baseline, quietMs = DEFAULT_QUIET_MS) {
    return { baseline: { text: baseline?.text || '', key: baseline?.key || '', count: Number(baseline?.count) || 0 }, quietMs, lastAnswer: '', stableSince: 0, started: false };
  }
  function observeCapture(state, snapshot, generating, now = Date.now()) {
    const rawText = snapshot?.text || '';
    const answer = finalAnswerText(rawText);
    const isNew = state.started || isNewAssistant({ ...snapshot, text: rawText }, state.baseline);
    const usable = isNew && answer && !isIncompleteThinking(rawText);
    const startedNow = Boolean(usable && !state.started);
    if (!usable) { state.lastAnswer = ''; state.stableSince = 0; return { startedNow, complete: false, response: '' }; }
    state.started = true;
    if (answer !== state.lastAnswer) { state.lastAnswer = answer; state.stableSince = now; }
    const complete = !generating && now - state.stableSince >= state.quietMs;
    return { startedNow, complete, response: complete ? rawText.trim() : '' };
  }
  return { DEFAULT_QUIET_MS, createCaptureState, finalAnswerText, isIncompleteThinking, isNewAssistant, observeCapture };
});
