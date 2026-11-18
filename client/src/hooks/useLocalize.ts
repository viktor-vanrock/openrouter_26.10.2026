import { useCallback } from 'react';
import { TOptions } from 'i18next';
import { useTranslation } from 'react-i18next';
import { withChatRouterBrand } from '~/utils/brand';
import translationEn from '~/locales/en/translation.json';

export type TranslationKeys = keyof typeof translationEn;

export default function useLocalize() {
  const { t } = useTranslation();

  return useCallback(
    (phraseKey: TranslationKeys, options?: TOptions) => withChatRouterBrand(t(phraseKey, options)),
    [t],
  );
}
