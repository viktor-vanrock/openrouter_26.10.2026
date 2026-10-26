import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('prototype worker package build', () => {
  it('loads the built public entrypoint as an ES module', async () => {
    const packageRoot = path.resolve(__dirname, '..');
    const rollup = path.resolve(packageRoot, '../../node_modules/.bin/rollup');
    await execFileAsync(rollup, ['-c', '--silent', '--bundleConfigAsCjs'], { cwd: packageRoot });

    const probe = [
      `import * as worker from ${JSON.stringify(new URL(`file://${path.join(packageRoot, 'dist/index.js')}`).href)};`,
      "if (typeof worker.createLocalPipeline !== 'function') process.exit(1);",
      "if (typeof worker.PrototypeWorker !== 'function') process.exit(1);",
    ].join('');
    await expect(execFileAsync(process.execPath, ['--input-type=module', '-e', probe])).resolves.toBeDefined();
  });
});
