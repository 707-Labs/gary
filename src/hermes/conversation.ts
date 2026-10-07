/** Canonical, bounded structured conversation; it grants no tool authority. */
export type ConversationMessage = Record<string, unknown>;
export const MAX_HISTORY_MESSAGES = 512;
export const MAX_HISTORY_BYTES = 524_288;
const NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const reject = (): never => { throw new Error("invalid_conversation_history"); };
export function finiteJson(value: unknown): boolean {
  const pending: unknown[] = [value];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === "number" && !Number.isFinite(item)) return false;
    if (Array.isArray(item)) for (const entry of item) pending.push(entry);
    else if (object(item)) for (const entry of Object.values(item)) pending.push(entry);
  }
  return true;
}
const stable = (value: unknown): unknown => Array.isArray(value) ? value.map(stable)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
export function canonicalArguments(value: unknown): string {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; } catch { return reject(); }
  if (!object(parsed) || !finiteJson(parsed)) return reject();
  return JSON.stringify(stable(parsed));
}
function content(value: unknown, empty = false): string {
  if (typeof value === "string") return value;
  if (empty && (value === null || value === undefined)) return "";
  if (Array.isArray(value) && value.every(block => object(block) && block.type === "text"
      && typeof block.text === "string" && Object.keys(block).every(key => ["type", "text"].includes(key)))) {
    return value.map(block => (block as { text: string }).text).join("");
  }
  return reject();
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) reject();
}
/** No system messages, implicit tool results, pending calls or repeated IDs by default. */
export function canonicalizeConversation(value: unknown, options: { requireResolved?: boolean } = {}): ConversationMessage[] {
  if (!Array.isArray(value) || value.length > MAX_HISTORY_MESSAGES || !finiteJson(value)) return reject();
  let size: number;
  try { size = Buffer.byteLength(JSON.stringify(value)); } catch { return reject(); }
  if (size > MAX_HISTORY_BYTES) return reject();
  const used = new Set<string>(), pending = new Map<string, string>();
  const result: ConversationMessage[] = [];
  for (const message of value) {
    if (!object(message)) return reject();
    if (message.role === "tool") {
      keys(message, ["role", "content", "tool_call_id", "name"]);
      if (typeof message.tool_call_id !== "string" || !pending.has(message.tool_call_id)
          || (message.name !== undefined && message.name !== pending.get(message.tool_call_id))) return reject();
      pending.delete(message.tool_call_id);
      result.push({ role: "tool", content: content(message.content), tool_call_id: message.tool_call_id });
      continue;
    }
    if (pending.size) return reject();
    if (message.role === "user") {
      keys(message, ["role", "content"]); result.push({ role: "user", content: content(message.content) });
    } else if (message.role === "assistant") {
      keys(message, ["role", "content", "tool_calls", "reasoning_content"]);
      const assistant: ConversationMessage = { role: "assistant", content: content(message.content, true) };
      if (message.reasoning_content !== undefined) {
        if (typeof message.reasoning_content !== "string") return reject();
        if (message.reasoning_content.trim()) assistant.reasoning_content = message.reasoning_content;
      }
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls) || message.tool_calls.length < 1 || message.tool_calls.length > 32) return reject();
        assistant.tool_calls = message.tool_calls.map(call => {
          if (!object(call)) return reject(); keys(call, ["id", "type", "function"]);
          if (call.type !== "function" || typeof call.id !== "string" || !ID.test(call.id)
              || used.has(call.id) || !object(call.function)) return reject();
          keys(call.function, ["name", "arguments"]);
          if (typeof call.function.name !== "string" || !NAME.test(call.function.name)
              || typeof call.function.arguments !== "string") return reject();
          used.add(call.id); pending.set(call.id, call.function.name);
          return { id: call.id, type: "function", function: { name: call.function.name,
            arguments: canonicalArguments(call.function.arguments) } };
        });
      }
      if (!assistant.content && !assistant.tool_calls) return reject();
      result.push(assistant);
    } else return reject();
  }
  if (options.requireResolved !== false && pending.size) return reject();
  if (Buffer.byteLength(JSON.stringify(result)) > MAX_HISTORY_BYTES) return reject();
  return result;
}
export const sameConversation = (left: readonly ConversationMessage[], right: readonly ConversationMessage[]): boolean => JSON.stringify(left) === JSON.stringify(right);
export const isConversationPrefix = (prefix: readonly ConversationMessage[], value: readonly ConversationMessage[]): boolean =>
  value.length >= prefix.length && sameConversation(prefix, value.slice(0, prefix.length));
