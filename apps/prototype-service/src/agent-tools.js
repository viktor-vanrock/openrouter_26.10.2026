import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { validateSourcePath, sourceBytes, SOURCE_LIMITS } from './source-manifest.js';

const fixed = (name) =>
  name === 'src/app/main.tsx' ||
  name.startsWith('src/app/providers/') ||
  name.startsWith('src/app/styles/');
/** Data-only source tools for the agent sandbox. The installed runtime must deny all other tools.
 * This module never evaluates source or executes shell commands.
 */
export class AgentSourceTools {
  constructor({ root, authorize, consumeTool }) {
    if (typeof authorize !== 'function' || typeof consumeTool !== 'function')
      throw new Error('PROTOTYPE_AGENT_AUTHORITY_REQUIRED');
    this.root = path.resolve(root);
    this.authorize = authorize;
    this.consumeTool = consumeTool;
    this.writes = Promise.resolve();
  }
  async target(name, create = false) {
    validateSourcePath(name);
    if (fixed(name)) throw new Error('PROTOTYPE_AGENT_IMMUTABLE_SOURCE');
    const rootStat = await fs.lstat(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink())
      throw new Error('PROTOTYPE_AGENT_PATH_REJECTED');
    const parts = name.split('/');
    let parent = this.root;
    for (const part of parts.slice(0, -1)) {
      parent = path.join(parent, part);
      if (create)
        await fs.mkdir(parent).catch((error) => {
          if (error.code !== 'EEXIST') throw error;
        });
      const stat = await fs.lstat(parent);
      if (!stat.isDirectory() || stat.isSymbolicLink())
        throw new Error('PROTOTYPE_AGENT_PATH_REJECTED');
    }
    const filename = path.join(parent, parts.at(-1));
    try {
      const stat = await fs.lstat(filename);
      if (
        !stat.isFile() ||
        stat.isSymbolicLink() ||
        stat.nlink !== 1 ||
        stat.size > SOURCE_LIMITS.maxFileBytes
      ) {
        throw new Error('PROTOTYPE_AGENT_PATH_REJECTED');
      }
    } catch (error) {
      if (!create || error.code !== 'ENOENT') throw error;
    }
    return filename;
  }
  async read(name, actionId) {
    await this.authorize();
    await this.consumeTool(actionId);
    const filename = await this.target(name);
    const handle = await fs.open(filename, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > SOURCE_LIMITS.maxFileBytes)
        throw new Error('PROTOTYPE_AGENT_PATH_REJECTED');
      const bytes = await handle.readFile();
      if (
        bytes.length > SOURCE_LIMITS.maxFileBytes ||
        !Buffer.from(bytes.toString('utf8')).equals(bytes)
      )
        throw new Error('PROTOTYPE_AGENT_SOURCE_INVALID');
      return bytes.toString('utf8');
    } finally {
      await handle.close();
    }
  }
  async list() {
    await this.authorize();
    const names = [];
    let expanded = 0,
      directories = 0;
    const visit = async (directory) => {
      const stat = await fs.lstat(directory);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        ++directories > 2000 ||
        path.relative(this.root, directory).split(path.sep).length > 64
      )
        throw new Error('PROTOTYPE_AGENT_PATH_REJECTED');
      for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name),
          name = path.relative(this.root, absolute).split(path.sep).join('/');
        if (entry.isSymbolicLink()) throw new Error('PROTOTYPE_AGENT_PATH_REJECTED');
        if (entry.isDirectory()) {
          if (fixed(`${name}/`)) continue;
          await visit(absolute);
        } else {
          if (fixed(name)) continue;
          validateSourcePath(name);
          const filename = await this.target(name),
            stat = await fs.stat(filename);
          names.push(name);
          expanded += stat.size;
          if (names.length > SOURCE_LIMITS.maxFiles || expanded > SOURCE_LIMITS.maxSourceBytes)
            throw new Error('PROTOTYPE_AGENT_SOURCE_LIMIT');
        }
      }
    };
    await visit(path.join(this.root, 'src'));
    return names.sort();
  }
  async search(query, actionId) {
    if (typeof query !== 'string' || !query.length || query.length > 256)
      throw new Error('PROTOTYPE_AGENT_SEARCH_INVALID');
    await this.authorize();
    await this.consumeTool(actionId);
    const result = [];
    for (const name of await this.list()) {
      const handle = await fs.open(
        await this.target(name),
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      let source;
      try {
        source = await handle.readFile('utf8');
      } finally {
        await handle.close();
      }
      for (const [index, line] of source.split('\n').entries())
        if (line.includes(query)) {
          result.push({ path: name, line: index + 1, text: line.slice(0, 512) });
          if (result.length === 100) return result;
        }
    }
    return result;
  }
  async write(name, source, actionId) {
    const bytes = sourceBytes(source);
    if (bytes.length > SOURCE_LIMITS.maxFileBytes) throw new Error('PROTOTYPE_AGENT_SOURCE_LIMIT');
    const operation = this.writes.then(async () => {
      await this.authorize();
      await this.consumeTool(actionId);
      const filename = await this.target(name, true);
      const current = await this.list();
      let total = bytes.length;
      for (const file of current)
        if (file !== name) total += (await fs.stat(await this.target(file))).size;
      if (
        (!current.includes(name) && current.length >= SOURCE_LIMITS.maxFiles) ||
        total > SOURCE_LIMITS.maxSourceBytes
      )
        throw new Error('PROTOTYPE_AGENT_SOURCE_LIMIT');
      await this.authorize();
      const handle = await fs.open(
        filename,
        constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1) throw new Error('PROTOTYPE_AGENT_PATH_REJECTED');
        await handle.truncate(0);
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      return { path: name, bytes: bytes.length };
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
  async remove(name, actionId) {
    const operation = this.writes.then(async () => {
      await this.authorize();
      await this.consumeTool(actionId);
      const filename = await this.target(name);
      await fs.unlink(filename);
      return { path: name, removed: true };
    });
    this.writes = operation.catch(() => undefined);
    return operation;
  }
}
