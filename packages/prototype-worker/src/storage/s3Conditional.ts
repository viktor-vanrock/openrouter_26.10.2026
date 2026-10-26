/** Provider compatibility for atomic create-only PUT. Addressing remains a separate SDK setting. */
export type S3ConditionalCreateMode = 's3-if-none-match' | 'obs-forbid-overwrite';
export function s3ConditionalCreateMode(endpoint?: string): S3ConditionalCreateMode {
  if (!endpoint) return 's3-if-none-match';
  const hostname = new URL(endpoint).hostname.toLowerCase();
  return /^obs(?:\.[a-z0-9-]+)+\.(?:hc\.sbercloud\.ru|myhuaweicloud\.com)$/.test(hostname)
    ? 'obs-forbid-overwrite' : 's3-if-none-match';
}

export function configureConditionalPut<T extends { middlewareStack: { add: (middleware: unknown, options: unknown) => void } }>(
  command: T, mode: S3ConditionalCreateMode, condition?: '*',
): T {
  if (condition && mode === 'obs-forbid-overwrite') {
    command.middlewareStack.add((next: (args: unknown) => Promise<unknown>) => async (args: { request: { headers: Record<string, string> } }) => {
      // SberCloud OBS S3-compatible API ignores If-None-Match on PUT. This header is signed before send.
      args.request.headers['x-amz-forbid-overwrite'] = 'true';
      return next(args);
    }, { step: 'build', name: 'prototypeObsConditionalCreate', priority: 'low' });
  }
  return command;
}

export function isConditionalCreateConflict(error: unknown): boolean {
  const value = error as { name?: string; $metadata?: { httpStatusCode?: number } };
  return value?.$metadata?.httpStatusCode === 412 ||
    value?.$metadata?.httpStatusCode === 409 && value?.name === 'ObjectAlreadyExists';
}
