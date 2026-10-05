import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { useParams } from "react-router-dom";
import { Skeleton } from "../../components/Skeleton";
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
    };
  }, [client, token]);

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
          window.location.assign(url.href);
        }
      }
    } catch (cause) {
      if (!mounted.current) return;
      busy.current = false;
      setState({ status: "ready", data, error: errorMessage(cause) });
    }
  }

  if (state.status === "loading") {
    return <div className="publicPage"><div className="publicCard" aria-busy><Skeleton lines={4} /></div></div>;
  }
  if (!("data" in state)) {
    return (
      <div className="publicPage">
        <div className="publicCard">
          <h1>{state.status === "missing" ? "This link is not valid" : "Something went wrong"}</h1>
          <p className="center muted">
            {state.status === "error"
              ? `${state.message} Try again in a moment.`
              : "Use the confirmation link from the most recent email you received."}
          </p>
        </div>
      </div>
    );
  }

  const { brand, form_name } = state.data;
  const style = {
    backgroundColor: brand.background_color,
    "--surface": brand.background_color,
    "--text": brand.text_color,
    "--text-muted": brand.text_color,
  } as CSSProperties;
  return (
    <div className="publicPage" style={style}>
      <ConfirmCard
        brand={{ ...brand, color: brand.primary_color }}
        formName={form_name}
        onConfirm={() => { void confirm(); }}
        busy={state.status === "busy"}
        done={state.status === "done"}
        error={state.error}
      />
    </div>
  );
}
