import { render, screen } from '@testing-library/react';
import { RecoilRoot } from 'recoil';
import PrototypeModeBadge from './PrototypeModeBadge';
import store from '~/store';
let mockAvailable = false;
jest.mock('~/hooks/Prototype/usePrototypeAvailability', () => ({
  __esModule: true,
  default: () => mockAvailable,
}));
jest.mock('~/store', () => {
  const { atom, atomFamily } = jest.requireActual('recoil');
  return {
    __esModule: true,
    default: {
      prototypeModePinned: atom({ key: 'badge-test-pin', default: false }),
      prototypeModeByConvoId: atomFamily({ key: 'badge-test-mode', default: false }),
    },
  };
});
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { prototypeAgent: { enabled: true } } }),
}));

it('hides the pinned tool while unavailable and restores it when readiness returns', () => {
  const tree = () => (
    <RecoilRoot initializeState={({ set }) => set(store.prototypeModePinned, true)}>
      <PrototypeModeBadge key={String(mockAvailable)} conversationId="new" />
    </RecoilRoot>
  );
  const { rerender } = render(tree());
  expect(screen.queryByRole('button', { name: 'Prototype mode' })).not.toBeInTheDocument();
  mockAvailable = true;
  rerender(tree());
  expect(screen.getByRole('button', { name: 'Prototype mode' })).toBeInTheDocument();
  mockAvailable = false;
  rerender(tree());
  expect(screen.queryByRole('button', { name: 'Prototype mode' })).not.toBeInTheDocument();
});
