import "@dispatchmail/core/env";
import { connect } from "./index.js";
import { migrate } from "./migration.js";

const db = connect();

try {
  await migrate(db);
  console.log("migrated");
} finally {
  await db.end();
}
