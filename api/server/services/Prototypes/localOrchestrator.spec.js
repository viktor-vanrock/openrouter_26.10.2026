const { createLocalPrototypeOrchestrator } = require('./localOrchestrator');

describe('local Prototype orchestrator wiring', () => {
  it('stays off unless the feature and local role are both enabled', async () => {
    const roles = { start: jest.fn(), stop: jest.fn() };
    expect(createLocalPrototypeOrchestrator({ config: { enabled: false }, processRole: 'local', roles })).toBeNull();
    expect(createLocalPrototypeOrchestrator({ config: { enabled: true }, processRole: 'api', roles })).toBeNull();
    expect(createLocalPrototypeOrchestrator({ config: { enabled: true }, processRole: 'local', roles })).not.toBeNull();
  });

  it('starts and stops all local background roles as one lifecycle', async () => {
    const roles = {
      publisher: { start: jest.fn(), stop: jest.fn() },
      consumer: { start: jest.fn(), stop: jest.fn() },
      reconciler: { start: jest.fn(), stop: jest.fn() },
    };
    const orchestrator = createLocalPrototypeOrchestrator({
      config: { enabled: true }, processRole: 'local', roles,
    });
    await orchestrator.start();
    await orchestrator.stop();
    for (const role of Object.values(roles)) {
      expect(role.start).toHaveBeenCalledTimes(1);
      expect(role.stop).toHaveBeenCalledTimes(1);
    }
  });
});
