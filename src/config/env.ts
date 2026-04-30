import "dotenv/config";
import { z } from "zod";

const durationSchema = z
  .string()
  .trim()
  .regex(/^\d+(s|m|h|d)$/i, "Must be a duration like 15m, 7d, 1h, or 30s");

const requiredTrimmedString = (name: string) =>
  z.string().trim().min(1, `${name} is required`);

const optionalUrlSchema = z.preprocess((value) => {
  if (typeof value !== "string") return value;

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}, z.string().url().optional());

const envSchema = z
  .object({
    // Server
    // Do not default NODE_ENV. Railway/production must explicitly set this.
    NODE_ENV: z.enum(["development", "production", "test"]),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),

    // Database
    MONGODB_URI: requiredTrimmedString("MONGODB_URI"),

    // Auth
    JWT_SECRET: z
      .string()
      .trim()
      .min(32, "JWT_SECRET must be at least 32 characters"),
    JWT_EXPIRES_IN: durationSchema.default("15m"),
    JWT_REFRESH_SECRET: z
      .string()
      .trim()
      .min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),
    JWT_REFRESH_EXPIRES_IN: durationSchema.default("7d"),

    // Security
    BCRYPT_SALT_ROUNDS: z.coerce.number().int().min(10).max(14).default(12),
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(900000),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(100),

    // CORS — no default intentionally: must be set explicitly in every environment.
    // Wildcard is rejected in production at startup.
    // Multiple origins can be provided as a comma-separated string.
    CORS_ORIGIN: requiredTrimmedString("CORS_ORIGIN"),

    // Integrations
    // Required for WhatsApp bot — Claude API key from console.anthropic.com.
    ANTHROPIC_API_KEY: requiredTrimmedString("ANTHROPIC_API_KEY"),

    // Shared secret sent by n8n in X-Webhook-Secret header.
    // Must match the value configured in the n8n HTTP Request node.
    // IMPORTANT: confirm this variable name matches Railway, backend middleware, and n8n.
    WEBHOOK_SECRET: z
      .string()
      .trim()
      .min(16, "WEBHOOK_SECRET must be at least 16 characters"),

    // Meta permanent access token — used to download customer-sent images from
    // WhatsApp media servers for visual inventory search.
    WHATSAPP_ACCESS_TOKEN: requiredTrimmedString("WHATSAPP_ACCESS_TOKEN"),

    // Cloudinary URL for the bank account image sent automatically when a customer
    // asks where to deposit. Optional — if not set Luis escalates to the owner instead.
    // Empty Railway values are treated as undefined.
    // Set in Railway: BANK_ACCOUNT_IMAGE_URL=https://res.cloudinary.com/...
    BANK_ACCOUNT_IMAGE_URL: optionalUrlSchema,
  })
  .refine((env) => env.JWT_SECRET !== env.JWT_REFRESH_SECRET, {
    path: ["JWT_REFRESH_SECRET"],
    message: "JWT_REFRESH_SECRET must be different from JWT_SECRET",
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("❌ Invalid environment variables:");
  parsed.error.issues.forEach((issue) => {
    console.error(`   ${issue.path.join(".")}: ${issue.message}`);
  });
  process.exit(1);
}

const corsOrigins = parsed.data.CORS_ORIGIN.split(",")
  .map((origin) => origin.trim())
  .filter(Boolean);

export const env = {
  ...parsed.data,
  CORS_ORIGINS: corsOrigins,
  IS_PRODUCTION: parsed.data.NODE_ENV === "production",
  IS_DEVELOPMENT: parsed.data.NODE_ENV === "development",
  IS_TEST: parsed.data.NODE_ENV === "test",
} as const;

// Hard fail in production for wildcard CORS.
if (env.IS_PRODUCTION && env.CORS_ORIGINS.includes("*")) {
  console.error(
    "❌ CORS_ORIGIN cannot include wildcard (*) in production. Set explicit origins.",
  );
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
  CORS_ORIGINS,
  ANTHROPIC_API_KEY,
  WEBHOOK_SECRET,
  WHATSAPP_ACCESS_TOKEN,
  BANK_ACCOUNT_IMAGE_URL,
  IS_PRODUCTION,
  IS_DEVELOPMENT,
  IS_TEST,
} = env;
