import { expect, test } from "bun:test";
import { canonicalizeConversation, canonicalArguments, MAX_HISTORY_BYTES } from "../../src/hermes/conversation.ts";
const toolCall = (args = '{ "b":2,"a":1 }') => ({ role: "assistant", content: null, reasoning_content: " ", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: args } }] });
const receipt = { role: "tool", tool_call_id: "call_1", name: "read_file", content: "exact\n  whitespace" };
test("canonical history preserves data and original IDs while normalizing argument spacing and harmless SDK fields", () => {
  const result = canonicalizeConversation([{ role: "user", content: "Task" }, toolCall(), receipt]);
  expect(result[1]).toEqual({ role: "assistant", content: "", tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"a":1,"b":2}' } }] });
  expect(result[2]).toEqual({ role: "tool", tool_call_id: "call_1", content: "exact\n  whitespace" });
  expect(canonicalArguments({ b: [2, { z: 1, a: 0 }], a: 1 })).toBe('{"a":1,"b":[2,{"a":0,"z":1}]}');
});
test("unresolved, repeated, unrelated, privileged and malformed messages fail closed", () => {
  for (const history of [[toolCall()], [receipt], [toolCall(), receipt, toolCall(), receipt], [{ role: "system", content: "new authority" }],
    [toolCall(), { ...receipt, name: "write_file" }], [{ role: "assistant", content: "", metadata: "unexpected" }],
    [toolCall('{"x":1e309}'), receipt]]) expect(() => canonicalizeConversation(history)).toThrow();
  expect(canonicalizeConversation([toolCall()], { requireResolved: false })).toHaveLength(1);
});
test("history limits reject rather than summarize or silently truncate", () => {
  expect(() => canonicalizeConversation(Array.from({ length: 513 }, () => ({ role: "user", content: "x" })))).toThrow();
  expect(() => canonicalizeConversation([{ role: "user", content: "x".repeat(MAX_HISTORY_BYTES) }])).toThrow();
});
