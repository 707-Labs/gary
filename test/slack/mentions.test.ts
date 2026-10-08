import { expect,test } from 'bun:test';
import { hasSlackUserMention } from '../../src/slack/mentions.ts';
const id='U0C7NPEUG1F';
test('canonical and labeled mentions trigger only the exact user ID',()=>{
  for(const text of [`<@${id}>`,`hello <@${id}|Gary> status`,`<@U0OTHER11> <@${id}|Gary the bot>`,`<@${id}|Gary 🐙>`])expect(hasSlackUserMention(text,id)).toBe(true);
});
test('suffixes, spoofed labels, malformed and nested tokens cannot trigger',()=>{
  for(const text of [`<@${id}X>`,`<@${id.slice(0,-1)}>`,`<@U0OTHER11|${id}>`,`<@${id.toLowerCase()}>`,`<@${id}|>`,
    `<@${id}| >`,`<@${id}|Gary|admin>`,`<@${id}|Gary\nadmin>`,`<@${id}|${'x'.repeat(81)}>`,`<@${id}`,
    `<<@${id}>>`,`<@U0OTHER11|<@${id}>>`,`&lt;@${id}&gt;`,`<@${id} |Gary>`,`<＠${id}>`, '@Gary'])expect(hasSlackUserMention(text,id)).toBe(false);
  expect(hasSlackUserMention(`<@${id}>`,id+'|Gary')).toBe(false);
});
