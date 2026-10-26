import { useContext, useState } from 'react';
import { PERIODS, RU_MONTHS } from '../consts';
import { Period } from '~/common';
import { ChevronLeft, ChevronRight, ChevronDown, ChevronUp } from 'lucide-react';
import { useModelShare } from '~/hooks/admin/useModelShare';
import { isDark, ThemeContext } from '@librechat/client';
import { ResponsiveContainer, PieChart, Pie, Cell, Tooltip, Legend } from 'recharts';
import type { PieLabelRenderProps } from 'recharts';

function getUTCMonday(d: Date): Date {
  const day = d.getUTCDay();
  const delta = day === 0 ? -6 : 1 - day;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + delta));
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * 86400000);
}

function fmtDay(d: Date): string {
  return `${d.getUTCDate()} ${RU_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

function getModelRangeLabel(period: Period, offset: number): string {
  const now = new Date();
  if (period === Period.day) {
    const todayStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const d = addDays(todayStart, offset);
    return fmtDay(d);
  }
  if (period === Period.week) {
    const mon = addDays(getUTCMonday(now), offset * 7);
    const sun = addDays(mon, 6);
    return `${fmtDay(mon)} – ${fmtDay(sun)}`;
  }
  const currentMonthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const d = new Date(
    Date.UTC(currentMonthStart.getUTCFullYear(), currentMonthStart.getUTCMonth() + offset, 1),
  );
  return `${RU_MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}

const COLORS = [
  '#3b82f6',
  '#10b981',
  '#a78bfa',
  '#f59e0b',
  '#ef4444',
  '#06b6d4',
  '#84cc16',
  '#f97316',
  '#ec4899',
  '#6366f1',
];

const renderCustomLabel = ({
  cx,
  cy,
  midAngle,
  innerRadius,
  outerRadius,
  percent,
}: PieLabelRenderProps) => {
  if (
    percent == null ||
    percent < 0.04 ||
    cx == null ||
    cy == null ||
    midAngle == null ||
    innerRadius == null ||
    outerRadius == null
  )
    return null;
  const RADIAN = Math.PI / 180;
  const radius = innerRadius + (outerRadius - innerRadius) * 0.55;
  const x = cx + radius * Math.cos(-midAngle * RADIAN);
  const y = cy + radius * Math.sin(-midAngle * RADIAN);
  return (
    <text
      x={x}
      y={y}
      fill="white"
      textAnchor="middle"
      dominantBaseline="central"
      fontSize={11}
      fontWeight={600}
    >
      {`${Math.round(percent * 100)}%`}
    </text>
  );
};

export const ModelShareGraphic = () => {
  const [open, setOpen] = useState(false);
  const [period, setPeriod] = useState<Period>(Period.day);
  const [offset, setOffset] = useState(0);

  function handlePeriodChange(p: Period) {
    setPeriod(p);
    setOffset(0);
  }

  const buttonCommonStyle =
    'flex items-center gap-1 rounded-lg border border-black/30 bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-600/80';

  // данные для шапки: топ модель за сегодня
  const { data: todayData } = useModelShare(Period.day, 0);
  const { data, isLoading } = useModelShare(period, offset);

  const topModel = todayData && todayData.length > 0 ? todayData[0] : null;

  const { theme } = useContext(ThemeContext);
  const isDarkTheme = isDark(theme);
  const textColor = isDarkTheme ? 'white' : '#111827';

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
            <h2 className="text-sm font-semibold text-text-primary">Популярность моделей</h2>
            <p className="mt-0.5 text-xs text-text-secondary">
              Доля использования каждой модели (топ-10)
            </p>
          </div>
          <div className="flex items-center gap-3">
            {topModel && (
              <div className="text-right">
                <p className="text-md font-bold text-text-primary">
                  {`Топ сегодня: ${topModel.model} — ${topModel.share}%`}
                </p>
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
              {getModelRangeLabel(period, offset)}
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

          {isLoading ? (
            <div className="flex h-[340px] items-center justify-center">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-blue-500 border-t-transparent" />
            </div>
          ) : !data || data.length === 0 ? (
            <div className="flex h-[340px] items-center justify-center text-sm text-text-secondary">
              Нет данных за этот период
            </div>
          ) : (
            <ResponsiveContainer width="100%" height={340}>
              <PieChart>
                <Pie
                  data={data}
                  dataKey="count"
                  nameKey="model"
                  cx="50%"
                  cy="50%"
                  outerRadius={130}
                  labelLine={false}
                  label={renderCustomLabel}
                >
                  {data.map((_, i) => (
                    <Cell key={i} fill={COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#1f2937',
                    border: '1px solid rgba(255,255,255,0.1)',
                    borderRadius: '8px',
                    fontSize: '12px',
                    color: 'rgba(255,255,255,0.8)',
                  }}
                  formatter={(value, name, props) => [`${value} (${props.payload.share}%)`, name]}
                />
                <Legend
                  formatter={(value) => (
                    <span style={{ color: textColor, fontSize: 12 }}>{value}</span>
                  )}
                />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
      )}
    </div>
  );
};
