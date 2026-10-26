/** Build a trusted Chromium QA layer through Gateway. No model/provider credentials in image context. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import { SandboxGatewayClient } from '../src/sandbox-gateway-client.js';
import { loadPrototypeConfig } from '../src/config.js';
import { GatewayPipelineClient } from '../src/gateway-pipeline-client.js';
import { REACT_BUILD_PROFILE, digest } from '../src/pipeline-contract.js';
dotenv.config({ quiet: true });
const ts = createRequire(import.meta.url)('typescript');
const out = path.resolve(`.prototype-dev/gateway-browser-build-${Date.now()}`);
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const context = path.join(out, 'context');
const releasePath = 'apps/prototype-service/deploy/gateway/release-lock.json';
const lock = JSON.parse(await fs.readFile(releasePath, 'utf8'));
// Reuse an already baked Chromium layer when updating only trusted QA modules.
const baseOption = process.argv.indexOf('--browser-base');
const browserBase = baseOption < 0 ? null : process.argv[baseOption + 1];
const verifyOption = process.argv.indexOf('--verify-image');
const verifyImage = verifyOption < 0 ? null : process.argv[verifyOption + 1];
const imagePin =
  /^swr\.ru-moscow-1\.hc\.sbercloud\.ru\/sber_devices\/rndml\/devops\/k8s-sandbox-gw\/sandbox-images@sha256:[a-f0-9]{64}$/;
if (
  (baseOption >= 0 && !imagePin.test(browserBase ?? '')) ||
  (verifyOption >= 0 && !imagePin.test(verifyImage ?? '')) ||
  (baseOption >= 0 && verifyOption >= 0)
) {
  throw new Error('BROWSER_BASE_PIN_INVALID');
}
const gateway = await SandboxGatewayClient.fromConfig(
  loadPrototypeConfig(process.env, 'orchestrator').gateway,
);
const receipt = { at: new Date().toISOString(), providerRequests: 0 };
const exec = promisify(execFile);
try {
  if (verifyImage) receipt.image = verifyImage;
  else {
    await fs.mkdir(path.join(context, 'runner'), { recursive: true });
    await fs.mkdir(path.join(context, 'browser'), { recursive: true });
    for (const file of [
      'fixed-template.js',
      'react-source-policy.js',
      'source-manifest.js',
      'react-project-policy.js',
      'pipeline-contract.js',
      'pipeline-diagnostics.js',
      'uikit-compat.js',
    ])
      await fs.copyFile(`apps/prototype-service/src/${file}`, path.join(context, 'runner', file));
    await fs.copyFile(
      'apps/prototype-service/src/gateway-build-runner.mjs',
      path.join(context, 'runner/build.mjs'),
    );
    for (const module of ['artifacts', 'offlineBuildQa']) {
      let source = await fs.readFile(
        `packages/prototype-worker/src/execution/${module}.ts`,
        'utf8',
      );
      if (module === 'offlineBuildQa')
        source = source
          .replace("from './artifacts'", "from './artifacts.js'")
          .replace(
            "import { PlaywrightBrowserQa, type BrowserQaResult } from './browserQa';",
            "type BrowserQaResult = never; const PlaywrightBrowserQa = class { async run(): Promise<never> { throw new Error('BROWSER_CALLBACK_REQUIRED'); } };",
          );
      await fs.writeFile(
        path.join(context, `runner/${module}.js`),
        ts.transpileModule(source, {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        }).outputText,
      );
    }
    await fs.writeFile(
      path.join(context, 'browser/browserQa.js'),
      ts.transpileModule(
        await fs.readFile('packages/prototype-worker/src/execution/browserQa.ts', 'utf8'),
        {
          compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
        },
      ).outputText,
    );
    await fs.copyFile(
      'apps/prototype-service/src/gateway-browser-qa.mjs',
      path.join(context, 'browser/run.mjs'),
    );
    await fs.writeFile(
      path.join(context, 'browser/package.json'),
      JSON.stringify({ type: 'module', dependencies: { '@playwright/test': '1.63.0' } }),
    );
    await fs.writeFile(
      path.join(context, 'Dockerfile'),
      `FROM ${browserBase ?? lock.build.image}
  COPY runner /opt/prototype/runner
  COPY browser /opt/prototype/browser
  RUN ${browserBase ? 'chmod a+r /opt/prototype/browser/*.js /opt/prototype/browser/*.mjs /opt/prototype/browser/package.json' : 'npm install --prefix /opt/prototype/browser --ignore-scripts --no-audit --no-fund && PLAYWRIGHT_BROWSERS_PATH=/opt/prototype/browsers /opt/prototype/browser/node_modules/.bin/playwright install --with-deps chromium && chmod -R a+rX /opt/prototype/browser /opt/prototype/browsers'}
  `,
    );
    const archive = path.join(out, 'context.tar.gz');
    await exec('tar', ['-czf', archive, '-C', context, '.'], {
      env: { ...process.env, COPYFILE_DISABLE: '1' },
    });
    const bytes = await fs.readFile(archive);
    receipt.contextDigest = digest(bytes);
    receipt.baseImage = browserBase ?? lock.build.image;
    receipt.state = 'create_reserved';
    await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
    const created = await gateway.request('POST', '/images', {
      body: bytes,
      contentType: 'application/gzip',
      timeoutMs: 30000,
    });
    receipt.imageBuildId = created.id;
    receipt.state = 'building';
    await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt));
    const deadline = Date.now() + 20 * 60000;
    let result;
    while (Date.now() < deadline) {
      result = await gateway.request('GET', `/images/${created.id}`);
      if (['ready', 'failed'].includes(result.state)) break;
      await delay(10000);
    }
    if (result?.state === 'building') throw new Error('BROWSER_IMAGE_PUBLICATION_PENDING');
    if (result?.state !== 'ready') throw new Error('BROWSER_IMAGE_BUILD_FAILED');
    const completed = await gateway.request('GET', `/images/${created.id}?log=1`, {
      maxBytes: 2 * 1024 * 1024,
    });
    const pushed = completed.log?.match(/pushing manifest for (\S+@sha256:[a-f0-9]{64})/);
    if (!pushed) throw new Error('BROWSER_IMAGE_DIGEST_UNKNOWN');
    if (pushed[1].split('@')[0] !== result.image) throw new Error('BROWSER_IMAGE_TAG_MISMATCH');
    receipt.image = `${result.image.replace(/:[^/:]+$/, '')}@${pushed[1].split('@')[1]}`;
    receipt.state = 'ready';
  }
  await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
  const pipeline = new GatewayPipelineClient({
    gateway,
    image: receipt.image,
    directory: path.join(out, 'executions'),
    log: (event) => {
      if (!event.endsWith('.log')) console.log(event);
    },
    limits: { ...lock.build, browserQaRequired: true },
  });
  const source =
    "import {useState} from 'react';import {Button} from '@ai-sber/uikit';export function App(){const [n,setN]=useState(0);return <main><h1>Browser QA fixture</h1><Button onClick={()=>setN(n+1)}>Добавить</Button><p>Количество: {n}</p></main>}";
  const snapshot = await pipeline.run({
    executionId: `browser_good_${Date.now()}`,
    profile: REACT_BUILD_PROFILE,
    format: 'react',
    source,
  });
  for (const [name, value] of [
    ['prototype.html', snapshot.html],
    ['sources.zip', snapshot.sourcesZip],
    ['qa.json', snapshot.qaEvidence],
  ])
    await fs.writeFile(path.join(out, name), value);
  receipt.browserEvidence = JSON.parse(snapshot.qaEvidence);
  await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
  const employeeFixture = await fs.readFile(
    'apps/prototype-service/test/fixtures/react-design.tsx',
    'utf8',
  );
  const employee = await pipeline.run({
    executionId: `browser_employee_${Date.now()}`,
    profile: REACT_BUILD_PROFILE,
    format: 'react',
    source: employeeFixture,
  });
  receipt.employeeBrowserEvidence = JSON.parse(employee.qaEvidence);
  await fs.writeFile(path.join(out, 'employee-qa.json'), employee.qaEvidence, { mode: 0o600 });
  await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt), { mode: 0o600 });
  // This compiles and lints, but throws at React mount. It must never return a publication snapshot.
  const broken =
    "import {Button} from '@ai-sber/uikit';export function App(){const value=JSON.parse('runtime-failure-fixture');return <Button>{value}</Button>}";
  try {
    await pipeline.run({
      executionId: `browser_bad_${Date.now()}`,
      profile: REACT_BUILD_PROFILE,
      format: 'react',
      source: broken,
    });
    throw new Error('RUNTIME_FAILURE_ACCEPTED');
  } catch (error) {
    if (error.failureCode !== 'PROTOTYPE_QA_FAILED') throw error;
    receipt.runtimeFailureRejected = true;
    receipt.runtimeDiagnostics = error.diagnostics;
  }
  const currentLock = JSON.parse(await fs.readFile(releasePath, 'utf8'));
  if (JSON.stringify(currentLock.build) !== JSON.stringify(lock.build))
    throw new Error('BROWSER_RELEASE_CHANGED_DURING_VALIDATION');
  currentLock.build.image = receipt.image;
  currentLock.build.browserQaRequired = true;
  await fs.writeFile(releasePath, `${JSON.stringify(currentLock, null, 2)}\n`);
  receipt.passed = true;
} catch (error) {
  receipt.passed = false;
  receipt.code = error.failureCode ?? error.message;
  receipt.diagnostics = error.diagnostics;
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
  console.log(JSON.stringify({ ...receipt, evidenceDirectory: out }));
}
