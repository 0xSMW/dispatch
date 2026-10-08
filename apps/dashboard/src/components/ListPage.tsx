import type { ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import type { ListState } from "../hooks/useList";
import type { Selection } from "../hooks/useSelection";
import { useCan } from "../shell/session";
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
  const click = onRowClick ?? (rowHref ? (row: T) => navigate(rowHref(row)) : undefined);
  const hasFilters = Boolean(search) || Boolean(filters?.length) || Boolean(filterExtra);

  return (
    <div className="page">
      <PageHeader title={title} context={context} learn={learn} actions={can ? actions : null} />
      {tabs ? <Tabs tabs={tabs} /> : null}
      {hasFilters ? (
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
        empty={empty}
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
