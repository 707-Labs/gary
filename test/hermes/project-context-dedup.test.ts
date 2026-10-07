import { describe, expect, test } from 'bun:test';
import { formatProjectContext } from '../../src/skills.ts';

describe('original project context exact instruction deduplication', () => {
  test('identical loaded bodies appear once with both filenames retained', () => {
    const text = '\nKeep all exact whitespace and instructions.  \n';
    const result = formatProjectContext({ claudeMd: text, agentsMd: text, hasBeads: false }, []);
    expect(result).toBe('# CLAUDE.md and AGENTS.md (project instructions and agent guidance)\n\n' + text);
    expect(result.split(text)).toHaveLength(2);
  });
  test('case, whitespace and line-ending differences retain separate bodies and original order', () => {
    for (const agentsMd of ['Rules.\r\n', 'rules.\n', 'Rules.  \n']) {
      const result = formatProjectContext({ claudeMd: 'Rules.\n', agentsMd, hasBeads: false }, []);
      expect(result).toBe('# CLAUDE.md (project instructions)\n\nRules.\n\n\n# AGENTS.md (agent guidance)\n\n' + agentsMd);
    }
  });
  test('dedup keeps beads guidance and skill index after original instructions', () => {
    const result = formatProjectContext({ claudeMd: 'Shared rules.', agentsMd: 'Shared rules.', hasBeads: true }, [
      { name: 'fixture', description: 'Read relevant conventions.', path: '.claude/skills/fixture/SKILL.md' },
    ]);
    expect(result.split('Shared rules.')).toHaveLength(2);
    expect(result.indexOf('Shared rules.')).toBeLessThan(result.indexOf('# Beads tracker present'));
    expect(result.indexOf('# Beads tracker present')).toBeLessThan(result.indexOf('# Project skills'));
    expect(result).toContain('Never run `bd` commands that mutate state');
    expect(result).toContain('.claude/skills/fixture/SKILL.md');
  });
});
