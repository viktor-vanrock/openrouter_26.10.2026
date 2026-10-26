export type StageIdentity = { attemptId: string; executionId: string; stageId: string };

export class Phase3Pipeline {
  constructor(private readonly adapters: {
    generate(identity: StageIdentity): Promise<{ checkpoint: unknown; sourceDigest: string }>;
    prepareDependencies(sourceDigest: string, identity: StageIdentity): Promise<unknown>;
    transfer(input: unknown, identity: StageIdentity): Promise<unknown>;
    buildQa(input: { source: unknown; dependencyBundle: unknown }, identity: StageIdentity): Promise<unknown>;
    repair(input: { diagnostics: string[]; previous: StageIdentity }, identity: StageIdentity): Promise<{ checkpoint: unknown; sourceDigest: string }>;
    publish(input: { checkpoint: unknown; snapshot: unknown }, identity: StageIdentity): Promise<unknown>;
    acceptPublication(input: unknown, identity: StageIdentity): Promise<unknown>;
    createIdentity(stage: 'generation' | 'transfer' | 'dependency_preparation' | 'build_qa' | 'publish', repair: number): StageIdentity;
    maxRepairs?: number;
  }) {}

  async run(): Promise<unknown> {
    let generationIdentity = this.adapters.createIdentity('generation', 0);
    let generated = await this.adapters.generate(generationIdentity);
    const dependencies = await this.adapters.prepareDependencies(
      generated.sourceDigest,
      this.adapters.createIdentity('dependency_preparation', 0),
    );
    const dependencyBundle = await this.adapters.transfer(dependencies, this.adapters.createIdentity('transfer', 0));
    const maxRepairs = this.adapters.maxRepairs ?? 2;
    let snapshot;
    for (let repair = 0; repair <= maxRepairs; repair += 1) {
      const source = await this.adapters.transfer(generated.checkpoint, this.adapters.createIdentity('transfer', repair));
      const buildIdentity = this.adapters.createIdentity('build_qa', repair);
      try {
        snapshot = await this.adapters.buildQa({ source, dependencyBundle }, buildIdentity);
        break;
      } catch (error) {
        if (repair === maxRepairs) throw error;
        const diagnostics = Array.isArray((error as { diagnostics?: unknown }).diagnostics)
          ? (error as { diagnostics: string[] }).diagnostics.slice(0, 20)
          : ['Build or QA failed'];
        const nextIdentity = this.adapters.createIdentity('generation', repair + 1);
        if (nextIdentity.attemptId === generationIdentity.attemptId || nextIdentity.executionId === generationIdentity.executionId) {
          throw new Error('PROTOTYPE_REPAIR_IDENTITY_REUSED');
        }
        generated = await this.adapters.repair({ diagnostics, previous: generationIdentity }, nextIdentity);
        generationIdentity = nextIdentity;
      }
    }
    const publishIdentity = this.adapters.createIdentity('publish', 0);
    const publication = await this.adapters.publish({ checkpoint: generated.checkpoint, snapshot }, publishIdentity);
    return this.adapters.acceptPublication(publication, publishIdentity);
  }
}
