import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AgentSourceTools } from '../src/agent-tools.js';

test('source tools read/search/write only bounded source and refuse config, traversal, links and revoked authority', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-source-tools-'));
  let active = true;
  const tools = new AgentSourceTools({
    root,
    authorize: async () => {
      if (!active) throw new Error('revoked');
    },
    consumeTool: async () => {},
  });
  try {
    await tools.write(
      'src/entities/employee/model/demo.ts',
      'export const name = "Employee";',
      'write1',
    );
    assert.match(await tools.read('src/entities/employee/model/demo.ts', 'read1'), /Employee/);
    assert.equal((await tools.search('Employee', 'search1')).length, 1);
    for (const name of [
      '../secret.ts',
      'package.json',
      'src/app/main.tsx',
      'src/app/providers/index.tsx',
      'src/app/styles/globals.css',
    ]) {
      await assert.rejects(tools.write(name, 'forbidden', 'deny'));
    }
    await fs.symlink('/tmp', path.join(root, 'src/shared'));
    await assert.rejects(
      tools.write('src/shared/lib/file.ts', 'forbidden', 'link'),
      /PATH_REJECTED/,
    );
    await fs.unlink(path.join(root, 'src/shared'));
    await fs.link(
      path.join(root, 'src/entities/employee/model/demo.ts'),
      path.join(root, 'src/entities/employee/model/link.ts'),
    );
    await assert.rejects(
      tools.read('src/entities/employee/model/link.ts', 'hardlink'),
      /PATH_REJECTED/,
    );
    await fs.unlink(path.join(root, 'src/entities/employee/model/link.ts'));
    active = false;
    await assert.rejects(
      tools.write('src/entities/employee/model/demo.ts', 'changed', 'revoked'),
      /revoked/,
    );
    assert.match(
      await fs.readFile(path.join(root, 'src/entities/employee/model/demo.ts'), 'utf8'),
      /Employee/,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
