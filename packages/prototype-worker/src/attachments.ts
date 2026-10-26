import fs from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { PrototypeCommand } from './contracts';

type Manifest = PrototypeCommand['attachmentManifest'];

function safeName(value: string): string {
  const base = path.basename(value).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base && base !== '.' && base !== '..' ? base.slice(0, 180) : 'attachment.bin';
}

export async function materializeAttachments(input: {
  workspace: string;
  manifest: Manifest;
  openAttachment(fileId: string): Promise<NodeJS.ReadableStream>;
}): Promise<string[]> {
  const inputs = path.join(input.workspace, 'inputs');
  await fs.mkdir(inputs, { recursive: true });
  const written: string[] = [];
  try {
    for (const [index, entry] of input.manifest.entries()) {
      const filename = `${String(index + 1).padStart(3, '0')}-${safeName(entry.filename)}`;
      const destination = path.join(inputs, filename);
      const source = await input.openAttachment(entry.fileId);
      const handle = await fs.open(destination, 'wx');
      await handle.close();
      await pipeline(source, (await fs.open(destination, 'w')).createWriteStream());
      const stat = await fs.stat(destination);
      if (stat.size !== entry.size) throw new Error('Attachment size does not match manifest');
      written.push(`inputs/${filename}`);
    }
  } catch (error) {
    await fs.rm(inputs, { recursive: true, force: true });
    await fs.mkdir(inputs, { recursive: true });
    throw error;
  }
  return written;
}
