import test from 'node:test';
import assert from 'node:assert/strict';
import { repairButtonIcons } from '../src/react-kit-repair.js';
import { repairUiKitSource } from '../src/react-kit-repair.js';

test('unused dialog state is connected to a single kit Modal and the existing opener initializes its trigger', () => {
  const source = `import { useState } from 'react'; import { Modal, ModalTrigger, Button } from '@ai-sber/uikit';
    export function App() { const [isOpen, setIsOpen] = useState(false);
      const handleOpenModal = (employee?: string) => { setIsOpen(true); return employee; };
      const cancel = () => setIsOpen(false);
      return <><Modal><ModalTrigger asChild><Button>Add</Button></ModalTrigger><Button onClick={cancel}>Cancel</Button></Modal>
        <Button onClick={() => handleOpenModal('existing')}>Edit</Button></>; }`;
  const result = repairUiKitSource(source);
  assert.equal(result.changed, true);
  assert.match(result.source, /<Modal open=\{isOpen\} onOpenChange=\{setIsOpen\}>/);
  assert.match(result.source, /<Button onClick=\{\(\) => handleOpenModal\(\)\}>Add/);
  assert.match(result.source, /onClick=\{cancel\}/);
  assert.equal(repairUiKitSource(result.source).changed, false);
});

test('unused destructured names are removed without dropping the state hook, setter or used status in another scope', () => {
  const source = `import { useState } from 'react';import { Button } from '@ai-sber/uikit';
    export function App(){const [isOpen,setIsOpen]=useState(false); const employee={id:'1',status:'active'};
      const {id,status}=employee;const label=(status:string)=>status;
      return <Button onClick={()=>setIsOpen(true)}>{id}{label(employee.status)}</Button>}`;
  const result = repairUiKitSource(source);
  assert.equal(result.changed, true);
  assert.match(result.source, /\[,setIsOpen\]=useState\(false\)/);
  assert.match(result.source, /const \{id\}=employee/);
  assert.match(result.source, /label=\(status:string\)=>status/);
  assert.equal(repairUiKitSource(result.source).changed, false);
});

test('one remaining unused binding is fixed even when the compiler omits its fix-all identifier', () => {
  const source =
    "import { Button } from '@ai-sber/uikit'; export function App() { const employee={id:'1',status:'active'}; const {id,status}=employee;return <Button>{id}</Button>; }";
  const result = repairUiKitSource(source);
  assert.equal(result.changed, true);
  assert.match(result.source, /const \{id\}=employee/);
});

test('cleanup leaves side-effectful defaults, rest exclusions and existing modal control untouched', () => {
  const source =
    "import { Button, Modal } from '@ai-sber/uikit';export function App(){const {ignored=sideEffect(),...rest}=item;return <Modal open={true}><Button>{rest.id}</Button></Modal>}";
  const result = repairUiKitSource(source);
  assert.match(result.source, /const \{ignored=sideEffect\(\),\.\.\.rest\}=item/);
  assert.match(result.source, /<Modal open=\{true\}>/);
  assert.match(result.source, /<Button>\{rest.id\}<\/Button>/);
  assert.equal(repairUiKitSource(result.source).changed, false);
});

test('repair retains the dynamic right icon and removes the now unused left icon import', () => {
  const source = `import { Button as Action } from '@ai-sber/uikit'; import { SlidersHorizontal, ChevronDown, ChevronUp } from 'lucide-react';
    export function App() { const open = true; return <Action leftIcon={<SlidersHorizontal />} rightIcon={open ? <ChevronUp/> : <ChevronDown/>}>Фильтры</Action>; }`;
  const result = repairButtonIcons(source);
  assert.equal(result.changed, true);
  assert.doesNotMatch(result.source, /leftIcon|SlidersHorizontal/);
  assert.match(result.source, /rightIcon=\{open/);
  assert.match(result.source, /ChevronDown, ChevronUp/);
  assert.equal(repairButtonIcons(result.source).changed, false);
});

test('single icon and non-kit buttons remain unchanged', () => {
  for (const source of [
    `import { Button } from '@ai-sber/uikit';export function App(){return <Button leftIcon={<span/>}>Save</Button>}`,
    `import { Button } from 'other';export function App(){return <Button leftIcon={<span/>} rightIcon={<span/>}>Save</Button>}`,
  ])
    assert.deepEqual(repairButtonIcons(source), { source, changed: false });
});

test('label-bound SearchInput is repaired to a real kit Input with the same label and string callback', async () => {
  const { repairLabelBoundSearch } = await import('../src/react-kit-repair.js');
  const source = `import { SearchInput as Search, Label } from '@ai-sber/uikit';
    export function App() { const setSearch = (value: string) => value; return <><Label htmlFor="search">Search</Label><Search id="search" value="a" onChange={setSearch} placeholder="Search" /></>; }`;
  const result = repairLabelBoundSearch(source);
  assert.equal(result.changed, true);
  assert.match(result.source, /Input as __PrototypeSearchInput/);
  assert.match(result.source, /htmlFor="search"/);
  assert.match(result.source, /<__PrototypeSearchInput id="search"/);
  assert.match(result.source, /\(setSearch\)\(event.target.value\)/);
  assert.doesNotMatch(result.source, /SearchInput as Search/);
  assert.equal(repairLabelBoundSearch(result.source).changed, false);
});
