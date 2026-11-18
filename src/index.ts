import { runGaryHost, type StartupDependencies } from './startup.ts';
import { log } from './logger.ts';

export async function main(deps: StartupDependencies = {}): Promise<void> { await runGaryHost(deps); }

// Importing the actual entrypoint in offline integration tests cannot start Gary.
if (import.meta.main) {
  main().catch((error: unknown) => {
    // Host setup can touch credentials. Never reflect a raw startup exception;
    // only Gary's own snake_case failure codes are safe to log.
    const message = error instanceof Error ? error.message : '';
    const code = /^[a-z][a-z0-9_]{2,63}$/.test(message) ? message : 'unclassified';
    log.error('fatal', { error: 'gary_startup_failed', code });
    process.exitCode = 1;
  });
}
