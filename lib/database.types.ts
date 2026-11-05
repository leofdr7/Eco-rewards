export type MedalTier = 'gold' | 'silver' | 'bronze' | 'none';

export interface City {
  id: string;
  name: string;
  slug: string;
  sort_order: number;
  created_at: string;
}

export interface Profile {
  id: string;
  email: string;
  account_number: string | null;
  alias: string | null;
  full_name: string | null;
  age: number | null;
  date_of_birth: string | null;
  avatar_url: string | null;
  points_balance: number;
  monthly_eco_points: number;
  city_id: string | null;
  role: 'user' | 'admin';
  face_consent_at: string | null;
  created_at: string;
  updated_at: string;
  city?: City | null;
}

export interface Transaction {
  id: string;
  user_id: string;
  type: 'bottle' | 'can' | 'redemption';
  points: number;
  description: string;
  machine_id: string | null;
  session_id: string | null;
  created_at: string;
}

export interface Machine {
  id: string;
  machine_code: string;
  name: string;
  location: string | null;
  is_active: boolean;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface RecyclingSession {
  id: string;
  machine_id: string;
  user_id: string;
  status: 'armed' | 'completed' | 'expired' | 'cancelled';
  source: 'qr' | 'keypad' | 'face';
  armed_at: string;
  expires_at: string;
  items_processed: number;
  last_item_at: string | null;
  created_at: string;
  updated_at: string;
  machine?: Machine;
}

export interface FaceEmbedding {
  id: string;
  user_id: string;
  embedding: number[];
  model: string;
  created_at: string;
}

export interface FaceEnrollmentJob {
  id: string;
  user_id: string;
  status: 'pending' | 'done' | 'failed';
  storage_paths: string[];
  error: string | null;
  created_at: string;
  updated_at: string;
}

export interface FaceRequest {
  id: string;
  machine_id: string;
  user_id: string;
  status: 'pending' | 'matched' | 'failed' | 'expired';
  session_id: string | null;
  error: string | null;
  created_at: string;
  expires_at: string;
  updated_at: string;
}

export interface Reward {
  id: string;
  name: string;
  description: string;
  image_url: string;
  points_cost: number;
  category: 'coffee' | 'food' | 'drinks' | 'snacks';
  brand: string;
  is_active: boolean;
  created_at: string;
}

export interface RedemptionRecord {
  id: string;
  user_id: string;
  reward_id: string;
  points_spent: number;
  redemption_code: string;
  redeemed_at: string;
  reward?: Reward;
}

export interface MonthlyCompetition {
  id: string;
  year: number;
  month: number;
  status: 'active' | 'finalized';
  finalized_at: string | null;
  created_at: string;
}

export interface CityBattleEntry {
  city_id: string;
  city_name: string;
  total_eco_points: number;
  recycler_count: number;
  rank: number;
}

export interface CityLeaderboardEntry {
  user_id: string;
  city_id: string;
  city_name: string;
  display_name: string;
  monthly_eco_points: number;
  rank_in_city: number;
}

export interface NationalLeaderboardEntry {
  user_id: string;
  city_id: string | null;
  city_name: string | null;
  display_name: string;
  monthly_eco_points: number;
  rank_national: number;
}

export interface MonthlyCityResult {
  id: string;
  competition_id: string;
  city_id: string;
  rank: number;
  total_eco_points: number;
  recycler_count: number;
  cities?: Pick<City, 'name'>;
}

export interface MonthlyUserResult {
  id: string;
  competition_id: string;
  user_id: string;
  city_id: string | null;
  eco_points: number;
  rank_national: number;
  rank_in_city: number | null;
  medal_tier: MedalTier;
  profiles?: Pick<Profile, 'alias' | 'full_name'>;
  cities?: Pick<City, 'name'>;
  monthly_competitions?: Pick<MonthlyCompetition, 'year' | 'month'>;
}
