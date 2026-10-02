import { X } from "lucide-react";

export type BulkAction = {
  label: string;
  onClick: () => void;
  hint?: string;
  danger?: boolean;
};

export interface BulkBarProps {
  count: number;
  actions: BulkAction[];
  onClear: () => void;
}

/** Floating pill at the bottom center: "3 selected", then actions with key hints. Hidden at zero. */
export function BulkBar({ count, actions, onClear }: BulkBarProps) {
  if (count === 0) return null;
  return (
    <div className="bulkBar" role="toolbar" aria-label="Bulk actions">
      <span className="bulkCount">{count} selected</span>
      {actions.map((action) => (
        <button key={action.label} type="button" className={action.danger ? "ghost dangerText small" : "ghost small"} onClick={action.onClick}>
          {action.label}
          {action.hint ? <kbd>{action.hint}</kbd> : null}
        </button>
      ))}
      <button type="button" className="ghost icon small" aria-label="Clear selection" onClick={onClear}>
        <X size={14} />
      </button>
    </div>
  );
}
