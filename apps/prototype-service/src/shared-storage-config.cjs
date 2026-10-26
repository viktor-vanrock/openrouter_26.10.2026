/** Shared AWS configuration for the API and packaged worker; no secondary credentials. */
function prototypeS3Config(env = process.env) {
  if (!env.AWS_BUCKET_NAME || !env.AWS_REGION)
    throw new Error('AWS_BUCKET_NAME and AWS_REGION are required for prototype storage');
  const addressing = env.AWS_FORCE_PATH_STYLE ?? 'false';
  if (!['true', 'false', '1', '0', ''].includes(addressing))
    throw new Error('AWS_FORCE_PATH_STYLE must be true or false');
  if (Boolean(env.AWS_ACCESS_KEY_ID) !== Boolean(env.AWS_SECRET_ACCESS_KEY))
    throw new Error('AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY must be configured together');
  return {
    region: env.AWS_REGION,
    ...(env.AWS_ENDPOINT_URL ? { endpoint: env.AWS_ENDPOINT_URL } : {}),
    forcePathStyle: addressing === 'true' || addressing === '1',
    requestChecksumCalculation: 'WHEN_REQUIRED',
    ...(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? {
          credentials: {
            accessKeyId: env.AWS_ACCESS_KEY_ID,
            secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
            ...(env.AWS_SESSION_TOKEN ? { sessionToken: env.AWS_SESSION_TOKEN } : {}),
          },
        }
      : {}),
  };
}
module.exports = { prototypeS3Config };
