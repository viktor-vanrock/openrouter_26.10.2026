import { memo, useContext, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useRecoilValue } from 'recoil';
import { BookOpen, Settings, X } from 'lucide-react';
import { ThemeContext, useMediaQuery } from '@librechat/client';
import { getConfigDefaults, PermissionTypes, Permissions } from 'librechat-data-provider';
import ModelSelector from './Menus/Endpoints/ModelSelector';
import { useGetStartupConfig } from '~/data-provider';
import ExportAndShareMenu from './ExportAndShareMenu';
import { OpenSidebar, PresetsMenu } from './Menus';
import BookmarkMenu from './Menus/BookmarkMenu';
import { TemporaryChat } from './TemporaryChat';
import AddMultiConvo from './AddMultiConvo';
import { useHasAccess } from '~/hooks';
import { cn } from '~/utils';
import { hasDevelopingCookie } from '~/utils/developingCookie';
import store from '~/store';
import { OpenrouterButton } from '../OpenrouterButton';
import { CurrentKeyProvider } from '~/Providers';

import { ModelSelectorProvider } from './Menus/Endpoints/ModelSelectorContext';
import { ModelSelectorChatProvider } from './Menus/Endpoints/ModelSelectorChatContext';
import { SettingOpenrouterKeyButton } from '../SettingOpenrouterKeyButton';
import { MobileAccordionPanel } from './MobileAccordionPanel';
import ReleasesButton from '~/components/Releases/ReleasesButton';

const defaultInterface = getConfigDefaults().interface;
const GUIDE_VISITED_KEY = 'chatrouter:guide-visited';

function GuideHeaderActions({
  compact = false,
  showGuide,
  inMenu = false,
  onMenuClose,
}: {
  compact?: boolean;
  showGuide: boolean;
  inMenu?: boolean;
  onMenuClose?: () => void;
}) {
  const [guideVisited, setGuideVisited] = useState(() => {
    try {
      return window.localStorage.getItem(GUIDE_VISITED_KEY) === '1';
    } catch {
      return false;
    }
  });

  const markGuideVisited = () => {
    setGuideVisited(true);
    try {
      window.localStorage.setItem(GUIDE_VISITED_KEY, '1');
    } catch {
      // Browsers may disable local storage; the current page still updates.
    }
  };

  if (inMenu) {
    return (
      <>
        {showGuide && (
          <div className="flex min-h-[60px] items-center border-b border-border-light px-4">
            <Link
              to="/guide"
              onClick={() => {
                markGuideVisited();
                onMenuClose?.();
              }}
              className="flex h-[50px] w-full items-center text-text-primary"
            >
              Руководство
            </Link>
          </div>
        )}
        {showGuide && (
          <div className="flex min-h-[60px] items-center border-b border-border-light px-4">
            <ReleasesButton inMenu />
          </div>
        )}
      </>
    );
  }

  return (
    <div className="flex shrink-0 items-center gap-2">
      {showGuide && (
        <Link
          to="/guide"
          onClick={markGuideVisited}
          className={cn(
            'inline-flex h-9 shrink-0 items-center gap-2 rounded-[30px] border px-3 text-sm font-semibold transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-red-600',
            guideVisited
              ? 'border-border-light bg-surface-primary text-text-primary hover:bg-surface-hover'
              : 'guide-button-unvisited attention-button-shadow border-red-700 bg-red-700 text-white hover:bg-red-800',
          )}
          aria-label="Как пользоваться ChatRouter"
        >
          <BookOpen className="h-4 w-4" aria-hidden="true" />
          <span className="hidden min-[1200px]:inline">Как пользоваться ChatRouter</span>
          <span className="min-[1200px]:hidden">Руководство</span>
          {!guideVisited && (
            <span className="rounded-full bg-white/20 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide">
              Новое
            </span>
          )}
        </Link>
      )}
      {showGuide && <ReleasesButton compact={compact} />}
    </div>
  );
}

function Header() {
  const { data: startupConfig } = useGetStartupConfig();
  const navVisible = useRecoilValue(store.sidebarExpanded);
  const { theme } = useContext(ThemeContext);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const interfaceConfig = useMemo(
    () => startupConfig?.interface ?? defaultInterface,
    [startupConfig],
  );

  const hasAccessToBookmarks = useHasAccess({
    permissionType: PermissionTypes.BOOKMARKS,
    permission: Permissions.USE,
  });

  const hasAccessToMultiConvo = useHasAccess({
    permissionType: PermissionTypes.MULTI_CONVO,
    permission: Permissions.USE,
  });

  const hasAccessToTemporaryChat = useHasAccess({
    permissionType: PermissionTypes.TEMPORARY_CHAT,
    permission: Permissions.USE,
  });

  const isSmallScreen = useMediaQuery('(max-width: 768px)');
  const showActionsInMenu = useMediaQuery('(max-width: 640px)');
  const sberLogoSrc = theme === 'dark' ? 'assets/sberLogoWhite.png' : 'assets/sberLogo.png';
  const isNeedShareMenu = false;
  const showDevelopingActions = hasDevelopingCookie();

  return (
    <div className="via-presentation/70 md:from-presentation/80 md:via-presentation/50 2xl:from-presentation/0 absolute top-0 z-10 flex h-[52px] w-full items-center justify-between border-b bg-presentation from-presentation to-transparent p-2 font-semibold text-text-primary 2xl:via-transparent">
      <div className="hide-scrollbar flex w-full items-center justify-between gap-2 overflow-x-auto">
        <div className="mx-1 flex items-center">
          <OpenSidebar className="md:hidden" />
          {isSmallScreen && !showActionsInMenu && showDevelopingActions && (
            <GuideHeaderActions compact showGuide={showDevelopingActions} />
          )}
          {!(navVisible && isSmallScreen) && (
            <div
              className={cn(
                'flex items-center gap-2 pl-2',
                !isSmallScreen ? 'transition-all duration-200 ease-in-out' : '',
              )}
            >
              <CurrentKeyProvider>
                <ModelSelectorChatProvider>
                  <ModelSelectorProvider startupConfig={startupConfig}>
                    <img src={sberLogoSrc} alt={`sber logo Icon`} className="w-20" />
                    <ModelSelector startupConfig={startupConfig} />
                    {isSmallScreen ? (
                      <>
                        <button
                          onClick={() => setMobileMenuOpen((v) => !v)}
                          className={cn(
                            'flex h-10 w-20 items-center justify-center rounded-xl border border-border-light bg-white text-gray-700 transition-colors hover:bg-gray-100 active:bg-gray-200',
                            mobileMenuOpen && 'bg-gray-100',
                          )}
                          aria-label="Настройки"
                        >
                          {mobileMenuOpen ? <X size={22} /> : <Settings size={22} />}
                        </button>
                        <MobileAccordionPanel
                          open={mobileMenuOpen}
                          onClose={() => setMobileMenuOpen(false)}
                          interfaceConfig={interfaceConfig}
                          hasAccessToBookmarks={hasAccessToBookmarks === true}
                          hasAccessToMultiConvo={hasAccessToMultiConvo === true}
                          hasAccessToTemporaryChat={hasAccessToTemporaryChat === true}
                          startupConfig={startupConfig}
                          isNeedShareMenu={isNeedShareMenu}
                          guideActions={
                            showActionsInMenu && showDevelopingActions ? (
                              <GuideHeaderActions
                                showGuide={showDevelopingActions}
                                inMenu
                                onMenuClose={() => setMobileMenuOpen(false)}
                              />
                            ) : null
                          }
                        />
                      </>
                    ) : (
                      <>
                        {interfaceConfig.presets === true && interfaceConfig.modelSelect && (
                          <PresetsMenu />
                        )}
                        {hasAccessToBookmarks === true && <BookmarkMenu />}
                        {hasAccessToMultiConvo === true && <AddMultiConvo />}
                        <OpenrouterButton />
                        <SettingOpenrouterKeyButton />
                      </>
                    )}
                  </ModelSelectorProvider>
                </ModelSelectorChatProvider>
              </CurrentKeyProvider>
            </div>
          )}
        </div>

        {!isSmallScreen && (
          <div className="flex items-center gap-2">
            {showDevelopingActions && <GuideHeaderActions showGuide={showDevelopingActions} />}
            <ExportAndShareMenu
              isSharedButtonEnabled={startupConfig?.sharedLinksEnabled ?? false}
            />
            {hasAccessToTemporaryChat === true && <TemporaryChat />}
          </div>
        )}
      </div>
      {/* Empty div for spacing */}
      <div />
    </div>
  );
}

const MemoizedHeader = memo(Header);
MemoizedHeader.displayName = 'Header';

export default MemoizedHeader;
