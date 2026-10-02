import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { sendFake } from "./index.js";

const previous = {
  terminal: process.env.FAKE_PROVIDER_TERMINAL_DELAY_MS,
  delayed: process.env.FAKE_PROVIDER_DELAYED_DELAY_MS
};

beforeEach(() => {
  process.env.FAKE_PROVIDER_TERMINAL_DELAY_MS = "0";
  process.env.FAKE_PROVIDER_DELAYED_DELAY_MS = "0";
});

afterAll(() => {
  restore("FAKE_PROVIDER_TERMINAL_DELAY_MS", previous.terminal);
  restore("FAKE_PROVIDER_DELAYED_DELAY_MS", previous.delayed);
});

describe("sendFake", () => {
  it("records sent and then delivered", () => {
    const result = sendFake({ id: "email_1", recipients: ["you@example.com"], subject: "Hello" });
    expect(result.provider_message_id.startsWith("ses_")).toBe(true);
    expect(result.events.map((event) => event.type)).toEqual(["email.sent", "email.delivered"]);
    expect(result.events[0]).toMatchObject({
      provider_event_id: `${result.provider_message_id}:sent`,
      delay_ms: 0,
      data: { provider_message_id: result.provider_message_id, subject: "Hello", attachments: 0 }
    });
  });

  it("bounces, complains, or delays from the recipient address", () => {
    expect(types(["bounce@example.com"])).toEqual(["email.sent", "email.bounced"]);
    expect(types(["COMPLAINT@example.com"])).toEqual(["email.sent", "email.complained"]);
    expect(types(["delay@example.com"])).toEqual(["email.sent", "email.delivery_delayed", "email.delivered"]);
  });

  it("gives each recipient its own outcome", () => {
    const result = sendFake({ id: "email_1", recipients: ["ada@example.net", "Bounce@example.net", "complaint@example.net"], subject: "Hello" });
    const events = result.events.map((event) => [event.type, event.recipients]);
    expect(events).toEqual([
      ["email.sent", ["ada@example.net", "Bounce@example.net", "complaint@example.net"]],
      ["email.delivered", ["ada@example.net"]],
      ["email.bounced", ["Bounce@example.net"]],
      ["email.complained", ["complaint@example.net"]],
    ]);
    // A bounce names the address it is about, as docs/webhooks.md says.
    expect(result.events[2]!.data).toMatchObject({ email: "bounce@example.net", bounce: { type: "Permanent" } });
  });

  it("prefers bounce over delay when the address contains both", () => {
    expect(types(["bounce-delay@example.com"])).toEqual(["email.sent", "email.bounced"]);
  });

  it("uses the configured delays and a new provider id for each send", () => {
    process.env.FAKE_PROVIDER_TERMINAL_DELAY_MS = "15";
    process.env.FAKE_PROVIDER_DELAYED_DELAY_MS = "5";
    const delayed = sendFake({ id: "email_1", recipients: ["delay@example.com"], subject: "Later", attachments: 2 });
    const again = sendFake({ id: "email_1", recipients: ["delay@example.com"], subject: "Later", attachments: 2 });

    expect(delayed.events.find((event) => event.type === "email.delivery_delayed")?.delay_ms).toBe(5);
    expect(delayed.events.at(-1)?.delay_ms).toBe(15);
    expect(delayed.events[0].data).toMatchObject({ attachments: 2 });
    expect(delayed.provider_message_id).not.toBe(again.provider_message_id);
  });
});

function types(recipients: string[]) {
  return sendFake({ id: "email_1", recipients, subject: "Hello" }).events.map((event) => event.type);
}

function restore(name: string, value: string | undefined) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
