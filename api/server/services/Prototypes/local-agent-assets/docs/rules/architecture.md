# Правила архитектуры

## Методология: Feature-Sliced Design (FSD)

Все прототипы строятся по методологии FSD. Это обязательно.

### Файловая структура прототипа

```
prototypes/{prototype-name}/
├── src/
│   ├── app/                        # Инициализация приложения
│   │   ├── providers/              # React провайдеры (Router, Theme, MSW)
│   │   │   └── index.tsx
│   │   ├── styles/
│   │   │   └── globals.css         # Глобальные стили + @ai-sber/uikit/styles
│   │   ├── App.tsx
│   │   └── main.tsx
│   │
│   ├── pages/                      # Страницы = роуты
│   │   ├── dashboard/
│   │   │   ├── ui/
│   │   │   │   └── DashboardPage.tsx
│   │   │   └── index.ts
│   │   └── index.ts                # Реэкспорт всех страниц
│   │
│   ├── widgets/                    # Крупные самодостаточные блоки UI
│   │   ├── header/
│   │   │   ├── ui/
│   │   │   │   └── Header.tsx
│   │   │   └── index.ts
│   │   └── sidebar/
│   │
│   ├── features/                   # Пользовательские сценарии
│   │   ├── auth/
│   │   │   ├── ui/
│   │   │   ├── model/              # Стейт, хуки
│   │   │   ├── api/                # MSW хендлеры
│   │   │   └── index.ts
│   │   └── ...
│   │
│   ├── entities/                   # Бизнес-сущности
│   │   ├── user/
│   │   │   ├── ui/
│   │   │   ├── model/
│   │   │   └── index.ts
│   │   └── ...
│   │
│   └── shared/                     # Переиспользуемый код без бизнес-логики
│       ├── ui/                     # Только обёртки над @ai-sber/uikit если нужны
│       ├── lib/                    # Утилиты, хелперы
│       ├── api/                    # MSW setup, http-клиент
│       │   ├── msw-setup.ts
│       │   └── handlers.ts         # Корневой файл хендлеров
│       ├── config/                 # Константы, env, роуты
│       │   └── routes.ts
│       └── types/                  # Общие TypeScript типы
│
├── public/
│   └── mockServiceWorker.js        # Генерируется MSW
│
├── package.json
├── vite.config.ts
├── tsconfig.json
├── tailwind.config.js
├── .eslintrc.json
└── .prettierrc
```

## Принципы проектирования

### SOLID
- **S** — каждый компонент/модуль отвечает за одну вещь
- **O** — компоненты расширяемы через props, не через изменение кода
- **L** — дочерние компоненты заменяемы без изменения родителей
- **I** — пропсы минимальны, не передавай лишнего
- **D** — зависимости через пропсы/контекст, не импортируй напрямую из нижних слоёв

### KISS — Keep It Simple
- Не усложняй то что можно сделать просто
- Прототип — это не продакшн, но код должен быть читаемым
- Если можно обойтись без абстракции — обходись

### DRY — Don't Repeat Yourself
- Повторяющийся UI → компонент в `shared/ui` или `entities`
- Повторяющаяся логика → хук или утилита в `shared/lib`
- Повторяющиеся моки → фабрики в `shared/api`

## Правила импортов (FSD)

```
app → pages → widgets → features → entities → shared
```

**Нельзя** импортировать из вышестоящего слоя. Нельзя импортировать из соседних слайсов напрямую — только через `index.ts` (публичный API слайса).

```tsx
// ✅ Правильно
import { UserCard } from '@/entities/user'
import { Button } from '@ai-sber/uikit'

// ❌ Неправильно
import { UserCard } from '@/entities/user/ui/UserCard'
import { useAuthStore } from '@/features/auth/model/store'
```

## Path алиасы

Всегда используй алиасы, не относительные пути глубже одного уровня:

```tsx
// ✅
import { Button } from '@ai-sber/uikit'
import { formatDate } from '@/shared/lib'
import { UserCard } from '@/entities/user'

// ❌
import { formatDate } from '../../../shared/lib/formatDate'
```

Настройка в `vite.config.ts` и `tsconfig.json`:
```ts
alias: {
  '@': path.resolve(__dirname, './src'),
}
```
