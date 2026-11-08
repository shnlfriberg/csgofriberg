const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { getBuildInfo } = require('./build-info.cjs');

function fixture(t, withGit = true) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'friberg-version-'));
  t.after(() => {
    assert.equal(path.dirname(cwd), path.resolve(os.tmpdir()));
    assert.ok(path.basename(cwd).startsWith('friberg-version-'));
    fs.rmSync(cwd, { recursive: true, force: true });
  });
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ version: '1.2.3' }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  if (withGit) {
    git('init');
    git('add', 'package.json');
    git('-c', 'user.name=Build Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  }
  return { cwd, git, env: {}, now: new Date('2026-11-08T00:00:00.000Z') };
}

test('main build identifies its exact commit without claiming a release', (t) => {
  const options = fixture(t);
  const info = getBuildInfo(options);
  assert.equal(info.gitCommit, options.git('rev-parse', 'HEAD'));
  assert.equal(info.version, `1.2.3-dev+g${info.gitCommit.slice(0, 7)}`);
  assert.equal(info.dirty, false);
  assert.equal(info.releaseTag, null);
  assert.equal(info.builtAt, options.now.toISOString());
});

test('release tag must exactly match the root package version', (t) => {
  const options = fixture(t);
  options.env = { GITHUB_REF_TYPE: 'tag', GITHUB_REF_NAME: 'v1.2.3' };
  assert.equal(getBuildInfo(options).version, '1.2.3');
  options.env.GITHUB_REF_NAME = 'v1.2.4';
  assert.throws(() => getBuildInfo(options), /must match/);
});

test('local data exports do not dirty a build, but untracked source does', (t) => {
  const options = fixture(t);
  fs.writeFileSync(path.join(options.cwd, 'players_backup.json'), '{}');
  assert.equal(getBuildInfo(options).dirty, false);
  fs.mkdirSync(path.join(options.cwd, 'client'));
  fs.writeFileSync(path.join(options.cwd, 'client/new.ts'), 'export {}');
  assert.equal(getBuildInfo(options).dirty, true);
  assert.match(getBuildInfo(options).version, /\.dirty$/);
  options.env.RELEASE_TAG = 'v1.2.3';
  assert.throws(() => getBuildInfo(options), /clean working tree/);
});

test('tracked modifications also mark the build dirty', (t) => {
  const options = fixture(t);
  fs.writeFileSync(path.join(options.cwd, 'package.json'), '{"version":"1.2.4"}');
  assert.equal(getBuildInfo(options).dirty, true);
});

test('Docker and CI resolve the same release metadata without .git', (t) => {
  const options = fixture(t, false);
  options.env = {
    OCI_REVISION: 'a'.repeat(40), OCI_VERSION: '1.2.3', RELEASE_TAG: 'v1.2.3',
    OCI_CREATED: options.now.toISOString(), BUILD_REQUIRE_GIT: 'true',
  };
  const info = getBuildInfo(options);
  assert.equal(info.version, options.env.OCI_VERSION);
  assert.equal(info.gitCommit, options.env.OCI_REVISION);
  assert.equal(info.builtAt, options.env.OCI_CREATED);
  delete options.env.OCI_CREATED;
  assert.throws(() => getBuildInfo(options), /Docker builds require/);
});

test('rejects malformed revisions and inconsistent OCI labels', (t) => {
  const options = fixture(t, false);
  options.env.OCI_REVISION = 'abc1234';
  assert.throws(() => getBuildInfo(options), /full 40-character/);
  options.env.OCI_REVISION = 'b'.repeat(40);
  options.env.OCI_VERSION = 'wrong';
  assert.throws(() => getBuildInfo(options), /does not match/);
});

test('child builds preserve the parent identity even when run later', (t) => {
  const options = fixture(t);
  const info = getBuildInfo(options);
  options.env.BUILD_INFO_JSON = JSON.stringify(info);
  options.now = new Date('2030-01-01');
  assert.deepEqual(getBuildInfo(options), info);
});
