import { afterEach, describe, expect, it, vi } from "vitest";

// Import the real acceptance fixture, but replace its runner and all runtime dependencies.
// No acceptance case, socket, client, API or worker from the real services can execute.
type Env = Record<string, string | undefined>;
type Hook = () => unknown;
const approved = {
  TEST_DATABASE_URL:
    "postgres://test:synthetic-password@localhost:32768/dispatch_test",
  TEST_REDIS_URL: "redis://localhost:32769/15",
};
const targetNames = [
  "TEST_DATABASE_URL",
  "TEST_REDIS_URL",
  "TEST_ADMIN_DATABASE_URL",
  "REQUIRE_INTEGRATION_TESTS",
];

async function fixture(supplied: Env, loaded: Env = {}) {
  vi.resetModules();
  for (const name of targetNames) vi.stubEnv(name, supplied[name]);
  for (const name of [
    "RATE_LIMIT_PER_SECOND",
    "AUTH_RATE_LIMIT_PER_SECOND",
    "TELEMETRY_FLUSH_MS",
    "FAKE_PROVIDER_TERMINAL_DELAY_MS",
    "FAKE_PROVIDER_DELAYED_DELAY_MS",
  ])
    vi.stubEnv(name, process.env[name]);
  vi.stubEnv("DATABASE_URL", "unapproved-ambient-database");
  vi.stubEnv("REDIS_URL", "unapproved-ambient-redis");
  const hooks: Record<string, Hook[]> = {
    beforeAll: [],
    beforeEach: [],
    afterEach: [],
    afterAll: [],
  };
  const register = vi.fn((name: string, hook: Hook) => {
    hooks[name]!.push(hook);
  });
  const suites = vi.fn();
  const skipIf = vi.fn((_skip: boolean) => suites);
  vi.doMock("vitest", () => ({
    beforeAll: (hook: Hook) => register("beforeAll", hook),
    beforeEach: (hook: Hook) => register("beforeEach", hook),
    afterEach: (hook: Hook) => register("afterEach", hook),
    afterAll: (hook: Hook) => register("afterAll", hook),
    describe: Object.assign(suites, { skipIf }),
    it: vi.fn(),
    expect,
  }));
  const loadEnv = vi.fn(() => {
    for (const [name, value] of Object.entries(loaded)) vi.stubEnv(name, value);
    return {};
  });
  vi.doMock("@dispatchmail/core/env", loadEnv);
  const query = vi.fn(async (sql: string) =>
    sql.includes("pg_tables")
      ? { rows: [{ tablename: "fixture" }], rowCount: 1 }
      : { rows: [], rowCount: 0 },
  );
  const db = { query, end: vi.fn(async () => {}) };
  const connect = vi.fn((_url?: string) => db);
  const migrate = vi.fn(async () => {});
  const dbModule = vi.fn(() => ({
    connect,
    migrate,
    tx: async (_db: unknown, run: (client: typeof db) => Promise<unknown>) =>
      run(db),
    ...Object.fromEntries(
      [
        "appendEvent",
        "claimAutomationRuns",
        "contactColumns",
        "dispatchContactWrite",
        "emit",
        "executeAutomationRun",
        "fireEvent",
        "reconcileBroadcastSent",
        "retryTx",
        "unsubscribeToken",
        "updateContact",
      ].map((name) => [name, vi.fn()]),
    ),
  }));
  vi.doMock("@dispatchmail/db", dbModule);
  const helpers = vi.fn(() =>
    Object.fromEntries(
      [
        "contactContext",
        "createImport",
        "claimImports",
        "importBatch",
        "runImport",
        "deliverJob",
        "applySesEvent",
      ].map((name) => [name, vi.fn()]),
    ),
  );
  vi.doMock("../../../packages/db/src/automations.js", helpers);
  vi.doMock("../../../packages/db/src/imports.js", helpers);
  vi.doMock("../../worker/src/imports.js", helpers);
  vi.doMock("../../worker/src/deliver.js", helpers);
  vi.doMock("../../worker/src/events.js", helpers);
  const coreModule = vi.fn(() => ({
    id: (prefix: string) => `${prefix}_fixture`,
    makeKey: () => ({ secret: "synthetic-fixture-key" }),
    keyHash: () => "synthetic-fixture-hash",
    ProviderError: class extends Error {},
    renderTemplate: vi.fn(),
    sign: vi.fn(),
    verify: vi.fn(),
  }));
  vi.doMock("@dispatchmail/core", coreModule);
  const redisClient = vi.fn((_url: string | undefined) => ({}));
  const appEnv: Env[] = [];
  const initialize = () => {
    appEnv.push({
      DATABASE_URL: process.env.DATABASE_URL,
      REDIS_URL: process.env.REDIS_URL,
    });
    connect();
    redisClient(process.env.REDIS_URL);
    return { close: vi.fn(async () => {}) };
  };
  const api = vi.fn(() => ({ ...initialize(), app: { inject: vi.fn() } }));
  const worker = vi.fn(() => ({ ...initialize(), tick: vi.fn() }));
  vi.doMock("./server.js", api);
  vi.doMock("../../worker/src/worker.js", worker);
  const imported = import("./accept.test.js");
  return {
    imported,
    hooks,
    register,
    skipIf,
    loadEnv,
    coreModule,
    dbModule,
    helpers,
    connect,
    query,
    migrate,
    redisClient,
    api,
    worker,
    appEnv,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const name of [
    "vitest",
    "@dispatchmail/core/env",
    "@dispatchmail/core",
    "@dispatchmail/db",
    "../../../packages/db/src/automations.js",
    "../../../packages/db/src/imports.js",
    "../../worker/src/imports.js",
    "../../worker/src/deliver.js",
    "../../worker/src/events.js",
    "./server.js",
    "../../worker/src/worker.js",
  ])
    vi.doUnmock(name);
  vi.resetModules();
});

describe("actual acceptance fixture wiring, offline", () => {
  const cases: Array<[string, Env, Env, string]> = [
    ["inherited safe targets", {}, approved, "TEST_DATABASE_URL"],
    [
      "inherited old host targets",
      {},
      {
        TEST_DATABASE_URL:
          "postgres://synthetic:secret@home-server:5432/dispatch_test",
        TEST_REDIS_URL: "redis://synthetic:secret@home-server:6379",
      },
      "TEST_DATABASE_URL",
    ],
    [
      "partial DB supply completed by env",
      { TEST_DATABASE_URL: approved.TEST_DATABASE_URL },
      { TEST_REDIS_URL: approved.TEST_REDIS_URL },
      "TEST_REDIS_URL",
    ],
    [
      "partial Redis supply completed by env",
      { TEST_REDIS_URL: approved.TEST_REDIS_URL },
      { TEST_DATABASE_URL: approved.TEST_DATABASE_URL },
      "TEST_DATABASE_URL",
    ],
    [
      "unsafe explicit DB",
      {
        ...approved,
        TEST_DATABASE_URL:
          "postgres://synthetic:secret@home-server:5432/dispatch_test",
      },
      {},
      "TEST_DATABASE_URL",
    ],
    [
      "unsafe explicit Redis",
      {
        ...approved,
        TEST_REDIS_URL: "redis://synthetic:secret@home-server:6379",
      },
      {},
      "TEST_REDIS_URL",
    ],
    [
      "unsafe resolved DB",
      approved,
      { TEST_DATABASE_URL: "postgres://localhost:5432/dispatch_test" },
      "TEST_DATABASE_URL",
    ],
    [
      "unsafe resolved Redis",
      approved,
      { TEST_REDIS_URL: "redis://localhost:6379" },
      "TEST_REDIS_URL",
    ],
    [
      "inherited admin",
      approved,
      { TEST_ADMIN_DATABASE_URL: "postgres://localhost:32768/postgres" },
      "TEST_ADMIN_DATABASE_URL",
    ],
    [
      "unsafe explicit admin",
      {
        ...approved,
        TEST_ADMIN_DATABASE_URL:
          "postgres://synthetic:secret@home-server:5432/postgres",
      },
      {},
      "TEST_ADMIN_DATABASE_URL",
    ],
    [
      "unsafe resolved admin",
      {
        ...approved,
        TEST_ADMIN_DATABASE_URL: "postgres://localhost:32768/postgres",
      },
      { TEST_ADMIN_DATABASE_URL: "postgres://localhost:32768/dispatch" },
      "TEST_ADMIN_DATABASE_URL",
    ],
    [
      "empty explicit values",
      { TEST_DATABASE_URL: "", TEST_REDIS_URL: "" },
      {},
      "TEST_DATABASE_URL",
    ],
    [
      "required missing values",
      { REQUIRE_INTEGRATION_TESTS: "true" },
      {},
      "REQUIRE_INTEGRATION_TESTS",
    ],
    [
      "env-required missing values",
      {},
      { REQUIRE_INTEGRATION_TESTS: "true" },
      "REQUIRE_INTEGRATION_TESTS",
    ],
    [
      "admin-only config",
      { TEST_ADMIN_DATABASE_URL: "postgres://localhost:32768/postgres" },
      {},
      "TEST_DATABASE_URL",
    ],
  ];
  it.each(cases)(
    "refuses %s before every hook and side effect",
    async (_name, supplied, loaded, variable) => {
      const f = await fixture(supplied, loaded);
      await expect(f.imported).rejects.toThrow(new RegExp(`^${variable}: `));
      expect(f.loadEnv).toHaveBeenCalledOnce();
      for (const spy of [
        f.register,
        f.skipIf,
        f.coreModule,
        f.dbModule,
        f.helpers,
        f.connect,
        f.query,
        f.migrate,
        f.redisClient,
        f.api,
        f.worker,
      ]) {
        expect(spy).not.toHaveBeenCalled();
      }
      expect(process.env.DATABASE_URL).toBe("unapproved-ambient-database");
      expect(process.env.REDIS_URL).toBe("unapproved-ambient-redis");
    },
  );

  it("skips entirely absent optional targets without clients or app initialization", async () => {
    const f = await fixture({});
    await f.imported;
    expect(f.skipIf.mock.calls.every(([skip]) => skip === true)).toBe(true);
    for (const hook of f.hooks.beforeAll!) await hook();
    for (const spy of [
      f.connect,
      f.query,
      f.migrate,
      f.redisClient,
      f.api,
      f.worker,
    ])
      expect(spy).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "uses only canonical approved fixture/app targets, explicit admin=%s",
    async (explicitAdmin) => {
      const f = await fixture({
        ...approved,
        REQUIRE_INTEGRATION_TESTS: "true",
        ...(explicitAdmin
          ? {
              TEST_ADMIN_DATABASE_URL:
                "postgresql://admin:synthetic-admin@localhost:32768/postgres",
            }
          : {}),
      });
      await f.imported;
      expect(f.skipIf.mock.calls.every(([skip]) => skip === false)).toBe(true);
      expect(f.connect).not.toHaveBeenCalled();
      expect(f.api).not.toHaveBeenCalled();
      expect(f.worker).not.toHaveBeenCalled();
      expect(process.env.DATABASE_URL).toBe(
        "postgres://test:synthetic-password@127.0.0.1:32768/dispatch_test",
      );
      expect(process.env.REDIS_URL).toBe("redis://127.0.0.1:32769/15");
      for (const hook of f.hooks.beforeAll!) await hook();
      expect(f.connect.mock.calls.slice(0, 2)).toEqual([
        [
          explicitAdmin
            ? "postgresql://admin:synthetic-admin@127.0.0.1:32768/postgres"
            : "postgres://test:synthetic-password@127.0.0.1:32768/postgres",
        ],
        ["postgres://test:synthetic-password@127.0.0.1:32768/dispatch_test"],
      ]);
      expect(f.query).toHaveBeenCalledWith(
        "select 1 from pg_database where datname = $1",
        ["dispatch_test"],
      );
      expect(f.query).toHaveBeenCalledWith('create database "dispatch_test"');
      expect(f.migrate).toHaveBeenCalledOnce();
      expect(f.api).toHaveBeenCalledOnce();
      expect(f.worker).toHaveBeenCalledOnce();
      expect(f.appEnv).toEqual(
        Array(2).fill({
          DATABASE_URL:
            "postgres://test:synthetic-password@127.0.0.1:32768/dispatch_test",
          REDIS_URL: "redis://127.0.0.1:32769/15",
        }),
      );
      expect(f.redisClient.mock.calls).toEqual(
        Array(2).fill(["redis://127.0.0.1:32769/15"]),
      );
      // Exercise the actual destructive fixture helpers, entirely through the mocked DB.
      for (const hook of f.hooks.beforeEach!) await hook();
      expect(f.query).toHaveBeenCalledWith(
        'truncate "fixture" restart identity cascade',
      );
      expect(
        f.query.mock.calls.some(([sql]) =>
          sql.startsWith("insert into tenants"),
        ),
      ).toBe(true);
      expect(process.env.AUTH_RATE_LIMIT_PER_SECOND).toBe("1000");
      expect(process.env.TELEMETRY_FLUSH_MS).toBe("600000");
      for (const hook of f.hooks.afterEach!) await hook();
      for (const hook of f.hooks.afterAll!) await hook();
    },
  );
});
