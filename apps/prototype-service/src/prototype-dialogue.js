/** Explicit review selection; ordinary feedback must keep both design choices. */
export function selectedPrototypeVariant(text) {
  if (
    /не\s+(?:финализ|заверш)|do\s+not\s+(?:finaliz|finish)/iu.test(text) ||
    !/финализ|заверш|finaliz|finish/iu.test(text)
  )
    return null;
  return (
    /^\s*(?:беру|выбираю|оставь|оставляем|choose|use)\s+(?:вариант|variant)\s+([ab])\b/iu
      .exec(text)?.[1]
      ?.toUpperCase() ?? null
  );
}

export function prototypeContext(requirements, previousSource) {
  return previousSource
    ? `${requirements}\n\nИсходник последней принятой версии. Внеси правки, сохрани остальные сценарии:\n\`\`\`tsx\n${previousSource}\n\`\`\``
    : requirements;
}

/** Both default designs must be visible in the plan, even when the model omits them. */
export function ensurePlanVariants(prompt) {
  const a = /(?:^|\s)(?:вариант\s+)?[AА]\s*[—:−-]/iu.test(prompt);
  const b = /(?:^|\s)(?:вариант\s+)?[BВ]\s*[—:−-]/iu.test(prompt);
  if (a && b) return prompt;
  const designs =
    '\n\nВарианты дизайна:\nA — компактный рабочий экран с быстрым доступом к действиям.\nB — карточки с акцентом на статус и подробности.\nОба варианта поддерживают все сценарии и общие данные. После просмотра выберите один вариант для дальнейших правок.';
  const approval = '\n\nПодтвердите план или напишите, что нужно изменить.';
  return prompt.slice(0, 2048 - designs.length - approval.length).trimEnd() + designs + approval;
}
