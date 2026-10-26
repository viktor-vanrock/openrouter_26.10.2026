import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { materializeAttachments } from './attachments';

describe('local attachment materialization', () => {
  it('copies only manifest-bound files under generated safe names', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-attachments-'));
    try {
      const source = path.join(root, 'source.bin');
      const workspace = path.join(root, 'workspace');
      await fs.mkdir(workspace);
      await fs.writeFile(source, 'slides');
      const paths = await materializeAttachments({
        workspace,
        manifest: [{ fileId: 'file_1', filename: '../../pitch.pptx', mimeType: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', size: 6 }],
        openAttachment: async (fileId) => {
          expect(fileId).toBe('file_1');
          return fs.open(source, 'r').then((handle) => handle.createReadStream());
        },
      });
      expect(paths).toEqual(['inputs/001-pitch.pptx']);
      expect(await fs.readFile(path.join(workspace, paths[0]), 'utf8')).toBe('slides');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('removes partial files when attachment size differs from the manifest', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-attachments-'));
    try {
      const source = path.join(root, 'source.bin');
      const workspace = path.join(root, 'workspace');
      await fs.mkdir(workspace);
      await fs.writeFile(source, 'too large');
      await expect(materializeAttachments({
        workspace,
        manifest: [{ fileId: 'file_1', filename: 'a.txt', mimeType: 'text/plain', size: 1 }],
        openAttachment: async () => fs.open(source, 'r').then((handle) => handle.createReadStream()),
      })).rejects.toThrow('size');
      await expect(fs.readdir(path.join(workspace, 'inputs'))).resolves.toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('removes all materialized files when a later attachment fails', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-attachments-'));
    try {
      const first = path.join(root, 'first.bin');
      const second = path.join(root, 'second.bin');
      const workspace = path.join(root, 'workspace');
      await fs.mkdir(workspace);
      await fs.writeFile(first, 'ok');
      await fs.writeFile(second, 'wrong');
      await expect(materializeAttachments({
        workspace,
        manifest: [
          { fileId: 'file_1', filename: 'one.txt', mimeType: 'text/plain', size: 2 },
          { fileId: 'file_2', filename: 'two.txt', mimeType: 'text/plain', size: 1 },
        ],
        openAttachment: async (fileId) => fs.open(fileId === 'file_1' ? first : second, 'r').then((handle) => handle.createReadStream()),
      })).rejects.toThrow('size');
      expect(await fs.readdir(path.join(workspace, 'inputs'))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
