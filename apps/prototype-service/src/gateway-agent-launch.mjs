/** Trusted fixed dispatch. Gateway sessions may ignore image USER, so enforce identity here. */
import fs from 'node:fs/promises';
const modes = new Map([
  ['runtime-probe', './runtime-probe.mjs'],
  ['hostile-config', './hostile-config.mjs'],
  ['adapter', './gateway-adapter-sandbox.mjs'],
]);
const mode = process.argv[2];
if (!modes.has(mode) || process.argv.length !== 3) throw new Error('AGENT_DISPATCH_DENIED');
if (process.getuid() === 0) {
  // Only the fixed scratch roots and known input files are adjusted. Never follow symlinks.
  for (const name of ['/work', '/run/input', '/tmp/prototype-home']) {
    const stat = await fs.lstat(name);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('AGENT_SCRATCH_REJECTED');
    await fs.chown(name, 10001, 10001);
  }
  if (mode === 'adapter') {
    for (const name of ['/run/input/adapter-input.json']) {
      const stat = await fs.lstat(name);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 16000)
        throw new Error('AGENT_INPUT_REJECTED');
      await fs.chown(name, 10001, 10001);
      await fs.chmod(name, 0o600);
    }
  }
  process.setgroups([]);
  process.setgid(10001);
  process.setuid(10001);
}
if (process.getuid() !== 10001 || process.getgid() !== 10001)
  throw new Error('AGENT_NONROOT_REQUIRED');
// Only the short scoped credential can reach the adapter. Other process inputs stay out of OpenCode.
const scoped = mode === 'adapter' ? process.env.PROTOTYPE_SCOPED_TOKEN : undefined;
for (const name of Object.keys(process.env)) delete process.env[name];
Object.assign(process.env, {
  PATH: '/usr/local/bin:/usr/bin:/bin',
  HOME: '/tmp/prototype-home',
  OPENCODE_DISABLE_PROJECT_CONFIG: 'true',
  OPENCODE_DISABLE_DEFAULT_PLUGINS: 'true',
  OPENCODE_DISABLE_EXTERNAL_SKILLS: 'true',
  OPENCODE_DISABLE_MODELS_FETCH: 'true',
  OPENCODE_DISABLE_LSP_DOWNLOAD: 'true',
});
if (scoped) process.env.PROTOTYPE_SCOPED_TOKEN = scoped;
if (mode === 'adapter')
  process.argv = [process.execPath, '/opt/prototype/agent/gateway-adapter-sandbox.mjs'];
await import(modes.get(mode));
