# Скилл: Variant Switcher

Плавающая панель в прototипе, которая позволяет менеджеру переключаться
между несколькими вариантами дизайна одного и того же экрана прямо в браузере.

## Когда использовать

Создавай Variant Switcher когда:
- В ТЗ есть неопределённость как должен выглядеть ключевой экран
- Менеджер хочет сравнить табличное vs карточное представление данных
- Нужно показать несколько UX-подходов на выбор

Обычно 2-3 варианта для **главного экрана** прototипа. Не делай варианты для каждой страницы — только для ключевой.

## Что создаётся

```
src/shared/ui/variant-switcher/
├── VariantSwitcher.tsx      # Плавающая панель UI
├── useVariant.ts            # Хук — хранит выбранный вариант
└── index.ts
```

А в папке страницы где нужны варианты:
```
src/pages/dashboard/
├── ui/
│   ├── DashboardPage.tsx           # Главная страница — подключает switcher
│   ├── variants/
│   │   ├── DashboardTableView.tsx  # Вариант A — таблица
│   │   ├── DashboardCardsView.tsx  # Вариант B — карточки
│   │   └── DashboardKanbanView.tsx # Вариант C — kanban (если нужен)
│   └── ...
└── index.ts
```

## Реализация VariantSwitcher

```tsx
// src/shared/ui/variant-switcher/VariantSwitcher.tsx
import { useState } from 'react'
import { Button, Badge } from '@ai-sber/uikit'

export interface Variant {
  id: string
  label: string
  description?: string
}

interface VariantSwitcherProps {
  variants: Variant[]
  activeId: string
  onChange: (id: string) => void
}

export function VariantSwitcher({ variants, activeId, onChange }: VariantSwitcherProps) {
  const [isOpen, setIsOpen] = useState(true)

  if (!isOpen) {
    return (
      <button
        onClick={() => setIsOpen(true)}
        className="fixed bottom-6 right-6 z-50 flex items-center gap-2 rounded-full bg-gray-900 px-4 py-2 text-sm text-white shadow-lg transition hover:bg-gray-700"
      >
        🎨 Варианты
      </button>
    )
  }

  return (
    <div className="fixed bottom-6 right-6 z-50 w-64 rounded-xl bg-white p-4 shadow-2xl ring-1 ring-gray-200">
      {/* Заголовок */}
      <div className="mb-3 flex items-center justify-between">
        <span className="text-sm font-semibold text-gray-900">🎨 Варианты дизайна</span>
        <button
          onClick={() => setIsOpen(false)}
          className="text-gray-400 hover:text-gray-600"
        >
          ✕
        </button>
      </div>

      {/* Список вариантов */}
      <div className="flex flex-col gap-2">
        {variants.map((variant) => (
          <button
            key={variant.id}
            onClick={() => onChange(variant.id)}
            className={[
              'flex flex-col items-start rounded-lg px-3 py-2 text-left transition',
              activeId === variant.id
                ? 'bg-blue-50 ring-2 ring-blue-500'
                : 'hover:bg-gray-50 ring-1 ring-gray-200',
            ].join(' ')}
          >
            <div className="flex w-full items-center justify-between">
              <span className="text-sm font-medium text-gray-900">{variant.label}</span>
              {activeId === variant.id && (
                <Badge variant="default" className="text-xs">Активен</Badge>
              )}
            </div>
            {variant.description && (
              <span className="mt-0.5 text-xs text-gray-500">{variant.description}</span>
            )}
          </button>
        ))}
      </div>

      {/* Подсказка */}
      <p className="mt-3 text-xs text-gray-400">
        Только для демо. В продакшне не отображается.
      </p>
    </div>
  )
}
```

## Реализация useVariant

```tsx
// src/shared/ui/variant-switcher/useVariant.ts
import { useState } from 'react'
import type { Variant } from './VariantSwitcher'

export function useVariant(variants: Variant[]) {
  const [activeId, setActiveId] = useState(variants[0]?.id ?? '')

  return {
    activeId,
    setActiveId,
    activeVariant: variants.find((v) => v.id === activeId),
  }
}
```

## Пример подключения на странице

```tsx
// src/pages/dashboard/ui/DashboardPage.tsx
import { VariantSwitcher, useVariant } from '@/shared/ui/variant-switcher'
import { DashboardTableView } from './variants/DashboardTableView'
import { DashboardCardsView } from './variants/DashboardCardsView'

const VARIANTS = [
  {
    id: 'table',
    label: 'Вариант A — Таблица',
    description: 'Компактное табличное представление',
  },
  {
    id: 'cards',
    label: 'Вариант B — Карточки',
    description: 'Визуальные карточки с превью',
  },
]

export function DashboardPage() {
  const { activeId, setActiveId } = useVariant(VARIANTS)

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Контент меняется в зависимости от варианта */}
      {activeId === 'table' && <DashboardTableView />}
      {activeId === 'cards' && <DashboardCardsView />}

      {/* Переключатель — всегда поверх */}
      <VariantSwitcher
        variants={VARIANTS}
        activeId={activeId}
        onChange={setActiveId}
      />
    </div>
  )
}
```

## Правила создания вариантов

1. **Каждый вариант — полноценный**, не заглушка. Реальные данные, реальный UI Kit.
2. **Варианты отличаются по-настоящему** — не просто цвет кнопки, а разный layout/подход.
3. **Общая логика не дублируется** — данные (хуки, MSW) общие, только UI разный.
4. **2-3 варианта максимум** — больше только запутает менеджера.
