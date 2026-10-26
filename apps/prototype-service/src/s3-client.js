import { configureConditionalPut, s3ConditionalCreateMode } from '@librechat/prototype-worker';
import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';

async function streamToBuffer(body) {
  if (typeof body?.transformToByteArray === 'function')
    return Buffer.from(await body.transformToByteArray());
  const chunks = [];
  for await (const chunk of body) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

export class StageS3Client {
  constructor(config) {
    this.client = new S3Client(config);
    this.conditionalCreate = s3ConditionalCreateMode(config.endpoint);
  }
  async putObject({ bucket, key, body, metadata, ifNoneMatch }) {
    const command = new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      Metadata: metadata,
      ...(ifNoneMatch ? { IfNoneMatch: ifNoneMatch } : {}),
    });
    configureConditionalPut(command, this.conditionalCreate, ifNoneMatch);
    await this.client.send(command);
  }
  async headObject({ bucket, key }) {
    try {
      const value = await this.client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
      return { size: value.ContentLength, metadata: value.Metadata ?? {} };
    } catch (error) {
      if (error?.$metadata?.httpStatusCode === 404 || error?.name === 'NotFound') return null;
      throw error;
    }
  }
  async getObject({ bucket, key }) {
    const value = await this.client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    return streamToBuffer(value.Body);
  }
  async deleteObject({ bucket, key }) {
    await this.client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }));
  }
  destroy() {
    this.client.destroy();
  }
}
