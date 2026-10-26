import mongoose from 'mongoose';
import type { Response } from 'express';
import type { ServerRequest } from '~/types/http.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

class LogsController {
  async getLogs(req: ServerRequest, res: Response): Promise<void> {
    const db = mongoose.connection.db;
    if (!db || mongoose.connection.readyState !== 1) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }

    const {
      level,
      search,
      from,
      to,
      page = '1',
      limit: limitParam = String(DEFAULT_LIMIT),
    } = req.query as Record<string, string>;

    const filter: Record<string, unknown> = {};

    if (level) {
      filter.level = level;
    }

    if (search) {
      filter.message = { $regex: search, $options: 'i' };
    }

    if (from || to) {
      filter.timestamp = {
        ...(from ? { $gte: new Date(from) } : {}),
        ...(to ? { $lte: new Date(to) } : {}),
      };
    }

    const limit = Math.min(parseInt(limitParam, 10) || DEFAULT_LIMIT, MAX_LIMIT);
    const skip = (Math.max(parseInt(page, 10) || 1, 1) - 1) * limit;

    const [logs, total] = await Promise.all([
      db.collection('app_logs').find(filter).sort({ timestamp: -1 }).skip(skip).limit(limit).toArray(),
      db.collection('app_logs').countDocuments(filter),
    ]);

    res.json({
      total,
      page: parseInt(page, 10) || 1,
      limit,
      pages: Math.ceil(total / limit),
      logs,
    });
  }

  async deleteLogs(req: ServerRequest, res: Response): Promise<void> {
    const db = mongoose.connection.db;
    if (!db || mongoose.connection.readyState !== 1) {
      res.status(503).json({ error: 'Database not connected' });
      return;
    }

    const { before } = req.query as Record<string, string>;
    const filter: Record<string, unknown> = {};

    if (before) {
      filter.timestamp = { $lt: new Date(before) };
    }

    const result = await db.collection('app_logs').deleteMany(filter);
    res.json({ deleted: result.deletedCount });
  }
}

export default new LogsController();
