import React, { useEffect, useState } from 'react';
import { useForm, FormProvider } from 'react-hook-form';
import {
  EModelEndpoint,
  EModelEndpointCustom,
  alternateName,
  isAssistantsEndpoint,
} from 'librechat-data-provider';
import {
  useRevokeUserKeyMutation,
  useRevokeAllUserKeysMutation,
} from 'librechat-data-provider/react-query';
import {
  Label,
  Button,
  Spinner,
  OGDialog,
  Dropdown,
  OGDialogTitle,
  OGDialogHeader,
  OGDialogFooter,
  OGDialogContent,
  useToastContext,
  OGDialogTrigger,
} from '@librechat/client';
import type { TDialogProps } from '~/common';
import { useUserKey, useLocalize } from '~/hooks';
import { NotificationSeverity } from '~/common';
import CustomConfig from './CustomEndpoint';
import GoogleConfig from './GoogleConfig';
import OpenAIConfig from './OpenAIConfig';
import OtherConfig from './OtherConfig';
import BedrockConfig from './BedrockConfig';
import HelpText from './HelpText';
import { logger } from '~/utils';
import { useCurrentKey } from '~/Providers';
const endpointComponents = {
  [EModelEndpoint.google]: GoogleConfig,
  [EModelEndpoint.openAI]: OpenAIConfig,
  [EModelEndpoint.custom]: CustomConfig,
  [EModelEndpoint.azureOpenAI]: OpenAIConfig,
  [EModelEndpoint.assistants]: OpenAIConfig,
  [EModelEndpoint.azureAssistants]: OpenAIConfig,
  [EModelEndpoint.bedrock]: BedrockConfig,
  default: OtherConfig,
};

const formSet: Set<string> = new Set([
  EModelEndpoint.openAI,
  EModelEndpoint.custom,
  EModelEndpoint.azureOpenAI,
  EModelEndpoint.assistants,
  EModelEndpoint.azureAssistants,
  EModelEndpoint.bedrock,
]);

const OPENROUTER_KEY_REGEX = /^sk-or-(?:v\d+-)?[A-Za-z0-9_-]{32,}$/;

const isOpenRouterEndpoint = (endpoint: EModelEndpoint | string) =>
  endpoint === EModelEndpointCustom.openRouter ||
  endpoint.toString().toLowerCase() === 'openrouter';

const isValidOpenRouterKey = (key: string) => OPENROUTER_KEY_REGEX.test(key.trim());

const EXPIRY = {
  THIRTY_MINUTES: { label: 'in 30 minutes', value: 30 * 60 * 1000 },
  TWO_HOURS: { label: 'in 2 hours', value: 2 * 60 * 60 * 1000 },
  TWELVE_HOURS: { label: 'in 12 hours', value: 12 * 60 * 60 * 1000 },
  ONE_DAY: { label: 'in 1 day', value: 24 * 60 * 60 * 1000 },
  ONE_WEEK: { label: 'in 7 days', value: 7 * 24 * 60 * 60 * 1000 },
  ONE_MONTH: { label: 'in 30 days', value: 30 * 24 * 60 * 60 * 1000 },
  NEVER: { label: 'never', value: 0 },
};

const RevokeKeysButton = ({
  endpoint,
  disabled,
  setDialogOpen,
}: {
  endpoint: string;
  disabled: boolean;
  setDialogOpen: (open: boolean) => void;
}) => {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const { showToast } = useToastContext();
  const revokeKeyMutation = useRevokeUserKeyMutation(endpoint);
  const revokeKeysMutation = useRevokeAllUserKeysMutation();

  const handleSuccess = () => {
    showToast({
      message: localize('com_ui_revoke_key_success'),
      status: NotificationSeverity.SUCCESS,
    });

    if (!setDialogOpen) {
      return;
    }

    setDialogOpen(false);
  };

  const handleError = () => {
    showToast({
      message: localize('com_ui_revoke_key_error'),
      status: NotificationSeverity.ERROR,
    });
  };

  const onClick = () => {
    revokeKeyMutation.mutate(
      {},
      {
        onSuccess: handleSuccess,
        onError: handleError,
      },
    );
    setOpen(false);
  };

  const isLoading = revokeKeyMutation.isLoading || revokeKeysMutation.isLoading;

  return (
    <div className="flex items-center justify-between">
      <OGDialog open={open} onOpenChange={setOpen}>
        <OGDialogTrigger asChild>
          <Button
            variant="destructive"
            className="flex items-center justify-center rounded-lg bg-red-500 transition-colors duration-200"
            onClick={() => setOpen(true)}
            disabled={disabled}
          >
            {localize('com_ui_revoke')}
          </Button>
        </OGDialogTrigger>
        <OGDialogContent className="max-w-[450px]">
          <OGDialogHeader>
            <OGDialogTitle>{localize('com_ui_revoke_key_endpoint', { 0: endpoint })}</OGDialogTitle>
          </OGDialogHeader>
          <div className="py-4">
            <Label className="text-left text-sm font-medium">
              {localize('com_ui_revoke_key_confirm')}
            </Label>
          </div>
          <OGDialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              {localize('com_ui_cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={onClick}
              disabled={isLoading}
              className="bg-destructive text-white transition-all duration-200 hover:bg-destructive/80"
            >
              {isLoading ? <Spinner /> : localize('com_ui_revoke')}
            </Button>
          </OGDialogFooter>
        </OGDialogContent>
      </OGDialog>
    </div>
  );
};

const SetKeyDialog = ({
  open,
  onOpenChange,
  endpoint,
  endpointType,
  userProvideURL,
  userProvideAccessKeyId,
  userProvideSecretAccessKey,
  userProvideSessionToken,
  userProvideBearerToken,
}: Pick<TDialogProps, 'open' | 'onOpenChange'> & {
  endpoint: EModelEndpoint | string;
  endpointType?: EModelEndpoint;
  userProvideURL?: boolean | null;
  userProvideAccessKeyId?: boolean;
  userProvideSecretAccessKey?: boolean;
  userProvideSessionToken?: boolean;
  userProvideBearerToken?: boolean;
}) => {
  const methods = useForm({
    defaultValues: {
      apiKey: '',
      baseURL: '',
      azureOpenAIApiKey: '',
      azureOpenAIApiInstanceName: '',
      azureOpenAIApiDeploymentName: '',
      azureOpenAIApiVersion: '',
      bedrockAccessKeyId: '',
      bedrockSecretAccessKey: '',
      bedrockSessionToken: '',
      bedrockBearerToken: '',
      // TODO: allow endpoint definitions from user
      // name: '',
      // TODO: add custom endpoint models defined by user
      // models: '',
    },
  });

  const [userKey, setUserKey] = useState('');
  const [isFirstRender, setIsFirstRender] = useState(true);
  const [expiresAtLabel, setExpiresAtLabel] = useState(EXPIRY.NEVER.label);
  const isOpenRouter = isOpenRouterEndpoint(endpoint);
  const watchedApiKey = methods.watch('apiKey');
  const openRouterKeyValue = isOpenRouter ? (watchedApiKey ?? '').trim() : '';
  const isOpenRouterKeyValid = isOpenRouter ? isValidOpenRouterKey(openRouterKeyValue) : true;
  const { getExpiry, saveUserKey } = useUserKey(endpoint);
  const { showToast } = useToastContext();
  const localize = useLocalize();
  const { setCurrentKey, hasCurrentKey, errorOpenrouterKey } = useCurrentKey();
  useEffect(() => {
    if (!isFirstRender) {
      setCurrentKey();
    } else {
      setIsFirstRender(false);
    }
  }, [getExpiry]);

  const expirationOptions = Object.values(EXPIRY);
  const configuredEndpoint = endpointType ?? endpoint;

  const handleExpirationChange = (label: string) => {
    setExpiresAtLabel(label);
  };

  const submit = () => {
    const selectedOption = expirationOptions.find((option) => option.label === expiresAtLabel);
    let expiresAt: number | null;

    if (selectedOption?.value === 0) {
      expiresAt = null;
    } else {
      expiresAt = Date.now() + (selectedOption ? selectedOption.value : 0);
    }

    const saveKey = (key: string) => {
      saveUserKey(key, expiresAt, {
        onSuccess: () => {
          showToast({
            message: localize('com_ui_save_key_success'),
            status: NotificationSeverity.SUCCESS,
          });
          onOpenChange(false);
        },
        onError: (error) => {
          logger.error('Error saving user key:', error);
          showToast({
            message: localize('com_ui_save_key_error'),
            status: NotificationSeverity.ERROR,
          });
        },
      });
    };

    if (formSet.has(endpoint) || formSet.has(endpointType ?? '')) {
      // TODO: handle other user provided options besides baseURL and apiKey
      methods.handleSubmit((data) => {
        const isAzure = configuredEndpoint === EModelEndpoint.azureOpenAI;
        const isBedrock = configuredEndpoint === EModelEndpoint.bedrock;
        const isOpenAIBase =
          isAzure ||
          configuredEndpoint === EModelEndpoint.openAI ||
          isAssistantsEndpoint(configuredEndpoint);
        if (isAzure) {
          data.apiKey = 'n/a';
        }

        const emptyValues = Object.keys(data).filter((key) => {
          if (!isAzure && key.startsWith('azure')) {
            return false;
          }
          if (!isBedrock && key.startsWith('bedrock')) {
            return false;
          }
          if (isOpenAIBase && key === 'baseURL') {
            return false;
          }
          if (key === 'baseURL' && !(userProvideURL ?? false)) {
            return false;
          }
          return data[key] === '';
        });

        if (isBedrock) {
          const bearerToken = userProvideBearerToken ? data.bedrockBearerToken?.trim() : '';
          const accessKeyId = userProvideAccessKeyId ? data.bedrockAccessKeyId?.trim() : '';
          const secretAccessKey = userProvideSecretAccessKey
            ? data.bedrockSecretAccessKey?.trim()
            : '';
          const sessionToken = userProvideSessionToken ? data.bedrockSessionToken?.trim() : '';
          const accessKeyIdLabel = localize('com_endpoint_config_bedrock_access_key_id');
          const secretAccessKeyLabel = localize('com_endpoint_config_bedrock_secret_access_key');
          const sessionTokenLabel = localize('com_endpoint_config_bedrock_session_token');
          const bearerTokenLabel = localize('com_endpoint_config_bedrock_bearer_token');
          const canSubmitBearerToken = !!bearerToken;
          const hasUserProvidedAccessKeyAuth =
            !!userProvideAccessKeyId || !!userProvideSecretAccessKey || !!userProvideSessionToken;
          const missingFields = [
            !canSubmitBearerToken && !hasUserProvidedAccessKeyAuth && userProvideBearerToken
              ? bearerTokenLabel
              : '',
            !canSubmitBearerToken && userProvideAccessKeyId && !accessKeyId ? accessKeyIdLabel : '',
            !canSubmitBearerToken && userProvideSecretAccessKey && !secretAccessKey
              ? secretAccessKeyLabel
              : '',
            !canSubmitBearerToken && userProvideSessionToken && !sessionToken
              ? sessionTokenLabel
              : '',
          ].filter(Boolean);

          if (!canSubmitBearerToken && missingFields.length > 0) {
            showToast({
              message: `${localize('com_endpoint_config_required_fields')} ${missingFields.join(', ')}`,
              status: NotificationSeverity.ERROR,
            });
            onOpenChange(true);
            return;
          }

          if (!canSubmitBearerToken && !hasUserProvidedAccessKeyAuth) {
            showToast({
              message: localize('com_endpoint_config_bedrock_credentials_required'),
              status: NotificationSeverity.ERROR,
            });
            onOpenChange(true);
            return;
          }
        } else if (emptyValues.length > 0) {
          showToast({
            message: `${localize('com_endpoint_config_required_fields')} ${emptyValues.join(', ')}`,
            status: NotificationSeverity.ERROR,
          });
          onOpenChange(true);
          return;
        }

        const {
          apiKey,
          baseURL,
          bedrockAccessKeyId,
          bedrockSecretAccessKey,
          bedrockSessionToken,
          bedrockBearerToken,
          ...azureOptions
        } = data;
        const userProvidedData = { apiKey, baseURL };
        if (isAzure) {
          userProvidedData.apiKey = JSON.stringify({
            azureOpenAIApiKey: azureOptions.azureOpenAIApiKey,
            azureOpenAIApiInstanceName: azureOptions.azureOpenAIApiInstanceName,
            azureOpenAIApiDeploymentName: azureOptions.azureOpenAIApiDeploymentName,
            azureOpenAIApiVersion: azureOptions.azureOpenAIApiVersion,
          });
        } else if (isBedrock) {
          const bearerToken = userProvideBearerToken ? bedrockBearerToken.trim() : '';
          const accessKeyId = userProvideAccessKeyId ? bedrockAccessKeyId.trim() : '';
          const secretAccessKey = userProvideSecretAccessKey ? bedrockSecretAccessKey.trim() : '';
          const sessionToken = userProvideSessionToken ? bedrockSessionToken.trim() : '';

          if (bearerToken) {
            userProvidedData.apiKey = JSON.stringify({
              bearerToken,
            });
          } else {
            userProvidedData.apiKey = JSON.stringify({
              ...(accessKeyId && { accessKeyId }),
              ...(secretAccessKey && { secretAccessKey }),
              ...(sessionToken && { sessionToken }),
            });
          }
        }

        saveKey(JSON.stringify(userProvidedData));
        methods.reset();
      })();
      return;
    }

    if (!userKey.trim()) {
      showToast({
        message: localize('com_ui_key_required'),
        status: NotificationSeverity.ERROR,
      });
      return;
    }

    saveKey(userKey);
    setUserKey('');
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter') {
      return;
    }
    event.preventDefault();
    if (isOpenRouter && !isOpenRouterKeyValid) {
      return;
    }
    submit();
  };

  const EndpointComponent = endpointComponents[configuredEndpoint] ?? endpointComponents['default'];
  const expiryTime = getExpiry();

  return (
    <OGDialog open={open} onOpenChange={onOpenChange}>
      <OGDialogContent className="w-11/12 max-w-2xl">
        <OGDialogHeader>
          <OGDialogTitle>
            {`${localize('com_endpoint_config_key_for')} ${alternateName[endpoint] ?? endpoint}`}
          </OGDialogTitle>
        </OGDialogHeader>
        <div className="grid w-full items-center gap-2 py-4">
          {/* <small className="text-red-600">
            {expiryTime === 'never'
              ? localize('com_endpoint_config_key_never_expires')
              : `${localize('com_endpoint_config_key_encryption')} ${new Date(
                  expiryTime ?? 0,
                ).toLocaleString()}`}
          </small>
          <Dropdown
            label="Expires "
            value={expiresAtLabel}
            onChange={handleExpirationChange}
            options={expirationOptions.map((option) => option.label)}
            sizeClasses="w-[185px]"
            portal={false}
          /> */}
          {/* закоментирован выбор срока использования openrouter ключа по умолчанию бессрочный(never) */}
          <div className="mt-2" />
          <FormProvider {...methods}>
            <div onKeyDown={handleKeyDown}>
              <EndpointComponent
                userKey={userKey}
                endpoint={endpoint}
                setUserKey={setUserKey}
                userProvideURL={userProvideURL}
                userProvideAccessKeyId={userProvideAccessKeyId}
                userProvideSecretAccessKey={userProvideSecretAccessKey}
                userProvideSessionToken={userProvideSessionToken}
                userProvideBearerToken={userProvideBearerToken}
              />
            </div>
          </FormProvider>
          <HelpText endpoint={endpoint} />
          {errorOpenrouterKey && <div className="text-text-destructive">{errorOpenrouterKey}</div>}
          {!errorOpenrouterKey &&
            isOpenRouter &&
            openRouterKeyValue.length > 0 &&
            !isOpenRouterKeyValid && (
              <div className="text-text-destructive">
                Ключ не похож на OpenRouter ключ (ожидается формат sk-or-…)
              </div>
            )}
          {!errorOpenrouterKey && (!isOpenRouter || isOpenRouterKeyValid) && (
            <div className="text-[var(--additional-text-purple)]">Валидный OpenRouter ключ</div>
          )}
        </div>
        <div className="flex justify-end gap-[8px]">
          <div className="w-150px">
            <RevokeKeysButton
              endpoint={endpoint}
              disabled={!(expiryTime ?? '') || !!errorOpenrouterKey}
              setDialogOpen={onOpenChange}
            />
          </div>
          <div className="w-150px">
            <Button
              variant="submit"
              onClick={submit}
              disabled={isOpenRouter && !isOpenRouterKeyValid}
              className="bg-[var(--bg-send-button)] hover:bg-[var(--bg-send-button-hover)]"
            >
              {localize('com_ui_submit')}
            </Button>
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
};

export default SetKeyDialog;
