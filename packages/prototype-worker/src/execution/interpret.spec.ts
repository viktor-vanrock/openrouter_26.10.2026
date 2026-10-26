import { interpretTurn } from './interpret';

describe('interpretTurn', () => {
  it.each([
    ['Summary\nPROTOTYPE_READY: crm-dashboard', { kind: 'review', prototypeSlug: 'crm-dashboard', text: 'Summary' }],
    ['Done\nPROTOTYPE_FINALIZED: crm-dashboard', { kind: 'completed', prototypeSlug: 'crm-dashboard', text: 'Done' }],
    ['Question\nWAITING_FOR_CLARIFICATION', { kind: 'waiting', waitingReason: 'clarification', text: 'Question' }],
    ['Plan\nWAITING_FOR_PLAN_APPROVAL', { kind: 'waiting', waitingReason: 'plan_approval', text: 'Plan' }],
  ])('interprets stable marker %s', (text, expected) => {
    expect(interpretTurn(text)).toEqual(expected);
  });

  it.each(['', 'PROTOTYPE_READY: ../escape', 'unmarked question'])('rejects ambiguous output %s', (text) => {
    expect(() => interpretTurn(text)).toThrow();
  });
});
