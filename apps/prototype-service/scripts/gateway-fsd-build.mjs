/** T009 trusted image preparation + remote multi-file fixture; no model/provider keys. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import dotenv from 'dotenv';
import { SandboxGatewayClient } from '../src/sandbox-gateway-client.js';
import { GatewayPipelineClient } from '../src/gateway-pipeline-client.js';
import { loadPrototypeConfig } from '../src/config.js';
import { createSourceManifest, SOURCE_PROFILES } from '../src/source-manifest.js';
import { reactAgentRulesBundle } from '../src/react-agent-instructions.js';
import { REACT_FSD_BUILD_PROFILE, digest, pipelineIdentity } from '../src/pipeline-contract.js';
const ts = createRequire(import.meta.url)('typescript');
const exec = promisify(execFile);
dotenv.config({ quiet: true });
const root = path.resolve('.');
const out = path.resolve(
  process.env.PROTOTYPE_ACCEPTANCE_OUTPUT || `.prototype-dev/gateway-fsd-build-${Date.now()}`,
);
await fs.mkdir(out, { recursive: true, mode: 0o700 });
const receipt = {
  at: new Date().toISOString(),
  profile: REACT_FSD_BUILD_PROFILE,
  providerRequests: 0,
};
const release = JSON.parse(
  await fs.readFile('apps/prototype-service/deploy/gateway/release-lock.json', 'utf8'),
);
const config = loadPrototypeConfig(process.env, 'orchestrator');
const gateway = await SandboxGatewayClient.fromConfig(config.gateway);
const rules = await reactAgentRulesBundle();
try {
  await gateway.probe();
  const context = path.join(out, 'context'),
    runner = path.join(context, 'runner');
  await fs.mkdir(runner, { recursive: true });
  const templateRoot = 'api/server/services/Prototypes/local-agent-assets/template';
  const templateContext = path.join(context, 'template');
  await fs.cp(templateRoot, templateContext, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(templateRoot, source);
      return !['node_modules', 'dist', 'tsconfig.tsbuildinfo'].includes(
        relative.split(path.sep)[0],
      );
    },
  });
  const modules = [
    'fixed-template.js',
    'react-source-policy.js',
    'source-manifest.js',
    'react-project-policy.js',
    'pipeline-contract.js',
    'pipeline-diagnostics.js',
    'uikit-compat.js',
  ];
  for (const name of modules)
    await fs.copyFile(`apps/prototype-service/src/${name}`, path.join(runner, name));
  await fs.copyFile(
    'apps/prototype-service/deploy/gateway/build-runner/package.json',
    path.join(runner, 'package.json'),
  );
  await fs.copyFile(
    'apps/prototype-service/deploy/gateway/build-runner/package-lock.json',
    path.join(runner, 'package-lock.json'),
  );
  await fs.copyFile(
    'apps/prototype-service/src/gateway-build-runner.mjs',
    path.join(runner, 'build.mjs'),
  );
  for (const name of ['artifacts', 'offlineBuildQa']) {
    let source = await fs.readFile(`packages/prototype-worker/src/execution/${name}.ts`, 'utf8');
    if (name === 'offlineBuildQa') {
      source = source.replace(
        "import { PlaywrightBrowserQa, type BrowserQaResult } from './browserQa';",
        "type BrowserQaResult = never; const PlaywrightBrowserQa = class { async run(): Promise<never> { throw new Error('BROWSER_QA_DISABLED'); } };",
      );
      source = source.replace("from './artifacts'", "from './artifacts.js'");
    }
    await fs.writeFile(
      path.join(runner, `${name}.js`),
      ts.transpileModule(source, {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
      }).outputText,
    );
  }
  const rulesRoot = path.join(context, 'rules');
  for (const entry of rules.entries) {
    const target = path.join(rulesRoot, entry.path);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, entry.text);
  }
  await fs.writeFile(
    path.join(rulesRoot, 'manifest.json'),
    JSON.stringify({ ...rules.manifest, digest: rules.digest }),
  );
  const runtimeLock = JSON.parse(
    await fs.readFile(
      'apps/prototype-service/deploy/gateway/build-runner/runtime-lock.json',
      'utf8',
    ),
  );
  if (
    runtimeLock.platform !== 'linux/amd64' ||
    !/^node:24\.16\.0-alpine@sha256:[a-f0-9]{64}$/.test(runtimeLock.baseImage)
  ) {
    throw new Error('GATEWAY_BUILD_BASE_IMAGE_INVALID');
  }
  receipt.baseImage = runtimeLock.baseImage;
  await fs.writeFile(
    path.join(context, 'Dockerfile'),
    [
      `FROM ${runtimeLock.baseImage}`,
      'RUN apk add --no-cache util-linux && if [ ! -x /usr/bin/setpriv ]; then setpriv_path="$(command -v setpriv)" && ln -s "$setpriv_path" /usr/bin/setpriv; fi && test -x /usr/bin/setpriv',
      'COPY template /opt/prototype/template',
      'RUN npm ci --prefix /opt/prototype/template --include=dev --ignore-scripts --no-audit --no-fund',
      'COPY runner /opt/prototype/runner',
      'RUN npm ci --prefix /opt/prototype/runner --omit=dev --ignore-scripts --no-audit --no-fund',
      'COPY rules /opt/prototype/rules',
      '',
    ].join('\n'),
  );
  const archive = path.join(out, 'context.tar.gz');
  await exec('tar', ['-czf', archive, '-C', context, '.'], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  const bytes = await fs.readFile(archive);
  receipt.contextDigest = digest(bytes);
  receipt.rulesDigest = rules.digest;
  // Persist intent before an ambiguous build POST; same tar bytes have a content-addressed Gateway build ID.
  await fs.writeFile(
    path.join(out, 'receipt.json'),
    JSON.stringify({ ...receipt, phase: 'image_create_intent' }),
    { mode: 0o600 },
  );
  const built = await gateway.request('POST', '/images', {
    body: bytes,
    contentType: 'application/gzip',
    timeoutMs: 30_000,
  });
  receipt.imageBuildId = built.id;
  await fs.writeFile(
    path.join(out, 'receipt.json'),
    JSON.stringify({ ...receipt, phase: 'image_building' }),
    { mode: 0o600 },
  );
  const deadline = Date.now() + 10 * 60_000;
  let result;
  while (Date.now() < deadline) {
    result = await gateway.request('GET', `/images/${built.id}`);
    if (result.state === 'ready' || result.state === 'failed') break;
    console.log(
      JSON.stringify({ event: 'image.progress', state: result.state, phase: result.phase }),
    );
    await delay(5000);
  }
  if (result?.state !== 'ready') throw new Error('GATEWAY_FSD_IMAGE_UNAVAILABLE');
  // API1 returns a mutable tag; the trusted build log records the registry manifest digest.
  const completed = await gateway.request('GET', `/images/${built.id}?log=1`, {
    maxBytes: 1024 * 1024,
  });
  const pushed = completed.log?.match(/pushing manifest for (\S+@sha256:[a-f0-9]{64})/);
  if (!pushed || pushed[1].split('@')[0] !== result.image)
    throw new Error('GATEWAY_IMAGE_DIGEST_UNAVAILABLE');
  result.image = `${result.image.replace(/:[^/:]+$/, '')}@${pushed[1].split('@')[1]}`;
  receipt.image = result.image;
  await fs.writeFile(
    path.join(out, 'receipt.json'),
    JSON.stringify({ ...receipt, phase: 'image_ready' }),
    { mode: 0o600 },
  );
  const sources = {
    'src/app/App.tsx':
      "import { CrmPage } from '@/pages/crm'; export function App() { return <CrmPage />; }",
    'src/pages/crm/index.ts': "export { CrmPage } from './ui/CrmPage';",
    'src/pages/crm/ui/CrmPage.tsx':
      "import { EmployeeList } from '@/widgets/employees'; export function CrmPage() { return <main><h1>FSD fixture</h1><EmployeeList /></main>; }",
    'src/widgets/employees/index.ts': "export { EmployeeList } from './ui/EmployeeList';",
    'src/widgets/employees/ui/EmployeeList.tsx':
      "import { AddEmployee } from '@/features/add-employee'; export function EmployeeList() { return <section><AddEmployee /></section>; }",
    'src/features/add-employee/index.ts': "export { AddEmployee } from './ui/AddEmployee';",
    'src/features/add-employee/ui/AddEmployee.tsx':
      "import { useEmployees } from '@/entities/employee'; import { Button } from '@ai-sber/uikit'; export function AddEmployee() { const { employees, add } = useEmployees(); return <><Button onClick={add}>Добавить</Button><p>Сотрудников: {employees.length}</p></>; }",
    'src/entities/employee/index.ts': "export { useEmployees } from './model/useEmployees';",
    'src/entities/employee/model/useEmployees.ts':
      "import { useState } from 'react'; import { DEMO_NAME } from '@/shared/lib'; export function useEmployees() { const [employees, setEmployees] = useState([DEMO_NAME]); const add = () => setEmployees(values => [...values, DEMO_NAME]); return { employees, add }; }",
    'src/shared/lib/index.ts': "export const DEMO_NAME = 'Иван';",
  };
  const sourceManifest = createSourceManifest(sources, {
    profile: SOURCE_PROFILES.fsd,
    engineId: 'opencode-fsd-v1',
    modelId: 'fixture/no-model-request',
    revision: 1,
    rulesDigest: rules.digest,
    templateDigest: release.build.templateDigest,
    toolchainDigest: release.build.toolchainDigest,
  });
  const pipeline = new GatewayPipelineClient({
    gateway,
    image: result.image,
    directory: path.join(out, 'executions'),
    log: (event, fields) => console.log(JSON.stringify({ event, ...fields })),
  });
  const input = {
    executionId: `fsd_fixture_${Date.now()}`,
    profile: REACT_FSD_BUILD_PROFILE,
    format: 'react',
    sourceManifest,
    sources,
  };
  const snapshot = await pipeline.run(input);
  for (const [name, value] of [
    ['prototype.html', snapshot.html],
    ['sources.zip', snapshot.sourcesZip],
    ['qa.json', snapshot.qaEvidence],
  ]) {
    await fs.writeFile(path.join(out, name), value);
  }
  receipt.inputDigest = pipelineIdentity(input).inputDigest;
  receipt.sourceManifestDigest = sourceManifest.digest;
  receipt.artifacts = snapshot.digests;
  receipt.passed = true;
  const releasePath = 'apps/prototype-service/deploy/gateway/release-lock.json';
  const updatedRelease = {
    ...release,
    build: { ...release.build, image: result.image },
    buildFsd: { ...release.buildFsd, image: result.image },
  };
  const temporaryReleasePath = `${releasePath}.${process.pid}.tmp`;
  await fs.writeFile(temporaryReleasePath, `${JSON.stringify(updatedRelease, null, 2)}\n`, {
    mode: 0o644,
  });
  await fs.rename(temporaryReleasePath, releasePath);
  receipt.previousImages = {
    build: release.build.image,
    buildFsd: release.buildFsd.image,
  };
  receipt.releasePinUpdated = true;
} catch (error) {
  receipt.passed = false;
  receipt.error = error.message;
  process.exitCode = 1;
} finally {
  await fs.writeFile(path.join(out, 'receipt.json'), JSON.stringify(receipt, null, 2), {
    mode: 0o600,
  });
}
console.log(JSON.stringify({ ...receipt, evidenceDirectory: out }));
