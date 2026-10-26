import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface Column<T> {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  width?: string;
}

interface Props<T> {
  data: T[];
  columns: Column<T>[];
  pageSize?: number;
  loading?: boolean;
  emptyMessage?: string;
  onRowClick?: (row: T) => void;
  /** Total number of records from server. When provided, enables controlled (server-side) pagination. */
  total?: number;
  /** Current 1-based page (controlled by parent). Required when `total` is provided. */
  page?: number;
  /** Called when user clicks prev/next. Required when `total` is provided. */
  onPageChange?: (page: number) => void;
}

export const DataTable = <T extends { id: string }>({
  data,
  columns,
  pageSize = 10,
  loading,
  emptyMessage = 'No data found',
  onRowClick,
  total,
  page: controlledPage,
  onPageChange,
}: Props<T>) => {
  const [internalPage, setInternalPage] = useState(1);

  const isControlled = total !== undefined;
  const page = controlledPage ?? internalPage;
  const totalPages = isControlled
    ? Math.max(1, Math.ceil(total / pageSize))
    : Math.max(1, Math.ceil(data.length / pageSize));
  const displayTotal = isControlled ? total : data.length;
  const slice = isControlled ? data : data.slice((page - 1) * pageSize, page * pageSize);

  const handlePrev = () => {
    const prev = Math.max(1, page - 1);
    if (onPageChange) {
      onPageChange(prev);
    } else {
      setInternalPage(prev);
    }
  };

  const handleNext = () => {
    const next = Math.min(totalPages, page + 1);
    if (onPageChange) {
      onPageChange(next);
    } else {
      setInternalPage(next);
    }
  };

  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg bg-surface-hover" />
        ))}
      </div>
    );
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border-light">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-text-secondary"
                  style={col.width ? { width: col.width } : undefined}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className="px-4 py-8 text-center text-text-secondary">
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              slice.map((row) => (
                <tr
                  key={row.id}
                  onClick={() => onRowClick?.(row)}
                  className={`border-b border-border-light last:border-0 hover:bg-surface-hover${onRowClick ? 'cursor-pointer' : ''}`}
                >
                  {columns.map((col) => (
                    <td key={col.key} className="px-4 py-3 text-text-primary">
                      {col.render(row)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {totalPages > 1 && (
        <div className="flex items-center justify-between border-t border-border-light px-4 py-3">
          <span className="text-xs text-text-secondary">
            Page {page} of {totalPages} ({displayTotal} total)
          </span>
          <div className="flex gap-1">
            <button
              onClick={handlePrev}
              disabled={page === 1}
              className="rounded p-1 hover:bg-surface-hover disabled:opacity-40"
            >
              <ChevronLeft className="h-4 w-4 text-text-secondary" />
            </button>
            <button
              onClick={handleNext}
              disabled={page === totalPages}
              className="rounded p-1 hover:bg-surface-hover disabled:opacity-40"
            >
              <ChevronRight className="h-4 w-4 text-text-secondary" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
