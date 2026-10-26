import express from 'express';
import LogsController from '../controllers/logsController.js';
import type { ServerRequest } from '~/types/http.js';

const router = express.Router();

// GET /api/admin/logs?level=error&search=OpenRouter&from=2026-07-01&to=2026-07-07&page=1&limit=50
router.get('/', async (req, res) => {
  await LogsController.getLogs(req as unknown as ServerRequest, res);
});

// DELETE /api/admin/logs?before=2026-07-01  (удалить старые записи)
router.delete('/', async (req, res) => {
  await LogsController.deleteLogs(req as unknown as ServerRequest, res);
});

export default router;
