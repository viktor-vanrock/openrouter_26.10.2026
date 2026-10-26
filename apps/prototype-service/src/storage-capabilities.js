import { isConditionalCreateConflict } from '@librechat/prototype-worker';
import { randomUUID } from 'node:crypto';

/** Admission gate for the publication contract, tested only under a unique owned prefix. */
export async function assertStorageCapabilities({ client, bucket }) {
  const key = `prototypes/acceptance/${randomUUID()}/capabilities.txt`;
  const body = Buffer.from('prototype storage capability probe');
  let created = false;
  try {
    await client.putObject({ bucket, key, body, ifNoneMatch: '*' });
    created = true;
    if (
      (await client.headObject({ bucket, key }))?.size !== body.length ||
      !(await client.getObject({ bucket, key })).equals(body)
    )
      throw new Error('PROTOTYPE_STORAGE_VERIFY_FAILED');
    let conditional = false;
    try {
      await client.putObject({
        bucket,
        key,
        body: Buffer.from('must not overwrite'),
        ifNoneMatch: '*',
      });
    } catch (error) {
      if (isConditionalCreateConflict(error)) conditional = true;
      else throw error;
    }
    if (!conditional || !(await client.getObject({ bucket, key })).equals(body)) {
      throw new Error('PROTOTYPE_STORAGE_CONDITIONAL_WRITE_UNSUPPORTED');
    }
  } finally {
    if (created) {
      await client.deleteObject({ bucket, key });
      if (await client.headObject({ bucket, key }))
        throw new Error('PROTOTYPE_STORAGE_CLEANUP_FAILED');
    }
  }
}
