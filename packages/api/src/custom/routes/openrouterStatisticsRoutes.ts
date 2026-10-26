import express from 'express';
import OpenRouterStatisticsController from '../controllers/openrouterStatisticsController';
import type { ServerRequest } from '~/types/http.js';

const router = express.Router();

router.get('/balance', async (req, res) => {
  await OpenRouterStatisticsController.getBalance(req as unknown as ServerRequest, res);
});

export default router;