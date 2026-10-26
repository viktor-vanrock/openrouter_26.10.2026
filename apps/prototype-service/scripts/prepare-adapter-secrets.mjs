/** Writes deployment secrets to a new private file; never changes root .env or uploads. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
const args = process.argv.slice(2);
const output = args[args.indexOf('--out') + 1];
if (!args.includes('--out') || !output)
  throw new Error('Usage: prepare-adapter-secrets.mjs --out <new-private-env-file>');
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 3072 });
const signing = Buffer.from(privateKey.export({ type: 'pkcs8', format: 'pem' })).toString('base64');
const token = randomBytes(32).toString('hex');
const file = await fs.open(path.resolve(output), 'wx', 0o600);
try {
  await file.writeFile(
    `PROTOTYPE_SERVICE_TOKEN=${token}\nPROTOTYPE_MODEL_TOKEN_PRIVATE_KEY_BASE64=${signing}\n`,
  );
} finally {
  await file.close();
}
console.log(
  'Adapter secrets saved to a new file with mode0600. No certificate generation or upload.',
);
