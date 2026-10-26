/** Trusted entrypoint inside Gateway only; generated HTML executes in an opaque iframe. */
import fs from 'node:fs/promises';
import { chromium } from '@playwright/test';
import { PlaywrightBrowserQa } from './browserQa.js';
import { safeDiagnostics } from '../runner/pipeline-diagnostics.js';
const qa = new PlaywrightBrowserQa(async () => ({
  chromium: {
    launch: (options) =>
      chromium.launch({
        ...options,
        args: ['--disable-dev-shm-usage', '--disable-gpu', '--js-flags=--jitless'],
      }),
  },
}));
try {
  const html = await fs.readFile('/workspace/dist/index.html');
  const result = await qa.run({ html, timeoutMs: 12000 });
  await fs.writeFile('/workspace/browser-qa.json', JSON.stringify(result));
} catch (error) {
  // Browser/container failures are never classified as source errors or paid repair candidates.
  const diagnostics = safeDiagnostics([error?.message ?? 'Chromium QA unavailable']);
  await fs.writeFile(
    '/workspace/browser-qa.json',
    JSON.stringify({ infrastructureFailure: true, diagnostics }),
  );
  process.stderr.write(`BROWSER_INFRASTRUCTURE_FAILURE=${JSON.stringify(diagnostics)}\n`);
  process.exitCode = 1;
}
