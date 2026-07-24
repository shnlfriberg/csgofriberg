export interface User {
  id: number;
  username: string;
  display_id: string | null;
  password_hash: string;
  role: 'user' | 'admin';
  token_version: number;
  created_at: string;
}

export interface Player {
  id: number;
  nickname: string;
  nationality: string;
  region: string;
  team: string;
  age: number;
  role: string;
  major_championships: number;
  major_appearances: number;
  /** Deprecated compatibility field; difficulty membership lives in player_difficulties. */
  is_easy?: boolean | number;
  difficulties?: string[];
  is_active: boolean | number;
  is_enabled: boolean | number;
  created_at: string;
}

export type FeedbackLevel = 'correct' | 'close' | 'wrong';

export interface AttributeFeedback {
  value: string | number | boolean;
  level: FeedbackLevel;
  /** 数值型属性的方向提示: higher = 目标比猜测大 */
  hint?: 'higher' | 'lower';
}

export interface GuessFeedback {
  playerId: number;
  nickname: string;
  correct: boolean;
  attributes: {
    nationality: AttributeFeedback;
    region: AttributeFeedback;
    team: AttributeFeedback;
    age: AttributeFeedback;
    role: AttributeFeedback;
    majorChampionships: AttributeFeedback;
    majorAppearances: AttributeFeedback;
    isActive: AttributeFeedback;
  };
}

export interface GameRow {
  id: number;
  session_id: string | null;
  user_id: number | null;
  guest_key: string | null;
  target_player_id: number;
  mode: string;
  guesses: string;
  status: 'playing' | 'won' | 'lost';
  guess_count: number;
  created_at: string;
  finished_at: string | null;
}
