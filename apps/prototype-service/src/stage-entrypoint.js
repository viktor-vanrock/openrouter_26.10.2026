import { runStageCommand, writeStageFailure } from './stage-runtime.js';

const stage = process.argv[3];
try {
  await runStageCommand(stage);
} catch (error) {
  let code = 'PROTOTYPE_EXECUTION_FAILED';
  try {
    const failure = await writeStageFailure(stage, error);
    code = failure.code;
  } catch {}
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
}
