import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Failed } from "../../components/Empty";
import { PageHeader } from "../../components/PageHeader";
import { Skeleton } from "../../components/Skeleton";
import { Tabs } from "../../components/Tabs";
import { useHotkey } from "../../hooks/useHotkey";
import { useAll, useResource } from "../../hooks/useResource";
import { errorMessage } from "../../lib/client";
import { shortcuts } from "../../lib/shortcuts";
import { useCan, useClient } from "../../shell/session";
import type { BrandSettings, Topic } from "../../types";
import {
  PreferenceCard,
  preferenceText,
  previewBrand,
  type Done,
} from "../public/Preferences";
import { LeaveGuard } from "../templates/editor";
import { settingsTabs } from "../tabs";
import "../../styles/settings.css";
import "../../styles/unsubscribe-editor.css";

const fields = [
  "title",
  "description",
  "button_label",
  "updated_title",
  "updated_description",
  "unsubscribed_title",
  "unsubscribed_description",
  "logo_url",
  "color",
] as const;
type Key = (typeof fields)[number];
type Form = Record<Key, string>;
function toForm(brand: BrandSettings | null): Form {
  return Object.fromEntries(
    fields.map((key) => [key, brand?.[`unsubscribe_${key}`] ?? ""]),
  ) as Form;
}
/** Changed fields only; clearing an override restores its inherited/default value. */
export function pagePatch(form: Form, saved: Form) {
  return Object.fromEntries(
    fields
      .filter((key) => form[key].trim() !== saved[key].trim())
      .map((key) => [`unsubscribe_${key}`, form[key].trim() || null]),
  );
}
function validation(key: Key, value: string): string | null {
  const text = value.trim();
  if (key === "logo_url") {
    if (!text) return null;
    try {
      if (text.startsWith("https://") && new URL(text).protocol === "https:") return null;
    } catch {
      /* Show the field error. */
    }
    return "Use a valid HTTPS URL.";
  }
  if (key === "color")
    return !text || /^#[0-9a-f]{6}$/i.test(text)
      ? null
      : "Use a six-digit hex color, such as #171717.";
  const limit =
    key === "button_label" ? 80 : key.includes("description") ? 500 : 120;
  return text.length > limit ? `Use ${limit} characters or fewer.` : null;
}
function usePageData() {
  const brand = useResource<BrandSettings>("/brand");
  const topics = useAll<Topic>("/topics");
  const visible = (topics.data?.data ?? [])
    .filter((topic) => topic.visibility === "public")
    .map((topic) => ({
      id: topic.id,
      name: topic.name,
      description: topic.description,
      subscription: topic.default_subscription,
    }));
  return { brand, topics, visible };
}
function PageTabs({
  page,
  onChange,
}: {
  page: "preferences" | "success";
  onChange: (page: "preferences" | "success") => void;
}) {
  return (
    <Tabs
      label="Page preview"
      value={page}
      onChange={onChange}
      tabs={[
        { id: "preferences", label: "Preferences" },
        { id: "success", label: "Success" },
      ]}
    />
  );
}
function OutcomeTabs({
  outcome,
  onChange,
}: {
  outcome: Exclude<Done, null>;
  onChange: (value: Exclude<Done, null>) => void;
}) {
  return (
    <Tabs
      label="Success outcome"
      value={outcome}
      onChange={onChange}
      tabs={[
        { id: "updated", label: "Preferences updated" },
        { id: "unsubscribed", label: "Unsubscribed" },
      ]}
    />
  );
}
function PreviewControls({
  width,
  theme,
  onWidth,
  onTheme,
}: {
  width: string;
  theme: string;
  onWidth: (v: "desktop" | "mobile") => void;
  onTheme: (v: "light" | "dark") => void;
}) {
  return (
    <div className="unsubscribePreviewControls">
      <div className="segmented" role="group" aria-label="Preview width">
        {(["desktop", "mobile"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={width === value}
            onClick={() => onWidth(value)}
          >
            {value === "desktop" ? "Desktop" : "Mobile"}
          </button>
        ))}
      </div>
      <div className="segmented" role="group" aria-label="Preview theme">
        {(["light", "dark"] as const).map((value) => (
          <button
            type="button"
            key={value}
            aria-pressed={theme === value}
            onClick={() => onTheme(value)}
          >
            {value === "light" ? "Light" : "Dark"}
          </button>
        ))}
      </div>
    </div>
  );
}

export function UnsubscribePage() {
  const can = useCan();
  const { brand, topics, visible } = usePageData();
  const [page, setPage] = useState<"preferences" | "success">("preferences");
  const [outcome, setOutcome] = useState<Exclude<Done, null>>("updated");
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  return (
    <div className="page settingsPage">
      <PageHeader title="Settings" />
      <Tabs tabs={settingsTabs} />
      <section className="panel unsubscribeSettings">
        <div className="unsubscribeHeading">
          <div>
            <h2>Unsubscribe page</h2>
            <p className="muted">
              Recipients choose their topics or unsubscribe from all emails.
            </p>
          </div>
          <div className="toolbar">
            <Link className="button secondary" to="/audience/topics">
              Manage topics
            </Link>
            {can ? (
              <Link className="button" to="/settings/unsubscribe-page/edit">
                Edit page
              </Link>
            ) : null}
          </div>
        </div>
        <PageTabs page={page} onChange={setPage} />
        {page === "success" ? (
          <OutcomeTabs outcome={outcome} onChange={setOutcome} />
        ) : null}
        <PreviewControls
          width={width}
          theme={theme}
          onWidth={setWidth}
          onTheme={setTheme}
        />
        <aside
          className={`unsubscribeCanvas preferenceTheme ${theme}`}
          aria-label="Preference page preview"
        >
          {brand.error || topics.error ? (
            <Failed
              message={brand.error || topics.error || "Could not load preview."}
              onRetry={() =>
                void Promise.all([brand.reload(), topics.reload()])
              }
            />
          ) : !brand.data || topics.loading ? (
            <Skeleton lines={5} />
          ) : (
            <div className={`unsubscribeViewport ${width}`}>
              <PreferenceCard
                brand={previewBrand(brand.data)}
                email="contact@example.com"
                topics={visible}
                checked={Object.fromEntries(
                  visible.map((topic) => [
                    topic.id,
                    topic.subscription === "opt_in",
                  ]),
                )}
                done={page === "success" ? outcome : null}
                onDoneChange={(done) => {
                  if (done) {
                    setOutcome(done);
                    setPage("success");
                  } else setPage("preferences");
                }}
                preview
              />
            </div>
          )}
        </aside>
        <p className="note">
          Every broadcast includes a link here and supports one-click
          unsubscribe. Public topics are shown, along with private topics a
          contact already receives. Page appearance inherits your{" "}
          <Link to="/settings/brand">brand settings</Link>.
        </p>
      </section>
    </div>
  );
}

export function UnsubscribeEditor() {
  const can = useCan();
  const client = useClient();
  const navigate = useNavigate();
  const { brand, topics, visible } = usePageData();
  const saved = toForm(brand.data);
  const [draft, setDraft] = useState<Form | null>(null);
  const [cancelled, setCancelled] = useState(false);
  useEffect(() => {
    if (cancelled) navigate("/settings/unsubscribe-page");
  }, [cancelled, navigate]);
  const form = draft ?? saved;
  const [page, setPage] = useState<"preferences" | "success">("preferences");
  const [outcome, setOutcome] = useState<Exclude<Done, null>>("updated");
  const [inspector, setInspector] = useState<"content" | "appearance">(
    "content",
  );
  const [selected, setSelected] = useState<Key | null>(null);
  const [width, setWidth] = useState<"desktop" | "mobile">("desktop");
  const [theme, setTheme] = useState<"light" | "dark">("light");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState(false);
  const inputs = useRef<
    Partial<Record<Key, HTMLInputElement | HTMLTextAreaElement | null>>
  >({});
  const body = pagePatch(form, saved);
  const dirty = Object.keys(body).length > 0;
  const invalid = fields.some((key) => validation(key, form[key]));
  const disabled = !can || !brand.data || saving;
  async function save() {
    if (!can || saving || invalid || !dirty) return false;
    setSaving(true);
    setError(null);
    try {
      const result = await client.patch<BrandSettings>("/brand", body);
      brand.setData(result);
      setDraft(null);
      setSavedMessage(true);
      return true;
    } catch (cause) {
      setError(errorMessage(cause));
      return false;
    } finally {
      setSaving(false);
    }
  }
  useHotkey(shortcuts.save.combo, () => void save(), {
    enabled: can && dirty && !invalid && !saving,
  });
  const preview = previewBrand({
    ...brand.data,
    ...Object.fromEntries(
      fields.map((key) => [
        `unsubscribe_${key}`,
        (key === "logo_url" || key === "color") && validation(key, form[key]) ? null : form[key].trim() || null,
      ]),
    ),
  });
  function select(key: Key) {
    setSelected(key);
    setInspector("content");
    // The inspector tab may need to mount before its field can receive focus.
    requestAnimationFrame(() => inputs.current[key]?.focus());
  }
  const contentKeys: Key[] =
    page === "preferences"
      ? ["title", "description", "button_label"]
      : outcome === "updated"
        ? ["updated_title", "updated_description"]
        : ["unsubscribed_title", "unsubscribed_description"];
  const defaults: Partial<Record<Key, string>> = {
    title: preferenceText.title,
    description: preferenceText.description,
    button_label: preferenceText.button,
    updated_title: preferenceText.updatedTitle,
    updated_description: preferenceText.updated,
    unsubscribed_title: preferenceText.unsubscribedTitle,
    unsubscribed_description: preferenceText.unsubscribed,
  };
  const labels: Record<Key, string> = {
    title: "Title",
    description: "Description",
    button_label: "Button label",
    updated_title: "Title",
    updated_description: "Description",
    unsubscribed_title: "Title",
    unsubscribed_description: "Description",
    logo_url: "Page logo URL",
    color: "Accent color",
  };
  function field(key: Key) {
    const props = {
      id: `unsubscribe-${key}`,
      value: form[key],
      placeholder:
        defaults[key] ??
        (key === "logo_url"
          ? brand.data?.logo_url || "https://example.com/logo.png"
          : brand.data?.color || "#171717"),
      disabled,
      "aria-invalid": Boolean(validation(key, form[key])),
      onChange: (
        event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
      ) => {
        setDraft({ ...form, [key]: event.target.value });
        setSavedMessage(false);
      },
      onFocus: () => setSelected(key),
    };
    return (
      <div className={`field ${selected === key ? "selected" : ""}`} key={key}>
        <label htmlFor={props.id}>{labels[key]}</label>
        {key.includes("description") ? (
          <textarea
            {...props}
            rows={4}
            ref={(node) => {
              inputs.current[key] = node;
            }}
          />
        ) : (
          <input
            {...props}
            type="text"
            ref={(node) => {
              inputs.current[key] = node;
            }}
          />
        )}
        {validation(key, form[key]) ? (
          <span className="fieldError" role="alert">
            {validation(key, form[key])}
          </span>
        ) : null}
      </div>
    );
  }
  return (
    <div className="unsubscribeEditor">
      <header className="unsubscribeEditorBar">
        <Link
          to="/settings/unsubscribe-page"
          aria-disabled={saving}
          onClick={(event) => {
            if (saving) event.preventDefault();
          }}
        >
          ← Back
        </Link>
        <PageTabs page={page} onChange={setPage} />
        <div className="toolbar">
          <span className="muted" role="status">
            {saving
              ? "Saving…"
              : dirty
                ? "Unsaved changes"
                : savedMessage
                  ? "Saved"
                  : can
                    ? "All changes saved"
                    : "View only"}
          </span>
          {can ? (
            <>
              <button
                type="button"
                className="secondary"
                disabled={saving}
                onClick={() => {
                  setDraft(null);
                  setCancelled(true);
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={disabled || !dirty || invalid}
                onClick={() => void save()}
              >
                Save
              </button>
            </>
          ) : null}
        </div>
      </header>
      <div className="unsubscribeEditorBody">
        <main className="unsubscribeEditorMain">
          {page === "success" ? (
            <OutcomeTabs outcome={outcome} onChange={setOutcome} />
          ) : null}
          <PreviewControls
            width={width}
            theme={theme}
            onWidth={setWidth}
            onTheme={setTheme}
          />
          <div
            className={`unsubscribeCanvas preferenceTheme ${theme}`}
            aria-label="Preference page preview"
          >
            {brand.error || topics.error ? (
              <Failed
                message={
                  brand.error || topics.error || "Could not load preview."
                }
                onRetry={() =>
                  void Promise.all([brand.reload(), topics.reload()])
                }
              />
            ) : !brand.data || topics.loading ? (
              <Skeleton lines={5} />
            ) : (
              <div className={`unsubscribeViewport ${width}`}>
                <PreferenceCard
                  brand={preview}
                  email="contact@example.com"
                  topics={visible}
                  checked={Object.fromEntries(
                    visible.map((topic) => [
                      topic.id,
                      topic.subscription === "opt_in",
                    ]),
                  )}
                  done={page === "success" ? outcome : null}
                  busy={saving}
                  preview
                  onSelect={can && !saving ? select : undefined}
                  onDoneChange={(done) => {
                    if (done) {
                      setOutcome(done);
                      setPage("success");
                    } else setPage("preferences");
                  }}
                />
              </div>
            )}
          </div>
        </main>
        <aside className="unsubscribeInspector" aria-label="Page inspector">
          <Tabs
            label="Inspector"
            value={inspector}
            onChange={setInspector}
            tabs={[
              { id: "content", label: "Content" },
              { id: "appearance", label: "Appearance" },
            ]}
          />
          <div className="stack">
            {inspector === "content" ? (
              <>
                {contentKeys.map(field)}
                <p className="note">
                  Leave a field empty to use the default text.
                </p>
              </>
            ) : (
              <>
                {field("logo_url")}
                {field("color")}
                <p className="note">
                  Leave these empty to inherit your brand’s logo and color.
                  These overrides apply only to this page.
                </p>
                <Link to="/settings/brand">Brand settings</Link>
              </>
            )}
            {error ? (
              <p className="alert" role="alert">
                {error}
              </p>
            ) : null}
          </div>
        </aside>
      </div>
      <LeaveGuard
        when={dirty || saving}
        onSave={!invalid && !saving ? save : undefined}
      />
    </div>
  );
}
