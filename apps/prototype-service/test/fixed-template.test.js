import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  fixedTemplateProfile,
  initializeFixedWorkspace,
  prepareFixedWorkspace,
  verifyFixedWorkspace,
} from '../src/fixed-template.js';

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-fixed-template-'));
  const root = path.join(directory, 'template');
  const workspace = path.join(directory, 'workspace');
  await fs.mkdir(path.join(root, 'node_modules/pkg'), { recursive: true });
  await fs.mkdir(path.join(root, 'src'));
  for (const name of [
    'package.json',
    'package-lock.json',
    'vite.config.ts',
    'tsconfig.json',
    'eslint.config.js',
    'postcss.config.js',
    'tailwind.config.js',
    'index.html',
  ]) {
    await fs.writeFile(path.join(root, name), `trusted:${name}`);
  }
  await fs.writeFile(path.join(root, 'src/app.tsx'), 'trusted source');
  return { directory, root, workspace };
}

test('fixed workspace uses image dependencies and allows source edits without npm installation', async () => {
  const value = await fixture();
  try {
    const profile = await initializeFixedWorkspace(value.workspace, value.root);
    await fs.writeFile(path.join(value.workspace, 'src/app.tsx'), 'generated source');
    assert.deepEqual(
      await verifyFixedWorkspace(value.workspace, { root: value.root, ...profile }),
      profile,
    );
    assert.equal(
      await fs.realpath(path.join(value.workspace, 'node_modules')),
      path.join(await fs.realpath(value.root), 'node_modules'),
    );
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true });
  }
});

test('fixed profile rejects changed manifest, lockfile or build configuration', async () => {
  for (const name of ['package.json', 'package-lock.json', 'vite.config.ts']) {
    const value = await fixture();
    try {
      await initializeFixedWorkspace(value.workspace, value.root);
      await fs.writeFile(path.join(value.workspace, name), 'model modification');
      await assert.rejects(
        () => verifyFixedWorkspace(value.workspace, { root: value.root }),
        /TEMPLATE_MODIFIED/,
      );
    } finally {
      await fs.rm(value.directory, { recursive: true, force: true });
    }
  }
});

test('fixed profile rejects unbound digests, project config, dependency substitution and control-file symlinks', async () => {
  const value = await fixture();
  try {
    await initializeFixedWorkspace(value.workspace, value.root);
    await assert.rejects(
      () =>
        verifyFixedWorkspace(value.workspace, {
          root: value.root,
          templateDigest: `sha256:${'0'.repeat(64)}`,
        }),
      /PROFILE_MISMATCH/,
    );
    await fs.writeFile(path.join(value.workspace, '.npmrc'), 'registry=http://hostile.test');
    await assert.rejects(
      () => verifyFixedWorkspace(value.workspace, { root: value.root }),
      /TEMPLATE_MODIFIED/,
    );
    await fs.unlink(path.join(value.workspace, '.npmrc'));
    await fs.unlink(path.join(value.workspace, 'node_modules'));
    await fs.mkdir(path.join(value.workspace, 'node_modules'));
    await assert.rejects(
      () => verifyFixedWorkspace(value.workspace, { root: value.root }),
      /DEPENDENCIES_MODIFIED/,
    );
    await fs.unlink(path.join(value.workspace, 'package.json'));
    await fs.symlink(
      path.join(value.root, 'package.json'),
      path.join(value.workspace, 'package.json'),
    );
    await assert.rejects(
      () => verifyFixedWorkspace(value.workspace, { root: value.root }),
      /TEMPLATE_INVALID/,
    );
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true });
  }
});

test('initialization does not overwrite an existing workspace and requires installed trusted dependencies', async () => {
  const value = await fixture();
  try {
    await initializeFixedWorkspace(value.workspace, value.root);
    await assert.rejects(() => initializeFixedWorkspace(value.workspace, value.root), /NOT_EMPTY/);
    await fs.rm(path.join(value.root, 'node_modules'), { recursive: true });
    await assert.rejects(() => fixedTemplateProfile(value.root), /ENOENT/);
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true });
  }
});

test('checkpoint restore attaches only fixed dependencies and never overwrites restored source', async () => {
  const value = await fixture();
  try {
    const profile = await prepareFixedWorkspace(value.workspace, { root: value.root });
    await fs.writeFile(path.join(value.workspace, 'src/app.tsx'), 'restored source');
    await fs.unlink(path.join(value.workspace, 'node_modules'));
    await prepareFixedWorkspace(value.workspace, profile);
    assert.equal(
      await fs.readFile(path.join(value.workspace, 'src/app.tsx'), 'utf8'),
      'restored source',
    );
    await fs.writeFile(path.join(value.workspace, 'package.json'), 'hostile restored manifest');
    await assert.rejects(
      () => prepareFixedWorkspace(value.workspace, profile),
      /TEMPLATE_MODIFIED/,
    );
  } finally {
    await fs.rm(value.directory, { recursive: true, force: true });
  }
});
