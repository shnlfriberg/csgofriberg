export type FeedbackLevel = 'correct' | 'close' | 'wrong';

export interface AttributeFeedback {
  value: string | number | boolean;
  level: FeedbackLevel;
  hint?: 'higher' | 'lower';
}

export interface GuessFeedback {
  playerId: number;
  nickname: string;
  correct: boolean;
  attributes: {
    nationality: AttributeFeedback;
    team: AttributeFeedback;
    age: AttributeFeedback;
    role: AttributeFeedback;
    majorChampionships: AttributeFeedback;
    majorAppearances: AttributeFeedback;
    isActive: AttributeFeedback;
  };
}

export type HiddenAttributeFeedback = Pick<AttributeFeedback, 'level' | 'hint'>;

export interface HiddenGuessFeedback {
  hidden: true;
  correct: boolean;
  attributes: {
    nationality: HiddenAttributeFeedback;
    team: HiddenAttributeFeedback;
    age: HiddenAttributeFeedback;
    role: HiddenAttributeFeedback;
    majorChampionships: HiddenAttributeFeedback;
    majorAppearances: HiddenAttributeFeedback;
    isActive: HiddenAttributeFeedback;
  };
}

export type MultiplayerGuessFeedback = GuessFeedback | HiddenGuessFeedback;

export interface UserInfo {
  id: number;
  username: string;
  role: 'user' | 'admin';
}

export interface PlayerInfo {
  id: number;
  nickname: string;
  nationality: string;
  region: string;
  team: string;
  age: number;
  role: string;
  majorChampionships: number;
  majorAppearances: number;
  isActive: boolean;
}

export interface RoomPlayer {
  key: string;
  name: string;
  ready: boolean;
  connected: boolean;
  score: number;
  guessCount: number;
  guesses: MultiplayerGuessFeedback[];
}

export interface PlayerPerformanceStats {
  single: {
    games: number;
    wins: number;
    losses: number;
    winRate: number;
    avgGuesses: number | null;
    bestGuesses: number | null;
  };
  multi: {
    games: number;
    wins: number;
    losses: number;
    winRate: number;
    recentAverageWinningGuesses: number | null;
    recentMatches: Array<{
      id: number;
      result: 'won' | 'lost' | 'draw';
      score: { me: number; opponent: number };
      boType: number;
      dbType: string;
      opponentDisplayId: string;
      finishedAt: string;
      rounds: Array<{
        round: number;
        winner: 'me' | 'opponent' | null;
        meGuesses: number;
        opponentGuesses: number;
      }>;
    }>;
  };
}

export interface MatchReplayRound {
  round: number;
  reason: string;
  winner: 'me' | 'opponent' | null;
  answer: PlayerInfo;
  me: { guesses: GuessFeedback[] };
  opponent: { guesses: GuessFeedback[] };
}

export interface MatchReplay {
  id: number | string;
  mode: string;
  boType: number;
  finishedAt: string;
  result: 'won' | 'lost' | 'draw';
  me: { score: number };
  opponent: { displayId: string; score: number };
  rounds: MatchReplayRound[];
}

export interface RoomState {
  id: string;
  hostKey: string;
  status: 'waiting' | 'playing' | 'round_over' | 'finished';
  matchmaking: boolean;
  readyCheckEndsAt: number | null;
  dbType: string;
  boType: number;
  rematchAllowed: boolean;
  rematchInvite: { inviterKey: string } | null;
  allowSpectators: boolean;
  anonymous: boolean;
  round: number;
  roundId: number;
  stateVersion: number;
  winsNeeded: number;
  maxGuesses: number;
  roundEndsAt: number | null;
  matchStartsAt: number | null;
  spectatorCount: number;
  players: RoomPlayer[];
  roundResult: {
    winnerKey: string | null;
    reason: string;
    nextRoundAt: number | null;
    answer: {
      nickname: string;
      team: string;
      nationality: string;
      role: string;
      majorChampionships: number;
      majorAppearances: number;
    } | null;
  } | null;
  matchResult: {
    winnerKey: string | null;
    reason: string;
    answer: {
      nickname: string;
      team: string;
      nationality: string;
      role: string;
      majorChampionships: number;
      majorAppearances: number;
    } | null;
  } | null;
  matchReplay?: MatchReplay;
}

export interface RoomPatch {
  roomId: string;
  baseVersion: number;
  stateVersion: number;
  hostKey?: string;
  players?: {
    added?: RoomPlayer[];
    updated?: Array<Partial<RoomPlayer> & { key: string }>;
    removed?: string[];
  };
  spectatorCount?: number;
}

export interface PresenceStats {
  onlineUsers: number;
  multiplayerRooms: number;
  singleGames: number;
  updatedAt: number;
}
