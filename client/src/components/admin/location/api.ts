import { api } from '../../../location/api';
import type { MergePoint, MergePointsInput, MergePointsResult } from '@friberg/location-core';
import type {
  AdminOverview,
  BankChecks,
  CaptureAsset,
  CaptureDraft,
  CapturePointInput,
  MapDefinition,
  Question,
} from '../../../location/types';

const root = '/admin/location';
let captureSnapshot: { revision?: string; items: CaptureDraft[] } | undefined;
export interface BatchPublishResponse {
  results: Array<
    | { id: string; capturePointId: string; ok: true }
    | { id: string; capturePointId: string; ok: false; code: string }
  >;
}
export const locationAdmin = {
  submissionPoints: async (mapId: string, floorId: string, signal?: AbortSignal) =>
    (await api.get<{ items: MergePoint[]; mapVersion: number }>(`${root}/submission-points`, { params: { mapId, floorId }, signal })).data,
  mergePoints: async (input: MergePointsInput) => (await api.post<MergePointsResult>(`${root}/points/merge`, input)).data,
  mergeCandidates: async (mapId: string, floorId: string, signal?: AbortSignal) =>
    (await api.get<{ items: MergePoint[]; mapVersion: number }>(`${root}/points`, { params: { mapId, floorId }, signal })).data,
  overview: async (compact = false, daily = false) => (await api.get<AdminOverview>(`${root}/overview`, { params: { compact: compact ? '1' : undefined, daily: daily ? '1' : undefined } })).data,
  questions: async (params: Record<string, unknown>, signal?: AbortSignal) => (await api.get<QuestionPage>(`${root}/questions`, { params, signal })).data,
  question: async (id: string) => (await api.get<{ question: Question; reference: Question | null }>(`${root}/questions/${encodeURIComponent(id)}`)).data,
  pendingQuestions: async () => (await api.get<{ items: Array<Pick<Question, 'id' | 'version'>> }>(`${root}/questions/pending`)).data.items,
  checks: async () => (await api.get<BankChecks>(`${root}/checks`)).data,
  publishQuestions: async (questions: Array<Pick<Question, 'id' | 'version'>>) =>
    (await api.post<BatchPublishResponse>(`${root}/questions/publish`, { questions })).data,
  saveMap: async (map: MapDefinition) =>
    (await api.put<MapDefinition>(`${root}/maps/${map.id}`, map)).data,
  captures: async () => {
    const previous = captureSnapshot;
    const { data } = await api.get<{ revision?: string; items?: CaptureDraft[]; unchanged?: boolean }>(`${root}/capture-drafts`, { params: { revision: previous?.revision } });
    if (data.unchanged && previous) return previous.items;
    const next = { revision: data.revision, items: data.items || [] };
    captureSnapshot = next;
    return next.items;
  },
  savePoints: async (points: CapturePointInput[]) =>
    (
      await api.post<{ items: CaptureDraft[] }>(`${root}/capture-drafts`, {
        points,
      })
    ).data.items,
  attachImage: async (draft: CaptureDraft, asset: CaptureAsset) =>
    (
      await api.patch<CaptureDraft>(
        `${root}/capture-drafts/${draft.id}/asset`,
        {
          version: draft.version,
          asset: {
            url: asset.url,
            thumbnailUrl: asset.thumbnailUrl,
            hash: asset.hash,
          },
        }
      )
    ).data,
  appendImage: async (draft: CaptureDraft, imageId: string, asset: CaptureAsset) =>
    (await api.post<CaptureDraft>(`${root}/capture-drafts/${draft.id}/images`, {
      version: draft.version, imageId,
      asset: { url: asset.url, thumbnailUrl: asset.thumbnailUrl, hash: asset.hash },
    })).data,
  removeImage: async (draft: CaptureDraft, imageId: string) =>
    (await api.delete<CaptureDraft>(`${root}/capture-drafts/${draft.id}/images/${imageId}`, { data: { version: draft.version } })).data,
  removePoint: async (draft: CaptureDraft) => {
    await api.delete(`${root}/capture-drafts/${draft.id}`, {
      data: { version: draft.version },
    });
  },
  generateDaily: async () => {
    await api.post(`${root}/daily/generate`);
  },
};
export interface QuestionPage {
  items: Question[]; total: number; totalAll?: number; pending: number; page: number; pageSize: number; pointCounts: Record<string, number>;
}

export function validCaptureFile(file: File) {
  return (
    ['image/png', 'image/jpeg', 'image/webp'].includes(file.type) &&
    file.size > 0 &&
    file.size <= 16 * 1024 * 1024
  );
}

export async function uploadCaptureImage(
  file: File,
  onProgress?: (percent: number) => void
) {
  return (
    await api.post<CaptureAsset & { width: number; height: number }>(
      `${root}/assets`,
      await file.arrayBuffer(),
      {
        headers: { 'Content-Type': file.type },
        onUploadProgress: (event) =>
          onProgress?.(
            Math.min(
              95,
              Math.round((event.loaded / (event.total || file.size)) * 100)
            )
          ),
      }
    )
  ).data;
}

export type QuestionImportResult =
  | { ok: true; question: Question }
  | { ok: false; code: string; id: string | null };

export async function importQuestionManifest(files: File[]) {
  const manifest =
    files.find((file) => file.name === 'manifest.json') ||
    files.find((file) => file.name.endsWith('.json'));
  if (!manifest) throw new Error('manifest.json');
  const content: {
    questions?: Array<Record<string, unknown> & { imageFile?: string }>;
  } = JSON.parse(await manifest.text());
  if (
    !Array.isArray(content.questions) ||
    !content.questions.length ||
    content.questions.length > 500
  )
    throw new Error('manifest.json');
  const directory = manifest.webkitRelativePath.slice(
    0,
    manifest.webkitRelativePath.lastIndexOf('/') + 1
  );
  const prepared = [];
  for (const { imageFile, ...question } of content.questions) {
    if (!imageFile) {
      prepared.push({ ...question, status: 'draft' });
      continue;
    }
    const image = files.find(
      (file) => file.webkitRelativePath === directory + imageFile
    );
    if (!image || !validCaptureFile(image)) throw new Error(imageFile);
    const asset = await uploadCaptureImage(image);
    prepared.push({
      ...question,
      imageUrl: asset.url,
      thumbnailUrl: asset.thumbnailUrl,
      imageHash: asset.hash,
      status: 'draft',
    });
  }
  return (
    await api.post<{ results: QuestionImportResult[] }>(
      `${root}/questions/import`,
      { questions: prepared }
    )
  ).data.results;
}
