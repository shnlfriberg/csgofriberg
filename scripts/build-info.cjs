const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const source = 'https://github.com/shnlfriberg/csgofriberg';
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(cwd, args) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

function getBuildInfo({ cwd = root, env = process.env, now = new Date() } = {}) {
  // The parent build freezes metadata for every child process, including Vite.
  if (env.BUILD_INFO_JSON) return JSON.parse(env.BUILD_INFO_JSON);
  const baseVersion = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8')).version;
  if (!versionPattern.test(baseVersion)) throw new Error('Root package version must be X.Y.Z');
  const releaseTag = env.RELEASE_TAG || (env.GITHUB_REF_TYPE === 'tag' ? env.GITHUB_REF_NAME : '') || null;
  if (releaseTag && releaseTag !== `v${baseVersion}`) {
    throw new Error(`Release tag ${releaseTag} must match package version v${baseVersion}`);
  }
  const gitCommit = env.OCI_REVISION || env.GITHUB_SHA || git(cwd, ['rev-parse', 'HEAD']) || null;
  if (gitCommit && !/^[a-f0-9]{40}$/.test(gitCommit)) throw new Error('Git revision must be a full 40-character hash');
  if (env.BUILD_REQUIRE_GIT === 'true' && (!gitCommit || !env.OCI_VERSION || !env.OCI_CREATED)) {
    throw new Error('Docker builds require OCI_REVISION, OCI_VERSION and OCI_CREATED');
  }
  const hasGit = Boolean(git(cwd, ['rev-parse', '--show-toplevel']));
  const dirty = hasGit && Boolean(
    git(cwd, ['status', '--porcelain', '--untracked-files=no']) ||
    git(cwd, ['ls-files', '--others', '--exclude-standard', '--', 'client', 'server', 'packages', 'scripts', 'pow-wasm'])
  );
  if (releaseTag && dirty) throw new Error('A release build requires a clean working tree');
  const version = releaseTag ? baseVersion : `${baseVersion}-dev${gitCommit ? `+g${gitCommit.slice(0, 7)}${dirty ? '.dirty' : ''}` : ''}`;
  if (env.OCI_VERSION && env.OCI_VERSION !== version) throw new Error('OCI_VERSION does not match build version');
  const builtAt = env.OCI_CREATED || now.toISOString();
  if (!Number.isFinite(Date.parse(builtAt))) throw new Error('Invalid build timestamp');
  return { version, gitCommit, builtAt, source: env.OCI_SOURCE || source, releaseTag, dirty };
}

function writeServerInfo(info) {
  const directory = path.join(root, 'server/src/generated');
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'buildInfo.json'), `${JSON.stringify(info, null, 2)}\n`);
}

if (require.main === module) {
  try {
    const info = getBuildInfo();
    const command = process.argv[2];
    if (command === 'ci') {
      if (!info.gitCommit) throw new Error('CI requires a Git revision');
      const values = {
        version: info.version, revision: info.gitCommit, created: info.builtAt, source: info.source,
        release_tag: info.releaseTag || '', stable: Boolean(info.releaseTag),
        resource_version: String(Date.parse(info.builtAt)),
      };
      fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''));
    } else if (command === 'json' || command === 'write-server') {
      writeServerInfo(info);
      if (command === 'json') process.stdout.write(JSON.stringify(info));
    } else if (command === 'run') {
      writeServerInfo(info);
      const packageManager = process.env.npm_execpath;
      if (!packageManager) throw new Error('Run this build through pnpm');
      const nodeScript = /\.[cm]?js$/.test(packageManager);
      const result = spawnSync(nodeScript ? process.execPath : packageManager, [...(nodeScript ? [packageManager] : []), 'run', process.argv[3]], {
        cwd: root, stdio: 'inherit', env: { ...process.env, BUILD_INFO_JSON: JSON.stringify(info) },
      });
      if (result.error) throw result.error;
      process.exitCode = result.status ?? 1;
    } else {
      throw new Error('Usage: build-info.cjs ci|json|write-server|run <script>');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { getBuildInfo };
