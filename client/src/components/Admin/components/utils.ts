import { Period } from '~/common';
import { RU_MONTHS } from '../consts';

function getUTCMonday(d: Date): Date {
  const day = d.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + delta));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000);
}

function fmtDay(d: Date): string {
  return `${d.getUTCDate()} ${RU_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function fmtMonthYear(d: Date): string {
  return `${RU_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

export function getRangeLabel(period: Period, offset: number): string {
  const now = new Date();

  if (period === 'day') {
    const mon = addDays(getUTCMonday(now), offset * 7);
    const sun = addDays(mon, 6);
    return `${fmtDay(mon)} – ${fmtDay(sun)}`;
  }

  if (period === 'week') {
    const pageLastMonday = addDays(getUTCMonday(now), offset * 12 * 7);
    const pageFirstMonday = addDays(pageLastMonday, -11 * 7);
    const pageEnd = addDays(pageLastMonday, 6);
    return `${fmtDay(pageFirstMonday)} – ${fmtDay(pageEnd)}`;
  }

  const endMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset * 12, 1));
  const startMonth = new Date(Date.UTC(endMonth.getUTCFullYear(), endMonth.getUTCMonth() - 11, 1));
  return `${fmtMonthYear(startMonth)} – ${fmtMonthYear(endMonth)}`;
}
