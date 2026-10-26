# Правила code style

## TypeScript

- **Строгий режим обязателен** — `"strict": true` в tsconfig
- Никаких `any` — используй `unknown` + type guard если тип неизвестен
- Все пропсы компонентов типизированы через `interface`, не `type` (для компонентов)
- `type` используй для union types, алиасов, утилитарных типов
- Экспортируй типы рядом с компонентом, реэкспортируй через `index.ts`

```tsx
// ✅ Правильно
interface UserCardProps {
  user: User
  onEdit?: (id: string) => void
  className?: string
}

export function UserCard({ user, onEdit, className }: UserCardProps) { ... }
export type { UserCardProps }

// ❌ Неправильно
export function UserCard(props: any) { ... }
```

## React

- **Только функциональные компоненты** — никаких class components
- **Именованный экспорт** для компонентов — никаких `export default`
- Имя компонента = имя файла (PascalCase)
- Один компонент = один файл
- Хуки только в `model/` директории слайса или `shared/lib`

```tsx
// ✅ Правильно — UserCard.tsx
export function UserCard({ user }: UserCardProps) {
  return <Card>...</Card>
}

// ❌ Неправильно
export default function({ user }) { ... }
```

## Именование

| Что | Стиль | Пример |
|-----|-------|--------|
| Компоненты, интерфейсы, типы | PascalCase | `UserCard`, `UserCardProps` |
| Функции, переменные, хуки | camelCase | `useUserData`, `formatDate` |
| Константы | UPPER_SNAKE_CASE | `API_BASE_URL`, `MAX_RETRIES` |
| Файлы компонентов | PascalCase | `UserCard.tsx` |
| Файлы утилит/хуков | camelCase | `formatDate.ts`, `useUserData.ts` |
| Директории | kebab-case | `user-card/`, `auth-form/` |
| CSS классы | kebab-case (через Tailwind) | — |

## ESLint конфигурация

```json
{
  "extends": [
    "eslint:recommended",
    "plugin:@typescript-eslint/recommended",
    "plugin:react-hooks/recommended",
    "prettier"
  ],
  "rules": {
    "@typescript-eslint/no-explicit-any": "error",
    "@typescript-eslint/explicit-function-return-type": "off",
    "no-console": ["warn", { "allow": ["warn", "error"] }],
    "react-hooks/rules-of-hooks": "error",
    "react-hooks/exhaustive-deps": "warn"
  }
}
```

## Частые ESLint-ошибки — обязательно проверяй до финальной сборки

Эти правила **не фиксируются через `lint:fix`** — их нужно устранять руками.
Они же чаще всего ломают финальную проверку и приводят к долгим переделкам.

### `react-hooks/static-components` — компонент внутри компонента

ESLint считает компонентом любую функцию с заглавной буквы, которая возвращает JSX.
Если создать такую функцию **внутри** другого компонента — это нарушение: React будет
пересоздавать её при каждом рендере, теряя state и вызывая баги.

```tsx
// ❌ Ошибка — ToolIcon определён внутри ToolCard
export function ToolCard({ tool }: ToolCardProps) {
  // ESLint: react-hooks/static-components
  const ToolIcon = ({ icon }: { icon: string }) => <Database className="h-5 w-5" />
  return <ToolIcon icon={tool.icon} />
}

// ✅ Правильно — выноси в отдельный файл или за пределы родительского компонента
function ToolIcon({ icon }: { icon: string }) {
  return <Database className="h-5 w-5" />
}

export function ToolCard({ tool }: ToolCardProps) {
  return <ToolIcon icon={tool.icon} />
}
```

Если иконка выбирается динамически по ключу — используй **функцию**, возвращающую JSX, а не компонент:

```tsx
// ✅ Функция-хелпер (не компонент, строчная буква) — допустима внутри модуля
function getToolIcon(key: ToolIconKey): ReactNode {
  const icons: Record<ToolIconKey, ReactNode> = {
    database: <Database className="h-5 w-5" />,
    code: <Code2 className="h-5 w-5" />,
  }
  return icons[key] ?? <Activity className="h-5 w-5" />
}
```

### `react-hooks/set-state-in-effect` — синхронный setState в useEffect

Вызов `setState` **синхронно в теле** `useEffect` (не в колбэке async/fetch) создаёт лишний
render-цикл и может зациклить компонент.

```tsx
// ❌ Ошибка — синхронный setState прямо в теле эффекта
useEffect(() => {
  setData(initialData)   // react-hooks/set-state-in-effect
}, [initialData])

// ✅ Правильно — инициализируй state через useState, производные — через useMemo
const [data, setData] = useState(initialData)

// ✅ Если нужна реакция на изменение пропа — useMemo, не useEffect+setState
const filtered = useMemo(
  () => items.filter((i) => i.categoryId === activeCategory),
  [items, activeCategory]
)

// ✅ setState в useEffect допустим только внутри async/колбэка
useEffect(() => {
  if (!IS_DEV) return
  fetch('/api/items')
    .then((r) => r.json())
    .then((data) => setItems(data))   // ✅ — внутри колбэка, не синхронно
}, [])
```

## Prettier конфигурация

```json
{
  "semi": false,
  "singleQuote": true,
  "tabWidth": 2,
  "trailingComma": "es5",
  "printWidth": 100,
  "plugins": ["prettier-plugin-tailwindcss"]
}
```

## Tailwind

- Используй Tailwind utility-классы и semantic tokens, уже подключённые шаблоном.
- Не импортируй `@ai-sber/uikit/tailwind-preset`: установленная версия его не экспортирует.
- Не пиши кастомный CSS без крайней необходимости
- Сложные комбинации классов выноси в `cva` (class-variance-authority — уже в зависимостях uikit)
- Порядок классов — автоматически через prettier-plugin-tailwindcss

```tsx
// ✅ Правильно
<div className="flex items-center gap-4 rounded-lg bg-white p-6 shadow-sm">

// ❌ Избегай
<div style={{ display: 'flex', alignItems: 'center' }}>
```

## Структура файла компонента

```tsx
// 1. Импорты внешних библиотек
import { useState } from 'react'
import { Button, Card } from '@ai-sber/uikit'

// 2. Импорты внутренние (по слоям FSD)
import { UserAvatar } from '@/entities/user'
import { formatDate } from '@/shared/lib'

// 3. Типы
interface UserCardProps {
  user: User
  onEdit?: (id: string) => void
}

// 4. Компонент
export function UserCard({ user, onEdit }: UserCardProps) {
  // 4.1 Хуки
  const [isExpanded, setIsExpanded] = useState(false)

  // 4.2 Обработчики
  const handleEdit = () => onEdit?.(user.id)

  // 4.3 JSX
  return (
    <Card>
      <UserAvatar src={user.avatar} />
      <Button onClick={handleEdit}>Редактировать</Button>
    </Card>
  )
}

// 5. Экспорт типов
export type { UserCardProps }
```
