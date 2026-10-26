import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { dataService } from 'librechat-data-provider';
import { RecoilRoot } from 'recoil';
import PrototypeCard from './PrototypeCard';
import PrototypePreview from '~/components/Artifacts/PrototypePreview';
import { ShareContext } from '~/Providers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SSE } from 'sse.js';

jest.mock('sse.js', () => {
  class FakeSSE {
    static instances: any[] = [];
    headers: any;
    url: string;
    options: any;
    close = jest.fn();
    stream = jest.fn();
    listeners = new Map();
    addEventListener = jest.fn((type: string, listener: any) => {
      this.listeners.set(type, listener);
    });

    constructor(url: string, options: any) {
      this.url = url;
      this.options = options;
      this.headers = options.headers ?? {};
      FakeSSE.instances.push(this);
    }

    emit(type: string, data: any, lastEventId = '') {
      this.listeners.get(type)?.({
        data: JSON.stringify(data),
        lastEventId,
      } as MessageEvent<string>);
    }
  }
  return { SSE: FakeSSE };
});

jest.mock('librechat-data-provider', () => {
  const actual = jest.requireActual('librechat-data-provider');
  return {
    ...actual,
    apiBaseUrl: () => '',
    getTokenHeader: () => 'Bearer browser-token',
    dataService: {
      getConversationPrototype: jest.fn(),
      getPrototypeHtml: jest.fn(),
      getPrototypeHtmlDownload: jest.fn(),
      getPrototypeSources: jest.fn(),
      approvePrototype: jest.fn(),
      cancelPrototype: jest.fn(),
      retryPrototype: jest.fn(),
      finalizePrototype: jest.fn(),
      saveMessage: jest.fn(),
      replyToPrototype: jest.fn(),
    },
  };
});

const card = {
  type: 'prototype' as const,
  jobId: 'job_507f1f77bcf86cd799439011',
  conversationId: 'conversation-1',
  turnId: 'turn-1',
  revision: 4,
  cursor: 8,
  status: 'waiting_for_input' as const,
  phase: 'planning',
  waitingReason: 'plan_approval' as const,
  promptMessageId: 'prompt-1',
  modelId: 'openai/gpt-5',
  modelWarning: null,
  prototypeName: null,
  previewAvailable: true,
  sourcesAvailable: true,
  failure: null,
  activity: [
    {
      id: 'event-1',
      phase: 'planning',
      message: 'Plan ready',
      createdAt: '2026-09-28T00:00:00.000Z',
    },
  ],
  versions: [],
  actions: { approve: true, cancel: true, retry: false, finalize: false, reply: false },
  canCancel: true,
  canReply: false,
  estimatedCost: null,
  actualCostUsd: 0,
};

const FakeEventSource = SSE as unknown as {
  instances: Array<{
    url: string;
    headers: Record<string, string>;
    options: { autoReconnect?: boolean; useLastEventId?: boolean };
    close: jest.Mock;
    stream: jest.Mock;
    emit: (type: string, data: unknown, lastEventId?: string) => void;
  }>;
};

describe('PrototypeCard', () => {
  const renderWithProviders = (ui: React.ReactNode) => {
    const queryClient = new QueryClient();
    const Wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>{children}</RecoilRoot>
      </QueryClientProvider>
    );
    return {
      queryClient,
      ...render(ui, { wrapper: Wrapper }),
    };
  };

  beforeEach(() => {
    jest.clearAllMocks();
    FakeEventSource.instances = [];
    jest.mocked(dataService.getConversationPrototype).mockResolvedValue(card);
    jest.mocked(dataService.getPrototypeHtml).mockResolvedValue({
      data: {
        text: async () =>
          '<!doctype html><html><head><title>Accepted</title></head><body>Ready</body></html>',
      },
    } as never);
    jest.mocked(dataService.getPrototypeHtmlDownload).mockResolvedValue({
      data: new Blob(['accepted']),
      headers: { 'content-disposition': 'attachment; filename="accepted.html"' },
    } as never);
    jest.mocked(dataService.getPrototypeSources).mockResolvedValue({
      data: new Blob(['sources']),
      headers: { 'content-disposition': 'attachment; filename="sources.zip"' },
    } as never);
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: jest.fn(() => 'blob:prototype-download'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: jest.fn(),
    });
    HTMLAnchorElement.prototype.click = jest.fn();
    jest.mocked(dataService.approvePrototype).mockResolvedValue({ ...card, status: 'queued' });
  });

  it('stops the running indicator and shows the generation compatibility failure received over SSE', async () => {
    jest
      .mocked(dataService.getConversationPrototype)
      .mockResolvedValue({ ...card, status: 'running', phase: 'generation' });
    renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    await screen.findByRole('status', { name: 'Прототип обрабатывается' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const message =
      'Сервис прототипов обновлён с момента создания этой задачи. Начните новый прототип в новом чате.';
    act(() =>
      FakeEventSource.instances[0].emit('job_state', {
        ...card,
        cursor: 9,
        revision: 5,
        status: 'failed',
        failure: { code: 'PROTOTYPE_EXECUTION_FAILED', message },
      }),
    );
    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(
      screen.queryByRole('status', { name: 'Прототип обрабатывается' }),
    ).not.toBeInTheDocument();
  });

  it('describes finished steps and raw phases without claiming the whole prototype has finished', async () => {
    jest.mocked(dataService.getConversationPrototype).mockResolvedValue({
      ...card,
      status: 'failed',
      failure: {
        code: 'PROTOTYPE_BUILD_FAILED',
        message: 'Не удалось подготовить прототип к просмотру.',
      },
      activity: [
        {
          id: 'finished',
          phase: 'generation',
          message: 'Prototype stage completed',
          createdAt: '',
        },
        { id: 'transfer', phase: 'transfer', message: 'transfer', createdAt: '' },
        { id: 'check', phase: 'build_qa', message: 'build_qa', createdAt: '' },
      ],
    });
    renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    expect(await screen.findByText('Исходники прототипа подготовлены')).toBeInTheDocument();
    expect(screen.getByText('Подготавливаем исходники')).toBeInTheDocument();
    expect(screen.getByText('Проверяем готовность прототипа')).toBeInTheDocument();
    expect(screen.queryByText('Этап прототипа завершён')).not.toBeInTheDocument();
    expect(screen.queryByText('build_qa')).not.toBeInTheDocument();
  });

  it('hydrates from the durable snapshot and renders a sandboxed accepted preview', async () => {
    renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    expect(await screen.findByRole('region', { name: 'Prototype task' })).toBeInTheDocument();
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(FakeEventSource.instances[0].url).toContain('/prototype/events?cursor=8');
    expect(FakeEventSource.instances[0].headers).toEqual({
      Accept: 'text/event-stream',
      Authorization: 'Bearer browser-token',
    });
    expect(FakeEventSource.instances[0].options).toMatchObject({
      autoReconnect: true,
      useLastEventId: true,
    });
    expect(FakeEventSource.instances[0].stream).toHaveBeenCalledTimes(1);

    renderWithProviders(
      <PrototypePreview jobId={card.jobId} conversationId={card.conversationId} />,
    );
    const iframe = screen.getByTitle('Accepted prototype');
    expect(iframe).toHaveAttribute('sandbox', 'allow-scripts allow-forms');
    expect(iframe.getAttribute('sandbox')).not.toContain('allow-same-origin');
    expect(iframe).toHaveAttribute('referrerpolicy', 'no-referrer');
    await waitFor(() => expect(iframe.getAttribute('srcdoc')).toContain("connect-src 'none'"));
    expect(dataService.getPrototypeHtml).toHaveBeenCalledWith(card.jobId, card.conversationId);
  });

  it('uses a non-empty idempotency key and disables duplicate action submission', async () => {
    renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    const approve = await screen.findByRole('button', { name: 'Подтвердить план' });
    fireEvent.click(approve);
    await waitFor(() => expect(dataService.approvePrototype).toHaveBeenCalledTimes(1));
    expect(jest.mocked(dataService.approvePrototype).mock.calls[0][1]).toBe('conversation-1');
    expect(jest.mocked(dataService.approvePrototype).mock.calls[0][2]).toMatch(/^approve:/);
    expect(jest.mocked(dataService.approvePrototype).mock.calls[0][3]).toBe(4);
  });

  it.each(['queued', 'preparing', 'running'] as const)(
    'shows background progress for %s without a pending button action',
    async (status) => {
      jest.mocked(dataService.getConversationPrototype).mockResolvedValue({ ...card, status });
      renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
      const progress = await screen.findByRole('status', { name: 'Прототип обрабатывается' });
      expect(progress).toHaveTextContent(
        status === 'queued'
          ? 'Запрос принят. Ожидаем начала работы'
          : 'Продумываем экраны и сценарии',
      );
      expect(progress.querySelector('.prototype-thinking')).toBeInTheDocument();
      expect(
        screen.queryByText(/Режим:|React \+ TypeScript|@ai-sber\/uikit/),
      ).not.toBeInTheDocument();
    },
  );

  it('updates progress from durable stages and stops it when a response is needed or work finishes', async () => {
    jest
      .mocked(dataService.getConversationPrototype)
      .mockResolvedValue({ ...card, status: 'running' });
    renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    await screen.findByRole('status', { name: 'Прототип обрабатывается' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const stream = FakeEventSource.instances[0];
    act(() =>
      stream.emit('job_state', { ...card, cursor: 9, status: 'running', phase: 'build_qa' }),
    );
    expect(screen.getByRole('status', { name: 'Прототип обрабатывается' })).toHaveTextContent(
      'Проверяем, что прототип готов к просмотру',
    );
    for (const [index, status] of [
      'waiting_for_input',
      'review',
      'completed',
      'failed',
      'canceled',
    ].entries()) {
      act(() => stream.emit('job_state', { ...card, cursor: 10 + index, status }));
      expect(
        screen.queryByRole('status', { name: 'Прототип обрабатывается' }),
      ).not.toBeInTheDocument();
    }
  });

  it('shows a connection warning during background work and restores the stage after reconnect', async () => {
    jest
      .mocked(dataService.getConversationPrototype)
      .mockResolvedValue({ ...card, status: 'running' });
    renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    await screen.findByRole('status', { name: 'Прототип обрабатывается' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0].emit('error', {}));
    expect(screen.getByRole('status', { name: 'Прототип обрабатывается' })).toHaveTextContent(
      'Восстанавливаем связь. Результат пока не подтверждён',
    );
    act(() => FakeEventSource.instances[0].emit('open', {}));
    expect(screen.getByRole('status', { name: 'Прототип обрабатывается' })).toHaveTextContent(
      'Продумываем экраны и сценарии',
    );
  });

  it('downloads accepted artifacts through the authenticated data client', async () => {
    renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'HTML' }));

    await waitFor(() =>
      expect(dataService.getPrototypeHtmlDownload).toHaveBeenCalledWith(
        card.jobId,
        'conversation-1',
        undefined,
      ),
    );
  });

  it('choosing a design sends an explicit review reply for rebuilding instead of completing the draft', async () => {
    const review = {
      ...card,
      status: 'review' as const,
      waitingReason: null,
      actions: { ...card.actions, approve: false, finalize: false, reply: true },
    };
    jest.mocked(dataService.getConversationPrototype).mockResolvedValue(review);
    jest
      .mocked(dataService.replyToPrototype)
      .mockResolvedValue({ ...review, status: 'queued', cursor: 9 });
    renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    expect(screen.queryByRole('button', { name: 'Завершить выполнение' })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Выбрать вариант B' }));
    await waitFor(() => expect(dataService.replyToPrototype).toHaveBeenCalledTimes(1));
    expect(dataService.saveMessage).toHaveBeenCalledWith(
      'conversation-1',
      expect.objectContaining({
        text: 'Выбираю вариант B. Сохрани его для всех последующих доработок.',
        parentMessageId: 'prompt-1',
        metadata: { prototypeAgent: true, prototypeReplyToMessageId: 'prompt-1' },
      }),
    );
    expect(dataService.finalizePrototype).not.toHaveBeenCalled();
  });

  it('applies a durable SSE cursor once and refreshes projected chat messages', async () => {
    const queryClient = new QueryClient();
    const invalidate = jest.spyOn(queryClient, 'invalidateQueries').mockResolvedValue();
    render(
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>
          <PrototypeCard conversationId="conversation-1" />
        </RecoilRoot>
      </QueryClientProvider>,
    );
    await screen.findByRole('region', { name: 'Prototype task' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    expect(invalidate).toHaveBeenCalledWith([expect.anything(), 'conversation-1']);
    expect(invalidate).toHaveBeenCalledTimes(1);
    invalidate.mockClear();
    const update = { ...card, cursor: 9, revision: 5, status: 'queued' as const };

    act(() => {
      FakeEventSource.instances[0].emit('job_state', update, '9');
      FakeEventSource.instances[0].emit('job_state', update, '9');
    });

    await screen.findByText(/в очереди · планирование/);
    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
  });

  it('clears a transient disconnect warning after the authenticated stream reconnects', async () => {
    renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    await screen.findByRole('region', { name: 'Prototype task' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => FakeEventSource.instances[0].emit('error', {}));
    expect(
      await screen.findByText('Связь прервалась. Восстанавливаем обновления…'),
    ).toBeInTheDocument();

    act(() => FakeEventSource.instances[0].emit('open', {}));
    await waitFor(() =>
      expect(
        screen.queryByText('Связь прервалась. Восстанавливаем обновления…'),
      ).not.toBeInTheDocument(),
    );
  });

  it('resets the cursor on conversation navigation and ignores the closed stream', async () => {
    const view = renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    await screen.findByRole('region', { name: 'Prototype task' });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const previousStream = FakeEventSource.instances[0];
    const next = {
      ...card,
      jobId: 'job_507f1f77bcf86cd799439012',
      conversationId: 'conversation-2',
      modelId: 'fake/new-model',
      cursor: 1,
      revision: 0,
    };
    jest.mocked(dataService.getConversationPrototype).mockResolvedValue(next);
    view.rerender(<PrototypeCard conversationId="conversation-2" />);
    await screen.findByText(/fake\/new-model/);
    expect(previousStream.close).toHaveBeenCalledTimes(1);
    act(() =>
      previousStream.emit('job_state', { ...card, cursor: 99, modelId: 'fake/old-model' }, '99'),
    );
    expect(screen.queryByText(/fake\/old-model/)).not.toBeInTheDocument();
    expect(screen.getByText(/fake\/new-model/)).toBeInTheDocument();
  });

  it('ignores a delayed action response from a previous conversation', async () => {
    let finish!: (value: typeof card) => void;
    jest.mocked(dataService.approvePrototype).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const view = renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Подтвердить план' }));
    const next = {
      ...card,
      conversationId: 'conversation-2',
      modelId: 'fake/new-model',
      cursor: 1,
    };
    jest.mocked(dataService.getConversationPrototype).mockResolvedValue(next);
    view.rerender(<PrototypeCard conversationId="conversation-2" />);
    await screen.findByText(/fake\/new-model/);
    await act(async () => {
      finish({ ...card, cursor: 99, modelId: 'fake/old-model' });
    });
    expect(screen.getByText(/fake\/new-model/)).toBeInTheDocument();
    expect(screen.queryByText(/fake\/old-model/)).not.toBeInTheDocument();
  });

  it('recovers an action conflict even when SSE already delivered the same cursor', async () => {
    let rejectAction!: (error: unknown) => void;
    jest.mocked(dataService.cancelPrototype).mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectAction = reject;
        }),
    );
    const canceled = {
      ...card,
      cursor: 9,
      revision: 5,
      status: 'canceled' as const,
      actions: { approve: false, cancel: false, retry: false, finalize: false, reply: false },
    };
    renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    fireEvent.click(await screen.findByRole('button', { name: 'Отменить' }));
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    act(() => FakeEventSource.instances[0].emit('job_state', canceled, '9'));
    jest.mocked(dataService.getConversationPrototype).mockResolvedValue(canceled);
    await act(async () => {
      rejectAction({ isAxiosError: true, response: { status: 409 } });
    });
    await screen.findByText(/отменён · ~?openai\//);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(dataService.cancelPrototype).toHaveBeenCalledTimes(1);
    expect(dataService.getConversationPrototype).toHaveBeenCalledTimes(2);
  });

  it('retries a temporarily unavailable snapshot before opening the durable stream', async () => {
    jest
      .mocked(dataService.getConversationPrototype)
      .mockRejectedValueOnce({ isAxiosError: true, response: { status: 503 } })
      .mockResolvedValue(card);
    renderWithProviders(<PrototypeCard conversationId="conversation-1" />);
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Не удалось загрузить состояние прототипа. Пробуем ещё раз',
    );
    expect(FakeEventSource.instances).toHaveLength(0);
    await screen.findByRole('region', { name: 'Prototype task' }, { timeout: 2_000 });
    expect(dataService.getConversationPrototype).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('retries accepted preview loading after a temporary storage outage', async () => {
    jest.mocked(dataService.getPrototypeHtml).mockRejectedValueOnce(new Error('temporary outage'));
    renderWithProviders(
      <PrototypePreview jobId={card.jobId} conversationId={card.conversationId} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Retry preview' }));
    await waitFor(() =>
      expect(screen.getByTitle('Accepted prototype').getAttribute('srcdoc')).toContain(
        "connect-src 'none'",
      ),
    );
    expect(dataService.getPrototypeHtml).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('does not expose the source job card or control API in a shared conversation', async () => {
    render(
      <QueryClientProvider client={new QueryClient()}>
        <RecoilRoot>
          <ShareContext.Provider value={{ isSharedConvo: true }}>
            <PrototypeCard conversationId="conversation-1" />
          </ShareContext.Provider>
        </RecoilRoot>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(dataService.getConversationPrototype).not.toHaveBeenCalled());
    expect(screen.queryByRole('region', { name: 'Prototype task' })).not.toBeInTheDocument();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('requests fullscreen from the direct preview button click', async () => {
    renderWithProviders(
      <PrototypePreview jobId={card.jobId} conversationId={card.conversationId} />,
    );
    const iframe = screen.getByTitle('Accepted prototype');
    await waitFor(() => expect(iframe.getAttribute('srcdoc')).toContain("connect-src 'none'"));
    const container = iframe.parentElement as HTMLDivElement;
    const requestFullscreen = jest.fn().mockResolvedValue(undefined);
    container.requestFullscreen = requestFullscreen;

    fireEvent.click(screen.getByRole('button', { name: 'Enter fullscreen' }));

    expect(requestFullscreen).toHaveBeenCalledTimes(1);
  });

  it('refreshes an open preview when a new accepted HTML digest arrives', async () => {
    const queryClient = new QueryClient();
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>
        <RecoilRoot>{children}</RecoilRoot>
      </QueryClientProvider>
    );
    const view = render(
      <PrototypePreview
        jobId={card.jobId}
        conversationId={card.conversationId}
        htmlDigest="first"
      />,
      { wrapper },
    );
    await waitFor(() =>
      expect(screen.getByTitle('Accepted prototype').getAttribute('srcdoc')).toContain('Ready'),
    );
    jest.mocked(dataService.getPrototypeHtml).mockResolvedValue({
      data: { text: async () => '<!doctype html><h1>Final chosen layout</h1>' },
    } as never);
    view.rerender(
      <PrototypePreview
        jobId={card.jobId}
        conversationId={card.conversationId}
        htmlDigest="second"
      />,
    );
    await waitFor(() =>
      expect(screen.getByTitle('Accepted prototype').getAttribute('srcdoc')).toContain(
        'Final chosen layout',
      ),
    );
    expect(dataService.getPrototypeHtml).toHaveBeenCalledTimes(2);
  });

  it('exits fullscreen from the preview button and follows fullscreenchange', async () => {
    renderWithProviders(
      <PrototypePreview jobId={card.jobId} conversationId={card.conversationId} />,
    );
    const container = screen.getByTitle('Accepted prototype').parentElement;
    const exitFullscreen = jest.fn().mockResolvedValue(undefined);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: container });
    Object.defineProperty(document, 'exitFullscreen', {
      configurable: true,
      value: exitFullscreen,
    });
    try {
      fireEvent(document, new Event('fullscreenchange'));
      fireEvent.click(screen.getByRole('button', { name: 'Exit fullscreen' }));
      expect(exitFullscreen).toHaveBeenCalledTimes(1);
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
      fireEvent(document, new Event('fullscreenchange'));
      expect(screen.getByRole('button', { name: 'Enter fullscreen' })).toBeInTheDocument();
    } finally {
      Reflect.deleteProperty(document, 'fullscreenElement');
      Reflect.deleteProperty(document, 'exitFullscreen');
    }
  });
});
