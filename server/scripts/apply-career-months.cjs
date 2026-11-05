// Apply a reviewed browser-evidence report through the ordinary career service.
// No graph publication, legacy-player writes or schema changes. Dry-run by default.
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { db } = require('../dist/db/knex');
const { careerSchema, submitCareer, reviewCareer } = require('../dist/card-link/careers');
const args = process.argv.slice(2), input = args[0];
if (!input || !process.env.DB_URL) throw Error('Explicit DB_URL and correction report are required');
const apply = args.includes('--apply');
const reviewer = Number(args[args.indexOf('--reviewer') + 1]);

async function main() {
  const bytes = fs.readFileSync(input), report = JSON.parse(bytes);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (apply && !await db('users').where({ id: reviewer, role: 'admin' }).first()) throw Error('LOCAL_ADMIN_REQUIRED');
  const prepared = [];
  for (const item of report.corrections) {
    const career = careerSchema.parse(item.career);
    const row = await db('card_careers').where({ player_id: item.playerId }).first();
    if (!row || Number(row.revision) !== item.expectedRevision) throw Error(`REVISION_CHANGED:${item.playerId}`);
    const old = careerSchema.parse(JSON.parse(row.payload));
    if (old.locked || old.personKey !== career.personKey || old.tenures.length !== career.tenures.length) throw Error(`IDENTITY_OR_SHAPE_CHANGED:${item.playerId}`);
    // A month supplement may only improve start/end precision and attach its
    // evidence; changing teams, roles, game, original text or exact days fails.
    let changed = 0;
    career.tenures.forEach((tenure, i) => {
      const before = old.tenures[i];
      if (JSON.stringify(before) === JSON.stringify(tenure)) return;
      changed++;
      if (!['year', 'unknown'].includes(before.precision) || tenure.precision !== 'month' || !tenure.manual || !/^https:\/\/www\.hltv\.org\/player\/\d+\//.test(tenure.manual.source)) throw Error(`INVALID_CORRECTION:${item.playerId}:${i}`);
      if (JSON.stringify(tenure.sourceSnapshot) !== JSON.stringify(before)) throw Error(`SOURCE_CHANGED:${item.playerId}:${i}`);
      for (const key of ['teamId', 'team', 'game', 'status', 'rawDates', 'source', 'verified'])
        if (tenure[key] !== before[key]) throw Error(`UNRELATED_CHANGE:${item.playerId}:${i}:${key}`);
      if (tenure.manual.fields.some(k => !['start', 'end', 'precision'].includes(k))) throw Error('UNEXPECTED_PROTECTED_FIELD');
    });
    if (changed !== item.changes.length) throw Error(`CHANGE_COUNT_MISMATCH:${item.playerId}`);
    prepared.push({ ...item, career });
  }
  const result = { mode: apply ? 'apply' : 'dry-run', reportSha256: digest, players: prepared.length, tenures: report.correctedTenures, applied: [] };
  for (const item of prepared) {
    if (!apply) continue;
    const review = await submitCareer({ playerId: item.playerId, expectedRevision: item.expectedRevision, career: item.career }, `admin:${reviewer}:hltv-browser`, createHash('sha256').update(`${digest}:${item.playerId}`).digest('hex'));
    if (review.status !== 'pending') throw Error(`REVIEW_NOT_PENDING:${item.playerId}:${review.status}`);
    const accepted = await reviewCareer(review.id, true, reviewer);
    if (accepted.status !== 'approved') throw Error(`REVIEW_FAILED:${item.playerId}`);
    result.applied.push({ playerId: item.playerId, reviewId: review.id, tenures: item.changes.length });
  }
  console.log(JSON.stringify(result, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.destroy());
