import { act, renderHook, waitFor } from '@testing-library/react';
import {
  QueryClient,
  QueryClientProvider,
  focusManager,
  onlineManager,
} from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import { useGetUserBalance } from './queries';

const mockGetBalance = jest.fn();
const mockQueriesEnabled = jest.fn();
jest.mock('recoil', () => ({ useRecoilValue: () => mockQueriesEnabled() }));
jest.mock('~/store', () => ({ __esModule: true, default: { queriesEnabled: 'queriesEnabled' } }));
jest.mock('librechat-data-provider', () => ({
  QueryKeys: { balance: 'balance' },
  dataService: { getUserBalance: () => mockGetBalance() },
}));

function harness(enabled?: boolean) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return {
    client,
    ...renderHook(({ enabled }) => useGetUserBalance({ enabled }), {
      wrapper,
      initialProps: { enabled },
    }),
  };
}

beforeEach(() => {
  mockQueriesEnabled.mockReturnValue(true);
  mockGetBalance.mockResolvedValue({ tokenCredits: 100 });
});

afterEach(() => {
  focusManager.setFocused(undefined);
  onlineManager.setOnline(true);
});

it.each([undefined, false])(
  'does not fetch balance when enabled is %s, even on focus or reconnect',
  async (enabled) => {
    const { unmount, client } = harness(enabled);
    try {
      await act(async () => {
        focusManager.setFocused(false);
        onlineManager.setOnline(false);
        focusManager.setFocused(true);
        onlineManager.setOnline(true);
      });
      expect(mockGetBalance).not.toHaveBeenCalled();
    } finally {
      unmount();
      client.clear();
    }
  },
);

it('starts fetching only after the loaded config explicitly enables balance', async () => {
  const { rerender, unmount, client } = harness();
  try {
    rerender({ enabled: false });
    expect(mockGetBalance).not.toHaveBeenCalled();
    rerender({ enabled: true });
    await waitFor(() => expect(mockGetBalance).toHaveBeenCalledTimes(1));
    rerender({ enabled: false });
    await act(async () => {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
    });
    expect(mockGetBalance).toHaveBeenCalledTimes(1);
  } finally {
    unmount();
    client.clear();
  }
});

it('does not fetch balance while global queries are disabled', () => {
  mockQueriesEnabled.mockReturnValue(false);
  const { unmount, client } = harness(true);
  expect(mockGetBalance).not.toHaveBeenCalled();
  unmount();
  client.clear();
});
