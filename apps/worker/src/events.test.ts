import { DeleteMessageCommand, ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { describe, expect, it, vi } from "vitest";
import { applySesEvent, consumeOnce, mapSesEvent, type SesEvent } from "./events.js";

const bounce: SesEvent = {
  eventType: "Bounce",
  mail: {
    messageId: "sesmsg",
    destination: ["a@example.com", "b@example.com"],
    tags: { dispatch_email_id: ["email_1"], dispatch_tenant_id: ["tenant_1"] }
  },
  bounce: {
    bounceType: "Permanent",
    bounceSubType: "General",
    bouncedRecipients: [{ emailAddress: "a@example.com", diagnosticCode: "smtp; 550" }]
  }
};

describe("mapSesEvent", () => {
  it("maps a permanent bounce to one recipient and ignores SES opens", () => {
    expect(mapSesEvent(bounce)).toMatchObject({
      type: "email.bounced",
      emailId: "email_1",
      tenantId: "tenant_1",
      recipients: ["a@example.com"],
      data: { bounce: { type: "Permanent", subType: "General", message: "smtp; 550" }, email: "a@example.com" }
    });
    expect(mapSesEvent({ ...bounce, eventType: "Open" })).toBeNull();
    expect(mapSesEvent({ ...bounce, eventType: "Send" })?.providerEventId).toBe("sesmsg:sent");
  });
});

describe("applySesEvent", () => {
  it("writes the bounce through appendEvent for the bounced address only", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("select provider_message_id from emails")) return { rows: [{ provider_message_id: "sesmsg" }] };
        if (sql.includes("insert into email_events")) {
          return { rows: [{ id: "event_1", tenant_id: "tenant_1", request_id: "req", email_id: "email_1", type: "email.bounced", data: {} }] };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    await applySesEvent(client, bounce);
    const recipient = queries.find((query) => query.sql.includes("update email_recipients"));
    expect(recipient?.params[4]).toEqual(["a@example.com"]);
    expect(queries.some((query) => query.params.includes("email.bounced"))).toBe(true);
  });

  it("gives each bounced address its own diagnostic", async () => {
    const queries: Array<{ sql: string; params: unknown[] }> = [];
    const client = {
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        if (sql.includes("select provider_message_id from emails")) return { rows: [{ provider_message_id: "sesmsg" }] };
        if (sql.includes("insert into email_events")) {
          return { rows: [{ id: "event_1", tenant_id: "tenant_1", request_id: "req", email_id: "email_1", type: "email.bounced", data: {} }] };
        }
        return { rows: [], rowCount: 1 };
      })
    };
    await applySesEvent(client, {
      ...bounce,
      bounce: {
        bounceType: "Permanent",
        bounceSubType: "General",
        bouncedRecipients: [
          { emailAddress: "a@example.com", diagnosticCode: "smtp; 550 no such user" },
          { emailAddress: "b@example.com", diagnosticCode: "smtp; 552 mailbox full" }
        ]
      }
    });
    const events = queries.filter((query) => query.sql.includes("insert into email_events") && query.params.includes("email.bounced"));
    expect(events.map((event) => JSON.parse(String(event.params[7])).bounce.message)).toEqual(["smtp; 550 no such user", "smtp; 552 mailbox full"]);
  });
});

describe("event ownership", () => {
  const client = (stored: Array<{ provider_message_id: string | null }>) => {
    const queries: string[] = [];
    return {
      queries,
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("select provider_message_id from emails")) return { rows: stored };
        return { rows: [], rowCount: 1 };
      })
    };
  };

  it("drops an event whose message ID is not the one stored for the email its tags name", async () => {
    const forged = client([{ provider_message_id: "another-message" }]);
    await expect(applySesEvent(forged, bounce)).resolves.toBeNull();
    expect(forged.queries.some((sql) => sql.includes("insert into email_events"))).toBe(false);

    const unknown = client([]);
    await expect(applySesEvent(unknown, bounce)).resolves.toBeNull();
  });

  it("leaves an event on the queue when the message ID has not been stored yet", async () => {
    const early = client([{ provider_message_id: null }]);
    await expect(applySesEvent(early, bounce)).rejects.toThrow(/before its message ID was stored/);
    expect(early.queries.some((sql) => sql.includes("insert into email_events"))).toBe(false);
  });
});

describe("consumeOnce", () => {
  it("deletes a message only after the handler finishes", async () => {
    const sent: unknown[] = [];
    const client = {
      send: vi.fn(async (command: unknown) => {
        sent.push(command);
        if (command instanceof ReceiveMessageCommand) return { Messages: [{ Body: JSON.stringify(bounce), ReceiptHandle: "handle-1" }] };
        return {};
      })
    };
    const seen: unknown[] = [];
    await expect(consumeOnce(client, "https://queue.example/events", async (body) => { seen.push(body); })).resolves.toBe(1);
    expect(seen).toEqual([bounce]);
    expect(sent[1]).toBeInstanceOf(DeleteMessageCommand);

    const failing = {
      send: vi.fn(async (command: unknown) => {
        if (command instanceof ReceiveMessageCommand) return { Messages: [{ Body: "{}", ReceiptHandle: "handle-2" }] };
        return {};
      })
    };
    await expect(consumeOnce(failing, "https://queue.example/events", async () => { throw new Error("db down"); })).rejects.toThrow("db down");
    expect(failing.send.mock.calls.some((call) => call[0] instanceof DeleteMessageCommand)).toBe(false);
  });
});
