import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { EmailFrame } from "../../components/EmailFrame";
import { Facts } from "../../components/Facts";
import { Skeleton } from "../../components/Skeleton";
import { Time } from "../../components/Time";
import { errorMessage, publicClient } from "../../lib/client";
import type { SharedEmail } from "../../types";
import "../../styles/public.css";

type State =
  | { status: "loading" }
  | { status: "ready"; email: SharedEmail }
  | { status: "expired" }
  | { status: "error"; message: string };

/** Public shared-email page at `/shared?token=`. Read-only, no session. */
export function Shared() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const client = useMemo(() => publicClient(), []);
  const [state, setState] = useState<State>(token ? { status: "loading" } : { status: "expired" });

  useEffect(() => {
    if (!token) return;
    let live = true;
    client
      .get<SharedEmail>(`/shared/${encodeURIComponent(token)}`)
      .then((email) => live && setState({ status: "ready", email }))
      .catch((cause: unknown) => {
        if (!live) return;
        const status = (cause as { statusCode?: number }).statusCode;
        // A bad, expired, or deleted token all come back 404.
        setState(status === 404 || status === 400 ? { status: "expired" } : { status: "error", message: errorMessage(cause) });
      });
    return () => {
      live = false;
    };
  }, [client, token]);

  if (state.status === "expired" || state.status === "error") {
    return (
      <div className="publicPage">
        <div className="publicCard">
          <h1>{state.status === "expired" ? "This link has expired" : "Something went wrong"}</h1>
          <p className="center muted">
            {state.status === "expired" ? "Ask the sender for a new link." : `${state.message} Try again in a moment.`}
          </p>
        </div>
      </div>
    );
  }

  if (state.status === "loading") {
    return (
      <div className="sharedPage" aria-busy>
        <Skeleton width="medium" />
        <Skeleton lines={3} />
      </div>
    );
  }

  const { email } = state;
  return (
    <div className="sharedPage">
      <div className="typeLabel">Shared email</div>
      <h1>{email.subject || "(no subject)"}</h1>
      <Facts
        columns={3}
        items={[
          { label: "From", value: email.from },
          { label: "To", value: email.to.join(", ") },
          { label: "Sent", value: <Time value={email.created_at} mode="absolute" /> },
        ]}
      />
      {email.html ? (
        <EmailFrame html={email.html} />
      ) : email.text ? (
        <pre className="sharedText">{email.text}</pre>
      ) : (
        <p className="muted">This email has no body.</p>
      )}
    </div>
  );
}
