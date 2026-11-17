import dotenv from 'dotenv';
import { z } from 'zod';

export const DEFAULT_DEV_DB_URL =
  'postgresql://marketplace_user:marketplace_password@localhost:5433/marketplace_dev';

export const DEFAULT_TEST_DB_URL =
  'postgresql://marketplace_user:marketplace_password@localhost:5433/marketplace_test';

const envSchema = z.object({
  DATABASE_URL: z
    .string({
      error: 'DATABASE_URL is required',
    })
    .url('DATABASE_URL must be a valid URL')
    .default(DEFAULT_DEV_DB_URL),
  DATABASE_URL_TEST: z
    .string()
    .url('DATABASE_URL_TEST must be a valid URL')
    .default(DEFAULT_TEST_DB_URL),
  PORT: z
    .string()
    .default('3000')
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: 'PORT must be a valid positive number',
    })
    .transform((val) => Number(val)),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  JWT_SECRET: z
    .string()
    .min(16, 'JWT_SECRET must be at least 16 characters long')
    .default('dev-jwt-insecure-secret-key-32chars!!'),
  JWT_EXPIRES_IN: z.string().default('1h'),
  OTP_TTL_SECONDS: z
    .string()
    .default('120')
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: 'OTP_TTL_SECONDS must be a positive number',
    })
    .transform((val) => Number(val)),
  OTP_RATE_LIMIT_MAX_ATTEMPTS: z
    .string()
    .default('3')
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: 'OTP_RATE_LIMIT_MAX_ATTEMPTS must be a positive number',
    })
    .transform((val) => Number(val)),
  OTP_RATE_LIMIT_WINDOW_SECONDS: z
    .string()
    .default('60')
    .refine((val) => !isNaN(Number(val)) && Number(val) > 0, {
      message: 'OTP_RATE_LIMIT_WINDOW_SECONDS must be a positive number',
    })
    .transform((val) => Number(val)),
});

export interface AppConfig {
  databaseUrl: string;
  testDatabaseUrl: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
  jwtSecret: string;
  jwtExpiresIn: string;
  otpTtlSeconds: number;
  otpRateLimitMaxAttempts: number;
  otpRateLimitWindowSeconds: number;
}

export function loadConfig(
  rawEnv: NodeJS.ProcessEnv = process.env,
  options: { loadDotenv?: boolean } = {},
): AppConfig {
  if (options.loadDotenv !== false && typeof process !== 'undefined') {
    dotenv.config();
  }

  const result = envSchema.safeParse(rawEnv);

  if (!result.success) {
    const errorMessages = result.error.issues
      .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid configuration: ${errorMessages}`);
  }

  const {
    DATABASE_URL,
    DATABASE_URL_TEST,
    PORT,
    NODE_ENV,
    JWT_SECRET,
    JWT_EXPIRES_IN,
    OTP_TTL_SECONDS,
    OTP_RATE_LIMIT_MAX_ATTEMPTS,
    OTP_RATE_LIMIT_WINDOW_SECONDS,
  } = result.data;

  return {
    databaseUrl: DATABASE_URL,
    testDatabaseUrl: DATABASE_URL_TEST,
    port: PORT,
    nodeEnv: NODE_ENV,
    jwtSecret: JWT_SECRET,
    jwtExpiresIn: JWT_EXPIRES_IN,
    otpTtlSeconds: OTP_TTL_SECONDS,
    otpRateLimitMaxAttempts: OTP_RATE_LIMIT_MAX_ATTEMPTS,
    otpRateLimitWindowSeconds: OTP_RATE_LIMIT_WINDOW_SECONDS,
  };
}
