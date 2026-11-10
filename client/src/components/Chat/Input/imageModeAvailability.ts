import { isImageOutputCapableModel, isToolsCapableModel } from 'librechat-data-provider';
import type { ModelInfo } from 'librechat-data-provider';

export function imageModeAvailability({
  developing,
  endpoint,
  model,
  metadata,
}: {
  developing: boolean;
  endpoint?: string | null;
  model?: string | null;
  metadata?: ModelInfo;
}) {
  const supportsTools = metadata != null && isToolsCapableModel(metadata);
  const outputsImage = metadata != null && isImageOutputCapableModel(metadata);
  return {
    eligible: developing && endpoint === 'OpenRouter' && !!model && !supportsTools && !outputsImage,
  };
}
