import { createContext, useContext, useMemo } from "react";
import { AlertCircle, Plus } from "lucide-react";
import {
  Background,
  BackgroundVariant,
  BaseEdge,
  Controls,
  EdgeLabelRenderer,
  Handle,
  Position,
  ReactFlow,
  getSmoothStepPath,
  type EdgeProps,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Badge, statusToVariant } from "../../components/Badge";
import { Tile } from "../../components/PageHeader";
import { describe as summary, stepLabels, triggerLabels, triggerSummary, type TriggerConfig } from "./graph";
import type { RuleSources } from "../../lib/rules";
import { slotId, type CanvasEdge, type CanvasNode, type EndNode, type Slot, type StepNode, type TriggerNode } from "./layout";
import { stepIcons, stepTones } from "./Steps";
import { EmailCountLine, type EmailCounts } from "./EmailMetrics";

// The React Flow half of the canvas. `Canvas.tsx` loads this file with a dynamic import, so
// @xyflow/react and its stylesheet stay out of the main bundle.

type Actions = {
  selected: string | null;
  /** The slot whose picker is open. */
  adding: string | null;
  onSelect: (key: string) => void;
  onAdd: (slot: Slot) => void;
  emailCounts?: Record<string, EmailCounts>;
  triggerConfig?: TriggerConfig;
  triggerSources?: RuleSources;
};

// Node and edge components are module-level so React Flow does not remount them on each render.
// They reach the canvas's state through this context instead of through `data`.
const FlowActions = createContext<Actions>({ selected: null, adding: null, onSelect: () => undefined, onAdd: () => undefined });

function Handles() {
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="canvasHandle" />
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="canvasHandle" />
    </>
  );
}

function tintOf(status: string | null) {
  if (!status) return "";
  return status === "not_started" ? "tint skipped" : `tint ${statusToVariant(status)}`;
}

function StepBox({ data }: NodeProps<StepNode>) {
  const { selected, onSelect, emailCounts } = useContext(FlowActions);
  const { node, issues, status, error } = data;
  const classes = ["canvasNode", "nodrag", "nopan", tintOf(status), issues ? "invalid" : "", selected === node.key ? "selected" : ""];
  return (
    <>
      <Handles />
      <button
        type="button"
        className={classes.filter(Boolean).join(" ")}
        aria-label={`Step ${node.key}`}
        aria-pressed={selected === node.key}
        aria-invalid={issues ? true : undefined}
        onClick={() => onSelect(node.key)}
      >
        <span className="canvasNodeHead">
          <Tile tone={stepTones[node.type]}>{stepIcons[node.type]}</Tile>
          <strong>{stepLabels[node.type]}</strong>
          {status ? <Badge value={status} /> : null}
          {issues ? (
            <span className="canvasIssues" title={`${issues} ${issues === 1 ? "issue" : "issues"}`}>
              <AlertCircle size={14} aria-hidden />
              {issues}
            </span>
          ) : null}
        </span>
        <span className={error ? "canvasNodeLine errorText" : "canvasNodeLine"}>{error ?? (summary(node) || node.key)}</span>
        <span className="canvasNodeLine mono dim">{node.key}</span>
        {node.type === "send_email" && emailCounts ? <span className="canvasNodeLine"><EmailCountLine counts={emailCounts[node.key]} /></span> : null}
      </button>
    </>
  );
}

function TriggerBox({ data }: NodeProps<TriggerNode>) {
  const { selected, onSelect, triggerConfig, triggerSources } = useContext(FlowActions);
  const config = triggerConfig ?? { type: "event", event_name: data.event };
  const classes = ["canvasNode", "nodrag", "nopan", tintOf(data.status), data.issues ? "invalid" : "", selected === data.key ? "selected" : ""];
  return (
    <>
      <Handle type="source" position={Position.Bottom} isConnectable={false} className="canvasHandle" />
      <button
        type="button"
        className={classes.filter(Boolean).join(" ")}
        aria-label="Trigger"
        aria-pressed={selected === data.key}
        aria-invalid={data.issues ? true : undefined}
        onClick={() => onSelect(data.key)}
      >
        <span className="canvasNodeHead">
          <Tile tone={stepTones.trigger}>{stepIcons.trigger}</Tile>
          <strong>{triggerLabels[config.type]}</strong>
          {data.issues ? (
            <span className="canvasIssues" title={`${data.issues} ${data.issues === 1 ? "issue" : "issues"}`}>
              <AlertCircle size={14} aria-hidden />
              {data.issues}
            </span>
          ) : null}
        </span>
        <span className="canvasNodeLine">{triggerSummary(config, triggerSources) || <span className="dim">No event set</span>}</span>
        <span className="canvasNodeLine mono dim">{data.key}</span>
      </button>
    </>
  );
}

function EndBox({ data }: NodeProps<EndNode>) {
  const { adding, onAdd } = useContext(FlowActions);
  const slot = data.slot;
  return (
    <>
      <Handle type="target" position={Position.Top} isConnectable={false} className="canvasHandle" />
      <div className="canvasEnding">
        {slot ? (
          <button
            type="button"
            className={adding === slotId(slot) ? "canvasEnd nodrag nopan active" : "canvasEnd nodrag nopan"}
            aria-label={data.label}
            onClick={() => onAdd(slot)}
          >
            <Plus size={14} aria-hidden />
            Add step
          </button>
        ) : (
          <span className="canvasEnd done">End</span>
        )}
        <span className="dim">The run ends here.</span>
      </div>
    </>
  );
}

function Link({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, data }: EdgeProps<CanvasEdge>) {
  const { adding, onAdd } = useContext(FlowActions);
  const [path, midX, midY] = getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 10 });
  const slot = data?.slot;
  // A branch edge turns halfway down, so its label and "+" sit on the last straight stretch.
  const labelled = Boolean(data?.label);
  return (
    <>
      <BaseEdge id={id} path={path} className={data?.branch ? `canvasEdge ${data.branch}` : "canvasEdge"} />
      <EdgeLabelRenderer>
        {data?.label ? (
          <div className={`canvasLabel nodrag nopan ${data.branch ?? ""}`} style={{ transform: `translate(-50%, -50%) translate(${targetX}px, ${targetY - 40}px)` }}>
            {data.label}
          </div>
        ) : null}
        {slot ? (
          <button
            type="button"
            className={adding === slotId(slot) ? "canvasAdd nodrag nopan active" : "canvasAdd nodrag nopan"}
            style={{ transform: `translate(-50%, -50%) translate(${labelled ? targetX : midX}px, ${labelled ? targetY - 14 : midY}px)` }}
            aria-label={data?.addLabel ?? "Add step"}
            onClick={() => onAdd(slot)}
          >
            <Plus size={12} aria-hidden />
          </button>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}

const nodeTypes = { step: StepBox, trigger: TriggerBox, end: EndBox };
const edgeTypes = { link: Link };

export type FlowProps = Actions & { nodes: CanvasNode[]; edges: CanvasEdge[]; label: string };

/** The canvas itself: a dot grid you can pan and zoom, with nodes placed by `layout()`. */
export default function Flow({ nodes, edges, label, selected, adding, onSelect, onAdd, emailCounts, triggerConfig, triggerSources }: FlowProps) {
  const actions = useMemo(() => ({ selected, adding, onSelect, onAdd, emailCounts, triggerConfig, triggerSources }), [selected, adding, onSelect, onAdd, emailCounts, triggerConfig, triggerSources]);
  return (
    <FlowActions.Provider value={actions}>
      <ReactFlow<CanvasNode, CanvasEdge>
        aria-label={label}
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        // The tree places every node, so nothing is dragged, connected, or deleted on the canvas
        // itself. Edits go through the "+" controls and the side panel.
        nodesDraggable={false}
        nodesConnectable={false}
        nodesFocusable={false}
        edgesFocusable={false}
        elementsSelectable={false}
        deleteKeyCode={null}
        selectionKeyCode={null}
        multiSelectionKeyCode={null}
        panOnScroll
        zoomOnDoubleClick={false}
        minZoom={0.3}
        maxZoom={1.5}
        fitView
        fitViewOptions={{ padding: 0.15, maxZoom: 1 }}
      >
        <Background variant={BackgroundVariant.Dots} gap={18} size={1.2} />
        <Controls showInteractive={false} position="bottom-right" />
      </ReactFlow>
    </FlowActions.Provider>
  );
}
