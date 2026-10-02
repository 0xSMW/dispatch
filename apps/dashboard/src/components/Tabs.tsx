import { NavLink } from "react-router-dom";

export type Tab<T extends string = string> = {
  id: T;
  label: string;
  /** Makes the tab a link. Use for tabs that are routes, such as Contacts and Segments. */
  to?: string;
  count?: number;
};

export interface TabsProps<T extends string> {
  tabs: Array<Tab<T>>;
  /** Active tab for state tabs. Link tabs follow the URL instead. */
  value?: T;
  onChange?: (tab: T) => void;
  label?: string;
}

/** A row of tabs. State tabs when given `value` and `onChange`, route tabs when each tab has `to`. */
export function Tabs<T extends string>({ tabs, value, onChange, label }: TabsProps<T>) {
  return (
    <div className="tabs" role={tabs.every((tab) => tab.to) ? undefined : "tablist"} aria-label={label}>
      {tabs.map((tab) => {
        const content = (
          <>
            {tab.label}
            {tab.count !== undefined ? <span className="tabCount">{tab.count}</span> : null}
          </>
        );
        if (tab.to) {
          return (
            <NavLink key={tab.id} to={tab.to} end className={({ isActive }) => (isActive ? "tab active" : "tab")}>
              {content}
            </NavLink>
          );
        }
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            aria-selected={value === tab.id}
            className={value === tab.id ? "tab active" : "tab"}
            onClick={() => onChange?.(tab.id)}
          >
            {content}
          </button>
        );
      })}
    </div>
  );
}
