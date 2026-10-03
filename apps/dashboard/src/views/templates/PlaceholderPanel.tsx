import { useEffect, useState } from "react";
import { Field } from "../../components/Field";
import { builtIn, declarable, type Variable } from "./render";
import { inlineFallback, renamePlaceholder, type Editor, type Placeholder } from "./placeholders";
import { Requirement, type Fallbacks } from "./Variables";

export type PlaceholderControls = {
  variables: Variable[];
  onChange: (key: string, change: Partial<Variable>) => void;
  fallbacks: Fallbacks;
};

export function PlaceholderPanel({ token, editor, controls }: { token: Placeholder; editor: Editor; controls: PlaceholderControls }) {
  const [name, setName] = useState(token.key);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setName(token.key);
    setError(null);
  }, [token.key, token.from]);
  const local = token.list !== null;
  const provided = builtIn(token.key) && !local;
  const variable = controls.variables.find((item) => item.key === token.key) ?? {
    key: token.key, type: token.kind === "each" ? "list" : "string", fallback_value: null,
  };
  function rename() {
    if (name === token.key) return;
    if (!declarable(name) || (!local && builtIn(name))) {
      setError("Use 1–50 letters, digits, or underscores, and no reserved name.");
      return;
    }
    if (renamePlaceholder(editor, token, name) && !local) {
      const existing = controls.variables.find((item) => item.key === name);
      controls.onChange(name, existing ?? { ...variable, key: name });
      if (controls.fallbacks.current.has(token.key)) controls.fallbacks.current.set(name, controls.fallbacks.current.get(token.key)!);
    }
    setError(null);
  }
  return (
    <aside className="placeholderPanel stack" aria-label="Placeholder controls">
      <h3>Placeholder</h3>
      <div onBlur={rename} onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          rename();
        }
      }}>
        <Field label="Name" mono value={name} onChange={setName} disabled={provided || !editor.isEditable} error={error} />
      </div>
      <Field label="List item" value={local ? `Item in ${token.list}` : "Not a list item"} disabled onChange={() => undefined}
        hint={local ? "This name reads a field of the current item. The each block sets its scope." : "Use an each block in Code mode to repeat list items."} />
      {provided ? (
        <p className="dim">Provided by Dispatch. Configure this value in its source, not as a template variable.</p>
      ) : local ? (
        <Requirement
          variable={{ key: token.key, type: token.kind === "each" ? "list" : "string", fallback_value: token.inline }}
          memoryKey={`${token.list}:${token.from}:${token.key}`}
          disabled={!editor.isEditable || !token.raw.startsWith("{{{") || token.kind !== "value"}
          onChange={(value) => inlineFallback(editor, token, value === null ? null : String(value))}
        />
      ) : (
        <Requirement variable={variable} fallbacks={controls.fallbacks} disabled={!editor.isEditable} onChange={(fallback_value) => controls.onChange(token.key, { fallback_value })} />
      )}
      {!local && token.inline !== null ? (
        <p className="dim">Inline fallback: <span className="mono">{token.inline || "(empty)"}</span>. It takes precedence over the saved fallback. Edit it in Code mode.</p>
      ) : null}
    </aside>
  );
}
