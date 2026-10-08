import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { errorMessage } from "../../lib/client";
import { confirmationClient } from "../../lib/confirmation";
import type { Confirmation } from "../../types";
import { ConfirmCard } from "./Confirm";
import "../../styles/public.css";

type State =
  | { status: "loading" | "missing" }
  | { status: "error"; message: string }
  | { status: "ready" | "busy" | "done"; data: Confirmation; error?: string };

/** Token-only public page. Reading the link never confirms a subscription. */
export function ConfirmPage() {
  const { token = "" } = useParams<{ token: string }>();
  return <ConfirmationPage key={token} token={token} />;
}

function ConfirmationPage({ token }: { token: string }) {
  const client = useMemo(() => confirmationClient(), []);
  const [state, setState] = useState<State>(token ? { status: "loading" } : { status: "missing" });
  const busy = useRef(false);
  const redirectTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [redirecting, setRedirecting] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    if (token) {
      void client.get(token).then((data) => {
        if (live) setState({ status: data.confirmed ? "done" : "ready", data });
      }).catch((cause: unknown) => {
        if (!live) return;
        setState((cause as { statusCode?: number } | null)?.statusCode === 404
          ? { status: "missing" }
          : { status: "error", message: errorMessage(cause) });
      });
    }
    return () => {
      live = false;
      mounted.current = false;
      clearTimeout(redirectTimer.current);
    };
  }, [client, token, attempt]);

  async function confirm() {
    if (state.status !== "ready" || busy.current) return;
    busy.current = true;
    const { data } = state;
    setState({ status: "busy", data });
    try {
      const result = await client.confirm(token);
      if (!mounted.current) return;
      setState({ status: "done", data });
      // Only the confirmation response can supply a destination, never the page URL.
      if (result.redirect_url) {
        let url: URL;
        try {
          url = new URL(result.redirect_url);
        } catch {
          return;
        }
        if (url.protocol === "https:" && !url.username && !url.password) {
          setRedirecting(true);
          redirectTimer.current = setTimeout(() => {
            if (mounted.current) window.location.assign(url.href);
          }, 800);
        }
      }
    } catch (cause) {
      if (!mounted.current) return;
      busy.current = false;
      setState((cause as { statusCode?: number } | null)?.statusCode === 404
        ? { status: "missing" }
        : { status: "ready", data, error: errorMessage(cause) });
    }
  }

  const data = "data" in state ? state.data : undefined;
  return (
    <div className="publicPage confirmPage">
      <ConfirmCard
        brand={data ? { ...data.brand, color: data.brand.primary_color } : undefined}
        onConfirm={() => { void confirm(); }}
        onRetry={() => { setState({ status: "loading" }); setAttempt((value) => value + 1); }}
        loading={state.status === "loading"}
        missing={state.status === "missing"}
        loadError={state.status === "error"}
        busy={state.status === "busy"}
        done={state.status === "done"}
        redirecting={redirecting}
        error={"error" in state ? state.error : undefined}
      />
    </div>
  );
}
