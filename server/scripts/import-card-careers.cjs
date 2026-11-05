// Explicit local rollout tool. Dry-run by default; never edits legacy players.
const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { db } = require('../dist/db/knex');
const { careerSubmissionSchema, submitCareer, reviewCareer } = require('../dist/card-link/careers');
const { mergeCareer, sameCareerData } = require('../dist/card-link/careerSync');
const { buildCandidate, publishGraph } = require('../dist/card-link/graphs');
const { createRound, graphIndex, shortestPath } = require('@friberg/card-link-core');
const args = process.argv.slice(2);
const input = args[0];
if (!input || !process.env.DB_URL) throw new Error('Usage: explicit DB_URL + import-card-careers.cjs AUDIT.json [--apply] [--publish]');
const apply = args.includes('--apply'), publish = args.includes('--publish');
if (publish && !apply) throw new Error('--publish requires --apply');

async function main() {
  const bytes = fs.readFileSync(input), audit = JSON.parse(bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const report = { observedAt: new Date().toISOString(), auditSha256: hash, total: audit.total, approved: 0, updated: 0, pending: 0, existing: 0, absent: 0, mode: apply ? 'apply' : 'dry-run' };
  const reviewer = Number(args[args.indexOf('--reviewer') + 1]);
  const admin = Number.isInteger(reviewer) && reviewer > 0
    ? await db('users').where({ role: 'admin', id: reviewer }).select('id').first()
    : null;
  if (apply && !admin) throw new Error('LOCAL_ADMIN_REQUIRED');
  // Validate the entire input and its retained source before the first write.
  const prepared = [];
  for (const item of audit.items) {
    if (!item.career) { report.absent++; continue; }
    const wiki = fs.readFileSync(path.join(path.dirname(input), `${item.playerId}.wiki`), 'utf8').replace(/\r\n/g, '\n');
    if (createHash('sha256').update(wiki).digest('hex') !== item.wikiSha256) throw new Error(`SOURCE_CHANGED:${item.playerId}`);
    const submission = careerSubmissionSchema.parse({ playerId: item.playerId, expectedRevision: 0, career: item.career });
    if (item.reviewReady && (item.flags.length || !/^liquipedia:counterstrike:\d+$/.test(item.career.personKey))) throw new Error(`INVALID_REVIEW:${item.playerId}`);
    prepared.push({ item, submission });
  }
  for (const { item, submission } of prepared) {
    const existing = await db('card_careers').where({ player_id: item.playerId }).first();
    if (existing) {
      const current = JSON.parse(existing.payload);
      if (!args.includes('--update-reviewed') || !item.reviewReady || sameCareerData(current, mergeCareer(current, submission.career, false).career)) { report.existing++; continue; }
      if (current.locked || current.personKey !== submission.career.personKey) throw new Error(`MANUAL_REVIEW_REQUIRED:${item.playerId}`);
      submission.expectedRevision = Number(existing.revision);
      report.updated++;
    }
    if (apply) {
      const review = await submitCareer(submission, `local-audit:${hash.slice(0, 24)}`, createHash('sha256').update(`${hash}:${item.playerId}`).digest('hex'));
      if (item.reviewReady && review.status !== 'unchanged') {
        if (review.status === 'conflict') throw new Error(`MANUAL_REVIEW_REQUIRED:${item.playerId}`);
        const result = await reviewCareer(review.id, true, Number(admin.id));
        if (result.status !== 'approved') throw new Error(`REVIEW_CONFLICT:${item.playerId}`);
      }
    }
    report[item.reviewReady ? 'approved' : 'pending']++;
  }
  if (publish) {
    const graph = await buildCandidate();
    const row = await db('card_graphs').where({ version: graph.version }).first();
    const data = JSON.parse(row.payload), index = graphIndex(data);
    // Verify every persisted endpoint candidate, then sample hand construction
    // across all difficulties. A failed validation leaves the old pointer intact.
    let checked = 0;
    for (const [difficulty, pairs] of Object.entries(data.pairs)) {
      const bounds = difficulty === 'easy' ? [2, 2] : difficulty === 'normal' ? [3, 3] : [4, 5];
      for (const [start, end] of pairs) {
        const route = shortestPath(index, start, end);
        if (!route || route.length - 1 < bounds[0] || route.length - 1 > bounds[1]) throw new Error('INVALID_ENDPOINT_PAIR');
        checked++;
      }
      for (let seed = 1; seed <= 1000; seed++) {
        const [start, end] = pairs[seed % pairs.length];
        const q = { graphVersion: data.version, start, end, pool: data.players.map(p => p.id).filter(id => id !== start && id !== end) };
        const state = createRound(index, q, 'limited', seed, 0, 180);
        if (!shortestPath(index, start, end, new Set([start, end, ...state.hand]))) throw new Error('UNSOLVABLE_INITIAL_HAND');
      }
    }
    await publishGraph(graph.version);
    report.graph = { ...graph, checkedEndpointPairs: checked, checkedHands: 3000 };
  }
  console.log(JSON.stringify(report, null, 2));
}
main().catch(e => { console.error(e.message); process.exitCode = 1; }).finally(() => db.destroy());
