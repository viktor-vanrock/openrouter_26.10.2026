export type OpenrouterError = { message: string | null; code?: number } | null;

export enum ERROR_NUMBER {
  OPENROUTER_KEY_NOT_FOUND = 400,
  INVALID_API_KEY = 401,
  INSUFFICIENT_FUNDS = 402,
  RATE_LIMIT = 429,
}
