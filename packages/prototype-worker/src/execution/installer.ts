import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSourcesArchive } from './artifacts';

const exec = promisify(execFile);

export type TrustedInstallInput = {
  manifest: Record<string, unknown>;
  lockfile: Record<string, unknown>;
  gatewayUrl: string;
  destination: string;
  timeoutMs: number;
  maxBundleBytes: number;
};

export class DependencyInstaller {
  constructor(private readonly run = exec) {}
  async install(input: TrustedInstallInput): Promise<Buffer> {
    const gateway = new URL(input.gatewayUrl);
    if (!['http:', 'https:'].includes(gateway.protocol) || gateway.username || gateway.password) throw new Error('PROTOTYPE_DEPENDENCY_GATEWAY_INVALID');
    const destination = path.resolve(input.destination);
    await fs.mkdir(destination, { recursive: false });
    await fs.writeFile(path.join(destination, 'package.json'), `${JSON.stringify(input.manifest, null, 2)}\n`, { flag: 'wx' });
    await fs.writeFile(path.join(destination, 'package-lock.json'), `${JSON.stringify(input.lockfile, null, 2)}\n`, { flag: 'wx' });
    await this.run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: destination, timeout: input.timeoutMs, maxBuffer: 1_000_000,
      env: {
        PATH: process.env.PATH, npm_config_registry: gateway.toString(), npm_config_ignore_scripts: 'true',
        npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
        npm_config_fetch_retries: '0', npm_config_userconfig: path.join(destination, '.empty-npmrc'),
      },
    });
    const bundle = await buildSourcesArchive(destination, { includeDependenciesOnly: true });
    if (bundle.length > input.maxBundleBytes) throw new Error('PROTOTYPE_DEPENDENCY_BUNDLE_LIMIT');
    return bundle;
  }
}
