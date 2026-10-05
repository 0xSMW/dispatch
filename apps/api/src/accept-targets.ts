type TargetEnv = {
  TEST_DATABASE_URL?: string;
  TEST_REDIS_URL?: string;
  TEST_ADMIN_DATABASE_URL?: string;
  REQUIRE_INTEGRATION_TESTS?: string;
};

type ApprovedTargets = {
  databaseUrl: string;
  redisUrl: string;
  adminUrl: string;
};

type TargetName = Exclude<keyof TargetEnv, "REQUIRE_INTEGRATION_TESTS">;
const names: TargetName[] = [
  "TEST_DATABASE_URL",
  "TEST_REDIS_URL",
  "TEST_ADMIN_DATABASE_URL",
];

function refuse(name: keyof TargetEnv, rule: string): never {
  throw new Error(`${name}: ${rule}`);
}

function target(value: string, name: TargetName, path: string) {
  const redis = name === "TEST_REDIS_URL";
  const schemes = redis ? "redis" : "postgres|postgresql";
  const port = redis ? "32769" : "32768";
  // Check the original spelling too: URL parsing can normalize malformed input.
  const shape = new RegExp(
    `^(?:${schemes})://(?:[^@/?#\\\\\\s]*@)?(?:localhost|127\\.0\\.0\\.1):${port}${path}$`,
  );
  if (/[\s\\]/.test(value) || !shape.test(value)) {
    refuse(
      name,
      redis
        ? "must use a redis URL with exact localhost or 127.0.0.1, explicit port 32769, and an empty path, /, or database /0 through /15; no query or fragment"
        : `must use a postgres or postgresql URL with exact localhost or 127.0.0.1, explicit port 32768, and exact ${path}; no query or fragment`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
    // The clients decode credentials. Reject invalid escapes without exposing parser errors.
    decodeURIComponent(url.username);
    decodeURIComponent(url.password);
  } catch {
    refuse(name, "must be a well-formed URL");
  }
  url.hostname = "127.0.0.1";
  return url;
}

/** Approve only explicitly supplied disposable targets, without loading env or creating clients. */
export function acceptTargets(
  resolved: TargetEnv,
  supplied: TargetEnv,
): ApprovedTargets | undefined {
  if (
    names.every(
      (name) => resolved[name] === undefined && supplied[name] === undefined,
    )
  ) {
    if (
      resolved.REQUIRE_INTEGRATION_TESTS === "true" ||
      supplied.REQUIRE_INTEGRATION_TESTS === "true"
    ) {
      refuse(
        "REQUIRE_INTEGRATION_TESTS",
        "requires explicit TEST_DATABASE_URL and TEST_REDIS_URL",
      );
    }
    return undefined;
  }

  for (const name of ["TEST_DATABASE_URL", "TEST_REDIS_URL"] as const) {
    if (supplied[name] === undefined)
      refuse(name, "must be explicitly supplied before env loading");
    if (resolved[name] === undefined)
      refuse(name, "must resolve with both database and Redis targets");
  }
  // Validate both snapshots. An env-loaded endpoint must never become execution or a skip.
  target(supplied.TEST_DATABASE_URL!, "TEST_DATABASE_URL", "/dispatch_test");
  target(supplied.TEST_REDIS_URL!, "TEST_REDIS_URL", "(?:/(?:[0-9]|1[0-5])?)?");
  const database = target(
    resolved.TEST_DATABASE_URL!,
    "TEST_DATABASE_URL",
    "/dispatch_test",
  );
  const redis = target(
    resolved.TEST_REDIS_URL!,
    "TEST_REDIS_URL",
    "(?:/(?:[0-9]|1[0-5])?)?",
  );

  let admin: URL;
  if (supplied.TEST_ADMIN_DATABASE_URL === undefined) {
    if (resolved.TEST_ADMIN_DATABASE_URL !== undefined) {
      refuse(
        "TEST_ADMIN_DATABASE_URL",
        "must be explicitly supplied before env loading or entirely absent",
      );
    }
    admin = new URL(database);
    admin.pathname = "/postgres";
  } else {
    target(
      supplied.TEST_ADMIN_DATABASE_URL,
      "TEST_ADMIN_DATABASE_URL",
      "/postgres",
    );
    if (resolved.TEST_ADMIN_DATABASE_URL === undefined) {
      refuse(
        "TEST_ADMIN_DATABASE_URL",
        "must resolve when explicitly supplied",
      );
    }
    admin = target(
      resolved.TEST_ADMIN_DATABASE_URL,
      "TEST_ADMIN_DATABASE_URL",
      "/postgres",
    );
    if (admin.hostname !== database.hostname || admin.port !== database.port) {
      refuse(
        "TEST_ADMIN_DATABASE_URL",
        "must share the approved database host and port",
      );
    }
  }
  return {
    databaseUrl: database.href,
    redisUrl: redis.href,
    adminUrl: admin.href,
  };
}
