import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  // Server
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(4000),

  // Database
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),

  // Auth
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('15m'),
  JWT_REFRESH_SECRET: z
    .string()
    .min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('7d'),

  // Security
  BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
  RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

  // CORS — no default intentionally: must be set explicitly in every environment.
  // Wildcard is rejected in production at startup.
  CORS_ORIGIN: z.string().min(1, 'CORS_ORIGIN is required'),

  // Integrations
  // Required for WhatsApp bot — Claude API key from console.anthropic.com.
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),

  // Shared secret sent by n8n in X-Webhook-Secret header.
  // Must match the value configured in the n8n HTTP Request node.
  WEBHOOK_SECRET: z.string().min(16, 'WEBHOOK_SECRET must be at least 16 characters'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  parsed.error.issues.forEach((issue) => {
    console.error(`   ${issue.path.join('.')}: ${issue.message}`);
  });
  process.exit(1);
}

export const env = {
  ...parsed.data,
  IS_PRODUCTION:  parsed.data.NODE_ENV === 'production',
  IS_DEVELOPMENT: parsed.data.NODE_ENV === 'development',
  IS_TEST:        parsed.data.NODE_ENV === 'test',
} as const;

// Hard fail in production for wildcard CORS.
if (env.IS_PRODUCTION && env.CORS_ORIGIN === '*') {
  console.error('❌ CORS_ORIGIN cannot be wildcard (*) in production. Set an explicit origin.');
  process.exit(1);
}

export const {
  NODE_ENV,
  PORT,
  MONGODB_URI,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  JWT_REFRESH_SECRET,
  JWT_REFRESH_EXPIRES_IN,
  BCRYPT_SALT_ROUNDS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  CORS_ORIGIN,
  ANTHROPIC_API_KEY,
  WEBHOOK_SECRET,
  IS_PRODUCTION,
  IS_DEVELOPMENT,
  IS_TEST,
} = env;