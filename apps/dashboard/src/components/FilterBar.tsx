import { badgeLabel } from "./Badge";
import { Dropdown } from "./Dropdown";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { useSearchParams } from "react-router-dom";
import { Search } from "lucide-react";
import type { Option } from "./Field";

export type Filter = {
  /** URL search param, such as "status". */
  param: string;
  label: string;
  options: Array<Option | string>;
  /** Label for the empty value. Defaults to "All <label>". */
  all?: string;
};

export interface FilterBarProps {
  /** Search box bound to `?q=` (or `searchParam`). Pass false to hide it. */
  search?: string | false;
  searchParam?: string;
  filters?: Filter[];
  /** Extra controls on the right, such as an export button. */
  children?: ReactNode;
}

/** Wait this long after the last keystroke before writing the search to the URL. */
export const searchDelay = 300;

/**
 * Search input and select filters bound to URL search params.
 * Read the same params with `useFilters()` and pass them to `useList()`.
 */
export function FilterBar({ search = "Search", searchParam = "q", filters = [], children }: FilterBarProps) {
  const [params, setParams] = useSearchParams();
  const current = params.get(searchParam) ?? "";
  const [text, setText] = useState(current);
  const typed = useRef(false);

  // Follow the URL when it changes from outside, such as the back button.
  useEffect(() => {
    if (!typed.current) setText(current);
  }, [current]);

  useEffect(() => {
    if (!typed.current) return;
    const timer = setTimeout(() => {
      typed.current = false;
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          if (text.trim()) next.set(searchParam, text.trim());
          else next.delete(searchParam);
          return next;
        },
        { replace: true },
      );
    }, searchDelay);
    return () => clearTimeout(timer);
  }, [text, searchParam, setParams]);

  function setFilter(param: string, value: string) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      if (value) next.set(param, value);
      else next.delete(param);
      return next;
    });
  }

  return (
    <div className="filterBar">
      {search !== false ? (
        <label className="searchBox">
          <Search size={15} aria-hidden />
          <input
            type="search"
            aria-label={search}
            placeholder={search}
            value={text}
            onChange={(event) => {
              typed.current = true;
              setText(event.target.value);
            }}
          />
        </label>
      ) : null}
      {filters.map((filter) => (
        <Dropdown
          key={filter.param}
          aria-label={filter.label}
          className="filterSelect"
          value={params.get(filter.param) ?? ""}
          onChange={(event) => setFilter(filter.param, event.target.value)}
        >
          <option value="">{filter.all ?? `All ${filter.label.toLowerCase()}`}</option>
          {filter.options.map((option) => {
            const item = typeof option === "string" ? { value: option, label: badgeLabel(option) } : option;
            return (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            );
          })}
        </Dropdown>
      ))}
      {children ? <div className="toolbar filterExtra">{children}</div> : null}
    </div>
  );
}
