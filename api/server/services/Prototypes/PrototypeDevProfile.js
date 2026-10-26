const fs = require('node:fs');
const path = require('node:path');

const profilePath = path.resolve(__dirname, '../../../../.prototype-dev/runtime.json');

/** Development-only handoff from the separately started prototype service. */
function applyPrototypeDevProfile({ env = process.env, filename = profilePath, isAlive } = {}) {
  if (env.NODE_ENV !== 'development' || env.PROTOTYPE_DEV_ENABLED === 'false') return false;
  let profile;
  try {
    const stat = fs.lstatSync(filename);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 16_384) {
      throw new Error('Prototype development profile must be an owner-only regular file');
    }
    profile = JSON.parse(fs.readFileSync(filename, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (!Number.isSafeInteger(profile.pid) || profile.pid < 1) throw new Error('Invalid prototype service PID');
  const checkAlive = isAlive ?? ((pid) => { try { process.kill(pid, 0); return true; } catch { return false; } });
  if (!checkAlive(profile.pid)) return false;
  const values = profile.env;
  if (profile.schemaVersion === 2) {
    if (!values || values.PROTOTYPE_MONGO_URI !== env.PROTOTYPE_MONGO_URI || !env.PROTOTYPE_MONGO_URI ||
        values.REDIS_URI !== env.REDIS_URI || !env.REDIS_URI ||
        !/^[a-f0-9]{64}$/.test(values.PROTOTYPE_TEST_WORKER_IDENTITY ?? '')) {
      throw new Error('Invalid local prototype runtime profile');
    }
    env.PROTOTYPE_TEST_WORKER_IDENTITY = values.PROTOTYPE_TEST_WORKER_IDENTITY;
    return true;
  }
  if (!values || !/^mongodb:\/\/127\.0\.0\.1:19017\/prototype_personal_[a-f0-9]{32}\?replicaSet=prototype-rs&directConnection=true$/.test(values.MONGO_URI) ||
      typeof env.REDIS_URI !== 'string' || !env.REDIS_URI ||
      values.REDIS_URI !== env.REDIS_URI ||
      !/^[a-f0-9]{64}$/.test(values.PROTOTYPE_TEST_WORKER_IDENTITY ?? '') ||
      values.CONFIG_PATH !== path.join(path.dirname(filename), 'librechat.yaml')) {
    throw new Error('Invalid local prototype runtime profile');
  }
  // A missing/stopped prototype worker must never switch the ordinary chat database or config.
  if (env.MONGO_URI !== values.MONGO_URI) return false;
  const allowed = ['PROTOTYPE_TEST_WORKER_IDENTITY'];
  if (profile.synthetic === true) {
    if (!/^http:\/\/127\.0\.0\.1:\d{4,5}\/v1$/.test(values.OPENROUTER_API_URL ?? '')) {
      throw new Error('Invalid synthetic gateway');
    }
  }
  // Validate the whole optional profile before changing any normal-chat settings.
  for (const key of allowed) env[key] = values[key];
  // Synthetic provider settings stay in the prototype test process, not ordinary chat.
  Object.assign(env, {
    PROTOTYPE_TRANSPORT_ENABLED: 'true',
  });
  return true;
}

module.exports = { applyPrototypeDevProfile };
