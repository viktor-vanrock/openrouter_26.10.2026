import { z } from 'zod';
import type { TModelSpecPreset } from './schemas';
import {
  EModelEndpoint,
  tModelSpecPresetSchema,
  eModelEndpointSchema,
  AuthType,
  authTypeSchema,
} from './schemas';

export const WEB_SEARCH_CAPABLE_MODELS = [
  'perplexity/sonar',
  'perplexity/sonar-pro',
  'perplexity/sonar-reasoning',
  'perplexity/sonar-reasoning-pro',
  'openai/gpt-4o-search-preview',
  'openai/gpt-4o-mini-search-preview',
  'google/gemini-2.0-flash-001',
  'google/gemini-2.0-pro-exp-02-05',
] as const;

export const DEFAULT_WEB_SEARCH_MODEL = 'perplexity/sonar';

export interface ModelInfo {
  id: string;
  supported_parameters?: string[];
}

export function filterToolsCapableModels(models: ModelInfo[]): ModelInfo[] {
  return models.filter(isToolsCapableModel);
}

export function isToolsCapableModel(model: ModelInfo): boolean {
  return Boolean(
    model.supported_parameters?.includes('tools') ||
      model.supported_parameters?.includes('function_calling'),
  );
}

const webSearchCapableModelIds = new Set<string>(WEB_SEARCH_CAPABLE_MODELS);

export const supportsNativeWebSearch = (model?: string | null): boolean =>
  model != null && webSearchCapableModelIds.has(model);

export const filterWebSearchCapableModels = (models: string[]): string[] =>
  models.filter(supportsNativeWebSearch);

export type TModelSpec = {
  name: string;
  label: string;
  preset: TModelSpecPreset;
  order?: number;
  default?: boolean;
  description?: string;
  /**
   * Optional group name for organizing specs in the UI selector.
   * - If it matches an endpoint name (e.g., "openAI", "groq"), the spec appears nested under that endpoint
   * - If it's a custom name (doesn't match any endpoint), it creates a separate collapsible group
   * - If omitted, the spec appears as a standalone item at the top level
   */
  group?: string;
  /**
   * Optional icon URL for the group this spec belongs to.
   * Only needs to be set on one spec per group - the first one found with a groupIcon will be used.
   * Can be a URL or an endpoint name to use its icon.
   */
  groupIcon?: string | EModelEndpoint;
  showIconInMenu?: boolean;
  showIconInHeader?: boolean;
  iconURL?: string | EModelEndpoint; // Allow using project-included icons
  authType?: AuthType;
  /** Hide the chat input tool badge row while this model spec is active. */
  hideBadgeRow?: boolean;
  webSearch?: boolean;
  fileSearch?: boolean;
  executeCode?: boolean;
  artifacts?: string | boolean;
  mcpServers?: string[];
};

export const tModelSpecSchema = z.object({
  name: z.string(),
  label: z.string(),
  preset: tModelSpecPresetSchema,
  order: z.number().optional(),
  default: z.boolean().optional(),
  description: z.string().optional(),
  group: z.string().optional(),
  groupIcon: z.union([z.string(), eModelEndpointSchema]).optional(),
  showIconInMenu: z.boolean().optional(),
  showIconInHeader: z.boolean().optional(),
  iconURL: z.union([z.string(), eModelEndpointSchema]).optional(),
  authType: authTypeSchema.optional(),
  hideBadgeRow: z.boolean().optional(),
  webSearch: z.boolean().optional(),
  fileSearch: z.boolean().optional(),
  executeCode: z.boolean().optional(),
  artifacts: z.union([z.string(), z.boolean()]).optional(),
  mcpServers: z.array(z.string()).optional(),
});

export const specsConfigSchema = z.object({
  enforce: z.boolean().default(false),
  prioritize: z.boolean().default(true),
  list: z.array(tModelSpecSchema).default([]),
  addedEndpoints: z.array(z.union([z.string(), eModelEndpointSchema])).optional(),
});

export type TSpecsConfig = z.infer<typeof specsConfigSchema>;
