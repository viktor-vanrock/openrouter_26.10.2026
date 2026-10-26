# Gateway: нарушения требуемой изоляции agent sandbox

**Кому:** команде Gateway / владельцу sandbox runtime и сетевой политики.
**Дата проверок изоляции:** 9 октября 2026 года, 17:28–17:40 МСК (14:28–14:40 UTC).
**История подключения Storybook MCP:** 8 октября 2026 года, по сохранённым receipts; при подготовке документа повторный сетевой прогон не выполнялся.
**Проверенная среда:** Gateway API 1, версия `v0.7.9`, `https://fleet-sandbox-gw.sberai-rnd.ru`.
**Статус:** блокер приёмки agent profile для сервиса прототипов ChatRouter.

В реальных Gateway sandbox обнаружены два расхождения с требуемым профилем агента:

1. Процесс, запущенный через sessions API, получает **UID 0**, хотя в Dockerfile образа указан `USER 10001:10001`.
2. Sandbox достигает **прямого provider origin и постороннего сайта**, хотя для этого agent profile должен быть разрешён только HTTPS-доступ к ChatRouter Model Proxy и необходимый DNS.

Дополнительно ниже описан отдельный blocker подключения к корпоративному Storybook MCP: из Gateway внешний маршрут возвращал HTTP307 на тот же URL, хотя локальный внутренний маршрут работал. Это проблема доступности/маршрутизации; её не следует автоматически считать доказанным нарушением security boundary Gateway.

Это отчёт о наблюдаемом поведении конкретной среды и требованиях нашей интеграции. Исходники Gateway и фактические Pod/CNI security settings не исследовались, поэтому точную причину на стороне платформы должен установить её владелец. Распространение поведения на другие команды, профили и версии Gateway не проверялось.

## Контекст и ожидаемая граница

Внутри sandbox запускается OpenCode для работы с исходниками прототипа. Для этой интеграции агент должен выполнять модельные запросы через:

```text
https://orchat.sberai-rnd.ru/api/prototype-model/v1
```

Model Proxy связывает запрос с владельцем, выбранной моделью и активной execution tuple; проверяет короткий scoped-токен, отзыв authority, бюджет и журнал запросов. Provider credential остаётся на стороне ChatRouter API.

Sandbox получает только краткоживущий scoped model token. Provider API key, service bearer, RSA signing key, Gateway token, Mongo URI и storage credentials в sandbox не передаются. Для сетевых проверок в этом отчёте даже scoped-токен не использовался.

Требуемая граница:

```text
Agent sandbox → ChatRouter Model Proxy → provider
```

Прямой маршрут sandbox → provider и доступ к произвольным внешним сайтам для данного профиля должны быть запрещены. Агентский процесс должен работать под непривилегированным UID/GID. Образ для изолированной сборки имеет отдельный offline-профиль; его сетевые требования нельзя объединять с agent profile.

## 1. Sessions API запускает процесс под root вопреки USER образа

### Наблюдение

Первый образ содержит:

```dockerfile
USER 10001:10001
```

Он был собран через Gateway, опубликован по digest и запущен в настоящем sandbox. Через `POST /sandboxes/{id}/sessions` выполнен прямой запуск диагностической программы:

```json
{
  "argv": ["node", "/opt/prototype/agent/runtime-probe.mjs"],
  "cwd": "/work"
}
```

Программа записала результат `process.getuid()`:

```json
{
  "uid": 0,
  "nodeVersion": "v24.16.0",
  "binaryVersion": "1.18.16"
}
```

Клиент не передавал параметр запуска от root. В проверенной OpenAPI-схеме создания sandbox и session поля выбора UID/GID отсутствуют. Требование `USER` в образе оказалось недостаточным для обеспечения non-root выполнения session-процесса.

### Риск и предел доказательства

При обычном прямом запуске agent-процесс получает права root **внутри sandbox**. Это расширяет доступ к доступным этому процессу файлам и операциям по сравнению с требуемым UID 10001. Конкретные последствия зависят от user namespaces, capabilities, mounts и runtime sandbox — их конфигурация в этой проверке не установлена.

**Выход на Kubernetes node, обход gVisor, чтение host filesystem, доступ к другой команде и эксплуатация kernel vulnerability не проверялись и не заявляются.** UID 0 в sandbox сам по себе не доказывает host root или sandbox escape.

### Проверенная временная мера на стороне клиента

Добавлен фиксированный trusted launcher, который до запуска agent-кода выполняет:

```js
process.setgroups([]);
process.setgid(10001);
process.setuid(10001);
```

Launcher проверяет итоговый UID/GID, ограничивает варианты запуска и очищает окружение. В новом baked image повторный remote probe показал **UID 10001**. На исходном образе отдельный контрольный запуск с явным переключением пользователя также дал UID 10001.

Это подтверждённая клиентская мера для наших контролируемых запусков. Она не меняет поведение Gateway sessions API и не гарантирует, что другой прямой session-запуск не получит UID 0.

### Что требуется от Gateway

Уточнить и зафиксировать контракт пользователя session-процесса: должен ли он наследовать `USER` образа либо получать UID/GID из отдельного platform profile. Для agent profile требуется обеспечить непривилегированный запуск на стороне Gateway/runtime, без зависимости от клиентского launcher. Если служебный sandbox daemon должен работать с другими правами, отделить его identity от identity выполняемого agent-процесса.

## 2. Сетевой профиль допускает прямой provider и посторонний интернет

### Наблюдение

Из одной и той же диагностической программы внутри Gateway sandbox выполнены три HTTPS GET без `Authorization`. Проверка сертификатов была включена; автоматические redirects запрещены, время запроса ограничено восемью секундами.

| URL | Фактический результат | Требование для agent profile |
| --- | --- | --- |
| `https://orchat.sberai-rnd.ru/api/prototype-model/v1/models` | **HTTP 401** | Маршрут должен быть доступен; без scoped-токена 401 ожидаем |
| `https://or.crbrcloud.ru/api/v1/models` | **HTTP 401** | Прямой provider origin должен быть недоступен по сети |
| `https://example.com/` | **HTTP 200** | Посторонний внешний origin должен быть недоступен по сети |

Сначала эти результаты получены при UID 0. Затем они **повторились при UID 10001**, включая финальный образ с trusted launcher. Переключение пользователя не устраняет сетевой дефект.

Фрагмент фактического финального receipt:

```json
{
  "uid": 10001,
  "network": {
    "modelProxy": { "reachable": true, "status": 401 },
    "providerUpstream": { "reachable": true, "status": 401 },
    "unrelatedPublic": { "reachable": true, "status": 200 }
  },
  "egressIsolation": "FAIL: forbidden destination reachable"
}
```

**401 от provider — это не сетевой запрет.** Соединение достигло HTTP-сервера, который отказал на уровне авторизации. Provider authentication в этой проверке не обходилась.

### Риск и предел доказательства

Для проверенного sandbox отсутствует требуемая граница «исходящий трафик только к Model Proxy». Посторонний внешний сайт достижим. Если недоверенный код получает возможность выполнить сетевой запрос, это создаёт потенциальный канал отправки данных за пределы разрешённого сервиса.

Прямой provider origin также достижим. Если provider credential когда-либо окажется доступен такому коду, сетевой слой не остановит попытку обращения в обход task-scoped Model Proxy и его бюджета/журнала. **Credential в sandbox не передавался; успешный оплачиваемый запрос в обход Proxy не выполнялся и не доказан.**

Наблюдения относятся к двум конкретным запрещённым для нашего профиля origins. Они не являются сканированием интернета или доказательством доступности всех внешних и внутренних ресурсов. Доступ к Mongo, Redis, OBS, metadata endpoints и соседним workloads здесь не проверялся.

### Почему запретов инструментов OpenCode недостаточно

Actual installed OpenCode 1.18.16 прошёл synthetic-provider проверки: hostile project config не включил bash, webfetch, внешнее чтение, плагины или MCP. Запрещённые действия не создали markers и не раскрыли synthetic canary.

При этом доверенная диагностическая Node.js программа из той же среды достигла запрещённых origins. Эти запросы выполнялись диагностической программой, **не моделью и не инструментом OpenCode**. Они доказывают сетевую достижимость процесса в sandbox, но не доказанный обход permissions самим OpenCode.

Tool permissions защищают определённый agent runtime. Сетевой профиль должен независимо ограничивать процесс в sandbox, включая исполнение сгенерированного кода или дефект в runtime. Успешная проверка tool permissions не заменяет network isolation.

### Что требуется от Gateway

Предоставить отдельный agent profile с **default-deny egress** и явными разрешениями:

- DNS только к утверждённым resolver endpoints.
- HTTPS/TCP 443 к `orchat.sberai-rnd.ru` для Model Proxy.
- Запрет прямого provider origin, постороннего public Internet и внутренних сервисов, не включённых в profile.

На уровне trusted application transport дополнительно сохраняется allowlist путей `/api/prototype-model/v1/models` и `/api/prototype-model/v1/chat/completions`, проверка TLS и запрет redirects.

Обычная Kubernetes NetworkPolicy не фильтрует HTTPS URL path и сама не предоставляет FQDN allowlist. Если ingress IP общий или меняется, нужен подходящий механизм CNI/FQDN либо approved egress proxy с ограничением destinations. При использовании proxy прямые обходные соединения также должны быть запрещены. Конкретный механизм выбирает владелец платформы.

В проверенной Gateway API1 OpenAPI-схеме `SandboxSpec` есть `image`, resources, `env`, compose, name и labels, но **нет network/egress profile или securityContext**. Это ограничение публичного клиентского интерфейса; оно не доказывает отсутствия административных механизмов на платформе. Нужен документированный способ получить требуемый профиль: через разрешённый API, привязку команды или иной управляемый механизм Gateway. Клиентские labels нельзя считать гарантией применения Pod network policy без подтверждённого контракта.

## 3. Storybook MCP: корпоративный endpoint не прошёл handshake из Gateway

### Какой сервер и когда проверялся

8 октября 2026 года проверялся новый корпоративный endpoint:

```text
https://storybook.sberdevices.ru/mcp
```

Это историческая проверка8 октября. Версия Gateway для этих двух Storybook probes по сохранённым результатам отдельно не установлена; `v0.7.9` в шапке относится к проверке изоляции9 октября.

Endpoint должен предоставлять документацию UI Kit через MCP: `initialize` → `notifications/initialized` → `tools/list` → `tools/call` для чтения документации. Модельные запросы для этой диагностики не нужны.

### Фактическое различие локального и Gateway маршрута

| Проверка8 октября | Локальный Mac | Настоящий Gateway sandbox |
| --- | --- | --- |
| DNS для `storybook.sberdevices.ru` | `172.20.10.90` | `95.181.177.49` |
| MCP POST `initialize` с bearer | PASS, HTTP200 | **FAIL, HTTP307**, server `nginx` |
| GET `/mcp` без bearer | В этом сравнении не зафиксирован | **HTTP307** |
| Redirect Location | Не требовался для successful handshake | `https://storybook.sberdevices.ru/mcp` |
| Redirect на тот же полный URL | Не наблюдался в successful local probe | **Да**, query отсутствует |
| `tools/list` и чтение документации | PASS:5 tools,1616 bytes | Не достигнуты: ошибка на `initialize` |

Сохранённый Gateway результат:

```json
{
  "addresses": [{ "address": "95.181.177.49", "family": 4 }],
  "unauthenticated": {
    "status": 307,
    "location": "https://storybook.sberdevices.ru/mcp"
  },
  "code": "STORYBOOK_MCP_HTTP_307",
  "phase": "initialize",
  "redirectLocation": "https://storybook.sberdevices.ru/mcp",
  "sameTarget": true,
  "queryKeys": [],
  "server": "nginx"
}
```

Этот HTTP-ответ показывает, что внешний маршрут достиг nginx. Это **не доказательство блокировки egress firewall**: соединение уже дошло до HTTP-сервера. Отказ произошёл до завершения MCP handshake. Автоматически следовать redirect клиенту не разрешалось; сервер указывает тот же URL, что при следовании может приводить к повторному redirect. Сам бесконечный цикл не выполнялся.

Разные DNS-ответы объясняют, почему успешное подключение с Mac не доказывает работу из Gateway. Redirect без bearer также показывает, что одной смены токена недостаточно для устранения наблюдаемой ошибки. Точная причина — nginx routing, TLS termination, forwarded scheme/headers либо другая настройка внешнего ingress — пока не установлена.

### Что это блокирует и что уже удалось проверить

Из Gateway не удалось получить MCP session и прочитать UI Kit документацию **на новом корпоративном endpoint**. Поэтому его нельзя считать принятым источником документации для agent runtime. Это отдельный availability blocker, который относится совместно к владельцам Storybook/public ingress и Gateway routing/DNS; принадлежность ошибки к реализации Gateway не доказана.

Позднее8 октября по решению пользователя временно вернулись к прежнему серверу:

```text
https://storybook.ekim-evgeny.ru/mcp
```

Повторный **реальный Gateway** probe старого endpoint прошёл: `initialize`, `tools/list`, `tools/call:list-all-documentation`, protocol `2025-03-26`,5 tools,1876 bytes документации. Bearer нового корпоративного сервера на старый origin **не отправлялся**.

Таким образом, утверждение «никакой Storybook MCP из Gateway не работает» неверно. Установлен конкретный отказ нового корпоративного ingress, а старый endpoint прошёл протокольный smoke8 октября. Проверка не подтверждает нынешнее состояние endpoints9 октября или позже: новых запросов для дополнения этого документа не было. Регистрация согласованного Storybook MCP и реальные обращения tools из installed OpenCode в новом agent profile также ещё не приняты.

Доступность отдельного Storybook MCP namespace в клиенте Codex — другой вопрос: наличие конфигурации или отсутствие инструмента в текущем клиентском профиле не доказывает сетевой отказ Gateway. Этот раздел опирается на HTTP/MCP receipts настоящего sandbox.

### Что требуется от владельцев Storybook и Gateway

1. Владелец Storybook/public ingress проверяет маршрут `95.181.177.49` для HTTPS `/mcp`: TLS termination, scheme/forwarded headers и nginx redirect/routing. Ожидается MCP response на POST `initialize`, без redirect на тот же URL; сохранить точную причину и исправление.
2. Владелец Gateway подтверждает используемые DNS-ответы и согласованный путь до Storybook. При необходимости предоставляет approved routing/DNS, не подменяя TLS-проверку, не добавляя public tunnel и не отправляя Storybook credential на другой origin.
3. Для минимального model-only agent smoke разрешён только Model Proxy. Если для product agent включается согласованный read-only Storybook MCP, это **отдельное явное исключение** в default-deny profile: только выбранный Storybook origin и необходимые MCP requests. Все остальные MCP/destinations остаются запрещены. Старый и новый origins не разрешаются одновременно по умолчанию.
4. После исправления из того же agent sandbox повторить authenticated `initialize`/`tools/list`/read-documentation. Затем отдельно принять регистрацию MCP и read tools в installed OpenCode. Сетевой/протокольный probe не заменяет runtime tool acceptance.

Evidence для корреляции:

| Проверка | Начало прогона, МСК | Sandbox ID | Session ID |
| --- | --- | --- | --- |
| Корпоративный Storybook: public/private DNS и nginx307 | 08.10.2026 17:19:51 | `33bb35b61d87b1c7` | `3f23ba2da9d06049` |
| Контроль старого Storybook: Gateway MCP PASS | 08.10.2026 18:16:44 | `97deba8f05cc217d` | `1368b2aa4c946c7f` |

Оба probes использовали image:

```text
swr.ru-moscow-1.hc.sbercloud.ru/sber_devices/rndml/devops/k8s-sandbox-gw/sandbox-images@sha256:7682cf09f6e126ae624c231e159379ec546c0ecaa60e5e368db5fd36feb4fdb5
```

JSON результаты сохранены в `.prototype-dev/storybook-gateway-probe-network-final.log` и `.prototype-dev/storybook-legacy-gateway-recheck.log`. Исходные run IDs в этих результатах: `storybook-gateway-1791469191208` и `storybook-gateway-1791472604666`; отдельные каталоги первоначальных receipts сейчас отсутствуют, поэтому этот раздел сверялся с сохранившимися log-файлами. В передаваемый документ не включены значения токенов. Provider requests0; для обоих собственных sandbox записан DELETE acknowledgement, whole cgroup stop не доказан.

Критерий закрытия Storybook blocker: новый согласованный endpoint успешно завершает authenticated MCP handshake и read-documentation **из Gateway**, без self-redirect, с сохранённой проверкой TLS, правильным origin для credential и документированным ограниченным egress profile. Если временно остаётся legacy endpoint, зафиксировать это явно; его успех не закрывает ошибку нового корпоративного ingress.

## Evidence для корреляции с Gateway logs

| Проверка | Начало прогона, МСК | Sandbox ID | Session ID |
| --- | --- | --- | --- |
| Прямой запуск: UID 0, provider/public reachable | 09.10.2026 17:28:47 | `5f9f571b01fefbf6` | `fc6fa9f6f4135213` |
| Контроль на исходном образе: явный UID 10001, egress по-прежнему открыт | 09.10.2026 17:31:25 | `e47ddfbebf4ca0a0` | runtime: `4c0bb28d8ab77ae9`; hostile config: `c085db7dcb565fd8` |
| Финальный trusted launcher: UID 10001, permissions PASS, egress FAIL | 09.10.2026 17:37:16 | `15d18dd87291f41e` | runtime: `d2811be6881b8ac3`; hostile config: `9e9a1d85b362dc1e` |

Исходный image:

```text
swr.ru-moscow-1.hc.sbercloud.ru/sber_devices/rndml/devops/k8s-sandbox-gw/sandbox-images@sha256:86eb1d76b4ee0eab61570ff85177d7d38cd9abe16b0dcf3acf76221eb44c8b4c
```

Финальный image с launcher:

```text
swr.ru-moscow-1.hc.sbercloud.ru/sber_devices/rndml/devops/k8s-sandbox-gw/sandbox-images@sha256:b048d1db00fc1d45753e7fe4483e0e5dc8cfcd7bb7975d140207fdfa2c14cb2b
```

Версии: Node.js `v24.16.0`, OpenCode `1.18.16`. SHA256 установленного OpenCode binary:

```text
bad9b279fb1e76e74c9d867339f25faf506ab2ecf777f14265787048a76a7bda
```

Сырые receipts сохранены у интегратора. Основные источники в репозитории ChatRouter:

- `apps/prototype-service/src/gateway-agent-runtime-probe.mjs` — фактическая диагностика UID/config/HTTPS reachability.
- `apps/prototype-service/src/gateway-agent-launch.mjs` — временный клиентский launcher.
- `apps/prototype-service/scripts/gateway-agent-image.mjs` — сборка и выполнение probes через Gateway.
- `packages/prototype-worker/scripts/opencode-hostile-config.mjs` — synthetic-provider проверки installed binary; для Gateway заменялся только путь binary.

Финальный receipt: `.prototype-dev/gateway-agent-image-1791556636683/receipt.json`; исходный root receipt: `.prototype-dev/gateway-agent-image-1791556127606/receipt.json`. Это локальные сохранённые evidence, а не доступные команде Gateway внешние ссылки. Выше приведены необходимые результаты и идентификаторы, чтобы документ можно было отправить отдельно.

## Как повторить и принять исправление

Следующая процедура основана на выполненных probes; повтор после исправления платформы ещё не проводился. Запускать её только в согласованном собственном sandbox, не добавляя реальные credentials.

1. Взять исходный image по digest с `USER 10001:10001`. Создать sandbox и через sessions API запустить `node /opt/prototype/agent/runtime-probe.mjs` **напрямую**, без client-side `su`/setuid launcher. Проверить фактический UID процесса.
2. Для проверки client mitigation отдельно использовать финальный image и `node /opt/prototype/agent/launch.mjs runtime-probe`.
3. Проверить те же три HTTPS GET без авторизации. HTTP 401 от Model Proxy — положительная проверка маршрута. Provider/public HTTP-ответ — отрицательный результат изоляции, независимо от их статуса.
4. Подтвердить применение network policy по фактической workload identity/Pod labels и предоставить deny evidence из CNI/firewall/proxy. Один timeout или DNS failure не доказывает, что нужный запрет стабильно обеспечен policy.
5. Проверить заново installed OpenCode permissions и затем, отдельным согласованным этапом, scoped discovery с активным токеном и модельный smoke.
6. Завершить только собственные sessions/sandbox и зафиксировать cleanup.

Критерии закрытия:

| Требование | Критерий |
| --- | --- |
| Non-root identity на стороне Gateway | Прямой session-запуск в agent profile работает под утверждённым non-root UID/GID без клиентского privilege-drop workaround; identity и capabilities документированы |
| Разрешённый маршрут | Model Proxy доступен по HTTPS с проверкой сертификата; без токена 401, с активным scoped-токеном discovery200 |
| Запрещённые маршруты | Прямой provider, посторонний public origin и остальные запрещённые profile destinations блокируются; предоставлено policy-denial evidence |
| Отсутствие обхода через proxy | Если используется egress proxy, прямой outbound запрещён; redirects и другие destinations не расширяют разрешённый маршрут |
| Управляемый контракт | У интегратора есть документированный способ выбрать/получить agent profile и проверить, что он применён |
| Независимость профилей | Сборочный offline profile и agent profile принимаются отдельно |

## Cleanup и текущий статус интеграции

Все собственные sandbox проверки получили DELETE acknowledgement. На контрольном чтении 09.10.2026 в 17:39:57 МСК GET вернул 404 для созданных sandbox. Это подтверждает отсутствие доступной API-записи, **но не является доказательством остановки всех процессов/cgroup**. Если Gateway предоставляет отдельное подтверждение завершения workload, просим указать его.

В image/probe стадии production DB writes — **0**, платных provider model POST — **0**. Реальные secrets в image context и sandbox не передавались. Обычный ChatRouter API после проверок отвечал200. Ранее принятая выдача scoped-токена production API не является подтверждением сетевой изоляции Gateway.

Кандидат agent image сохранён с `accepted:false`; активный `release-lock.agent` остаётся `null`, `productionApproved:false`. Включение этого agent profile для production генерации отложено до принятия identity/network требований. Мы не утверждаем CVE, host escape, межкомандный доступ, утечку данных или несанкционированную оплату: установлены root identity session-процесса и достижимость двух запрещённых для нашего профиля destinations.

**Запрос к команде Gateway:** подтвердить контракт session UID/GID, предоставить/настроить изолированный agent egress profile и совместно с владельцем Storybook проверить внешний DNS/ingress маршрут корпоративного MCP. После этого повторить указанные положительные и отрицательные проверки и зафиксировать platform evidence.
