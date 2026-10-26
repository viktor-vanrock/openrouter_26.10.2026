import https from 'node:https';
import fs from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import {
  decodePipelineResult,
  validatePipelineInput,
  MAX_RESULT_BYTES,
} from './pipeline-contract.js';
import { safeDiagnostics } from './pipeline-diagnostics.js';

/** No Kubernetes credentials: this adapter speaks only the fixed pipeline API. */
export class PipelineClient {
  constructor({ baseUrl, ca, cert, key }) {
    this.baseUrl = new URL(baseUrl);
    if (this.baseUrl.protocol !== 'https:' || this.baseUrl.username || this.baseUrl.password) {
      throw new Error('PIPELINE_URL_INVALID');
    }
    this.tls = { ca, cert, key, rejectUnauthorized: true };
  }
  static async fromDirectory(directory, baseUrl = 'https://localhost:19443') {
    const [ca, cert, key] = await Promise.all(
      ['ca.crt', 'client.crt', 'client.key'].map((name) => fs.readFile(`${directory}/${name}`)),
    );
    return new PipelineClient({ baseUrl, ca, cert, key });
  }
  request(method, pathname, body) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        new URL(pathname, this.baseUrl),
        { ...this.tls, method, headers: { 'content-type': 'application/json' }, timeout: 15_000 },
        (res) => {
          const chunks = [];
          let size = 0;
          res.on('data', (bytes) => {
            size += bytes.length;
            if (size > MAX_RESULT_BYTES + 64_000)
              res.destroy(new Error('PIPELINE_RESPONSE_TOO_LARGE'));
            else chunks.push(bytes);
          });
          res.on('error', reject);
          res.on('end', () => {
            try {
              const value = JSON.parse(Buffer.concat(chunks));
              if (res.statusCode < 200 || res.statusCode >= 300) {
                const error = new Error(value.error ?? 'PIPELINE_REQUEST_FAILED');
                error.status = res.statusCode;
                reject(error);
              } else resolve(value);
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      req.on('error', reject);
      req.on('timeout', () => req.destroy(new Error('PIPELINE_REQUEST_TIMEOUT')));
      req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  async run(input, { signal, timeoutMs = 240_000 } = {}) {
    validatePipelineInput(input);
    signal?.throwIfAborted();
    const run = await this.request('POST', '/v1/runs', input);
    const deadline = Date.now() + timeoutMs;
    try {
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const state = await this.request('GET', `/v1/runs/${run.name}`);
        if (state.status === 'succeeded') {
          return decodePipelineResult(
            input,
            await this.request('GET', `/v1/runs/${run.name}/result`),
          );
        }
        if (state.status === 'failed') {
          const error = new Error('PIPELINE_EXECUTION_FAILED');
          error.writersStopped = true;
          const failure = await this.request('GET', `/v1/runs/${run.name}/diagnostics`).catch(
            () => null,
          );
          error.diagnostics = safeDiagnostics(failure?.diagnostics);
          error.failureCode = /^PROTOTYPE_[A-Z_]+$|^PIPELINE_[A-Z_]+$/.test(failure?.code ?? '')
            ? failure.code
            : error.message;
          throw error;
        }
        await delay(750, undefined, { signal });
      }
      throw new Error('PIPELINE_DEADLINE_EXCEEDED');
    } catch (error) {
      if (error.message !== 'PIPELINE_EXECUTION_FAILED') {
        const canceled = await this.request('DELETE', `/v1/runs/${run.name}`).catch(() => null);
        error.writersStopped = canceled?.writersStopped === true;
      }
      error.runName = run.name;
      throw error;
    }
  }
}
