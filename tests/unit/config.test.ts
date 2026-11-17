import { describe, expect, it } from 'vitest';
import { loadConfig, DEFAULT_DEV_DB_URL, DEFAULT_TEST_DB_URL } from '../../src/config/index.js';

describe('loadConfig', () => {
  it('parses environment with default values when empty', () => {
    const config = loadConfig({}, { loadDotenv: false });

    expect(config.databaseUrl).toBe(DEFAULT_DEV_DB_URL);
    expect(config.testDatabaseUrl).toBe(DEFAULT_TEST_DB_URL);
    expect(config.port).toBe(3000);
    expect(config.nodeEnv).toBe('development');
  });

  it('respects explicitly provided values', () => {
    const config = loadConfig(
      {
        DATABASE_URL: 'postgresql://custom_user:pass@localhost:5432/custom_dev',
        DATABASE_URL_TEST: 'postgresql://custom_user:pass@localhost:5432/custom_test',
        PORT: '8080',
        NODE_ENV: 'test',
      },
      { loadDotenv: false },
    );

    expect(config.databaseUrl).toBe('postgresql://custom_user:pass@localhost:5432/custom_dev');
    expect(config.testDatabaseUrl).toBe('postgresql://custom_user:pass@localhost:5432/custom_test');
    expect(config.port).toBe(8080);
    expect(config.nodeEnv).toBe('test');
  });

  it('throws an error when DATABASE_URL is not a valid URL', () => {
    expect(() => loadConfig({ DATABASE_URL: 'invalid-url' }, { loadDotenv: false })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('throws an error when PORT is not a valid number', () => {
    expect(() =>
      loadConfig(
        {
          PORT: 'not-a-number',
        },
        { loadDotenv: false },
      ),
    ).toThrow(/PORT/);
  });
});
