import type { Response } from 'express';
import { logger } from '@librechat/data-schemas';
import type { ServerRequest } from '~/types/http';

interface ActivityPoint {
  label: string;
  users: number;
  startDate: Date;
  enddate?: Date;
}

interface AdminUserActivityDeps {
  aggregate: (pipeline: object[]) => Promise<{ _id: string; users: number }[]>;
}

enum PeriodType {
  'day' = 'day',
  'week' = 'week',
  'month' = 'month',
};

type GroupDateExpression = {
  $dateToString: {
    format: string;
    date: 
      | { $toDate: string } 
      | { 
          $dateTrunc: {
            date: { $toDate: string };
            unit: 'week';
            startOfWeek: 'monday';
          };
        };
  };
};

interface BacketsType { key: string; label: string; startDate: Date; endDate?: Date };

const RU_MONTHS = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

function getUTCMonday(d: Date): Date {
  const day = d.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + delta));
}

function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * 86400000);
}

function addUTCMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
}

function fmtDate(d: Date): string {
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(d.getUTCDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}`;
}

export function createAdminUserActivityHandlers(deps: AdminUserActivityDeps) {
  const { aggregate } = deps;

  async function getUserActivityHandler(req: ServerRequest, res: Response) {
    try {
      const period = (req.query.period as PeriodType) ?? PeriodType.day;
      const rawOffset = parseInt((req.query.offset as string) ?? '0', 10);
      const offset = Math.min(isNaN(rawOffset) ? 0 : rawOffset, 0);

      const now = new Date();

      let matchStart: Date;
      let matchEnd: Date;
      let buckets: BacketsType[];
      let groupDateExpr: GroupDateExpression;

      switch (period) {
        case PeriodType.day : {
          const weekMonday = addDays(getUTCMonday(now), offset * 7);
          matchStart = weekMonday;
          matchEnd = addDays(weekMonday, 7);

          buckets = Array.from({ length: 7 }, (_, i) => {
            const d = addDays(weekMonday, i);
            return { 
              key: fmtDate(d),
              startDate: d,
              label: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][i] 
            };
          });

          groupDateExpr = {
            $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$createdAt' } },
          };
          break;
        }
        case PeriodType.week : {
          const currentMonday = getUTCMonday(now);
          const pageLastMonday = addDays(currentMonday, offset * 12 * 7);
          const pageFirstMonday = addDays(pageLastMonday, -11 * 7);
          matchStart = pageFirstMonday;
          matchEnd = addDays(pageLastMonday, 7);

          buckets = Array.from({ length: 12 }, (_, i) => {
            const weekStart = addDays(pageFirstMonday, i * 7);
            const weekEnd = addDays(weekStart, 6);
            const label =
              `${weekStart.getUTCDate()} ${RU_MONTHS[weekStart.getUTCMonth()]} – ` +
              `${weekEnd.getUTCDate()} ${RU_MONTHS[weekEnd.getUTCMonth()]}`;
            return { 
              key: fmtDate(weekStart),
              startDate: weekStart,
              endDate: weekEnd,
              label 
            };
          });

          groupDateExpr = {
            $dateToString: {
              format: '%Y-%m-%d',
              date: {
                $dateTrunc: {
                  date: { $toDate: '$createdAt' },
                  unit: 'week',
                  startOfWeek: 'monday',
                },
              },
            },
          };
          break;
        }
        default: {
          const currentMonthStart = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
          );
          const pageEndMonth = addUTCMonths(currentMonthStart, offset * 12);
          const pageStartMonth = addUTCMonths(pageEndMonth, -11);
          matchStart = pageStartMonth;
          matchEnd = addUTCMonths(pageEndMonth, 1);

          buckets = Array.from({ length: 12 }, (_, i) => {
            const d = addUTCMonths(pageStartMonth, i);
            const yyyy = d.getUTCFullYear();
            const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
            return {
              key: `${yyyy}-${mm}`,
              startDate: d,
              label: `${RU_MONTHS[d.getUTCMonth()]} ${yyyy}`,
            };
          });

          groupDateExpr = {
            $dateToString: { format: '%Y-%m', date: { $toDate: '$createdAt' } },
          };
        }
      }

      const results = await aggregate([
        {
          $match: {
            $expr: {
              $and: [
                { $gte: [{ $toDate: '$createdAt' }, matchStart] },
                { $lt: [{ $toDate: '$createdAt' }, matchEnd] },
              ],
            },
          },
        },
        {
          $group: {
            _id: groupDateExpr,
            users: { $addToSet: '$user' },
          },
        },
        {
          $project: {
            _id: 1,
            users: { $size: '$users' },
          },
        }
      ]);

      const resultMap: Record<string, number> = {};
      for (const r of results) {
        resultMap[r._id] = r.users;
      }

      const data: ActivityPoint[] = buckets.map(({ key, label, startDate, endDate }) => ({
        label,
        startDate,
        endDate,
        users: resultMap[key] ?? 0,
      }));

      return res.status(200).json(data);
    } catch (error) {
      logger.error('[adminUserActivity] getUserActivity error:', error);
      return res.status(500).json({ error: 'Failed to fetch user activity' });
    }
  }

  return { getUserActivity: getUserActivityHandler };
}

interface ModelShareDeps {
  aggregate: (pipeline: object[]) => Promise<{ _id: string; count: number }[]>;
}

export function createAdminModelShareHandlers(deps: ModelShareDeps) {
  const { aggregate } = deps;

  async function getModelShareHandler(req: ServerRequest, res: Response) {
    try {
      const period = (req.query.period as PeriodType) ?? PeriodType.day;
      const rawOffset = parseInt((req.query.offset as string) ?? '0', 10);
      const offset = Math.min(isNaN(rawOffset) ? 0 : rawOffset, 0);

      const now = new Date();

      let matchStart: Date;
      let matchEnd: Date;

      switch (period) {
        case PeriodType.day: {
          const todayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
          matchStart = addDays(todayStart, offset);
          matchEnd = addDays(matchStart, 1);
          break;
        }
        case PeriodType.week: {
          matchStart = addDays(getUTCMonday(now), offset * 7);
          matchEnd = addDays(matchStart, 7);
          break;
        }
        default: {
          const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
          matchStart = addUTCMonths(currentMonthStart, offset);
          matchEnd = addUTCMonths(matchStart, 1);
        }
      }

      const results = await aggregate([
        {
          $match: {
            isCreatedByUser: false,
            model: { $nin: [null, ''] },
            $expr: {
              $and: [
                { $gte: [{ $toDate: '$createdAt' }, matchStart] },
                { $lt: [{ $toDate: '$createdAt' }, matchEnd] },
              ],
            },
          },
        },
        {
          $group: {
            _id: '$model',
            count: { $sum: 1 },
          },
        },
        { $sort: { count: -1 } },
        { $limit: 10 },
      ]);

      const total = results.reduce((sum, r) => sum + r.count, 0);
      const data = results.map((r) => ({
        model: r._id,
        count: r.count,
        share: total > 0 ? Math.round((r.count / total) * 100) : 0,
      }));

      return res.status(200).json(data);
    } catch (error) {
      logger.error('[adminModelShare] getModelShare error:', error);
      return res.status(500).json({ error: 'Failed to fetch model share' });
    }
  }

  return { getModelShare: getModelShareHandler };
}

interface MessageStatsDeps {
  aggregate: (pipeline: object[]) => Promise<{ _id: string; count: number }[]>;
}

export function createAdminMessageStatsHandlers(deps: MessageStatsDeps) {
  const { aggregate } = deps;

  async function getMessageStatsHandler(req: ServerRequest, res: Response) {
    try {
      const period = (req.query.period as PeriodType) ?? PeriodType.day;
      const rawOffset = parseInt((req.query.offset as string) ?? '0', 10);
      const offset = Math.min(isNaN(rawOffset) ? 0 : rawOffset, 0);

      const now = new Date();

      let matchStart: Date;
      let matchEnd: Date;
      let buckets: BacketsType[];
      let groupDateExpr: GroupDateExpression;

      switch (period) {
        case PeriodType.day: {
          const weekMonday = addDays(getUTCMonday(now), offset * 7);
          matchStart = weekMonday;
          matchEnd = addDays(weekMonday, 7);

          buckets = Array.from({ length: 7 }, (_, i) => {
            const d = addDays(weekMonday, i);
            return {
              key: fmtDate(d),
              startDate: d,
              label: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][i],
            };
          });

          groupDateExpr = {
            $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$createdAt' } },
          };
          break;
        }
        case PeriodType.week: {
          const currentMonday = getUTCMonday(now);
          const pageLastMonday = addDays(currentMonday, offset * 12 * 7);
          const pageFirstMonday = addDays(pageLastMonday, -11 * 7);
          matchStart = pageFirstMonday;
          matchEnd = addDays(pageLastMonday, 7);

          buckets = Array.from({ length: 12 }, (_, i) => {
            const weekStart = addDays(pageFirstMonday, i * 7);
            const weekEnd = addDays(weekStart, 6);
            const label =
              `${weekStart.getUTCDate()} ${RU_MONTHS[weekStart.getUTCMonth()]} – ` +
              `${weekEnd.getUTCDate()} ${RU_MONTHS[weekEnd.getUTCMonth()]}`;
            return { key: fmtDate(weekStart), startDate: weekStart, endDate: weekEnd, label };
          });

          groupDateExpr = {
            $dateToString: {
              format: '%Y-%m-%d',
              date: {
                $dateTrunc: {
                  date: { $toDate: '$createdAt' },
                  unit: 'week',
                  startOfWeek: 'monday',
                },
              },
            },
          };
          break;
        }
        default: {
          const currentMonthStart = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
          );
          const pageEndMonth = addUTCMonths(currentMonthStart, offset * 12);
          const pageStartMonth = addUTCMonths(pageEndMonth, -11);
          matchStart = pageStartMonth;
          matchEnd = addUTCMonths(pageEndMonth, 1);

          buckets = Array.from({ length: 12 }, (_, i) => {
            const d = addUTCMonths(pageStartMonth, i);
            const yyyy = d.getUTCFullYear();
            const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
            return {
              key: `${yyyy}-${mm}`,
              startDate: d,
              label: `${RU_MONTHS[d.getUTCMonth()]} ${yyyy}`,
            };
          });

          groupDateExpr = {
            $dateToString: { format: '%Y-%m', date: { $toDate: '$createdAt' } },
          };
        }
      }

      const results = await aggregate([
        {
          $match: {
            isCreatedByUser: true,
            $expr: {
              $and: [
                { $gte: [{ $toDate: '$createdAt' }, matchStart] },
                { $lt: [{ $toDate: '$createdAt' }, matchEnd] },
              ],
            },
          },
        },
        {
          $group: {
            _id: groupDateExpr,
            count: { $sum: 1 },
          },
        },
      ]);

      const resultMap: Record<string, number> = {};
      for (const r of results) {
        resultMap[r._id] = r.count;
      }

      const data = buckets.map(({ key, label, startDate, endDate }) => ({
        label,
        startDate,
        endDate,
        messages: resultMap[key] ?? 0,
      }));

      return res.status(200).json(data);
    } catch (error) {
      logger.error('[adminMessageStats] getMessageStats error:', error);
      return res.status(500).json({ error: 'Failed to fetch message stats' });
    }
  }

  return { getMessageStats: getMessageStatsHandler };
}

interface NewUsersDeps {
  aggregate: (pipeline: object[]) => Promise<{ _id: string; count: number }[]>;
}

export function createAdminNewUsersHandlers(deps: NewUsersDeps) {
  const { aggregate } = deps;

  async function getNewUsersHandler(req: ServerRequest, res: Response) {
    try {
      const period = (req.query.period as PeriodType) ?? PeriodType.day;
      const rawOffset = parseInt((req.query.offset as string) ?? '0', 10);
      const offset = Math.min(isNaN(rawOffset) ? 0 : rawOffset, 0);

      const now = new Date();

      let matchStart: Date;
      let matchEnd: Date;
      let buckets: BacketsType[];
      let groupDateExpr: GroupDateExpression;

      switch (period) {
        case PeriodType.day: {
          const weekMonday = addDays(getUTCMonday(now), offset * 7);
          matchStart = weekMonday;
          matchEnd = addDays(weekMonday, 7);

          buckets = Array.from({ length: 7 }, (_, i) => {
            const d = addDays(weekMonday, i);
            return { 
              key: fmtDate(d),
              startDate: d,
              label: ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'][i] 
            };
          });

          groupDateExpr = {
            $dateToString: { format: '%Y-%m-%d', date: { $toDate: '$createdAt' } },
          };
          break;
        }
        case PeriodType.week: {
          const currentMonday = getUTCMonday(now);
          const pageLastMonday = addDays(currentMonday, offset * 12 * 7);
          const pageFirstMonday = addDays(pageLastMonday, -11 * 7);
          matchStart = pageFirstMonday;
          matchEnd = addDays(pageLastMonday, 7);

          buckets = Array.from({ length: 12 }, (_, i) => {
            const weekStart = addDays(pageFirstMonday, i * 7);
            const weekEnd = addDays(weekStart, 6);
            const label =
              `${weekStart.getUTCDate()} ${RU_MONTHS[weekStart.getUTCMonth()]} – ` +
              `${weekEnd.getUTCDate()} ${RU_MONTHS[weekEnd.getUTCMonth()]}`;
            return { 
              key: fmtDate(weekStart),
              startDate: weekStart,
              endDate: weekEnd,
              label
            };
          });

          groupDateExpr = {
            $dateToString: {
              format: '%Y-%m-%d',
              date: {
                $dateTrunc: {
                  date: { $toDate: '$createdAt' },
                  unit: 'week',
                  startOfWeek: 'monday',
                },
              },
            },
          };
          break;
        }
        default: {
          const currentMonthStart = new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1),
          );
          const pageEndMonth = addUTCMonths(currentMonthStart, offset * 12);
          const pageStartMonth = addUTCMonths(pageEndMonth, -11);
          matchStart = pageStartMonth;
          matchEnd = addUTCMonths(pageEndMonth, 1);

          buckets = Array.from({ length: 12 }, (_, i) => {
            const d = addUTCMonths(pageStartMonth, i);
            const yyyy = d.getUTCFullYear();
            const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
            return {
              key: `${yyyy}-${mm}`,
              startDate: d,
              label: `${RU_MONTHS[d.getUTCMonth()]} ${yyyy}`,
            };
          });

          groupDateExpr = {
            $dateToString: { format: '%Y-%m', date: { $toDate: '$createdAt' } },
          };
        }
      }

      const results = await aggregate([
        {
          $match: {
            $expr: {
              $and: [
                { $gte: [{ $toDate: '$createdAt' }, matchStart] },
                { $lt: [{ $toDate: '$createdAt' }, matchEnd] },
              ],
            },
          },
        },
        {
          $group: {
            _id: groupDateExpr,
            count: { $sum: 1 },
          },
        },
      ]);

      const resultMap: Record<string, number> = {};
      for (const r of results) {
        resultMap[r._id] = r.count;
      }

      const data: ActivityPoint[] = buckets.map(({ key, label, startDate, endDate }) => ({
        label,
        startDate,
        endDate,
        users: resultMap[key] ?? 0,
      }));

      return res.status(200).json(data);
    } catch (error) {
      logger.error('[adminNewUsers] getNewUsers error:', error);
      return res.status(500).json({ error: 'Failed to fetch new users' });
    }
  }

  return { getNewUsers: getNewUsersHandler };
}
