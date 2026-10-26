/** Run Codex with only the Storybook credential read from the project's root .env. */
import fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const root = fileURLToPath(new URL('../', import.meta.url));
const values = dotenv.parse(await fs.readFile(new URL('../.env', import.meta.url)));
const token = process.env.STORYBOOK_MCP_TOKEN || values.STORYBOOK_MCP_TOKEN;
if (!token || /\s/.test(token)) {
  console.error('STORYBOOK_MCP_TOKEN is missing or invalid in root .env/current environment.');
  process.exit(1);
}
if (process.argv.includes('--check')) {
  console.log('STORYBOOK_MCP_TOKEN is present. Its value and other root .env variables were not printed or exported.');
} else {
  const child = spawn('codex', process.argv.slice(2), { cwd: root, stdio: 'inherit',
    env: { ...process.env, STORYBOOK_MCP_TOKEN: token } });
  child.on('error', error => { console.error(error.code === 'ENOENT' ? 'codex CLI is not on PATH.' : 'Unable to start Codex CLI.'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
}
