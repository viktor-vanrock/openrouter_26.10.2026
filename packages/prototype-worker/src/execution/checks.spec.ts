import { runPrototypeChecks } from './checks';

describe('runPrototypeChecks', () => {
  it('runs only bounded type-check and lint commands without installing dependencies', async () => {
    const run = jest.fn(async () => ({ stdout: '', stderr: '' }));
    await expect(runPrototypeChecks('/tmp/workspace', run as never)).resolves.toEqual({
      clean: true, output: '',
    });
    expect(run.mock.calls.map((call) => call[1])).toEqual([
      ['run', 'type-check'], ['run', 'lint'],
    ]);
  });

  it('returns sanitized bounded check failures to the repair loop', async () => {
    const run = jest.fn(async (_file, args) => {
      if (args[1] === 'type-check') throw { stderr: 'x'.repeat(9000) };
      return { stdout: '', stderr: '' };
    });
    const result = await runPrototypeChecks('/tmp/workspace', run as never);
    expect(result.clean).toBe(false);
    expect(result.output).toHaveLength(8000);
  });
});
