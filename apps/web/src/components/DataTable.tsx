import Link from 'next/link';
import type { ReactElement, ReactNode } from 'react';

export interface Column<T> {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  align?: 'left' | 'right';
  /** Hidden below the given breakpoint, so a laptop table stays readable on a tablet. */
  hideBelow?: 'md' | 'lg' | 'xl';
}

const HIDE = {
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
} as const;

/**
 * The console's one table.
 *
 * `rowHref` makes the whole row a link by stretching an anchor over it, rather than by an
 * onClick handler: this keeps the table renderable from a server component, and the row stays a
 * real link — middle-clickable, focusable, and readable to a screen reader through `rowLabel`.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  rowHref,
  rowLabel,
  empty,
}: {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  rowHref?: (row: T) => string;
  rowLabel?: (row: T) => string;
  empty: ReactNode;
}): ReactElement {
  if (rows.length === 0) {
    return <>{empty}</>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-line border-b">
            {columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                className={`eyebrow px-5 py-2.5 ${column.align === 'right' ? 'text-right' : 'text-left'} ${
                  column.hideBelow === undefined ? '' : HIDE[column.hideBelow]
                }`}
              >
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className={`border-line relative border-b last:border-b-0 ${
                rowHref === undefined ? '' : 'row-link'
              }`}
            >
              {columns.map((column, index) => (
                <td
                  key={column.key}
                  className={`px-5 py-3 align-top ${column.align === 'right' ? 'text-right' : ''} ${
                    column.hideBelow === undefined ? '' : HIDE[column.hideBelow]
                  }`}
                >
                  {index === 0 && rowHref !== undefined ? (
                    <Link
                      href={rowHref(row)}
                      aria-label={rowLabel?.(row)}
                      className="absolute inset-0 z-10"
                    >
                      <span className="sr-only">{rowLabel?.(row) ?? 'open'}</span>
                    </Link>
                  ) : null}
                  <span className="relative z-20">{column.cell(row)}</span>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
