// Browser stub for msw/node — this module is Node-only.
// In browser context, setupServer is never called (only msw/browser is used).
// This stub prevents Vite's import-analysis from failing on the node-only subpath.
export const setupServer = (..._handlers: unknown[]) => ({
  listen: () => {},
  close: () => {},
  resetHandlers: () => {},
  use: () => {},
  restoreHandlers: () => {},
})
