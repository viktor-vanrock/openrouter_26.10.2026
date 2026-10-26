import assert from 'node:assert/strict';
import test from 'node:test';
import { reactPrototypeSource } from '../src/react-prototype.js';
import { validateReactDesign, validateFinalReactDesign } from '../src/react-source-policy.js';
import fs from 'node:fs/promises';

test('finalized source must no longer contain the design switcher', async () => {
  const draft = await fs.readFile(new URL('./fixtures/react-design.tsx', import.meta.url), 'utf8');
  const final = await fs.readFile(new URL('./fixtures/react-final.tsx', import.meta.url), 'utf8');
  assert.throws(() => validateFinalReactDesign(draft), {
    code: 'LIVE_MODEL_FINAL_VARIANT_INVALID',
  });
  assert.equal(validateFinalReactDesign(final), final);
});

test('design markers must be rendered JSX attributes, not comments or inert strings', async () => {
  const source = await fs.readFile(new URL('./fixtures/react-design.tsx', import.meta.url), 'utf8');
  assert.equal(validateReactDesign(source), source);
  for (const rejected of [
    source.replace('aria-label="Варианты дизайна"', ''),
    source.replace('data-prototype-variant={variant}', ''),
    `// aria-label="Варианты дизайна" data-prototype-variant\nimport { Button } from '@ai-sber/uikit'; export function App() { return <Button>A</Button>; }`,
  ])
    assert.throws(() => validateReactDesign(rejected), {
      code: 'LIVE_MODEL_DESIGN_VARIANTS_MISSING',
    });
});

test('UI Kit components must be imported and rendered, including local aliases', () => {
  const source =
    "import { Button as Action } from '@ai-sber/uikit'; export function App() { return <Action>Добавить</Action>; }";
  assert.equal(reactPrototypeSource(source), source);
  assert.equal(reactPrototypeSource(`\`\`\`tsx\n${source}\n\`\`\``), source);
  for (const fake of [
    "// import { Button } from '@ai-sber/uikit'\nexport function App() { return <button>Go</button>; }",
    "import type { Button } from '@ai-sber/uikit'; export function App() { return <button>Go</button>; }",
    "import { Button } from '@ai-sber/uikit'; export function App() { void Button; return <button>Go</button>; }",
    "import { Button } from '@ai-sber/uikit'; export function App() { return <Button>Go</Button> ",
  ])
    assert.throws(() => reactPrototypeSource(fake), { code: 'LIVE_MODEL_REACT_INVALID' });
});

test('one-file generation rejects external imports and executable project configuration', () => {
  const source =
    "import { Button } from '@ai-sber/uikit'; export function App() { return <Button>Go</Button>; }";
  for (const injected of [
    "import x from 'https://example.test/module';",
    "import x from './other';",
    "import x from 'node:fs';",
    "const extra = import('react');",
    "const extra = require('fs');",
    "export { x } from './other';",
  ])
    assert.throws(() => reactPrototypeSource(`${injected}\n${source}`), {
      code: 'LIVE_MODEL_REACT_INVALID',
    });
});

test('React rejection identifies the rule and syntax location without exposing generated text', () => {
  const cases = [
    [
      'export function App() { return <button>private-user-text</button>; }',
      'uikit_component_not_rendered',
    ],
    [
      "import { Button } from '@ai-sber/uikit'; const Main = () => <Button>private-user-text</Button>;",
      'app_export_missing',
    ],
    [
      "import x from 'https://private.test?token=secret'; export function App() {}",
      'import_not_allowed',
    ],
    [
      "const extra = import('private-module'); export function App() {}",
      'dynamic_import_not_allowed',
    ],
    [
      "import { Button } from '@ai-sber/uikit';\nexport function App() { return <Button>private-user-text</Button>",
      'tsx_syntax_error',
    ],
  ];
  for (const [content, reason] of cases) {
    assert.throws(
      () => reactPrototypeSource(content),
      (error) => {
        assert.equal(error.code, 'LIVE_MODEL_REACT_INVALID');
        assert.equal(error.details.reason, reason);
        assert.doesNotMatch(
          JSON.stringify(error.details) + error.diagnostics.join(''),
          /private-|secret/,
        );
        if (reason === 'tsx_syntax_error') {
          assert.ok(error.details.lineNumber >= 2);
          assert.ok(error.details.columnNumber >= 1);
          assert.ok(Number.isSafeInteger(error.details.diagnosticCode));
        }
        return true;
      },
    );
  }
});
