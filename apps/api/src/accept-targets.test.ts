import { describe, expect, it } from "vitest";
import { acceptTargets } from "./accept-targets.js";

const approved = {
  TEST_DATABASE_URL:
    "postgres://test:synthetic-password@localhost:32768/dispatch_test",
  TEST_REDIS_URL: "redis://localhost:32769",
};
const admin =
  "postgres://admin:synthetic-admin-password@localhost:32768/postgres";
type Targets = Parameters<typeof acceptTargets>[0];

function refusal(resolved: Targets, supplied: Targets, variable: string) {
  let error: unknown;
  try {
    acceptTargets(resolved, supplied);
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toMatch(new RegExp(`^${variable}: `));
  expect((error as Error).message).not.toMatch(
    /synthetic|@|:\/\/|Invalid URL|input|secret/i,
  );
  expect((error as Error).cause).toBeUndefined();
}

describe("acceptTargets", () => {
  it("skips only entirely absent optional configuration", () => {
    expect(acceptTargets({}, {})).toBeUndefined();
    expect(
      acceptTargets({ REQUIRE_INTEGRATION_TESTS: "false" }, {}),
    ).toBeUndefined();
  });

  it.each(["resolved", "supplied"] as const)(
    "refuses absent required configuration in %s",
    (snapshot) => {
      refusal(
        snapshot === "resolved" ? { REQUIRE_INTEGRATION_TESTS: "true" } : {},
        snapshot === "supplied" ? { REQUIRE_INTEGRATION_TESTS: "true" } : {},
        "REQUIRE_INTEGRATION_TESTS",
      );
    },
  );

  it("canonicalizes both hosts and derives admin only from the approved DB", () => {
    const input = Object.freeze({ ...approved });
    expect(acceptTargets(input, input)).toEqual({
      databaseUrl:
        "postgres://test:synthetic-password@127.0.0.1:32768/dispatch_test",
      redisUrl: "redis://127.0.0.1:32769",
      adminUrl: "postgres://test:synthetic-password@127.0.0.1:32768/postgres",
    });
    expect(input).toEqual(approved);
  });

  it.each(["postgres", "postgresql"])(
    "allows %s and encoded credentials without changing them",
    (scheme) => {
      const values = {
        TEST_DATABASE_URL: `${scheme}://user%40test:synthetic%2Fpassword@127.0.0.1:32768/dispatch_test`,
        TEST_REDIS_URL: "redis://user:synthetic%23password@127.0.0.1:32769/0",
        TEST_ADMIN_DATABASE_URL: `${scheme}://admin:synthetic-admin-password@localhost:32768/postgres`,
        REQUIRE_INTEGRATION_TESTS: "true",
      };
      expect(acceptTargets(values, values)).toEqual({
        databaseUrl: values.TEST_DATABASE_URL,
        redisUrl: values.TEST_REDIS_URL,
        adminUrl: values.TEST_ADMIN_DATABASE_URL.replace(
          "localhost",
          "127.0.0.1",
        ),
      });
    },
  );

  it.each(["", "/", ...Array.from({ length: 16 }, (_, i) => `/${i}`)])(
    "allows Redis path %j",
    (path) => {
      const values = {
        ...approved,
        TEST_REDIS_URL: `redis://localhost:32769${path}`,
      };
      expect(acceptTargets(values, values)?.redisUrl).toBe(
        `redis://127.0.0.1:32769${path}`,
      );
    },
  );

  it.each([
    [{}, approved, "TEST_DATABASE_URL"],
    [approved, {}, "TEST_DATABASE_URL"],
    [
      { TEST_DATABASE_URL: approved.TEST_DATABASE_URL },
      { TEST_DATABASE_URL: approved.TEST_DATABASE_URL },
      "TEST_REDIS_URL",
    ],
    [
      { TEST_REDIS_URL: approved.TEST_REDIS_URL },
      { TEST_REDIS_URL: approved.TEST_REDIS_URL },
      "TEST_DATABASE_URL",
    ],
    [
      approved,
      { TEST_DATABASE_URL: approved.TEST_DATABASE_URL },
      "TEST_REDIS_URL",
    ],
    [
      approved,
      { TEST_REDIS_URL: approved.TEST_REDIS_URL },
      "TEST_DATABASE_URL",
    ],
    [
      { TEST_DATABASE_URL: approved.TEST_DATABASE_URL },
      approved,
      "TEST_REDIS_URL",
    ],
    [
      { TEST_REDIS_URL: approved.TEST_REDIS_URL },
      approved,
      "TEST_DATABASE_URL",
    ],
    [{ TEST_ADMIN_DATABASE_URL: admin }, {}, "TEST_DATABASE_URL"],
    [{}, { TEST_ADMIN_DATABASE_URL: admin }, "TEST_DATABASE_URL"],
  ] satisfies Array<[Targets, Targets, string]>)(
    "refuses implicit or partial snapshots %#",
    (resolved, supplied, name) => {
      refusal(resolved, supplied, name);
    },
  );

  it("refuses inherited admin even when it has an approved address", () => {
    refusal(
      { ...approved, TEST_ADMIN_DATABASE_URL: admin },
      approved,
      "TEST_ADMIN_DATABASE_URL",
    );
    refusal(
      { ...approved, TEST_ADMIN_DATABASE_URL: "" },
      approved,
      "TEST_ADMIN_DATABASE_URL",
    );
    refusal(
      approved,
      { ...approved, TEST_ADMIN_DATABASE_URL: admin },
      "TEST_ADMIN_DATABASE_URL",
    );
  });

  const postgresInvalid = [
    "",
    "not a URL",
    "/dispatch_test",
    "postgres:localhost:32768/dispatch_test",
    "postgres://",
    "postgres:///dispatch_test",
    "postgres://localhost/dispatch_test",
    "postgres://localhost:5432/dispatch_test",
    "postgres://localhost:032768/dispatch_test",
    "postgres://localhost:65536/dispatch_test",
    "postgres://localhost:32768",
    "postgres://localhost:32768/",
    "postgres://localhost:32768/dispatch",
    "postgres://localhost:32768/postgres",
    "postgres://localhost:32768/dispatch_test/",
    "postgres://localhost:32768/else/../dispatch_test",
    "postgres://localhost:32768/%64ispatch_test",
    "postgres://home-server:32768/dispatch_test",
    "postgres://db.rds.amazonaws.com:32768/dispatch_test",
    "postgres://127.1:32768/dispatch_test",
    "postgres://2130706433:32768/dispatch_test",
    "postgres://127.0.0.2:32768/dispatch_test",
    "postgres://[::1]:32768/dispatch_test",
    "postgres://LOCALHOST:32768/dispatch_test",
    "postgres://localhost.:32768/dispatch_test",
    "postgres://%6cocalhost:32768/dispatch_test",
    "POSTGRES://localhost:32768/dispatch_test",
    "mysql://localhost:32768/dispatch_test",
    "postgres://localhost:32768/dispatch_test?",
    "postgres://localhost:32768/dispatch_test?host=home-server",
    "postgres://localhost:32768/dispatch_test#",
    "postgres://localhost:32768/dispatch_test#fragment",
    " postgres://localhost:32768/dispatch_test",
    "postgres://localhost:32768/dispatch_test\n",
    "postgres://local\thost:32768/dispatch_test",
    "postgres://localhost:32768\\dispatch_test",
    "postgres://synthetic:%ZZ@localhost:32768/dispatch_test",
    "postgres://synthetic:%FF@localhost:32768/dispatch_test",
    "postgres://synthetic:password@foreign@localhost:32768/dispatch_test",
    "postgres://synthetic:password@localhost:32768/dispatch_test?password=synthetic-secret",
  ];
  const redisInvalid = [
    "",
    "not a URL",
    "redis://",
    "redis:///0",
    "redis://localhost",
    "redis://localhost:6379",
    "redis://localhost:032769",
    "redis://localhost:32768",
    "redis://home-server:32769",
    "redis://cache.amazonaws.com:32769",
    "redis://[::1]:32769",
    "redis://127.1:32769",
    "redis://LOCALHOST:32769",
    "rediss://localhost:32769",
    "http://localhost:32769",
    "redis://localhost:32769/-1",
    "redis://localhost:32769/16",
    "redis://localhost:32769/01",
    "redis://localhost:32769/1.0",
    "redis://localhost:32769/+1",
    "redis://localhost:32769/%31",
    "redis://localhost:32769//",
    "redis://localhost:32769/1/",
    "redis://localhost:32769/other",
    "redis://localhost:32769/else/../0",
    "redis://localhost:32769?",
    "redis://localhost:32769?db=0",
    "redis://localhost:32769#",
    "redis://localhost:32769#fragment",
    "redis://localhost:32769\n",
    "redis://local\thost:32769",
    "redis://synthetic:%ZZ@localhost:32769",
    "redis://synthetic:%FF@localhost:32769",
  ];
  for (const [name, invalid] of [
    ["TEST_DATABASE_URL", postgresInvalid],
    ["TEST_REDIS_URL", redisInvalid],
    [
      "TEST_ADMIN_DATABASE_URL",
      [
        "",
        "not a URL",
        "postgres://localhost/postgres",
        "postgres://localhost:5432/postgres",
        "postgres://127.0.0.2:32768/postgres",
        "postgres://home-server:32768/postgres",
        "postgres://localhost:32768/dispatch_test",
        "postgres://localhost:32768/dispatch",
        "postgres://localhost:32768/else/../postgres",
        "postgres://localhost:32768/postgres?",
        "postgres://localhost:32768/postgres#",
        "postgres://localhost:32768/postgres\n",
        "postgres://synthetic:%ZZ@localhost:32768/postgres",
      ],
    ],
  ] as const) {
    it.each(invalid.map((value, index) => [index, value] as const))(
      `refuses unsafe ${name} case %i in either snapshot with redacted errors`,
      (_index, value) => {
        const safe = { ...approved, TEST_ADMIN_DATABASE_URL: admin };
        const unsafe = { ...safe, [name]: value };
        refusal(unsafe, safe, name);
        refusal(safe, unsafe, name);
      },
    );
  }
});
