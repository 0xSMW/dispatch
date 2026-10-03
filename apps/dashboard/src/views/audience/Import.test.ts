// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h } from "../../testing";
import { guessMapping } from "./csv";
import { duplicateHeader, ImportContacts, Imports, keyCollisions } from "./Import";
import { calls, list, show, stubApi } from "./stub";

const counts = { total: 3, created: 2, updated: 1, skipped: 0, failed: 0 };

function api(statuses: string[] = ["completed"]) {
  let poll = 0;
  return stubApi({
    "GET /segments": list([{ object: "segment", id: "seg_vip", name: "VIP", created_at: "", updated_at: "" }]),
    "GET /topics": list([
      { object: "topic", id: "topic_news", name: "News", key: "news", description: null, visibility: "public", default_subscription: "opt_in" },
    ]),
    "GET /contact-properties": list([]),
    "POST /contacts/imports": { object: "contact_import", id: "import_1" },
    "GET /contacts/imports/import_1": () => {
      const status = statuses[Math.min(poll++, statuses.length - 1)];
      return { object: "contact_import", id: "import_1", status, counts, error: null, created_at: "2026-09-30T00:00:00.000Z", completed_at: null };
    },
    "GET /contacts/imports": list([
      { object: "contact_import", id: "import_1", status: "completed", counts, error: null, created_at: "2026-09-30T00:00:00.000Z", completed_at: null },
    ]),
  });
}

async function next(dialog: HTMLElement) {
  const button = within(dialog).getByRole("button", { name: /^Next|^Start import/ });
  await waitFor(() => expect(button).toHaveProperty("disabled", false));
  fireEvent.click(button);
}

describe("ImportContacts", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("uploads the file with the column map, segments, and topics, then shows the result", async () => {
    const fetch = api(["in_progress", "completed"]);
    const onDone = vi.fn();
    show(h(ImportContacts, { onClose: vi.fn(), onDone }));
    const dialog = await screen.findByRole("dialog");

    const file = new File(["Email,First name,Company\nada@example.com,Ada,Acme\n"], "people.csv", { type: "text/csv" });
    fireEvent.change(within(dialog).getByLabelText("CSV file"), { target: { files: [file] } });
    await within(dialog).findByText("ada@example.com");
    await next(dialog);

    // Columns mapped by header name; Company is offered as a property.
    expect((within(dialog).getByLabelText("Email") as HTMLSelectElement).value).toBe("Email");
    expect((within(dialog).getByLabelText("First name") as HTMLSelectElement).value).toBe("First name");
    fireEvent.click(within(dialog).getByLabelText("Company"));
    fireEvent.change(within(dialog).getByLabelText("Existing contacts"), { target: { value: "skip" } });
    await next(dialog);

    fireEvent.click(await within(dialog).findByLabelText("VIP"));
    fireEvent.change(within(dialog).getByLabelText("News subscription"), { target: { value: "opt_in" } });
    await next(dialog);

    expect(within(dialog).getByText("people.csv")).toBeTruthy();
    await next(dialog);

    await waitFor(() => expect(calls(fetch)).toContain("POST /contacts/imports"));
    const upload = fetch.mock.calls.find(([url, init]) => String(url).endsWith("/contacts/imports") && init?.method === "POST")!;
    const form = upload[1]!.body as FormData;
    expect(JSON.parse(String(form.get("column_map")))).toEqual({
      email: { column: "Email" },
      first_name: { column: "First name" },
      last_name: null,
      unsubscribed: null,
      properties: { company: { column: "Company", type: "string" } },
    });
    expect(form.get("on_conflict")).toBe("skip");
    expect(JSON.parse(String(form.get("segments")))).toEqual([{ id: "seg_vip" }]);
    expect(JSON.parse(String(form.get("topics")))).toEqual([{ id: "topic_news", subscription: "opt_in" }]);
    expect((form.get("file") as File).name).toBe("people.csv");

    await screen.findByText("in progress");
    await waitFor(() => expect(screen.getByText("completed")).toBeTruthy(), { timeout: 3000 });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    const strip = screen.getByText("created").closest("dl")!;
    expect(within(strip).getByText("2")).toBeTruthy();
  });

  it("finds repeated headers and property keys that collide", () => {
    expect(duplicateHeader(["Email", "name", "EMAIL"])).toBe("EMAIL");
    expect(duplicateHeader(["Email", "name"])).toBeNull();
    const mapping = guessMapping(["email", "Company!", "company?", "plan"]);
    const include = { ...mapping, properties: mapping.properties.map((item) => ({ ...item, include: true })) };
    expect(keyCollisions(include)).toEqual(["company"]);
    expect(keyCollisions(mapping)).toEqual([]);
  });

  it("keeps Next disabled until a column is mapped to email", async () => {
    api();
    show(h(ImportContacts, { onClose: vi.fn(), onDone: vi.fn() }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("CSV file"), {
      target: { files: [new File(["name,city\nAda,London\n"], "odd.csv")] },
    });
    await within(dialog).findByText("London");
    await next(dialog);
    expect(within(dialog).getByText("Map a column to email.")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: /^Next/ })).toHaveProperty("disabled", true);
  });
});

describe("Imports", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists past imports with the default limit of 10 and opens one", async () => {
    const fetch = api();
    show(h(Imports, { onClose: vi.fn() }));
    await screen.findByText("2 created, 1 updated, 0 failed");
    expect(calls(fetch)).toContain("GET /contacts/imports?limit=10");
    fireEvent.click(screen.getByText("2 created, 1 updated, 0 failed"));
    await waitFor(() => expect(calls(fetch)).toContain("GET /contacts/imports/import_1"));
    expect(await screen.findByRole("progressbar")).toBeTruthy();
  });
});
