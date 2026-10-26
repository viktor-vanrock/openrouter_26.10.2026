import { setupServer } from 'msw/node'
import { handlers } from './handlers'

// Для тестов (Node.js / Vitest)
export const server = setupServer(...handlers)

// Для браузера инициализируем лениво чтобы не ломать тесты
export async function createWorker() {
  const { setupWorker } = await import('msw/browser')
  return setupWorker(...handlers)
}
