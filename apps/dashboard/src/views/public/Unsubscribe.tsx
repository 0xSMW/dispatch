import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Skeleton } from "../../components/Skeleton";
import { useMutation } from "../../hooks/useMutation";
import { errorMessage, publicClient } from "../../lib/client";
import type { Preferences } from "../../types";
import { PreferenceCard, type Done } from "./Preferences";
import "../../styles/public.css";

type State =
  | { status: "loading" }
  | { status: "ready"; data: Preferences }
  | { status: "missing" }
  | { status: "error"; message: string };

function optedIn(data: Preferences) {
  return Object.fromEntries(data.topics.map((topic) => [topic.id, topic.subscription === "opt_in"]));
}

/** Public preference page at `/unsubscribe?token=`. No session: the token is the only credential. */
export function Unsubscribe() {
  const [params] = useSearchParams();
  const token = params.get("token") ?? "";
  const client = useMemo(() => publicClient(), []);
  const path = `/unsubscribe/${encodeURIComponent(token)}`;
  const [state, setState] = useState<State>(token ? { status: "loading" } : { status: "missing" });
  const [checked, setChecked] = useState<Record<string, boolean>>({});
  const [done, setDone] = useState<Done>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    let live = true;
    client
      .get<Preferences>(path)
      .then((data) => {
        if (!live) return;
        setState({ status: "ready", data });
        setChecked(optedIn(data));
        if (data.unsubscribed) setDone("unsubscribed");
      })
      .catch((cause: unknown) => {
        if (!live) return;
        const status = (cause as { statusCode?: number }).statusCode;
        setState(status === 404 ? { status: "missing" } : { status: "error", message: errorMessage(cause) });
      });
    return () => {
      live = false;
    };
  }, [client, path, token]);

  const save = useMutation(
    (body: { topics: Array<{ id: string; subscription: "opt_in" | "opt_out" }> } | { unsubscribe_all: true }) =>
      client.post<Preferences>(path, body),
    {
      onSuccess: (data, body) => {
        setState({ status: "ready", data });
        setDone("unsubscribe_all" in body ? "unsubscribed" : "updated");
      },
      onError: (cause) => setError(cause.message),
    },
  );

  if (state.status === "loading") {
    return (
      <div className="publicPage">
        <div className="publicCard" aria-busy>
          <Skeleton lines={4} />
        </div>
      </div>
    );
  }

  if (state.status !== "ready") {
    return (
      <div className="publicPage">
        <div className="publicCard">
          <h1>{state.status === "missing" ? "This link is not valid" : "Something went wrong"}</h1>
          <p className="center muted">
            {state.status === "missing"
              ? "Use the unsubscribe link from the most recent email you received."
              : `${state.message} Try again in a moment.`}
          </p>
        </div>
      </div>
    );
  }

  const { data } = state;
  return (
    <div className="publicPage">
      <PreferenceCard
        brand={data.brand}
        title={data.brand.title ?? undefined}
        description={data.brand.description ?? undefined}
        email={data.email}
        topics={data.topics}
        checked={checked}
        onToggle={(id) => setChecked((current) => ({ ...current, [id]: !current[id] }))}
        onUpdate={() => {
          setError(null);
          void save.mutate({
            topics: data.topics.map((topic) => ({ id: topic.id, subscription: checked[topic.id] ? "opt_in" : "opt_out" })),
          });
        }}
        onUnsubscribeAll={() => {
          setError(null);
          void save.mutate({ unsubscribe_all: true });
        }}
        busy={save.isLoading}
        done={done}
        error={error}
      />
    </div>
  );
}
