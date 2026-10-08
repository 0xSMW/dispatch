import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { Failed } from "../../components/Empty";
import { Field, TextArea } from "../../components/Field";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Tabs } from "../../components/Tabs";
import { useHotkey } from "../../hooks/useHotkey";
import { useMutation } from "../../hooks/useMutation";
import { useAll, useResource } from "../../hooks/useResource";
import { metaKey } from "../../components/Kbd";
import { shortcuts } from "../../lib/shortcuts";
import { useCan, useClient } from "../../shell/session";
import type { BrandSettings, Topic } from "../../types";
import { PreferenceCard, preferenceText, previewBrand } from "../public/Preferences";
import { settingsTabs } from "../tabs";
import "../../styles/audience.css";
import "../../styles/settings.css";

type Form = { title: string; description: string };

function toForm(brand: BrandSettings | null): Form {
  return { title: brand?.unsubscribe_title ?? "", description: brand?.unsubscribe_description ?? "" };
}

/** The `PATCH /brand` body: changed fields only. An emptied field is sent as null, which goes back to the default. */
export function pagePatch(form: Form, saved: Form) {
  const body: Record<string, string | null> = {};
  if (form.title.trim() !== saved.title) body.unsubscribe_title = form.title.trim() || null;
  if (form.description.trim() !== saved.description) body.unsubscribe_description = form.description.trim() || null;
  return body;
}

/**
 * The preference page as recipients see it: its title and description, with a live
 * preview. Logo and color come from brand settings. An empty field uses the default text.
 */
export function UnsubscribePage() {
  const client = useClient();
  const can = useCan();
  const brand = useResource<BrandSettings>("/brand");
  const topics = useAll<Topic>("/topics");
  const saved = toForm(brand.data);
  // null until the user edits; a fresh load or a save drops the draft.
  const [draft, setDraft] = useState<Form | null>(null);
  const form = draft ?? saved;
  useEffect(() => setDraft(null), [brand.data]);

  const body = pagePatch(form, saved);
  const dirty = Object.keys(body).length > 0;
  const tooLong = form.title.trim().length > 120 || form.description.trim().length > 500;
  const save = useMutation(() => client.patch<BrandSettings>("/brand", body), {
    success: "Unsubscribe page saved.",
    onSuccess: (data) => brand.setData(data),
  });
  useHotkey(shortcuts.save.combo, () => void save.mutate(), { enabled: can && dirty && !tooLong && !save.isLoading });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dirty && !tooLong) void save.mutate();
  }

  const visible = (topics.data?.data ?? [])
    .filter((topic) => topic.visibility === "public")
    .map((topic) => ({ id: topic.id, name: topic.name, description: topic.description, subscription: topic.default_subscription }));
  const error = brand.error ?? topics.error;

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <Tabs tabs={settingsTabs} />
      <div className="settingsSplit">
        <Panel title="Unsubscribe page">
          <form className="stack" onSubmit={submit}>
            <p className="muted">
              Every broadcast links here through <span className="mono">{"{{{RESEND_UNSUBSCRIBE_URL}}}"}</span> and adds one-click
              unsubscribe headers. Contacts see public topics, plus private topics they already receive.
            </p>
            <div className="form">
              <Field
                label="Title"
                value={form.title}
                onChange={(title) => setDraft({ ...form, title })}
                placeholder={preferenceText.title}
                error={form.title.trim().length > 120 ? "Use 120 characters or fewer." : null}
                disabled={!can || !brand.data}
              />
              <TextArea
                label="Description"
                value={form.description}
                onChange={(description) => setDraft({ ...form, description })}
                rows={3}
                placeholder={preferenceText.description}
                error={form.description.trim().length > 500 ? "Use 500 characters or fewer." : null}
                hint="Shown above the list of topics. Leave either field empty to use the default text."
                disabled={!can || !brand.data}
              />
            </div>
            {can ? (
              <div className="toolbar">
                <button type="submit" disabled={!dirty || tooLong || save.isLoading} aria-busy={save.isLoading}>
                  {save.isLoading ? <span className="spinner" aria-hidden /> : null}
                  Save <kbd>{metaKey}S</kbd>
                </button>
                {dirty ? (
                  <button type="button" className="ghost" onClick={() => setDraft(null)}>
                    Discard
                  </button>
                ) : null}
              </div>
            ) : null}
            <p className="note">
              Change the logo and color in <Link to="/settings/brand">brand settings</Link>, and the topics in{" "}
              <Link to="/audience/topics">Topics</Link>.
            </p>
          </form>
        </Panel>
        <aside className="previewPane" aria-label="Preference page preview">
          <span className="previewLabel">Preview</span>
          {error ? (
            <Failed message={error} onRetry={() => void Promise.all([brand.reload(), topics.reload()])} />
          ) : (brand.loading && !brand.data) || topics.loading ? (
            <Skeleton lines={5} />
          ) : (
            <PreferenceCard
              brand={previewBrand(brand.data)}
              email="contact@example.com"
              topics={visible}
              checked={Object.fromEntries(visible.map((topic) => [topic.id, topic.subscription === "opt_in"]))}
              title={form.title.trim() || undefined}
              description={form.description.trim() || undefined}
              preview
            />
          )}
        </aside>
      </div>
    </div>
  );
}
