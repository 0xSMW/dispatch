import { Link } from "react-router-dom";
import { Rocket } from "lucide-react";
import { useResource } from "../hooks/useResource";
import type { Email, List, Setup } from "../types";
import { useCan } from "./session";

/** `unknown` is set when the request the step depends on failed, so `done` means nothing. */
export type Step = { label: string; done: boolean; to: string; unknown?: boolean };

/** The three onboarding steps, shared by the banner and `/setup`. Pass `null` for a state that failed to load. */
export function setupSteps(setup: Setup | null | undefined, sent: boolean | null): Step[] {
  return [
    { label: "Verify a domain", done: setup?.domain?.status === "verified", to: "/domains", unknown: setup === null },
    { label: "Create an API key", done: Boolean(setup?.api_key), to: "/api-keys", unknown: setup === null },
    // Done once any email exists, however it was sent.
    { label: "Send your first email through the API", done: Boolean(sent), to: "/setup/send", unknown: sent === null },
  ];
}

export function useSetup() {
  const setup = useResource<Setup>("/setup");
  const emails = useResource<List<Email>>("/emails?limit=1");
  const steps = setupSteps(
    setup.error && !setup.data ? null : (setup.data ?? undefined),
    emails.error && !emails.data ? null : (emails.data?.data.length ?? 0) > 0,
  );
  return {
    setup,
    emails,
    steps,
    loading: setup.loading || emails.loading,
    reload: () => Promise.all([setup.reload(), emails.reload()]).then(() => undefined),
  };
}

/** Banner on `/emails` until the three setup steps are done. */
export function Onboarding() {
  const { steps, loading } = useSetup();
  // Every setup step writes, so a viewer is not asked to do them.
  const can = useCan();
  const done = steps.filter((step) => step.done).length;
  if (!can || loading || steps.some((step) => step.unknown) || done === steps.length) return null;
  return (
    <div className="banner">
      <Rocket size={16} />
      <span>
        Finish setting up Dispatch: {done} of {steps.length} steps done.
      </span>
      <Link className="button secondary small" to="/setup">
        Continue setup
      </Link>
    </div>
  );
}
