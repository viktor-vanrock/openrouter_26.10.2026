import fs from 'node:fs/promises';
import path from 'node:path';
import {
  inspectZipArchive, extractZipArchive, inspectTarZstdArchive, extractTarZstdArchive,
  type ArchiveLimits,
} from '../archivePolicy';
import type { ArtifactOwner, ArtifactStore, ImmutableStoredObject } from './types';

export class TransferAdapter {
  constructor(private readonly store: ArtifactStore, private readonly limits: ArchiveLimits) {}

  async restoreZip(reference: ImmutableStoredObject, owner: ArtifactOwner, destination: string): Promise<void> {
    const absolute = path.resolve(destination);
    await fs.mkdir(absolute, { recursive: false });
    try {
      const bytes = await this.store.readVerified(reference, owner);
      await inspectZipArchive(bytes, this.limits);
      await extractZipArchive(bytes, absolute, this.limits);
    } catch (error) {
      await fs.rm(absolute, { recursive: true, force: true });
      throw error;
    }
  }

  async restoreTarZstd(reference: ImmutableStoredObject, owner: ArtifactOwner, destination: string): Promise<void> {
    const absolute = path.resolve(destination);
    await fs.mkdir(absolute, { recursive: false });
    try {
      const bytes = await this.store.readVerified(reference, owner);
      await inspectTarZstdArchive(bytes, this.limits);
      await extractTarZstdArchive(bytes, absolute, this.limits);
    } catch (error) {
      await fs.rm(absolute, { recursive: true, force: true });
      throw error;
    }
  }

  async publishQuiesced(
    input: Parameters<ArtifactStore['publish']>[0],
    writersStopped: () => Promise<boolean>,
  ): Promise<ImmutableStoredObject> {
    if (!(await writersStopped())) throw new Error('PROTOTYPE_WRITERS_NOT_QUIESCED');
    return this.store.publish(input);
  }
}
