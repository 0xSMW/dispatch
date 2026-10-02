import { Link } from "react-router-dom";
import { Rocket } from "lucide-react";
import { useResource } from "../hooks/useResource";
import type { Email, List, Setup } from "../types";
import { useCan } from "./session";

export type Step = { label: string; done: boolean; to: string };

/** The three onboarding steps, shared by the banner and `/setup`. */
export function setupSteps(setup: Setup | null, sent: boolean): Step[] {
  return [
    { label: "Verify a domain", done: setup?.domain?.status === "verified", to: "/domains" },
    { label: "Create an API key", done: Boolean(setup?.api_key), to: "/api-keys" },
    { label: "Send an email", done: sent, to: "/emails/send" },
  ];
}

export function useSetup() {
  const setup = useResource<Setup>("/setup");
  const emails = useResource<List<Email>>("/emails?limit=1");
  const steps = setupSteps(setup.data, (emails.data?.data.length ?? 0) > 0);
  return {
    setup,
    steps,
    loading: setup.loading || emails.loading,
    reload: () => Promise.all([setup.reload(), emails.reload()]).then(() => undefined),
  };
}

/** Banner on `/emails` until the three setup steps are done. */
export function Onboarding() {
  const { steps, loading, setup } = useSetup();
  // Every setup step writes, so a viewer is not asked to do them.
  const can = useCan();
  const done = steps.filter((step) => step.done).length;
  if (!can || loading || setup.error || done === steps.length) return null;
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
