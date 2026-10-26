const {
  PrototypeTransportRuntime,
  runPrototypeReconcilerLoop,
} = require('./PrototypeTransportRuntime');

describe('PrototypeTransportRuntime', () => {
  it('starts publisher, event consumer, and reconciler loops and stops them together', async () => {
    let resolveRead;
    const eventSource = {
      ensureGroup: jest.fn(),
      next: jest.fn(async () => new Promise((resolve) => { resolveRead = resolve; })),
      close: jest.fn(async () => resolveRead?.(null)),
    };
    const controller = { runOnce: jest.fn(async () => false) };
    const runtime = new PrototypeTransportRuntime({
      outboxPublisher: controller,
      eventSource,
      eventConsumer: { consume: jest.fn() },
      reconcile: jest.fn(),
      close: jest.fn(),
    });
    await runtime.start();
    expect(runtime.isReady()).toBe(true);
    expect(eventSource.ensureGroup).toHaveBeenCalledTimes(1);
    await runtime.stop();
    expect(runtime.isReady()).toBe(false);
    expect(eventSource.close).toHaveBeenCalledTimes(1);
  });

  it('keeps reconciling after a recoverable failure until aborted', async () => {
    const controller = new AbortController();
    const onError = jest.fn();
    const reconcile = jest.fn()
      .mockRejectedValueOnce(new Error('temporary'))
      .mockImplementationOnce(async () => controller.abort());
    await runPrototypeReconcilerLoop({
      reconcile, signal: controller.signal, intervalMs: 1, onError,
    });
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('does not report a reconciler failure triggered by shutdown', async () => {
    const controller = new AbortController();
    const onError = jest.fn();
    const reconcile = jest.fn(async () => {
      controller.abort();
      throw new Error('Connection is closed.');
    });
    await runPrototypeReconcilerLoop({ reconcile, signal: controller.signal, onError });
    expect(onError).not.toHaveBeenCalled();
  });
});
