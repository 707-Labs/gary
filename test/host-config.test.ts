import { expect, test } from 'bun:test';
import { loadHostStartupConfig } from '../src/host-config.ts';

const READONLY_IMAGE='sha256:e77edfc6e20402c7ed9f447dca81dc61e277c2a39199963f455a37a03dfcedf4';
const canary = {
  GARY_RUNTIME_MODE: 'hermes-canary', GARY_HERMES_ACTIVATION_PATH: '/private/runtime/activation.json',
  GARY_EXECUTOR: 'docker', GARY_EXECUTOR_NETWORK: 'none',
  GARY_EXECUTOR_IMAGE: 'sha256:0efb49a8f21794948395f7bec2c15557a78473acd760207613fe7714e7c47f8c',
  GARY_BUN_CACHE_VOLUME: 'gary-bun-cache-20261007-node24',
  DOCKER_HOST: 'unix:///Users/tanner/.colima/default/docker.sock',
};
test('free-form conversation requires explicit private DM, clean release pin and private absolute config path',()=>{
  const env={...canary,GARY_RUNTIME_MODE:'hermes-readonly-canary',GARY_EXECUTOR_IMAGE:READONLY_IMAGE,GARY_BUN_CACHE_VOLUME:'gary-bun-cache',GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:'/private/runtime/slack.env',
    GARY_SLACK_TANNER_DM_ENABLED:'1',GARY_READONLY_SLACK_RELEASE_COMMIT:'a'.repeat(40),GARY_SLACK_CONVERSATION_CONFIG:'/private/runtime/conversation.json'};
  expect(loadHostStartupConfig(env).slackConversationConfigPath).toBe(env.GARY_SLACK_CONVERSATION_CONFIG);
  for(const key of ['GARY_SLACK_TANNER_DM_ENABLED','GARY_READONLY_SLACK_RELEASE_COMMIT','GARY_SLACK_ENABLED'])expect(()=>loadHostStartupConfig({...env,[key]:undefined})).toThrow();
  expect(()=>loadHostStartupConfig({...env,GARY_RUNTIME_MODE:'legacy'})).toThrow();
  expect(()=>loadHostStartupConfig({...env,GARY_SLACK_CONVERSATION_CONFIG:'./config.json'})).toThrow();
});
test('ordinary startup remains legacy and never implicitly enables Slack or Hermes', () => {
  expect(loadHostStartupConfig({})).toEqual({ mode: 'legacy' });
  for (const env of [{ GARY_RUNTIME_MODE: 'other' }, { GARY_HERMES_ACTIVATION_PATH: '/a' }, { GARY_SLACK_ENABLED: '1' }]) {
    expect(() => loadHostStartupConfig(env)).toThrow();
  }
});
test('canary cannot silently use a local, mutable-image or networked executor', () => {
  for (const field of ['GARY_EXECUTOR', 'GARY_EXECUTOR_NETWORK', 'GARY_EXECUTOR_IMAGE', 'GARY_BUN_CACHE_VOLUME', 'DOCKER_HOST'] as const) {
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

test('read-only startup requires Slack and prohibits shared-channel responses',()=>{
  const env={...canary,GARY_RUNTIME_MODE:'hermes-readonly-canary',GARY_EXECUTOR_IMAGE:READONLY_IMAGE,GARY_BUN_CACHE_VOLUME:'gary-bun-cache',GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:'/private/runtime/slack.env'};
  expect(loadHostStartupConfig(env).mode).toBe('hermes-readonly-canary');
  expect(()=>loadHostStartupConfig({...env,GARY_SLACK_ENABLED:'0'})).toThrow('readonly_canary_requires_slack');
  expect(()=>loadHostStartupConfig({...env,GARY_SLACK_ALLOWED_CHANNEL_IDS:'C0123456789'})).toThrow('readonly_canary_shared_channels_disabled');
});


test('coding requires its exact browser image/cache pair and cannot mix readonly components',()=>{
  for(const override of [
    {GARY_EXECUTOR_IMAGE:READONLY_IMAGE},
    {GARY_BUN_CACHE_VOLUME:'gary-bun-cache'},
    {GARY_EXECUTOR_IMAGE:READONLY_IMAGE,GARY_BUN_CACHE_VOLUME:'gary-bun-cache'},
    {GARY_EXECUTOR_IMAGE:canary.GARY_EXECUTOR_IMAGE+' '},
    {GARY_BUN_CACHE_VOLUME:canary.GARY_BUN_CACHE_VOLUME+' '},
  ])expect(()=>loadHostStartupConfig({...canary,...override})).toThrow('hermes_requires_reviewed_docker_executor');
});

test('readonly retains the original image and default cache and cannot inherit the coding profile',()=>{
  const env={...canary,GARY_RUNTIME_MODE:'hermes-readonly-canary',GARY_EXECUTOR_IMAGE:READONLY_IMAGE,
    GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:'/private/runtime/slack.env'};
  for(const cache of [undefined,'gary-bun-cache'])expect(loadHostStartupConfig({...env,GARY_BUN_CACHE_VOLUME:cache}).mode).toBe('hermes-readonly-canary');
  for(const override of [
    {GARY_EXECUTOR_IMAGE:canary.GARY_EXECUTOR_IMAGE,GARY_BUN_CACHE_VOLUME:canary.GARY_BUN_CACHE_VOLUME},
    {GARY_EXECUTOR_IMAGE:READONLY_IMAGE,GARY_BUN_CACHE_VOLUME:canary.GARY_BUN_CACHE_VOLUME},
    {GARY_EXECUTOR_IMAGE:canary.GARY_EXECUTOR_IMAGE,GARY_BUN_CACHE_VOLUME:'gary-bun-cache'},
  ])expect(()=>loadHostStartupConfig({...env,...override})).toThrow('hermes_requires_reviewed_docker_executor');
});
test('Tanner DM opt-in and exact Slack release pin are restricted to readonly mode',()=>{
  const env={...canary,GARY_RUNTIME_MODE:'hermes-readonly-canary',GARY_EXECUTOR_IMAGE:READONLY_IMAGE,GARY_BUN_CACHE_VOLUME:'gary-bun-cache',GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:'/private/runtime/slack.env',
    GARY_SLACK_TANNER_DM_ENABLED:'1',GARY_READONLY_SLACK_RELEASE_COMMIT:'b'.repeat(40)};
  expect(loadHostStartupConfig(env)).toMatchObject({readonlySlackReleaseCommit:'b'.repeat(40),slack:{tannerDirectMessages:true,approvedChannelIds:[]}});
  for(const update of [{GARY_RUNTIME_MODE:'legacy'},{GARY_RUNTIME_MODE:'hermes-canary'},{GARY_SLACK_ENABLED:'0'},
    {GARY_SLACK_TANNER_DM_ENABLED:'yes'},{GARY_SLACK_TANNER_DM_ENABLED:'0'},{GARY_READONLY_SLACK_RELEASE_COMMIT:'main'}])
    expect(()=>loadHostStartupConfig({...env,...update})).toThrow();
});


test('combined conversations require an exact independent release and preserve coding executor policy',()=>{
  const env={...canary,GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:'/private/runtime/slack.env',
    GARY_SLACK_TANNER_DM_ENABLED:'1',GARY_SLACK_CONVERSATION_CONFIG:'/private/dm/conversation.json',
    GARY_SLACK_SHARED_CONVERSATION_CONFIG:'/private/shared/conversation.json',GARY_CONVERSATION_RUNTIME_RELEASE:'c'.repeat(40)};
  expect(loadHostStartupConfig(env)).toMatchObject({mode:'hermes-canary',conversationRuntimeRelease:'c'.repeat(40),
    slackConversationConfigPath:'/private/dm/conversation.json',slackSharedConversationConfigPath:'/private/shared/conversation.json',slack:{approvedChannelIds:[],tannerDirectMessages:true}});
  for(const change of [{GARY_CONVERSATION_RUNTIME_RELEASE:undefined},{GARY_CONVERSATION_RUNTIME_RELEASE:'main'},
    {GARY_RUNTIME_MODE:'legacy'},{GARY_RUNTIME_MODE:'hermes-readonly-canary'},{GARY_READONLY_SLACK_RELEASE_COMMIT:'b'.repeat(40)},
    {GARY_SLACK_ENABLED:'0'},{GARY_SLACK_TANNER_DM_ENABLED:'0'},{GARY_SLACK_ALLOWED_CHANNEL_IDS:'C0123456789'},
    {GARY_SLACK_SHARED_CONVERSATION_CONFIG:env.GARY_SLACK_CONVERSATION_CONFIG},{GARY_EXECUTOR_IMAGE:READONLY_IMAGE}])
    expect(()=>loadHostStartupConfig({...env,...change})).toThrow();
});
test('shared-only runtime needs pinned explicit configuration and grants no private DM access',()=>{
  const env={...canary,GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:'/private/runtime/slack.env',
    GARY_SLACK_SHARED_CONVERSATION_CONFIG:'/private/shared/conversation.json',GARY_CONVERSATION_RUNTIME_RELEASE:'c'.repeat(40)};
  expect(loadHostStartupConfig(env).slack?.tannerDirectMessages).toBeUndefined();
  expect(()=>loadHostStartupConfig({...env,GARY_SLACK_TANNER_DM_ENABLED:'1'})).toThrow();
  expect(()=>loadHostStartupConfig({...env,GARY_SLACK_SHARED_CONVERSATION_CONFIG:undefined})).toThrow();
});

test('project tools require a separate exact configuration hash inside the reviewed combined runtime',()=>{
 const env={...canary,GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:'/private/runtime/slack.env',GARY_SLACK_SHARED_CONVERSATION_CONFIG:'/private/shared/config.json',GARY_CONVERSATION_RUNTIME_RELEASE:'c'.repeat(40),GARY_PROJECT_ASSISTANT_CONFIG:'/private/project/config.json',GARY_PROJECT_ASSISTANT_CONFIG_SHA256:'d'.repeat(64)};
 expect(loadHostStartupConfig(env).projectAssistantConfigPath).toBe(env.GARY_PROJECT_ASSISTANT_CONFIG);
 for(const change of [{GARY_PROJECT_ASSISTANT_CONFIG:undefined},{GARY_PROJECT_ASSISTANT_CONFIG_SHA256:undefined},{GARY_PROJECT_ASSISTANT_CONFIG_SHA256:'main'},{GARY_PROJECT_ASSISTANT_CONFIG:'relative.json'},{GARY_CONVERSATION_RUNTIME_RELEASE:undefined},{GARY_RUNTIME_MODE:'legacy'}])expect(()=>loadHostStartupConfig({...env,...change})).toThrow();
});

test('alert intake needs its own exact configuration hash and pinned combined runtime',()=>{
 const env={...canary,GARY_SLACK_ENABLED:'1',GARY_SLACK_CREDENTIALS_FILE:'/private/runtime/slack.env',GARY_SLACK_SHARED_CONVERSATION_CONFIG:'/private/shared/config.json',GARY_CONVERSATION_RUNTIME_RELEASE:'c'.repeat(40),GARY_SLACK_ALERT_CONFIG:'/private/alerts/config.json',GARY_SLACK_ALERT_CONFIG_SHA256:'d'.repeat(64)};
 expect(loadHostStartupConfig(env)).toMatchObject({slackAlertConfigPath:env.GARY_SLACK_ALERT_CONFIG,slackAlertConfigSha256:env.GARY_SLACK_ALERT_CONFIG_SHA256});
 for(const change of [{GARY_SLACK_ALERT_CONFIG:undefined},{GARY_SLACK_ALERT_CONFIG_SHA256:undefined},{GARY_SLACK_ALERT_CONFIG_SHA256:'main'},
  {GARY_SLACK_ALERT_CONFIG:'relative.json'},{GARY_CONVERSATION_RUNTIME_RELEASE:undefined},{GARY_RUNTIME_MODE:'legacy'},{GARY_SLACK_ENABLED:'0'}])expect(()=>loadHostStartupConfig({...env,...change})).toThrow();
});
