import { useCallback, useRef, useState } from 'react';
import {
  BookOpen,
  Check,
  ChevronDown,
  CirclePlay,
  FileText,
  FlaskConical,
  Plus,
  Search,
  Settings,
  Wrench,
  X,
  Zap,
} from 'lucide-react';
import {
  OGDialog,
  OGDialogClose,
  OGDialogContent,
  OGDialogTitle,
  TooltipAnchor,
} from '@librechat/client';
import type { LucideIcon } from 'lucide-react';
import type { TranslationKeys } from '~/hooks/useLocalize';
import { useLocalize } from '~/hooks';
import { cn } from '~/utils';

type SectionId =
  | 'what-is-agent'
  | 'create-agent'
  | 'instructions'
  | 'web-search'
  | 'tools'
  | 'skills'
  | 'files'
  | 'advanced'
  | 'usage'
  | 'parameters';

interface DocumentationSection {
  id: SectionId;
  titleKey: TranslationKeys;
  icon: LucideIcon;
}

const sections: DocumentationSection[] = [
  { id: 'what-is-agent', titleKey: 'com_documentation_section_what_is_agent', icon: BookOpen },
  { id: 'create-agent', titleKey: 'com_documentation_section_create_agent', icon: Plus },
  { id: 'instructions', titleKey: 'com_documentation_section_instructions', icon: FileText },
  { id: 'parameters', titleKey: 'com_documentation_section_parameters', icon: Settings },
  { id: 'web-search', titleKey: 'com_documentation_section_web_search', icon: Search },
  { id: 'tools', titleKey: 'com_documentation_section_tools', icon: Wrench },
  { id: 'skills', titleKey: 'com_documentation_section_skills', icon: Zap },
  { id: 'files', titleKey: 'com_documentation_section_files', icon: FileText },
  { id: 'advanced', titleKey: 'com_documentation_section_advanced', icon: FlaskConical },
  { id: 'usage', titleKey: 'com_documentation_section_usage', icon: CirclePlay },
];

const contentKeys: Record<SectionId, TranslationKeys> = {
  'what-is-agent': 'com_documentation_content_what_is_agent',
  'create-agent': 'com_documentation_content_create_agent',
  instructions: 'com_documentation_content_instructions',
  'web-search': 'com_documentation_content_web_search',
  tools: 'com_documentation_content_tools',
  skills: 'com_documentation_content_skills',
  files: 'com_documentation_content_files',
  advanced: 'com_documentation_content_advanced',
  usage: 'com_documentation_content_usage',
  parameters: 'com_documentation_content_parameters',
};

const parameterKeys = [
  'provider',
  'model',
  'context_tokens',
  'output_tokens',
  'temperature',
  'top_p',
  'frequency_penalty',
  'presence_penalty',
  'stop_sequences',
  'resend_files',
  'image_detail',
  'reasoning_effort',
  'reasoning_summary',
  'verbosity',
  'responses_api',
  'web_search',
  'disable_streaming',
  'file_token_limit',
  'prompt_caching',
  'reset',
] as const;

export default function DocumentationModal() {
  const localize = useLocalize();
  const [open, setOpen] = useState(false);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionId>('what-is-agent');
  const contentRef = useRef<HTMLDivElement>(null);
  const sectionRefs = useRef<Partial<Record<SectionId, HTMLElement | null>>>({});

  const selectSection = useCallback((sectionId: SectionId) => {
    setActiveSection(sectionId);
    setMobileMenuOpen(false);
    sectionRefs.current[sectionId]?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, []);

  const handleScroll = useCallback(() => {
    const containerTop = contentRef.current?.getBoundingClientRect().top ?? 0;
    let closestSection = sections[0].id;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (const section of sections) {
      const element = sectionRefs.current[section.id];
      if (!element) {
        continue;
      }
      const distance = Math.abs(element.getBoundingClientRect().top - containerTop - 16);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestSection = section.id;
      }
    }
    setActiveSection(closestSection);
  }, []);

  return (
    <OGDialog open={open} onOpenChange={setOpen}>
      <TooltipAnchor
        side="right"
        description={localize('com_documentation_tooltip')}
        render={
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label={localize('com_documentation_tooltip')}
            className="flex h-9 w-9 items-center justify-center rounded-lg p-2 text-text-primary transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-600"
          >
            <BookOpen className="h-5 w-5" aria-hidden="true" />
          </button>
        }
      />
      <OGDialogContent
        className="h-[85vh] w-[90vw] max-w-[1100px] overflow-hidden border-border-light bg-surface-primary p-0"
        showCloseButton={false}
      >
        <div className="flex h-full min-h-0 flex-col">
          <header className="flex shrink-0 items-center justify-between border-b border-border-light px-5 py-4">
            <OGDialogTitle className="flex items-center gap-2 text-2xl">
              <BookOpen className="h-5 w-5" aria-hidden="true" />
              {localize('com_documentation_title')}
            </OGDialogTitle>
            <OGDialogClose
              className="flex h-9 w-9 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-surface-hover hover:text-text-primary"
              aria-label={localize('com_ui_close')}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </OGDialogClose>
          </header>

          <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
            <nav
              className="hidden shrink-0 gap-1 overflow-y-auto border-border-light bg-surface-primary-alt p-3 sm:flex sm:w-60 sm:flex-col sm:border-r"
              aria-label={localize('com_documentation_title')}
            >
              {sections.map(({ id, titleKey, icon: Icon }) => (
                <button
                  key={id}
                  type="button"
                  onClick={() => selectSection(id)}
                  aria-current={activeSection === id ? 'true' : undefined}
                  className={cn(
                    'flex shrink-0 items-center gap-2 rounded-lg px-3 py-2 text-left text-lg transition-colors sm:w-full',
                    activeSection === id
                      ? 'bg-surface-active-alt font-medium text-text-primary'
                      : 'text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                  )}
                >
                  <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>{localize(titleKey)}</span>
                </button>
              ))}
            </nav>

            <div className="relative z-[200] shrink-0 border-b border-border-light bg-surface-primary-alt p-3 sm:hidden">
              {(() => {
                const active = sections.find(({ id }) => id === activeSection) ?? sections[0];
                const Icon = active.icon;
                return (
                  <>
                    <button
                      type="button"
                      onClick={() => setMobileMenuOpen((isMenuOpen) => !isMenuOpen)}
                      className="flex w-full items-center gap-2 rounded-lg bg-surface-active-alt px-3 py-2 text-left text-lg font-medium text-text-primary"
                      aria-label={localize('com_documentation_title')}
                      aria-expanded={mobileMenuOpen}
                    >
                      <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate">{localize(active.titleKey)}</span>
                      <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                    </button>
                    {mobileMenuOpen && (
                      <div
                        role="menu"
                        aria-label={localize('com_documentation_title')}
                        className="absolute left-3 right-3 top-[calc(100%-0.25rem)] z-[210] max-h-[60vh] overflow-y-auto rounded-lg border border-border-light bg-surface-primary p-1 shadow-lg"
                      >
                        {sections.map(({ id, titleKey, icon: SectionIcon }) => (
                          <button
                            key={id}
                            type="button"
                            role="menuitemradio"
                            aria-checked={activeSection === id}
                            onClick={() => selectSection(id)}
                            className={cn(
                              'flex w-full items-center gap-2 rounded-md px-3 py-2 text-left text-base text-text-secondary hover:bg-surface-hover hover:text-text-primary',
                              activeSection === id &&
                                'bg-surface-active-alt font-medium text-text-primary',
                            )}
                          >
                            <SectionIcon className="h-4 w-4 shrink-0" aria-hidden="true" />
                            <span className="flex-1">{localize(titleKey)}</span>
                            {activeSection === id && (
                              <Check className="h-4 w-4" aria-hidden="true" />
                            )}
                          </button>
                        ))}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>

            <div
              ref={contentRef}
              onScroll={handleScroll}
              className="min-h-0 min-w-[400px] flex-1 overflow-y-auto scroll-smooth px-6 py-5"
            >
              {sections.map(({ id, titleKey, icon: Icon }) => (
                <section
                  key={id}
                  ref={(element) => {
                    sectionRefs.current[id] = element;
                  }}
                  className="mb-10 scroll-mt-4 last:mb-4"
                  aria-labelledby={`documentation-${id}`}
                >
                  <h2
                    id={`documentation-${id}`}
                    className="mb-4 flex items-center gap-2 text-[22px] font-semibold text-text-primary"
                  >
                    <Icon className="h-5 w-5" aria-hidden="true" />
                    {localize(titleKey)}
                  </h2>
                  {id === 'parameters' ? (
                    <div className="space-y-7 text-lg leading-8 text-text-secondary">
                      {parameterKeys.map((parameter) => {
                        const title =
                          `com_documentation_parameter_${parameter}_title` as TranslationKeys;
                        const content =
                          `com_documentation_parameter_${parameter}_content` as TranslationKeys;
                        return (
                          <div key={parameter}>
                            <h3 className="mb-2 text-xl font-semibold text-text-primary">
                              {localize(title)}
                            </h3>
                            <div className="whitespace-pre-line">{localize(content)}</div>
                          </div>
                        );
                      })}
                    </div>
                  ) : id === 'advanced' ? (
                    <div className="space-y-5 text-lg leading-8 text-text-secondary">
                      <div className="rounded-lg border border-yellow-500/40 bg-yellow-500/10 px-4 py-3 text-text-primary">
                        <strong>⚠️ {localize('com_documentation_advanced_beta_warning')}</strong>
                      </div>
                      <div className="whitespace-pre-line">{localize(contentKeys[id])}</div>
                    </div>
                  ) : (
                    <div className="whitespace-pre-line text-lg leading-8 text-text-secondary">
                      {localize(contentKeys[id])}
                    </div>
                  )}
                </section>
              ))}
            </div>
          </div>
        </div>
      </OGDialogContent>
    </OGDialog>
  );
}
