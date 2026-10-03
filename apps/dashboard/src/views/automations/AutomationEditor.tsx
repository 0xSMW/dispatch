import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { GitBranch, Zap } from "lucide-react";
import { Badge } from "../../components/Badge";
import { Code } from "../../components/Code";
import { DateRange } from "../../components/DateRange";
import { ConfirmPhrase } from "../../components/ConfirmPhrase";
import { Failed } from "../../components/Empty";
import { Field } from "../../components/Field";
import { Menu } from "../../components/Menu";
import { Modal } from "../../components/Modal";
import { PageHeader, Tile } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { Tabs } from "../../components/Tabs";
import { toast } from "../../components/Toast";
import { useHotkey } from "../../hooks/useHotkey";
import { shortcuts } from "../../lib/shortcuts";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { ApiError } from "../../lib/client";
import { useCan, useClient } from "../../shell/session";
import type { Automation, ContactProperty, EventDefinition, Segment, Template, Topic } from "../../types";
import {
  descendants,
  insertStep,
  mergeIssues,
  moveStep,
  placeIssues,
  removeStep,
  setWaitBranches,
  setTrigger,
  stepLabels,
  toGraph,
  toTree,
  treeIssues,
  treeTrigger,
  triggerLabels,
  triggerSummary,
  triggerWarning,
  updateNode,
  type Graph,
  type ListPath,
  type Node,
  type Tree,
} from "./graph";
import { LeaveGuard } from "../templates/editor";
import { RunMetrics } from "./RunMetrics";
import { Runs } from "./Runs";
import { StepList, type StepActions, type StepOptions } from "./Steps";
import { TriggerForm, triggerLoading, triggerSources } from "./Trigger";
import { Canvas, ViewSwitch } from "./Canvas";
import { StopAutomation, isEnabled } from "./Stop";
import { countsByStep, useEmailMetrics } from "./EmailMetrics";

type Draft = { name: string; tree: Tree };

/** What the API would store, to tell saved from unsaved. */
function snapshot(draft: Draft) {
  return JSON.stringify({ name: draft.name.trim(), ...toGraph(draft.tree) });
}

/** Explains a failed save. A 409 `conflict` means the automation is enabled. */
export function saveError(error: Error) {
  if (error instanceof ApiError && error.name === "conflict") {
    return "This automation is enabled, so its steps cannot change. Stop it first, or duplicate it and edit the copy.";
  }
  return error.message;
}

/** `/automations/:id/editor`: the builder and the runs for this automation. */
export function AutomationEditor() {
  const { id } = useParams<{ id: string }>();
  const client = useClient();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const tab = params.get("tab") === "runs" ? "runs" : params.get("tab") === "metrics" ? "metrics" : "builder";
  // List is the default; both views edit the same tree.
  const view = params.get("view") === "canvas" ? "canvas" : "list";
  const setView = (next: "list" | "canvas") =>
    setParams((previous) => {
      const params = new URLSearchParams(previous);
      if (next === "canvas") params.set("view", "canvas");
      else params.delete("view");
      return params;
    });
  const automation = useResource<Automation>(`/automations/${id}`);
  const row = automation.data;
  const emailMetrics = useEmailMetrics(id);

  const [draft, setDraft] = useState<Draft | null>(null);
  const [saved, setSaved] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [apiError, setApiError] = useState<string | null>(null);
  // Issues from the last failed save, placed on the step cards their paths name.
  const [apiIssues, setApiIssues] = useState<Record<string, Record<string, string>>>({});
  const sent = useRef<Graph["steps"]>([]);
  const sentDraft = useRef<Draft | null>(null);
  const loaded = useRef<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [removing, setRemoving] = useState<{ path: ListPath; index: number; node: Node } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // What the API has stored, for the run drawer. The draft may hold unsaved edits.
  const stored = useMemo(() => (row ? toTree(row.steps ?? [], row.connections ?? []) : null), [row]);

  useEffect(() => {
    if (!row || !stored) return;
    setProblem(stored.problem);
    // The draft is built once per automation. A save's own response, or a stop, must not rebuild
    // it: that replaced whatever was typed while the request was in flight.
    if (loaded.current === row.id) return;
    loaded.current = row.id;
    const next = { name: row.name, tree: stored.tree };
    setDraft(next);
    setSaved(snapshot(next));
  }, [row, stored]);

  const templates = useList<Template>("/templates", {}, { all: true });
  const segments = useList<Segment>("/segments", {}, { all: true });
  const events = useList<EventDefinition>("/events", {}, { all: true });
  const topics = useList<Topic>("/topics", {}, { all: true });
  const properties = useList<ContactProperty>("/contact-properties", {}, { all: true });
  const options: StepOptions = useMemo(
    () => ({
      templates: templates.rows.map((item) => ({ value: item.id, label: item.alias ? `${item.name} (${item.alias})` : item.name })),
      segments: segments.rows.map((item) => ({ value: item.id, label: item.name })),
      events: events.rows.map((item) => item.name),
      topics: topics.rows.map((item) => ({ value: item.id, label: item.name })),
      eventDefinitions: events.rows,
      contactProperties: properties.rows,
      topicsReady: !topics.loading && !topics.error,
      segmentsReady: !segments.loading && !segments.error,
      propertiesReady: !properties.loading && !properties.error,
      topicsError: topics.error,
      segmentsError: segments.error,
      propertiesError: properties.error,
      eventName: draft?.tree.event ?? stored?.tree.event,
      templateNames: Object.fromEntries(templates.rows.flatMap((item) => [
        [item.id, item.name], ...(item.alias ? [[item.alias, item.name]] : []),
      ])),
      emailCounts: emailMetrics.data && !emailMetrics.error ? countsByStep(emailMetrics.data) : undefined,
    }),
    [templates.rows, segments.rows, segments.loading, segments.error, events.rows, topics.rows, topics.loading, topics.error, properties.rows, properties.loading, properties.error, draft?.tree.event, stored?.tree.event, emailMetrics.data, emailMetrics.error],
  );

  const enabled = row ? isEnabled(row) : false;
  const can = useCan();
  // A viewer sees the builder read-only, the same way as an enabled automation.
  const locked = !can || enabled || Boolean(problem);
  const dirty = Boolean(draft) && snapshot(draft!) !== saved;
  const issues = useMemo(() => (draft ? treeIssues(draft.tree, {
    events: events.rows, ...triggerSources(options),
  }) : {}), [draft, events.rows, options]);
  const trigger = draft ? treeTrigger(draft.tree) : null;
  const resourceWarning = trigger ? triggerWarning(trigger, triggerSources(options)) : null;
  const triggerPending = trigger ? triggerLoading(trigger, options) : false;
  const nameIssue = draft && !draft.name.trim() ? "Enter a name." : null;
  const valid = !nameIssue && Object.keys(issues).length === 0;

  const save = useMutation(
    (body: Record<string, unknown>) => client.patch<Automation>(`/automations/${id}`, body),
    {
      success: (result) => (isEnabled(result) ? "Automation started." : "Automation saved."),
      onSuccess: (result) => {
        setApiError(null);
        setApiIssues({});
        setChecked(false);
        // Saved is what was sent. Anything typed since stays in the draft and shows as unsaved.
        if (sentDraft.current) setSaved(snapshot(sentDraft.current));
        sentDraft.current = null;
        automation.setData(result);
      },
      onError: (error) => {
        const message = saveError(error);
        const issues = error instanceof ApiError ? error.issues : [];
        if (issues.length) {
          const { cards, rest } = placeIssues(sent.current, issues);
          setApiIssues(cards);
          setApiError(rest.length ? rest.join(" ") : null);
          toast.error(Object.keys(cards).length ? "Fix the highlighted steps first." : message);
          return;
        }
        setApiIssues({});
        setApiError(message);
        toast.error(message);
      },
    },
  );

  const duplicate = useMutation(() => client.post<Automation>(`/automations/${id}/duplicate`), {
    success: "Automation duplicated.",
    onSuccess: (copy) => navigate(`/automations/${copy.id}/editor`),
  });

  function submit(start: boolean) {
    if (!can || !draft || save.isLoading || triggerPending || (start && resourceWarning)) return;
    sentDraft.current = null;
    if (problem) {
      if (start) void save.mutate({ status: "enabled" });
      return;
    }
    if (!valid) {
      setChecked(true);
      toast.error("Fix the highlighted fields first.");
      return;
    }
    const graph = toGraph(draft.tree);
    sent.current = graph.steps;
    sentDraft.current = draft;
    void save.mutate({ name: draft.name.trim(), ...graph, ...(start ? { status: "enabled" } : {}) });
  }

  useHotkey(shortcuts.save.combo, () => submit(false), { enabled: tab === "builder" && !locked && dirty });

  const edit = (change: (tree: Tree) => Tree) => {
    setApiIssues({});
    setDraft((current) => (current ? { ...current, tree: change(current.tree) } : current));
  };
  const errors = mergeIssues(checked ? issues : {}, apiIssues);
  const actions: StepActions = {
    insert: (path, index, type, key) => edit((tree) => insertStep(tree, path, index, type, key)),
    remove: (path, index, node) => (descendants(node) ? setRemoving({ path, index, node }) : edit((tree) => removeStep(tree, path, index))),
    move: (path, index, delta) => edit((tree) => moveStep(tree, path, index, delta)),
    change: (key, change) => edit((tree) => updateNode(tree, key, change)),
    waitBranches: (path, index, on) => edit((tree) => setWaitBranches(tree, path, index, on)),
  };

  if (automation.error) return <Failed message={automation.error} onRetry={() => void automation.reload()} />;

  return (
    <div className="page">
      <PageHeader
        back={{ to: "/automations", label: "Automations" }}
        icon={<GitBranch size={20} />}
        tone={enabled ? "success" : "neutral"}
        label="Automation"
        title={row ? row.name : <Skeleton width="medium" />}
        actions={
          row ? (
            <>
              <Badge value={enabled ? "enabled" : "disabled"} />
              {!locked && draft ? <span className="dim saveState">{dirty ? "Unsaved changes" : "Saved"}</span> : null}
              {!locked ? (
                <button type="button" className="secondary" disabled={!dirty || save.isLoading} onClick={() => submit(false)}>
                  Save
                </button>
              ) : null}
              {!can ? null : enabled ? (
                <button type="button" className="secondary" onClick={() => setStopping(true)}>
                  Stop
                </button>
              ) : (
                <button type="button" disabled={save.isLoading || !draft || triggerPending || Boolean(resourceWarning)} aria-busy={save.isLoading} onClick={() => submit(true)}>
                  Start
                </button>
              )}
              {can ? (
                <Menu
                  items={[
                    { label: "Duplicate", onSelect: () => void duplicate.mutate() },
                    "divider",
                    { label: "Delete automation", danger: true, onSelect: () => setDeleting(true) },
                  ]}
                />
              ) : null}
            </>
          ) : null
        }
      />

      <Tabs
        tabs={[
          { id: "builder", label: "Builder" },
          { id: "runs", label: "Runs" },
          { id: "metrics", label: "Metrics" },
        ]}
        value={tab}
        onChange={(next) => setParams(next === "builder" ? {} : { tab: next })}
      />

      {tab === "runs" && id ? (
        <Runs automationId={id} tree={stored?.tree ?? null} options={options} />
      ) : tab === "metrics" && id ? (
        <RunMetrics automationId={id} tree={stored?.tree ?? null} names={options.templateNames} emails={emailMetrics} />
      ) : !draft || !row ? (
        <Skeleton lines={6} />
      ) : (
        <div className={view === "canvas" && !problem ? "builder wide" : "builder"}>
          {enabled && can ? (
            <div className="notice" role="status">
              <span>Enabled automations cannot be edited. Stop it to change its steps, or duplicate it and edit the copy.</span>
              <button type="button" className="secondary small" onClick={() => void duplicate.mutate()} disabled={duplicate.isLoading}>
                Duplicate
              </button>
            </div>
          ) : null}
          {problem ? (
            <div className="notice warning" role="status">
              <span>
                {problem} The list builder cannot edit this automation without losing steps. Change it through the API or CLI. You can still start and stop it here.
              </span>
            </div>
          ) : null}
          {apiError ? (
            <div className="alert" role="alert">
              {apiError}
            </div>
          ) : null}
          {view === "canvas" && resourceWarning ? (
            <div className="notice warning" role="status">{resourceWarning}. Change the trigger before starting this automation.</div>
          ) : null}

          <div className="form builderName">
            <Field
              label="Name"
              value={draft.name}
              onChange={(name) => setDraft({ ...draft, name })}
              error={checked ? nameIssue : null}
              disabled={locked}
              required
            />
          </div>

          {problem ? null : <div className="toolbar"><ViewSwitch value={view} onChange={setView} /><DateRange /></div>}

          {/* The canvas draws the trigger as its first node and edits it in its side panel. */}
          {view === "list" || problem ? (
          <article className="stepCard" aria-label="Trigger">
            <header className="stepHeader">
              <Tile tone="accent">
                <Zap size={14} />
              </Tile>
              <div className="stepTitle">
                <strong>{triggerLabels[treeTrigger(draft.tree).type]}</strong>
                <span className="dim">{triggerSummary(treeTrigger(draft.tree), triggerSources(options))}</span>
                <span className="mono dim">{draft.tree.trigger}</span>
              </div>
            </header>
            <div className="form">
              <TriggerForm
                config={treeTrigger(draft.tree)}
                onChange={(config) => edit((tree) => setTrigger(tree, config))}
                options={options}
                errors={errors[draft.tree.trigger]}
                disabled={locked}
              />
            </div>
          </article>
          ) : null}

          {problem ? (
            <Code value={{ steps: row.steps, connections: row.connections ?? [] }} />
          ) : view === "canvas" ? (
            <Canvas
              tree={draft.tree}
              actions={locked ? undefined : actions}
              disabled={locked}
              errors={errors}
              options={options}
              onTrigger={(config) => edit((tree) => setTrigger(tree, config))}
            />
          ) : (
            <StepList
              nodes={draft.tree.steps}
              actions={locked ? undefined : actions}
              disabled={locked}
              errors={errors}
              options={options}
            />
          )}
        </div>
      )}

      <LeaveGuard when={dirty && !locked} />

      {removing ? (
        <Modal
          isOpen
          title="Remove step"
          onClose={() => setRemoving(null)}
          onSubmit={() => {
            edit((tree) => removeStep(tree, removing.path, removing.index));
            setRemoving(null);
          }}
          submitLabel="Remove"
          danger
          size="small"
        >
          <p className="muted">
            This removes the {stepLabels[removing.node.type].toLowerCase()} and the {descendants(removing.node)} steps in its branches.
          </p>
        </Modal>
      ) : null}
      {stopping && row ? <StopAutomation automation={row} onClose={() => setStopping(false)} onDone={(next) => automation.setData(next)} /> : null}
      {deleting && row ? (
        <ConfirmPhrase
          title="Delete automation"
          body={`${row.name} and its runs in progress stop for good.`}
          phrase={row.name}
          action="Delete automation"
          onConfirm={() => client.delete(`/automations/${row.id}`)}
          onClose={() => setDeleting(false)}
          onDone={() => {
            toast.success("Automation deleted.");
            navigate("/automations");
          }}
        />
      ) : null}
    </div>
  );
}
