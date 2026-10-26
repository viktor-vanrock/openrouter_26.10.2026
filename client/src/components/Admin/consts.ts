import { Period } from '~/common';

type PeriodGraphicType = { value: Period; label: string };

export const PERIODS: PeriodGraphicType[] = [
  { value: Period.day, label: 'День' },
  { value: Period.week, label: 'Неделя' },
  { value: Period.month, label: 'Месяц' },
];

export const RU_MONTHS = [
  'янв',
  'фев',
  'мар',
  'апр',
  'май',
  'июн',
  'июл',
  'авг',
  'сен',
  'окт',
  'ноя',
  'дек',
];
