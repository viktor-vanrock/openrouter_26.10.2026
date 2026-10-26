const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { readSigningKey } = require('./PrototypeModelProxyStartup');

it('accepts the same RSA signing key from Secret base64 or a private regular file', async () => {
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const encoded = Buffer.from(pem).toString('base64');
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'prototype-signing-'));
  const filename = path.join(directory, 'signing.pem');
  try {
    await fs.writeFile(filename, pem, { mode: 0o600 });
    const envKey = await readSigningKey(undefined, encoded);
    const fileKey = await readSigningKey(filename);
    const data = Buffer.from('scoped model token');
    expect(crypto.verify('sha256', data, crypto.createPublicKey(fileKey), crypto.sign('sha256', data, envKey))).toBe(true);
    await expect(readSigningKey(filename, encoded)).rejects.toThrow('PROTOTYPE_PROXY_KEY_INVALID');
    await fs.chmod(filename, 0o644);
    await expect(readSigningKey(filename)).rejects.toThrow('PROTOTYPE_PROXY_KEY_INVALID');
    await fs.chmod(filename, 0o600);
    await fs.symlink(filename, path.join(directory, 'link.pem'));
    await expect(readSigningKey(path.join(directory, 'link.pem'))).rejects.toThrow();
    await expect(readSigningKey(undefined, 'invalid base64')).rejects.toThrow('PROTOTYPE_PROXY_KEY_INVALID');
    const weak = crypto.generateKeyPairSync('rsa', { modulusLength: 1024 }).privateKey;
    await expect(readSigningKey(undefined, Buffer.from(weak.export({ type: 'pkcs8', format: 'pem' })).toString('base64')))
      .rejects.toThrow('PROTOTYPE_PROXY_KEY_INVALID');
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
