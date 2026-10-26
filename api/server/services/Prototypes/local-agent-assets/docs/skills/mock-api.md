# Скилл: Моки API через MSW

## Что такое MSW и зачем

Mock Service Worker (MSW) перехватывает HTTP запросы на уровне Service Worker.
Это позволяет писать реалистичные запросы (`fetch`/`axios`) в коде, а MSW возвращает моковые данные.
Когда разработчик добавит бекенд — просто удалим MSW и всё заработает без изменений в бизнес-логике.

## Структура файлов

```
src/shared/api/
├── msw-setup.ts              # Инициализация server/worker
├── handlers.ts               # Импортирует ВСЕ хендлеры
├── factories/                # Фабрики для генерации тестовых данных
│   └── index.ts
└── users/                    # Хендлеры по сущностям
    └── handlers.ts
src/features/auth/api/
└── handlers.ts               # Хендлеры для авторизации
```

## Инициализация MSW

```ts
// src/shared/api/msw-setup.ts
import { setupServer } from 'msw/node'
import { handlers } from './handlers'

// Для тестов (Node.js / Vitest)
export const server = setupServer(...handlers)

// Для браузера инициализируем лениво чтобы не ломать тесты
export async function createWorker() {
  const { setupWorker } = await import('msw/browser')
  return setupWorker(...handlers)
}
```

```ts
// src/shared/api/msw-node-stub.ts
// Browser stub for msw/node — this module is Node-only.
// In browser context, setupServer is never called (only msw/browser is used).
// This stub prevents Vite's import-analysis from failing on the node-only subpath.
export const setupServer = (..._handlers: unknown[]) => ({
  listen: () => {},
  close: () => {},
  resetHandlers: () => {},
  use: () => {},
  restoreHandlers: () => {},
})
```

```ts
// src/shared/api/handlers.ts — корневой файл
import { userHandlers } from './users/handlers'
import { authHandlers } from '@/features/auth/api/handlers'
// импортируй все хендлеры здесь

export const handlers = [
  ...authHandlers,
  ...userHandlers,
]
```

## Запуск MSW в приложении

```tsx
// src/app/main.tsx
async function enableMocking() {
  if (import.meta.env.DEV) {
    const { createWorker } = await import('@/shared/api/msw-setup')
    const worker = await createWorker()
    return worker.start({
      onUnhandledRequest: 'warn',
      serviceWorker: { url: `${import.meta.env.BASE_URL}mockServiceWorker.js` },
    })
  }
}

enableMocking().then(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  )
})
```

> ⚠️ Используй `createWorker()` (lazy import), а не прямой `import { worker }` — иначе Vite при сборке
> пытается резолвить `msw/browser` в Node-окружении тестов и падает.
> Псевдоним `'msw/node' → msw-node-stub.ts` в `vite.config.ts` тоже обязателен.

## Написание хендлеров

```ts
// src/shared/api/users/handlers.ts
import { http, HttpResponse, delay } from 'msw'
import { users } from './data'  // моковые данные

export const userHandlers = [
  // GET список
  http.get('/api/users', async ({ request }) => {
    const url = new URL(request.url)
    const search = url.searchParams.get('search') ?? ''
    const page = Number(url.searchParams.get('page') ?? 1)
    const limit = Number(url.searchParams.get('limit') ?? 10)

    await delay(300)  // реалистичная задержка

    const filtered = users.filter(u =>
      u.name.toLowerCase().includes(search.toLowerCase())
    )

    return HttpResponse.json({
      data: filtered.slice((page - 1) * limit, page * limit),
      total: filtered.length,
      page,
      limit,
    })
  }),

  // GET один элемент
  http.get('/api/users/:id', async ({ params }) => {
    await delay(200)
    const user = users.find(u => u.id === params.id)

    if (!user) {
      return HttpResponse.json({ message: 'Пользователь не найден' }, { status: 404 })
    }

    return HttpResponse.json(user)
  }),

  // POST создание
  http.post('/api/users', async ({ request }) => {
    const body = await request.json() as CreateUserDto
    await delay(500)

    const newUser = {
      id: crypto.randomUUID(),
      ...body,
      createdAt: new Date().toISOString(),
    }

    users.push(newUser)
    return HttpResponse.json(newUser, { status: 201 })
  }),

  // PUT обновление
  http.put('/api/users/:id', async ({ params, request }) => {
    const body = await request.json() as UpdateUserDto
    await delay(400)

    const index = users.findIndex(u => u.id === params.id)
    if (index === -1) {
      return HttpResponse.json({ message: 'Не найден' }, { status: 404 })
    }

    users[index] = { ...users[index], ...body }
    return HttpResponse.json(users[index])
  }),

  // DELETE удаление
  http.delete('/api/users/:id', async ({ params }) => {
    await delay(300)
    const index = users.findIndex(u => u.id === params.id)

    if (index === -1) {
      return HttpResponse.json({ message: 'Не найден' }, { status: 404 })
    }

    users.splice(index, 1)
    return new HttpResponse(null, { status: 204 })
  }),
]
```

## Моковые данные

```ts
// src/shared/api/users/data.ts
export interface User {
  id: string
  name: string
  email: string
  role: 'admin' | 'manager' | 'user'
  status: 'active' | 'inactive'
  createdAt: string
}

// Используй реалистичные русские данные
export const users: User[] = [
  {
    id: '1',
    name: 'Алексей Петров',
    email: 'a.petrov@company.ru',
    role: 'admin',
    status: 'active',
    createdAt: '2024-01-15T10:00:00Z',
  },
  {
    id: '2',
    name: 'Мария Иванова',
    email: 'm.ivanova@company.ru',
    role: 'manager',
    status: 'active',
    createdAt: '2024-02-20T14:30:00Z',
  },
  // Добавляй 5-15 записей для реалистичности
]
```

## Правила написания моков

1. **Реалистичные задержки** — всегда добавляй `await delay(200-500)`, чтобы UX был честным
2. **Реалистичные данные** — русские имена, реальные форматы дат, правдоподобные значения
3. **Обработка ошибок** — всегда возвращай 404 если не найдено, 422 если невалидные данные
4. **Пагинация** — если список, всегда делай пагинацию
5. **Поиск/фильтрация** — если в ТЗ есть поиск, реализуй его в моке
6. **Состояние в памяти** — мутации (POST/PUT/DELETE) должны реально изменять массив данных
7. **Каждый хук — dual-mode** (см. «Как использовать в компонентах» ниже) — без этого прототип в собранном виде (`/export-html`, API-сервис) будет вёрсткой без единой рабочей кнопки

## Как использовать в компонентах — ОБЯЗАТЕЛЬНО dual-mode хуки

> ⚠️ **Это не опционально.** Прототип собирается не только через `vite dev` (там MSW реально
> перехватывает `fetch`), но и в single-file HTML (`/export-html`, а также асинхронный API-сервис) —
> а там **Service Worker не запускается** (нет `vite dev`, часто нет и `file://`-доступа к SW).
> Если хук написан как голый `fetch('/api/...')` без запасного варианта — в собранном прототипе
> запрос просто падает в никуда: список остаётся пустым, кнопки «создать/изменить/удалить» ничего
> не делают. Менеджер увидит вёрстку без единой рабочей кнопки — это ломает весь смысл прототипа.
>
> Каждый хук, который дёргает `/api/...`, обязан ветвиться по `import.meta.env.DEV`:
> в dev — реальный `fetch` (MSW его перехватит), вне dev — сразу отдаёт статические сид-данные
> и мутирует их **в локальном React state**, без сети. Именно эта ветка делает кнопки в собранном
> прототипе живыми.

```tsx
// src/entities/user/model/useUsers.ts
import { useState, useEffect, useCallback } from 'react'
import { users as seedUsers } from '@/shared/api/users/data'
import type { User, CreateUserDto } from '@/shared/types'

const IS_DEV = import.meta.env.DEV

export function useUsers(search: string, page: number) {
  // Вне dev — сразу стартуем с сид-данными, без пустого экрана загрузки
  const [users, setUsers] = useState<User[]>(IS_DEV ? [] : seedUsers)
  const [isLoading, setIsLoading] = useState(IS_DEV)

  useEffect(() => {
    if (!IS_DEV) return // статика уже в state — сетевой запрос не нужен
    setIsLoading(true)
    fetch(`/api/users?search=${search}&page=${page}`)
      .then((r) => r.json())
      .then(({ data }) => setUsers(data))
      .finally(() => setIsLoading(false))
  }, [search, page])

  const createUser = useCallback(async (dto: CreateUserDto) => {
    if (!IS_DEV) {
      const newUser: User = { ...dto, id: crypto.randomUUID(), createdAt: new Date().toISOString() }
      setUsers((prev) => [newUser, ...prev])
      return newUser
    }
    const res = await fetch('/api/users', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dto),
    })
    const newUser = await res.json()
    setUsers((prev) => [newUser, ...prev])
    return newUser
  }, [])

  const deleteUser = useCallback(async (id: string) => {
    if (!IS_DEV) {
      setUsers((prev) => prev.filter((u) => u.id !== id))
      return
    }
    await fetch(`/api/users/${id}`, { method: 'DELETE' })
    setUsers((prev) => prev.filter((u) => u.id !== id))
  }, [])

  return { users, isLoading, createUser, deleteUser }
}
```

Правила для этой ветки:
- **`updateUser`/аналоги** — та же схема: вне dev просто `setUsers(prev => prev.map(...))` вместо `fetch` + `PUT`
- **Фильтрация/поиск/пагинация** вне dev — считай на клиенте из уже загруженных сид-данных (`Array.filter`/`slice`), а не через query-параметры к несуществующему бэкенду
- **Ошибки** вне dev не нужны — там нет сети, которая могла бы упасть; `try/catch` вокруг `fetch`-ветки оставляй только для dev-режима
- Этот паттерн нужен **в каждом хуке, где есть `fetch`** — не только в «главном» списке, а во всех CRUD-операциях, которые должны быть видимо интерактивны в собранном прототипе

## MSW в тестах

```ts
// tests/setup.ts — уже настроено в шаблоне
import { server } from '@/shared/api/msw-setup'

beforeAll(() => server.listen())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// В конкретном тесте — переопределить хендлер
import { server } from '@/shared/api/msw-setup'
import { http, HttpResponse } from 'msw'

it('shows error when API fails', async () => {
  server.use(
    http.get('/api/users', () => {
      return HttpResponse.json({ message: 'Server Error' }, { status: 500 })
    })
  )
  // ...тест
})
```
