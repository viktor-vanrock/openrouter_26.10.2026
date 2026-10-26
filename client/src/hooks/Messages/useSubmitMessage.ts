import { useCallback, useRef } from 'react';
import { useRecoilCallback, useRecoilValue, useSetRecoilState } from 'recoil';
import { isAxiosError } from 'axios';
import { v4 } from 'uuid';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { useToastContext } from '@librechat/client';
import {
  Constants,
  FileSources,
  QueryKeys,
  replaceSpecialVars,
  dataService,
} from 'librechat-data-provider';
import { useChatContext, useChatFormContext, useAddedChatContext } from '~/Providers';
import { useAuthContext } from '~/hooks/AuthContext';
import { useLatestMessage } from '~/hooks/Messages/useLatestMessage';
import { mainTextareaId } from '~/common';
import store from '~/store';
import usePrototypeAvailability from '~/hooks/Prototype/usePrototypeAvailability';
import useSetFilesToDelete from '~/hooks/Files/useSetFilesToDelete';

export default function useSubmitMessage() {
  const { user } = useAuthContext();
  const setFilesToDelete = useSetFilesToDelete();
  const filesToDeleteRef = useRef(setFilesToDelete);
  filesToDeleteRef.current = setFilesToDelete;
  const methods = useChatFormContext();
  const { conversation: addedConvo } = useAddedChatContext();
  const { ask, index, getMessages, setMessages, conversation, setConversation, files, setFiles } =
    useChatContext();
  const { showToast } = useToastContext();
  const latestMessage = useLatestMessage(index);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const prototypeAvailable = usePrototypeAvailability();
  const prototypeSubmitting = useRecoilValue(store.prototypeSubmittingByIndex(index));
  const setPrototypeSubmitting = useSetRecoilState(store.prototypeSubmittingByIndex(index));
  const claimPrototypeSubmit = useRecoilCallback(
    ({ snapshot, set }) =>
      () => {
        if (snapshot.getLoadable(store.prototypeSubmittingByIndex(index)).getValue()) return false;
        set(store.prototypeSubmittingByIndex(index), true);
        return true;
      },
    [index],
  );
  const preservePrototypeMode = useRecoilCallback(
    ({ set }) =>
      (targetId: string) => {
        set(store.prototypeModeByConvoId(targetId), true);
      },
    [],
  );
  const conversationId = useRecoilValue(store.conversationIdByIndex(index));
  const prototypeMode = useRecoilValue(
    store.prototypeModeByConvoId(conversationId ?? Constants.NEW_CONVO),
  );
  const prototypeCard = useRecoilValue(
    store.prototypeCardByConvoId(conversationId ?? Constants.NEW_CONVO),
  );

  const autoSendPrompts = useRecoilValue(store.autoSendPrompts);
  const setActivePrompt = useSetRecoilState(store.activePromptByIndex(index));

  const submitMessage = useCallback(
    async (data?: { text: string }) => {
      if (!data) {
        return console.warn('No data provided to submitMessage');
      }
      if (prototypeMode && !prototypeAvailable) {
        showToast({
          message:
            'Сервис прототипов временно недоступен. Выключите режим прототипа и отправьте сообщение в обычный чат.',
          status: 'warning',
        });
        return;
      }
      if (prototypeMode && prototypeSubmitting && prototypeAvailable) return;
      const rootMessages = getMessages();
      const isLatestInRootMessages = rootMessages?.some(
        (message) => message.messageId === latestMessage?.messageId,
      );
      if (!isLatestInRootMessages && latestMessage) {
        setMessages([...(rootMessages || []), latestMessage]);
      }

      if (prototypeMode) {
        if (prototypeCard && prototypeCard.status !== 'completed' && !prototypeCard.actions.reply) {
          showToast({
            message: 'Wait for the prototype to request a reply or complete the current turn.',
            status: 'warning',
          });
          return;
        }
        const submittedFiles = Array.from(files.values());
        if (submittedFiles.length > 10) {
          showToast({
            message: 'К одному запросу можно приложить не более 10 документов.',
            status: 'warning',
          });
          return;
        }
        if (submittedFiles.some((file) => file.progress !== 1)) {
          showToast({ message: 'Дождитесь завершения загрузки файла.', status: 'warning' });
          return;
        }
        if (submittedFiles.some((file) => file.source !== FileSources.text)) {
          showToast({
            message:
              'Для ТЗ выберите «Загрузить как текст». Другие вложения пока не поддерживаются.',
            status: 'warning',
          });
          return;
        }
        const targetConversationId =
          !conversationId || conversationId === Constants.NEW_CONVO ? v4() : conversationId;
        const text = data.text.trim();
        if (!text) return;
        const messageId = v4();
        const parentMessageId = latestMessage?.messageId ?? Constants.NO_PARENT;
        const modelId = conversation?.model ?? addedConvo?.model ?? rootMessages?.at(-1)?.model;
        if (!modelId) {
          showToast({ message: 'Select a model before starting a prototype.', status: 'warning' });
          return;
        }
        if (!claimPrototypeSubmit()) return;
        const optimisticMessage = {
          messageId,
          conversationId: targetConversationId,
          parentMessageId,
          text,
          ...(submittedFiles.length
            ? {
                files: submittedFiles.map((file) => ({
                  file_id: file.file_id,
                  filename: file.filename,
                  type: file.type?.startsWith('image/') ? 'text/plain' : (file.type ?? ''),
                  source: file.source,
                  bytes: file.size,
                })),
              }
            : {}),
          sender: 'User',
          isCreatedByUser: true,
          error: false,
          metadata: { prototypeAgent: true },
        };
        setMessages([...(rootMessages ?? []), optimisticMessage]);
        methods.reset();
        try {
          if (prototypeCard?.actions.reply === true && prototypeCard.promptMessageId != null) {
            await dataService.saveMessage(targetConversationId, {
              ...optimisticMessage,
              model: modelId,
              endpoint: conversation?.endpoint ?? undefined,
              metadata: {
                prototypeAgent: true,
                prototypeReplyToMessageId: prototypeCard.promptMessageId,
              },
            });
            await dataService.replyToPrototype(
              prototypeCard.jobId,
              targetConversationId,
              {
                messageId,
                prototypeReplyToMessageId: prototypeCard.promptMessageId,
              },
              `reply:${messageId}`,
              prototypeCard.revision,
            );
          } else {
            await dataService.submitPrototypeTurn(
              targetConversationId,
              {
                messageId,
                parentMessageId,
                text,
                ...(submittedFiles.length
                  ? { fileIds: submittedFiles.map((file) => file.file_id) }
                  : {}),
                modelId,
                endpoint: conversation?.endpoint ?? undefined,
                title: text.slice(0, 80),
                revision: prototypeCard?.revision ?? null,
              },
              `chat:${messageId}`,
            );
          }
          if (submittedFiles.length) {
            const acceptedIds = new Set(submittedFiles.map((file) => file.file_id));
            setFiles((current) => {
              const remaining = new Map(
                Array.from(current).filter(([, file]) => !acceptedIds.has(file.file_id)),
              );
              filesToDeleteRef.current(Object.fromEntries(remaining));
              return remaining;
            });
          }
          if (targetConversationId !== conversationId) {
            preservePrototypeMode(targetConversationId);
            try {
              setConversation(await dataService.getConversationById(targetConversationId));
            } catch {
              setConversation({
                ...(addedConvo ?? conversation ?? {}),
                conversationId: targetConversationId,
                endpoint: conversation?.endpoint ?? addedConvo?.endpoint ?? null,
                createdAt:
                  addedConvo?.createdAt ?? conversation?.createdAt ?? new Date().toISOString(),
                updatedAt:
                  addedConvo?.updatedAt ?? conversation?.updatedAt ?? new Date().toISOString(),
                model: modelId,
                title: text.slice(0, 80),
              });
            }
            navigate(`/c/${targetConversationId}`);
          }
        } catch (error) {
          setMessages(rootMessages ?? []);
          if (!methods.getValues('text')?.trim()) {
            methods.setValue('text', data.text, { shouldValidate: true });
          }
          const code = isAxiosError(error) ? error.response?.data?.error?.code : undefined;
          const messages: Record<string, string> = {
            PROTOTYPE_CONTENT_BLOCKED:
              'Запрос отклонён по правилам содержания. Измените требования или содержимое ТЗ. Черновик и вложения сохранены.',
            PROTOTYPE_MODERATION_UNAVAILABLE:
              'Не удалось проверить содержание запроса. Генерация не запускалась. Черновик и вложения сохранены.',
            PROTOTYPE_ATTACHMENT_INVALID:
              'Не удалось прочитать ТЗ. Загрузите непустой документ через «Загрузить как текст». Черновик и вложения сохранены.',
            PROTOTYPE_REQUIREMENTS_TOO_LARGE:
              'Сообщение и текст ТЗ превышают 50 000 символов. Сократите документ или разделите доработки на несколько сообщений. Вложения сохранены.',
            PROTOTYPE_MODEL_BLOCKED:
              'This model is not allowed for prototypes. Select another model.',
            PROTOTYPE_MODEL_UNSUPPORTED:
              'This model does not support prototypes. Select another model.',
            PROTOTYPE_STALE_REVISION:
              'The prototype changed in another tab. Wait for the card to update and retry.',
            PROTOTYPE_SERVICE_UNAVAILABLE:
              'The Prototype service is unavailable. Your draft has been preserved.',
            PROTOTYPE_QUEUE_UNAVAILABLE:
              'The Prototype execution queue is unavailable. Your draft has been preserved.',
          };
          showToast({
            message:
              messages[code] ??
              'The Prototype message could not be accepted. Your draft has been preserved; reload to recover server state.',
            status: 'error',
          });
        } finally {
          try {
            await queryClient.invalidateQueries([QueryKeys.messages, targetConversationId]);
          } finally {
            setPrototypeSubmitting(false);
          }
        }
        return;
      }

      ask(
        {
          text: data.text,
        },
        {
          addedConvo: addedConvo ?? undefined,
        },
      );
      methods.reset();
    },
    [
      ask,
      methods,
      addedConvo,
      setMessages,
      setConversation,
      getMessages,
      latestMessage,
      prototypeMode,
      prototypeAvailable,
      prototypeSubmitting,
      claimPrototypeSubmit,
      preservePrototypeMode,
      setPrototypeSubmitting,
      files,
      setFiles,
      conversationId,
      queryClient,
      conversation,
      navigate,
      prototypeCard,
      showToast,
    ],
  );

  const submitPrompt = useCallback(
    (text: string) => {
      const parsedText = replaceSpecialVars({ text, user });
      if (autoSendPrompts) {
        submitMessage({ text: parsedText });
        return;
      }

      const textarea = document.getElementById(mainTextareaId) as HTMLTextAreaElement | null;
      const currentText = textarea?.value ?? methods.getValues('text');
      const newText = currentText.trim().length > 1 ? `\n${parsedText}` : parsedText;
      setActivePrompt(newText);
    },
    [autoSendPrompts, submitMessage, setActivePrompt, methods, user],
  );

  return { submitMessage, submitPrompt };
}
