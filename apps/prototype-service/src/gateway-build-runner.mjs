import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { initializeFixedWorkspace, verifyFixedWorkspace } from './fixed-template.js';
import { validateReactSource } from './react-source-policy.js';
import {
  validatePipelineInput,
  pipelineIdentity,
  digest,
  REACT_FSD_BUILD_PROFILE,
} from './pipeline-contract.js';
import { OfflineBuildQaRunner } from './offlineBuildQa.js';
import { safeDiagnostics } from './pipeline-diagnostics.js';
import { UIKIT_COMPAT_CSS } from './uikit-compat.js';

const input = validatePipelineInput(JSON.parse(await fs.readFile('/run/input/input.json', 'utf8')));
const identity = {
  executionId: input.executionId,
  inputDigest: pipelineIdentity(input).inputDigest,
  profile: input.profile,
};
const active = new Set();
const expires = Date.now() + 180000;
function stop() {
  for (const child of active) {
    try {
      process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* exited */
    }
  }
}
process.on('SIGTERM', stop);
const watchdog = setTimeout(stop, 180000);
await fs.mkdir('/run/output', { recursive: true });
const run = (command, args, options) =>
  new Promise((resolve, reject) => {
    const timeoutMs = Math.min(options.timeout, expires - Date.now());
    if (timeoutMs <= 0) {
      reject(new Error('PROTOTYPE_BUILD_DEADLINE'));
      return;
    }
    process.stdout.write(`CHECK_START ${args.at(-1)}\n`);
    const child = spawn(
      '/usr/bin/setpriv',
      [
        '--reuid=10001',
        '--regid=10001',
        '--clear-groups',
        '--bounding-set=-all',
        '--no-new-privs',
        command,
        ...args,
      ],
      {
        cwd: options.cwd,
        env: { ...options.env, HOME: '/tmp' },
        detached: true,
      },
    );
    active.add(child);
    const out = [],
      err = [];
    let bytes = 0;
    const collect = (chunks, destination) => (chunk) => {
      bytes += chunk.length;
      if (bytes > 1_000_000) {
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {}
        return;
      }
      chunks.push(chunk);
      destination.write(chunk);
    };
    child.stdout.on('data', collect(out, process.stdout));
    child.stderr.on('data', collect(err, process.stderr));
    const timer = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, timeoutMs);
    child.on('error', reject);
    child.on('close', (code) => {
      clearTimeout(timer);
      active.delete(child);
      process.stdout.write(`CHECK_END ${args.at(-1)} ${code}\n`);
      if (code !== 0 || bytes > 1_000_000)
        reject(
          Object.assign(new Error('PROTOTYPE_BUILD_FAILED'), {
            stdout: Buffer.concat(out).toString(),
            stderr: Buffer.concat(err).toString(),
          }),
        );
      else
        resolve({ stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
    });
  });

try {
  const multi = input.profile === REACT_FSD_BUILD_PROFILE;
  if (!multi) validateReactSource(input.source);
  const profile = await initializeFixedWorkspace('/workspace');
  if (
    multi &&
    (input.sourceManifest.templateDigest !== profile.templateDigest ||
      input.sourceManifest.toolchainDigest !== profile.toolchainDigest)
  ) {
    throw new Error('PROTOTYPE_FIXED_PROFILE_MISMATCH');
  }
  if (multi) {
    const { digest: expected, ...rules } = JSON.parse(
      await fs.readFile('/opt/prototype/rules/manifest.json', 'utf8'),
    );
    if (digest(JSON.stringify(rules)) !== expected || expected !== input.sourceManifest.rulesDigest)
      throw new Error('PROTOTYPE_RULES_PIN_MISMATCH');
    for (const file of rules.files) {
      if (
        !/^(?:rules|skills)\/[a-z-]+\.md$/.test(file.path) ||
        digest(await fs.readFile(`/opt/prototype/rules/${file.path}`)) !== file.digest
      ) {
        throw new Error('PROTOTYPE_RULES_PIN_MISMATCH');
      }
    }
  }
  const styles = '/workspace/src/app/styles/globals.css';
  if (
    !(await fs.readFile(styles, 'utf8')).includes(
      "@source '../../../node_modules/@ai-sber/uikit/dist'",
    )
  ) {
    await fs.appendFile(styles, "\n@source '../../../node_modules/@ai-sber/uikit/dist';\n");
  }
  await fs.appendFile(styles, `\n${UIKIT_COMPAT_CSS}\n`);
  const fixedSources = {};
  async function describeFixedSource(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name),
        name = path.relative('/workspace', target);
      if (entry.name === 'node_modules') continue;
      if (entry.isDirectory()) await describeFixedSource(target);
      else if (!entry.isFile()) throw new Error('PROTOTYPE_FIXED_SOURCE_INVALID');
      else if (!(name in input.sources)) fixedSources[name] = digest(await fs.readFile(target));
    }
  }
  if (multi) await describeFixedSource('/workspace');
  if (multi) {
    for (const [name, source] of Object.entries(input.sources)) {
      const target = path.join('/workspace', name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, source);
    }
    await fs.writeFile('/workspace/source-manifest.json', JSON.stringify(input.sourceManifest));
  } else await fs.writeFile('/workspace/src/app/App.tsx', input.source);
  // Grant only writable execution workspace; image dependencies/runner remain root-owned.
  const ownership = spawn('chown', ['-R', '10001:10001', '/workspace'], { stdio: 'inherit' });
  await new Promise((resolve, reject) =>
    ownership.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error('WORKSPACE_OWNERSHIP')),
    ),
  );
  await verifyFixedWorkspace('/workspace', profile);
  const browserQa = async () => {
    try {
      await run('/usr/local/bin/node', ['/opt/prototype/browser/run.mjs'], {
        cwd: '/workspace',
        timeout: 60000,
        env: {
          PATH: process.env.PATH,
          NODE_ENV: 'production',
          PLAYWRIGHT_BROWSERS_PATH: '/opt/prototype/browsers',
        },
      });
      const value = JSON.parse(await fs.readFile('/workspace/browser-qa.json', 'utf8'));
      if (
        !Array.isArray(value.checks) ||
        !Array.isArray(value.consoleErrors) ||
        !Array.isArray(value.networkRequests)
      )
        throw new Error();
      await fs.unlink('/workspace/browser-qa.json');
      return value;
    } catch {
      let diagnostics = [];
      try {
        diagnostics = safeDiagnostics(
          JSON.parse(await fs.readFile('/workspace/browser-qa.json', 'utf8')).diagnostics,
        );
      } catch {
        /* The browser process may have been killed before writing a receipt. */
      }
      throw Object.assign(new Error('PROTOTYPE_QA_INFRASTRUCTURE_FAILED'), { diagnostics });
    }
  };
  const snapshot = await new OfflineBuildQaRunner(run, browserQa).execute({
    workspace: '/workspace',
    timeoutMs: 90000,
    templateDigest: profile.templateDigest,
    toolchainDigest: profile.toolchainDigest,
    ...(input.validation !== 'browser' ? { validation: 'build-only' } : {}),
  });
  await verifyFixedWorkspace('/workspace', profile);
  if (multi)
    for (const [name, expected] of Object.entries(fixedSources)) {
      if (digest(await fs.readFile(path.join('/workspace', name))) !== expected)
        throw new Error('PROTOTYPE_FIXED_SOURCE_MODIFIED');
    }
  const qaEvidence = Buffer.from(
    JSON.stringify({
      ...JSON.parse(snapshot.qaEvidence),
      ...(multi
        ? {
            sourceManifestDigest: input.sourceManifest.digest,
            rulesDigest: input.sourceManifest.rulesDigest,
            fixedFiles: profile.hashes,
            fixedSources,
          }
        : {}),
      executionId: input.executionId,
      format: input.format,
      profile: input.profile,
      runtime: 'sandbox-gateway',
    }),
  );
  const artifacts = {
    'preview.html': snapshot.html,
    'sources.zip': snapshot.sourcesZip,
    'qa.json': qaEvidence,
  };
  for (const [name, bytes] of Object.entries(artifacts))
    await fs.writeFile(`/run/output/${name}`, bytes);
  const result = {
    ...identity,
    passed: true,
    managedWritersStopped: active.size === 0,
    digests: {
      html: digest(snapshot.html),
      sourcesZip: digest(snapshot.sourcesZip),
      qaEvidence: digest(qaEvidence),
    },
  };
  await fs.writeFile('/run/output/result.json', JSON.stringify(result));
  process.stdout.write('BUILD_RESULT_READY\n');
} catch (error) {
  stop();
  await fs.writeFile(
    '/run/output/result.json',
    JSON.stringify({
      ...identity,
      passed: false,
      managedWritersStopped: active.size === 0,
      code: ['PROTOTYPE_QA_FAILED', 'PROTOTYPE_QA_INFRASTRUCTURE_FAILED'].includes(error.message)
        ? error.message
        : 'PROTOTYPE_BUILD_FAILED',
      diagnostics: safeDiagnostics(error.diagnostics || [error.message]),
    }),
  );
  process.exitCode = 1;
} finally {
  clearTimeout(watchdog);
}
