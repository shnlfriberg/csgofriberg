// Read-only parity check. Reviewed extensions are bound to exact hashes.
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, relative, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(resolve(root, 'integration/upstream-baseline.json'), 'utf8'));
const args = process.argv.slice(2);
let source;
let output;
let remote = false;
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--remote') remote = true;
  else if (args[i] === '--source' && args[i + 1]) source = resolve(args[++i]);
  else if (args[i] === '--output' && args[i + 1]) output = resolve(root, args[++i]);
  else throw new Error('Usage: node scripts/check-upstream.mjs [--source CHECKOUT] [--remote] [--output REPORT.json]');
}
const hash = (bytes) => createHash('sha256').update(bytes.toString('latin1').replace(/\r\n/g, '\n'), 'latin1').digest('hex');
const git = (...params) => execFileSync('git', params, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim();
const report = {
  repository: baseline.repository,
  branch: baseline.branch,
  commit: baseline.commit,
  checkedAt: new Date().toISOString(),
  identical: [],
  reviewedDifferences: [],
  ignoredGenerated: baseline.ignoredGenerated,
  missing: [],
  unexpectedDifferences: [],
};

if (source) {
  if (git('-C', source, 'rev-parse', 'HEAD') !== baseline.commit) throw new Error('Source checkout must be at the pinned upstream commit.');
  if (git('-C', source, 'status', '--porcelain', '--untracked-files=no')) throw new Error('Source checkout has tracked changes.');
  const paths = git('-C', source, 'ls-files', '-z').split('\0').filter(Boolean);
  const expected = [...Object.keys(baseline.files), ...baseline.ignoredGenerated].sort();
  if (JSON.stringify(paths.sort()) !== JSON.stringify(expected)) throw new Error('Source file inventory differs from baseline.');
  for (const [path, entry] of Object.entries(baseline.files)) {
    if (hash(readFileSync(resolve(source, path))) !== entry.upstreamSha256) throw new Error(`Upstream hash mismatch: ${path}`);
  }
}
if (remote) {
  const ref = git('ls-remote', '--exit-code', baseline.repository, `refs/heads/${baseline.branch}`);
  report.remoteCommit = ref.split(/\s+/)[0];
  report.upstreamAdvanced = report.remoteCommit !== baseline.commit;
}
for (const [path, entry] of Object.entries(baseline.files)) {
  const file = resolve(root, path);
  if (!existsSync(file)) { report.missing.push(path); continue; }
  const actual = hash(readFileSync(file));
  if (actual === entry.upstreamSha256) report.identical.push(path);
  else if (entry.localSha256 && actual === entry.localSha256) report.reviewedDifferences.push({ path, reason: entry.reason });
  else report.unexpectedDifferences.push(path);
}
report.ok = !report.missing.length && !report.unexpectedDifferences.length && !report.upstreamAdvanced;
if (output) {
  const path = relative(root, output);
  if (path.startsWith('..') || isAbsolute(path)) throw new Error('Report must be saved inside the workspace.');
  if (existsSync(output)) throw new Error('Report already exists; choose a new output path.');
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
}
console.log(`${report.ok ? 'PASS' : 'FAIL'} ${baseline.repository} @ ${baseline.commit.slice(0, 7)}`);
console.log(`${report.identical.length} identical; ${report.reviewedDifferences.length} reviewed extensions/tooling; ${report.missing.length} missing; ${report.unexpectedDifferences.length} unexpected; ${baseline.ignoredGenerated.length} generated files ignored.`);
for (const path of report.missing) console.error(`Missing: ${path}`);
for (const path of report.unexpectedDifferences) console.error(`Review required: ${path}`);
if (report.upstreamAdvanced) console.error(`Upstream changed to ${report.remoteCommit}; fetch and review before updating the baseline.`);
process.exitCode = report.ok ? 0 : 1;
