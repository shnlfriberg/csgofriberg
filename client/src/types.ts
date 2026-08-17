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
  email?: string | null;
  emailVerified?: boolean;
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
  difficulties?: string[];
  isActive: boolean;
}

export interface RoomPlayer {
  key: string;
  name: string;
  ready: boolean;
  connected: boolean;
  score: number;
  skipped: boolean;
  guessCount: number;
  guesses: MultiplayerGuessFeedback[];
  eliminated?: boolean;
  eliminationReason?: 'player_left' | 'disconnect_timeout' | null;
  team?: 'a' | 'b' | null;
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
  winnerTeam?: 'a' | 'b' | null;
  answer: PlayerInfo;
  me: { guesses: GuessFeedback[]; guessTimes?: Array<number | null> };
  opponent: { guesses: GuessFeedback[]; guessTimes?: Array<number | null> };
  winnerParticipantId?: string | null;
  players?: Array<{
    participantId: string;
    guesses: GuessFeedback[];
    guessTimes?: Array<number | null>;
  }>;
  sharedGuesses?: Array<{
    actor: 'me' | 'opponent' | null;
    actorDisplayId?: string | null;
    feedback: GuessFeedback;
    guessTime: number | null;
  }>;
  teamGuesses?: Record<'a' | 'b', Array<{
    actor: 'me' | 'opponent' | null;
    actorDisplayId?: string | null;
    feedback: GuessFeedback;
    guessTime: number | null;
  }>>;
  teamScores?: { a: number; b: number } | null;
}

export interface MatchReplay {
  id: number | string;
  mode: string;
  boType: number;
  gameMode?: 'classic' | 'relay' | 'relay2v2';
  totalRounds?: number;
  relaySolvedRounds?: number;
  teamScores?: { a: number; b: number };
  finishedAt: string;
  result: 'won' | 'lost' | 'draw' | 'cooperative';
  me: { score: number };
  opponent: { displayId: string; score: number } | null;
  participants?: Array<{
    id: string;
    displayId: string;
    score: number;
    isMe?: boolean;
    isWinner: boolean;
    team?: 'a' | 'b' | null;
    eliminated?: boolean;
    eliminationReason?: 'player_left' | 'disconnect_timeout' | null;
  }>;
  winnerParticipantId?: string | null;
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
  gameMode?: 'classic' | 'relay' | 'relay2v2';
  totalRounds?: number;
  maxPlayers?: number;
  currentTurnKey?: string | null;
  relaySolvedRounds?: number;
  teamScores?: { a: number; b: number };
  relayGuesses?: Array<{
    actorKey: string;
    guessedAt: number;
    feedback: GuessFeedback;
  }>;
  teamTurnKeys?: { a: string | null; b: string | null };
  teamExhausted?: { a: boolean; b: boolean };
  teamGuesses?: Record<'a' | 'b', Array<{
    actorKey: string;
    guessedAt: number;
    feedback: MultiplayerGuessFeedback;
  }>>;
  rematchAllowed: boolean;
  rematchInvite: {
    acceptedKeys?: string[];
    requiredKeys?: string[];
  } | null;
  allowSpectators: boolean;
  verifiedOnly: boolean;
  anonymous: boolean;
  round: number;
  roundId: number;
  stateVersion: number;
  winsNeeded: number;
  maxGuesses: number;
  guessIntervalMs: number;
  roundDurationMs: number;
  roundEndsAt: number | null;
  matchStartsAt: number | null;
  spectatorCount: number;
  players: RoomPlayer[];
  roundResult: {
    winnerKey: string | null;
    winnerTeam?: 'a' | 'b' | null;
    reason: string;
    nextRoundAt: number | null;
    answer: {
      nickname: string;
      team: string;
      nationality: string;
      region: string;
      role: string;
      majorChampionships: number;
      majorAppearances: number;
    } | null;
  } | null;
  matchResult: {
    winnerKey: string | null;
    winnerTeam?: 'a' | 'b' | null;
    winnerKeys?: string[];
    reason: string;
    answer: {
      nickname: string;
      team: string;
      nationality: string;
      region: string;
      role: string;
      majorChampionships: number;
      majorAppearances: number;
    } | null;
  } | null;
  reportSubmitted: boolean;
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
  rematchInvite?: RoomState['rematchInvite'];
}

export interface PresenceStats {
  onlineUsers: number;
  multiplayerRooms: number;
  singleGames: number;
  updatedAt: number;
}
