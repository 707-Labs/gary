import { runGaryHost, type StartupDependencies } from './startup.ts';
import { log } from './logger.ts';

export async function main(deps: StartupDependencies = {}): Promise<void> { await runGaryHost(deps); }

// Importing the actual entrypoint in offline integration tests cannot start Gary.
if (import.meta.main) {
  main().catch(() => {
    // Host setup can touch credentials. Never reflect a raw startup exception.
    log.error('fatal', { error: 'gary_startup_failed' });
    process.exitCode = 1;
  });
}
