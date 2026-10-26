import winston from 'winston';
import mongoose from 'mongoose';
import TransportStream from 'winston-transport';
import DailyRotateFile from 'winston-daily-rotate-file';

export class AppError extends Error {
  constructor(
    message: string,
    public statusCode: number = 500,
    public code?: string
  ) {
    super(message);
    this.name = this.constructor.name;
    Error.captureStackTrace(this, this.constructor);
  }
}

const { NODE_ENV } = process.env;

const levels = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const level = (): string => {
  return NODE_ENV === 'production' ? 'warn' : 'debug';
};

const consoleFormat = winston.format.combine(
  winston.format.colorize({ all: true }),
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(
    (info) => `${info.timestamp} ${info.level}: ${info.message} ${
      info.meta ? JSON.stringify(info.meta) : ''
    }`
  ),
);

const fileFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.json(),
);

// Winston transport that writes to MongoDB via mongoose connection
class MongoTransport extends TransportStream {
  private collection: string;

  constructor(opts?: TransportStream.TransportStreamOptions & { collection?: string }) {
    super(opts);
    this.collection = opts?.collection ?? 'app_logs';
  }

  log(info: Record<string, unknown>, callback: () => void) {
    const db = mongoose.connection.db;
    if (!db || mongoose.connection.readyState !== 1) {
      callback();
      return;
    }

    const doc = {
      level: info['level'],
      message: info['message'],
      meta: info['meta'] ?? null,
      stack: info['stack'] ?? null,
      code: info['code'] ?? null,
      timestamp: new Date(),
    };

    db.collection(this.collection).insertOne(doc).catch(() => {
      // silently ignore — never crash the app because of logging
    });

    callback();
  }
}

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: consoleFormat,
  }),
  new DailyRotateFile({
    level: 'error',
    filename: 'logs/error-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    zippedArchive: true,
    maxSize: '20m',
    maxFiles: '14d',
    format: fileFormat,
  }),
  new MongoTransport({
    level: 'warn',
    collection: 'app_logs',
  }),
];

export const logger = winston.createLogger({
  level: level(),
  levels,
  transports,
});