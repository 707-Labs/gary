import { expect, test } from 'bun:test';
import { createConversationEngineeringCapability, hasConversationEngineeringCapability, ordinaryEngineeringScope, submitConversationEngineering } from '../../src/hermes/conversation-engineering.ts';

const audience = { surface: 'private_dm' as const, requesterId: 'UOWNER', teamId: 'TTEAM', channelId: 'DOWNER', threadTs: '123.000001' };
test('ordinary engineering recognizes direct natural requests with an explicit repository, without acceptance constraints', () => {
  for (const text of ['Fix the login bug in 707-Labs/new-app', 'Can you implement dark mode in 707-Labs/new-app?',
    'Gary, please refactor 707-Labs/new-app and add tests.', 'Please debug https://github.com/707-Labs/new-app/issues/99',
    'I need you to improve <https://github.com/707-Labs/new-app|the app>', 'Fix `src/login.ts` in 707-Labs/new-app']) {
    expect(ordinaryEngineeringScope(text)).toEqual({ repository: '707-Labs/new-app' });
  }
});
test('ambiguous, negated, quoted, historical and foreign-scope text cannot authorize work', () => {
  for (const text of ['Fix the bug', 'What is the status of 707-Labs/new-app?', 'Could we fix 707-Labs/new-app?',
    'Do not fix 707-Labs/new-app', 'Fix 707-Labs/new-app only if I approve later', 'Example: fix 707-Labs/new-app',
    'He said fix 707-Labs/new-app', 'Please explain: "Fix 707-Labs/new-app"', '> Fix 707-Labs/new-app',
    '```\nFix 707-Labs/new-app\n```', 'Fix `707-Labs/new-app`', 'Fix "707-Labs/new-app"',
    'Fix 707-Labs/one and 707-Labs/two', 'Fix 707-Labs/new-app and https://github.com/other-org/private',
    'Please review this text:\n> Fix 707-Labs/new-app', 'Fix 707-Labs/new-app; don’t execute yet',
    'Fix 707-Labs/new-app after I approve', 'Fix 707-Labs/new-app once I approve', 'Fix 707-Labs/new-app tomorrow',
    'Fix 707-Labs/new-app in 30 minutes', 'Fix 707-Labs/new-app at 4 pm', 'Fix 707-Labs/new-app on Monday',
    'Fix 707-Labs/new-app and other-org/private', 'Fix 707-Labs/new-app and other-org/private.ts', 'Fix src/login.ts in 707-Labs/new-app',
    'Fix 707-Labs/new-app in an hour', 'Fix 707-Labs/new-app in ten minutes', 'Fix 707-Labs/new-app at noon',
    'Fix 707-Labs/new-app at 4pm', 'Fix 707-Labs/new-app upon my approval', 'Fix 707-Labs/new-app in a little while',
    'Fix 707-Labs/new-app but defer execution', 'Fix 707-Labs/new-app on Oct 12', 'Fix 707-Labs/new-app two hours from now']) {
    expect(ordinaryEngineeringScope(text)).toBeNull();
  }
});
test('only the original opaque capability and exact private audience reach the host callback', async () => {
  let calls = 0;
  const capability = createConversationEngineeringCapability(audience, async repository => {
    calls++; return { ok: true, dataOnly: true, data: { repository } };
  });
  const signal = new AbortController().signal;
  expect(hasConversationEngineeringCapability(JSON.parse(JSON.stringify(capability)), audience)).toBeFalse();
  for (const changed of [{ ...audience, channelId: 'DOTHER' }, { ...audience, threadTs: '124.000001' },
    { ...audience, requesterId: 'UOTHER' }, { ...audience, teamId: 'TOTHER' }, { ...audience, surface: 'shared_channel' as const }]) {
    expect(hasConversationEngineeringCapability(capability, changed)).toBeFalse();
    expect((await submitConversationEngineering(capability, changed, '707-Labs/new-app', signal, () => {})).ok).toBeFalse();
  }
  expect((await submitConversationEngineering(capability, audience, 'other/private', signal, () => {})).ok).toBeFalse();
  expect((await submitConversationEngineering(capability, audience, '707-Labs/new-app', signal, undefined)).ok).toBeFalse();
  await expect(submitConversationEngineering(capability, audience, '707-Labs/new-app', AbortSignal.abort(), () => {})).rejects.toThrow();
  await expect(submitConversationEngineering(capability, audience, '707-Labs/new-app', signal, () => { throw Error('owner_changed'); })).rejects.toThrow('owner_changed');
  expect(calls).toBe(0);
  expect((await submitConversationEngineering(capability, audience, '707-Labs/new-app', signal, () => {})).ok).toBeTrue();
  expect(calls).toBe(1);
});
