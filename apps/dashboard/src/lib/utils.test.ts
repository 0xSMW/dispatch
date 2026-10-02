import { describe, expect, it } from "vitest";
import { inboundBody, sendBody } from "./utils.js";

describe("sendBody", () => {
  it("splits address lists, parses JSON fields, and leaves out empty ones", () => {
    expect(
      sendBody({
        from: "Acme <hello@acme.com>",
        to: "a@x.com, b@x.com",
        cc: "",
        subject: "Hello",
        text: "Hi",
        html: " ",
        headers: '{"X-Trace":"1"}',
        tags: "",
      }),
    ).toEqual({
      from: "Acme <hello@acme.com>",
      to: ["a@x.com", "b@x.com"],
      subject: "Hello",
      text: "Hi",
      headers: { "X-Trace": "1" },
    });
  });
});

describe("inboundBody", () => {
  it("adds cc and bcc only when given", () => {
    expect(inboundBody({ from: "a@x.com", to: "in@acme.com", cc: "", bcc: "c@x.com", subject: "Hi", headers: "" })).toEqual({
      from: "a@x.com",
      to: ["in@acme.com"],
      bcc: ["c@x.com"],
      subject: "Hi",
      headers: {},
    });
  });
});
