import { expect, test } from 'bun:test';
import { renderSlackReplyParts, renderSlackReply, SLACK_REPLY_MAX_BYTES, SLACK_REPLY_TRUNCATED } from '../../src/slack/render.ts';

test('headings, paired Markdown bold and a pipe table become readable Slack mrkdwn',()=>{
  const result=renderSlackReply('# **Work summary**\n\n**Failed** and __blocked__ tasks\n\n| Ticket | State |\n| :--- | ---: |\n| ERT-1 | **failed** |\n| ERT-2 | paused |');
  expect(result).toBe('*Work summary*\n\n*Failed* and *blocked* tasks\n\n• Ticket: ERT-1 · State: *failed*\n• Ticket: ERT-2 · State: paused');
  expect(result).not.toContain('**');expect(result).not.toContain('| Ticket');
});
test('headings already using Slack or Markdown emphasis get exactly one outer bold span',()=>{
  for(const title of ['*Already bold*','**Already bold**','__Already bold__','_Already bold_','**__Already bold__**']) {
    expect(renderSlackReply('# '+title)).toBe('*Already bold*');
  }
  expect(renderSlackReply('## __Title__')).toBe('*Title*');
  expect(renderSlackReply('## **Strong** and __stronger__')).toBe('*Strong and stronger*');
  expect(renderSlackReply('## **Use `a__b`**')).toBe('*Use `a__b`*');
});
test('code stays literal, including Markdown and mention-like text; unfinished fences are closed',()=>{
  expect(renderSlackReply('Use **`a_b`**.\n```js\n# heading\nconst x = "**not bold** <@U123456>";\n```'))
    .toBe('Use *`a_b`*.\n```\n# heading\nconst x = "**not bold** &lt;@U123456&gt;";\n```');
  expect(renderSlackReply('~~~python\nprint("hi")')).toBe('```\nprint("hi")\n```');
});
test('links and existing user/channel mentions survive; conversion never synthesizes a mention',()=>{
  const input='[Ticket](https://example.invalid/a_b?q=1&v=2) https://example.invalid/a__b**c <https://example.invalid/t|link> <@U0A9M5W16F8> <#C0CHANNEL|name> @here <!here> &lt;@U0A9M5W16F8&gt; <bad>';
  expect(renderSlackReply(input)).toBe('<https://example.invalid/a_b?q=1&amp;v=2|Ticket> https://example.invalid/a__b**c <https://example.invalid/t|link> <@U0A9M5W16F8> <#C0CHANNEL|name> @here &lt;!here&gt; &lt;@U0A9M5W16F8&gt; &lt;bad&gt;');
  expect(renderSlackReply('[<@U0A9M5W16F8>](https://example.invalid/)')).toBe('<https://example.invalid/|&lt;@U0A9M5W16F8&gt;>');
  expect(renderSlackReply('[ping](slack://user?team=T0TEAM&id=U0USER)')).not.toContain('<@');
});
test('Markdown link destinations retain balanced and escaped parentheses without a trailing delimiter',()=>{
  expect(renderSlackReply('[parens](https://example.invalid/a_(b))')).toBe('<https://example.invalid/a_(b)|parens>');
  expect(renderSlackReply('Before [nested](https://example.invalid/a_(b_(c))?x=1&y=2), **after**.'))
    .toBe('Before <https://example.invalid/a_(b_(c))?x=1&amp;y=2|nested>, *after*.');
  expect(renderSlackReply('[escaped](https://example.invalid/a_\\(b\\)) and [next](https://example.invalid/next)'))
    .toBe('<https://example.invalid/a_(b)|escaped> and <https://example.invalid/next|next>');
  expect(renderSlackReply('`[literal](https://example.invalid/a_(b))`')).toBe('`[literal](https://example.invalid/a_(b))`');
});
test('pipes inside inline code and existing Slack links do not split table cells',()=>{
  expect(renderSlackReply('| Name | Value |\n| --- | --- |\n| code | `a|b` |\n| URL | <https://example.invalid/|label> |\n| literal | a\\|b |'))
    .toBe('• Name: code · Value: `a|b`\n• Name: URL · Value: <https://example.invalid/|label>\n• Name: literal · Value: a|b');
  expect(renderSlackReply('alpha | beta\nnot a separator')).toBe('alpha | beta\nnot a separator');
});
test('output bound is UTF-8 bytes after escaping, with an explicit non-corrupting marker',()=>{
  for(const source of ['🐌'.repeat(9_000),'&'.repeat(8_000),'<'.repeat(8_000),'é'.repeat(9_000)]) {
    const rendered=renderSlackReply(source);
    expect(Buffer.byteLength(rendered)).toBeLessThanOrEqual(SLACK_REPLY_MAX_BYTES);
    expect(rendered.endsWith(SLACK_REPLY_TRUNCATED)).toBe(true);
    expect(rendered).not.toContain('\ufffd');
    expect(rendered.slice(0,-SLACK_REPLY_TRUNCATED.length)).not.toMatch(/&(?:a|am|l|g)?$/);
  }
  expect(renderSlackReply('a'.repeat(SLACK_REPLY_MAX_BYTES))).toHaveLength(SLACK_REPLY_MAX_BYTES);
});
test('truncation closes fenced code, keeps complete links/inline code, and does not emit half an entity',()=>{
  const fenced=renderSlackReply('```\n'+'🐌 & <'.repeat(4_000)+'\n```');
  expect(Buffer.byteLength(fenced)).toBeLessThanOrEqual(SLACK_REPLY_MAX_BYTES);
  expect(fenced.match(/```/g)).toHaveLength(2);
  expect(fenced.endsWith('\n```'+SLACK_REPLY_TRUNCATED)).toBe(true);
  for(const tail of ['`'+'x'.repeat(200)+'`','<https://example.invalid/'+'x'.repeat(200)+'|link>','<@U0A9M5W16F8>']) {
    const rendered=renderSlackReply('x'.repeat(15_995)+' '+tail);
    expect(rendered).not.toContain(tail[0]==='`'?'`':'<');
    expect(rendered.endsWith(SLACK_REPLY_TRUNCATED)).toBe(true);
  }
  expect(renderSlackReply('bad \ud800 input')).toBe('bad \ufffd input');
});

test('multipart rendering preserves long code, Unicode and link boundaries with complete content and finite expansion',()=>{
  const body='🐌 const x = "<tag>";\n'.repeat(2200),source='## Code\n```js\n'+body+'```\n<https://example.invalid/long|Evidence>';
  const parts=renderSlackReplyParts(source);
  expect(parts.length).toBeGreaterThan(1);expect(parts.length).toBeLessThanOrEqual(5);
  for(const p of parts){expect(Buffer.byteLength(p)).toBeLessThanOrEqual(SLACK_REPLY_MAX_BYTES);expect(p.isWellFormed()).toBe(true);expect((p.match(/```/g)??[]).length%2).toBe(0);expect(p.endsWith('&am')).toBe(false);}
  const restored=parts.join('').replace('*Code*\n','').replace(/```\n|\n```/g,'');
  expect(restored).toBe(body.trimEnd().replace(/</g,'&lt;').replace(/>/g,'&gt;')+'\n<https://example.invalid/long|Evidence>');
  expect(()=>renderSlackReplyParts('&'.repeat(65_536))).toThrow('slack_reply_parts_limit');
  expect(renderSlackReplyParts('z'.repeat(65_536))).toHaveLength(5);
});
