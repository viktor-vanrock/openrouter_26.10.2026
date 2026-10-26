# Скилл: использование `@ai-sber/uikit`

## Источник истины

Этот документ обновлён по Storybook MCP `https://storybook.ekim-evgeny.ru/mcp`
и TypeScript declarations установленного `@ai-sber/uikit@0.1.x`.

Storybook публикует примеры с импортом из `@sberai/storybook`, но в прототипах
используй эквивалентные exports установленного пакета:

```tsx
import { Button, Input, Modal } from '@ai-sber/uikit'
```

Если remote Storybook MCP доступен в текущем runtime, перед применением незнакомого
компонента вызови последовательно:

1. `list-all-documentation`;
2. `get-documentation` для одного компонента за вызов.

В локальном Prototype Agent remote MCP намеренно отключён: используй этот проверенный
Storybook MCP snapshot и `.d.ts` установленного пакета. Не проси менеджера предоставить
MCP или выбрать другой workflow.

## Подключение стилей

Шаблон уже содержит корректные импорты:

```css
@import 'tailwindcss';
@import '@ai-sber/uikit/styles/tokens';
@import '@ai-sber/uikit/styles';
```

Не импортируй несуществующие `@ai-sber/uikit/tailwind.css` или
`@ai-sber/uikit/tailwind-preset` и не меняй Tailwind/Vite config.

## Надёжные компоненты и точный API

### Button

```tsx
<Button variant="primary" size="m" loading={false} disabled={false}>
  Сохранить
</Button>
```

- `loading`, не `isLoading`;
- размеры: `s`, `m`, `l`, `mobile-s`, `mobile-m`, `mobile-l`;
- для submit обязательно `type="submit"`.
- Иконку передавай через `leftIcon={<Plus size={16} />}` или `rightIcon`,
  но только одну из них: `leftIcon` и `rightIcon` взаимно исключаются в ButtonProps.
  а подпись — строкой в children. Не передавай иконку и строку как массив children:
  это другой режим content layout и может нарушить расположение и цвет подписи.
- Если кнопка находится за пределами `<form>`, связывай её через `form="form-id"`.
  Кнопку сохранения не оборачивай в ModalClose: закрывай окно только после валидации
  и обновления данных React.

### Input и Label

`Input` использует обычный React `ChangeEvent`, а не строковое значение:

```tsx
<Label htmlFor="employee-name">Имя</Label>
<Input
  id="employee-name"
  name="name"
  value={name}
  onChange={(event) => setName(event.target.value)}
  error={Boolean(nameError)}
  placeholder="Иван Петров"
/>
{nameError && <p className="text-sm text-red-500">{nameError}</p>}
```

Допустим также prop `label="Имя"`, но явный `Label htmlFor` удобнее для browser QA.

### SearchInput

В отличие от `Input`, `SearchInput.onChange` получает готовую строку:

```tsx
<SearchInput
  value={search}
  onChange={setSearch}
  placeholder="Поиск по имени и email"
/>
```

Не пиши `onChange={(event) => setSearch(event.target.value)}` на SearchInput.

SearchInput не принимает `id` или произвольные HTML input props. Для поиска с явным `<Label htmlFor="employee-search">` используй UI Kit `<Input id="employee-search" value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Поиск по имени" />`.
Размер `SearchInput` задаётся значениями `sm`, `md` или `lg` (например,
`size="lg"`). Не используй размеры кнопок `s`, `m`, `l` для `SearchInput`.

### SelectField — предпочтительный select для форм

Для обычных single-select полей предпочитай `SelectField`: у него меньше вложенности
и меньше риск сломать JSX.

```tsx
<SelectField
  id="employee-department"
  label="Отдел"
  value={department}
  onChange={setDepartment}
  options={[
    { value: 'development', label: 'Разработка' },
    { value: 'sales', label: 'Продажи' },
  ]}
  placeholder="Выберите отдел"
/>
```

`onChange` получает строку. Не используй DOM event.

### Select primitives

Используй их только когда нужен кастомный composition:

```tsx
<Select value={department} onValueChange={setDepartment}>
  <SelectTrigger aria-label="Отдел">
    <SelectValue placeholder="Выберите отдел" />
  </SelectTrigger>
  <SelectContent>
    <SelectItem value="development">Разработка</SelectItem>
    <SelectItem value="sales">Продажи</SelectItem>
  </SelectContent>
</Select>
```

- нет `Select.Option`;
- `SelectItem` всегда внутри `SelectContent`;
- `SelectTrigger` и `SelectValue` обязательны;
- обязательно дай trigger доступное имя (`aria-label` или связанный label).

Нативный `<select name="..." aria-label="...">` допустим как надёжный fallback,
если кастомный Select не является частью требований.

### Modal

Предпочтительный pattern из Storybook:

```tsx
<Modal>
  <ModalTrigger asChild>
    <Button>Добавить сотрудника</Button>
  </ModalTrigger>
  <ModalContent size="md">
    <ModalHeader>
      <ModalTitle>Добавить сотрудника</ModalTitle>
      <ModalDescription>Заполните обязательные поля</ModalDescription>
    </ModalHeader>
    <ModalBody>{/* form fields */}</ModalBody>
    <ModalFooter>
      <ModalClose asChild>
        <Button type="button" variant="secondary">Отмена</Button>
      </ModalClose>
      <Button type="submit">Сохранить</Button>
    </ModalFooter>
  </ModalContent>
</Modal>
```

Controlled variant: `<Modal open={open} onOpenChange={setOpen}>...</Modal>`.

- компоненты импортируются отдельно: `ModalContent`, не `Modal.Content`;
- closing tag должен совпадать: `<ModalContent>...</ModalContent>`;
- один `ModalTitle` внутри `ModalHeader`; не вкладывай дополнительные `<h2>`;
- dialog не рендерится вручную как постоянно видимый `<div role="dialog">`.

### Table — самый надёжный вариант

Для списков до нескольких десятков строк предпочитай composable Table:

```tsx
<Table>
  <TableHeader>
    <TableRow>
      <TableHead>Имя</TableHead>
      <TableHead>Email</TableHead>
    </TableRow>
  </TableHeader>
  <TableBody>
    {employees.map((employee) => (
      <TableRow key={employee.id}>
        <TableCell>{employee.name}</TableCell>
        <TableCell>{employee.email}</TableCell>
      </TableRow>
    ))}
  </TableBody>
</Table>
```

### DataTable

Используй только этот контракт:

```tsx
import type { DataTableColumn } from '@ai-sber/uikit'

const columns: DataTableColumn<Employee>[] = [
  { key: 'name', header: 'Имя', cell: (item) => item.name },
  { key: 'email', header: 'Email', cell: (item) => item.email },
]

<DataTable
  columns={columns}
  data={employees}
  keyExtractor={(item) => item.id}
  emptyMessage="Сотрудники не найдены"
/>
```

- обязательны `key`, `header`, `cell`, `data`, `keyExtractor`;
- `cell` получает сам `item`, вторым аргументом index;
- запрещены `Header`, `render`, `accessorKey`, `row.original`, `getValue()`;
- если TypeScript ругается на DataTable, замени его целиком на composable `Table`,
  не переписывай колонки методом проб и ошибок.

### Alert

```tsx
<Alert variant="error">
  <AlertTitle>Ошибка</AlertTitle>
  <AlertDescription>Проверьте обязательные поля.</AlertDescription>
</Alert>
```

Вариант ошибки называется `error`, не `destructive`.

## Правила для интерактивных прототипов

- Для автономного HTML держи demo-data в `useState`; не используй `fetch`/axios.
- Все form controls получают label, `name` или `aria-label`.
- Validation должна менять DOM и не закрывать Modal при ошибке.
- После успешного submit используй введённые и выбранные значения без placeholders.
- Для критичного сценария выбирай простой, типобезопасный composition вместо большого
  числа декоративных компонентов.
