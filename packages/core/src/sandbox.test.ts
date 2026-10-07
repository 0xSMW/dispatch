import { describe, expect, it } from "vitest";
import { sandboxAddress } from "./sandbox.js";

describe("sandboxAddress", () => {
  it.each(["a@example.com", "a@EXAMPLE.NET", "a@sub.example.org", "a@foo.test", "a@test", "a@foo.example", "a@foo.invalid", "a@deep.sub.test"])("matches reserved address %s", (address) => {
    expect(sandboxAddress(address)).toBe(true);
  });
  it.each(["a@notexample.com", "a@example.com.attacker.net", "a@contest.net", "a@simulator.amazonses.com", "a@dispatch-fixture.net"])("does not match real address %s", (address) => {
    expect(sandboxAddress(address)).toBe(false);
  });
  it("matches configured domains and subdomains without matching lookalikes", () => {
    expect(sandboxAddress("A@SUB.QA.dispatchmail.net", ["qa.dispatchmail.net"])).toBe(true);
    expect(sandboxAddress("a@notqa.dispatchmail.net", ["qa.dispatchmail.net"])).toBe(false);
    expect(sandboxAddress("a@qa.dispatchmail.net.attacker.net", ["qa.dispatchmail.net"])).toBe(false);
    expect(sandboxAddress("missing", [""])).toBe(false);
  });
});
