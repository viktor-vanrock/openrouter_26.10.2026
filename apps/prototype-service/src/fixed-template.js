import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const CONTROL_FILES = [
  'package.json',
  'package-lock.json',
  'vite.config.ts',
  'tsconfig.json',
  'eslint.config.js',
  'postcss.config.js',
  'tailwind.config.js',
  'index.html',
];
const EXCLUDED = new Set(['node_modules', 'dist', 'tsconfig.tsbuildinfo', '.DS_Store']);
const FORBIDDEN = ['.npmrc', 'opencode.json', 'opencode.jsonc', '.opencode'];
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

async function regularBytes(filename) {
  const stat = await fs.lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 5_000_000) {
    throw new Error('PROTOTYPE_FIXED_TEMPLATE_INVALID');
  }
  return fs.readFile(filename);
}

export async function fixedTemplateProfile(root = '/opt/prototype/template') {
  const absolute = await fs.realpath(root);
  const hashes = {};
  for (const name of CONTROL_FILES)
    hashes[name] = digest(await regularBytes(path.join(absolute, name)));
  const modules = await fs.lstat(path.join(absolute, 'node_modules'));
  if (!modules.isDirectory() || modules.isSymbolicLink())
    throw new Error('PROTOTYPE_FIXED_DEPENDENCIES_UNAVAILABLE');
  return {
    root: absolute,
    hashes,
    templateDigest: digest(Buffer.from(JSON.stringify(hashes))),
    toolchainDigest: digest(
      Buffer.from(
        JSON.stringify({
          node: process.version,
          abi: process.versions.modules,
          platform: process.platform,
          architecture: process.arch,
          lockfileDigest: hashes['package-lock.json'],
        }),
      ),
    ),
  };
}

export async function initializeFixedWorkspace(workspace, root = '/opt/prototype/template') {
  const profile = await fixedTemplateProfile(root);
  await fs.mkdir(workspace, { recursive: true });
  if ((await fs.readdir(workspace)).length !== 0)
    throw new Error('PROTOTYPE_FIXED_WORKSPACE_NOT_EMPTY');
  await fs.cp(profile.root, workspace, {
    recursive: true,
    filter: (source) => {
      const relative = path.relative(profile.root, source);
      return !EXCLUDED.has(relative.split(path.sep)[0]);
    },
  });
  // The real image contains npm's .bin symlinks and native optional binaries.
  // They are not repacked or installed by an execution, and cannot poison a cache.
  await fs.symlink(
    path.join(profile.root, 'node_modules'),
    path.join(workspace, 'node_modules'),
    'dir',
  );
  return profile;
}

export async function prepareFixedWorkspace(workspace, options = {}) {
  const root = options.root ?? '/opt/prototype/template';
  await fs.mkdir(workspace, { recursive: true });
  if ((await fs.readdir(workspace)).length === 0) await initializeFixedWorkspace(workspace, root);
  else {
    // Checkpoint archives intentionally omit dependencies. Attach only the image's
    // fixed dependency tree; never replace an existing untrusted tree or symlink.
    const modulesPath = path.join(workspace, 'node_modules');
    try {
      await fs.lstat(modulesPath);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const profile = await fixedTemplateProfile(root);
      await fs.symlink(path.join(profile.root, 'node_modules'), modulesPath, 'dir');
    }
  }
  return verifyFixedWorkspace(workspace, { ...options, root });
}

export async function verifyFixedWorkspace(
  workspace,
  { root = '/opt/prototype/template', templateDigest, toolchainDigest } = {},
) {
  const profile = await fixedTemplateProfile(root);
  if (
    (templateDigest && templateDigest !== profile.templateDigest) ||
    (toolchainDigest && toolchainDigest !== profile.toolchainDigest)
  ) {
    throw new Error('PROTOTYPE_FIXED_PROFILE_MISMATCH');
  }
  for (const name of CONTROL_FILES) {
    if (digest(await regularBytes(path.join(workspace, name))) !== profile.hashes[name]) {
      throw new Error('PROTOTYPE_FIXED_TEMPLATE_MODIFIED');
    }
  }
  for (const name of FORBIDDEN) {
    try {
      await fs.lstat(path.join(workspace, name));
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    throw new Error('PROTOTYPE_FIXED_TEMPLATE_MODIFIED');
  }
  const modulesPath = path.join(workspace, 'node_modules');
  if (
    !(await fs.lstat(modulesPath)).isSymbolicLink() ||
    (await fs.realpath(modulesPath)) !== path.join(profile.root, 'node_modules')
  ) {
    throw new Error('PROTOTYPE_FIXED_DEPENDENCIES_MODIFIED');
  }
  return profile;
}
