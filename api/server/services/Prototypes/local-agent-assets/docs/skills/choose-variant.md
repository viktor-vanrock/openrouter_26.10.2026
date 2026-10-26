# Скилл: Выбор варианта дизайна

Менеджер посмотрел прototип, выбрал понравившийся вариант — теперь нужно
зафиксировать его: убрать переключатель и оставить только выбранный вариант.

## Шаг 1 — Определи прототип и вариант

Из сообщения менеджера извлеки:
- **prototype-name** — имя прototипа (`crm-dashboard`, `focusflow-landing`, и т.д.)
- **chosen variant** — что выбрал менеджер (может быть id, лейбл, описание или просто «первый»/«второй»)

Если непонятно — уточни у менеджера.

## Шаг 2 — Найди файлы варианта

Открой главную страницу прototипа:
```
prototypes/{prototype-name}/src/pages/*/ui/*Page.tsx
```

Найди массив `VARIANTS` и прочитай все варианты. Сопоставь выбор менеджера с id варианта.

Например, если менеджер написал «список» или «вариант A», а в коде есть:
```ts
{ id: 'list', label: 'Вариант A — Список', description: 'Компактный список задач' }
```
→ выбранный id = `'list'`

## Шаг 3 — Обнови страницу

В файле страницы (`*Page.tsx`) сделай следующее:

**До:**
```tsx
import { VariantSwitcher, useVariant } from '@/shared/ui/variant-switcher'
import { TodoListView } from './variants/TodoListView'
import { TodoCardsView } from './variants/TodoCardsView'

const VARIANTS = [
  { id: 'list', label: 'Вариант A — Список', description: '...' },
  { id: 'cards', label: 'Вариант B — Карточки', description: '...' },
]

export function TodoPage() {
  const todoState = useTodos()
  const { activeId, setActiveId } = useVariant(VARIANTS)

  return (
    <div ...>
      {/* ... */}
      {activeId === 'list' && <TodoListView {...todoState} />}
      {activeId === 'cards' && <TodoCardsView {...todoState} />}
      <VariantSwitcher variants={VARIANTS} activeId={activeId} onChange={setActiveId} />
    </div>
  )
}
```

**После** (если выбрали `'list'`):
```tsx
import { TodoListView } from './variants/TodoListView'

export function TodoPage() {
  const todoState = useTodos()

  return (
    <div ...>
      {/* ... */}
      <TodoListView {...todoState} />
    </div>
  )
}
```

Что удаляем:
- импорт `VariantSwitcher` и `useVariant`
- импорты невыбранных вариантов (`TodoCardsView` если выбрали список)
- массив `VARIANTS`
- строку `const { activeId, setActiveId } = useVariant(VARIANTS)`
- все условия `{activeId === '...' && <.../>}` — оставляем только выбранный
- сам компонент `<VariantSwitcher .../>`

## Шаг 4 — Проверь сборку

```bash
cd prototypes/{prototype-name}
npm run type-check
npm run lint
```

Все проверки должны пройти. Если есть ошибки — исправь.

## Шаг 5 — Показ результата

Следуй @docs/skills/export-html.md — собери прототип с зафиксированным вариантом
в HTML-файл и открой его в браузере для финального просмотра менеджером.

## Шаг 6 — Отчёт менеджеру

```
## ✅ Вариант зафиксирован!

**Выбран:** {label варианта}

Переключатель вариантов удалён — прototип теперь показывает только выбранный дизайн.
```

## Что НЕ трогаем

- Файлы невыбранных вариантов (`TodoCardsView.tsx` и т.д.) — удалять не надо,
  они не мешают и могут пригодиться для истории
- `src/shared/ui/variant-switcher/` — сам компонент оставляем в shared,
  он может понадобиться другим страницам или следующим прototипам
