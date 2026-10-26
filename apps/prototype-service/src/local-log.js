import fs from 'node:fs';
import path from 'node:path';
import { safeDiagnostics } from './pipeline-diagnostics.js';
import { logEntry } from './service-log.js';

const stages = {
  generation: 'Создание прототипа',
  transfer: 'Подготовка проекта',
  dependency_preparation: 'Подготовка окружения',
  build_qa: 'Проверка готовности',
  publish: 'Публикация',
};
const events = {
  'service.start': 'Сервис запускается',
  'service.error': 'Ошибка сервиса',
  'stage.start': 'Начало',
  'stage.finished': 'Готово',
  'stage.cached': 'Готовый результат восстановлен',
  'stage.failed': 'Ошибка',
  'model.start': 'Запрос к модели',
  'model.finished': 'Ответ модели получен',
  'model.usage': 'Использование модели',
  'model.estimate_unavailable': 'Оценка стоимости недоступна',
  'source.repaired': 'Исходники исправлены',
  'build.verified': 'Прототип готов к просмотру',
  'gateway.created': 'Исполнитель проверки создан',
  'gateway.state': 'Ожидаем готовности исполнителя',
  'gateway.log': 'Проверка выполняется',
};
const errors = {
  LIVE_MODEL_PLAN_INVALID: 'Не удалось прочитать план модели',
  LIVE_MODEL_TIMEOUT: 'Истекло время ожидания ответа модели',
  LIVE_MODEL_UPSTREAM_UNAVAILABLE: 'Модель временно недоступна',
  LIVE_MODEL_BUDGET_EXCEEDED: 'Достигнут лимит расходов на запрос',
  LIVE_MODEL_BUDGET_ALREADY_RESERVED: 'Этот запрос уже отправлялся',
  LIVE_MODEL_PROVIDER_FUNDS_REQUIRED: 'Провайдер сообщает о недостатке средств',
  LIVE_MODEL_RATE_LIMITED: 'Провайдер временно ограничил запросы',
  LIVE_MODEL_OUTPUT_LIMIT: 'Модель достигла лимита ответа',
  SOURCE_STATIC_REPAIR: 'Подготовлены исходники для повторной проверки',
  SOURCE_MODEL_REPAIR: 'Модель исправила исходники после проверки',
  PROTOTYPE_QA_INFRASTRUCTURE_FAILED: 'Исполнитель проверки интерфейса недоступен',
};
const usd = (value) => `$${value.toFixed(4)}`;

/** Development terminal output; production uses serviceLogger's JSON stdout. */
export function localLogger(directory, terminal = console) {
  const filename = path.join(directory, 'service.log');
  return (event, fields = {}) => {
    const entry = logEntry(event, fields);
    const {
      jobId,
      stage,
      elapsedMs,
      code,
      upperCostUsd,
      actualCostUsd,
      inputTokens,
      outputTokens,
      maxOutputTokens,
    } = entry;
    const line = JSON.stringify(entry);
    const time = new Date(entry.time).toLocaleTimeString('ru-RU', { hour12: false });
    const symbol =
      event.endsWith('failed') || event.endsWith('error')
        ? '✗'
        : event.endsWith('finished') || event === 'build.verified'
          ? '✓'
          : '→';
    const subject =
      code === 'MODERATION'
        ? 'Проверка содержания'
        : code === 'PLAN'
          ? 'План'
          : code === 'CODE'
            ? 'Прототип'
            : (stages[stage] ?? '');
    const details = [];
    if (Number.isFinite(elapsedMs)) details.push(`${(elapsedMs / 1000).toFixed(1)} с`);
    if (Number.isFinite(upperCostUsd)) details.push(`резерв до ${usd(upperCostUsd)}`);
    if (Number.isFinite(actualCostUsd)) details.push(`стоимость ${usd(actualCostUsd)}`);
    if (Number.isSafeInteger(inputTokens))
      details.push(`вход ${inputTokens.toLocaleString('ru-RU')} токенов`);
    if (Number.isSafeInteger(outputTokens))
      details.push(`ответ ${outputTokens.toLocaleString('ru-RU')} токенов`);
    if (Number.isSafeInteger(maxOutputTokens))
      details.push(`лимит ответа ${maxOutputTokens.toLocaleString('ru-RU')} токенов`);
    if (code && !['MODERATION', 'PLAN', 'CODE', 'UIKIT_BUTTON_ICON_CONFLICT'].includes(code))
      details.push(errors[code] ?? code);
    if (jobId) details.push(`#${jobId.slice(-8)}`);
    const label = safeDiagnostics([events[event] ?? event])[0] ?? 'Событие';
    terminal.info(
      `\r[${time}] ${symbol} ${[label, subject].filter(Boolean).join(' · ')}${details.length ? ` — ${details.join(' · ')}` : ''}`,
    );
    for (const diagnostic of entry.diagnostics ?? []) {
      for (const row of diagnostic.split(/\r?\n/).slice(0, 10)) terminal.info(`\r    ${row}`);
    }
    try {
      fs.appendFileSync(filename, `${line}\n`, { mode: 0o600 });
    } catch {
      terminal.warn(`[${time}] Не удалось сохранить журнал сервиса.`);
    }
  };
}

/** Production is one JSON event per stdout line; local terminal retains readable output. */
export function serviceLogger(
  directory,
  { environment = process.env.NODE_ENV, terminal = console } = {},
) {
  if (environment !== 'production' && directory) return localLogger(directory, terminal);
  return (event, fields) => {
    try {
      terminal.info(JSON.stringify(logEntry(event, fields)));
    } catch {
      /* Logging must not change execution, authority or billing behavior. */
    }
  };
}
