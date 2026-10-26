import { interpretTurn } from './interpret';

const CODE_DONE = /(?:^|\n)PROTOTYPE_CODE_DONE:\s*([a-z0-9]+(?:-[a-z0-9]+)*)\s*$/i;

export class PrototypeExecutionRunner {
  constructor(
    private readonly deps: {
      client: { runTurn(session: unknown, prompt: string, onProgress: (value: string) => void): Promise<string> };
      checks(workspace: string): Promise<{ clean: boolean; output: string }>;
      maxCheckRetries?: number;
      maxTurnRetries?: number;
    },
  ) {}

  async run(session: unknown, prompt: string, onProgress: (value: string) => void) {
    const maxRetries = this.deps.maxCheckRetries ?? 3;
    let checkAttempt = 0;
    let turnAttempt = 0;
    let currentPrompt = prompt;
    while (true) {
      let text: string;
      try {
        text = await this.deps.client.runTurn(session, currentPrompt, onProgress);
      } catch (error) {
        const maxTurnRetries = this.deps.maxTurnRetries ?? 2;
        if (!(error as Error).message.includes('inactivity timeout') || turnAttempt >= maxTurnRetries) {
          throw error;
        }
        turnAttempt += 1;
        currentPrompt = `Continue: the previous turn timed out (${turnAttempt}/${maxTurnRetries}).`;
        continue;
      }
      const codeDone = text.trim().match(CODE_DONE);
      if (!codeDone) {
        const result = interpretTurn(text);
        if (result.kind === 'waiting') {
          return { type: 'waiting', payload: { waitingReason: result.waitingReason, text: result.text } };
        }
        return {
          type: result.kind === 'review' ? 'review_ready' : 'completed',
          payload: { prototypeSlug: result.prototypeSlug, summary: result.text },
        };
      }
      const workspace =
        typeof session === 'object' && session != null && 'workspace' in session
          ? String(session.workspace)
          : '';
      if (!workspace) throw new Error('Prototype execution session has no workspace');
      const checked = await this.deps.checks(workspace);
      if (checked.clean) {
        currentPrompt = `Checks passed. Report the result and end with PROTOTYPE_READY: ${codeDone[1]}`;
        continue;
      }
      if (checkAttempt >= maxRetries) {
        throw new Error(`Prototype checks failed after ${maxRetries} retries`);
      }
      checkAttempt += 1;
      currentPrompt = `Checks failed (${checkAttempt}/${maxRetries}). Fix them and end with PROTOTYPE_CODE_DONE: ${codeDone[1]}.\n${checked.output}`;
    }
  }
}
