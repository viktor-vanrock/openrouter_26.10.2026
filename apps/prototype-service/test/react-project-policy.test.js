import assert from 'node:assert/strict';
import test from 'node:test';
import { validateReactProject } from '../src/react-project-policy.js';
const fixture = {
  'src/app/App.tsx':
    "import { Page } from '@/pages/crm'; export function App() { return <Page />; }",
  'src/pages/crm/index.ts': "export { Page } from './ui/Page';",
  'src/pages/crm/ui/Page.tsx':
    "import { Employees } from '@/widgets/employees'; export function Page() { return <Employees />; }",
  'src/widgets/employees/index.ts': "export { Employees } from './ui/Employees';",
  'src/widgets/employees/ui/Employees.tsx':
    "import { Edit } from '@/features/edit'; export function Employees() { return <Edit />; }",
  'src/features/edit/index.ts': "export { Edit } from './ui/Edit';",
  'src/features/edit/ui/Edit.tsx':
    "import { demo } from '@/entities/employee'; import { Button } from '@ai-sber/uikit'; export function Edit() { return <Button>{demo}</Button>; }",
  'src/entities/employee/index.ts': "export { demo } from './model/demo';",
  'src/entities/employee/model/demo.ts':
    "import { name } from '@/shared/lib'; export const demo = name;",
  'src/shared/lib/index.ts': "export const name = 'Employee';",
};
test('connected FSD decomposition uses public APIs and real kit imports', () => {
  const result = validateReactProject(fixture);
  assert.equal(result.files, 10);
  assert.equal(result.validatedAs, 'static-policy-only');
});
test('denies upper-layer/private imports, hidden network/code, immutable config and fake FSD folders', () => {
  for (const [name, content, code] of [
    [
      'src/entities/employee/model/demo.ts',
      "import { Edit } from '@/features/edit'; export const demo = Edit;",
      'UPPER_LAYER',
    ],
    [
      'src/pages/crm/ui/Page.tsx',
      "import { Employees } from '@/widgets/employees/ui/Employees'; export function Page() { return <Employees />; }",
      'SLICE_PRIVATE',
    ],
    ['src/entities/employee/model/demo.ts', "export const demo = fetch('/private');", 'NETWORK'],
    [
      'src/entities/employee/model/demo.ts',
      "export const demo = import('react');",
      'DYNAMIC_IMPORT',
    ],
    ['src/app/main.tsx', 'export {};', 'IMMUTABLE'],
    ['package.json', '{}', 'MANIFEST'],
    ['src/shared/lib/index.ts', "export const name = globalThis['fetch'];", 'NETWORK'],
    ['src/shared/lib/index.ts', "export const name = self['fetch']('/private');", 'NETWORK'],
    [
      'src/features/edit/ui/Edit.tsx',
      "import type { ButtonProps } from '@ai-sber/uikit'; import { demo } from '@/entities/employee'; export function Edit() { return <button>{demo}</button>; }",
      'REQUIRED_COMPONENTS',
    ],
  ]) {
    assert.throws(() => validateReactProject({ ...fixture, [name]: content }), new RegExp(code));
  }
  assert.throws(
    () =>
      validateReactProject({
        ...fixture,
        'src/app/App.tsx':
          "import { Button } from '@ai-sber/uikit'; export function App() { return <Button>One file</Button>; }",
      }),
    /FSD_DECOMPOSITION/,
  );
  assert.throws(
    () =>
      validateReactProject({
        ...fixture,
        'src/shared/styles/a.css': "a { background: url('https://evil'); }",
      }),
    /NETWORK/,
  );
  assert.throws(
    () =>
      validateReactProject({
        ...fixture,
        'src/pages/crm/ui/Page.tsx':
          "import { Employees } from '@/widgets/employees/model'; export function Page() { return <Employees />; }",
        'src/widgets/employees/model/index.ts': "export { Employees } from '../ui/Employees';",
      }),
    /SLICE_PRIVATE/,
  );
  assert.throws(
    () =>
      validateReactProject({
        ...fixture,
        'src/app/App.tsx':
          "import { useState } from 'react'; import { Page } from '@/pages/crm'; export function App() { const [records] = useState([]); return <Page />; }",
      }),
    /APP_NOT_COMPOSITION/,
  );
});
