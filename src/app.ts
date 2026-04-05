import express, { json, type Application, type Request, type Response, type NextFunction } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { ApolloServer } from '@apollo/server';
import { expressMiddleware } from '@as-integrations/express5';
import { pinoHttp } from 'pino-http';
import { GraphQLError, type ValidationRule } from 'graphql';

import { schema } from '#/graphql/schema/index.js';
import { createGraphQLContext } from '#/graphql/context.js';

// ─── GraphQL depth limit ──────────────────────────────────────────────────────
// Prevents deeply nested queries from being used as a CPU/memory DoS vector.
// Depth is counted in selection-set nesting levels, not field count.
// 10 is generous enough for any legitimate dashboard query.

const MAX_QUERY_DEPTH = 10;

function createDepthLimitRule(maxDepth: number): ValidationRule {
  return (context) => ({
    OperationDefinition(operationNode) {
      const checkDepth = (
        selectionSet: typeof operationNode.selectionSet | undefined,
        depth: number,
      ): void => {
        if (!selectionSet) return;
        for (const selection of selectionSet.selections) {
          if (depth > maxDepth) {
            context.reportError(
              new GraphQLError(
                `Query depth ${depth} exceeds maximum allowed depth of ${maxDepth}.`,
              ),
            );
            return;
          }
          if ('selectionSet' in selection && selection.selectionSet) {
            checkDepth(selection.selectionSet, depth + 1);
          }
        }
      };
      checkDepth(operationNode.selectionSet, 1);
    },
  });
}
import {
  CORS_ORIGIN,
  IS_DEVELOPMENT,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
} from '#/config/env.js';
import { logger } from '#/config/logger.js';
import { AppError } from '#/shared/errors/index.js';
import { whatsappWebhookRouter } from '#/integrations/whatsapp/webhook.router.js';

export const createApp = async (): Promise<Application> => {
  const app = express();

  app.set('trust proxy', 1);

  // ─── Security headers ─────────────────────────────────────────────────────────
  app.use(
    helmet({
      contentSecurityPolicy:     IS_DEVELOPMENT ? false : undefined,
      crossOriginEmbedderPolicy: IS_DEVELOPMENT ? false : undefined,
    }),
  );

  // ─── CORS ─────────────────────────────────────────────────────────────────────
  app.use(
    cors({
      origin:      CORS_ORIGIN === '*' ? true : CORS_ORIGIN,
      credentials: true,
    }),
  );

  // ─── Rate limiting ────────────────────────────────────────────────────────────
  app.use(
    rateLimit({
      windowMs:        RATE_LIMIT_WINDOW_MS,
      max:             RATE_LIMIT_MAX_REQUESTS,
      standardHeaders: true,
      legacyHeaders:   false,
      message:         { success: false, message: 'Too many requests — please try again later.' },
      skip:            () => IS_DEVELOPMENT,
    }),
  );

  // ─── Request logging ──────────────────────────────────────────────────────────
  app.use(
    pinoHttp({
      logger,
      quietReqLogger: true,
      customLogLevel: (_req, res: { statusCode: number }) => {
        if (res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  // ─── Body parsing ─────────────────────────────────────────────────────────────
  app.use(json({ limit: '10kb' }));

  // ─── Health check ─────────────────────────────────────────────────────────────
  app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok' });
  });

  // ─── Apollo Server ────────────────────────────────────────────────────────────
  const server = new ApolloServer({
    schema,
    introspection: IS_DEVELOPMENT,
    validationRules: [createDepthLimitRule(MAX_QUERY_DEPTH)],
    formatError: (formattedError, error) => {
      const originalError = (error as { originalError?: unknown }).originalError ?? error;
      if (originalError instanceof AppError) {
        return {
          ...formattedError,
          extensions: {
            ...formattedError.extensions,
            code: originalError.code,
          },
        };
      }
      return formattedError;
    },
  });

  await server.start();

  app.use(
    '/api/graphql',
    expressMiddleware(server, {
      context: createGraphQLContext,
    }),
  );

  logger.info('Apollo middleware mounted at /api/graphql');

  // ─── Webhooks ─────────────────────────────────────────────────────────────────
  // Mounted after Apollo — webhook endpoints are REST, not GraphQL.
  // Secret validation is handled inside the controller.
  app.use('/api/webhooks/whatsapp', whatsappWebhookRouter);

  logger.info('WhatsApp webhook mounted at /api/webhooks/whatsapp');

  // ─── 404 ──────────────────────────────────────────────────────────────────────
  app.use((_req: Request, res: Response) => {
    res.status(404).json({
      success: false,
      message: 'Route not found',
    });
  });

  // ─── Global error handler ─────────────────────────────────────────────────────
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