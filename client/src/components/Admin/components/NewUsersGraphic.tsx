import { useContext, useState } from 'react';
import { PERIODS } from '../consts';
import { Period } from '~/common';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
import { getRangeLabel } from './utils';
import { useNewUsers } from '~/hooks/admin/useNewUsers';
import { isDark, ThemeContext } from '@librechat/client';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

export const NewUsersGraphic = () => {
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<Period>(Period.day);
  const [offset, setOffset] = useState(0);

  function handlePeriodChange(p: Period) {
    setPeriod(p);
    setOffset(0);
  }

  const buttonCommonStyle =
    'flex items-center gap-1 rounded-lg border border-black/30 bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-600/80';

  const { data: weekData } = useNewUsers(Period.week, 0);
  const { data: newUsersData, isLoading: isNewUsersLoading } = useNewUsers(period, offset);

  const weekTotal = weekData ? (weekData[weekData.length - 1]?.users ?? 0) : null;

  const { theme } = useContext(ThemeContext);
  const isDarkTheme = isDark(theme);

  return (
    <div
      className="mt-6 rounded-xl border bg-[var(--bg-admin-card)]"
      style={{ borderColor: 'var(--border-medium)' }}
    >
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between gap-4 p-5 text-left"
      >
        <div className="flex w-full flex-wrap justify-between gap-4">
          <div>
            <h2 className="text-sm font-semibold text-text-primary">Новые пользователи</h2>
            <p className="mt-0.5 text-xs text-text-secondary">
              Количество зарегистрированных пользователей
            </p>
          </div>
          <div className="flex items-center gap-3">
            {weekTotal !== null && (
              <div>
                <p className="text-md font-bold text-text-primary">{`Новых пользователей за текущую неделю: ${weekTotal} чел.`}</p>
              </div>
            )}
          </div>
        </div>
        <div className="shrink-0 text-text-secondary">
          {open ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
        </div>
      </button>

      {open && (
        <div className="border-t px-5 pb-5 pt-4" style={{ borderColor: 'var(--border-medium)' }}>
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-1 rounded-lg bg-white/10 px-3 py-1.5 text-sm text-gray-400">
              {getRangeLabel(period, offset)}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex overflow-hidden rounded-lg border border-gray-600/40 dark:border-gray-300/40">
                {PERIODS.map(({ value, label }) => (
                  <button
                    key={value}
                    onClick={() => handlePeriodChange(value)}
                    className={`px-4 py-1.5 text-sm font-medium transition-colors ${
                      period === value
                        ? 'bg-blue-600 text-white'
                        : 'text-gray-400 hover:bg-white/10'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <div className="flex gap-1">
                <button onClick={() => setOffset((o) => o - 1)} className={buttonCommonStyle}>
                  <ChevronLeft size={14} />
                </button>
                <button
                  onClick={() => setOffset((o) => o + 1)}
                  disabled={offset >= 0}
                  className={`${buttonCommonStyle} disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  <ChevronRight size={14} />
                </button>
              </div>
            </div>
          </div>

          {isNewUsersLoading ? (
            <div className="flex h-[300px] items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            </div>
          ) : !newUsersData || newUsersData.every((p) => p.users === 0) ? (
            <div className="flex h-[300px] items-center justify-center text-sm text-text-secondary">
              Нет данных за этот период
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={newUsersData}
                margin={{ top: 4, right: 8, left: -16, bottom: period === 'week' ? 90 : 0 }}
              >
                <CartesianGrid
                  strokeDasharray="3 3"
                  stroke={isDarkTheme ? 'white' : 'black'}
                  vertical={false}
                />
                <XAxis
                  dataKey="label"
                  tick={{ fill: isDarkTheme ? 'white' : 'black', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                  {...(period === 'week'
                    ? { angle: -45, textAnchor: 'end' as const, interval: 0 }
                    : {})}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: isDarkTheme ? 'white' : 'black', fontSize: 11 }}
                  axisLine={false}
                  tickLine={false}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.04)' }}
                  contentStyle={{
                    backgroundColor: '#1f2937',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: 'rgba(255,255,255,0.8)',
                  }}
                  formatter={(value) => [value, 'Новых пользователей']}
                />
                <Bar dataKey="users" fill="#10b981" radius={[4, 4, 0, 0]} maxBarSize={40} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  );
};
