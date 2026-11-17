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
});

export interface AppConfig {
  databaseUrl: string;
  testDatabaseUrl: string;
  port: number;
  nodeEnv: 'development' | 'test' | 'production';
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

  const { DATABASE_URL, DATABASE_URL_TEST, PORT, NODE_ENV } = result.data;

  return {
    databaseUrl: DATABASE_URL,
    testDatabaseUrl: DATABASE_URL_TEST,
    port: PORT,
    nodeEnv: NODE_ENV,
  };
}
