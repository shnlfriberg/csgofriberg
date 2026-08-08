export interface User {
  id: number;
  username: string;
  display_id: string | null;
  password_hash: string;
  role: 'user' | 'admin';
  token_version: number;
  matchmaking_restricted: boolean | number;
  email: string | null;
  email_verified_at: string | null;
  banned_at: string | null;
  created_at: string;
}

export interface Player {
  id: number;
  nickname: string;
  nationality: string;
  region: string;
  team: string;
  team_history: string[];
  age: number;
  role: string;
  major_championships: number;
  major_appearances: number;
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
