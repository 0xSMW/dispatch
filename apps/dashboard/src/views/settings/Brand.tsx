import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { EmailFrame } from "../../components/EmailFrame";
import { Failed } from "../../components/Empty";
import { Field, TextArea } from "../../components/Field";
import { metaKey } from "../../components/Kbd";
import { PageHeader } from "../../components/PageHeader";
import { Panel } from "../../components/Panel";
import { Skeleton } from "../../components/Skeleton";
import { Tabs } from "../../components/Tabs";
import { useHotkey } from "../../hooks/useHotkey";
import { shortcuts } from "../../lib/shortcuts";
import { useMutation } from "../../hooks/useMutation";
import { useResource } from "../../hooks/useResource";
import { useCan, useClient } from "../../shell/session";
import type { BrandSettings, List, Rendered } from "../../types";
import { textColor } from "../public/Preferences";
import { settingsTabs } from "../tabs";
import "../../styles/settings.css";

const keys = [
  "product_name",
  "product_url",
  "logo_url",
  "color",
  "support_email",
  "support_url",
  "privacy_url",
  "company_name",
  "company_address",
] as const;
type Key = (typeof keys)[number];
type Form = Record<Key, string>;

/** Only these accept null, which clears them. The rest keep their value once set. */
const nullable: Key[] = ["logo_url", "support_url", "privacy_url"];
const urls: Key[] = ["product_url", "logo_url", "support_url", "privacy_url"];
const fallbackColor = "#18181b";

function toForm(brand: BrandSettings | null): Form {
  return Object.fromEntries(keys.map((key) => [key, (brand?.[key] as string | null | undefined) ?? ""])) as Form;
}

/** Field errors, matching `brandSchema` in @dispatchmail/core. */
export function brandErrors(form: Form, saved: Form): Partial<Record<Key, string>> {
  const errors: Partial<Record<Key, string>> = {};
  for (const key of urls) {
    if (form[key] && !/^https:\/\/\S+$/.test(form[key])) errors[key] = "Use an https:// URL.";
  }
  if (form.color && !/^#[0-9a-fA-F]{6}$/.test(form.color)) errors.color = "Use a six-digit hex color, such as #1f7a4d.";
  if (form.support_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.support_email)) errors.support_email = "Enter an email address.";
  for (const key of keys) {
    if (!nullable.includes(key) && saved[key] && !form[key].trim()) errors[key] = "This cannot be cleared once set.";
  }
  return errors;
}

/** The `PATCH /brand` body: changed fields only, with cleared nullable fields as null. */
export function brandPatch(form: Form, saved: Form) {
  const body: Record<string, string | null> = {};
  for (const key of keys) {
    const value = form[key].trim();
    if (value === saved[key]) continue;
    if (value) body[key] = value;
    else if (nullable.includes(key)) body[key] = null;
  }
  return body;
}

type LibraryPreview = { slug: string; name: string; rendered?: Rendered; preview?: Rendered };

/** Brand settings: used by the default templates and the public pages. */
export function Brand() {
  const client = useClient();
  const can = useCan();
  const brand = useResource<BrandSettings>("/brand");
  const saved = toForm(brand.data);
  // null until the user edits; a fresh load or a save drops the draft.
  const [draft, setDraft] = useState<Form | null>(null);
  const form = draft ?? saved;
  const [preview, setPreview] = useState(0);
  useEffect(() => setDraft(null), [brand.data]);

  const errors = brandErrors(form, saved);
  const body = brandPatch(form, saved);
  const dirty = Object.keys(body).length > 0;
  const invalid = Object.keys(errors).length > 0;

  const save = useMutation(() => client.patch<BrandSettings>("/brand", body), {
    success: "Brand saved.",
    onSuccess: (data) => {
      brand.setData(data);
      setPreview((value) => value + 1);
    },
  });
  useHotkey(shortcuts.save.combo, () => void save.mutate(), { enabled: can && dirty && !invalid && !save.isLoading });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (dirty && !invalid) void save.mutate();
  }

  const set = (key: Key) => (value: string) => setDraft({ ...form, [key]: value });
  const color = /^#[0-9a-fA-F]{6}$/.test(form.color) ? form.color : fallbackColor;
  const sample = { "--brand": color, "--brand-text": textColor(color) } as CSSProperties;

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <Tabs tabs={settingsTabs} />
      {brand.error ? <Failed message={brand.error} onRetry={brand.reload} /> : null}
      {!brand.data && !brand.error ? <Skeleton lines={4} /> : null}
      {brand.data ? (
        <div className="settingsSplit">
          <Panel title="Brand">
            <form className="stack" onSubmit={submit}>
              <p className="muted">The default templates, the preference page, and the shared email page use these values.</p>
              <fieldset className="form two" disabled={!can}>
                <Field label="Product name" value={form.product_name} onChange={set("product_name")} error={errors.product_name} />
                <Field label="Product URL" type="url" value={form.product_url} onChange={set("product_url")} placeholder="https://example.com" error={errors.product_url} />
                <Field
                  label="Logo URL"
                  type="url"
                  value={form.logo_url}
                  onChange={set("logo_url")}
                  placeholder="https://example.com/logo.png"
                  error={errors.logo_url}
                  hint="A PNG or SVG on https. Leave empty to show the product name."
                  wide
                />
                <div className="field">
                  <label htmlFor="brand-color">Brand color</label>
                  <div className="colorField">
                    <input type="color" aria-label="Pick a color" value={color} onChange={(event) => set("color")(event.target.value)} />
                    <input
                      id="brand-color"
                      type="text"
                      className="mono"
                      value={form.color}
                      placeholder={fallbackColor}
                      onChange={(event) => set("color")(event.target.value)}
                      aria-invalid={errors.color ? true : undefined}
                    />
                  </div>
                  {errors.color ? <span className="fieldError" role="alert">{errors.color}</span> : null}
                </div>
                <div className="field">
                  <span className="fieldHint">Button text</span>
                  <div className="brandSample" style={sample}>
                    <button type="button" className="sampleButton" tabIndex={-1} aria-label="Sample button">
                      Get started
                    </button>
                    <span className="fieldHint">
                      Text on this color is {textColor(color) === "#ffffff" ? "white" : "black"}, picked for contrast.
                      {brand.data.text_color ? ` Saved: ${brand.data.text_color}.` : ""}
                    </span>
                  </div>
                </div>
                <Field label="Support email" type="email" value={form.support_email} onChange={set("support_email")} error={errors.support_email} />
                <Field label="Support URL" type="url" value={form.support_url} onChange={set("support_url")} placeholder="https://example.com/help" error={errors.support_url} />
                <Field
                  label="Privacy policy URL"
                  type="url"
                  value={form.privacy_url}
                  onChange={set("privacy_url")}
                  placeholder="https://example.com/privacy"
                  error={errors.privacy_url}
                  hint="Linked from the footer of the default templates. Receipts and invoices should have one."
                  wide
                />
                <Field label="Company name" value={form.company_name} onChange={set("company_name")} error={errors.company_name} wide />
                <TextArea
                  label="Company address"
                  value={form.company_address}
                  onChange={set("company_address")}
                  rows={3}
                  error={errors.company_address}
                  hint="Postal address for the footer of marketing email."
                  wide
                />
              </fieldset>
              {can ? (
                <div className="toolbar">
                  <button type="submit" disabled={!dirty || invalid || save.isLoading} aria-busy={save.isLoading}>
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
            </form>
          </Panel>
          <TemplatePreview version={preview} />
        </div>
      ) : null}
    </div>
  );
}

/** One default template rendered with the saved brand. It refreshes after each save. */
function TemplatePreview({ version }: { version: number }) {
  const library = useResource<List<{ slug: string; name: string }>>("/template-library");
  const slug = library.data?.data.find((entry) => entry.slug === "welcome")?.slug ?? library.data?.data[0]?.slug ?? null;
  const entry = useResource<LibraryPreview>(slug ? `/template-library/${slug}` : null);
  const [width, setWidth] = useState<"desktop" | "phone">("desktop");

  useEffect(() => {
    if (version) void entry.reload();
    // reload after a save only
  }, [version]);

  const html = (entry.data?.rendered ?? entry.data?.preview)?.html;

  return (
    <Panel
      title="Preview"
      actions={
        <button type="button" className="ghost small" onClick={() => setWidth(width === "desktop" ? "phone" : "desktop")}>
          {width === "desktop" ? "Phone width" : "Desktop width"}
        </button>
      }
    >
      <div className="previewFrame">
        {library.error || entry.error ? (
          <p className="note">The template library is not available, so there is no preview. {library.error ?? entry.error}</p>
        ) : library.data && !slug ? (
          <p className="note">The template library is empty.</p>
        ) : html ? (
          <>
            <div className="previewHead">
              <span>{entry.data?.name}</span>
              <span>Saved brand</span>
            </div>
            <EmailFrame html={html} width={width} />
          </>
        ) : (
          <Skeleton lines={6} />
        )}
      </div>
    </Panel>
  );
}
