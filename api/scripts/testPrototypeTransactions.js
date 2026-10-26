const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const executableSuffix = process.platform === 'win32' ? '.cmd' : '';
const rollup = path.join(repositoryRoot, 'node_modules', '.bin', `rollup${executableSuffix}`);
const jest = path.join(repositoryRoot, 'node_modules', '.bin', `jest${executableSuffix}`);

function buildPackage(relativeDirectory) {
  const packageDirectory = path.join(repositoryRoot, relativeDirectory);
  fs.rmSync(path.join(packageDirectory, 'dist'), { recursive: true, force: true });
  execFileSync(rollup, ['-c', '--silent', '--bundleConfigAsCjs'], {
    cwd: packageDirectory,
    stdio: 'inherit',
  });
}

buildPackage('packages/data-provider');
buildPackage('packages/data-schemas');

execFileSync(
  jest,
  ['--runInBand', '--watch=false', 'server/services/Prototypes/PrototypeService.spec.js'],
  {
    cwd: path.join(repositoryRoot, 'api'),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      PROTOTYPE_MONGO_TRANSACTION_TEST: '1',
    },
    stdio: 'inherit',
  },
);
