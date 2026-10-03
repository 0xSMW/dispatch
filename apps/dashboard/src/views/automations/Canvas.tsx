import { Component, Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, List as ListIcon, Trash2, Workflow, X } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Failed } from "../../components/Empty";
import { Tile } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { canMove, newKey, stepError, stepLabels, treeTrigger, triggerLabels, triggerSummary, type TriggerConfig, type StepType, type Tree } from "./graph";
import { layout, locate, runFocus, slotId, type Slot } from "./layout";
import { RunResult, StepForm, stepIcons, stepTones, type RunStep, type StepActions, type StepOptions } from "./Steps";
import { TriggerForm, triggerSources } from "./Trigger";
import "../../styles/canvas.css";

// The canvas view of the builder and the run view. It draws the same tree
// the list does and edits it only through the same `StepActions`, so it can never write a
// graph the list would not.

const Flow = lazy(() => import("./Flow"));

export type View = "list" | "canvas";

/** The List and Canvas switch above the builder and in the run drawer. */
export function ViewSwitch({ value, onChange }: { value: View; onChange: (view: View) => void }) {
  return (
    <div className="viewSwitch" role="group" aria-label="View">
      <button type="button" className={value === "list" ? "active" : ""} aria-pressed={value === "list"} onClick={() => onChange("list")}>
        <ListIcon size={14} aria-hidden />
        List
      </button>
      <button type="button" className={value === "canvas" ? "active" : ""} aria-pressed={value === "canvas"} onClick={() => onChange("canvas")}>
        <Workflow size={14} aria-hidden />
        Canvas
      </button>
    </div>
  );
}

/** The step picker groups, in the order the picker shows them. */
export const pickerGroups: Array<{ name: string; types: StepType[] }> = [
  { name: "Messages", types: ["send_email"] },
  { name: "Flow control", types: ["delay", "wait_for_event", "condition"] },
  { name: "Audience", types: ["contact_update", "contact_delete", "add_to_segment"] },
];

export interface CanvasProps {
  tree: Tree;
  /** Omit for a read-only canvas. */
  actions?: StepActions;
  disabled?: boolean;
  errors?: Record<string, Record<string, string>>;
  options?: StepOptions;
  /** Sets the trigger's event. The list edits it in the card above the steps. */
  onEvent?: (event: string) => void;
  onTrigger?: (config: TriggerConfig) => void;
  /** Run view: each step's result by key. */
  run?: Map<string, RunStep>;
  /** Puts the side panel under the canvas, for narrow places such as the run drawer. */
  stacked?: boolean;
}

export function Canvas({ tree, actions, disabled = false, errors = {}, options, onEvent, onTrigger, run, stacked = false }: CanvasProps) {
  const editable = Boolean(actions) && !disabled && !run;
  const [selected, setSelected] = useState<string | null>(() => (run ? runFocus(tree, run) : null));
  const [adding, setAdding] = useState<Slot | null>(null);
  const { nodes, edges } = useMemo(() => layout(tree, { editable, errors, run }), [tree, editable, errors, run]);

  const select = useCallback((key: string) => {
    setAdding(null);
    setSelected(key);
  }, []);
  const add = useCallback((slot: Slot) => {
    setSelected(null);
    setAdding(slot);
  }, []);
  const close = () => {
    setSelected(null);
    setAdding(null);
  };

  function pick(type: StepType) {
    if (!adding || !actions) return;
    // The key is chosen here and handed to the insert, so the panel can open on the new step.
    const key = newKey(tree, type);
    actions.insert(adding.path, adding.index, type, key);
    setAdding(null);
    setSelected(key);
  }

  // The panel comes after the whole canvas in the page. When it changes, focus moves to it, so a
  // keyboard user lands on the step they picked and not back at the top of the document.
  const viewRef = useRef<HTMLDivElement>(null);
  const shownPanel = adding ? `add:${adding.index}:${adding.path.map((hop) => `${hop.key}.${hop.branch}`).join("/")}` : selected;
  const firstPanel = useRef(true);
  useEffect(() => {
    if (firstPanel.current) {
      firstPanel.current = false;
      return;
    }
    const section = shownPanel ? viewRef.current?.querySelector<HTMLElement>(".canvasPanel") : null;
    if (!section) return;
    section.tabIndex = -1;
    section.focus();
  }, [shownPanel]);

  let panel: ReactNode;
  const found = selected && selected !== tree.trigger ? locate(tree, selected) : null;
  if (adding && editable) {
    panel = (
      <section className="canvasPanel" aria-label="Add a step">
        <PanelHeader title="Add a step" onClose={close} />
        {pickerGroups.map((group) => (
          <div key={group.name} className="pickerGroup" role="group" aria-label={group.name}>
            <h3>{group.name}</h3>
            {group.types.map((type) => (
              <button key={type} type="button" className="pickerItem" onClick={() => pick(type)}>
                <Tile tone={stepTones[type]}>{stepIcons[type]}</Tile>
                {stepLabels[type]}
              </button>
            ))}
          </div>
        ))}
      </section>
    );
  } else if (selected && selected === tree.trigger) {
    const issues = errors[tree.trigger] ?? {};
    const config = treeTrigger(tree);
    panel = (
      <section className="canvasPanel" aria-label="Trigger settings">
        <PanelHeader title={triggerLabels[config.type]} tone={stepTones.trigger} icon={stepIcons.trigger} detail={tree.trigger} onClose={close} />
        {run ? (
          <p className="muted">
            {triggerSummary(config, triggerSources(options))}
          </p>
        ) : (
          <div className="form">
            <TriggerForm
              config={config}
              onChange={(next) => {
                if (onTrigger) onTrigger(next);
                else if (next.type === "event") onEvent?.(next.event_name);
              }}
              options={options}
              errors={issues}
              disabled={!editable || (!onTrigger && !onEvent)}
            />
          </div>
        )}
      </section>
    );
  } else if (found) {
    const { node, path, index, list } = found;
    const issues = errors[node.key] ?? {};
    const result = run?.get(node.key);
    panel = (
      // Keyed by step: fields that hold their own text, such as a rule's number, must not carry
      // one step's value over to the next step of the same type.
      <section key={node.key} className="canvasPanel" aria-label={`Step ${node.key} settings`}>
        <PanelHeader
          title={stepLabels[node.type]}
          tone={stepTones[node.type]}
          icon={stepIcons[node.type]}
          detail={node.key}
          onClose={close}
          tools={
            <>
              {run ? <Badge value={result?.status ?? "not_started"} /> : null}
              {editable ? (
                <>
                  <button type="button" className="ghost icon small" aria-label="Move up" disabled={!canMove(list, index, -1)} onClick={() => actions!.move(path, index, -1)}>
                    <ArrowUp size={14} />
                  </button>
                  <button type="button" className="ghost icon small" aria-label="Move down" disabled={!canMove(list, index, 1)} onClick={() => actions!.move(path, index, 1)}>
                    <ArrowDown size={14} />
                  </button>
                  <button type="button" className="ghost icon small" aria-label="Remove step" onClick={() => actions!.remove(path, index, node)}>
                    <Trash2 size={14} />
                  </button>
                </>
              ) : null}
            </>
          }
        />
        {run ? (
          <RunResult node={node} result={result} />
        ) : (
          <StepForm node={node} path={path} index={index} actions={editable ? actions : undefined} disabled={!editable} errors={issues} options={options} />
        )}
        {!run && issues[stepError] ? (
          <p className="fieldError" role="alert">
            {issues[stepError]}
          </p>
        ) : null}
      </section>
    );
  } else {
    panel = (
      <section className="canvasPanel empty" aria-label="Step settings">
        <p className="dim">
          {run ? "Select a step to see its result." : editable ? "Select a step to edit it, or use + to add one." : "Select a step to see its settings."}
        </p>
      </section>
    );
  }

  return (
    <div ref={viewRef} className={stacked ? "canvasView stacked" : "canvasView"}>
      <div className="canvas">
        <Loaded>
          <Suspense fallback={<div className="canvasLoading"><Skeleton lines={4} /></div>}>
            <Flow
              nodes={nodes}
              edges={edges}
              emailCounts={options?.emailCounts}
              triggerConfig={treeTrigger(tree)}
              triggerSources={triggerSources(options)}
              label={run ? "Run canvas" : "Automation canvas"}
              selected={found ? found.node.key : selected === tree.trigger ? tree.trigger : null}
              adding={adding && editable ? slotId(adding) : null}
              onSelect={select}
              onAdd={add}
            />
          </Suspense>
        </Loaded>
      </div>
      {panel}
    </div>
  );
}

function PanelHeader({ title, detail, icon, tone, tools, onClose }: { title: string; detail?: string; icon?: ReactNode; tone?: Parameters<typeof Tile>[0]["tone"]; tools?: ReactNode; onClose: () => void }) {
  return (
    <header className="stepHeader">
      {icon ? <Tile tone={tone}>{icon}</Tile> : null}
      <div className="stepTitle">
        <strong>{title}</strong>
        {detail ? <span className="mono dim">{detail}</span> : null}
      </div>
      <div className="toolbar">
        {tools}
        <button type="button" className="ghost icon small" aria-label="Close panel" onClick={onClose}>
          <X size={14} />
        </button>
      </div>
    </header>
  );
}

/** Catches a failed chunk load, so a network blip shows a message instead of a blank page. */
class Loaded extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? <Failed message="The canvas could not load. Switch to List, or reload the page." /> : this.props.children;
  }
}
