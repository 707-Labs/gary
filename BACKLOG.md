# Backlog

Things we want to build into Gary but haven't yet. Order roughly by priority,
not by size. Items move out of here into actual work when picked up.

---

## Multi-model support

**Goal:** route different handlers to different LLM providers. Currently
everything goes through `src/adapters/glm.ts` (Z.ai's GLM-4.6 via Anthropic SDK
shim). I want to use my OpenAI and Kimi (Moonshot) subscriptions too — partly
for cost/quality tuning per task, partly because I'm paying for them anyway.

### Shape

One `ModelClient` interface, three concrete implementations:
- `GLMClient` — current; Z.ai endpoint, Anthropic SDK shim, GLM-4.6
- `OpenAIClient` — `api.openai.com`, OpenAI SDK, GPT-5 family
- `MoonshotClient` — `api.moonshot.cn` (OpenAI-compatible), OpenAI SDK with
  `baseURL` override, Kimi K2 / latest

Routing via env, picked at call time:
- `GARY_CLASSIFIER_MODEL=gpt-5-mini` (cheap, fast — runs on every poll)
- `GARY_CODE_MODEL=glm-4.6` (current — works well for tool-calling)
- `GARY_ANSWER_MODEL=kimi-latest` (long-context, deep reads)
- `GARY_CI_MODEL=glm-4.6`

Each handler resolves `ModelClient` from a registry keyed by model name. Model
name → provider mapping lives in `src/adapters/models.ts` or similar. Don't
make the user hand-pick provider in env — infer from the model name.

### Open questions

- **Fallback chain?** e.g. try GLM → fall back to GPT-5 on rate-limit. Probably
  not worth it for v1; adds retry/observability surface for marginal benefit.
  Revisit if Z.ai turns out to be flaky.
- **Reasoning models** (o3/o4-mini, GPT-5 thinking, Kimi K2 thinking) — useful
  for classification of ambiguous tickets? Or just slower/more expensive?
- **Tool-calling parity** — confirm both OpenAI and Moonshot expose a
  tool-calling API that the agent loop can drive. The agent loop currently
  speaks Anthropic's `tool_use` / `tool_result` content blocks; will need an
  abstraction layer or per-client message-format adapter.
- **Streaming** — current loop is non-streaming. Keep it that way for v1.

### Effort

~200-300 LOC plus tests. Refactor of `src/agent/loop.ts` to take a
`ModelClient` instead of importing GLM directly. Touches every handler call
site (one line each).

### Non-goals (for v1)

- Auto cost-based routing
- Per-ticket dynamic model selection
- Streaming
- Local models / Ollama

---

## (room for more)
