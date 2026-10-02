import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const loads: Array<{ file: string; props: Array<Record<string, unknown> | undefined> }> = [];
const component = {
  variables: [{ key: "NAME", prop: "name", type: "string", fallback_value: "there" }] as Array<Record<string, unknown>>,
  track: undefined as boolean | undefined,
  brand: true,
};

vi.mock("../../src/lib/react.js", () => ({
  loadFile: vi.fn(async (file: string) => {
    const load = { file, props: [] as Array<Record<string, unknown> | undefined> };
    loads.push(load);
    return {
      subject: "Welcome",
      variables: component.variables,
      track: component.track,
      brand: component.brand,
      render: async (props?: Record<string, unknown>) => {
        load.props.push(props);
        return props?.name ? `<p>${String(props.name)}</p>` : "<p>preview</p>";
      },
    };
  }),
}));

describe("pushTemplates", () => {
  const dirs: string[] = [];

  afterEach(async () => {
    loads.length = 0;
    component.variables = [{ key: "NAME", prop: "name", type: "string", fallback_value: "there" }];
    component.track = undefined;
    component.brand = true;
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("bundles each file once, and renders lists, the brand, and Track as the library build does", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-push-"));
    dirs.push(dir);
    const file = join(dir, "receipt.tsx");
    await writeFile(file, "export default function Receipt() { return null }\n");
    component.variables = [
      { key: "NAME", prop: "name", type: "string", fallback_value: "there" },
      { key: "LINE_ITEMS", prop: "items", type: "list", fallback_value: null, fields: ["description", "amount"] },
    ];
    component.track = false;
    const { pushTemplates } = await import("../../src/lib/push.js");
    const ok = <T>(data: T) => ({ data, error: null, headers: {} });
    const client = {
      get: vi.fn(async () => ({ data: null, error: { name: "not_found", statusCode: 404, message: "Template not found" }, headers: {} })),
      create: vi.fn(async () => ok({ id: "template_1", current_version_id: "version_1" })),
      update: vi.fn(),
      publish: vi.fn(),
    };
    await pushTemplates(client, file, false);
    expect(loads).toHaveLength(1);
    expect(loads[0]?.props).toHaveLength(1);
    const props = loads[0]!.props[0]!;
    const items = props.items as Array<Record<string, string>> & Record<symbol, string>;
    expect([...items]).toEqual([{ description: "{{{description}}}", amount: "{{{amount}}}" }]);
    expect(items[Symbol.for("dispatch.list")]).toBe("LINE_ITEMS");
    expect(props.brand).toMatchObject({ productName: "{{{PRODUCT_NAME}}}", supportEmail: "{{{SUPPORT_EMAIL}}}", year: "{{{CURRENT_YEAR}}}" });
    expect((client.create.mock.calls[0] as unknown[])[0]).toMatchObject({ alias: "receipt", track: false });

    component.brand = false;
    component.track = undefined;
    await pushTemplates(client, file, false);
    expect(loads[1]!.props[0]).not.toHaveProperty("brand");
    expect((client.create.mock.calls[1] as unknown[])[0]).not.toHaveProperty("track");
  });

  it("creates a draft from placeholders, then updates and publishes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-push-"));
    dirs.push(dir);
    const file = join(dir, "welcome.tsx");
    await writeFile(file, "export default function Welcome() { return null }\n");
    const { pushTemplates } = await import("../../src/lib/push.js");
    const ok = <T>(data: T) => ({ data, error: null, headers: {} });
    const created = {
      get: vi.fn(async () => ({ data: null, error: { name: "not_found", statusCode: 404, message: "Template not found" }, headers: {} })),
      create: vi.fn(async () => ok({ id: "template_1", current_version_id: "version_1" })),
      update: vi.fn(async () => ok({ id: "template_1", current_version_id: "version_2" })),
      publish: vi.fn(async () => ok({ id: "template_1" })),
    };
    const first = await pushTemplates(created, file, false);
    expect(first[0]).toMatchObject({ alias: "welcome", action: "created", status: "draft", id: "template_1" });
    expect((created.create.mock.calls[0] as unknown[])[0]).toMatchObject({
      alias: "welcome",
      html: "<p>{{{NAME}}}</p>",
      subject: "Welcome",
      publish: false,
      source: { kind: "react-email" },
      variables: [{ key: "NAME", type: "string", fallback_value: "there" }],
    });

    created.get.mockResolvedValueOnce(ok({ id: "template_1" }) as never);
    const second = await pushTemplates(created, file, true);
    expect(second[0]).toMatchObject({ action: "updated", status: "published", version_id: "version_2" });
    expect(created.publish).toHaveBeenCalledWith("template_1");
    expect(created.update).toHaveBeenCalledWith("template_1", expect.objectContaining({ html: "<p>{{{NAME}}}</p>" }));
  });

  it("stops on an API error other than 404", async () => {
    const dir = await mkdtemp(join(tmpdir(), "dispatch-push-"));
    dirs.push(dir);
    const file = join(dir, "welcome.tsx");
    await writeFile(file, "export default function Welcome() { return null }\n");
    const { pushTemplates } = await import("../../src/lib/push.js");
    const client = {
      get: vi.fn(async () => ({ data: null, error: { name: "restricted_api_key", statusCode: 401, message: "Nope" }, headers: {} })),
      create: vi.fn(),
      update: vi.fn(),
      publish: vi.fn(),
    };
    await expect(pushTemplates(client, file)).rejects.toMatchObject({ code: "restricted_api_key" });
    expect(client.create).not.toHaveBeenCalled();
  });
});
