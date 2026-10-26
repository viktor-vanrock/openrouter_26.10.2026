# Приёмка сервиса прототипов через Gateway

Актуальный список задач после очистки 12 октября 2026. Основные требования — [gateway-migration-spec.md](gateway-migration-spec.md), запуск — [README.md](README.md). Старые планы и дневники сведены в этот документ; удалённые источники доступны в Git history и сохранённой оператором резервной копии.

## Текущее состояние

- 13 октября, после `PROTOTYPE_INVALID_STATE` у повторного выполнения старого задания: воспроизведён конфликт immutable generation pins после изменения `rulesDigest`. Исключение до обычного stage handler раньше оставляло API/UI в running. Конфликт теперь создаёт проверяемый failure receipt и отправляется через существующий supervisor/fenced API; pins не переписываются, stale execution не завершается. Локально worker 204 passed/16 skipped, UI карточки 22 passed; новый rollout и изменение состояния зависшего production задания пока не проверены.

- 13 октября, после production ошибки `tsx_syntax_error` (TS1434, ответ 393 bytes): этап генерации теперь явно передаёт модели состояние `IMPLEMENTATION_APPROVED` и команду вернуть только App.tsx, сохраняя требования и историю. Отклонённый ответ сохраняется отдельно в приватный файл workspace, без включения в общий журнал/downloads/checkpoints. Локально: 201 passed, 16 skipped; подтверждены request contract, права файла и отсутствие повторного provider POST. Конкретный старый ответ не получен, поэтому причина production отказа остаётся гипотезой; новый rollout/live-прогон ещё не принят.

- 13 октября: локально проверено подробное логирование worker. В production — JSON в stdout, полные IDs команды/генерации, события модели/Gateway/control plane/workspace, причины отказа React и переходы readiness/heartbeat. Набор `node --test apps/prototype-service/test/*.test.js`: 199 passed, 16 skipped (внешние интеграции). Это engineering acceptance логирования; rollout, разбор JSON в OpenSearch и повторный согласованный прогон после `LIVE_MODEL_REACT_INVALID` ещё не проверены. T034–T036 этим не закрываются. Поиск и поля описаны в `gateway-worker-production-runbook.md`.

- Действующий engine: direct-react-v1. Разработка обычного UI/Gateway flow принята7 октября; full production product gate ещё не принят.
- T001–T010 и T037 имеют наблюдаемую development/engineering acceptance. Открытые T011–T036 не закрываются наличием исходников или одним smoke; отдельно принятый mTLS scope T028 сохранён.
- 9 октября own production store openrouter_chat/rs0: primary3 members, snapshot transaction, active refresh200, scoped discovery200 exact ~openai/gpt-luna-latest, cancel/fence then refresh409 PASS. Paid0.
- Worker standalone arm64 container: standby7/active10 checks PASS на own local Mongo/Redis/MinIO/HTTPS control plane и real Gateway GET; full registry amd64 CI/deployment/UI/restart/capacity acceptance pending.
- Dedicated installed OpenCode1.18.16 candidate: real Gateway image build/pull/start, UID10001 через trusted launcher, hostile-config/plugin/MCP/bash/webfetch/external-read denial PASS. Кандидат b048d1db… не принят: direct provider/public egress доступны, default Gateway session uid0 несмотря на image USER. release-lock.agent=null, productionApproved=false. Полный [отчёт Gateway](gateway-agent-isolation-report-2026-10-09.md).
- Storybook:8 октября corporate endpoint nginx307 self-redirect из Gateway при локальном200; legacy endpoint позднее real Gateway MCP PASS. Current network12 октября не перепроверялся; включение MCP требует отдельного approved origin/permissions.
- API/tool access: создание доступно авторизованным пользователям при включённой функции и готовом сервисе; чтение и отмена сохраняют привязку к владельцу и tenant.

## Задачи и исходные критерии приёмки

Отметка означает принятый scope задачи, не полную production готовность. Список сохраняет все37 идентификаторов и исходные критерии; предложенные пути будущих файлов не являются существующими runtime entrypoints.

- [x] T001 Добавить explicit Gateway backend, private URL/token/CA/image/resource limits и factory в `apps/prototype-service/src/config.js`, `sandbox-gateway-client.js`, `gateway-pipeline-client.js` и `apps/prototype-service/src/execution-backend.js` (новый). Для Gateway не требовать scheduler env; TLS/секреты/API compatibility/profile проверяются; exact release pin хранить в release lock, не требовать EXPECTED_VERSION в обычном local env, host/legacy fallback отсутствует. Читать root `.env` (ignored0600), куда пользователь поручил перенести S3/Redis/Gateway; поддержать `SANDBOX_GATEWAY_URL`/inline `SANDBOX_GATEWAY_TOKEN` и optional CA/file mode с явным выбором. Нормализовать S3 настройки для общего API/service клиента; credentials отсутствуют в `.env.example`/YAML. Для S3 использовать только AWS_*, для Redis — REDIS_URI, для model provider — OPENROUTER_API_URL и выбранную пользователем модель чата. Не вводить отдельные prototype credentials/URLs или region defaults. AWS_REGION должен быть явно заполнен для SDK signing. Перед acceptance проверить необходимые bucket/object permissions; один HeadBucket403 не определяет object-level capabilities.
  - Приёмка: missing/invalid settings fail-closed, валидный pin выбирает Gateway clients без чтения Kubernetes token.

- [x] T002 Ввести минимум durable build execution intents/IDs/input digest/offsets/cleanup outcome в `apps/prototype-service/src/gateway-execution-repository.js` (новый), `gateway-pipeline-client.js` и `packages/data-schemas/src/schema/prototypeGatewayExecution.ts` (новый, register в schema/models/methods exports). Привязать full tuple и CAS, сохранять verified output в S3 до DELETE.
  - Приёмка: lost create/session response сохраняет unknown intent и не повторяет POST; S3 failure не превращается в публикацию success.

- [x] T003 Выделить общую stage wiring из acceptance в `apps/prototype-service/src/react-stages.js` и `runtime-factory.js` (новые), переиспользовать `local-react-stages.js`, `stage-supervisor.js`, `orchestrator-runtime.js`. Transfer/fixed dependency stages проверяют конкретные persisted refs вместо фиктивного digest.
  - Приёмка: один source input ведёт к одному связанному snapshot/publication, agent/model code не исполняется на trusted host.

- [x] T004 Подключить factory к `apps/prototype-service/scripts/dev.mjs`, `scripts/stop-dev.mjs`, `api/server/services/Prototypes/PrototypeDevProfile.js` и `apps/prototype-service/README.md`. Сохранить три обычных scripts; Gateway profile не вызывает local-mvp/local-pipeline/Lima, не спавнит API/frontend и не останавливает чужие dependencies. Использовать общие root AWS settings в API/service без копирования credentials в dev profile; убрать hardcoded MinIO overrides при заданном S3. Redis оставить local для текущего стенда; не перезаписывать unrelated root `.env` настройки и не читать stale external secret copies вместо root env.
  - Приёмка: API/service control-plane repository scope совпадает; primary chat DB/config не переключаются по worker PID, подготовка replica-set scope явная и недеструктивная; secrets не печатаются.

- [x] T005 Проверить штатные approval/reply/finalize/SSE/download связи в `client/src/hooks/Messages/useSubmitMessage.ts`, `client/src/components/Chat/Prototype/PrototypeCard.tsx`, `api/server/routes/prototypes.js` и `api/server/services/Prototypes/PrototypeService.js`; исправить только выявленные gaps. В review использовать saved user message + replies, не submit нового initial turn.
  - Приёмка: устаревшая revision/чужой conversation отклонены, UI показывает стадии и provider usage без raw logs.

- [x] T006 Подготовить и выполнить компактную реальную UI приёмку в ручном сценарии обычного UI по runbook и `docs/integrations/prototype-agent/gateway-ui-runbook.md` (новый). CRM/план/approval/A-B shared state/добавление/редактирование/телефон/final B/download; Chromium desktop/mobile, hashes и sandbox cleanup. Evidence без secrets в ignored acceptance directory. Gate UI требует действий из обычного интерфейса, не только scripted BFF calls; FSD/production пока не заявлять.
  - Приёмка: См. требования текущей спецификации и фактические gates ниже.

- [x] T007 Описать versioned generation engine/source manifest/limits и additive schemas в `apps/prototype-service/src/generation-engine.js`, `source-manifest.js` (новые), `packages/prototype-worker/src/contracts.v2.ts` и `packages/data-schemas/src/schema/prototypeJob.ts`, `prototypeTurn.ts`. Зафиксировать engine/model/rules/profile в job/turn; baseline App.tsx преобразовать в manifest.
  - Приёмка: strict round-trip, конфликт engine/source/revision отклонён; старые records/read/download поддержаны.

- [x] T008 Реализовать multi-file policy/FSD imports в `apps/prototype-service/src/react-project-policy.js` (новый), `react-source-policy.js`, `packages/prototype-worker/src/archivePolicy.ts`. Allowlisted source paths/extensions, local aliases, layer direction, slice public API; immutable package/lock/config/main/providers.
  - Приёмка: valid FSD fixture принят, path traversal/duplicate/symlink/config edit/upper-layer import/network code отклонены. Наличие папок без декомпозиции не засчитывается как FSD.

- [x] T009 Добавить отдельный multi-file profile/manifest input и полную source binding в `apps/prototype-service/src/pipeline-contract.js`, `gateway-pipeline-client.js`, `packages/prototype-worker/src/execution/artifacts.ts` и `apps/prototype-service/src/gateway-build-runner.mjs` (новый trusted runner). Перенести runner из приватного acceptance context в versioned source.
  - Приёмка: remote multi-file fixture проходит type/lint/build, HTML/ZIP/QA hashes совпадают; transport/base64/archive caps и config hashes проверены; прежний single-file profile не ломается.

- [x] T010 Подготовить versioned prompt/rules bundle в `api/server/services/Prototypes/local-agent-assets/docs/rules/architecture.md`, `rules/code-style.md`, `docs/skills/create-prototype.md`, `variant-switcher.md`, `choose-variant.md`, `use-uikit.md`, `apps/prototype-service/src/react-agent-instructions.js` (новый). Указать соответствие `demo-promo-agent` и overrides: in-memory mocks, offline HTML, no runtime install/MCP/webfetch.
  - Приёмка: bundle доступен в image, hash/version записаны; dependency на sibling repo отсутствует; инструкции не требуют весь код в App.tsx.

- [ ] T011 Проверить SDK/binary versions и реализовать constrained agent runtime/tools в `packages/prototype-worker/src/opencode/client.ts`, `events.ts`, `apps/prototype-service/src/opencode-gateway-client.js` и `agent-tools.js` (новые). OpenCode запускается только в agent sandbox; tools читают/ищут/редактируют разрешённый source, arbitrary bash/webfetch/MCP/plugins/external_directory denied; проверки выполняет trusted runner. Проверка installed binary через adaptation `packages/prototype-worker/scripts/opencode-hostile-config.mjs`: project config не расширяет permissions; реальные tool calls не обходят path bounds. Не переиспользовать broad localAutoApprove.
  - Приёмка: См. требования текущей спецификации и фактические gates ниже.

- [ ] T012 Довести Model Proxy/lease token/SDK protocol в `api/server/services/Prototypes/PrototypeModelProxy.js`, `PrototypeJobTokenService.js`, `apps/prototype-service/src/model-proxy-lifecycle.js` (новый) и `config.js`. Проверить модели/discovery, streaming tools/results/usage, active tuple, token expiry/renewal, фиксированный upstream/model.
  - Приёмка: реальный SDK запрос проходит, подмена модели/URL/identity denied, после cancel новые requests denied; request caps bounded и достаточны для multi-file context.

- [ ] T013 Добавить multi-request turn budget/request journal в `apps/prototype-service/src/local-model-budget.js`, `local-model-settings.js`, `api/server/services/Prototypes/PrototypeModelMetrics.js` и `apps/prototype-service/src/agent-budget.js` (новый). Один turn учитывает все provider requests/repair; limits $2/8 requests/100 tools/2 repairs/10min configurable и persisted.
  - Приёмка: replay request ID не bill twice; настоящий следующий tool request разрешается в том же turn; unknown provider outcome не приводит к скрытому повтору/освобождению резерва.

- [ ] T014 Подготовить agent/build images и bounded TLS network profiles в `apps/prototype-service/Dockerfile`, `deploy/gateway/agent-profile.example.yaml`, `build-profile.example.yaml`, `release-lock.json` (новые examples/lock). Только agent→Model Proxy; build offline; no team/provider/DB/S3 keys в sandbox. В `docs/integrations/prototype-agent/gateway-migration-tasks.md` (новый) записать фактический reachability из sandbox. Platform egress/proxy publication выполняет владелец; не делать local tunnel/public exposure без согласованной схемы.
  - Приёмка: реальный proxy доступен, иной egress denied, image pulls доступны; unknown оставить blocker.

- [ ] T015 Выполнить реальный installed OpenCode smoke с моделью, выбранной в текущем чате, в `apps/prototype-service/scripts/gateway-opencode-probe.mjs` (новый). Прочитать файл, создать модуль, импортировать его и вернуть bounded source manifest; сохранить image/binary/model/tool events/usage/snapshot evidence. GPT Sol Latest в исторических receipts — конкретная acceptance-модель, а не обязательный runtime default.
  - Приёмка: tools действительно выполнены в Gateway sandbox, токен обновляется при длительном turn; без host OpenCode/mock provider или незаметной смены модели.

- [ ] T016 Реализовать ограниченный repair supervisor в `apps/prototype-service/src/agent-repair-loop.js` (новый), `opencode-gateway-client.js`, `gateway-pipeline-client.js`, `pipeline-diagnostics.js`. Сохранить candidate manifest перед checks; максимум2 исправления после initial checks, общий budget/deadline; окончательное решение только по trusted validation.
  - Приёмка: acceptance-only controlled TS error исправлен; повторный deterministic failure останавливается; previous publication не меняется. Fault injection выключен вне acceptance.

- [ ] T017 Провести сопоставимый CRM цикл и зафиксировать go/no-go в `e2e/prototype-opencode-comparison.mjs` и `docs/integrations/prototype-agent/gateway-opencode-evaluation.md` (новые). Проверить реальное FSD, A/B state, телефон/edit/finalize/offline HTML и repair; записать calls/tokens/cost/time/success vs baseline. Один исторический sample не доказывает экономию. Gate O: совместимость tools/proxy/permissions и usable source подтверждены; при no-go записать причину и не включать engine всем новым jobs.
  - Приёмка: См. требования текущей спецификации и фактические gates ниже.

- [ ] T018 Добавить durable plan/approval/engine/source/rules/model request refs и migrations в `packages/data-schemas/src/schema/prototypeJob.ts`, `prototypeTurn.ts`, `methods/prototype.ts`, `migrations/prototypeIndexes.ts` и `apps/prototype-service/src/prototype-state-repository.js` (новый). Проверка full tuple/CAS и immutable approval; plan JSON явно отличается от source checkpoint; новые поля additive, прежние данные не пересоздаются.
  - Приёмка: См. требования текущей спецификации и фактические gates ниже.

- [ ] T019 Реализовать immutable source manifest/checkpoint/restore в `packages/prototype-worker/src/storage/transfer.ts`, `storage/keys.ts`, `execution/artifacts.ts` и `apps/prototype-service/src/source-repository.js` (новый).
  - Приёмка: empty cache materializes последнюю accepted source с проверкой каждого digest/config pin; failed draft не выбран базой; сохранение до cleanup.

- [ ] T020 Подключить target engine к `apps/prototype-service/src/react-stages.js`, `runtime-factory.js`, `prototype-dialogue.js`, `react-prototype.js` и `local-react-stages.js`. Planner остаётся outside agent; coding начинается после persisted approval; no engine switch on failure. Legacy edit→FSD только новой accepted revision.
  - Приёмка: выбранный model/engine/rules сохраняются на ходе; agent completion без trusted checks не даёт preview.

- [ ] T021 Реализовать session lifecycle и восстановление bounded context в `apps/prototype-service/src/opencode-gateway-client.js`, `source-repository.js`, `packages/prototype-worker/src/opencode/client.ts`. Review/clarification не удерживают sandbox; новые sessions читают accepted project и transcript из durable refs. Native export/import только после verified portability и sanitization.
  - Приёмка: delete agent sandbox/fresh process после preview не мешает следующей правке.

- [ ] T022 Интегрировать multi-file review edit/выбор B/finalize/publication в `apps/prototype-service/src/react-stages.js`, `agent-repair-loop.js`, `packages/prototype-worker/src/execution/publication.ts`, `api/server/services/Prototypes/PrototypeService.js`.
  - Приёмка: меняются связанные файлы, общий state сохранён между A/B, switcher/невыбранный layout удалены; финальная версия принимается CAS только после type/lint/build.

- [ ] T023 Подключить agent progress/repair/budget usage к `apps/prototype-service/src/event-publisher.js`, `packages/prototype-worker/src/contracts.v2.ts`, `api/server/services/Prototypes/PrototypeEventApplier.js`, `client/src/components/Chat/Prototype/PrototypeCard.tsx`, `PrototypeMetrics.tsx`, `PrototypeProgress.tsx`.
  - Приёмка: SSE resume без duplicate effects, пользователь видит понятные стадии/стоимость; сырые tool outputs/provider secrets не отображаются; неизвестные usage/time не выдаются за точные.

- [ ] T024 Проверить экспорт/исторические версии/authorization в `api/server/routes/prototypes.js`, `api/server/services/Prototypes/PrototypeService.js`, `client/src/components/Artifacts/PrototypePreview.tsx`, `packages/prototype-worker/src/execution/artifacts.ts`.
  - Приёмка: multi-file ZIP содержит фактический FSD проект и fixed template, исключает secrets/deps/cache; one-file HTML offline; прежние App.tsx результаты доступны, чужой owner/conversation denied.

- [ ] T025 Расширить ручной UI приёмке по runbook и `docs/integrations/prototype-agent/gateway-ui-runbook.md` целевым сценарием OpenCode/FSD и restart-before-edit. Прогнать реальную модель через обычный UI: plan/approve/A-B/shared data/add/edit/phone/finalize/download + desktop/mobile, ZIP/import policy, no external requests, empty-cache restore. Зафиксировать Gate FSD и стоимость отдельно от baseline, не объявлять production-ready.
  - Приёмка: См. требования текущей спецификации и фактические gates ниже.

- [ ] T026 Довести durable agent/build reconciliation в `apps/prototype-service/src/gateway-execution-repository.js`, `gateway-pipeline-client.js`, `opencode-gateway-client.js`, `execution-registry.js`, `orchestrator-runtime.js`.
  - Приёмка: repeated Redis delivery, response lost create/session, crash после save/completion перед ACK — join/recover/quarantine без второго active execution и автоматического повторного paid request; plan/source/log offsets восстановлены.

- [ ] T027 Разделить intake/cancel/heartbeat/reconcile loops и cleanup debt в `apps/prototype-service/src/orchestrator-runtime.js`, `quota.js`, `gateway-execution-repository.js`, `api/server/services/Prototypes/PrototypeJobTokenService.js`.
  - Приёмка: cancel во время agent/build прерывает управление, отзывает model authority, fence запрещает late publication; running upstream billing отмечен честно; DELETE/404 не притворяются stop attestation.

- [x] T028 Реализовать native private mTLS API listener и service client в `api/server/services/Prototypes/PrototypeControlPlaneTlsServer.js` (новый), `PrototypeControlPlaneStartup.js`, `PrototypeTransportStartup.js`, `api/server/index.js`, `apps/prototype-service/src/control-plane-client.js`.
  - Приёмка: authorized SAN/cert принят; no cert/wrong SAN/expired cert/dev header/forwarded identity не дают service access; public API auth прежняя.

- [ ] T029 Подключить common Gateway/OpenCode runtime к `apps/prototype-service/src/entrypoint.js`, `run-role.js`, `orchestrator-lifecycle.js`, `config.js`, `server.js`, `runtime-factory.js`.
  - Приёмка: production не требует Kubernetes/projected output, readiness reflects actual dependencies/identity/API/images/model proxy; outage admission fail-closed, stop сохраняет intents; guards заменены wiring, не отключены.

- [ ] T030 Упаковать production API/service/agent/build dependencies в `apps/prototype-service/Dockerfile`, `package.json`, `packages/prototype-worker/package.json`, `deploy/gateway/release-lock.json` и `helm/prototype-service` и `envs/prod-prototype-worker.yaml`. Проверка final target NODE_ENV=production без API source imports/sibling repo/whole HOME/.env/Docker mounts; exact pins сохранены, image registry retention согласован, runtime npm install отсутствует.
  - Приёмка: См. требования текущей спецификации и фактические gates ниже.

- [ ] T031 Добавить ref-aware retention/GC и правила S3 в `apps/prototype-service/src/artifact-retention.js` (новый), `packages/prototype-worker/src/storage/s3.ts`, `api/server/services/Prototypes/PrototypeService.js`, `deploy/gateway/s3-retention.example.json` (новый). Staging24h, failed unreferenced drafts7дней — стартовые proposal; finals без auto-expiry; replay/tombstone≥7дней и не меньше actual replay window.
  - Приёмка: GC не удаляет active/accepted/recovery refs; partial upload очищается после grace; blanket bucket expiration запрещён.

- [ ] T032 Реализовать S3 capacity accounting/admission alerts и budget/queue/cleanup metrics в `apps/prototype-service/src/storage-capacity.js` (новый), `server.js`, `quota.js`, `docs/integrations/prototype-agent/gateway-operations.md` (новый). Quota30GB explicit, alerts70/85/95%; reserve всех active bounded outputs; новые admission запрещены при95% либо нехватке free capacity, неизвестная capacity fail-closed.
  - Приёмка: учитываются промежуточные/accepted copies; provider costs не смешиваются с registry/S3; backups/noncurrent versions вынесены в capacity assumptions.

- [ ] T033 Зафиксировать DevOps handoff в `docs/integrations/prototype-agent/gateway-worker-production-runbook.md` (новый): service→Gateway, sandbox→Model Proxy, CA/mTLS/token rotation, image pulls/retention, Gateway/sandboxd versions/limits/lease, isolation/egress/stop evidence, production Mongo/Redis/S3 ACL/backup/capacity. Никаких platform mutations из app tasks.
  - Приёмка: каждый input имеет owner/status/evidence; отсутствующие критические гарантии явные release blockers.

- [ ] T034 Подготовить packaged acceptance runner в `apps/prototype-service/scripts/gateway-production-smoke.mjs` (новый) и выполнить API/service NODE_ENV=production с локальными dependencies и remote Gateway. Реальный chat/FSD flow, auth negatives, cancel/timeout/queue/lost lease, duplicate delivery, empty tmpfs restart, S3 outage/partial save, download после cleanup.
  - Приёмка: без test identity/dev files authority; previous publication сохраняется при failure; evidence каждого обязательного сценария, targeted affected suites pass.

- [ ] T035 Подготовить worker Helm/CI/config/rollback и безопасную раздачу secrets; инструкции соответствуют фактическим entrypoints, deployment проверяется отдельно.
  - Приёмка: команды соответствуют существующим scripts/images, placeholders inputs явно указаны, secrets не включены; фактический deployment отдельное действие пользователя/оператора.

- [ ] T036 Согласовать основные инструкции, спецификацию, API-контракты и фактический checklist; удалять superseded документы, сохраняя актуальные требования и gates.
  - Приёмка: fresh user следует штатному UI runbook; production-ready только при T033/T034 и закрытых blockers.

- [x] T037 Завершить и проверить optional capability lifecycle в `api/server/services/Prototypes/PrototypeAvailability.js`, `PrototypeOptionalStartup.js`, `PrototypeTransportStartup.js`, `PrototypeDevProfile.js`, `api/server/index.js`, `api/server/routes/config.js`, `prototypes.js`, `internal/prototypeControlPlane.js`, `apps/prototype-service/src/service-heartbeat.js`, `client/src/hooks/Prototype/usePrototypeAvailability.ts`, `ToolsDropdown.tsx`, `PrototypeModeBadge.tsx`, `ChatForm.tsx`, `useSubmitMessage.ts`. Development lifecycle принят по приведённым ниже receipts; сохранить при common runtime/mTLS миграции и повторить packaged acceptance в T034.
  - Приёмка: API/readyz/login/обычная отправка стартуют при отсутствующем/зависшем prototype service и malformed prototype profile; primary DB/config не зависят от worker PID. При service loss readiness+heartbeat TTL15s/poll5s скрывают инструмент/badge и освобождают обычный composer без отправки draft автоматически. Authenticated heartbeat, multi-API visibility, восстановление после recovery и rejection new generation503 проверены. Accepted artifacts/cancel доступны при worker outage. Реальный ordinary UI smoke без prototype service дополняет targeted unit/render tests. Не обещать независимость от отказа общих Mongo/Redis/S3.

## Последовательность gates

1. UI baseline: T001–T006 и T037.
2. OpenCode/FSD: T007–T017; installed binary/tools/model proxy/egress перед сравнением и включением engine.
3. Edit/finalize/export: T018–T025 после agent gate.
4. Recovery/production: T026–T036; platform owners/packaged product verification обязательны.

## Внешние блокеры и следующий шаг

| Блокер | Владелец / действие |
| --- | --- |
| Gateway non-root contract и default-deny agent egress | Gateway operator: профиль, фактический workload selector, Model Proxy/DNS allowlist, provider/public denied; повторить probes из отчёта |
| Corporate Storybook self-redirect | Storybook ingress + Gateway DNS/routing owner: исправить внешний маршрут, повторить authenticated handshake/read docs |
| Paid scoped adapter/Gateway/tools/usage acceptance | ChatRouter + test owner: approved selected owner/model, current metadata, exact scope/budget; максимум2 POST/$0.10 для proposed smoke, без auto retry; затем reconcile own receipts |
| Worker production deployment | DevOps: dedicated Secret, native amd64 build/push/pull, CSI/PVC, same prototype store/Redis/OBS и healthy control plane; manual standby→active, full UI/cancel/restart checks |
| Full frontend build | 12 октября после удаления отдельного local UI и безопасных правок общий typecheck: 124 ошибки в frontend (исходно 188). Не выдавать focused PASS за full clean build |

## Evidence и правила повторения

Production authority own job_41f372f8bb4d07eb85cf7be2 retained canceled/revision3/fence2, no outbox/model requests. Full private receipts — .prototype-dev/adapter-gateway-acceptance-41f372f8bb4d07eb85cf7be2. Final agent image evidence — .prototype-dev/gateway-agent-image-1791556636683. Worker container evidence — .prototype-dev/production-worker-smoke-80672097bc5876ba11b6421e.

Provider/service/Gateway/DB/storage keys не отправлять в model/generated source/build sandbox. Нет self-signed JWT на клиенте, host OpenCode fallback, disabled TLS или public tunnel. Unknown paid/Gateway POST outcome не повторять; reconcile durable own tuple/IDs. DELETE ACK/GET404 не доказывает остановку whole cgroup. Не удалять shared stores/artifacts/secrets. Ordinary API/startup/chat должны сохраняться при отказе optional prototype service.

## Очистка и локальная проверка 12 октября 2026

Удалены 33 superseded документа, одноразовых e2e/probe helpers и дубли deployment примеров. Основная спецификация/checklist, API-контракты, operational runbooks, PDF/HTML, Gateway isolation report, runtime assets и regression suites сохранены. Существующие UI/runtime изменения включаются в общий commit; CRLF нормализованы в LF без удаления содержательных изменений. Private env/receipts остаются ignored; перед staging проверено отсутствие новых совпадений с private credentials.

Повторная локальная проверка: service189 PASS/16 external SKIP; API4 suites179 PASS/2 integration SKIP; tools3 suites24 PASS; client4 suites32 PASS; data-provider и prototype-worker build PASS; OpenAPI PASS; YAML parsing и Helm lint/render standby/active PASS; `git diff --check` PASS. Общий frontend typecheck FAIL:188 ошибок. Production/Gateway live requests, платные вызовы, deployment и смена действующих секретов в рамках очистки не выполнялись. Статусы остальных gates сохранены.

## Работа только через чат — 12 октября 2026

Свежий `origin/main` (921a2ff) влит в `prototype-agent-service` merge commit22b5de7 без конфликтов; направление подтверждено пользователем. Изменения прототипов обратно в main не вливаются.

Удалены 18 файлов отдельной страницы/runtime/router/smoke и её тестов; исключены local UI fields из startup/config schema/YAML, API mount и frontend route. Прототипы запускаются только через обычный чат и кнопку списка инструментов. Development launcher `prototype:dev` и общие direct generation stages сохраняются: это штатный worker чата. PDF/HTML обновлены, удалённых config fields и route references больше нет.

Низкорисковые typecheck правки: test fixtures/mocks и type-only imports, существующий shared Button в file views, декларация nullable error, callbacks диаграммы admin с проверкой отсутствующих координат. Логика отправки/streaming/model/store/worker не менялась. Общий typecheck188→124; оставшиеся ошибки требуют отдельного анализа chat/auth/attachments/dependencies, подавлений и ослабления compiler settings не добавлено. В изменённых сохраняемых frontend файлах type errors отсутствуют.

Проверки: API5 suites199 PASS/2 SKIP; schema121 PASS; client18 suites178 PASS (последние4 suites40 PASS после final type annotations); service189 PASS/16 external SKIP; data-provider build, frontend production build, OpenAPI PASS. Обновлённый PDF:8 страниц, layout PASS. Live production/provider/deployment не выполнялись.
