import { Dropdown } from "../../components/Dropdown";
import { useRef, type MutableRefObject } from "react";
import { Table } from "../../components/Table";
import { builtIn, type Found, type Variable, type VariableType } from "./render";

export type Fallbacks = MutableRefObject<Map<string, string | number>>;

/** Required is still null in the API. Remember a hidden fallback only for this editing session. */
export function Requirement({
  variable,
  onChange,
  disabled = false,
  fallbacks,
  memoryKey = variable.key,
}: {
  variable: Variable;
  onChange: (fallback: Variable["fallback_value"]) => void;
  disabled?: boolean;
  fallbacks?: Fallbacks;
  memoryKey?: string;
}) {
  const local = useRef(new Map<string, string | number>());
  const memory = fallbacks ?? local;
  const { key, type, fallback_value: fallback } = variable;
  if (fallback !== null) memory.current.set(memoryKey, fallback);
  const optional = type !== "list" && fallback !== null;
  return (
    <div className="requirement">
      <div className="segmented" role="group" aria-label={`Requirement for ${key}`}>
        <button type="button" className={!optional ? "active" : undefined} aria-pressed={!optional} disabled={disabled || type === "list"} onClick={() => onChange(null)}>
          Required
        </button>
        {type !== "list" ? (
          <button type="button" className={optional ? "active" : undefined} aria-pressed={optional} disabled={disabled} onClick={() => onChange(memory.current.get(memoryKey) ?? "")}>
            Optional
          </button>
        ) : null}
      </div>
      {optional ? (
        <input
          aria-label={`Fallback for ${key}`}
          value={String(fallback)}
          placeholder="Empty"
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : null}
    </div>
  );
}

export function VariableTable({
  variables,
  found,
  samples,
  onSample,
  onChange,
  disabled = false,
  fallbacks,
}: {
  variables: Variable[];
  found: Found[];
  samples: Record<string, string>;
  onSample: (key: string, value: string) => void;
  onChange: (key: string, change: Partial<Variable>) => void;
  disabled?: boolean;
  fallbacks: Fallbacks;
}) {
  const builtins = found.filter((item) => builtIn(item.key));
  return (
    <div className="stack varTable">
      <Table
        compact
        rows={variables}
        rowKey={(item) => item.key}
        empty={<p className="muted">No variables yet. Add a placeholder like {"{{{FIRST_NAME}}}"} to your HTML to create one.</p>}
        columns={[
          {
            header: "Name",
            cell: (item) => {
              const use = found.find((entry) => entry.key === item.key);
              return (
                <span className="varRow">
                  <span className="mono">{item.key}</span>
                  {use?.inline ? <span className="dim">inline fallback</span> : null}
                  {!use ? <span className="dim">not used</span> : null}
                </span>
              );
            },
          },
          {
            header: "Type",
            cell: (item) => (
              <Dropdown
                aria-label={`Type of ${item.key}`}
                value={item.type}
                disabled={disabled}
                onChange={(event) => {
                  const type = event.target.value as VariableType;
                  onChange(item.key, { type, ...(type === "list" ? { fallback_value: null } : {}) });
                }}
              >
                <option value="string">string</option>
                <option value="number">number</option>
                <option value="list">list</option>
              </Dropdown>
            ),
          },
          {
            header: "Requirement",
            cell: (item) => (
              <Requirement variable={item} fallbacks={fallbacks} disabled={disabled} onChange={(fallback_value) => onChange(item.key, { fallback_value })} />
            ),
          },
          {
            header: "Sample",
            cell: (item) => (
              <input
                aria-label={`Sample value for ${item.key}`}
                className={item.type === "list" ? "mono" : undefined}
                value={samples[item.key] ?? ""}
                placeholder={item.type === "list" ? '[{"description": "…"}]' : "Preview value"}
                onChange={(event) => onSample(item.key, event.target.value)}
              />
            ),
          },
        ]}
      />
      {builtins.length ? (
        <p className="dim">
          Provided by Dispatch: <span className="mono">{builtins.map((item) => item.key).join(", ")}</span>
        </p>
      ) : null}
    </div>
  );
}
