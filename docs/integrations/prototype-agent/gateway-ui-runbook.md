# Development: обычный чат через Gateway

Действующий engine — direct-react-v1. Development UI принят 7–8 октября 2026; OpenCode/FSD и полный production product gate остаются открытыми. Статус — [checklist](gateway-migration-tasks.md), production запуск — [worker runbook](gateway-worker-production-runbook.md).

## Конфигурация

Один root `.env`, owner-only0600:

- существующий `MONGO_URI` основной LibreChat сохранён;
- `PROTOTYPE_MONGO_URI=mongodb://127.0.0.1:19017/chatrouter_prototypes?replicaSet=prototype-rs&directConnection=true` — отдельная БД в постоянном Docker replica set `prototype-mongo`; основной Mongo на27017 остаётся standalone;
- общий `REDIS_URI=redis://127.0.0.1:6379`, `USE_REDIS`, `USE_REDIS_STREAMS` — текущий Docker `chat-redis`; отдельного Redis прототипов нет;
- общий набор `AWS_*`, явный region; для текущего endpoint `AWS_FORCE_PATH_STYLE=false` после фактического object probe;
- `PROTOTYPE_EXECUTION_BACKEND=sandbox-gateway`, `SANDBOX_GATEWAY_URL`, inline `SANDBOX_GATEWAY_TOKEN`, optional CA;
- `OPENROUTER_API_URL` и существующие пользовательские credentials; модель выбирается в интерфейсе, не в launcher.

Preview origin и включение prototypeAgent остаются в основном `librechat.yaml`. Service profile schemaVersion2 не копирует credentials и не меняет primary DB/config/search/host. Local dev header используется только в development и не является production identity.

## Gateway build image

Gateway удаляет опубликованные sandbox images через 3 дня. Перед каждым обновлением build image и до истечения этого окна выполнить из корня репозитория:

```sh
node apps/prototype-service/scripts/gateway-fsd-build.mjs
```

Скрипт собирает toolchain из pinned Node base image и зафиксированных template/runner dependencies, запускает synthetic FSD build в собственном sandbox без model/provider запросов и только после успешной проверки обновляет digest в `deploy/gateway/release-lock.json`. Затем нужно пересобрать и развернуть prototype service, чтобы его embedded release lock использовал новый digest. Эта процедура обновляет срок хранения Gateway image; для долгосрочной работы всё ещё нужно согласовать с Gateway owner постоянную retention policy.

## Запуск

Подготовить постоянный локальный replica set (отдельно от worker):

```sh
docker volume create prototype_mongo_data
docker compose -f docker-compose.deps-only.yml --profile prototype up -d --no-deps --wait prototype-mongo
npm run prototype:dev -- --check
```

Контейнер `chat-prototype-mongodb` публикует только loopback19017, использует сохранённый external volume `prototype_mongo_data` и автоматически инициализирует `prototype-rs` только при отсутствии конфигурации. Healthcheck ждёт writable primary, при restart не вызывает reconfig и не пересоздаёт БД. Volume прежнего prototype store восстановлен; основной `mongodb_data` контейнера чата не используется. Для чистой машины подготовить общий Redis/основную Mongo существующей командой `docker compose -f docker-compose.deps-only.yml up -d redis mongodb`.

`--check` проверяет обе Mongo, Redis/OBS/Gateway без чтения заданий очереди, запуска worker или запроса модели. Он может создать Redis consumer group и собственный временный S3 probe; probe очищается. При ошибке указывает зависимость и команды подготовки Mongo. `prototype:dev` сам Docker не поднимает.

В отдельных терминалах:

```sh
npm run backend:dev
npm run frontend:dev
npm run prototype:dev
```

Dependency bootstrap launcher не выполняет. Подготовленные Mongo replica set и Redis уже должны работать; remote Gateway API1 и digest-pinned build image проверяются factory. Production direct worker использует отдельный packaged entrypoint; OpenCode/FSD gate ещё открыт.

Перед publication проверить только собственный test prefix:

```sh
node apps/prototype-service/scripts/gateway-preflight.mjs --objects
```

Текущий ожидаемый результат — все7 checks PASS на SberCloud OBS через signed x-amz-forbid-overwrite compatibility. Guard сохранён; новый endpoint с неподдерживаемым conditional-create по-прежнему не объявляет available. Сервис после этой проверки стартует и посылает authenticated heartbeat.

В интерфейсе выберите OpenRouter и нужную модель, включите Tools Options → Prototype mode. Отправьте требования, прочитайте план и подтвердите его. После предпросмотра используйте «Добавить требования» для правок; «Завершить прототип…» предлагает явно выбрать A/B. HTML и «Исходники» скачивают последнюю принятую версию. Реальный CRM flow на выбранной GPT Sol Latest завершён на этом wiring; при недоступном worker новые генерации скрываются, принятые результаты и отмена доступны.

## Локальные regressions и ручная проверка

```sh
node --test apps/prototype-service/test/*.test.js
node docs/integrations/prototype-agent/validate-openapi.mjs
```

Store/lease/recovery integration suites включать отдельно только для выбранного тестового replica store; они создают собственные записи/DB, не являются read-only. Скрипты `prototypeStoreSmoke.js` и `prototypeModelProxySmoke.js` проверяют локальные границы без paid provider calls.

При согласованном model budget пройти из обычного UI: план → approval → A/B с общими редактируемыми данными → правка телефона → явный finalize B → HTML/ZIP. Проверить desktop/mobile, формы/кнопки/search/filter, console и отсутствие внешних запросов в экспортированном HTML. Сохранить own job/version/digests/usage и cleanup evidence в ignored `.prototype-dev` без auth material.

Optional lifecycle runner без provider calls остаётся `e2e/prototype-optional-lifecycle.mjs`. Он требует собственный completed test job и отсутствие его temporary account, создаёт только выбранный account/waiting fixture/API processes, восстанавливает managed worker после проверки. Его мутации допустимы только в согласованном тестовом scope.

При worker loss инструмент/badge исчезают по heartbeat TTL, composer освобождается, draft не отправляется автоматически; обычный чат/ready/login работают. Проверить recovery и доступность ранее принятых downloads/cancel. Прогон в development не доказывает production identity/isolation/whole sandbox stop.

## Browser gate сборки

Обязательная `validation=browser` реализована в отдельном build profile: Chromium проверяет opaque iframe/CSP, desktop1440×900 и mobile390×844, runtime/console/root/network и основное действие. Ошибка generated source допускает bounded repair; инфраструктурная ошибка не вызывает модель. Последняя accepted версия сохраняется при failure.

Counter fixture образа `sha256:946ba4629bce9a6aee1dd204db171fc32c72ffd67949bb246cdc18887700e9e9` прошёл реальные checks, но полный browser gate не включён: employee/runtime-negative acceptance прерван image pull503/start deadline. `release-lock.build.browserQaRequired` остаётся выключен до повторной проверки operator image/pull availability. Повторение без model calls (создаёт own Gateway executions):

```sh
node apps/prototype-service/scripts/gateway-browser-build.mjs --verify-image \
  swr.ru-moscow-1.hc.sbercloud.ru/sber_devices/rndml/devops/k8s-sandbox-gw/sandbox-images@sha256:946ba4629bce9a6aee1dd204db171fc32c72ffd67949bb246cdc18887700e9e9
```

Включение gate — только после good counter/employee/runtime-negative smoke. Ordinary chat не зависит от этого gate; статус не выдаётся за полный production build.
