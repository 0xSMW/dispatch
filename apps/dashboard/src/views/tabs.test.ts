import { expect, it } from "vitest";
import { audienceTabs, emailTabs, settingsTabs } from "./tabs";

it("keeps suppressions in Emails and removes the standalone test send tab", () => {
  expect(emailTabs.some((tab) => tab.to === "/emails/suppressions")).toBe(true);
  expect(audienceTabs.some((tab) => tab.to === "/emails/suppressions")).toBe(false);
  expect(emailTabs.some((tab) => tab.to === "/emails/send")).toBe(false);
});

it("opens Settings with Usage first", () => {
  expect(settingsTabs[0]).toEqual({ id: "usage", label: "Usage", to: "/settings/usage" });
});
