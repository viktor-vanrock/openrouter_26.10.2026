# Prototype execution contracts v2

Canonical parser: `packages/prototype-worker/src/contracts.v2.ts`.

Every command/event binds `jobId / turnId / expectedRevision / attemptId / executionId / stage / fenceToken`. Commands also carry the user/tenant scope used by quota enforcement; events additionally carry `leaseId`. Redis is transport only; Mongo acceptance must compare the entire tuple.

Execution credentials bind the same tuple plus `commandId`, `leaseId`, tenant, user and fixed model. Token refresh accepts the tuple only from an authenticated service identity, then derives authorization claims from matching Mongo job state and structured Redis lease data; caller-supplied model/user/tenant values are never accepted.

## Linearization

- Command acceptance linearizes in one Mongo transaction that persists the user turn, advances revision/fence, records active identities, and inserts the matching outbox command.
- Artifact publication linearizes at a Mongo CAS guarded by the entire identity tuple plus exact checkpoint/artifact digests. S3 upload or Redis delivery alone does not make an artifact current.
- Cancellation linearizes when Mongo advances the fence and records cancel/canceled state. Delayed pod deletion cannot re-enable stale publication.
- Worker event idempotency linearizes through a digest-bound Mongo receipt committed in the same transaction as the event effect. Redis ACK happens only after that transaction succeeds.

## V1 drain and rollback

V1 and v2 have separate stream names. Deploy v2-capable readers first, switch the producer, drain/reconcile all v1 pending entries, then disable v1 admission. The adapter receives attempt, fence, stage, digest, budget and deadline only from trusted Mongo/config state; it rejects v1 attachments. Rollback stops new admission and drains/cancels accepted executions, never returning to host execution.

## Budget and artifacts

Token/cost limits are explicit; nullable usage means unknown, not unlimited. Review/completed events require digest-bound checkpoint and artifact references. Credentials, authorization headers, object keys, workspace paths and provider bodies are excluded from worker events.

Repair metadata is bounded and checkpoint-backed, and follows the complete repair pipeline rather
than only its first generation command. Transfer and build/QA commands retain the same repair ordinal
and trusted diagnostics while receiving new command/execution identities and fenced revisions.

## Internal service completion boundary

The isolated service reports results through authenticated typed endpoints under
`/api/internal/prototype-control/v2`: lease registration, stage completion, generation waiting,
stage failure, and immutable publication. Each request carries the full command identity tuple;
the API derives a deterministic event ID and publishes only a schema-valid v2 event. The waiting
request is restricted to generation step `0`, `clarification | plan_approval`, a bounded safe prompt,
and a digest-bound checkpoint. A retry of the same execution outcome produces the same event ID.

The API mounts these endpoints only with the isolated transport feature. Completion fails closed
until Redis readiness/durability checks bind the publisher, and that binding is revoked during
shutdown. `PROTOTYPE_TEST_WORKER_IDENTITY` is a non-production integration seam only and is ignored
when `NODE_ENV=production`. The first production release uses HTTPS with a dedicated service bearer
token; native private mTLS is an optional separately configured deployment. Both modes authenticate
the trusted service and still require the live owner/execution tuple. A service token never replaces
the short scoped model token.

## Phase 4 chat projection

The public snapshot is conversation-bound and contains `jobId`, `turnId`, `revision`, durable
`cursor`, status/phase/waiting prompt identity, safe activity/failure, turn model, accepted version
digests and server-derived actions. Browser metadata is never authority: every snapshot, action,
event stream and artifact read repeats owner, tenant and original conversation binding checks.

Job-ID mutations carry the original conversation in `X-Prototype-Conversation-Id`; job and artifact
GETs carry it as a mandatory `conversationId` query parameter so iframe/download navigation can bind
without custom headers. The server compares that value with the stored job and never treats it as
authority by itself.

An ordinary-chat Prototype submit uses a mandatory `Idempotency-Key`. The user message, job/turn
CAS, durable public event and outbox command commit in one Mongo transaction. Worker event receipt,
job effect, assistant message projection and public event also commit together. Public SSE event IDs
are per-job monotonic `eventSequence` values; `Last-Event-ID` resumes with the first greater ID.

Accepted HTML/source downloads return bytes, safe `Content-Disposition`, `nosniff`, and a verified
digest header. A historical accepted version is selected only by its public revision and digest;
object keys and storage credentials are never part of the public contract.

Preview uses the authorized `GET /api/prototypes/:jobId/html` byte stream directly inside an iframe
without `allow-same-origin`. There is no public `html-ticket` JSON contract: the dormant ticket
declaration was removed because it had no single-use exchange implementation.

Clarification/review replies are message-identity operations. The browser persists the chat message
through the ordinary message API, then sends only its `messageId`, the expected Prototype prompt ID,
`Idempotency-Key`, and `X-Prototype-Revision` to `/replies`. The service re-reads the message from
Mongo in the state transaction and repeats user, tenant, and conversation binding checks.

## Requirements from documents

Prototype mode reuses the existing **Upload as Text** processing. Initial submits and edits after
completion accept optional `fileIds` (at most 10, each at most 128 characters). Clarification/review
replies retain the existing identity-only contract: file IDs come from the saved message's `files`.
The user still supplies a nonempty message, for example “Create a prototype using the attached specification”.

The server resolves files in the primary file store by user and tenant, enforces any existing
conversation binding, and requires `source: text` with nonempty extracted text. Unbound uploads
from a new chat and legacy uploads without a tenant in the default tenant are accepted. Expired,
pending, failed, missing, inaccessible and other attachment types return HTTP 422
`PROTOTYPE_ATTACHMENT_INVALID`; clients preserve the draft and attachments.

The accepted `PrototypeTurn.text` contains the message and the complete extracted document text,
labelled with filenames. The combined limit is 50000 characters including separators. Exceeding
it returns HTTP 422 `PROTOTYPE_REQUIREMENTS_TOO_LARGE`, without truncating documents. After acceptance,
planning, generation, repair, retries and later edits use this persisted text, without rereading files.
Duplicate delivery returns the accepted command before resolving files again. Chat messages retain
the short user text and file references; model requirements use the full server-derived snapshot.

Execution v2 stays text-only: `attachmentManifest` remains empty and the Gateway receives no file
URLs, storage keys or credentials. Supported document formats depend on the configured existing
text/document parser; this change adds no OCR service or prototype import/export.

## Content safety

Prototype submits, saved clarification/review replies and model tool specifications use the same
configured moderation provider as ordinary chat (`OPENAI_MODERATION`, its API key and optional reverse
proxy). The input includes server-resolved document text; a neutral message cannot hide rejected
requirements inside a file. A flagged request returns HTTP 422 `PROTOTYPE_CONTENT_BLOCKED`; provider
failure or an invalid moderation response returns HTTP 503 `PROTOTYPE_MODERATION_UNAVAILABLE`.
Neither outcome creates a turn or dispatches generation. The client retains its draft and files.

The direct React execution path also requires a semantic content decision before planning, coding,
repair or restoring a generation result, including approve/retry/resume of historical jobs. This check
is always active, even when the optional chat moderation provider is disabled. It uses the selected
model and the existing owner credential, with a maximum 512 output tokens and a separate `moderation`
reservation inside the existing turn budget. Full persisted requirements, including document snapshots
and prior edits, are checked together. Unchanged requirements reuse an owner/job/model/policy/digest-bound
decision from durable storage, including after a restart. Unknown paid outcomes are not retried
automatically; an explicit retry is a new bounded attempt.

Rejected or indeterminate checks stop before planning/code/build and produce the existing fenced
`PROTOTYPE_EXECUTION_FAILED` event with a safe user message. The previous accepted preview/downloads
remain available. Provider refusal and `content_filter` results are terminal safety failures, never
code/plan parse errors eligible for repair. No new browser-supplied approval or bypass flag is accepted.
Neutral medical, educational, scientific and support contexts are explicitly allowed by the policy;
classification quality still requires evaluation with the deployed selected model.

## Design selection and completion

Every initial prototype has two designs A/B, also described in the visible approved plan.
During review, `/replies` optionally accepts `selectedVariant: A | B` with the saved message ID.
The owner/revision/prompt-bound transaction records this choice once while starting the edit.
A second choice is rejected, including direct API calls. The choice persists across edits and restarts;
the generator and repair stage retain only the chosen design. Selection does not complete the job.

Snapshots expose nullable optional `selectedVariant`; accepted versions record the applied choice.
The separate `/finalize` action is allowed only in review after an accepted version matches that choice.
Completion preserves the accepted artifacts, creates a Russian completion message and dispatches no model request.
Historical completed jobs recover an older explicit A/B finalization reply when starting their next edit.

Metrics include measured active time of the current turn, excluding user waiting/review intervals.
Approximate time is derived from completed turns of this owner and model; with no samples it is unknown.
Token accounting remains internal and is not displayed in the prototype card.

### Доступ к генерации

Создание прототипов доступно авторизованным пользователям независимо от email. Доступность определяется включением `prototypeAgent.enabled` и готовностью сервиса. Проверки владельца, tenant, выбранной модели и состояния задания сохраняются.

Отключение функции блокирует submit, replies и действия генерации как на BFF, так и при прямом вызове сервиса/model tool. Ответ BFF — `503 PROTOTYPE_SERVICE_UNAVAILABLE`. Чтение принятых результатов и отмена остаются доступны владельцу. Загрузка tools скрывает отключённый инструмент; выполнение ранее загруженного инструмента повторно проверяет флаг, а production-сервис также проверяет свежую доступность worker перед записью задания.

SSE сохраняет курсор последнего доставленного события. На пустых ответах интервал опроса увеличивается с 1 до 2, 4 и максимум 5 секунд; доставка события возвращает интервал к 1 секунде. Keepalive идёт каждые 15 секунд. В простое новая версия может появиться с задержкой до 5 секунд; закрытие соединения останавливает опрос и keepalive.
