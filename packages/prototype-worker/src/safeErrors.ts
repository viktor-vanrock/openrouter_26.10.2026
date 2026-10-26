export type SafeWorkerError = {
  code: 'PROTOTYPE_EXECUTION_FAILED';
  message: 'Prototype execution failed';
};

export function safeWorkerError(_error: unknown): SafeWorkerError {
  return {
    code: 'PROTOTYPE_EXECUTION_FAILED',
    message: 'Prototype execution failed',
  };
}
