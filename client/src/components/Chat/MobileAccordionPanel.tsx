import { createPortal } from 'react-dom';
import { getConfigDefaults } from 'librechat-data-provider';
import { useGetStartupConfig } from '~/data-provider';
import ExportAndShareMenu from './ExportAndShareMenu';
import { PresetsMenu } from './Menus';
import BookmarkMenu from './Menus/BookmarkMenu';
import { TemporaryChat } from './TemporaryChat';
import AddMultiConvo from './AddMultiConvo';
import { cn } from '~/utils';
import { OpenrouterButton } from '../OpenrouterButton';
import { SettingOpenrouterKeyButton } from '../SettingOpenrouterKeyButton';

export function MobileAccordionPanel({
  open,
  onClose,
  interfaceConfig,
  hasAccessToBookmarks,
  hasAccessToMultiConvo,
  hasAccessToTemporaryChat,
  startupConfig,
  isNeedShareMenu,
}: {
  open: boolean;
  onClose: () => void;
  interfaceConfig: ReturnType<typeof getConfigDefaults>['interface'];
  hasAccessToBookmarks: boolean;
  hasAccessToMultiConvo: boolean;
  hasAccessToTemporaryChat: boolean;
  startupConfig: ReturnType<typeof useGetStartupConfig>['data'];
  isNeedShareMenu: boolean;
}) {
  return createPortal(
    <>
      {open && <div className="fixed inset-0 z-40 bg-black/20" onClick={onClose} />}
      <div
        className={cn(
          'fixed bottom-0 left-0 right-0 z-50 overflow-hidden transition-[max-height] duration-300 ease-in-out',
          open ? 'max-h-[600px]' : 'max-h-0',
        )}
      >
        <div className="flex flex-col border-t border-border-light bg-surface-primary text-text-primary shadow-xl">
          {interfaceConfig.presets === true && interfaceConfig.modelSelect && (
            <div
              className="flex min-h-[60px] items-center border-b border-border-light px-4"
              onClick={onClose}
            >
              <PresetsMenu />
            </div>
          )}
          {hasAccessToBookmarks === true && (
            <div
              className="flex min-h-[60px] items-center border-b border-border-light px-4"
              onClick={onClose}
            >
              <BookmarkMenu />
            </div>
          )}
          {hasAccessToMultiConvo === true && (
            <div
              className="flex min-h-[60px] items-center border-b border-border-light px-4"
              onClick={onClose}
            >
              <AddMultiConvo inNeedButton={false} />
            </div>
          )}
          <div
            className="flex min-h-[60px] items-center border-b border-border-light px-4"
            onClick={onClose}
          >
            <OpenrouterButton isNeedButton={false} />
          </div>
          {isNeedShareMenu && (
            <>
              <div
                className="flex min-h-[60px] items-center border-b border-border-light px-4"
                onClick={onClose}
              >
                <ExportAndShareMenu
                  isSharedButtonEnabled={startupConfig?.sharedLinksEnabled ?? false}
                />
              </div>
              {hasAccessToTemporaryChat === true && (
                <div
                  className="flex min-h-[60px] items-center border-b border-border-light px-4"
                  onClick={onClose}
                >
                  <TemporaryChat />
                </div>
              )}
            </>
          )}
          <div className="flex min-h-[60px] items-center px-4" onClick={onClose}>
            <SettingOpenrouterKeyButton isNeedButton={false} />
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
