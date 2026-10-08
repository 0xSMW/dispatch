// @vitest-environment jsdom
import { expect, it } from "vitest";
import { setupSteps } from "./Onboarding";

it("keeps the email setup step and directs it to Emails", () => {
  const steps = setupSteps(null, false);
  expect(steps).toHaveLength(3);
  expect(steps[2]).toEqual({ label: "Send an email", done: false, to: "/emails" });
  expect(setupSteps(null, true)[2].done).toBe(true);
  expect(steps.some((step) => step.to === "/emails/send")).toBe(false);
});
