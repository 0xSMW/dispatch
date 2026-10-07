// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { h, mockFetch, type Reply } from "../../testing";
import { guessMapping } from "./csv";
import { duplicateHeader, ImportContacts, Imports, keyCollisions } from "./Import";
import { calls, list, show, Status, stubApi } from "./stub";

const counts = { total: 3, created: 2, updated: 1, skipped: 0, failed: 0 };

function api(statuses: string[] = ["completed"], triggerDefault = false, automations: unknown[] = []) {
  let poll = 0;
  return stubApi({
    "GET /segments": list([{ object: "segment", id: "seg_vip", name: "VIP", created_at: "", updated_at: "" }]),
    "GET /topics": list([
      { object: "topic", id: "topic_news", name: "News", key: "news", description: null, visibility: "public", default_subscription: "opt_in" },
    ]),
    "GET /contact-properties": list([]),
    "GET /settings": { import_trigger_automations: triggerDefault, sandbox_domains: [] },
    "GET /automations": list(automations),
    "POST /contacts/imports": { object: "contact_import", id: "import_1", trigger_automations: triggerDefault },
    "GET /contacts/imports/import_1": () => {
      const status = statuses[Math.min(poll++, statuses.length - 1)];
      return { object: "contact_import", id: "import_1", trigger_automations: triggerDefault, status, counts, error: null, created_at: "2026-09-30T00:00:00.000Z", completed_at: null };
    },
    "GET /contacts/imports": list([
      { object: "contact_import", id: "import_1", trigger_automations: triggerDefault, status: "completed", counts, error: null, created_at: "2026-09-30T00:00:00.000Z", completed_at: null },
    ]),
  });
}

async function audience(text = "email\nada@example.com\n") {
  show(h(ImportContacts, { onClose: vi.fn(), onDone: vi.fn() }));
  const dialog = await screen.findByRole("dialog");
  fireEvent.change(within(dialog).getByLabelText("CSV file"), { target: { files: [new File([text], "people.csv")] } });
  await within(dialog).findByText("ada@example.com");
  await next(dialog);
  await next(dialog);
  return dialog;
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
    expect(form.get("trigger_automations")).toBe("false");
    expect([...form.keys()].indexOf("trigger_automations")).toBeLessThan([...form.keys()].indexOf("file"));
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

  it("offers four property types and preserves declared boolean/date types in uploaded mappings", async () => {
    const fetch = stubApi({
      "GET /segments": list([]), "GET /topics": list([]),
      "GET /settings": { import_trigger_automations: false, sandbox_domains: [] },
      "GET /contact-properties": list([{ key: "active", type: "boolean" }, { key: "renewed", type: "date" }, { key: "topics", type: "number" }]),
      "POST /contacts/imports": { object: "contact_import", id: "import_typed" },
      "GET /contacts/imports/import_typed": { object: "contact_import", id: "import_typed", status: "completed", counts, error: null },
    });
    show(h(ImportContacts, { onClose: vi.fn(), onDone: vi.fn() }));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(calls(fetch)).toContain("GET /contact-properties?limit=100"));
    fireEvent.change(within(dialog).getByLabelText("CSV file"), { target: { files: [new File(["Email,Active,Renewed,Topics,Other\nada@example.com,false,2026-10-04,2,true\n"], "typed.csv")] } });
    await within(dialog).findByText("ada@example.com");
    await next(dialog);
    expect(within(dialog).getByLabelText("Type for Active")).toHaveProperty("value", "boolean");
    expect(within(dialog).getByLabelText("Type for Active")).toHaveProperty("disabled", true);
    expect(within(dialog).getByLabelText("Type for Renewed")).toHaveProperty("value", "date");
    expect(within(dialog).getByLabelText("Type for Topics")).toHaveProperty("value", "number");
    fireEvent.click(within(dialog).getByLabelText("Other"));
    const other = within(dialog).getByLabelText("Type for Other");
    expect([...other.querySelectorAll("option")].map((option) => option.value)).toEqual(["string", "number", "boolean", "date"]);
    fireEvent.change(other, { target: { value: "boolean" } });
    await next(dialog);
    await next(dialog);
    await next(dialog);
    await waitFor(() => expect(calls(fetch)).toContain("POST /contacts/imports"));
    const form = fetch.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body as FormData;
    expect(JSON.parse(String(form.get("column_map"))).properties).toEqual({
      active: { column: "Active", type: "boolean" }, renewed: { column: "Renewed", type: "date" },
      topics: { column: "Topics", type: "number" }, other: { column: "Other", type: "boolean" },
    });
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

  it.each([false, true])("initializes from the tenant's %s default and sends that explicit selection", async (triggerDefault) => {
    const fetch = api(["completed"], triggerDefault);
    const dialog = await audience();
    expect(within(dialog).getByRole("switch", { name: "Start automations for these contacts" }).getAttribute("aria-checked")).toBe(String(triggerDefault));
    await next(dialog);
    await next(dialog);
    await waitFor(() => expect(calls(fetch)).toContain("POST /contacts/imports"));
    const form = fetch.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body as FormData;
    expect(form.get("trigger_automations")).toBe(String(triggerDefault));
    expect(await screen.findByText(`Automations for this import: ${triggerDefault ? "On" : "Off"}.`)).toBeTruthy();
  });

  it("sends an explicit off override even when the tenant default is on", async () => {
    const fetch = api(["completed"], true);
    const dialog = await audience();
    const toggle = within(dialog).getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    expect(within(dialog).queryByText(/may send emails immediately/)).toBeNull();
    await next(dialog);
    await next(dialog);
    await waitFor(() => expect(calls(fetch)).toContain("POST /contacts/imports"));
    const form = fetch.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body as FormData;
    expect(form.get("trigger_automations")).toBe("false");
  });

  it.each([false, true])("does not overwrite a user's choice when the %s tenant default arrives late", async (triggerDefault) => {
    const userChoice = !triggerDefault;
    let release!: (reply: Reply) => void;
    const pending = new Promise<Reply>((resolve) => { release = resolve; });
    const fetch = mockFetch((raw, init) => {
      if (new URL(raw).pathname === "/settings") return pending;
      if (init.method === "POST") return { body: { object: "contact_import", id: "import_1", trigger_automations: userChoice } };
      if (new URL(raw).pathname === "/contacts/imports/import_1") return { body: { object: "contact_import", id: "import_1", trigger_automations: userChoice, status: "completed", counts } };
      return { body: list([]) };
    });
    const dialog = await audience();
    const toggle = within(dialog).getByRole("switch");
    expect(toggle.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(toggle);
    if (!userChoice) fireEvent.click(toggle);
    release({ body: { import_trigger_automations: triggerDefault, sandbox_domains: [] } });
    await waitFor(() => expect(within(dialog).queryByText("Loading matching automations…")).toBeNull());
    expect(toggle.getAttribute("aria-checked")).toBe(String(userChoice));
    await next(dialog);
    await next(dialog);
    await waitFor(() => expect(calls(fetch)).toContain("POST /contacts/imports"));
    expect((fetch.mock.calls.find(([, init]) => init?.method === "POST")![1]!.body as FormData).get("trigger_automations")).toBe(String(userChoice));
  });

  it("lists only enabled creation and selected opt-in topic/segment automations, updating the count with the audience", async () => {
    const configs = [
      { name: "New contacts", trigger_config: { type: "contact_created" } },
      { name: "Newsletter welcome", trigger_config: { type: "topic_subscribed", topic_id: "topic_news" } },
      { name: "VIP welcome", trigger_config: { type: "segment_added", segment_id: "seg_vip" } },
      { name: "Other topic", trigger_config: { type: "topic_subscribed", topic_id: "topic_other" } },
      { name: "Other segment", trigger_config: { type: "segment_added", segment_id: "seg_other" } },
      { name: "Contact changed", trigger_config: { type: "contact_updated" } },
      { name: "App event", trigger_config: { type: "event", event_name: "signup" } },
      { name: "Disabled flow", trigger_config: { type: "contact_created" }, status: "disabled" },
      { name: "Legacy disabled flow", trigger_config: { type: "contact_created" }, status: undefined, enabled: false },
    ];
    api(["completed"], true, configs.map((config, i) => ({ id: `automation_${i}`, status: "enabled", ...config })));
    const dialog = await audience();
    expect(await within(dialog).findByText("1 matching enabled automation")).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText("VIP"));
    fireEvent.change(within(dialog).getByLabelText("News subscription"), { target: { value: "opt_in" } });
    expect(within(dialog).getByText("3 matching enabled automations")).toBeTruthy();
    for (const name of ["New contacts", "Newsletter welcome", "VIP welcome"]) expect(within(dialog).getByText(name)).toBeTruthy();
    for (const name of ["Other topic", "Other segment", "Contact changed", "App event", "Disabled flow", "Legacy disabled flow"]) expect(within(dialog).queryByText(name)).toBeNull();
    expect(within(dialog).getByText(/immediately or after their configured waits/)).toBeTruthy();
    expect(within(dialog).getByText(/Contact changes do not trigger automations during imports/)).toBeTruthy();
    fireEvent.change(within(dialog).getByLabelText("News subscription"), { target: { value: "opt_out" } });
    expect(within(dialog).getByText("2 matching enabled automations")).toBeTruthy();
    expect(within(dialog).queryByText("Newsletter welcome")).toBeNull();
  });

  it.each([10000, 10001])("warns above 10,000 data records, not quoted line breaks or the header (%i rows)", async (rows) => {
    api(["completed"], true);
    const dialog = await audience('email,note\nada@example.com,"two\nlines"\n' + 'bob@example.com,"two\nlines"\n'.repeat(rows - 1));
    await next(dialog);
    await waitFor(() => expect(within(dialog).getByText("Data rows").nextElementSibling?.textContent).toBe(rows.toLocaleString()), { timeout: 3000 });
    const warning = within(dialog).queryByText(/Starting automations for a large import may send many emails/);
    expect(Boolean(warning)).toBe(rows > 10000);
    fireEvent.click(within(dialog).getByRole("switch"));
    expect(within(dialog).queryByText(/Starting automations for a large import/)).toBeNull();
  });

  it("blocks an enabled import when its matching automation list fails, but permits an explicit off choice", async () => {
    const fetch = stubApi({
      "GET /segments": list([]), "GET /topics": list([]), "GET /contact-properties": list([]),
      "GET /settings": { import_trigger_automations: true, sandbox_domains: [] },
      "GET /automations": new Status(503, { message: "Unavailable" }),
    });
    const dialog = await audience();
    expect(await within(dialog).findByText(/Could not load matching automations/)).toBeTruthy();
    await next(dialog);
    const start = within(dialog).getByRole("button", { name: "Start import" });
    expect(start).toHaveProperty("disabled", true);
    fireEvent.click(start);
    expect(calls(fetch)).not.toContain("POST /contacts/imports");
    fireEvent.click(within(dialog).getByRole("switch"));
    expect(start).toHaveProperty("disabled", false);
  });
});

describe("Imports", () => {
  afterEach(() => {
    cleanup();
    sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  it("lists past imports with the default limit of 10 and opens one", async () => {
    const fetch = api(["completed"], true);
    show(h(Imports, { onClose: vi.fn() }));
    await screen.findByText("2 created, 1 updated, 0 failed");
    expect(calls(fetch)).toContain("GET /contacts/imports?limit=10");
    expect(screen.getByText("On")).toBeTruthy();
    fireEvent.click(screen.getByText("2 created, 1 updated, 0 failed"));
    await waitFor(() => expect(calls(fetch)).toContain("GET /contacts/imports/import_1"));
    expect(await screen.findByRole("progressbar")).toBeTruthy();
    expect(await screen.findByText("Automations for this import: On.")).toBeTruthy();
  });
});
