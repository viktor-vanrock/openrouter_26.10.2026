/** Optional capability state. HTTP handlers read memory, never wait for a remote dependency. */
function createPrototypeAvailability({ now = Date.now, ttlMs = 15_000 } = {}) {
  let transportReady = () => false;
  let heartbeatUntil = 0;
  let store;
  return {
    bindTransport(check) { transportReady = check; },
    unbindTransport() { transportReady = () => false; heartbeatUntil = 0; },
    async heartbeat() {
      const until = now() + ttlMs;
      if (store) await store.updateOne({ _id: 'prototype-service' },
        { $set: { expiresAt: new Date(until) } }, { upsert: true, maxTimeMS: 1_000 });
      heartbeatUntil = until;
    },
    monitor(collection, intervalMs = 5_000) {
      store = collection;
      let stopped = false;
      let running = false;
      async function refresh() {
        if (stopped || running) return;
        running = true;
        let timer;
        try {
          const doc = await Promise.race([
            collection.findOne({ _id: 'prototype-service' }, { maxTimeMS: 1_000 }),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), 1_000); }),
          ]);
          if (!stopped) heartbeatUntil = doc?.expiresAt instanceof Date ? doc.expiresAt.getTime() : 0;
        } catch { heartbeatUntil = 0; }
        finally { clearTimeout(timer); running = false; }
      }
      const timer = setInterval(() => { void refresh(); }, intervalMs);
      timer.unref?.();
      void refresh();
      return () => { stopped = true; clearInterval(timer); store = undefined; heartbeatUntil = 0; };
    },
    isAvailable() {
      try { return transportReady() === true && now() < heartbeatUntil; }
      catch { return false; }
    },
  };
}

const prototypeAvailability = createPrototypeAvailability();
module.exports = { createPrototypeAvailability, prototypeAvailability };
