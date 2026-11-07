export type Difficulty = 'easy' | 'normal' | 'hard';
export type Tier = 'easy' | 'medium' | 'hard';
export type Mode = 'random' | 'daily' | 'multiplayer';
export interface Identity {
  key: string;
  userId: number | null;
  name: string;
}
export interface Floor {
  id: string;
  name: string;
  radarUrl: string;
}
export interface MapDefinition {
  id: string;
  name: string;
  enabled: boolean;
  order: number;
  version: number;
  width: number;
  height: number;
  bounds: { u: number; v: number; width: number; height: number };
  floors: Floor[];
  calibration: {
    posX: number;
    posY: number;
    scale: number;
    points: Array<{
      x: number;
      y: number;
      u: number;
      v: number;
      floorId: string;
    }>;
  };
}
export interface Guess {
  mapId: string;
  floorId: string;
  u: number;
  v: number;
}
export interface CaptureAsset {
  url: string;
  thumbnailUrl: string;
  hash: string;
}
export interface CaptureImage {
  id: string;
  asset: CaptureAsset;
  createdAt: string;
}
export interface CaptureDraft extends Guess {
  id: string;
  version: number;
  mapVersion: number;
  batchId: string;
  batchName: string;
  order: number;
  capturePointId: string;
  createdAt: string;
  asset?: CaptureAsset;
  images?: CaptureImage[];
  world?: { x: number; y: number; z: number };
}
export type CapturePointInput = Pick<
  CaptureDraft,
  | 'id'
  | 'batchId'
  | 'batchName'
  | 'order'
  | 'capturePointId'
  | 'mapId'
  | 'floorId'
  | 'u'
  | 'v'
>;
export interface DailyAssignment {
  date: string;
  decks: Record<Difficulty, QuestionSnapshot[]>;
  maps: MapDefinition[];
  scoringVersion: 1;
}
export interface AdminOverview {
  questionPoints?: Array<{ mapId: string; capturePointId: string; count: number }>;
  maps: MapDefinition[];
  questions: Question[];
  capture: { points: number; withImages: number };
  counts: Array<{
    mapId: string;
    calibrationValid: boolean;
    easy: number;
    medium: number;
    hard: number;
    stale: number;
  }>;
  daily: DailyAssignment[];
}
export interface BankChecks {
  missingAssets: string[];
  compositions: Record<Difficulty, boolean>;
  dailyAvailable: boolean;
  randomAfterDaily?: Record<Difficulty, boolean>;
  dailySource?: 'fixed' | 'simulation';
  uniquePoints?: number;
  reservedPoints?: number;
  remainingByTier?: Record<Tier, number>;
}
export interface Question extends Guess {
  id: string;
  version: number;
  mapVersion: number;
  capturePointId: string;
  tier: Tier;
  imageUrl: string;
  thumbnailUrl: string;
  imageHash: string;
  status: 'draft' | 'review' | 'published' | 'disabled';
  capturedAt: string;
  build: string;
  source: string;
  world?: { x: number; y: number; z: number };
  view?: { pitch: number; yaw: number; roll: number; fov: number };
}
export interface QuestionSnapshot {
  question: Question;
  map: MapDefinition;
}
export interface RoundResult {
  round: number;
  imageUrl: string;
  questionId: string;
  questionVersion: number;
  tier: Tier;
  guess: Guess | null;
  answer: Guess;
  map: MapDefinition;
  guessedMap: MapDefinition | null;
  score: number;
  distanceRatio: number | null;
  mapCorrect: boolean;
  floorCorrect: boolean;
}
export interface ReplayRecord {
  gameId: string;
  owner: Identity;
  mode: Mode;
  difficulty: Difficulty;
  difficultyMix: Record<Tier, number>;
  date: string | null;
  totalScore: number;
  results: RoundResult[];
  scoringVersion: 1;
  game?: GameView;
  rank?: number | null;
  retired?: boolean;
  myKey?: string;
  roomId?: string;
  participants?: RoomView['players'];
  roomResults?: RoomView['results'];
}
export interface LocationStatsSummary {
  acceptedSubmissions: number;
  singleGames: number;
  randomGames: number;
  dailyGames: number;
  averageScore: number | null;
  bestScore: number | null;
  multiGames: number;
  multiEntries: number;
  multiWins: number;
  multiAverageScore: number | null;
}
export interface LocationSubmission extends Guess {
  /** Server-generated community point group; absent on legacy submissions. */
  capturePointId?: string;
  id: string;
  mapVersion: number;
  submitterName: string;
  imageUrl: string;
  thumbnailUrl: string;
  imageHash: string;
  note: string;
  createdAt: string;
}
export interface SubmissionPage {
  items: LocationSubmission[];
  total: number;
  page: number;
  pageSize: number;
}
export interface ContributorBoard {
  items: Array<{ id: string; displayId: string; accepted: number; rank: number; me: boolean }>;
  currentUser: { displayId: string; accepted: number; rank: number | null };
  page: number;
  hasNext: boolean;
}
export interface LocationStatsResponse {
  difficulties: Difficulty[];
  personal: LocationStatsSummary;
  global: LocationStatsSummary;
}
export interface LocationReplayItem {
  gameId: string;
  mode: Mode;
  difficulty: Difficulty;
  totalScore: number;
  finishedAt: number;
  rank: number | null;
  retired: boolean;
}
export interface LocationReplayPage {
  page: number;
  pageSize: number;
  hasNext: boolean;
  items: LocationReplayItem[];
}
export interface AnswerInput extends Guess {
  round: number;
  requestId: string;
  version: number;
}
export interface GameState {
  /** Random solo only; absent on legacy games. */
  bannedMapIds?: string[];
  id: string;
  owner: Identity;
  mode: 'random' | 'daily';
  difficulty: Difficulty;
  date: string | null;
  status: 'playing' | 'ready' | 'finished' | 'abandoned';
  questions: QuestionSnapshot[];
  maps: MapDefinition[];
  guesses: Guess[];
  requests: Record<string, string>;
  version: number;
  scoringVersion: 1;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
}
export interface GameView {
  bannedMapIds?: string[];
  id: string;
  mode: Mode;
  difficulty: Difficulty;
  date: string | null;
  status: GameState['status'];
  version: number;
  scoringVersion: 1;
  round: number;
  totalRounds: 5;
  answered: number;
  maps: MapDefinition[];
  question: { imageUrl: string; round: number } | null;
  guesses: Guess[];
  results: RoundResult[];
  totalScore: number | null;
  expiresAt: number;
}
export interface RoomPlayer {
  identity: Identity;
  socketId: string;
  ready: boolean;
  connected: boolean;
  disconnectAt: number | null;
  retired: boolean;
  guesses: Array<Guess | null>;
  currentGuess: Guess | null;
  requests: Record<string, string>;
}
export interface RoomState {
  rematch?: { acceptedKeys: string[]; requiredKeys: string[]; leftKeys?: string[] };
  id: string;
  gameId: string;
  host: string;
  difficulty: Difficulty;
  duration: number;
  status:
    | 'waiting'
    | 'preparing'
    | 'playing'
    | 'round_over'
    | 'finished'
    | 'cancelled';
  players: RoomPlayer[];
  maps: MapDefinition[];
  questions: QuestionSnapshot[];
  round: number;
  startsAt: number | null;
  endsAt: number | null;
  nextAt: number | null;
  createdAt: number;
  revision: number;
}
export interface RoomView {
  rematch?: { acceptedKeys: string[]; requiredKeys: string[] };
  id: string;
  gameId: string;
  me: string;
  /** Private recipient binding for discarding packets from a previous login. */
  viewerUserId: number | null;
  host: string;
  difficulty: Difficulty;
  duration: number;
  status: RoomState['status'];
  revision: number;
  round: number;
  maps: MapDefinition[];
  question: { imageUrl: string; round: number } | null;
  serverNow: number;
  startsAt: number | null;
  endsAt: number | null;
  nextAt: number | null;
  players: Array<{
    key: string;
    name: string;
    ready: boolean;
    connected: boolean;
    retired: boolean;
    submitted: boolean;
    score: number;
    rank: number | null;
  }>;
  myGuess: Guess | null;
  results: Array<{ key: string; name: string; rounds: RoundResult[] }>;
}
