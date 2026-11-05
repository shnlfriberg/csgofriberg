import { spawn } from "child_process";
import path from "path";
import { randomUUID } from "crypto";
import { db } from "../db/knex";
import { lockRow, transaction } from "./transaction";
export async function queueBuild() {
  return transaction(async (trx) => {
    await lockRow(trx, "card_catalog", { id: 1 });
    const old = await trx("card_build_jobs")
      .whereIn("status", ["pending", "running"])
      .first();
    if (old) return { id: old.id };
    const id = randomUUID();
    await trx("card_build_jobs").insert({
      id,
      status: "pending",
      due_at: Date.now(),
      result: null,
    });
    return { id };
  });
}
let active: Promise<void> | null = null;
export function processBuilds() {
  if (active) return active;
  active = (async () => {
    const job = await transaction(async (trx) => {
      await lockRow(trx, "card_catalog", { id: 1 });
      const row = await trx("card_build_jobs")
        .whereIn("status", ["pending", "running"])
        .where("due_at", "<=", Date.now())
        .first();
      if (!row) return null;
      const lease = randomUUID();
      await trx("card_build_jobs")
        .where({ id: row.id })
        .update({ status: "running", due_at: Date.now() + 600000, lease });
      return { ...row, lease };
    });
    if (!job) return;
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          ...process.execArgv,
          path.join(__dirname, `build${path.extname(__filename)}`),
        ],
        { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
      );
      let output = "";
      const capture = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-4000);
      };
      child.stdout.on("data", capture);
      child.stderr.on("data", capture);
      let completed = false;
      const timeout = setTimeout(() => child.kill(), 540000);
      const complete = (code: number | null) => {
        if (completed) return;
        completed = true;
        clearTimeout(timeout);
        void db("card_build_jobs")
          .where({ id: job.id, lease: job.lease })
          .update({
            status: code === 0 ? "completed" : "failed",
            result: output,
            due_at: 0,
          })
          .then(() => resolve(), reject);
      };
      child.once("error", (e) => {
        output = e.message;
        complete(1);
      });
      child.once("close", complete);
    });
  })().finally(() => {
    active = null;
  });
  return active;
}
