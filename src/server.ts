import { createApp } from './app.js';
import { loadConfig } from './config/index.js';
import { createDbPool, checkDatabaseConnection } from './db/index.js';

async function startServer(): Promise<void> {
  const config = loadConfig();
  const pool = createDbPool({ connectionString: config.databaseUrl });

  const isConnected = await checkDatabaseConnection(pool);
  if (!isConnected) {
    console.error('Failed to establish database connection during server startup.');
    process.exit(1);
  }

  const { app } = createApp({ pool, config });

  app.listen(config.port, () => {
    console.log(`Server listening on http://localhost:${config.port} (env: ${config.nodeEnv})`);
  });
}

if (process.env['NODE_ENV'] !== 'test') {
  startServer().catch((err) => {
    console.error('Fatal error during server startup:', err);
    process.exit(1);
  });
}
