# Сервис прототипов

Действующий engine — `direct-react-v1`. Trusted worker использует существующий ключ выбранной модели владельца; Sandbox Gateway выполняет сборку. OpenCode/FSD — следующий отдельный gate, автоматического переключения нет.

## Development

Общая конфигурация находится в root `.env`: primary `MONGO_URI` сохраняется, `PROTOTYPE_MONGO_URI` задаёт отдельный replica store; Redis/OBS/Gateway используют общие `REDIS_URI`, `AWS_*`, `SANDBOX_GATEWAY_*`. Region и addressing задаются явно; для текущего OBS `AWS_FORCE_PATH_STYLE=false`, для local MinIO true. Модель выбирается в чате.

```sh
docker volume create prototype_mongo_data
docker compose -f docker-compose.deps-only.yml --profile prototype up -d --no-deps --wait prototype-mongo
npm run prototype:dev -- --check
```

`--check` не потребляет задания и не вызывает модель, но проверка зависимостей может создать consumer group и собственный временный storage probe. Launcher не поднимает Docker/кластер/API/frontend и не копирует аккаунты.

В отдельных терминалах:

```sh
npm run backend:dev
npm run frontend:dev
npm run prototype:dev
```

Остановка только worker: `npm run stop --workspace=apps/prototype-service`. Полная [инструкция UI](../../docs/integrations/prototype-agent/gateway-ui-runbook.md).

## Production

```sh
node apps/prototype-service/src/entrypoint.js
# либо
npm start --workspace=apps/prototype-service
```

Production entrypoint получает process env из dedicated Secret/chart; root `.env` не загружается. Нужны роль orchestrator, sandbox-gateway backend, HTTPS bearer control plane и Mongo/Redis/OBS/Gateway. Один процесс без конфигурации завершается безопасной startup error с именем отсутствующего поля.

Образ: `docker build -f apps/prototype-service/Dockerfile --target runtime -t <worker-image> .`. Deployment: `helm/prototype-service`, `envs/prod-prototype-worker.yaml`, manual `build_prototype_worker` → `deploy_prototype_worker`. Для первой проверки инфраструктуры задать `WORKER_INTAKE_ENABLED=false`; active запуск требует согласованного pilot scope.

[Production runbook](../../docs/integrations/prototype-agent/gateway-worker-production-runbook.md), [adapter-only](../../docs/integrations/prototype-agent/adapter-release-runbook.md), [основные документы и приёмка](../../docs/integrations/prototype-agent/README.md).

## Проверки

`node --test apps/prototype-service/test/*.test.js` сохраняет meaningful regression coverage. Docker-based storage/vertical suites используют отдельный loopback compose с synthetic test-only credentials:

```sh
docker compose -f docker-compose.prototype-test-s3.yml up -d --wait
PROTOTYPE_STORAGE_INTEGRATION=1 NODE_OPTIONS=--experimental-vm-modules npm run test:ci --workspace=api -- --runInBand server/services/Prototypes/PrototypeS3Client.integration.spec.js
```

После проверки `docker compose -f docker-compose.prototype-test-s3.yml down` останавливает контейнер, сохраняя named volume. Набор multi-file source fixtures и versioned runtime assets обязателен: runtime читает инструкции из `assets/docs`, regressions используют файлы `fixtures`.
