import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DependencyInstaller } from './installer';

describe('DependencyInstaller', () => {
  it('runs only trusted npm ci flags against the gateway and excludes user inputs', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-installer-'));
    const run = jest.fn(async (_file, _args, options) => {
      await fs.mkdir(path.join(options.cwd, 'node_modules/pkg'), { recursive: true });
      await fs.writeFile(path.join(options.cwd, 'node_modules/pkg/index.js'), 'ok');
      return { stdout: '', stderr: '' };
    });
    try {
      const bundle = await new DependencyInstaller(run as never).install({
        manifest: { name: 'trusted' }, lockfile: { lockfileVersion: 3 }, gatewayUrl: 'http://dependency.internal',
        destination: path.join(root, 'install'), timeoutMs: 1_000, maxBundleBytes: 100_000,
      });
      expect(bundle.length).toBeGreaterThan(0);
      expect(run).toHaveBeenCalledWith('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], expect.objectContaining({
        env: expect.objectContaining({ npm_config_registry: 'http://dependency.internal/', npm_config_ignore_scripts: 'true' }),
      }));
      expect(JSON.stringify(run.mock.calls)).not.toMatch(/token|credential|transcript/i);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });
});
