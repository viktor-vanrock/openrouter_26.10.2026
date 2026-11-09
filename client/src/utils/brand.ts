export const APP_NAME = 'ChatRouter';

export function withChatRouterBrand(value: string): string {
  return value.replace(/OpenRouter Chat|\bLibreChat\b(?![./-])/gi, APP_NAME);
}
