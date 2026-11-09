/** Temporary UI switch for guide and news navigation. */
export function hasDevelopingCookie(): boolean {
  if (typeof document === 'undefined') return false;
  return document.cookie.split(';').some((part) => part.trim() === 'developing=1');
}
