import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ReleasesButton from './ReleasesButton';
import { getUnreadReleases, markReleasesSeen, useReleasesStatus } from './api';

jest.mock('./api', () => ({
  releaseKeys: {
    status: ['releases', 'status'],
    unread: ['releases', 'unread'],
    list: ['releases', 'list'],
  },
  useReleasesStatus: jest.fn(),
  getUnreadReleases: jest.fn(),
  getReleases: jest.fn(),
  markReleasesSeen: jest.fn(),
}));

jest.mock('@librechat/client', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  OGDialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  OGDialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

const status = useReleasesStatus as jest.Mock;
const getUnread = getUnreadReleases as jest.Mock;
const seen = markReleasesSeen as jest.Mock;

function renderButton() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ReleasesButton compact />
    </QueryClientProvider>,
  );
}

describe('ReleasesButton', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    seen.mockResolvedValue({ unreadCount: 0 });
  });

  it('shows a marker only when there are unread releases', () => {
    status.mockReturnValue({ data: { unreadCount: 3 } });
    const view = renderButton();
    expect(screen.getByRole('button', { name: /непрочитанные: 3/ })).toHaveTextContent('3');
    view.unmount();
    status.mockReturnValue({ data: { unreadCount: 0 } });
    renderButton();
    expect(screen.getByRole('button', { name: 'Что нового' })).not.toHaveTextContent('3');
  });

  it('keeps the popover snapshot after marking a release as seen', async () => {
    status.mockReturnValue({ data: { unreadCount: 1 } });
    getUnread.mockResolvedValue({
      items: [
        {
          id: '123',
          title: 'Первый релиз',
          text: 'Описание',
          publishedAt: '2026-10-26T18:30:00.000Z',
          isUnread: true,
        },
      ],
      unreadCount: 1,
      lastSeenAt: '2020-01-01T00:00:00.000Z',
    });
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: /непрочитанные: 1/ }));
    await waitFor(() => expect(seen).toHaveBeenCalledWith('2026-10-26T18:30:00.000Z'));
    expect(screen.getByText('Первый релиз')).toBeInTheDocument();
  });
});
