import type * as React from "react";
import { CheckCircle2 } from "lucide-react";
import { brandStyle, type PreferenceBrand } from "./Preferences";

export interface ConfirmCardProps {
  brand: PreferenceBrand;
  formName: string;
  onConfirm?: () => void;
  busy?: boolean;
  done?: boolean;
  error?: string | null;
  preview?: boolean;
}

export function ConfirmCard({
  brand, formName, onConfirm, busy = false, done = false, error, preview = false,
}: ConfirmCardProps): React.JSX.Element {
  const Heading = preview ? "h2" : "h1";
  const inactive = busy || preview || done || !onConfirm;
  const header = brand.logo_url ? (
    <img className="prefLogo" src={brand.logo_url} alt={brand.product_name} referrerPolicy="no-referrer" />
  ) : (
    <div className="prefName">{brand.product_name}</div>
  );

  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!inactive) onConfirm?.();
  }

  return (
    <form className="publicCard" style={brandStyle(brand)} onSubmit={submit} aria-busy={busy}>
      {header}
      <Heading className="prefTitle">{formName}</Heading>
      {done ? (
        <div className="prefDone" role="status">
          <CheckCircle2 size={28} aria-hidden />
          <p>Thank you! Your subscription is confirmed.</p>
        </div>
      ) : (
        <>
          <p className="center">Confirm your subscription.</p>
          <button type="submit" className="brandButton" disabled={inactive}>Confirm</button>
          {busy ? <p className="center muted" role="status">Confirming…</p> : null}
        </>
      )}
      {error ? <p className="prefError" role="alert">{error}</p> : null}
    </form>
  );
}
