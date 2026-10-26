const { runPrototypeEventLoop } = require('./PrototypeEventStream');
const { runPrototypeOutboxLoop } = require('./PrototypeOutboxPublisher');

function delay(ms, signal) {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });
}

async function runPrototypeReconcilerLoop({ reconcile, signal, intervalMs = 5_000, onError }) {
  while (!signal.aborted) {
    try { await reconcile(); } catch (error) { if (!signal.aborted) onError?.(error); }
    if (!signal.aborted) await delay(intervalMs, signal);
  }
}

class PrototypeTransportRuntime {
  constructor({ outboxPublisher, eventSource, eventConsumer, reconcile, close, onError }) {
    this.outboxPublisher = outboxPublisher;
    this.eventSource = eventSource;
    this.eventConsumer = eventConsumer;
    this.reconcile = reconcile;
    this.close = close;
    this.onError = onError;
    this.controller = null;
    this.loops = [];
    this.ready = false;
  }

  async start() {
    if (this.controller) throw new Error('Prototype transport runtime is already started');
    this.controller = new AbortController();
    await this.eventSource.ensureGroup();
    const signal = this.controller.signal;
    this.loops = [
      runPrototypeOutboxLoop({ publisher: this.outboxPublisher, signal, onError: this.onError }),
      runPrototypeEventLoop({
        source: this.eventSource, consumer: this.eventConsumer, signal, onError: this.onError,
        ensureGroup: false,
      }),
      runPrototypeReconcilerLoop({ reconcile: this.reconcile, signal, onError: this.onError }),
    ];
    this.ready = true;
  }

  isReady() { return this.ready; }

  async stop() {
    if (!this.controller) return;
    this.ready = false;
    this.controller.abort('shutdown');
    await this.eventSource.close?.();
    await this.close?.();
    await Promise.allSettled(this.loops);
    this.controller = null;
    this.loops = [];
  }
}

module.exports = {
  PrototypeTransportRuntime,
  runPrototypeReconcilerLoop,
};
