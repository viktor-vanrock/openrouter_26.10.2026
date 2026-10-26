import { Response } from 'express';
import openrouterBalanceService from '../services/openRouterStatisticsService.js';
import type { ServerRequest } from '~/types/http.js';
import { getUserOpenRouterKey } from './utils.js';
import { AppError, logger } from '../utils.js';

class OpenRouterStatisticsController {
  async getBalance(req: ServerRequest, res: Response): Promise<void> {
    const userId = req.user?.id;

      try {
        
        if (!userId) {
          throw new AppError(
            'OpenRouter ╨║╨╗╤О╤З ╨╜╨╡ ╨╜╨░╨╣╨┤╨╡╨╜.',
            400,
            'OPENROUTER_KEY_NOT_FOUND'
          );
        }

      const openRouterKey = await getUserOpenRouterKey(userId);
      
      if (!openRouterKey) {
        throw new AppError(
          'OpenRouter ключ не найден.',
          400,
          'OPENROUTER_KEY_NOT_FOUND'
        );
      }

      const statistics = await openrouterBalanceService.getBalance(openRouterKey);

      res.json({
        data: statistics,
      });
      
    } catch (error) {
      if (error instanceof AppError) {
        logger.warn('[OpenRouter] ' + error.message, { meta: { code: error.code, userId } });
        res.status(error.statusCode).json({
          success: false,
          error: error.message,
        });
        return;
      }

      logger.error('[OpenRouter] Неожиданная ошибка', { meta: { error, userId } });
      res.status(500).json({
        success: false,
        error: 'Внутренняя ошибка сервера'
      });
    }
  }
}

export default new OpenRouterStatisticsController();