export type Env = {
  DB: D1Database;
  AI: Ai;
  ADMIN_PASSWORD: string;
  PLAYER_PASSWORD: string;
  /** Picks the skin (see src/theme.ts): "hive" (default) or "bearplane". */
  THEME?: string;
};

export type Round = {
  id: number;
  question: string;
  num: number; // how many answers each player gives
  suggestion_id: number | null;
  status: "open" | "scoring" | "scored";
  opened_at: number;
  closes_at: number | null;
  scored_at: number | null;
};

export type Answer = {
  id: number;
  round_id: number;
  player_id: string;
  text: string;
  cluster_id: number | null;
  points: number;
  created_at: number;
};

export const now = () => Math.floor(Date.now() / 1000);
