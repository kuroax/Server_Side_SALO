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
    // Wildcard (*) is rejected in production at startup.
    // Multiple origins can be provided as a comma-separated string.
    // CORS_ORIGINS (the parsed value) is typed string[] | true:
    //   true        → allow all origins (development only)
    //   string[]    → allow exactly these origins
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

    // Shared secret used by n8n buffer endpoints (push + claim).
    // Must match BUFFER_WEBHOOK_SECRET set in n8n Railway service variables.
    // Rotate both values together if compromised.
    BUFFER_WEBHOOK_SECRET: z
      .string()
      .trim()
      .min(16, "BUFFER_WEBHOOK_SECRET must be at least 16 characters"),

    // How long (ms) the n8n Wait node holds before the buffer is claimed.
    // Must be less than the n8n Wait node duration (default: 60000ms).
    // Set to 5000 for local testing, 55000 for production.
    WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS: z.coerce
      .number()
      .int()
      .positive()
      .default(55000),

    // Cloudinary URL for the bank account image sent automatically when a customer
    // asks where to deposit. Optional — if not set Luis escalates to the owner instead.
    // Empty Railway values are treated as undefined.
    // Set in Railway: BANK_ACCOUNT_IMAGE_URL=https://res.cloudinary.com/...
    BANK_ACCOUNT_IMAGE_URL: optionalUrlSchema,

    // Meta App credentials — required for Embedded Signup token exchange.
    // META_APP_ID is your app ID: 2300378030444599
    // META_APP_SECRET is from App Dashboard > Basic settings.
    // Both optional until Embedded Signup is deployed to production.
    META_APP_ID: z.string().trim().optional(),
    META_APP_SECRET: z.string().trim().optional(),

    // System User master token for platform-level Meta API calls.
    // System User SALO ID: 61577448959274
    // Optional until multi-tenant onboarding is live.
    SYSTEM_USER_TOKEN: z.string().trim().optional(),
  })
  .refine((env) => env.JWT_SECRET !== env.JWT_REFRESH_SECRET, {
    path: ["JWT_REFRESH_SECRET"],
    message: "JWT_REFRESH_SECRET must be different from JWT_SECRET",
  });

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error("\u274c Invalid environment variables:");
  parsed.error.issues.forEach((issue) => {
    console.error(`   ${issue.path.join(".")}: ${issue.message}`);
  });
  process.exit(1);
}

// Parse CORS_ORIGIN into the shape the cors() middleware expects:
//   "*"                        → true          (allow all — development only)
//   "https://a.com,https://b.com" → string[]  (allow exactly these origins)
//
// The cors package accepts boolean true for wildcard, NOT ["*"].
// Passing ["*"] would try to match the literal string "*" against the
// request Origin header and block every real origin.
const corsOrigins: string[] | true =
  parsed.data.CORS_ORIGIN.trim() === "*"
    ? true
    : parsed.data.CORS_ORIGIN
        .split(",")
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
// CORS_ORIGINS is true (not an array) when the env var is "*".
if (env.IS_PRODUCTION && env.CORS_ORIGINS === true) {
  console.error(
    "\u274c CORS_ORIGIN cannot be wildcard (*) in production. Set explicit origins.",
  );
  process.exit(1);
}

export const {
  NODE_ENV, // No default — must be set explicitly in every environment.
  // Local dev: add NODE_ENV=development to your .env file.
  PORT,
  MONGODB_URI,
  JWT_SECRET,
  JWT_EXPIRES_IN,
  JWT_REFRESH_SECRET,
  JWT_REFRESH_EXPIRES_IN,
  BCRYPT_SALT_ROUNDS,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMIT_MAX_REQUESTS,
  // CORS_ORIGIN is the raw comma-separated string from the environment variable.
  // Prefer CORS_ORIGINS (parsed, typed string[] | true) in all middleware.
  // CORS_ORIGIN is retained only for logging/debugging — do not pass it to cors().
  CORS_ORIGIN,
  CORS_ORIGINS,
  ANTHROPIC_API_KEY,
  WEBHOOK_SECRET,
  WHATSAPP_ACCESS_TOKEN,
  BUFFER_WEBHOOK_SECRET,
  WHATSAPP_BUFFER_ELAPSED_THRESHOLD_MS,
  BANK_ACCOUNT_IMAGE_URL,
  META_APP_ID,
  META_APP_SECRET,
  SYSTEM_USER_TOKEN,
  IS_PRODUCTION,
  IS_DEVELOPMENT,
  IS_TEST,
} = env;