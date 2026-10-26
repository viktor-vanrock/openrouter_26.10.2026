import { errorLogFields } from './service-log.js';

/** Authenticated capability lease; emit transitions, not a line every five seconds. */
export function startServiceHeartbeat({ client, isReady, intervalMs = 5_000, log = () => {} }) {
  let stopped = false;
  let running = false;
  let state;
  let failureCount = 0;
  function transition(next, fields = {}) {
    if (state === next) return;
    state = next;
    log(`heartbeat.${next}`, fields);
  }
  async function beat() {
    if (stopped || running) return;
    running = true;
    try {
      if ((await isReady()) && !stopped) {
        await client.post('/internal/prototype-control/v2/heartbeat', { ready: true });
        transition('available', { failureCount });
        failureCount = 0;
      } else transition('paused');
    } catch (error) {
      failureCount++;
      transition('failed', {
        ...errorLogFields(error, 'PROTOTYPE_HEARTBEAT_FAILED'),
        failureCount,
      });
    } finally {
      running = false;
    }
  }
  const timer = setInterval(() => {
    void beat();
  }, intervalMs);
  timer.unref?.();
  void beat();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
