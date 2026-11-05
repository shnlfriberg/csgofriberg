import type { Guess } from './types.js';

export interface MergePoint extends Guess {
  capturePointId: string;
  fingerprint: string;
  questions: number;
  images: number;
  thumbnails: string[];
  eligible: boolean;
}
export interface MergePointsInput extends Guess {
  operationId: string;
  mapVersion: number;
  points: Array<Pick<MergePoint, 'capturePointId' | 'fingerprint'>>;
}
export interface MergePointsResult {
  capturePointId: string;
  points: number;
  questions: number;
  images: number;
}
