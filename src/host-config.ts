/** Public startup switches only. Secrets are loaded by the isolated host Slack loader. */
import { isAbsolute, normalize } from 'node:path';
import { HERMES_CODING_RUNTIME_POLICY } from './hermes/coding-runtime-policy.ts';

export interface HostStartupConfig {
  mode: 'legacy' | 'hermes-canary' | 'hermes-readonly-canary';
  activationPath?: string;
  slack?: { credentialsPath: string; approvedChannelIds: readonly string[] };
}

function path(value: string | undefined): string {
  if (!value || !isAbsolute(value) || normalize(value) !== value || /[\0\r\n]/.test(value)) {
    throw new Error('invalid_host_configuration');
  }
  return value;
}

export function loadHostStartupConfig(env: Readonly<Record<string, string | undefined>> = process.env): HostStartupConfig {
  const mode = env.GARY_RUNTIME_MODE ?? 'legacy';
  if (mode !== 'legacy' && mode !== 'hermes-canary' && mode !== 'hermes-readonly-canary') throw new Error('invalid_runtime_mode');
  const enabled = env.GARY_SLACK_ENABLED;
  if (enabled !== undefined && enabled !== '0' && enabled !== '1') throw new Error('invalid_slack_enable_switch');
  if (mode === 'legacy') {
    if (env.GARY_HERMES_ACTIVATION_PATH || enabled === '1' || env.GARY_SLACK_CREDENTIALS_FILE || env.GARY_SLACK_ALLOWED_CHANNEL_IDS) {
      throw new Error('hermes_configuration_requires_canary_mode');
    }
    return Object.freeze({ mode });
  }
  // The host's existing executor remains the only workspace mutation authority.
  // Require the reviewed Docker path; never silently use LocalExecutor here.
  const executor = HERMES_CODING_RUNTIME_POLICY.executor;
  const reviewedPair = mode === 'hermes-canary'
    ? env.GARY_EXECUTOR_IMAGE === executor.image && env.GARY_BUN_CACHE_VOLUME === executor.bunCacheVolume
    : env.GARY_EXECUTOR_IMAGE === 'sha256:e77edfc6e20402c7ed9f447dca81dc61e277c2a39199963f455a37a03dfcedf4'
      && (env.GARY_BUN_CACHE_VOLUME === undefined || env.GARY_BUN_CACHE_VOLUME === 'gary-bun-cache');
  if (!reviewedPair || env.GARY_EXECUTOR !== 'docker' || env.GARY_EXECUTOR_NETWORK !== 'none'
      || env.DOCKER_HOST !== 'unix:///Users/tanner/.colima/default/docker.sock' || Boolean(env.DOCKER_CONTEXT)) {
    throw new Error('hermes_requires_reviewed_docker_executor');
  }
  const activationPath = path(env.GARY_HERMES_ACTIVATION_PATH);
  if (mode === 'hermes-readonly-canary' && enabled !== '1') throw new Error('readonly_canary_requires_slack');
  if (enabled !== '1') {
    if (env.GARY_SLACK_CREDENTIALS_FILE || env.GARY_SLACK_ALLOWED_CHANNEL_IDS) throw new Error('slack_configuration_requires_enable');
    return Object.freeze({ mode, activationPath });
  }
  const rawChannels = env.GARY_SLACK_ALLOWED_CHANNEL_IDS;
  const approvedChannelIds = rawChannels ? rawChannels.split(',') : [];
  if (approvedChannelIds.length > 16 || new Set(approvedChannelIds).size !== approvedChannelIds.length
      || approvedChannelIds.some(channel => !/^[CG][A-Z0-9]{8,20}$/.test(channel))) {
    throw new Error('invalid_slack_channel_allowlist');
  }
  if (mode === 'hermes-readonly-canary' && approvedChannelIds.length) throw new Error('readonly_canary_shared_channels_disabled');
  return Object.freeze({ mode, activationPath,
    slack: Object.freeze({ credentialsPath: path(env.GARY_SLACK_CREDENTIALS_FILE), approvedChannelIds: Object.freeze(approvedChannelIds) }) });
}
