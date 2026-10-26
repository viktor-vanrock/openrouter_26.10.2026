import { createRequire } from 'node:module';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Preserve the local default while allowing Docker/CI to choose a smaller heap.
const env = {
  ...process.env,
  NODE_ENV: 'production',
  NODE_OPTIONS: process.env.NODE_OPTIONS || '--max-old-space-size=8192',
};
const require = createRequire(import.meta.url);
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
for (const args of [
  [vite, 'build'],
  [fileURLToPath(new URL('./post-build.cjs', import.meta.url))],
]) {
  const result = spawnSync(process.execPath, args, { env, stdio: 'inherit' });
  if (result.error || result.status !== 0) process.exit(result.status ?? 1);
}
