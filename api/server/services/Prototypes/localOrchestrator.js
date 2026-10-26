function createLocalPrototypeOrchestrator({ config, processRole, roles }) {
  if (config?.enabled !== true || processRole !== 'local') return null;
  const allRoles = Object.values(roles);
  return {
    async start() {
      await Promise.all(allRoles.map((role) => role.start()));
    },
    async stop() {
      await Promise.all(allRoles.map((role) => role.stop()));
    },
  };
}

module.exports = { createLocalPrototypeOrchestrator };
