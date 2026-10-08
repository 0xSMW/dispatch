import { cloneElement, isValidElement, type ReactNode } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import type { ListState } from "../hooks/useList";
import type { Selection } from "../hooks/useSelection";
import { useCan } from "../shell/session";
import { Empty, type EmptyProps } from "./Empty";
import { BulkBar, type BulkAction } from "./BulkBar";
import { FilterBar, type Filter } from "./FilterBar";
import { PageHeader, type PageHeaderProps } from "./PageHeader";
import { Table, type Column } from "./Table";
import { Tabs, type Tab } from "./Tabs";

export interface ListPageProps<T extends { id: string }> {
  title: string;
  context?: ReactNode;
  learn?: PageHeaderProps["learn"];
  /** Primary action on the right, such as an "Add domain" button. */
  actions?: ReactNode;
  /** Route tabs under the title, such as Contacts / Properties / Segments / Topics. */
  tabs?: Tab[];
  /** Search placeholder. Omit to hide the search box. Bound to `?q=`. */
  search?: string;
  filters?: Filter[];
  /** Controls at the end of the filter row. */
  filterExtra?: ReactNode;
  list: ListState<T>;
  columns: Array<Column<T>>;
  /** Row click target. */
  rowHref?: (row: T) => string;
  onRowClick?: (row: T) => void;
  menu?: (row: T) => ReactNode;
  selection?: Selection;
  bulkActions?: BulkAction[];
  empty?: ReactNode;
  /** Plural noun for the footer, such as "domains". */
  noun?: string;
  /** Modals and drawers owned by the page. */
  children?: ReactNode;
}

/**
 * Title, primary action, tabs, filter row, table, and footer: the whole list page pattern. A
 * viewer gets no actions, checkboxes, or bulk actions, and row menus keep only items marked `read`.
 */
export function ListPage<T extends { id: string }>({
  title,
  context,
  learn,
  actions,
  tabs,
  search,
  filters,
  filterExtra,
  list,
  columns,
  rowHref,
  onRowClick,
  menu,
  selection,
  bulkActions,
  empty,
  noun,
  children,
}: ListPageProps<T>) {
  const navigate = useNavigate();
  const can = useCan();
  const [params, setParams] = useSearchParams();
  const filtered = [...params].some(([key, value]) => value && !["tab", "view"].includes(key));
  const blank = !list.loading && !list.error && list.page === 1 && !list.rows.length && !filtered;
  const emptyContent = blank && isValidElement<EmptyProps>(empty) && empty.type === Empty
    ? cloneElement(empty, { action: empty.props.action ?? (canActions(actions)) })
    : filtered && !list.rows.length && !list.loading && !list.error
      ? <Empty title="No results" body="Try a different search, or clear your filters." action={<button type="button" className="secondary" onClick={() => setParams((previous) => { const next = new URLSearchParams(previous); for (const key of [...next.keys()]) if (!["tab", "view"].includes(key)) next.delete(key); return next; })}>Clear filters</button>} />
      : empty;
  function canActions(value: ReactNode) {
    if (!can) return null;
    // if (title === "Timeline" || title === "Logs") return <Link className="button" to="/emails/send">Send test email</Link>;
    return value;
  }
  const click = onRowClick ?? (rowHref ? (row: T) => navigate(rowHref(row)) : undefined);
  const hasFilters = Boolean(search) || Boolean(filters?.length) || Boolean(filterExtra);

  return (
    <div className="page">
      <PageHeader title={title} context={context} learn={blank ? undefined : learn} actions={can && !blank ? actions : null} />
      {tabs ? <Tabs tabs={tabs} /> : null}
      {hasFilters && !blank ? (
        <FilterBar search={search ?? false} filters={filters}>
          {filterExtra}
        </FilterBar>
      ) : null}
      <Table
        columns={columns}
        rows={list.rows}
        loading={list.loading}
        error={list.error}
        onRetry={() => void list.reload()}
        empty={emptyContent}
        onRowClick={click}
        selection={selection}
        menu={menu}
        page={list.page}
        hasMore={list.hasMore}
        onNext={list.next}
        onPrevious={list.previous}
        noun={noun}
      />
      {can && selection && bulkActions ? <BulkBar count={selection.count} actions={bulkActions} onClear={selection.clear} /> : null}
      {children}
    </div>
  );
}
