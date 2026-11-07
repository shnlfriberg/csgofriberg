import fs from 'node:fs/promises';
import { savePointModels } from './pointStore';
import { createReadStream, createWriteStream } from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { Transform, type Readable, type Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ZipFile } from 'yazl';
import * as yauzl from 'yauzl';
import sharp from 'sharp';
import { z } from 'zod';
import { db } from '../db/knex';
import { HttpError } from '../middleware/common';
import { assetDirectory, assetPath } from './assets';
import { withKeyLock } from './lock';
import { captureDraftSchema, mapSchema, questionSchema } from './validation';
import { mapGeometry } from './coordinates';
import { captureImages, sameCapturePoint, sameWorldPosition } from './capturePoints';
import type { CaptureDraft, MapDefinition, Question } from './types';
import { assertStorageRoom, directoryBytes, storageLimits } from './storageQuota';

const transferRoot = path.join(assetDirectory, '.bank-transfer');
const maxBytes = 1024 * 1024 * 1024;
const maxImageBytes = 16 * 1024 * 1024;
const maxManifestBytes = 8 * 1024 * 1024;
const lifetime = 30 * 60 * 1000;
const digest = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
const manifestSchema = z
  .object({
    format: z.literal('friberg-location-bank'),
    formatVersion: z.literal(1),
    exportedAt: z.string().datetime(),
    maps: z.array(mapSchema).max(50),
    mapVersions: z.array(mapSchema).max(1000),
    questions: z
      .array(
        questionSchema.required({ id: true, version: true, mapVersion: true })
      )
      .max(5000),
    captureDrafts: z.array(captureDraftSchema).max(10000).default([]),
    assets: z
      .array(
        z
          .object({
            url: z.string().max(150),
            file: z.string().regex(/^assets\/[a-f0-9]{64}\.webp$/),
            sha256: z.string().regex(/^[a-f0-9]{64}$/),
            size: z.number().int().positive().max(maxImageBytes),
          })
          .strict()
      )
      .max(12000),
  })
  .strict();
type Manifest = z.infer<typeof manifestSchema>;
interface Stage {
  owner: number;
  expiresAt: number;
  manifest: Manifest;
}
interface Catalog {
  maps: MapDefinition[];
  questions: Question[];
  versions: MapDefinition[];
  captureDrafts: CaptureDraft[];
}
export interface BankPreview {
  token: string;
  fingerprint: string;
  expiresAt: number;
  exportedAt: string;
  questions: number;
  assets: number;
  mapChanges: number;
  added: number;
  updated: number;
  skipped: number;
  captureDrafts: number;
  captureChanges: number;
  conflicts: Array<{ id: string; code: string }>;
  canImport: boolean;
}
interface Plan {
  preview: BankPreview;
  maps: MapDefinition[];
  questions: Question[];
  versions: MapDefinition[];
  captureDrafts: CaptureDraft[];
}
const key = (map: MapDefinition) => `${map.id}:${map.version}`;
const withoutVersion = ({
  version: _version,
  ...value
}: Question | MapDefinition | CaptureDraft) => value;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const bundleError = () => new HttpError(400, 'LOCATION_BANK_INVALID');
const folder = (token: string) => {
  if (!z.string().uuid().safeParse(token).success) throw bundleError();
  return path.join(transferRoot, token);
};
async function hashFile(filename: string) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filename)) hash.update(chunk);
  return hash.digest('hex');
}
function limitBytes(limit: number) {
  let size = 0;
  return new Transform({
    transform(chunk, _encoding, callback) {
      size += chunk.length;
      callback(
        size > limit ? new HttpError(413, 'LOCATION_BANK_TOO_LARGE') : null,
        size > limit ? undefined : chunk
      );
    },
  });
}
async function catalog(): Promise<Catalog> {
  const maps = (await db('location_maps').orderBy('id').select('payload')).map(
    (row) => mapSchema.parse(JSON.parse(row.payload))
  );
  const questions = (
    await db('location_questions').orderBy('id').select('payload')
  ).map((row) =>
    questionSchema
      .required({ id: true, version: true, mapVersion: true })
      .parse(JSON.parse(row.payload))
  );
  const versions = (
    await db('location_versions')
      .where('key', 'like', 'map:%')
      .orderBy('key')
      .select('payload')
  ).map((row) => mapSchema.parse(JSON.parse(row.payload)));
  const captureDrafts = (
    await db('location_capture_drafts').orderBy('id').select('payload')
  ).map((row) => captureDraftSchema.parse(JSON.parse(row.payload)));
  return { maps, questions, versions, captureDrafts };
}
const fingerprint = (value: Catalog) => digest(JSON.stringify(value));

/** Snapshot metadata under the catalog lock; immutable image files stream afterwards. */
export async function exportBank(output: Writable) {
  const source = await withKeyLock('location:catalog', catalog);
  const snapshots = new Map(source.maps.map((map) => [key(map), map]));
  for (const question of [...source.questions, ...source.captureDrafts]) {
    const id = `${question.mapId}:${question.mapVersion}`;
    if (!snapshots.has(id)) {
      const snapshot = source.versions.find((map) => key(map) === id);
      if (!snapshot) throw new HttpError(409, 'LOCATION_BANK_MISSING_MAP');
      snapshots.set(id, snapshot);
    }
  }
  const urls = new Set(
    [...snapshots.values()]
      .flatMap((map) => map.floors.map((floor) => floor.radarUrl))
      .filter(Boolean)
  );
  source.questions.forEach((question) => {
    urls.add(question.imageUrl);
    urls.add(question.thumbnailUrl);
  });
  source.captureDrafts.forEach((draft) => {
    for (const image of captureImages(draft)) {
      urls.add(image.asset.url);
      urls.add(image.asset.thumbnailUrl);
    }
  });
  const assets: Manifest['assets'] = [];
  const files = new Map<string, string>();
  let total = 0;
  for (const url of urls) {
    const filename = assetPath(url);
    let stat;
    try {
      stat = await fs.stat(filename);
    } catch {
      throw new HttpError(409, 'LOCATION_INVALID_ASSET');
    }
    if (!stat.isFile() || stat.size > maxImageBytes)
      throw new HttpError(413, 'LOCATION_BANK_TOO_LARGE');
    const sha256 = await hashFile(filename);
    const file = `assets/${sha256}.webp`;
    assets.push({ url, file, sha256, size: stat.size });
    if (!files.has(file)) {
      total += stat.size;
      files.set(file, filename);
    }
  }
  if (total > maxBytes - maxManifestBytes)
    throw new HttpError(413, 'LOCATION_BANK_TOO_LARGE');
  if (
    source.questions.some(
      (q) =>
        assets.find((asset) => asset.url === q.imageUrl)?.sha256 !== q.imageHash
    )
  )
    throw new HttpError(409, 'LOCATION_INVALID_ASSET');
  if (
    source.captureDrafts.some(
      (d) => captureImages(d).some((image) =>
        assets.find((asset) => asset.url === image.asset.url)?.sha256 !== image.asset.hash)
    )
  )
    throw new HttpError(409, 'LOCATION_INVALID_ASSET');
  const manifest = manifestSchema.parse({
    format: 'friberg-location-bank',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    maps: source.maps,
    mapVersions: [...snapshots.values()],
    questions: source.questions,
    captureDrafts: source.captureDrafts,
    assets,
  });
  const zip = new ZipFile();
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2));
  if (manifestBytes.length > maxManifestBytes)
    throw new HttpError(413, 'LOCATION_BANK_TOO_LARGE');
  zip.addBuffer(manifestBytes, 'manifest.json');
  for (const [name, filename] of files)
    zip.addFile(filename, name, { compress: false });
  const zipOutput = zip.outputStream as Readable;
  const done = pipeline(zipOutput, output);
  zip.on('error', (error) => zipOutput.destroy(error));
  zip.end();
  await done;
}

async function extractPackage(filename: string, destination: string) {
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(
      filename,
      { lazyEntries: true, validateEntrySizes: true },
      (error, file) => (error ? reject(error) : resolve(file!))
    )
  );
  const names = new Set<string>();
  let total = 0;
  await new Promise<void>((resolve, reject) => {
    const fail = (error: unknown) => {
      zip.close();
      reject(error instanceof HttpError ? error : bundleError());
    };
    zip.on('error', fail);
    zip.on('end', resolve);
    zip.on('entry', (entry: yauzl.Entry) => {
      void (async () => {
        const name = entry.fileName;
        if (
          names.has(name) ||
          names.size >= 12001 ||
          (name !== 'manifest.json' &&
            !/^assets\/[a-f0-9]{64}\.webp$/.test(name)) ||
          entry.generalPurposeBitFlag & 1 ||
          ((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000
        )
          throw bundleError();
        names.add(name);
        total += entry.uncompressedSize;
        const limit =
          name === 'manifest.json' ? maxManifestBytes : maxImageBytes;
        if (entry.uncompressedSize > limit || total > maxBytes)
          throw new HttpError(413, 'LOCATION_BANK_TOO_LARGE');
        const stream = await new Promise<Readable>(
          (resolveStream, rejectStream) =>
            zip.openReadStream(entry, (error, stream) =>
              error ? rejectStream(error) : resolveStream(stream!)
            )
        );
        await pipeline(
          stream,
          limitBytes(limit),
          createWriteStream(path.join(destination, name), { flags: 'wx' })
        );
        zip.readEntry();
      })().catch(fail);
    });
    zip.readEntry();
  });
  if (!names.has('manifest.json')) throw bundleError();
  return names;
}

async function validateManifest(
  manifest: Manifest,
  destination: string,
  names: Set<string>
) {
  const maps = new Map(manifest.mapVersions.map((map) => [key(map), map]));
  if (
    maps.size !== manifest.mapVersions.length ||
    new Set(manifest.maps.map((map) => map.id)).size !== manifest.maps.length ||
    new Set(manifest.questions.map((q) => q.id)).size !==
      manifest.questions.length ||
    new Set(manifest.questions.map((q) => q.imageHash)).size !==
      manifest.questions.length
  )
    throw bundleError();
  for (const map of manifest.maps)
    if (
      !maps.has(key(map)) ||
      mapGeometry(maps.get(key(map))!) !== mapGeometry(map)
    )
      throw bundleError();
  const assets = new Map(manifest.assets.map((asset) => [asset.url, asset]));
  if (assets.size !== manifest.assets.length) throw bundleError();
  const referenced = new Set(
    manifest.mapVersions
      .flatMap((map) => map.floors.map((floor) => floor.radarUrl))
      .filter(Boolean)
  );
  for (const q of manifest.questions) {
    const map = maps.get(`${q.mapId}:${q.mapVersion}`);
    if (
      !map ||
      !manifest.maps.some((current) => current.id === map.id) ||
      !map.floors.some((floor) => floor.id === q.floorId)
    )
      throw bundleError();
    if (
      q.world &&
      Math.hypot(
        (q.world.x - map.calibration.posX) /
          (map.calibration.scale * map.width) -
          q.u,
        (map.calibration.posY - q.world.y) /
          (map.calibration.scale * map.height) -
          q.v
      ) > 0.005
    )
      throw bundleError();
    referenced.add(q.imageUrl);
    referenced.add(q.thumbnailUrl);
    if (assets.get(q.imageUrl)?.sha256 !== q.imageHash) throw bundleError();
  }
  if (
    new Set(manifest.captureDrafts.map((d) => d.id)).size !==
    manifest.captureDrafts.length
  )
    throw bundleError();
  const pendingImageIds = new Set<string>();
  for (const draft of manifest.captureDrafts) {
    const map = maps.get(`${draft.mapId}:${draft.mapVersion}`);
    if (
      !map ||
      !manifest.maps.some((m) => m.id === map.id) ||
      !map.floors.some((f) => f.id === draft.floorId) ||
      manifest.questions.some((q) => q.id === draft.id && !sameCapturePoint(q, draft))
    )
      throw bundleError();
    for (const image of captureImages(draft)) {
      if (pendingImageIds.has(image.id) || manifest.questions.some((q) => q.id === image.id) || manifest.captureDrafts.some((p) => p.id === image.id && p.id !== draft.id)) throw bundleError();
      pendingImageIds.add(image.id);
      referenced.add(image.asset.url);
      referenced.add(image.asset.thumbnailUrl);
      if (assets.get(image.asset.url)?.sha256 !== image.asset.hash)
        throw bundleError();
    }
  }
  const pointAnswers = new Map<string, Question | CaptureDraft>();
  for (const item of [...manifest.questions, ...manifest.captureDrafts]) {
    const key = `${item.mapId}:${item.capturePointId}`;
    const previous = pointAnswers.get(key);
    if (previous && (previous.floorId !== item.floorId ||
      (previous.world && item.world && !sameWorldPosition(previous.world, item.world)))) throw bundleError();
    if (!previous || item.world) pointAnswers.set(key, item);
  }
  if (
    referenced.size !== assets.size ||
    [...referenced].some((url) => !assets.has(url))
  )
    throw bundleError();
  const metadata = new Map<string, { width?: number; height?: number }>();
  for (const asset of manifest.assets) {
    if (asset.file !== `assets/${asset.sha256}.webp` || !names.has(asset.file))
      throw bundleError();
    if (metadata.has(asset.file)) continue;
    const filename = path.join(destination, asset.file);
    if (
      (await fs.stat(filename)).size !== asset.size ||
      (await hashFile(filename)) !== asset.sha256
    )
      throw bundleError();
    const info = await sharp(await fs.readFile(filename), {
      limitInputPixels: 16_000_000,
    }).metadata();
    if (info.format !== 'webp' || (info.pages && info.pages > 1))
      throw bundleError();
    metadata.set(asset.file, info);
  }
  if (names.size !== metadata.size + 1) throw bundleError();
  for (const map of manifest.mapVersions)
    for (const floor of map.floors)
      if (floor.radarUrl) {
        const info = metadata.get(assets.get(floor.radarUrl)!.file)!;
        if (info.width !== map.width || info.height !== map.height)
          throw new HttpError(400, 'LOCATION_RADAR_SIZE');
      }
}

/** Only expired UUID staging folders are removed; published assets are never removed. */
async function cleanupStages() {
  await fs.mkdir(transferRoot, { recursive: true });
  for (const entry of await fs.readdir(transferRoot, { withFileTypes: true })) {
    if (
      !entry.isDirectory() ||
      !z.string().uuid().safeParse(entry.name).success
    )
      continue;
    const destination = folder(entry.name);
    try {
      if ((await fs.stat(destination)).mtimeMs < Date.now() - lifetime * 4)
        await fs.rm(destination, { recursive: true, force: true });
    } catch (error) {
      if (
        !['ENOENT', 'EBUSY', 'EPERM'].includes(
          (error as NodeJS.ErrnoException).code || ''
        )
      )
        throw error;
    }
  }
}
export async function cleanupBankStages(): Promise<void> {
  await withKeyLock('location:bank-stage', cleanupStages);
}
export async function stageBank(
  input: Readable,
  owner: number
): Promise<BankPreview> {
  try { return await withKeyLock('location:bank-stage', () => stageBankExclusive(input, owner)); }
  catch (error) {
    if (error instanceof Error && error.message === 'RESOURCE_BUSY') throw new HttpError(429, 'LOCATION_BUSY');
    throw error;
  }
}
async function stageBankExclusive(input: Readable, owner: number): Promise<BankPreview> {
  await cleanupStages();
  const declared = Number((input as Readable & { headers?: Record<string, unknown> }).headers?.['content-length']);
  const reserve = (Number.isFinite(declared) && declared > 0 ? Math.min(maxBytes, declared) : maxBytes) + maxBytes;
  await assertStorageRoom(transferRoot, reserve, storageLimits.stages, true);
  let ownedBytes = 0;
  for (const entry of await fs.readdir(transferRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || !z.string().uuid().safeParse(entry.name).success) continue;
    try {
      const stage = JSON.parse(await fs.readFile(path.join(folder(entry.name), 'stage.json'), 'utf8')) as Stage;
      if (stage.owner === owner) ownedBytes += await directoryBytes(folder(entry.name), true);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  if (ownedBytes + reserve > storageLimits.ownerStages) throw new HttpError(429, 'LOCATION_STORAGE_LIMIT');
  const token = randomUUID();
  const destination = folder(token);
  await fs.mkdir(path.join(destination, 'assets'), { recursive: true });
  try {
    const filename = path.join(destination, 'package.zip');
    await pipeline(
      input,
      limitBytes(maxBytes),
      createWriteStream(filename, { flags: 'wx' }),
      { signal: AbortSignal.timeout(10 * 60_000) }
    );
    const names = await extractPackage(filename, destination);
    const raw = manifestSchema.safeParse(
      JSON.parse(
        await fs.readFile(path.join(destination, 'manifest.json'), 'utf8')
      )
    );
    if (!raw.success) throw bundleError();
    await validateManifest(raw.data, destination, names);
    await fs.unlink(filename);
    const stage: Stage = {
      owner,
      expiresAt: Date.now() + lifetime,
      manifest: raw.data,
    };
    await fs.writeFile(
      path.join(destination, 'stage.json'),
      JSON.stringify(stage),
      { flag: 'wx' }
    );
    return await previewBank(token, owner, false);
  } catch (error) {
    await fs.rm(destination, { recursive: true, force: true });
    throw error instanceof HttpError ? error : bundleError();
  }
}
async function readStage(token: string, owner: number): Promise<Stage> {
  let stage: Stage;
  try {
    stage = JSON.parse(
      await fs.readFile(path.join(folder(token), 'stage.json'), 'utf8')
    );
  } catch {
    throw new HttpError(410, 'LOCATION_BANK_EXPIRED');
  }
  if (stage.owner !== owner) throw new HttpError(404, 'LOCATION_BANK_EXPIRED');
  if (stage.expiresAt < Date.now())
    throw new HttpError(410, 'LOCATION_BANK_EXPIRED');
  return stage;
}
function hashUrl(hash: string) {
  const hex = hash.slice(0, 32);
  return `/location-assets/${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}.webp`;
}
async function resolveUrls(stage: Stage): Promise<Map<string, string>> {
  const urls = new Map<string, string>();
  for (const asset of stage.manifest.assets) {
    let url = hashUrl(asset.sha256);
    try {
      if ((await hashFile(assetPath(asset.url))) === asset.sha256)
        url = asset.url;
    } catch {
      /* Source UUID may not exist on this server. */
    }
    urls.set(asset.url, url);
  }
  return urls;
}
function planBank(
  stage: Stage,
  current: Catalog,
  urls: Map<string, string>,
  token: string,
  updateQuestions: boolean
): Plan {
  const rewriteMap = (map: MapDefinition): MapDefinition => ({
    ...map,
    floors: map.floors.map((floor) => ({
      ...floor,
      radarUrl: urls.get(floor.radarUrl) || floor.radarUrl,
    })),
  });
  const versions: MapDefinition[] = [];
  const maps: MapDefinition[] = [];
  const mapped = new Map<string, MapDefinition>();
  for (const source of stage.manifest.maps) {
    const old = current.maps.find((map) => map.id === source.id);
    const value = rewriteMap(source);
    const registered = current.versions.filter((map) => map.id === source.id);
    if (old && !registered.some((map) => map.version === old.version))
      registered.push(old);
    let highest = Math.max(0, ...registered.map((map) => map.version));
    for (const previous of stage.manifest.mapVersions.filter(
      (map) => map.id === source.id && map.version !== source.version
    )) {
      const archive = rewriteMap(previous);
      // Keep stale source questions stale even when two geometries happen to match.
      let target = registered.find(
        (map) =>
          map.version !== old?.version &&
          mapGeometry(map) === mapGeometry(archive)
      );
      if (!target) {
        target = { ...archive, version: ++highest };
        registered.push(target);
        versions.push(target);
      }
      mapped.set(key(previous), target);
    }
    const target = {
      ...value,
      version:
        old &&
        mapGeometry(old) === mapGeometry(value) &&
        highest === old.version
          ? old.version
          : highest + 1,
    };
    mapped.set(key(source), target);
    if (!old || !equal(old, target)) maps.push(target);
    if (!registered.some((map) => map.version === target.version))
      versions.push(target);
  }
  const questions: Question[] = [];
  let skipped = 0;
  let added = 0;
  let updated = 0;
  const conflicts: BankPreview['conflicts'] = [];
  for (const source of stage.manifest.questions) {
    if (current.captureDrafts.some((d) => d.id === source.id && !sameCapturePoint(d, source))) {
      conflicts.push({
        id: source.id,
        code: 'LOCATION_BANK_QUESTION_CONFLICT',
      });
      continue;
    }
    const old = current.questions.find((q) => q.id === source.id);
    const duplicate = current.questions.find(
      (q) => q.imageHash === source.imageHash && q.id !== source.id
    );
    if (duplicate) {
      conflicts.push({ id: source.id, code: 'LOCATION_DUPLICATE_IMAGE' });
      continue;
    }
    const value: Question = {
      ...source,
      imageUrl: urls.get(source.imageUrl)!,
      thumbnailUrl: urls.get(source.thumbnailUrl)!,
      mapVersion: mapped.get(`${source.mapId}:${source.mapVersion}`)!.version,
      version: (old?.version || 0) + 1,
    };
    if (old && equal(withoutVersion(old), withoutVersion(value))) {
      skipped++;
      continue;
    }
    if (old && !updateQuestions) {
      conflicts.push({
        id: source.id,
        code: 'LOCATION_BANK_QUESTION_CONFLICT',
      });
      continue;
    }
    questions.push(value);
    if (old) updated++;
    else added++;
  }
  const captureDrafts: CaptureDraft[] = [];
  for (const source of stage.manifest.captureDrafts) {
    if (current.questions.some((q) => q.id === source.id && !sameCapturePoint(q, source))) {
      conflicts.push({
        id: source.id,
        code: 'LOCATION_BANK_QUESTION_CONFLICT',
      });
      continue;
    }
    const old = current.captureDrafts.find((d) => d.id === source.id);
    const value: CaptureDraft = {
      ...source,
      mapVersion: mapped.get(`${source.mapId}:${source.mapVersion}`)!.version,
      version: (old?.version || 0) + 1,
      ...(source.asset
        ? {
            asset: {
              ...source.asset,
              url: urls.get(source.asset.url)!,
              thumbnailUrl: urls.get(source.asset.thumbnailUrl)!,
            },
          }
        : {}),
      ...(source.images ? { images: source.images.map((image) => ({ ...image,
        asset: { ...image.asset, url: urls.get(image.asset.url)!, thumbnailUrl: urls.get(image.asset.thumbnailUrl)! },
      })) } : {}),
    };
    if (old && equal(withoutVersion(old), withoutVersion(value))) continue;
    if (old && !updateQuestions) {
      conflicts.push({
        id: source.id,
        code: 'LOCATION_BANK_QUESTION_CONFLICT',
      });
      continue;
    }
    captureDrafts.push(value);
  }
  const replacedQuestions = new Set(questions.map((q) => q.id));
  const replacedPoints = new Set(captureDrafts.map((p) => p.id));
  const sharedPositions = new Map<string, Question | CaptureDraft>();
  for (const item of [
    ...current.questions.filter((q) => !replacedQuestions.has(q.id)),
    ...current.captureDrafts.filter((p) => !replacedPoints.has(p.id)),
    ...questions, ...captureDrafts,
  ]) {
    const key = `${item.mapId}:${item.capturePointId}`;
    const previous = sharedPositions.get(key);
    if (previous && (previous.floorId !== item.floorId ||
      (previous.world && item.world && !sameWorldPosition(previous.world, item.world))))
      conflicts.push({ id: item.id, code: 'LOCATION_CAPTURE_POSITION_MISMATCH' });
    if (!previous || item.world) sharedPositions.set(key, item);
  }
  return {
    maps,
    questions,
    versions,
    captureDrafts,
    preview: {
      token,
      fingerprint: fingerprint(current),
      expiresAt: stage.expiresAt,
      exportedAt: stage.manifest.exportedAt,
      questions: stage.manifest.questions.length,
      captureDrafts: stage.manifest.captureDrafts.length,
      captureChanges: captureDrafts.length,
      assets: stage.manifest.assets.length,
      mapChanges: maps.length,
      added,
      updated,
      skipped,
      conflicts,
      canImport: conflicts.length === 0,
    },
  };
}
export async function previewBank(
  token: string,
  owner: number,
  updateQuestions: boolean
) {
  const stage = await readStage(token, owner);
  const urls = await resolveUrls(stage);
  return withKeyLock(
    'location:catalog',
    async () =>
      planBank(stage, await catalog(), urls, token, updateQuestions).preview
  );
}

export async function importBank(
  token: string,
  owner: number,
  expectedFingerprint: string,
  updateQuestions: boolean
) {
  const receiptKey = `bank:${token}`;
  const previous = await db('location_versions')
    .where({ key: receiptKey })
    .first();
  if (previous) {
    const receipt = JSON.parse(previous.payload);
    if (receipt.owner !== owner)
      throw new HttpError(404, 'LOCATION_BANK_EXPIRED');
    return receipt.result;
  }
  const stage = await readStage(token, owner);
  const urls = await resolveUrls(stage);
  // Materialize immutable files before taking the short catalog lock. Failed DB
  // commits may leave unreferenced files, but never a question with a missing image.
  await withKeyLock('location:asset-storage', async () => {
  let incoming = 0;
  for (const asset of stage.manifest.assets) {
    try { await fs.stat(assetPath(urls.get(asset.url)!)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; incoming += asset.size; }
  }
  await assertStorageRoom(assetDirectory, incoming, storageLimits.assets);
  for (const asset of stage.manifest.assets) {
    const filename = assetPath(urls.get(asset.url)!);
    try {
      await fs.copyFile(
        path.join(folder(token), asset.file),
        filename,
        1 /* COPYFILE_EXCL */
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if ((await hashFile(filename)) !== asset.sha256) throw bundleError();
  }
  });
  return withKeyLock('location:catalog', async () => {
    const receipt = await db('location_versions')
      .where({ key: receiptKey })
      .first();
    if (receipt) return JSON.parse(receipt.payload).result;
    const current = await catalog();
    if (fingerprint(current) !== expectedFingerprint)
      throw new HttpError(409, 'LOCATION_BANK_CHANGED');
    const plan = planBank(stage, current, urls, token, updateQuestions);
    if (!plan.preview.canImport)
      throw new HttpError(409, 'LOCATION_BANK_CONFLICT');
    const result = {
      added: plan.preview.added,
      updated: plan.preview.updated,
      skipped: plan.preview.skipped,
      maps: plan.maps.length,
      ...(plan.captureDrafts.length
        ? { captureDrafts: plan.captureDrafts.length }
        : {}),
    };
    await db.transaction(async (trx) => {
      await savePointModels(trx, [...plan.captureDrafts, ...plan.questions]);
      const rows = [
        ...plan.versions.map((map) => ({
          key: `map:${map.id}:${map.version}`,
          payload: JSON.stringify(map),
        })),
        ...plan.questions.map((q) => ({
          key: `question:${q.id}:${q.version}`,
          payload: JSON.stringify(q),
        })),
        { key: receiptKey, payload: JSON.stringify({ owner, result }) },
      ];
      for (let i = 0; i < rows.length; i += 100)
        await trx('location_versions').insert(rows.slice(i, i + 100));
      for (let i = 0; i < plan.maps.length; i += 100)
        await trx('location_maps')
          .insert(
            plan.maps
              .slice(i, i + 100)
              .map((map) => ({ id: map.id, payload: JSON.stringify(map) }))
          )
          .onConflict('id')
          .merge();
      for (let i = 0; i < plan.questions.length; i += 100)
        await trx('location_questions')
          .insert(
            plan.questions
              .slice(i, i + 100)
              .map((q) => ({
                id: q.id,
                image_hash: q.imageHash,
                payload: JSON.stringify(q),
              }))
          )
          .onConflict('id')
          .merge();
      for (let i = 0; i < plan.captureDrafts.length; i += 100)
        await trx('location_capture_drafts')
          .insert(
            plan.captureDrafts
              .slice(i, i + 100)
              .map((d) => ({ id: d.id, payload: JSON.stringify(d) }))
          )
          .onConflict('id')
          .merge();
    });
    return result;
  });
}
