import { Phase3Pipeline } from './phase3Pipeline';

describe('Phase3Pipeline', () => {
  it('completes fake generation through immutable transfer, repair, offline QA and publication', async () => {
    const calls: string[] = [];
    let build = 0;
    const pipeline = new Phase3Pipeline({
      createIdentity: (stage, repair) => ({ attemptId: `attempt_${repair}`, executionId: `${stage}_${repair}`, stageId: `${stage}_${repair}` }),
      generate: async () => { calls.push('generate'); return { checkpoint: 'cp0', sourceDigest: 'digest0' }; },
      prepareDependencies: async () => { calls.push('dependencies'); return 'bundle-stored'; },
      transfer: async (value) => { calls.push(`transfer:${value}`); return `copy:${value}`; },
      buildQa: async () => { calls.push('build'); if (build++ === 0) throw Object.assign(new Error('failed'), { diagnostics: ['type error'] }); return 'verified-snapshot'; },
      repair: async ({ diagnostics }) => { calls.push(`repair:${diagnostics[0]}`); return { checkpoint: 'cp1', sourceDigest: 'digest1' }; },
      publish: async () => { calls.push('publish'); return 'immutable-publication'; },
      acceptPublication: async (value) => { calls.push('accept'); return value; },
    });
    await expect(pipeline.run()).resolves.toBe('immutable-publication');
    expect(calls).toEqual(['generate', 'dependencies', 'transfer:bundle-stored', 'transfer:cp0', 'build', 'repair:type error', 'transfer:cp1', 'build', 'publish', 'accept']);
  });

  it('never accepts review when publication fails', async () => {
    const acceptPublication = jest.fn();
    const pipeline = new Phase3Pipeline({
      createIdentity: (stage) => ({ attemptId: 'attempt_1', executionId: `${stage}_1`, stageId: `${stage}_1` }),
      generate: async () => ({ checkpoint: 'cp', sourceDigest: 'digest' }), prepareDependencies: async () => 'bundle',
      transfer: async (value) => value, buildQa: async () => 'snapshot', repair: async () => ({ checkpoint: 'cp2', sourceDigest: 'digest2' }),
      publish: async () => { throw new Error('S3 outage'); }, acceptPublication,
    });
    await expect(pipeline.run()).rejects.toThrow('S3 outage');
    expect(acceptPublication).not.toHaveBeenCalled();
  });
});
