import "dotenv/config";
import { connect } from "./index.js";
import { schema } from "./schema.js";

const db = connect();

try {
  await db.query(schema);
  console.log("migrated");
} finally {
  await db.end();
}
