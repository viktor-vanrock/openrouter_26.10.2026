import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createVerifiedArtifactSnapshot, readBuiltPreview, type VerifiedArtifactSnapshot } from './artifacts';
import { PlaywrightBrowserQa, type BrowserQaResult } from './browserQa';

const exec = promisify(execFile);
const REMOTE_REFERENCE = /(?:src|href)\s*=\s*["'](?:https?:)?\/\//i;
export type BrowserQa = (input: { workspace: string; html: Buffer; sandbox: boolean }) => Promise<BrowserQaResult>;

export class OfflineBuildQaRunner {
  constructor(
    private readonly run = exec,
    private readonly browserQa: BrowserQa = ({ html }) => new PlaywrightBrowserQa().run({ html }),
  ) {}
  async execute(input: { workspace: string; timeoutMs: number; templateDigest: `sha256:${string}`; toolchainDigest: `sha256:${string}`; validation?: 'build-only' }): Promise<VerifiedArtifactSnapshot> {
    const diagnostics: string[] = [];
    for (const script of ['type-check', 'lint', 'build']) {
      try {
        await this.run('npm', ['run', script], {
          cwd: input.workspace, timeout: input.timeoutMs, maxBuffer: 1_000_000,
          env: { PATH: process.env.PATH, NODE_ENV: 'production',
            HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9',
            NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost',
            npm_config_offline: 'true', npm_config_audit: 'false', npm_config_fund: 'false' },
        });
      } catch (error) {
        const output = error as { stderr?: string; stdout?: string; message?: string };
        diagnostics.push(`${script}: ${String(output.stderr || output.stdout || output.message || 'Unknown command failure').slice(-8_000)}`);
        throw Object.assign(new Error('PROTOTYPE_BUILD_FAILED'), { diagnostics });
      }
    }
    const preview = await readBuiltPreview(input.workspace);
    if (REMOTE_REFERENCE.test(preview.toString('utf8'))) throw new Error('PROTOTYPE_QA_NETWORK_REFERENCE');
    if (input.validation === 'build-only') {
      return createVerifiedArtifactSnapshot({ workspace: input.workspace, qaEvidence: {
        schemaVersion: 1, passed: true, validation: 'build-only',
        checks: ['type-check', 'lint', 'build'], browserQaPerformed: false,
        consoleErrors: [], networkRequests: [],
      }, templateDigest: input.templateDigest, toolchainDigest: input.toolchainDigest });
    }
    const qa = await this.browserQa({ workspace: input.workspace, html: preview, sandbox: true });
    if (qa.consoleErrors.length > 0 || qa.networkRequests.length > 0) {
      throw Object.assign(new Error('PROTOTYPE_QA_FAILED'), { diagnostics: [...qa.consoleErrors, ...qa.networkRequests].slice(0, 20) });
    }
    return createVerifiedArtifactSnapshot({ workspace: input.workspace, qaEvidence: {
      schemaVersion: 1, passed: true, validation: 'browser', browserQaPerformed: true,
      checks: ['type-check', 'lint', 'build', ...qa.checks], consoleErrors: [], networkRequests: [],
    }, templateDigest: input.templateDigest, toolchainDigest: input.toolchainDigest });
  }
}

export class RepairCoordinator {
  private repairs = 0;
  constructor(private readonly maxRepairs = 2) {}
  next(input: { previousAttemptId: string; diagnostics: string[] }, createIdentity: () => { attemptId: string; executionId: string }) {
    if (this.repairs >= this.maxRepairs) throw new Error('PROTOTYPE_REPAIR_LIMIT');
    this.repairs += 1;
    const identity = createIdentity();
    if (identity.attemptId === input.previousAttemptId) throw new Error('PROTOTYPE_REPAIR_IDENTITY_REUSED');
    return { ...identity, repairOrdinal: this.repairs, diagnostics: input.diagnostics.join('\n').slice(0, 8_000) };
  }
}
