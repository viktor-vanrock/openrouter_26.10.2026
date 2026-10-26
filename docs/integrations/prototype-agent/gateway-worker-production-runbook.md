# Запуск worker прототипов в production

Этот runbook относится к **существующему direct-react-v1 baseline**: trusted worker генерирует исходник выбранной моделью владельца, Gateway выполняет отдельную изолированную сборку. Production API Model Proxy/scoped token/OpenCode/FSD — другой engine gate и здесь не считаются принятыми.

## Как найти логи конкретной генерации

При `NODE_ENV=production` worker пишет в stdout по одному JSON-событию на строку. Этот поток забирает существующий сборщик Kubernetes. Отдельный namespace и новый секрет не нужны. Production больше не создаёт растущий `service.log`; хранение и срок жизни централизованных логов задаёт инфраструктура.

В OpenSearch Discover сначала выберите время запуска генерации, затем DQL:

```text
kubernetes.pod.name: prototype-worker-*
```

Если сборщик предоставляет поле `kubernetes.container.name`, добавьте `AND kubernetes.container.name: "worker"`, чтобы исключить Vault. Добавьте имя pod и контейнера в колонки и сохраните поиск. Даже если JSON остаётся строкой `message`, полный `jobId` и события доступны для поиска по содержимому `message`. Фильтры по отдельным JSON-полям требуют, чтобы сборщик разбирал JSON; точные названия полей зависят от его настройки.

События содержат `time` (UTC), `service=prototype-worker`, `level`, `event`; события задания также содержат `jobId`, `turnId`, `commandId`, `executionId`, `attemptId`, `modelId`, `stage`, `expectedRevision`, `fenceToken` и доступные owner/conversation IDs. Полный `jobId` можно взять из ответа или URL `/api/prototypes/...` в Network браузера.

Основные события:

| События | Что показывают |
| --- | --- |
| `service.*`, `dependency.*` | Запуск, остановку, ошибку конкретной зависимости и изменение готовности |
| `heartbeat.*` | Первую ошибку связи с API и восстановление; успешные heartbeat каждые 5 секунд не засоряют журнал |
| `command.*`, `control.*` | Получение команды, отказ, подтверждение обработки, запросы регистрации/завершения этапа в API и HTTP-статус |
| `workspace.*` | Восстановление и сохранение рабочего состояния |
| `stage.*` | Начало, окончание, сохранённый результат, ошибку или прекращение этапа |
| `model.*` | Проверку модели, резерв, отправку, ответ, фактические токены/расход и проверку полученного результата |
| `gateway.*` | Создание sandbox/session, сборку, очищенные сообщения исполнителя, проверку результата и состояние удаления |

`model.start.maxOutputTokens` — разрешённый максимум ответа; `model.usage.outputTokens` — фактический расход. Для `LIVE_MODEL_REACT_INVALID` смотрите `reason`, `lineNumber`, `columnNumber`, `diagnosticCode` и `diagnostics`. Например, `tsx_syntax_error` указывает на синтаксис, `app_export_missing` — на отсутствие экспорта App, `uikit_component_not_rendered` — на отсутствие используемого UI Kit. Для отклонённого текстового ответа также доступны размер и SHA-256 (`sourceBytes`, `sourceDigest`). Исходник и промпт в журнал не выводятся.

После исправления этапа подтверждённой генерации worker также сохраняет отклонённый текстовый ответ модели (не более 200 KB) в приватный файл `turns/<turnId>/rejected-model-<commandId>.txt`, права `0600`. Событие `model.response_saved` подтверждает сохранение. Это диагностический файл текущего workspace: он не включён в разрешённый список S3 checkpoints, публичные downloads или логи. Оператор может прочитать его через `kubectl exec` контейнера `worker`; обычный пользователь API к нему доступа не получает. Если файл не удалось создать, ошибка записывается отдельно, основной результат генерации не меняется. Старые прогоны этим исправлением не восстанавливаются.

Не путайте два шлюза: `OPENROUTER_API_URL` обслуживает модель (`POST /chat/completions`), `SANDBOX_GATEWAY_URL` — изолированную сборку (`POST /sandboxes`, затем session/logs). В direct-react-v1 ошибка проверки модельного ответа на этапе `generation` возникает до создания build sandbox. `executionId` в журнале worker не является `sandboxId`. Ручка POST модели создаёт новый платный запрос, а не читает историю; endpoint получения старого ответа в текущей интеграции отсутствует.

После изменения инструкций генерации меняется `rulesDigest`. У существующего задания привязка правил/engine/template/toolchain неизменна; повтор старого задания новым worker может дать `PROTOTYPE_INVALID_STATE`. Не переписывайте generation pins вручную и не подменяйте новый digest старым. Создайте новый прототип в новом чате. Конфликт привязки до начала модели/сборки теперь записывается как `stage.failed` с `reason=generation_binding_conflict` и передаётся через обычный fenced failure в API. UI получает `failed`, прекращает индикатор и показывает пояснение. Старое зависшее выполнение получит этот результат только после обработки обновлённым worker; редактирование UI само по себе не меняет состояние задания. Ошибки stale revision и временная недоступность Mongo/API сохраняют прежнее поведение, чтобы не завершить чужое или более новое выполнение.

Секреты, заголовки авторизации, полные ответы провайдера, приватные URL и содержимое артефактов не сериализуются как поля журнала. Диагностика ограничена по размеру и очищается от известных форматов токенов/паролей/ключей. Не передавайте в лог дополнительные произвольные объекты ошибок: используется явный список допустимых полей.

При наличии доступа к кластеру:

```sh
kubectl logs -n openrouter-chat deployment/prototype-worker -c worker --since=1h --tail=500 --timestamps
```

После rollout проверьте наличие JSON-событий `service.start` и `heartbeat.available`, затем проследите один согласованный прогон по полному `jobId`. Локальные тесты логирования не доказывают доставку/разбор JSON в production OpenSearch и не закрывают приёмку генерации.

## Команда и образ

Локально `npm run prototype:dev` остаётся launcher, читает root `.env` и публикует development identity profile. Production работает без этого profile и без root `.env`:

```sh
node apps/prototype-service/src/entrypoint.js
```

Либо из checkout с уже доставленным process env:

```sh
npm start --workspace=apps/prototype-service
```

Сборка standalone service image:

```sh
docker build -f apps/prototype-service/Dockerfile --target runtime -t <worker-image> .
```

В образе только runtime service sources, versioned assets, release-lock и необходимые compiled workspace packages. API source, frontend, root `.env`, HOME/Docker socket/Kubernetes credentials не нужны. UID/GID10001; workspace `/var/lib/prototype` — private scratch/cache, durable authority в prototype Mongo + immutable OBS. npm11.17.0 закреплён на build-time из-за воспроизведённого npm11.13 lockfile/override incompatibility. `npm ci --omit=dev` сохранён, runtime install отсутствует.

Основной deployment — repository chart `helm/prototype-service` и values `envs/prod-prototype-worker.yaml`; GitLab подставляет registry digest из build artifact. StorageClass `csi-disk-topology` следует существующему Mongo chart; фактические provisioning/ACL принимаются в кластере. YAML не применялся автоматически.1 replica/Recreate, no service-account token, readonly rootfs, writable private workspace+tmp, bounded resources и SIGTERM. Worker не нуждается в публичном ingress/Service: он делает исходящие запросы к API/Gateway и читает внутренние dependencies. Kubelet probes используют container3090.

Dedicated worker Secret содержит только поля из `worker.production.example.env`: same production prototype replica URI, существующий primary URI, Redis/OBS/Gateway, service bearer и существующие CREDS_KEY/CREDS_IV для чтения owner-bound encrypted provider key. **RSA private signing key только API**, Secret API целиком worker не передавать. Базы/пользователи/ключи не клонируются. Separate replica host/DB проверяются; indexes и DB grants готовит оператор/API, worker startup не создаёт shared indexes.

## Два режима и API flags

Для первого инфраструктурного smoke передать manual job variable `WORKER_INTAKE_ENABLED=false`. Production values по последнему запросу пользователя готовы к active запуску (`true`); нажатие deploy запускает проверку dependencies и intake. Standby:

- `/healthz`200 после проверенного запуска dependencies и Gateway GET;
- `/status` показывает standby/dependencies available/storage not_probed;
- `/readyz`503: этот pod не объявляет generation capability;
- нет Redis consumer-group creation/ACK, heartbeat, S3 capability write или model POST.

Для контролируемой обычной генерации оператор включает **оба слоя**:

| Место | Настройка |
| --- | --- |
| API ConfigMap (`envs/prod.yaml` configYamlContent) | `prototypeAgent.enabled=true`; сохранить полный modelPolicy/storage/preview контракт |
| API env | `PROTOTYPE_TRANSPORT_ENABLED=true`, same `PROTOTYPE_MONGO_URI`, bearer service auth и shared Redis/OBS |
| Worker env | `PROTOTYPE_WORKER_INTAKE_ENABLED=true`, Gateway backend, HTTPS control plane origin |
| Adapter для следующего OpenCode acceptance | `PROTOTYPE_MODEL_PROXY_ENABLED=true`, API-only signing source; эта настройка сама worker intake не включает |

При active startup worker проверяет Redis noeviction/persistence и own-prefix OBS put/head/get/conditional/delete, затем готовит group и запускает heartbeat через HTTPS bearer. Fresh authenticated heartbeat + API transport readiness открывают UI capability по существующему TTL. `prototypeAgent.enabled` без transport/worker heartbeat недостаточен. Не запускать development identity header в production.

Concurrency config global2/user1. Текущий consumer исполняет stages последовательно; верхняя граница2 не является доказательством двух параллельных generations. Production direct turn cap<= $2, невалидный/повышенный cap блокирует startup. Выбранный model сохраняется; raw provider key только trusted стороне и не попадает в Gateway build sandbox.

## Ручные кнопки GitLab CI

Include `.gitlab/prototype-service.yml` добавлен в root CI. Jobs доступны в MR в main и на main, manual/optional: обычный pipeline не ждёт запуска prototype jobs.

1. Развернуть API из этой ветки обычными `build` → `deploy_GK_prod`: новые backend guards и `envs/prod.yaml` нужны **до** пользовательской генерации. `prototypeAgent.enabled=true`, transport/proxy=true, bearer, corporate upstream и direct turn cap$2 закреплены явным pod env поверх Secret. Создание прототипов доступно авторизованным пользователям при включённой функции и готовом transport. Чтение результатов и отмена сохраняют привязку к владельцу и tenant.
2. Подготовить dedicated `prototype-worker-env` Secret в `openrouter-chat` по `worker.production.example.env`. Worker и API используют **один и тот же** production prototype replica URI/logical DB. В текущем переданном URI это `openrouter_chat`; название из старого примера `chatrouter_prototypes` не является основанием менять URI. Основной chat `MONGO_URI` сохраняется. Worker нужен существующий owner credential в основной БД, CREDS_KEY/IV для его чтения, shared Redis/OBS/Gateway и service bearer; RSA остаётся только API. Secret создаёт оператор защищённым способом, содержимое не попадает в CI log/artifacts.
3. Нажать `build_prototype_worker`. Kaniko использует existing masked `kanikocfg`, target runtime и native linux/amd64 runner (проверка x86_64), публикует `${CI_REGISTRY_IMAGE}/prototype-service:${CI_COMMIT_SHA}-${CI_PIPELINE_ID}`. Artifact сохраняет только repository и sha256 digest. Требуются штатные registry права/CA; TLS verification включена. После7 дней artifact надо пересобрать.
4. Нажать `deploy_prototype_worker`. Job получает build dotenv, использует существующую runner kube identity/OC login и freeze guard. Он проверяет наличие worker Secret, создаёт/обновляет dedicated image pull Secret `prototype-worker-registry` из masked `kanikocfg` без вывода содержимого, выполняет Helm lint/upgrade --atomic --wait и rollout status. Registry auth временные файлы удаляются; application Secret не создаётся и не меняется. Release `prototype-worker`,1 pod/Recreate, retained runtime authority в Mongo/OBS.
5. Для запуска без intake в форме Run job задать `WORKER_INTAKE_ENABLED=false`; для включения снова запустить deploy с `true`. Standby pod использует `/healthz` для Kubernetes readiness, чтобы Helm мог завершиться; application `/readyz`503 и capability/heartbeat отсутствуют. Active readiness использует `/readyz` и требует dependencies/storage/heartbeat. Ошибка active startup откатывает Helm release; обычный API остаётся доступным.

HTTP endpoint для deployment не добавлялся: пользователь выбрал manual CI job. Внешний `.kaniko`/`.kube_deploy` template проверен read-only на commit `f00ebd5501ae8f4a7ed731f0312a812375e79516`; auth создавался в template **script**, поэтому replacement worker script явно готовит `/kaniko/.docker/config.json`. Worker deploy не клонирует внешний chart и не изменяет его. Template refs в общем pipeline исторически unpinned; фактическую merged CI config/runner registry push/cluster rollout ещё проверить в GitLab.

`envs/prod-prototype-adapter.example.yaml` — отдельный adapter-only overlay с transport=false. Не добавлять его поверх active config: он выключит worker admission. Это не active worker values.

## Диагностика запуска из checkout

`node apps/prototype-service/src/entrypoint.js` без process env не загружает root `.env` и завершался общей ошибкой. Точная причина воспроизведена: `PROTOTYPE_SERVICE_ROLE is required`. Теперь выводится safe config code/поле и подсказка `npm run prototype:dev`; dependency failures по-прежнему не выводят URI/credentials. Для локальной разработки использовать launcher. Production pod получает роль/backend/env из chart и dedicated Secret; одной команды без конфигурации недостаточно.

## Локально проверенная подготовка

```sh
node apps/prototype-service/scripts/gateway-production-smoke.mjs
node apps/prototype-service/scripts/gateway-production-smoke.mjs --active
```

Оба runner разрешают temporary DB только на loopback Mongo и не подключаются к production URI. Standby smoke использует реальный authenticated Gateway GET; active smoke создаёт собственные disposable Redis/MinIO и HTTPS control-plane fixture с trusted local certificate. Никакой реальный provider или generation command не отправляется. Active scope — startup/storage/heartbeat/empty queue, не whole product acceptance. Credentials env files/private test key удаляются; sanitized receipts0700/0600, own DB/container/network cleaned.

Приёмка9 октября: standalone arm64 image build PASS. Standby7 checks PASS; active10 checks PASS: nonroot, readonly runtime, ready200, HTTPS bearer heartbeat, storage capability, empty own command stream, no outbox/model calls и graceful SIGTERM. Evidence `production-worker-smoke-e36d5317cbdd4786f553c64f/receipt.json`, imageId `sha256:e26ca8bca8b31ff885e26486a1c94f93c2d1c03dc008972db5a511f0d37a2c89`. Это local image ID, не опубликованный registry digest; production amd64 image/CI/registry/pull ещё надо принять.

Active repro первоначально падал на S3 HEAD с Node24/MinIO keep-alive. Socket/request deadlines не устранили сбой; dedicated HTTP(S) agents с keepAlive=false позволили тому же packaged runner пройти. TLS verification сохранена, новые connections ограничены connection/socket timeout, SDK maxAttempts1. Safe dependency/errorType/httpStatus diagnostics не печатают URI/credentials. Производительность/OBS в production проверяются отдельно.

`DurableStageWorkspace`: source/plan/checkpoint/snapshot/output сохраняются в owner-bound immutable OBS JSON и Mongo `prototypestagecheckpoints` receipt **до** completion/ACK. CAS конфликтует с cancel/fence; restore сверяет полный owner/model/command/revision/digest/pins. Empty-cache restore exact stage и предыдущего turn проверен real local replica + fake object store; stale/foreign ownership denied. This is baseline recovery evidence; crash-after-paid-response-before-checkpoint/unknown Gateway create/session не даёт автоматического нового платного вызова и требует reconciliation. Full restart-before-edit через реальный UI/OBS и all HA/GC gates ещё не приняты.

## Проверка внутри production сети

Mac не получает доступ к cluster replica set. DevOps запускает image и acceptance runner в том же network scope, где API видит3 advertised members и DB `openrouter_chat`; same-store binding сначала проверить. Выполнить standby/startup; после явного controlled enable принять owner-bound selected model plan→approval→build→preview→edit/finalize/download, cancel/outage/restart и стоимость. Production provider/Gateway request receipts отдельны от local counters.

Для выбранной пользователем GPT Luna Latest нужен exact provider catalog ID и existing production owner key. Для OpenCode нужен отдельный agent image (`release-lock.agent` покаnull), constrained tools/egress/installed binary acceptance и target engine integration; переключение флагов этого не создаёт.

Rollback: worker intake=false, API prototypeAgent/transport=false; ordinary chat и accepted reads/cancel сохраняются. Mongo/OBS/Secrets не удалять. SIGTERM прекращает heartbeat/обрывает active fetch/stages, освобождает own connections. Durable unknown reservation и cleanup debt сохраняются; DELETE ACK не является доказательством остановки всего cgroup.



## Приёмка и основные документы

Фактические результаты container/authority/image probes и оставшиеся gates — [checklist](gateway-migration-tasks.md). Gateway agent non-root/egress и Storybook routing — [отчёт для команды Gateway](gateway-agent-isolation-report-2026-10-09.md). Эти исторические проверки не означают, что GitLab rollout или полный production UI уже приняты.

[PDF-инструкция](deployment-guide/prototype-service-deployment-guide-2026-10-12.pdf) и её [HTML со схемами](deployment-guide/guide.html) описывают архитектуру, пользователя, deployment и секреты простым языком. Service-local `.env` отсутствует: dev читает root `.env`, production получает Secret. Generated runtime profile — development config, private production-identity file — input acceptance runner. Исторические непустые CREDS/JWT значения в tracked API YAML требуют coordinated переноса в protected source без произвольной смены шифрования; очистка документации не меняет действующие encryption keys/Secret delivery.
