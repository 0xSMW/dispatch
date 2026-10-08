import {
  useState,
  type CSSProperties,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import { CheckCircle2 } from "lucide-react";
import type { BrandSettings, Preferences } from "../../types";
import "../../styles/public.css";

export type PreferenceBrand = Preferences["brand"];
export type PreferenceTopic = Preferences["topics"][number];

/** Default copy for the preference page. The settings page previews the same text. */
export const preferenceText = {
  title: "Email preferences",
  description: "Choose the emails you receive.",
  button: "Save preferences",
  updatedTitle: "Preferences updated",
  unsubscribedTitle: "You’re unsubscribed",
  updated: "Your email preferences were updated.",
  unsubscribed: "You have been unsubscribed.",
};

/** The tenant's color as CSS variables. A brand color is data, so it cannot be a theme token. */
export function brandStyle(
  brand: Pick<PreferenceBrand, "color" | "text_color">,
): CSSProperties {
  // Old installations saved Zinc's default as their brand color. Let the neutral
  // default follow the page theme; explicit brand accents keep their own colors.
  if (["#18181b", "#171717"].includes(brand.color.toLowerCase())) return {};
  return {
    "--brand": brand.color,
    "--brand-text": brand.text_color,
  } as CSSProperties;
}

/** Black or white, whichever reads better on `color`. Mirrors `brandTextColor` in @dispatchmail/core. */
export function textColor(color: string): "#ffffff" | "#000000" {
  const hex = /^#[0-9a-f]{6}$/i.test(color) ? color.slice(1) : "171717";
  const channel = (part: string) => {
    const value = Number.parseInt(part, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const lum =
    0.2126 * channel(hex.slice(0, 2)) +
    0.7152 * channel(hex.slice(2, 4)) +
    0.0722 * channel(hex.slice(4, 6));
  const onWhite = 1.05 / (lum + 0.05);
  const onBlack = (lum + 0.05) / 0.05;
  return onWhite >= onBlack ? "#ffffff" : "#000000";
}

/** The page brand from `GET /brand`, with the API's defaults for unset fields. */
export function previewBrand(
  brand: Partial<BrandSettings> | null | undefined,
): PreferenceBrand {
  const color = brand?.unsubscribe_color || brand?.color || "#171717";
  return {
    product_name:
      brand?.product_name || brand?.variables?.PRODUCT_NAME || "Your product",
    logo_url: brand?.unsubscribe_logo_url || brand?.logo_url || null,
    color,
    text_color: textColor(color),
    title: brand?.unsubscribe_title,
    description: brand?.unsubscribe_description,
    button_label: brand?.unsubscribe_button_label,
    updated_title: brand?.unsubscribe_updated_title,
    updated_description: brand?.unsubscribe_updated_description,
    unsubscribed_title: brand?.unsubscribe_unsubscribed_title,
    unsubscribed_description: brand?.unsubscribe_unsubscribed_description,
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
  /** Inside a dashboard page: locally simulate changes without saving recipient preferences. */
  preview?: boolean;
  onDoneChange?: (done: Done) => void;
  onSelect?: (
    field:
      | "title"
      | "description"
      | "button_label"
      | "updated_title"
      | "updated_description"
      | "unsubscribed_title"
      | "unsubscribed_description",
  ) => void;
}

/** The preference page body. The public page drives it; Topics and the settings page render it as a preview. */
export function PreferenceCard(props: PreferenceCardProps) {
  return props.preview ? (
    <PreferencePreview {...props} />
  ) : (
    <PreferenceBody {...props} />
  );
}

function PreferencePreview(props: PreferenceCardProps) {
  const [choices, setChoices] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<Done>(null);
  const checked = { ...props.checked, ...choices };
  const outcome = props.done === undefined ? done : props.done;
  const finish = (next: Done) => {
    setDone(next);
    props.onDoneChange?.(next);
  };
  return (
    <div className="prefPreview">
      <PreferenceBody
        {...props}
        checked={checked}
        done={outcome}
        onToggle={(id) =>
          setChoices((current) => ({ ...current, [id]: !checked[id] }))
        }
        onUpdate={() => finish("updated")}
        onUnsubscribeAll={() => finish("unsubscribed")}
      />
      {outcome && !props.onSelect ? (
        <button
          type="button"
          className="ghost"
          onClick={() => {
            setChoices({});
            finish(null);
          }}
        >
          Reset preview
        </button>
      ) : null}
    </div>
  );
}

function PreferenceBody({
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
  title = brand.title || preferenceText.title,
  description = brand.description || preferenceText.description,
  onSelect,
  preview = false,
}: PreferenceCardProps) {
  const Heading = preview ? "h2" : "h1";
  const selectable = (
    field: Parameters<NonNullable<PreferenceCardProps["onSelect"]>>[0],
  ) =>
    onSelect
      ? {
          tabIndex: 0,
          title: "Edit this text",
          onClick: () => onSelect(field),
          onKeyDown: (event: KeyboardEvent) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onSelect(field);
            }
          },
        }
      : {};
  const header = brand.logo_url ? (
    <img
      className="prefLogo"
      src={brand.logo_url}
      alt={brand.product_name}
      referrerPolicy="no-referrer"
    />
  ) : (
    <div className="prefName">{brand.product_name}</div>
  );

  if (done) {
    return (
      <div className="publicCard" style={brandStyle(brand)}>
        {header}
        <div className="prefDone" role="status">
          <Heading
            className="prefTitle"
            {...selectable(
              done === "updated" ? "updated_title" : "unsubscribed_title",
            )}
          >
            {done === "updated"
              ? brand.updated_title || preferenceText.updatedTitle
              : brand.unsubscribed_title || preferenceText.unsubscribedTitle}
          </Heading>
          <p
            {...selectable(
              done === "updated"
                ? "updated_description"
                : "unsubscribed_description",
            )}
          >
            {done === "updated"
              ? brand.updated_description || preferenceText.updated
              : brand.unsubscribed_description || preferenceText.unsubscribed}
          </p>
          <CheckCircle2 size={28} aria-hidden />
        </div>
      </div>
    );
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (onSelect) onSelect("button_label");
    else onUpdate?.();
  }

  return (
    <form className="publicCard" style={brandStyle(brand)} onSubmit={submit}>
      {header}
      <Heading className="prefTitle" {...selectable("title")}>
        {title}
      </Heading>
      <p className="prefDescription" {...selectable("description")}>
        {description}
      </p>
      {email ? <p className="center muted">{email}</p> : null}
      {topics.length ? (
        <>
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
            {brand.button_label || preferenceText.button}
          </button>
          <p className="prefOr">Or</p>
        </>
      ) : null}
      <button
        type="button"
        className="outlineButton"
        disabled={busy}
        onClick={() => onUnsubscribeAll?.()}
      >
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
