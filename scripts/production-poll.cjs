// Return the latest observed state, including after a delayed wake crosses the
// deadline. Never assert on a response fetched before the final timer wait.
async function pollState(read, accepted, {
  timeoutMs = 12000, intervalMs = 250, now = Date.now,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  const deadline = now() + timeoutMs;
  while (true) {
    const state = await read();
    if (accepted(state) || now() >= deadline) return state;
    await sleep(Math.max(0, Math.min(intervalMs, deadline - now())));
  }
}
module.exports = { pollState };
