/** Stop only the managed prototype process. Shared dependencies remain running. */
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const profile = fileURLToPath(new URL('../../../.prototype-dev/runtime.json', import.meta.url));
try {
  const stat = await fs.lstat(profile);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 16384)
    throw new Error('Invalid private prototype profile');
  const state = JSON.parse(await fs.readFile(profile, 'utf8'));
  if (state.schemaVersion !== 2 || !Number.isSafeInteger(state.pid) || state.pid < 1)
    throw new Error('Unsupported prototype profile');
  const lock = Number(
    await fs.readFile(new URL('../../../.prototype-dev/service.lock', import.meta.url), 'utf8'),
  );
  if (lock !== state.pid) throw new Error('Prototype process identity mismatch');
  try {
    process.kill(state.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  console.info(
    'Sent shutdown to the prototype service. Shared Mongo, Redis and S3 remain available.',
  );
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
