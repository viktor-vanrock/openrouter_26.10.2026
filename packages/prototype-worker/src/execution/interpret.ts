export type TurnResult =
  | { kind: 'waiting'; waitingReason: 'clarification' | 'plan_approval'; text: string }
  | { kind: 'review' | 'completed'; prototypeSlug: string; text: string };

const SLUG = '[a-z0-9]+(?:-[a-z0-9]+)*';

export function interpretTurn(value: string): TurnResult {
  const text = value.trim();
  if (!text) throw new Error('OpenCode turn returned no stable result');
  const markers = [
    { expression: new RegExp(`(?:^|\\n)PROTOTYPE_READY:\\s*(${SLUG})\\s*$`, 'i'), kind: 'review' as const },
    { expression: new RegExp(`(?:^|\\n)PROTOTYPE_FINALIZED:\\s*(${SLUG})\\s*$`, 'i'), kind: 'completed' as const },
  ];
  for (const marker of markers) {
    const match = text.match(marker.expression);
    if (match) {
      return { kind: marker.kind, prototypeSlug: match[1].toLowerCase(), text: text.slice(0, match.index).trim() };
    }
  }
  for (const [literal, waitingReason] of [
    ['WAITING_FOR_CLARIFICATION', 'clarification'],
    ['WAITING_FOR_PLAN_APPROVAL', 'plan_approval'],
  ] as const) {
    const expression = new RegExp(`(?:^|\\n)${literal}\\s*$`);
    const match = text.match(expression);
    if (match) return { kind: 'waiting', waitingReason, text: text.slice(0, match.index).trim() };
  }
  throw new Error('OpenCode turn omitted a required stable marker');
}
