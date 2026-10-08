import { expect, test } from 'bun:test';
import { loadHostStartupConfig } from '../src/host-config.ts';

const canary = {
  GARY_RUNTIME_MODE: 'hermes-canary', GARY_HERMES_ACTIVATION_PATH: '/private/runtime/activation.json',
  GARY_EXECUTOR: 'docker', GARY_EXECUTOR_NETWORK: 'none',
  GARY_EXECUTOR_IMAGE: 'sha256:e77edfc6e20402c7ed9f447dca81dc61e277c2a39199963f455a37a03dfcedf4',
  DOCKER_HOST: 'unix:///Users/tanner/.colima/default/docker.sock',
};
test('ordinary startup remains legacy and never implicitly enables Slack or Hermes', () => {
  expect(loadHostStartupConfig({})).toEqual({ mode: 'legacy' });
  for (const env of [{ GARY_RUNTIME_MODE: 'other' }, { GARY_HERMES_ACTIVATION_PATH: '/a' }, { GARY_SLACK_ENABLED: '1' }]) {
    expect(() => loadHostStartupConfig(env)).toThrow();
  }
});
test('canary cannot silently use a local, mutable-image or networked executor', () => {
  for (const field of ['GARY_EXECUTOR', 'GARY_EXECUTOR_NETWORK', 'GARY_EXECUTOR_IMAGE', 'DOCKER_HOST'] as const) {
    expect(() => loadHostStartupConfig({ ...canary, [field]: undefined })).toThrow('hermes_requires_reviewed_docker_executor');
  }
  expect(() => loadHostStartupConfig({ ...canary, DOCKER_CONTEXT: 'remote' })).toThrow();
  expect(() => loadHostStartupConfig({ ...canary, GARY_BUN_CACHE_VOLUME: 'unreviewed-cache' })).toThrow();
  expect(loadHostStartupConfig(canary)).toEqual({ mode: 'hermes-canary', activationPath: canary.GARY_HERMES_ACTIVATION_PATH });
});
test('Slack defaults to no shared channels and requires an explicit absolute credential path', () => {
  const env = { ...canary, GARY_SLACK_ENABLED: '1', GARY_SLACK_CREDENTIALS_FILE: '/private/runtime/slack.env' };
  expect(loadHostStartupConfig(env).slack?.approvedChannelIds).toEqual([]);
  expect(loadHostStartupConfig({ ...env, GARY_SLACK_ALLOWED_CHANNEL_IDS: 'C0123456789' }).slack?.approvedChannelIds).toEqual(['C0123456789']);
  for (const value of ['*', 'C0123456789,C0123456789', ' C0123456789', '']) {
    if (!value) continue;
    expect(() => loadHostStartupConfig({ ...env, GARY_SLACK_ALLOWED_CHANNEL_IDS: value })).toThrow('invalid_slack_channel_allowlist');
  }
  expect(() => loadHostStartupConfig({ ...env, GARY_SLACK_CREDENTIALS_FILE: './slack.env' })).toThrow();
  expect(() => loadHostStartupConfig({ ...canary, GARY_SLACK_CREDENTIALS_FILE: '/private/slack.env' })).toThrow();
  expect(() => loadHostStartupConfig({ ...canary, GARY_SLACK_ENABLED: 'yes' })).toThrow();
});
