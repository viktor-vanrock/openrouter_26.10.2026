import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { PropsWithChildren } from 'react';
import usePrototypeAvailability from './usePrototypeAvailability';

const mockAuth = jest.fn();
const mockGet = jest.fn();
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => mockAuth() }));
jest.mock('~/data-provider', () => ({
  useGetStartupConfig: () => ({ data: { prototypeAgent: { enabled: true } } }),
}));
jest.mock('librechat-data-provider', () => ({
  apiBaseUrl: () => '',
  request: { get: (...args: unknown[]) => mockGet(...args) },
}));

function harness() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => usePrototypeAvailability(), { wrapper }) };
}

it('does not reuse the previous account capability while the next account request is pending', async () => {
  mockAuth.mockReturnValue({ isAuthenticated: true, user: { id: 'allowed-owner' } });
  mockGet.mockResolvedValueOnce({ available: true });
  const { result, rerender, unmount, client } = harness();
  await waitFor(() => expect(result.current).toBe(true));
  mockAuth.mockReturnValue({ isAuthenticated: true, user: { id: 'other-owner' } });
  let finish: (value: { available: boolean }) => void = () => {};
  mockGet.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  rerender();
  expect(result.current).toBe(false);
  await waitFor(() => expect(mockGet).toHaveBeenCalledTimes(2));
  finish({ available: false });
  await waitFor(() =>
    expect(client.getQueryData(['prototype-availability', 'other-owner'])).toEqual({
      available: false,
    }),
  );
  expect(result.current).toBe(false);
  unmount();
  client.clear();
});

it('does not request capability without an authenticated identity', () => {
  mockAuth.mockReturnValue({ isAuthenticated: false, user: undefined });
  const { result, unmount, client } = harness();
  expect(result.current).toBe(false);
  expect(mockGet).not.toHaveBeenCalled();
  unmount();
  client.clear();
});

it('polls every 30 seconds on the visible tab and stops when the chat unmounts', async () => {
  jest.useFakeTimers();
  mockAuth.mockReturnValue({ isAuthenticated: true, user: { id: 'allowed-owner' } });
  mockGet.mockResolvedValue({ available: true });
  const { unmount, client } = harness();
  try {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(29_999);
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
    unmount();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
  } finally {
    unmount();
    client.clear();
    jest.useRealTimers();
  }
});

it('pauses polling on hidden tabs and refreshes on returning to the chat', async () => {
  jest.useFakeTimers();
  const visibility = jest.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  mockAuth.mockReturnValue({ isAuthenticated: true, user: { id: 'allowed-owner' } });
  mockGet.mockResolvedValue({ available: true });
  const { unmount, client } = harness();
  try {
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('hidden');
    act(() => {
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await act(async () => {
      await jest.advanceTimersByTimeAsync(90_000);
    });
    expect(mockGet).toHaveBeenCalledTimes(1);
    visibility.mockReturnValue('visible');
    await act(async () => {
      window.dispatchEvent(new Event('visibilitychange'));
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(mockGet).toHaveBeenCalledTimes(2);
  } finally {
    unmount();
    client.clear();
    visibility.mockRestore();
    jest.useRealTimers();
  }
});
