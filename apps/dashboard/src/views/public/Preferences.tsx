import type { CSSProperties, FormEvent } from "react";
import { CheckCircle2 } from "lucide-react";
import type { BrandSettings, Preferences } from "../../types";
import "../../styles/public.css";

export type PreferenceBrand = Preferences["brand"];
export type PreferenceTopic = Preferences["topics"][number];

/** Default copy for the preference page. The settings page previews the same text. */
export const preferenceText = {
  title: "Do you want to unsubscribe?",
  description: "Confirm your preferences:",
  updated: "Your email preferences were updated.",
  unsubscribed: "You have been unsubscribed.",
};

/** The tenant's color as CSS variables. A brand color is data, so it cannot be a theme token. */
export function brandStyle(brand: Pick<PreferenceBrand, "color" | "text_color">): CSSProperties {
  return { "--brand": brand.color, "--brand-text": brand.text_color } as CSSProperties;
}

/** Black or white, whichever reads better on `color`. Mirrors `brandTextColor` in @dispatchmail/core. */
export function textColor(color: string): "#ffffff" | "#000000" {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : "18181b";
  const channel = (part: string) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const lum = 0.2126 * channel(hex.slice(0, 2)) + 0.7152 * channel(hex.slice(2, 4)) + 0.0722 * channel(hex.slice(4, 6));
  const onWhite = 1.05 / (lum + 0.05);
  const onBlack = (lum + 0.05) / 0.05;
  return onWhite >= onBlack ? "#ffffff" : "#000000";
}

/** The page brand from `GET /brand`, with the API's defaults for unset fields. */
export function previewBrand(brand: Partial<BrandSettings> | null | undefined): PreferenceBrand {
  const color = brand?.color || "#18181b";
  return {
    product_name: brand?.product_name || "Your product",
    logo_url: brand?.logo_url || null,
    color,
    text_color: brand?.text_color || textColor(color),
  };
}

export type Done = "updated" | "unsubscribed" | null;

export interface PreferenceCardProps {
  brand: PreferenceBrand;
  email?: string;
  topics: PreferenceTopic[];
  /** Topic id to opted-in. */
  checked: Record<string, boolean>;
  onToggle?: (id: string) => void;
  onUpdate?: () => void;
  onUnsubscribeAll?: () => void;
  busy?: boolean;
  done?: Done;
  error?: string | null;
  title?: string;
  description?: string;
  /** Inside a dashboard page: the heading drops to h2 and the controls do nothing. */
  preview?: boolean;
}

/** The preference page body. The public page drives it; Topics and the settings page render it as a preview. */
export function PreferenceCard({
  brand,
  email,
  topics,
  checked,
  onToggle,
  onUpdate,
  onUnsubscribeAll,
  busy = false,
  done = null,
  error,
  title = preferenceText.title,
  description = preferenceText.description,
  preview = false,
}: PreferenceCardProps) {
  const Heading = preview ? "h2" : "h1";
  const header = brand.logo_url ? (
    <img className="prefLogo" src={brand.logo_url} alt={brand.product_name} referrerPolicy="no-referrer" />
  ) : (
    <div className="prefName">{brand.product_name}</div>
  );

  if (done) {
    return (
      <div className="publicCard" style={brandStyle(brand)}>
        {header}
        <div className="prefDone" role="status">
          <CheckCircle2 size={28} aria-hidden />
          <p>{done === "updated" ? preferenceText.updated : preferenceText.unsubscribed}</p>
        </div>
      </div>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    onUpdate?.();
  }

  return (
    <form className="publicCard" style={brandStyle(brand)} onSubmit={submit}>
      {header}
      <Heading className="prefTitle">{title}</Heading>
      {email ? <p className="center muted">{email}</p> : null}
      {topics.length ? (
        <>
          <p>{description}</p>
          <fieldset className="prefTopics" aria-label="Topics">
            {topics.map((topic) => (
              <label key={topic.id} className="prefTopic">
                <input
                  type="checkbox"
                  checked={Boolean(checked[topic.id])}
                  onChange={() => onToggle?.(topic.id)}
                  disabled={busy}
                />
                <span>{topic.name}</span>
                {topic.description ? <small>{topic.description}</small> : null}
              </label>
            ))}
          </fieldset>
          <button type="submit" className="brandButton" disabled={busy}>
            Update preferences
          </button>
          <p className="prefOr">Or</p>
        </>
      ) : null}
      <button type="button" className="outlineButton" disabled={busy} onClick={() => onUnsubscribeAll?.()}>
        Unsubscribe from all
      </button>
      {error ? (
        <p className="prefError" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
