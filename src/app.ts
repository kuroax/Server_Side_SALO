import express, { json, type Application, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import pinoHttp from 'pino-http';

import { schema } from '#/graphql/schema/index.js';
import { createContext } from '#/graphql/context.js';
import { CORS_ORIGIN, IS_DEVELOPMENT } from '#/config/env.js';
import { logger } from '#/config/logger.js';

export const createApp = async (): Promise<Application> => {
  const app = express();

  app.set('trust proxy', 1);

  // Security
  app.use(helmet());

  app.use(
    cors({
      origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN,
      credentials: true,
    }),
  );

  // Request logging
  app.use(
    pinoHttp({
      logger,
      quietReqLogger: true,
      customLogLevel: (_req, res) => {
        if (res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // Body parsing
  app.use(json({ limit: '10kb' }));

  // Health check
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // Apollo Server
  const server = new ApolloServer({
    schema,
    introspection: IS_DEVELOPMENT,
  });

  await server.start();

  app.use(
    '/api/graphql',
    expressMiddleware(server, {
      context: createContext,
    }),
  );

  logger.info('Apollo middleware mounted at /api/graphql');

  // 404
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      message: 'Route not found',
    });
  });

  // Global error handler
  app.use(
    (err: unknown, _req: Request, res: Response, _next: NextFunction): void => {
      logger.error({ err }, 'Unhandled application error');

      res.status(500).json({
        success: false,
        message: 'Internal server error',
      });
    },
  );

  return app;
};