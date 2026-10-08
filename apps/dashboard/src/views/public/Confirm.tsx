import type * as React from "react";
import { Check, LoaderCircle } from "lucide-react";
import type { PreferenceBrand } from "./Preferences";

export interface ConfirmCardProps {
  brand?: PreferenceBrand;
  formName?: string;
  onConfirm?: () => void;
  onRetry?: () => void;
  busy?: boolean;
  done?: boolean;
  loading?: boolean;
  missing?: boolean;
  loadError?: boolean;
  redirecting?: boolean;
  error?: string | null;
  preview?: boolean;
}

export function ConfirmCard({ brand, onConfirm, onRetry, busy = false, done = false,
  loading = false, missing = false, loadError = false, redirecting = false, error, preview = false,
}: ConfirmCardProps): React.JSX.Element {
  const Heading = preview ? "h2" : "h1";
  const title = loading ? "Checking your link" : missing ? "This link is unavailable"
    : loadError ? "Unable to load confirmation" : done ? "You're subscribed" : "Confirm your subscription";
  const description = loading ? "Your confirmation will be ready in a moment."
    : missing ? "Use the link in your latest confirmation email."
    : loadError ? "We couldn't load your confirmation. Please try again."
    : error ? "We couldn't confirm your subscription. Please try again."
    : done ? `Your subscription to ${brand?.product_name ?? "this newsletter"} is confirmed.`
    : `Confirm to receive email updates from ${brand?.product_name ?? "this newsletter"}.`;
  const phase = loading ? "loading" : missing ? "missing" : loadError ? "error" : done ? "done" : error ? "retry" : "ready";
  function submit(event: React.FormEvent) {
    event.preventDefault();
    if (preview || busy || loading || done || missing) return;
    if (loadError) onRetry?.(); else onConfirm?.();
  }
  return (
    <form className="publicCard confirmCard" onSubmit={submit} aria-busy={busy || loading}>
      <div className="confirmBrand">
        {brand?.logo_url ? <img className="prefLogo" src={brand.logo_url} alt={brand.product_name} referrerPolicy="no-referrer" />
          : brand ? <span>{brand.product_name}</span> : <span aria-hidden className="confirmBrandPlaceholder" />}
      </div>
      <div className="confirmCopy" key={phase} aria-live="polite" aria-atomic="true">
        <Heading className="prefTitle">{title}</Heading>
        <p role={error || loadError ? "alert" : undefined}>{description}</p>
      </div>
      <div className="confirmAction">
        {done ? <div className="confirmComplete" role="status"><Check size={18} aria-hidden />Subscription active</div>
          : missing ? <div className="confirmUnavailable">A valid confirmation link is required.</div>
          : <button type="submit" disabled={preview || busy || loading || (!loadError && !onConfirm)}>
            {(busy || loading) && <LoaderCircle size={18} className="confirmSpinner" aria-hidden />}
            <span role={busy || loading ? "status" : undefined}>{loading ? "Checking link…" : busy ? "Confirming…" : loadError || error ? "Try again" : "Confirm subscription"}</span>
          </button>}
      </div>
      <p className="confirmHelper">{done ? redirecting ? "Taking you back…" : "You can close this page."
        : missing || loadError || loading ? "" : "Unsubscribe at any time."}</p>
    </form>
  );
}
