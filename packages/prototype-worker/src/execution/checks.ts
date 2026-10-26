import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
export type CheckResult = { clean: boolean; output: string };

export async function runPrototypeChecks(
  workspace: string,
  run = exec,
): Promise<CheckResult> {
  const output: string[] = [];
  for (const script of ['type-check', 'lint']) {
    try {
      await run('npm', ['run', script], { cwd: workspace, timeout: 120_000 });
    } catch (error) {
      output.push(String((error as { stderr?: string }).stderr ?? (error as Error).message).slice(-8000));
    }
  }
  return { clean: output.length === 0, output: output.join('\n') };
}
