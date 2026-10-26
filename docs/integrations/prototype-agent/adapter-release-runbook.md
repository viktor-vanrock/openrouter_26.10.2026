# Первая выкладка адаптера с выключенными прототипами

Adapter-only overlay выключает UI/transport и включает proxy независимо от active worker settings в основном `envs/prod.yaml`. Для отдельной проверки адаптера применить `envs/prod-prototype-adapter.example.yaml`: UI/transport остаются выключенными, proxy включается отдельно. Рабочий generation worker этим релизом не запускается; OpenCode/FSD/production recovery gates ещё не приняты.

## Config и маршруты

В локальном chart `envs/prod.yaml` → `librechat.configYamlContent` → ConfigMap → `/app/librechat.yaml`. Корневой `librechat.yaml` используется локально и не включён в image. Vault integration в manifests отсутствует; environment приходит через существующий Kubernetes Secret `librechat-secret-env`. Если CI берёт внешний chart из helm-template, оператор должен подтвердить применение этих values и ConfigMap в rendered manifests. Не публиковать новый root `.env` целиком поверх production Secret.

Для первого запуска выбран `PROTOTYPE_SERVICE_AUTH_MODE=bearer`. Используется существующий HTTPS ingress и служебный токен worker→API. Сертификаты клиента, CA, private TLS Service3443 и identity initContainer не нужны. Обычные серверные HTTPS certificates Gateway/provider/Storybook/ChatRouter уже обслуживаются их инфраструктурой.

Worker обращается к `PROTOTYPE_CONTROL_PLANE_URL=https://orchat.sberai-rnd.ru`; client добавляет `/api` к внутренним путям:

- `/api/internal/prototype-tokens/refresh` — service auth, затем проверка active job/turn/fence/lease; invalid tuple422, stale409.
- `/api/internal/prototype-control/v2/*` — service auth; доступен только с включённым transport.
- `/api/prototype-model/v1/*` — короткий scoped model token для Gateway; служебный токен здесь не заменяет scoped token.

Без HTTPS или правильного service token refresh возвращает401. Legacy `/internal/prototype-tokens` в production остаётся404. В TLS termination режиме API использует Express `req.secure`: настроить `TRUST_PROXY` под реальное число доверенных ingress hops (текущий API принимает числовое значение), ingress должен заменять X-Forwarded-Proto, а backend port3080 должен быть доступен только доверенному ingress. Не открывать прямой публичный HTTP доступ к API. Streaming route должен сохранять путь без redirect и иметь выключенный SSE buffering.

## Секреты

| Переменная | Получатель | Назначение |
| --- | --- | --- |
| `PROTOTYPE_SERVICE_TOKEN` | API и trusted worker/probe | 32 случайных байта как64 lowercase hex characters; bearer только по HTTPS |
| `PROTOTYPE_MODEL_TOKEN_PRIVATE_KEY_BASE64` | Только API | RSA3072 PEM в однострочном base64 для подписи scoped model tokens |
| `PROTOTYPE_MONGO_URI` | API adapter и будущий worker | Отдельный prototype replica set; основной standalone MONGO_URI сохраняется |

Base64 не шифрует ключ: хранить его в production Secret/Vault, не YAML/Git. Эти секреты не заменяют JWT_SECRET/CREDS_KEY/CREDS_IV/provider keys. Service token и signing key не передаются sandbox. Токен sandbox ограничен выбранной моделью/owner/turn/lease, действует максимум45s и проверяется по живому состоянию БД. File-based signing key0600 остаётся допустимой альтернативой BASE64; два источника одновременно запрещены.

Сформировать новые секреты без печати значений и без перезаписи root `.env`:

```sh
mkdir -p .prototype-dev/production-identity
node apps/prototype-service/scripts/prepare-adapter-secrets.mjs \
  --out .prototype-dev/production-identity/adapter-secrets.env
```

Файл создаётся с0600 и exclusive create. Оператор добавляет обе переменные в существующий environment Secret через принятый процесс и отдельно PROTOTYPE_MONGO_URI. Worker/probe получает только service token; RSA signing key остаётся в API. Для ротации service token синхронно обновить API/worker; для signing key доступен предыдущий public key path. Optional native mTLS listener/client сохранён для последующего private deployment (`PROTOTYPE_SERVICE_AUTH_MODE=mtls`), но его PKI/bootstrap в первой выкладке не используется.

## Проверки и откат

1. Собрать candidate API image штатным CI. Dockerfile включает prototype-worker/dist, runtime Mongo/sharp dependencies и writable directories UID1000; client build уважает NODE_OPTIONS.
2. `node e2e/prototype-adapter-only.mjs --production` проверяет полный host API на собственных временных DB. `PROTOTYPE_ACCEPTANCE_IMAGE=<candidate-image> node e2e/prototype-adapter-image.mjs` проверяет полный packaged API UID1000. Оба runner не вызывают provider и не запускают worker; HTTPS ingress в локальном smoke моделируется доверенным proxy header.
3. Render prod values + adapter overlay. Подтвердить ingress, Secret flags, отдельный replica set. Никаких новых volumes/certificates/private ports для bearer режима.
4. После выкладки проверить ordinary ready/login/chat; `/api/prototype-model/v1/models` должен отвечать401 без scoped token. Refresh401 без service token. UI прототипов остаётся выключенным.
5. Отдельно принять реальный HTTPS Gateway→adapter и controlled active lease/scoped model request с выбранной моделью чата: streaming/usage/replay/cancel/budget. До этого локальный smoke не доказывает внешнюю production доступность или installed OpenCode.

Откат: adapter=false, UI/transport=false, предыдущий image digest. Store/Secrets сохраняются. Generation worker не запускать как часть первой выкладки.

## Controlled adapter acceptance

Фактические результаты и внешние блокеры — [checklist](gateway-migration-tasks.md); egress/installed binary/Storybook — [отчёт Gateway](gateway-agent-isolation-report-2026-10-09.md). Authority-прогон 9 октября подтвердил same production prototype store, refresh/scoped discovery и revoke после cancel без paid calls. Новый live scope требует свежих owner/model/metadata/approval и принятого agent image; старое разрешение не даёт автоматического rerun неизвестных POST.

Read-only default (не создаёт Mongo fixture/sandbox и не делает model POST):

```sh
node apps/prototype-service/scripts/gateway-adapter-probe.mjs
node apps/prototype-service/scripts/gateway-adapter-probe.mjs plan
```

Root `.env` читается без перезаписи. В production helper root локальный URI не использовать: оператор предоставляет `PROTOTYPE_MONGO_URI` нужного отдельного replica store в trusted process env и подтверждает same adapter DB. При `PROTOTYPE_ACCEPTANCE_PRODUCTION_STORE_CONFIRMED=true` plan фиксирует безопасный DB fingerprint; password/URI не выводится. Для выбора модели operator создаёт private0600 `selection.json`:

```json
{
  "owner": "<actual-userId-24hex>",
  "tenant": "<actual-tenantId>",
  "conversation": "<actual-conversationId>",
  "message": "<actual-messageId>",
  "model": "<exact-selected-message-model-including-tilde>",
  "verifiedByOperator": true,
  "operator": "<who-read-owner-bound-ChatRouter-message>"
}
```

`metadata.json`0600 — actual selected model entry от existing trusted API/provider catalog: id/context_length/top_provider.max_completion_tokens/pricing и при наличии overrides/cache/request prices. Не передавать provider key. Model в CLI отсутствует намеренно: source selection не заменяется runtime fallback. Operator selection является attestation; runner не заявляет самостоятельно выполненным read production chat DB.

```sh
node apps/prototype-service/scripts/gateway-adapter-probe.mjs plan \
  --selection .prototype-dev/<own-run>/selection.json \
  --metadata .prototype-dev/<own-run>/metadata.json
```

Plan печатает own IDs/full generation/changes/quote/ceiling/blockers и сохраняет0600 `plan.json`. Agent image берётся только из принятого `release-lock.agent.image`; пока agent=null, remote режимы blocked, build image не использовать. Review/write/cost approval сохраняется operator в0600 JSON **после явного разрешения человека**:

```json
{
  "operator": "<actual-approver>",
  "planDigest": "<digest-of-exact-plan>",
  "actions": ["fixture", "token", "gateway-discovery", "cleanup"],
  "validUntil": "<bounded-UTC-expiry>",
  "productionStoreFingerprint": "<same-store-fingerprint-from-plan>",
  "sameStoreAsProductionAdapter": true,
  "owner": "<actual-owner-from-plan>",
  "model": "<exact-model-from-plan>",
  "agentEgressVerified": true,
  "deployedCommit": "<actual-40hex-commit>",
  "deployedImageDigest": "sha256:<actual-64hex-digest>"
}
```

Для `live` включить соответствующее action и заранее согласовать `maxUsd:0.10`, `maxProviderPosts:2`, `metadataDigest:<from-plan>`, `metadataVerifiedAt:<operator-current-price-check-UTC>` (до5min перед запуском). Current price пересверяет оператор; hard API guards остаются$2/8/10min, runner не повышает и не подменяет их. Если quote выше$0.10/неизвестна, scope/model/metadata/image не доказаны — stop, корректность не упрощается.

После approval выполнить выбранный режим с **одним exact plan/approval**:

```sh
node apps/prototype-service/scripts/gateway-adapter-probe.mjs fixture --plan <private-plan.json> --approval <private-approval.json>
node apps/prototype-service/scripts/gateway-adapter-probe.mjs token --plan <private-plan.json> --approval <private-approval.json>
node apps/prototype-service/scripts/gateway-adapter-probe.mjs gateway-discovery --plan <private-plan.json> --approval <private-approval.json>
node apps/prototype-service/scripts/gateway-adapter-probe.mjs cleanup --plan <private-plan.json> --approval <private-approval.json>
```

Service bearer только в trusted process env, никогда argv/JSON/source/archive/sandbox. Token mode mint/renew пишет leases и поэтому тоже требует write scope approval. Discovery remote автоматически cancel/fence и cleanup в success/failure; **последующий live требует новую own fixture/IDs**. Для approved `live` заменить remote mode на `live`; он сам сначала проверяет discovery, затем два SSE POST/function-tool/follow-up. Два отдельных плана можно согласовать вместе, сохранив digest каждого. Production/helper crash не разрешает слепой rerun: inspect own private intent/DB/ledger, reconcile unknown сначала. `cleanup` отзывает только own authority и удаляет только известные own sandbox IDs, request/budget records сохраняет; ambiguous create без ID отдаётся Gateway operator по own run label.

Exit2 означает BLOCKED_BY_ENVIRONMENT, не просьбу автоматически повторить. Live receipt даже после usable SSE остаётся partial до upstream POST journal/expiry/stale/cancel/forbidden-egress evidence; DELETE ACK оставляет stop_unknown. Успешное поле отдельного seam не закрывает T012–T015. Installed OpenCode следует отдельным согласованным budget gate.

Локальная проверка runner (временные DB допускаются только на loopback replica):

```sh
PROTOTYPE_ACCEPTANCE_LOCAL_TEST=1 node --test apps/prototype-service/test/gateway-adapter-probe.test.js
node api/scripts/prototypeModelProxySmoke.js
```
