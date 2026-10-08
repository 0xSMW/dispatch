import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { BookOpen, ChevronLeft, Code2, GitBranch, Zap } from "lucide-react";
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
import { dialogOpen, shortcuts } from "../../lib/shortcuts";
import { learnLinks } from "../../lib/docs";
import { useList } from "../../hooks/useList";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { ApiError } from "../../lib/client";
import { kindLabels, templateKind } from "../../lib/emailKind";
import { useCan, useClient } from "../../shell/session";
import type { Automation, AutomationPreview, ContactProperty, EventDefinition, Segment, Template, Topic } from "../../types";
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
  type ListPath,
  type Node,
  type Tree,
} from "./graph";
import { LeaveGuard } from "../templates/editor";
import { RunMetrics } from "./RunMetrics";
import { Runs } from "./Runs";
import { StepList, type StepActions, type StepOptions } from "./Steps";
import { ReentryContext, TriggerForm, triggerLoading, triggerSources, type Reentry } from "./Trigger";
import { Canvas, ViewSwitch } from "./Canvas";
import { StopAutomation, isEnabled } from "./Stop";
import { countsByStep, useEmailMetrics } from "./EmailMetrics";
import { Enroll, canEnroll } from "./Enroll";
import { pickWinner } from "./winner";

type Draft = { name: string; tree: Tree; reentry: Reentry };
type SaveRequest = { body: Record<string, unknown>; draft: Draft | null; id: string };
type Confirmation = SaveRequest & { preview: AutomationPreview };

/** What the API would store, to tell saved from unsaved. */
function snapshot(draft: Draft) {
  return JSON.stringify({ name: draft.name.trim(), reentry: draft.reentry, ...toGraph(draft.tree) });
}

/** Only the graph-lock conflict gets editor guidance. Other conflicts keep their precise message. */
export function saveError(error: Error) {
  if (error instanceof ApiError && error.name === "conflict" && /^(Disable|Stop|Pause(?: or stop)?) the automation before changing its steps\.?$/.test(error.message)) {
    return "This automation is enabled, so its steps cannot change. Pause it first to keep its runs, or duplicate it and edit the copy.";
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
  // Canvas is the default; an explicit List choice survives tab and date changes.
  const view = params.get("view") === "list" ? "list" : "canvas";
  const setView = (next: "list" | "canvas") =>
    setParams((previous) => {
      const params = new URLSearchParams(previous);
      params.set("view", next);
      return params;
    });
  const setTab = (next: string) => setParams((previous) => {
    const params = new URLSearchParams(previous);
    if (next === "builder") params.delete("tab");
    else params.set("tab", next);
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
  const loaded = useRef<string | null>(null);
  const [checked, setChecked] = useState<false | "draft" | "enabled">(false);
  const [removing, setRemoving] = useState<{ path: ListPath; index: number; node: Node } | null>(null);
  const [stopping, setStopping] = useState(false);
  const [enrolling, setEnrolling] = useState(false);
  const enrollmentJob = params.get("enroll_job");
  const [deleting, setDeleting] = useState(false);
  const [winnerBusy, setWinnerBusy] = useState(false);
  const winnerLock = useRef(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const workspaceRef = useRef<HTMLDivElement>(null);
  const controlsRef = useRef<HTMLDivElement>(null);
  const immersive = tab === "builder" && view === "canvas" && !problem;

  useLayoutEffect(() => {
    const workspace = workspaceRef.current;
    const controls = controlsRef.current;
    if (!immersive || !workspace || !controls) return;
    // Includes wrapped controls and visible notices, including their scroll-constrained height.
    // Keep this on the workspace so the mounted Canvas inherits it without resetting selection.
    const measure = () => {
      const bottom = Math.max(0, controls.getBoundingClientRect().bottom - workspace.getBoundingClientRect().top);
      workspace.style.setProperty("--canvas-controls-bottom", `${bottom}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(controls);
    observer.observe(workspace);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
      workspace.style.removeProperty("--canvas-controls-bottom");
    };
  }, [immersive, automation.error]);

  // What the API has stored, for the run drawer. The draft may hold unsaved edits.
  const stored = useMemo(() => (row ? toTree(row.steps ?? [], row.connections ?? []) : null), [row]);

  useEffect(() => {
    if (!row || !stored) return;
    setProblem(stored.problem);
    // The draft is built once per automation. A save's own response, or a stop, must not rebuild
    // it: that replaced whatever was typed while the request was in flight.
    if (loaded.current === row.id) return;
    loaded.current = row.id;
    const next: Draft = { name: row.name, tree: stored.tree, reentry: row.reentry ?? "every_time" };
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
      templatesReady: !templates.loading && !templates.error,
      templatesError: templates.error,
      templates: templates.rows.map((item) => {
        const kind = item.kind ?? (item.html !== undefined || item.text !== undefined ? templateKind(item) : undefined);
        return { value: item.id, label: `${item.alias ? `${item.name} (${item.alias})` : item.name}${kind ? ` · ${kindLabels[kind]}` : ""}`, kind };
      }),
      segments: segments.rows.map((item) => ({ value: item.id, label: item.name })),
      staticSegments: segments.rows.filter((item) => item.type !== "dynamic").map((item) => ({ value: item.id, label: item.name })),
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
    [templates.rows, templates.loading, templates.error, segments.rows, segments.loading, segments.error, events.rows, topics.rows, topics.loading, topics.error, properties.rows, properties.loading, properties.error, draft?.tree.event, stored?.tree.event, emailMetrics.data, emailMetrics.error],
  );

  const enabled = row ? isEnabled(row) : false;
  const paused = row?.status === "paused";
  const can = useCan();
  // A viewer sees the builder read-only, the same way as an enabled automation.
  const locked = !can || enabled || Boolean(problem) || winnerBusy;
  const dirty = Boolean(draft) && snapshot(draft!) !== saved;
  const templateKinds = useMemo(() => Object.fromEntries(templates.rows.flatMap((item) => {
    const kind = item.kind ?? (item.html !== undefined || item.text !== undefined ? templateKind(item) : undefined);
    return kind ? [[item.id, kind], ...(item.alias ? [[item.alias, kind]] : [])] : [];
  })), [templates.rows]);
  const issues = useMemo(() => (draft ? treeIssues(draft.tree, {
    events: events.rows, ...triggerSources(options),
  }, { enabled: checked === "enabled", templateKinds }) : {}), [draft, events.rows, options, checked, templateKinds]);
  const trigger = draft ? treeTrigger(draft.tree) : null;
  const resourceWarning = trigger ? triggerWarning(trigger, triggerSources(options)) : null;
  const triggerPending = trigger ? triggerLoading(trigger, options) : false;
  const nameIssue = draft && !draft.name.trim() ? "Enter a name." : null;
  const current = useRef({ draft, id: row?.id, paused, can });
  current.current = { draft, id: row?.id, paused, can };

  function failedSave(error: Error, request: SaveRequest) {
    const message = saveError(error);
    const issues = error instanceof ApiError ? error.issues : [];
    if (issues.length) {
      const { cards, rest } = placeIssues(request.draft ? toGraph(request.draft.tree).steps : [], issues);
      setApiIssues(cards);
      setApiError(rest.length ? rest.join(" ") : null);
      toast.error(Object.keys(cards).length ? "Fix the highlighted steps first." : message);
      return;
    }
    setApiIssues({});
    setApiError(message);
    toast.error(message);
  }

  const save = useMutation(
    (request: SaveRequest) => client.patch<Automation>(`/automations/${request.id}`, request.body),
    {
      success: (result) => (isEnabled(result) ? paused ? "Automation resumed." : "Automation started." : "Automation saved."),
      onSuccess: (result, request) => {
        setApiError(null);
        setApiIssues({});
        setChecked(false);
        setConfirmation(null);
        // Saved is what was sent. Anything typed since stays in the draft and shows as unsaved.
        if (request.draft) setSaved(snapshot(request.draft));
        automation.setData(result);
      },
      onError: failedSave,
    },
  );

  function isCurrent(request: SaveRequest) {
    const latest = current.current;
    return latest.can && latest.paused && latest.id === request.id && latest.draft === request.draft;
  }

  const preview = useMutation(
    (request: SaveRequest) => client.patch<AutomationPreview>(`/automations/${request.id}?dry_run=true`, request.body),
    {
      onSuccess: (result, request) => {
        // Edits made while the preview was loading require a new preview, even after reverting.
        if (!isCurrent(request)) return;
        if (result.stranded_runs > 0) setConfirmation({ ...request, preview: result });
        else void save.mutate(request);
      },
      onError: (error, request) => {
        if (isCurrent(request)) failedSave(error, request);
      },
    },
  );
  const pause = useMutation(() => client.patch<Automation>(`/automations/${id}`, { status: "paused" }), {
    success: "Automation paused.",
    onSuccess: (result) => automation.setData(result),
  });
  const busy = save.isLoading || preview.isLoading || pause.isLoading || winnerBusy;
  async function winner(stepKey: string, variant: string) {
    if (winnerLock.current || !can || !row || dirty || busy || problem || confirmation || row.version === undefined) return;
    winnerLock.current = true;
    setWinnerBusy(true);
    setApiError(null);
    try {
      await pickWinner(client, row, stepKey, variant, (result) => {
        automation.setData(result);
        const stored = toTree(result.steps, result.connections);
        const next = { name: result.name, tree: stored.tree, reentry: result.reentry ?? "every_time" } satisfies Draft;
        setDraft(next);
        setSaved(snapshot(next));
      });
      toast.success("Winner picked. Automation resumed.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Winner could not be picked.";
      setApiError(message);
      toast.error(message);
    } finally {
      winnerLock.current = false;
      setWinnerBusy(false);
    }
  }

  const duplicate = useMutation(() => client.post<Automation>(`/automations/${id}/duplicate`), {
    success: "Automation duplicated.",
    onSuccess: (copy) => navigate(`/automations/${copy.id}/editor`),
  });

  function submit(start: boolean) {
    if (!can || !row || !draft || busy || confirmation || enabled || triggerPending || (start && resourceWarning)) return;
    const nextIssues = treeIssues(draft.tree, { events: events.rows, ...triggerSources(options) }, { enabled: start, templateKinds });
    // A clean paused graph still resumes with a status-only request. Do not newly apply
    // unrelated editor validation to its stored steps; only enforce the send-kind contract.
    const cleanResume = start && paused && !dirty;
    const sendIssues = Object.values(nextIssues).some((fields) => fields.kind || fields.topic_id);
    if (!problem && (cleanResume ? sendIssues : nameIssue || Object.keys(nextIssues).length)) {
      setChecked(start ? "enabled" : "draft");
      toast.error("Fix the highlighted fields first.");
      return;
    }
    if (start && (problem || (paused && !dirty))) {
      void save.mutate({ id: row.id, body: { status: "enabled" }, draft: null });
      return;
    }
    if (problem || (!start && !dirty)) return;
    const graph = toGraph(draft.tree);
    const request: SaveRequest = {
      id: row.id,
      draft,
      body: { name: draft.name.trim(), reentry: draft.reentry, ...graph, ...(start ? { status: "enabled" } : {}) },
    };
    setApiError(null);
    if (paused) void preview.mutate(request);
    else void save.mutate(request);
  }

  useHotkey(shortcuts.save.combo, () => submit(false), { enabled: tab === "builder" && !locked && dirty });

  const edit = (change: (tree: Tree) => Tree) => {
    if (locked || winnerBusy) return;
    setConfirmation(null);
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

  const headerActions = (
    row ? (
      <>
        <Badge value={row.status ?? (row.enabled ? "enabled" : "disabled")} />
        {can && canEnroll(row) ? <button type="button" className="secondary" onClick={() => setEnrolling(true)}>Enroll contacts</button> : null}
        {!locked && draft ? <span className="dim saveState">{dirty ? "Unsaved changes" : "Saved"}</span> : null}
        {!locked ? (
          <button type="button" className="secondary" disabled={!dirty || busy || Boolean(confirmation)} onClick={() => submit(false)}>
            Save
          </button>
        ) : null}
        {!can ? null : enabled ? (
          <button type="button" className="secondary" disabled={busy} onClick={() => void pause.mutate()}>
            Pause
          </button>
        ) : (
          <button type="button" disabled={busy || Boolean(confirmation) || !draft || triggerPending || Boolean(resourceWarning)} aria-busy={busy} onClick={() => submit(true)}>
            {paused ? "Resume" : "Start"}
          </button>
        )}
        {can && (enabled || paused) ? (
          <button type="button" className="secondary" disabled={busy} onClick={() => setStopping(true)}>
            Stop and cancel runs
          </button>
        ) : null}
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
  );
  const notices = (
    <>
      {enabled && can ? (
        <div className="notice" role="status">
          <span>Enabled automations cannot be edited. Pause it to change its steps while keeping runs, or duplicate it and edit the copy.</span>
          <button type="button" className="secondary small" onClick={() => void pause.mutate()} disabled={busy}>
            Pause
          </button>
          <button type="button" className="secondary small" onClick={() => void duplicate.mutate()} disabled={duplicate.isLoading}>
            Duplicate
          </button>
        </div>
      ) : null}
      {paused ? (
        <div className="notice" role="status">
          <span>Paused. Runs hold their place. New triggers are not started.</span>
        </div>
      ) : null}
      {problem ? (
        <div className="notice warning" role="status">
          <span>
            {problem} The list builder cannot edit this automation without losing steps. Change it through the API or CLI. You can still pause, resume, start and stop it here.
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
    </>
  );
  const nameField = draft ? (
    <Field
      className="automationName"
      label="Name"
      value={draft.name}
      onChange={(name) => {
        if (locked) return;
        setConfirmation(null);
        setDraft({ ...draft, name });
      }}
      error={checked ? nameIssue : null}
      disabled={locked}
      required
    />
  ) : <Skeleton width="medium" />;

  return (
    <div ref={workspaceRef} className={immersive ? "page automationEditor immersive" : "page automationEditor"}>
      <div ref={controlsRef} className="automationControls">
        {immersive ? (
          <header className="automationHeader">
            <Link className="backLink" to="/automations"><ChevronLeft size={14} /> Automations</Link>
            <h1 className="automationTitle">{draft?.name ?? row?.name ?? "Automation"}</h1>
            {nameField}
            <div className="toolbar automationActions">
              {headerActions}
              <button type="button" className="ghost small" title={`API reference (${shortcuts.api.keys[0]})`} onClick={() => {
                if (!dialogOpen()) document.dispatchEvent(new KeyboardEvent("keydown", { key: shortcuts.api.combo, bubbles: true }));
              }}><Code2 size={14} aria-hidden /> API</button>
            </div>
          </header>
        ) : (
          <PageHeader
            back={{ to: "/automations", label: "Automations" }}
            icon={<GitBranch size={20} />}
            tone={enabled ? "success" : "neutral"}
            label="Automation"
            title={row ? row.name : <Skeleton width="medium" />}
            actions={headerActions}
          />
        )}
        <div className="automationNavigation">
          <Tabs
            tabs={[
              { id: "builder", label: "Builder" },
              { id: "runs", label: "Runs" },
              { id: "metrics", label: "Metrics" },
            ]}
            value={tab}
            onChange={setTab}
          />
          {immersive && draft ? <>
            <ViewSwitch value={view} onChange={setView} />
            <DateRange />
            <nav className="learnLinks" aria-label="Learn more">
              <span className="muted"><BookOpen size={14} aria-hidden /> Learn</span>
              {learnLinks("automations").map(({ label, href }) => (
                <a key={href} className="learnChip" href={href} target="_blank" rel="noopener noreferrer">{label}</a>
              ))}
            </nav>
          </> : null}
        </div>
        {immersive && draft && row ? notices : null}
      </div>

      {tab === "runs" && id ? <Runs automationId={id} tree={stored?.tree ?? null} options={options} /> : null}
      {tab === "metrics" && id ? <RunMetrics automationId={id} tree={stored?.tree ?? null} names={options.templateNames} emails={emailMetrics}
        onWinner={winner} winnerBusy={winnerBusy} winnerDisabled={!can || dirty || busy || Boolean(problem) || Boolean(confirmation) || row?.version === undefined || row.status === "disabled"} /> : null}
      {!draft || !row ? (tab === "builder" ? <Skeleton lines={6} /> : null) : (
        <ReentryContext.Provider value={{ value: draft.reentry, onChange: (reentry) => {
          if (locked) return;
          setConfirmation(null);
          setApiError(null);
          setDraft((current) => current ? { ...current, reentry } : current);
        } }}>
          {/* Keep the builder mounted across tabs/views: the draft and contextual selection survive. */}
          <div hidden={tab !== "builder"} className={view === "canvas" && !problem ? "builder wide" : "builder"}>
            {!immersive && tab === "builder" ? notices : null}
            {!immersive && tab === "builder" ? <div className="form builderName">{nameField}</div> : null}
            {!immersive && tab === "builder" && !problem ? <div className="toolbar"><ViewSwitch value={view} onChange={setView} /><DateRange /></div> : null}

            {view === "list" || problem ? (
              <article className="stepCard" aria-label="Trigger">
                <header className="stepHeader">
                  <Tile tone="accent"><Zap size={14} /></Tile>
                  <div className="stepTitle">
                    <strong>{triggerLabels[treeTrigger(draft.tree).type]}</strong>
                    <span className="dim">{triggerSummary(treeTrigger(draft.tree), triggerSources(options))}</span>
                    <span className="mono dim">{draft.tree.trigger}</span>
                  </div>
                </header>
                <div className="form">
                  <TriggerForm config={treeTrigger(draft.tree)} onChange={(config) => edit((tree) => setTrigger(tree, config))}
                    options={options} errors={errors[draft.tree.trigger]} disabled={locked} />
                </div>
              </article>
            ) : null}

            {problem ? <Code value={{ steps: row.steps, connections: row.connections ?? [] }} /> : <>
              <div className="automationCanvas" hidden={view !== "canvas"}>
                <Canvas immersive tree={draft.tree} actions={locked ? undefined : actions} disabled={locked}
                  errors={errors} options={options} onTrigger={(config) => edit((tree) => setTrigger(tree, config))} />
              </div>
              {view === "list" ? <StepList nodes={draft.tree.steps} actions={locked ? undefined : actions}
                disabled={locked} errors={errors} options={options} /> : null}
            </>}
          </div>
        </ReentryContext.Provider>
      )}

      <LeaveGuard when={dirty && !locked} />
      {confirmation && confirmation.draft === draft && paused && can ? (
        <Modal
          isOpen
          title={confirmation.body.status === "enabled" ? "Save and resume automation" : "Save paused automation"}
          onClose={() => setConfirmation(null)}
          onSubmit={() => {
            if (busy || !isCurrent(confirmation)) return;
            void save.mutate(confirmation);
          }}
          submitLabel={confirmation.body.status === "enabled" ? "Save and resume" : "Save changes"}
          submitting={save.isLoading}
          submitDisabled={!isCurrent(confirmation)}
          danger
          size="small"
        >
          <p className="muted">{confirmation.preview.stranded_runs.toLocaleString()} runs are waiting at steps you removed or changed. They will stop.</p>
        </Modal>
      ) : null}
      {(enrolling || enrollmentJob) && row ? <Enroll key={row.id} automation={row} jobId={enrollmentJob}
        onJob={(jobId) => setParams((previous) => { const next = new URLSearchParams(previous); next.set("enroll_job", jobId); return next; })}
        onClose={() => { setEnrolling(false); setParams((previous) => { const next = new URLSearchParams(previous); next.delete("enroll_job"); return next; }); }} /> : null}

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
