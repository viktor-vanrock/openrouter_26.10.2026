import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

export const REACT_AGENT_RULES_VERSION = 'gateway-fsd-v1';
const root = new URL('../assets/docs/', import.meta.url);
const files = [
  'rules/architecture.md',
  'rules/code-style.md',
  'skills/use-uikit.md',
  'skills/variant-switcher.md',
  'skills/choose-variant.md',
  'rules/gateway-fsd.md',
];
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

/** Build-time bundle input; packaged images materialize these versioned bytes read-only.
 * No runtime access to a sibling repository or remote Storybook is needed.
 */
export async function reactAgentRulesBundle({ read = (url) => fs.readFile(url, 'utf8') } = {}) {
  const entries = await Promise.all(
    files.map(async (name) => ({ path: name, text: await read(new URL(name, root)) })),
  );
  const manifest = {
    schemaVersion: 1,
    version: REACT_AGENT_RULES_VERSION,
    files: entries.map((entry) => ({
      path: entry.path,
      bytes: Buffer.byteLength(entry.text),
      digest: hash(entry.text),
    })),
  };
  return {
    manifest,
    digest: hash(JSON.stringify(manifest)),
    instructions:
      `Target generation profile ${REACT_AGENT_RULES_VERSION}. The final Gateway override has priority over all historical workflow examples.\n\n` +
      entries.map((entry) => `REFERENCE ${entry.path}\n${entry.text}`).join('\n\n'),
    entries,
  };
}
