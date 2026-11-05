import { db } from "../db/knex";
import { buildCandidate } from "./graphs";
buildCandidate()
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : "BUILD_FAILED");
    process.exitCode = 1;
  })
  .finally(() => db.destroy());
