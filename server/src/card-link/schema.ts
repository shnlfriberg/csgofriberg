import type { Knex } from "knex";
import { backfillCareerTenures } from "./careerMigration";
export const CARD_REQUIRED_COLUMNS: Record<string, string[]> = {
  card_career_tenures: [
    "player_id",
    "ordinal",
    "person_key",
    "team_id",
    "start_date",
    "end_date",
    "payload",
  ],
  card_build_jobs: ["id", "status", "due_at", "lease", "result"],
  card_catalog: ["id", "revision", "graph_version", "enabled", "practice_enabled", "daily_enabled", "friend_enabled", "ranked_enabled"],
  card_admin_events: ["id", "action", "actor", "payload", "created_at"],
  card_careers: ["player_id", "revision", "payload"],
  card_career_reviews: [
    "id",
    "player_id",
    "expected_revision",
    "payload",
    "status",
  ],
  card_graphs: ["version", "source_revision", "payload", "source_hash", "published_at"],
  card_matches: [
    "id",
    "code",
    "scene",
    "variant",
    "status",
    "revision",
    "due_at",
    "payload",
  ],
  card_seats: ["match_id", "identity_key", "revision", "payload"],
  card_requests: ["scope", "request_id", "fingerprint", "response"],
  card_daily_attempts: ["day", "variant", "identity_key", "match_id"],
  card_claims: ["guest_key", "user_id"],
  card_daily: ["day", "variant", "payload"],
  card_outbox: ["match_id", "attempts", "due_at", "error"],
  card_results: ["match_id", "payload"],
  card_participants: [
    "match_id",
    "identity_key",
    "user_id",
    "variant",
    "scene",
    "day",
    "solved",
    "hops",
    "elapsed",
  ],
  card_ratings: ["user_id", "variant", "rating"],
  card_rating_ledger: ["match_id", "user_id", "before", "after"],
  card_queue: ["identity_key", "variant", "queued_at", "payload"],
  card_reservations: ["identity_key", "match_id"],
};
export async function ensureCardSchema(k: Knex): Promise<void> {
  const create = async (
    name: string,
    fn: (t: Knex.CreateTableBuilder) => void,
  ) => {
    if (!(await k.schema.hasTable(name))) await k.schema.createTable(name, fn);
  };
  await create("card_build_jobs", (t) => {
    t.string("id", 36).primary();
    t.string("status", 16).notNullable();
    t.bigInteger("due_at").notNullable();
    t.string("lease", 36).nullable();
    t.text("result").nullable();
  });
  await create("card_catalog", (t) => {
    t.integer("id").primary();
    t.integer("revision").notNullable().defaultTo(0);
    t.string("graph_version", 64).nullable();
    t.boolean("enabled").notNullable().defaultTo(false);
  });
  await k("card_catalog")
    .insert({ id: 1, revision: 0, enabled: false })
    .onConflict("id")
    .ignore();
  for (const scene of ['practice', 'daily', 'friend', 'ranked']) {
    if (!(await k.schema.hasColumn('card_catalog', `${scene}_enabled`)))
      await k.schema.alterTable('card_catalog', t => t.boolean(`${scene}_enabled`).notNullable().defaultTo(true));
  }
  await create('card_admin_events', t => {
    t.string('id', 36).primary(); t.string('action', 32).notNullable();
    t.integer('actor').nullable(); t.text('payload').notNullable();
    t.bigInteger('created_at').notNullable(); t.index(['created_at']);
  });
  await create("card_careers", (t) => {
    t.integer("player_id").primary().references("id").inTable("players");
    t.integer("revision").notNullable();
    t.text("payload").notNullable();
  });
  await create("card_career_tenures", (t) => {
    t.integer("player_id")
      .notNullable()
      .references("player_id")
      .inTable("card_careers");
    t.integer("ordinal").notNullable();
    t.string("person_key", 180).notNullable();
    t.string("team_id", 180).notNullable();
    t.string("start_date", 10).nullable();
    t.string("end_date", 10).nullable();
    t.text("payload").notNullable();
    t.primary(["player_id", "ordinal"]);
    t.index(["person_key"]);
    t.index(["team_id", "start_date"]);
  });
  await create("card_career_reviews", (t) => {
    t.string("id", 36).primary();
    t.integer("player_id").notNullable().references("id").inTable("players");
    t.integer("expected_revision").notNullable();
    t.text("payload").notNullable();
    t.string("status", 16).notNullable();
    t.string("source", 128).notNullable();
    t.bigInteger("created_at").notNullable();
    t.integer("handled_by").nullable();
    t.index(["status", "created_at"]);
  });
  await create("card_graphs", (t) => {
    t.string("version", 64).primary();
    t.integer("source_revision").notNullable();
    t.text("payload").notNullable();
    t.bigInteger("created_at").notNullable();
  });
  await create("card_matches", (t) => {
    t.string("id", 36).primary();
    t.string("code", 8).nullable().unique();
    t.string("scene", 16).notNullable();
    t.string("variant", 16).notNullable();
    t.string("status", 16).notNullable();
    t.integer("revision").notNullable();
    t.bigInteger("due_at").nullable();
    t.text("payload").notNullable();
    t.index(["status", "due_at"]);
  });
  await create("card_seats", (t) => {
    t.string("match_id", 36)
      .notNullable()
      .references("id")
      .inTable("card_matches");
    t.string("identity_key", 128).notNullable();
    t.integer("revision").notNullable();
    t.text("payload").notNullable();
    t.primary(["match_id", "identity_key"]);
    t.index(["identity_key"]);
  });
  await create("card_requests", (t) => {
    t.string("scope", 180).notNullable();
    t.string("request_id", 64).notNullable();
    t.string("fingerprint", 64).notNullable();
    t.text("response").notNullable();
    t.primary(["scope", "request_id"]);
  });
  await create("card_daily", (t) => {
    t.string("day", 10).notNullable();
    t.string("variant", 16).notNullable();
    t.text("payload").notNullable();
    t.primary(["day", "variant"]);
  });
  await create("card_daily_attempts", (t) => {
    t.string("day", 10).notNullable();
    t.string("variant", 16).notNullable();
    t.string("identity_key", 128).notNullable();
    t.string("match_id", 36)
      .notNullable()
      .references("id")
      .inTable("card_matches");
    t.primary(["day", "variant", "identity_key"]);
  });
  await create("card_claims", (t) => {
    t.string("guest_key", 128).primary();
    t.integer("user_id").notNullable();
  });
  await create("card_outbox", (t) => {
    t.string("match_id", 36).primary();
    t.integer("attempts").notNullable().defaultTo(0);
    t.bigInteger("due_at").notNullable();
    t.text("error").nullable();
    t.index(["due_at"]);
  });
  await create("card_results", (t) => {
    t.string("match_id", 36).primary();
    t.text("payload").notNullable();
    t.bigInteger("created_at").notNullable();
  });
  await create("card_participants", (t) => {
    t.string("match_id", 36)
      .notNullable()
      .references("match_id")
      .inTable("card_results");
    t.string("identity_key", 128).notNullable();
    t.integer("user_id").nullable();
    t.string("variant", 16).notNullable();
    t.string("scene", 16).notNullable();
    t.string("day", 10).nullable();
    t.integer("solved").notNullable();
    t.integer("hops").notNullable();
    t.bigInteger("elapsed").notNullable();
    t.primary(["match_id", "identity_key"]);
    t.index(["identity_key", "variant"]);
    t.index(["day", "variant", "solved", "hops"]);
  });
  await create("card_ratings", (t) => {
    t.integer("user_id").notNullable();
    t.string("variant", 16).notNullable();
    t.integer("rating").notNullable();
    t.primary(["user_id", "variant"]);
    t.index(["variant", "rating"]);
  });
  await create("card_rating_ledger", (t) => {
    t.string("match_id", 36).notNullable();
    t.integer("user_id").notNullable();
    t.integer("before").notNullable();
    t.integer("after").notNullable();
    t.primary(["match_id", "user_id"]);
  });
  await create("card_queue", (t) => {
    t.string("identity_key", 128).primary();
    t.string("variant", 16).notNullable();
    t.bigInteger("queued_at").notNullable();
    t.text("payload").notNullable();
    t.index(["variant", "queued_at"]);
  });
  await create("card_reservations", (t) => {
    t.string("identity_key", 128).primary();
    t.string("match_id", 36).notNullable();
  });
  if (!(await k.schema.hasColumn('card_graphs', 'source_hash')))
    await k.schema.alterTable('card_graphs', t => t.string('source_hash', 64).nullable());
  if (!(await k.schema.hasColumn('card_graphs', 'published_at'))) {
    await k.schema.alterTable('card_graphs', t => t.bigInteger('published_at').nullable());
  }
  {
    // Evidence of actual use is sufficient for legacy published versions. Do
    // not label every saved candidate as published, or rewrite graph payloads.
    const versions = new Set<string>();
    const catalog = await k('card_catalog').where({ id: 1 }).first();
    if (catalog?.graph_version) versions.add(catalog.graph_version);
    for (const table of ['card_matches', 'card_daily', 'card_results']) {
      for (let offset = 0; ; offset += 200) {
        const rows = await k(table).select('payload').orderBy(table === 'card_matches' ? 'id' : table === 'card_daily' ? 'day' : 'match_id').limit(200).offset(offset);
        for (const row of rows) {
          try {
            const value = JSON.parse(row.payload);
            if (table === 'card_results' && value.match?.graphVersion) versions.add(value.match.graphVersion);
            else for (const q of (table === 'card_daily' ? value : value.questions) ?? []) if (q.graphVersion) versions.add(q.graphVersion);
          } catch { /* Existing incompatible history remains untouched. */ }
        }
        if (rows.length < 200) break;
      }
    }
    for (const version of versions) await k('card_graphs').where({ version }).whereNull('published_at').update({ published_at: k.ref('created_at') });
  }
  await backfillCareerTenures(k);
}
