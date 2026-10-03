import type { MouseEvent, ReactNode } from "react";
import type { Selection } from "../hooks/useSelection";
import { useCan } from "../shell/session";
import { ReadOnlyMenus } from "./Menu";
import { Empty, Failed } from "./Empty";
import { Skeleton } from "./Skeleton";

export type Column<T> = {
  /** Header text. */
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Stable key; defaults to the header text. */
  key?: string;
  className?: string;
};

export interface TableProps<T> {
  columns: Array<Column<T>>;
  rows: T[];
  rowKey?: (row: T) => string;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  /** Shown inside the table frame when there are no rows. */
  empty?: ReactNode;
  /** Makes rows clickable. Clicks on buttons, links, and inputs inside a row are ignored. */
  onRowClick?: (row: T) => void;
  /** Adds a checkbox column bound to `useSelection()`. Hidden from a viewer. */
  selection?: Selection;
  /** Row menu slot, rendered as the last column. Usually `<Menu items={...} />`. A viewer sees only the items marked `read`. */
  menu?: (row: T) => ReactNode;
  /** Footer paging. Rendered when `page` is set. Matches `useList()`. */
  page?: number;
  hasMore?: boolean;
  onNext?: () => void;
  onPrevious?: () => void;
  /** Noun for the footer, such as "domains". */
  noun?: string;
  compact?: boolean;
}

function interactive(event: MouseEvent) {
  const target = event.target as HTMLElement;
  return Boolean(target.closest("button, a, input, select, textarea, label, [role='menu']"));
}

export function Table<T>({
  columns,
  rows,
  rowKey = (row) => (row as { id?: string }).id ?? JSON.stringify(row),
  loading = false,
  error = null,
  onRetry,
  empty,
  onRowClick,
  selection: picked,
  menu: rowMenu,
  page,
  hasMore = false,
  onNext,
  onPrevious,
  noun,
  compact = false,
}: TableProps<T>) {
  // Checkboxes only lead to bulk writes, so a viewer gets none. A viewer's row menus keep the
  // items that only read, such as View and Copy ID.
  const can = useCan();
  const selection = can ? picked : undefined;
  const menu = rowMenu;
  const span = columns.length + (selection ? 1 : 0) + (menu ? 1 : 0);
  const showSkeleton = loading && rows.length === 0;

  return (
    <div className={compact ? "tableWrap compact" : "tableWrap"}>
      <table>
        <thead>
          <tr>
            {selection ? (
              <th className="checkCell">
                <input
                  type="checkbox"
                  aria-label="Select all rows"
                  checked={selection.allSelected}
                  ref={(input) => {
                    if (input) input.indeterminate = selection.someSelected;
                  }}
                  onChange={selection.toggleAll}
                />
              </th>
            ) : null}
            {columns.map((column, index) => (
              <th key={column.key ?? (typeof column.header === "string" ? column.header : index)} className={column.className}>
                {column.header}
              </th>
            ))}
            {menu ? <th className="menuCell" aria-label="Actions" /> : null}
          </tr>
        </thead>
        <tbody aria-busy={loading}>
          {error ? (
            <tr>
              <td colSpan={span}>
                <Failed message={error} onRetry={onRetry} />
              </td>
            </tr>
          ) : showSkeleton ? (
            Array.from({ length: 3 }, (_, index) => (
              <tr key={`skeleton-${index}`}>
                <td colSpan={span}>
                  <Skeleton />
                </td>
              </tr>
            ))
          ) : rows.length === 0 ? (
            <tr>
              <td colSpan={span}>{empty ?? <Empty />}</td>
            </tr>
          ) : (
            rows.map((row) => {
              const id = rowKey(row);
              return (
                <tr
                  key={id}
                  className={[onRowClick ? "clickable" : "", selection?.has(id) ? "selected" : ""].filter(Boolean).join(" ") || undefined}
                  onClick={onRowClick ? (event) => !interactive(event) && onRowClick(row) : undefined}
                  // A clickable row is reachable with Tab and opens with Enter, so its detail is
                  // not mouse-only on pages where no cell holds a link.
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={
                    onRowClick
                      ? (event) => {
                          if (event.key !== "Enter" || event.target !== event.currentTarget) return;
                          event.preventDefault();
                          onRowClick(row);
                        }
                      : undefined
                  }
                >
                  {selection ? (
                    <td className="checkCell">
                      <input type="checkbox" aria-label="Select row" checked={selection.has(id)} onChange={() => selection.toggle(id)} />
                    </td>
                  ) : null}
                  {columns.map((column, index) => (
                    <td key={column.key ?? (typeof column.header === "string" ? column.header : index)} className={column.className}>
                      {column.cell(row)}
                    </td>
                  ))}
                  {menu ? (
                    <td className="menuCell">
                      <ReadOnlyMenus.Provider value={!can}>{menu(row)}</ReadOnlyMenus.Provider>
                    </td>
                  ) : null}
                </tr>
              );
            })
          )}
        </tbody>
      </table>
      {page !== undefined ? (
        <div className="tableFooter">
          <span>
            Page {page}
            {noun && rows.length > 0 ? ` · ${rows.length} ${noun}` : ""}
          </span>
          <div className="toolbar">
            <button type="button" className="ghost small" disabled={page <= 1 || loading} onClick={onPrevious}>
              Previous
            </button>
            <button type="button" className="ghost small" disabled={!hasMore || loading} onClick={onNext}>
              Next
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
