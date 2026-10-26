export interface OpenRouterBalanceData {
  spent: number;
  limit: number | null;
  remaining: number | null;
  percentageUsed: number | null;
  label: string;
}

export enum LIMIT_RESET {
  'DAILY' = 'daily',
  'WEEKLY' = 'weekly',
  'MONTHLY' = 'monthly',
}

export interface OpenRouterKeyResponseData {
  label: string;
  limit: number;
  limit_reset: LIMIT_RESET;
  limit_remaining: number;
  usage: number;
  usage_daily: number;
  usage_weekly: number;
  usage_monthly: number;
}

export interface OpenRouterKeyResponse {
  data: OpenRouterKeyResponseData;
}

export type ApiResponse<T> = {
  data: T;
  error?: string;
};