/** Fixed user-facing explanations; never interpolate a provider/worker exception. */
export function conversationFailureMessage(code: string, cleanupConfirmed: boolean, unknownSpend: boolean): string {
  if (!cleanupConfirmed) return "I couldn't confirm that the worker stopped. This thread is paused until its cleanup is verified; I won't start competing work or retry the request automatically.";
  if (unknownSpend) return "The provider's usage receipt is unresolved. This thread is paused until that request is reconciled; I won't make another paid request automatically.";
  if (code === 'dm_context_limit' || code === 'project_context_limit') {
    return "This thread is paused because the request no longer fits its context limit. Start a new thread with the question and the relevant details. This failed event and its tool actions won't be replayed automatically.";
  }
  if (code === 'project_tool_limit') return "I reached this request's tool limit before finishing the answer. This thread is paused; the completed tool actions need to be checked before continuing so they aren't repeated.";
  if (code === 'dm_budget_unavailable' || code === 'project_budget_unavailable') {
    return "I couldn't admit another request within this conversation's allocation. This thread is paused until the allocation is reviewed; I won't raise its limit or retry automatically.";
  }
  if (code === 'project_reply_rejected' || code === 'dm_reply_rejected') {
    return "The model returned an answer I couldn't verify. This thread is paused; the completed request needs review before a new continuation. I won't resend it automatically.";
  }
  return "I couldn't verify a complete reply. This thread is paused; an operator needs to check the recorded failure and completed calls before continuing. I won't repeat the request automatically.";
}
