import { configureConditionalPut, isConditionalCreateConflict, s3ConditionalCreateMode } from './s3Conditional';

describe('S3 conditional-create compatibility', () => {
  it('uses OBS compatibility only for verified provider host patterns, independent of path style', () => {
    expect(s3ConditionalCreateMode('https://obs.ru-moscow-1.hc.sbercloud.ru')).toBe('obs-forbid-overwrite');
    expect(s3ConditionalCreateMode('https://obs.cn-north-4.myhuaweicloud.com')).toBe('obs-forbid-overwrite');
    for (const endpoint of [undefined, 'http://127.0.0.1:19000', 'https://s3.eu-west-1.amazonaws.com',
      'https://obs.ru-moscow-1.hc.sbercloud.ru.evil.test']) {
      expect(s3ConditionalCreateMode(endpoint)).toBe('s3-if-none-match');
    }
  });
  it('adds a signed create-only provider header only for conditional PUT, not ordinary file overwrites', async () => {
    let middleware: any;
    const command = { middlewareStack: { add: jest.fn((value) => { middleware = value; }) } };
    configureConditionalPut(command, 'obs-forbid-overwrite', '*');
    const next = jest.fn(async () => ({}));
    const args = { request: { headers: { 'if-none-match': '*' } as Record<string, string> } };
    await middleware(next)(args);
    expect(args.request.headers['x-amz-forbid-overwrite']).toBe('true');
    expect(command.middlewareStack.add).toHaveBeenCalledWith(expect.any(Function), expect.objectContaining({ step: 'build' }));
    command.middlewareStack.add.mockClear();
    configureConditionalPut(command, 'obs-forbid-overwrite');
    configureConditionalPut(command, 's3-if-none-match', '*');
    expect(command.middlewareStack.add).not.toHaveBeenCalled();
  });
  it('recognizes only precondition/object-exists rejections, never arbitrary 409 or auth errors', () => {
    expect(isConditionalCreateConflict({ name: 'ObjectAlreadyExists', $metadata: { httpStatusCode: 409 } })).toBe(true);
    expect(isConditionalCreateConflict({ $metadata: { httpStatusCode: 412 } })).toBe(true);
    for (const error of [{ name: 'Conflict', $metadata: { httpStatusCode: 409 } }, { $metadata: { httpStatusCode: 403 } }]) {
      expect(isConditionalCreateConflict(error)).toBe(false);
    }
  });
});
