import { safeWorkerError } from './safeErrors';

describe('safeWorkerError', () => {
  it('redacts tokens, authorization values, and absolute paths', () => {
    const error = safeWorkerError(
      new Error('Bearer secret-job-token failed at /private/tmp/job_1 with apiKey=abc123'),
    );
    expect(error).toEqual({
      code: 'PROTOTYPE_EXECUTION_FAILED',
      message: 'Prototype execution failed',
    });
    expect(JSON.stringify(error)).not.toMatch(/secret-job-token|abc123|private\/tmp/);
  });
});
