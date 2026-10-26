# Сервис прототипов

Основные документы после очистки 12 октября 2026:

| Документ | Для чего |
| --- | --- |
| [PDF-инструкция](deployment-guide/prototype-service-deployment-guide-2026-10-12.pdf) / [HTML со схемами](deployment-guide/guide.html) | Запуск простым языком, архитектура, путь пользователя и распределение секретов |
| [Production worker](gateway-worker-production-runbook.md) | Standby/active, Secret, ручные GitLab build/deploy и откат |
| [Development UI](gateway-ui-runbook.md) | Локальные зависимости, обычный чат и ручная проверка |
| [Адаптер](adapter-release-runbook.md) | Отдельный proxy release и controlled live acceptance |
| [Спецификация](gateway-migration-spec.md) / [задачи](gateway-migration-tasks.md) | Требования, фактическая приёмка, незакрытые gates |
| [Отчёт Gateway](gateway-agent-isolation-report-2026-10-09.md) | Реальные ограничения UID/egress и Storybook routing |
| [Контракты](contracts-v2.md) / [BFF OpenAPI](bff-openapi.yaml) / [Model Proxy OpenAPI](model-proxy-openapi.yaml) | Авторизация, transport и API |

Текущий engine — `direct-react-v1`: trusted worker вызывает выбранную модель, Gateway собирает исходники. Development flow принят. OpenCode/FSD и полный production deployment/product acceptance ещё не приняты; agent release pin отсутствует. Точный статус — checklist, исторические результаты не являются свежей проверкой production.

Локальные проверки без production writes и paid calls:

```sh
node --test apps/prototype-service/test/*.test.js
node docs/integrations/prototype-agent/validate-openapi.mjs
NODE_OPTIONS=--experimental-vm-modules npm run test:ci --workspace=api -- --runInBand server/routes/__tests__/prototypes.spec.js server/routes/__tests__/config.spec.js server/services/Prototypes/PrototypeService.spec.js
npm run test:ci --workspace=client -- --runInBand src/hooks/Prototype/usePrototypeAvailability.spec.tsx src/components/Chat/Input/PrototypeModeBadge.spec.tsx src/hooks/Messages/useSubmitMessage.spec.tsx
```

Регрессионные тесты/runtime fixtures сохранены. Старые одноразовые e2e/дубли планов удалены. Private receipts, `.env`, `.prototype-dev` и любые реальные секреты не включаются в Git.
