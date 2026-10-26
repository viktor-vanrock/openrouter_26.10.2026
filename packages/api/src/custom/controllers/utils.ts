import mongoose from 'mongoose';
import { createMethods } from '@librechat/data-schemas';
import type { AllMethods } from '@librechat/data-schemas';
import { AppError, logger } from '../utils';

export async function resolveOpenRouterCredential(
  db: Pick<AllMethods, 'getUserKeyValues'>,
  userId: string,
): Promise<string> {
  const values = await db.getUserKeyValues({ userId, name: 'OpenRouter' });
  if (typeof values.apiKey !== 'string' || values.apiKey.length === 0) {
    throw new AppError('OpenRouter key not found', 400, 'OPENROUTER_KEY_NOT_FOUND');
  }

  return values.apiKey;
}

export async function getUserOpenRouterKey(userId: string): Promise<string | null> {
  try {
    return await resolveOpenRouterCredential(createMethods(mongoose), userId);
  } catch (error) {
    if (error instanceof AppError && error.code === 'OPENROUTER_KEY_NOT_FOUND') {
      return null;
    }

    logger.error('[OpenRouter] Unable to resolve credential', { meta: { userId } });
    return null;
  }
}
