import { Link } from "react-router-dom";
import { useEffect, useState, type CSSProperties, type FormEvent } from "react";
import { assertBrandContrast, brandSchema, emailFonts, resolvedTheme, themeContext, themeDefaults } from "../../../../../packages/core/src/brand";
import { EmailFrame } from "../../components/EmailFrame";
import { Empty, Failed } from "../../components/Empty";
import { Field, Select, TextArea } from "../../components/Field";
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
import type { BrandSettings, LibraryUpdates, List, Rendered } from "../../types";
import { textColor } from "../public/Preferences";
import { settingsTabs } from "../tabs";
import "../../styles/settings.css";

const legacyKeys = [
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
const tokenKeys = ["text_color", "background_color", "surface_color", "border_color", "font_family", "font_size", "radius", "button_style"] as const;
const keys = [...legacyKeys, ...tokenKeys];
type Key = (typeof keys)[number];
// Optional tokens keep the original field helpers compatible with legacy callers.
type Form = Record<(typeof legacyKeys)[number], string> & Partial<Record<(typeof tokenKeys)[number], string>>;
type Errors = Partial<Record<Key | "theme", string>>;

/** Only these accept null, which clears them. The rest keep their value once set. */
const nullable: Key[] = ["logo_url", "support_url", "privacy_url"];
const urls: Key[] = ["product_url", "logo_url", "support_url", "privacy_url"];
const fallbackColor = "#18181b";

function toForm(brand: BrandSettings | null): Form {
  const theme = resolvedTheme(brand ?? {});
  return Object.fromEntries(keys.map((key) => [key, String(brand?.[key] ?? (key in theme ? theme[key as keyof typeof theme] : ""))])) as Form;
}

/** Validate the merged draft, including saved settings outside this form. */
export function brandErrors(form: Form, saved: Form, brand?: BrandSettings | null): Errors {
  const errors: Errors = {};
  for (const key of urls) {
    if (form[key] && !/^https:\/\/\S+$/.test(form[key])) errors[key] = "Use an https:// URL.";
  }
  if (form.color && !/^#[0-9a-fA-F]{6}$/.test(form.color)) errors.color = "Use a six-digit hex color, such as #1f7a4d.";
  if (form.support_email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(form.support_email)) errors.support_email = "Enter an email address.";
  for (const key of keys) {
    if (!nullable.includes(key) && saved[key] && !form[key]?.trim()) errors[key] = "This cannot be cleared once set.";
  }
  const merged: Record<string, unknown> = Object.fromEntries(
    Object.keys(brandSchema.shape).filter((key) => brand && key in brand).map((key) => [key, brand![key as keyof BrandSettings]]),
  );
  for (const key of keys) {
    if (form[key] === undefined) continue;
    const value = form[key]!.trim();
    if (tokenKeys.includes(key as (typeof tokenKeys)[number]) || value) merged[key] = fieldValue(key, value);
    else if (nullable.includes(key)) merged[key] = null;
    else delete merged[key];
  }
  const result = brandSchema.safeParse(merged);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const key = issue.path[0] as Key;
      errors[key] ??= issue.message;
    }
  } else {
    try {
      assertBrandContrast(result.data);
    } catch (error) {
      errors.theme = error instanceof Error ? error.message : "The theme needs at least 4.5:1 contrast.";
    }
  }
  return errors;
}

function fieldValue(key: Key, value: string): string | number {
  return key === "font_size" || key === "radius" ? (value ? Number(value) : NaN) : value;
}

/** The `PATCH /brand` body: changed fields only, with cleared nullable fields as null. */
export function brandPatch(form: Form, saved: Form) {
  const body: Record<string, string | number | null> = {};
  for (const key of keys) {
    if (form[key] === undefined) continue;
    const value = form[key]!.trim();
    if (value === saved[key]?.trim()) continue;
    if (value) body[key] = fieldValue(key, value);
    else if (nullable.includes(key)) body[key] = null;
  }
  return body;
}

/** Invalid CSS values never reach the synthetic preview; valid draft tokens apply immediately. */
function previewBrand(form: Form) {
  const values = Object.fromEntries(keys.map((key) => [key, fieldValue(key, form[key]?.trim() ?? "")]));
  return Object.fromEntries(["color", ...tokenKeys].flatMap((key) => {
    const value = brandSchema.shape[key as "color" | (typeof tokenKeys)[number]].safeParse(values[key]);
    return value.success ? [[key, value.data]] : [];
  }));
}

type LibraryPreview = { slug: string; name: string; rendered?: Rendered; preview?: Rendered };

/** Brand settings: used by the default templates and the public pages. */
export function Brand() {
  const client = useClient();
  const can = useCan();
  const brand = useResource<BrandSettings>("/brand");
  const saved = toForm(brand.data);
  // A draft belongs to the loaded row. New data replaces it during rendering, not in an
  // effect that could run after the user's first edit and erase that edit.
  const [draft, setDraft] = useState<{ source: BrandSettings | null; form: Form } | null>(null);
  const form = draft && draft.source === brand.data ? draft.form : saved;
  const [preview, setPreview] = useState(0);

  const errors = brandErrors(form, saved, brand.data);
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
  const update = useMutation(() => client.post<LibraryUpdates>("/brand/update-library"), {
    success: (data) => `${data.updated.length} templates updated; ${data.skipped.length} skipped.`,
    onSuccess: () => setPreview((value) => value + 1),
  });
  const busy = save.isLoading || update.isLoading;
  useHotkey(shortcuts.save.combo, () => void save.mutate(), { enabled: can && dirty && !invalid && !busy });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (can && dirty && !invalid && !busy) void save.mutate();
  }

  const set = (key: Key) => (value: string) => setDraft({ source: brand.data, form: { ...form, [key]: value } });
  const color = /^#[0-9a-fA-F]{6}$/.test(form.color) ? form.color : fallbackColor;
  const localBrand = previewBrand(form);
  const theme = resolvedTheme(localBrand);
  const context = themeContext(localBrand);
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
              <fieldset className="form two" disabled={!can || busy}>
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
                  <span className="fieldHint">Public-page button text</span>
                  <div className="brandSample" style={sample}>
                    <button type="button" className="sampleButton" tabIndex={-1} aria-label="Sample button">
                      Get started
                    </button>
                    <span className="fieldHint">
                      Text on this color is {textColor(color) === "#ffffff" ? "white" : "black"}, picked for contrast.
                      {brand.data.button_text_color ? ` Saved: ${brand.data.button_text_color}.` : ""}
                    </span>
                  </div>
                </div>
                {(["text_color", "background_color", "surface_color", "border_color"] as const).map((key) => (
                  <div className="field" key={key}>
                    <label htmlFor={`brand-${key}`}>{({ text_color: "Text color", background_color: "Background color", surface_color: "Surface color", border_color: "Border color" })[key]}</label>
                    <div className="colorField">
                      <input type="color" aria-label={`Pick ${key.replace("_", " ")}`} value={theme[key]} onChange={(event) => set(key)(event.target.value)} />
                      <input id={`brand-${key}`} className="mono" value={form[key] ?? ""} onChange={(event) => set(key)(event.target.value)} aria-invalid={errors[key] ? true : undefined} />
                    </div>
                    {errors[key] ? <span className="fieldError" role="alert">{errors[key]}</span> : null}
                  </div>
                ))}
                <Select label="Font family" value={form.font_family ?? themeDefaults.font_family} onChange={set("font_family")} options={emailFonts.map((value, index) => ({ value, label: ["System sans-serif", "Arial", "Georgia", "Courier New"][index]! }))} error={errors.font_family} wide />
                <Field label="Font size" type="number" step={1} value={form.font_size ?? ""} onChange={set("font_size")} hint="14–18 px" error={errors.font_size} />
                <Field label="Radius" type="number" step={1} value={form.radius ?? ""} onChange={set("radius")} hint="0–16 px" error={errors.radius} />
                <Select label="Button style" value={form.button_style ?? "filled"} onChange={set("button_style")} options={[{ value: "filled", label: "Filled" }, { value: "outline", label: "Outline" }]} error={errors.button_style} />
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
              {errors.theme ? <p className="fieldError" role="alert">{errors.theme}</p> : null}
              {can ? (
                <div className="toolbar">
                  <button type="submit" disabled={!dirty || invalid || busy} aria-busy={save.isLoading}>
                    {save.isLoading ? <span className="spinner" aria-hidden /> : null}
                    Save <kbd>{metaKey}S</kbd>
                  </button>
                  {dirty ? (
                    <button type="button" className="ghost" disabled={busy} onClick={() => setDraft(null)}>
                      Discard
                    </button>
                  ) : null}
                </div>
              ) : null}
            </form>
            {can ? (
              <div className="stack">
                <p className="muted">Installed library templates keep their HTML until you explicitly update them. Edited templates are skipped.</p>
                <button type="button" className="ghost" disabled={dirty || invalid || busy} aria-busy={update.isLoading} onClick={() => {
                  if (can && !dirty && !invalid && !busy) void update.mutate();
                }}>Update library templates</button>
                {dirty ? <p className="note">Save or discard your changes before updating library templates.</p> : null}
              </div>
            ) : null}
            {update.error ? <p className="fieldError" role="alert">{update.error.message}</p> : null}
            {update.data ? (
              <div className="stack" role="status">
                <p>{update.data.updated.length} templates updated; {update.data.skipped.length} skipped.</p>
                {update.data.skipped.length ? (
                  <ul aria-label="Skipped templates">
                    {update.data.skipped.map((item) => <li key={item.id}>{item.name} ({item.slug}): {item.reason || "Not eligible for a library update."}</li>)}
                  </ul>
                ) : null}
              </div>
            ) : null}
          </Panel>
          <div className="stack">
            <Panel title="Live draft preview">
              <p className="note">A local sample of these tokens. The saved library preview below changes only after saving.</p>
              <div aria-label="Live email preview" style={{ background: theme.background_color, color: theme.text_color, fontFamily: theme.font_family, fontSize: theme.font_size, padding: 20 }}>
                <p style={{ margin: "0 0 16px" }}>{form.product_name || "Your product"}</p>
                <div style={{ background: theme.surface_color, border: `1px solid ${theme.border_color}`, borderRadius: theme.radius, padding: 20 }}>
                  <h2 style={{ color: "inherit", fontSize: "1.25em", margin: "0 0 12px" }}>Welcome aboard</h2>
                  <p style={{ margin: "0 0 16px" }}>Your account is ready. Here is a sample of your email body text.</p>
                  <span style={{ display: "inline-block", background: context.THEME_BUTTON_BACKGROUND, color: context.THEME_BUTTON_TEXT_COLOR, border: context.THEME_BUTTON_BORDER, borderRadius: theme.radius, fontSize: "inherit", padding: "10px 18px" }}>Get started</span>
                </div>
                <p style={{ fontSize: "0.85em", margin: "16px 0 0" }}>{form.company_name || "Your company"}{form.company_address ? ` · ${form.company_address}` : ""}</p>
              </div>
            </Panel>
            <TemplatePreview version={preview} />
          </div>
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
        html ? <button type="button" className="ghost small" onClick={() => setWidth(width === "desktop" ? "phone" : "desktop")}>
          {width === "desktop" ? "Phone width" : "Desktop width"}
        </button> : null
      }
    >
      <div className="previewFrame">
        {library.error || entry.error ? (
          <Empty compact title="Preview unavailable" body={<>The template library isn't available right now. {library.error ?? entry.error}</>} action={<Link to="/templates/library">Browse library</Link>} />
        ) : library.data && !slug ? (
          <Empty compact title="No preview available" body="The template library is empty." action={<Link to="/templates/library">Browse library</Link>} />
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
