/** Prototype startup errors are isolated from the chat's startup/readiness. */
function startOptionalPrototype({ start, logger, intervalMs = 5_000 }) {
  let stopped = false;
  let running = false;
  let started = false;
  async function attempt() {
    if (stopped || running || started) return;
    running = true;
    try {
      const runtime = await start();
      if (stopped) await runtime?.stop?.();
      else started = runtime != null;
    }
    catch { logger?.warn?.('[Prototype] Optional service is unavailable; ordinary chat remains enabled.'); }
    finally { running = false; }
  }
  const timer = setInterval(() => { void attempt(); }, intervalMs);
  timer.unref?.();
  void attempt();
  return () => { stopped = true; clearInterval(timer); };
}
module.exports = { startOptionalPrototype };
