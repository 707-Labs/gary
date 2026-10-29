// Used by scripts/deploy.sh: validate the private standing-engineering env file
// and print its four KEY=value pins. Read-only. usage: <env-file> <release-sha>
import { loadStandingEngineeringEnv, STANDING_ENGINEERING_ENV_KEYS } from "../src/standing-engineering-env.ts";

const [path, release] = process.argv.slice(2);
if (!path || !release) { console.error("usage: standing-engineering-env.ts <env-file> <release-sha>"); process.exit(2); }
try {
  const env = loadStandingEngineeringEnv(path, release);
  for (const key of STANDING_ENGINEERING_ENV_KEYS) console.log(`${key}=${env[key]}`);
} catch (error) {
  console.error(`[deploy] refusing: ${(error as Error).message}`);
  console.error("[deploy] fix the standing config/env, or move the env file aside to deploy with standing engineering disabled");
  process.exit(1);
}
