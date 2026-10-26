import { act, renderHook } from '@testing-library/react';
import { RecoilRoot, useRecoilCallback, useRecoilValue } from 'recoil';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Constants, dataService } from 'librechat-data-provider';
import useSubmitMessage from './useSubmitMessage';
import store from '~/store';

jest.mock('~/store', () => {
  const { atom, atomFamily } = jest.requireActual('recoil');
  const prototype = jest.requireActual('~/store/prototype');
  return {
    __esModule: true,
    default: {
      ...prototype,
      conversationIdByIndex: atomFamily({ key: 'submit-test-conversation', default: 'new' }),
      autoSendPrompts: atom({ key: 'submit-test-auto', default: false }),
      activePromptByIndex: atomFamily({ key: 'submit-test-prompt', default: '' }),
    },
  };
});

const mockNavigate = jest.fn();
const mockToast = jest.fn();
const mockAsk = jest.fn();
const mockSetMessages = jest.fn();
const mockSetConversation = jest.fn();
const mockReset = jest.fn();
const mockSetValue = jest.fn();
let mockDraft = '';
let mockFiles = new Map();
let mockCard: Record<string, unknown> | null = null;
let mockMode = true;
let mockAvailable = true;
jest.mock('~/hooks/Prototype/usePrototypeAvailability', () => ({
  __esModule: true,
  default: () => mockAvailable,
}));

jest.mock('react-router-dom', () => ({ useNavigate: () => mockNavigate }));
jest.mock('@librechat/client', () => ({ useToastContext: () => ({ showToast: mockToast }) }));
jest.mock('~/hooks/AuthContext', () => ({ useAuthContext: () => ({ user: {} }) }));
jest.mock('./useLatestMessage', () => ({ useLatestMessage: () => null }));
jest.mock('~/Providers', () => ({
  useAddedChatContext: () => ({ conversation: null }),
  useChatContext: () => ({
    ask: mockAsk,
    index: 0,
    getMessages: () => [],
    setMessages: mockSetMessages,
    conversation: { conversationId: 'new', model: 'fake/model', endpoint: 'OpenRouter' },
    setConversation: mockSetConversation,
    files: mockFiles,
  }),
  useChatFormContext: () => ({
    reset: mockReset,
    getValues: () => mockDraft,
    setValue: mockSetValue,
  }),
}));
jest.mock('librechat-data-provider', () => ({
  ...jest.requireActual('librechat-data-provider'),
  dataService: {
    submitPrototypeTurn: jest.fn(),
    replyToPrototype: jest.fn(),
    saveMessage: jest.fn(),
    getConversationById: jest.fn(),
  },
}));

function wrapper({ children }: { children: React.ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return (
    <RecoilRoot
      initializeState={({ set }) => {
        set(store.prototypeModeByConvoId(Constants.NEW_CONVO), mockMode);
        if (mockCard) set(store.prototypeCardByConvoId(Constants.NEW_CONVO), mockCard as never);
      }}
    >
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    </RecoilRoot>
  );
}

beforeEach(() => {
  jest.clearAllMocks();
  mockDraft = '';
  mockMode = true;
  mockAvailable = true;
  mockCard = null;
  mockFiles = new Map();
  (dataService.submitPrototypeTurn as jest.Mock).mockResolvedValue({});
  (dataService.getConversationById as jest.Mock).mockImplementation((id: string) =>
    Promise.resolve({ conversationId: id, model: 'fake/model', endpoint: 'OpenRouter' }),
  );
});

it('keeps Prototype mode in the created conversation without sending an ordinary chat request', async () => {
  const { result } = renderHook(
    () => ({
      ...useSubmitMessage(),
      getMode: useRecoilCallback(
        ({ snapshot }) =>
          (id: string) =>
            snapshot.getLoadable(store.prototypeModeByConvoId(id)).getValue(),
        [],
      ),
    }),
    { wrapper },
  );
  await act(async () => {
    await result.current.submitMessage({ text: 'Build a dashboard' });
  });
  const targetId = (dataService.submitPrototypeTurn as jest.Mock).mock.calls[0][0];
  expect(mockNavigate).toHaveBeenCalledWith(`/c/${targetId}`);
  expect(result.current.getMode(targetId)).toBe(true);
  expect(mockAsk).not.toHaveBeenCalled();
  expect(mockSetConversation).toHaveBeenCalledWith(
    expect.objectContaining({ conversationId: targetId }),
  );
});

it('serializes same-tick submits across two hook instances in the same composer', async () => {
  let finish!: () => void;
  (dataService.submitPrototypeTurn as jest.Mock).mockReturnValue(
    new Promise<void>((resolve) => {
      finish = resolve;
    }),
  );
  const { result } = renderHook(
    () => ({
      first: useSubmitMessage(),
      second: useSubmitMessage(),
      busy: useRecoilValue(store.prototypeSubmittingByIndex(0)),
    }),
    { wrapper },
  );
  let first!: Promise<void>;
  await act(async () => {
    first = result.current.first.submitMessage({ text: 'Build a dashboard' });
    await result.current.second.submitMessage({ text: 'Build a dashboard' });
  });
  expect(result.current.busy).toBe(true);
  expect(dataService.submitPrototypeTurn).toHaveBeenCalledTimes(1);
  expect(mockReset).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish();
    await first;
  });
  expect(result.current.busy).toBe(false);
});

it('restores a rejected draft and displays a bounded error instead of backend details', async () => {
  (dataService.submitPrototypeTurn as jest.Mock).mockRejectedValue({
    isAxiosError: true,
    response: {
      data: {
        error: {
          code: 'PROTOTYPE_SERVICE_UNAVAILABLE',
          message: 'private internal details',
        },
      },
    },
  });
  const { result } = renderHook(() => useSubmitMessage(), { wrapper });
  await act(async () => {
    await result.current.submitMessage({ text: 'My original requirements' });
  });
  expect(mockSetValue).toHaveBeenCalledWith('text', 'My original requirements', {
    shouldValidate: true,
  });
  expect(mockToast).toHaveBeenCalledWith({
    message: 'The Prototype service is unavailable. Your draft has been preserved.',
    status: 'error',
  });
});

it('preserves a newer draft when a request fails', async () => {
  mockDraft = 'Newer requirements';
  (dataService.submitPrototypeTurn as jest.Mock).mockRejectedValue(
    new Error('network unavailable'),
  );
  const { result } = renderHook(() => useSubmitMessage(), { wrapper });
  await act(async () => {
    await result.current.submitMessage({ text: 'Original requirements' });
  });
  expect(mockSetValue).not.toHaveBeenCalled();
});

it.each([
  [
    'PROTOTYPE_CONTENT_BLOCKED',
    'Запрос отклонён по правилам содержания. Измените требования или содержимое ТЗ. Черновик и вложения сохранены.',
  ],
  [
    'PROTOTYPE_MODERATION_UNAVAILABLE',
    'Не удалось проверить содержание запроса. Генерация не запускалась. Черновик и вложения сохранены.',
  ],
])('shows a content safety error and restores the draft for %s', async (code, message) => {
  (dataService.submitPrototypeTurn as jest.Mock).mockRejectedValue({
    isAxiosError: true,
    response: { data: { error: { code, message: 'private provider details' } } },
  });
  const { result } = renderHook(() => useSubmitMessage(), { wrapper });
  await act(async () => {
    await result.current.submitMessage({ text: 'Original request' });
  });
  expect(mockSetValue).toHaveBeenCalledWith('text', 'Original request', { shouldValidate: true });
  expect(mockToast).toHaveBeenCalledWith({ message, status: 'error' });
  expect(mockAsk).not.toHaveBeenCalled();
});

it('does not enqueue a second turn while the card is running', async () => {
  mockCard = { status: 'running', actions: { reply: false } };
  const { result } = renderHook(() => useSubmitMessage(), { wrapper });
  await act(async () => {
    await result.current.submitMessage({ text: 'Another request' });
  });
  expect(dataService.submitPrototypeTurn).not.toHaveBeenCalled();
  expect(mockReset).not.toHaveBeenCalled();
});

it('rejects attachments before message persistence or enqueue', async () => {
  mockFiles.set('file', {});
  const { result } = renderHook(() => useSubmitMessage(), { wrapper });
  await act(async () => {
    await result.current.submitMessage({ text: 'Build a dashboard' });
  });
  expect(dataService.submitPrototypeTurn).not.toHaveBeenCalled();
  expect(dataService.saveMessage).not.toHaveBeenCalled();
});

it('uses the ordinary chat request when Prototype mode is off', async () => {
  mockMode = false;
  const { result } = renderHook(() => useSubmitMessage(), { wrapper });
  await act(async () => {
    await result.current.submitMessage({ text: 'Ordinary message' });
  });
  expect(mockAsk).toHaveBeenCalledWith({ text: 'Ordinary message' }, { addedConvo: undefined });
  expect(dataService.submitPrototypeTurn).not.toHaveBeenCalled();
});

it('preserves a prototype draft during an outage and lets ordinary chat send after mode is disabled', async () => {
  mockAvailable = false;
  const { result, rerender } = renderHook(
    () => ({
      ...useSubmitMessage(),
      disablePrototype: useRecoilCallback(
        ({ set }) =>
          () =>
            set(store.prototypeModeByConvoId(Constants.NEW_CONVO), false),
        [],
      ),
    }),
    { wrapper },
  );
  await act(async () => {
    await result.current.submitMessage({ text: 'Keep this draft' });
  });
  expect(dataService.submitPrototypeTurn).not.toHaveBeenCalled();
  expect(mockAsk).not.toHaveBeenCalled();
  expect(mockReset).not.toHaveBeenCalled();
  expect(mockToast).toHaveBeenCalled();
  act(() => result.current.disablePrototype());
  rerender();
  await act(async () => {
    await result.current.submitMessage({ text: 'Ordinary chat' });
  });
  expect(mockAsk).toHaveBeenCalled();
});
