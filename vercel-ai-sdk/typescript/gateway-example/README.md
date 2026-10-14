# Three.dev Gateway for the Vercel AI SDK (TypeScript)

Record every LLM call of an app built on the [Vercel AI SDK](https://ai-sdk.dev) in
Three.dev. The app keeps its own provider keys and its AI SDK code; only the provider
instances change: each one points its `baseURL` at the Three.dev gateway and carries a few
`x-three-*` headers. The gateway forwards each call to the provider and records it.

This example is a small weather assistant. For each provider with keys in `.env` (OpenAI,
Anthropic, Gemini, OpenRouter, Azure OpenAI) it runs one conversation of three calls —
`generateText`, `streamText` and a tool loop — and groups the conversation into one
session in Three.dev.

## How it works

**1. Create provider instances that point at the gateway.** Use a provider instance
(`createOpenAI`, `createAnthropic`, ...), not the default export
(`import { openai } from "@ai-sdk/openai"`): the default export cannot carry the headers,
and pointing `OPENAI_BASE_URL` at the gateway with it is refused with
`401 invalid_api_key`.

```ts
const gateway = "https://gate.three.dev";

const openai = createOpenAI({
  apiKey: process.env.OPENAI_API_KEY,          // your own OpenAI key
  baseURL: `${gateway}/v1`,
  headers: {
    "x-three-api-key": process.env.THREE_API_KEY!,
    "x-three-use-case": process.env.USE_CASE_SLUG!,
    "x-three-ai-provider": "openai",
  },
});
```

**2. Send the session id per call.** Headers passed to `generateText` / `streamText`
merge with the instance's headers, and the per-call value wins. That is how one instance
serves many conversations, each with its own session id:

```ts
const headers = { "x-three-session-id": sessionId }; // one per conversation

await generateText({ model: openai("gpt-5.4-mini"), prompt, headers });
```

All of it is in [`src/providers.ts`](./src/providers.ts) and
[`src/index.ts`](./src/index.ts).

## Provider wiring

Every instance sends `x-three-api-key`, `x-three-use-case` and `x-three-ai-provider`;
`<gateway>` is `THREE_GATEWAY_URL` (default `https://gate.three.dev`).

| Package | Factory | `baseURL` | `x-three-ai-provider` | Extra header |
|---|---|---|---|---|
| `@ai-sdk/openai` | `createOpenAI` | `<gateway>/v1` | `openai` | none |
| `@ai-sdk/anthropic` | `createAnthropic` | `<gateway>/v1` | `anthropic` | none |
| `@ai-sdk/google` | `createGoogle` | `<gateway>/v1beta` | `gemini` | none |
| `@ai-sdk/openai-compatible` (OpenRouter) | `createOpenAICompatible({ name: "openrouter" })` | `<gateway>/v1` | `openrouter` | `x-three-ai-provider-baseurl: https://openrouter.ai/api/v1` |
| `@ai-sdk/azure`, v1 URLs | `createAzure` | `<gateway>/v1` | `azure_openai` | `x-three-ai-provider-baseurl: <AZURE_ENDPOINT>/openai/v1` |
| `@ai-sdk/azure`, deployment URLs | `createAzure({ useDeploymentBasedUrls: true, apiVersion })` | `<gateway>/openai` | `azure_openai` | `x-three-ai-provider-baseurl: <AZURE_ENDPOINT>` |

Things to know:

- **Anthropic:** the `baseURL` includes `/v1`. This differs from the Anthropic SDK, whose
  base URL has no `/v1`.
- **OpenAI and Azure APIs:** `openai(model)` uses the Responses API and
  `openai.chat(model)` uses Chat Completions; both are recorded in full. The same goes for
  `azure(deployment)` and `azure.chat(deployment)`.
- **Azure:** `AZURE_ENDPOINT` is the resource address with no path
  (`https://<resource>.openai.azure.com`), and the model is the deployment name.
  `AZURE_API_VERSION` is used only with deployment URLs. It is an Azure API version such
  as `2025-04-01-preview` (the value after `api-version=` in the deployment's Target URI),
  not the model version. Azure answers a wrong value with `404 Resource not found`.
- **Embeddings:** `embed` / `embedMany` go through the gateway, but they are recorded
  without messages, tokens or cost.

## What the app does

For each provider with keys in `.env` (the others are skipped with one line saying so):

1. `generateText` with a short prompt,
2. `streamText`, printing the text as it streams,
3. a tool loop: a mock `get_weather` tool ([`src/tools.ts`](./src/tools.ts), `tool()`
   with a zod `inputSchema`) and `stopWhen: isStepCount(5)`, asking which of two cities is
   warmer.

The three calls share one session id (`crypto.randomUUID()`), so each provider's
conversation is one session in Three.dev. For Azure, the three calls use v1 URLs; when
`AZURE_API_VERSION` is set, one more Chat Completions call uses deployment URLs, in the
same session.

The app prints one short line per call (provider, call, first words of the answer). It
never prints keys or request headers.

## Prerequisites

- Node.js 22+ (required by `ai` v7)
- [Task](https://taskfile.dev) (optional)
- A Three.dev API key (`r3_sk_...`)
- An API key for at least one of the providers

## Setup

```bash
cp .env.example .env
# Edit .env: THREE_API_KEY, USE_CASE_SLUG and the keys of the providers you want to run
```

| Variable | Required | Description |
|---|---|---|
| `THREE_API_KEY` | Yes | Three.dev API key (`r3_sk_...`), sent as `x-three-api-key` |
| `USE_CASE_SLUG` | Yes | Use case slug, sent as `x-three-use-case`. A new slug is created on its first request (up to 20 per organization) |
| `THREE_GATEWAY_URL` | No | Gateway base URL, no path (default: `https://gate.three.dev`) |
| `OPENAI_API_KEY` / `OPENAI_MODEL` | No | OpenAI key and model (default: `gpt-5.4-mini`) |
| `ANTHROPIC_API_KEY` / `ANTHROPIC_MODEL` | No | Anthropic key and model (default: `claude-haiku-5-5`) |
| `GOOGLE_GENERATIVE_AI_API_KEY` / `GOOGLE_MODEL` | No | Gemini key and model (default: `gemini-3.8-flash`) |
| `OPENROUTER_API_KEY` / `OPENROUTER_MODEL` | No | OpenRouter key and model (default: `qwen/qwen3.8-27b`) |
| `AZURE_API_KEY` / `AZURE_ENDPOINT` / `AZURE_DEPLOYMENT` | No | Azure OpenAI key, resource address (no path) and deployment name; all three are needed |
| `AZURE_API_VERSION` | No | Azure API version for the deployment-URL call, e.g. `2025-04-01-preview`; leave empty to skip that call |

## Running the example

```bash
task run
```

This installs dependencies, creates `.env` from `.env.example` if needed, and runs the
example. Without Task, use `npm install && npm start`. `task typecheck` type-checks the
code.

## What to verify in Three.dev

Open the use case (`USE_CASE_SLUG`) in Three.dev:

- **Requests:** one request per call, with the provider, model, messages, tokens and cost.
  The tool loop shows one request per step.
- **Sessions:** one session per provider, holding that provider's calls (the app prints
  each session id).

## Using ai v6

The same wiring works with `ai` v6 (`ai` 6.x, provider packages 3.x,
`@ai-sdk/openai-compatible` 2.x). The only differences in this example:

| v7 | v6 |
|---|---|
| `createGoogle` | `createGoogleGenerativeAI` |
| `isStepCount(5)` | `stepCountIs(5)` |
| `instructions: "..."` | `system: "..."` |

## Design

- **Your own provider keys** — each provider instance keeps its `apiKey`; the gateway
  forwards it to the provider and records the call.
- **The integration is only the provider instances** — `baseURL` plus the `x-three-*`
  headers, all in `src/providers.ts`. The `generateText` / `streamText` calls in
  `src/index.ts` are ordinary AI SDK code.
- **Session id per call** — one provider instance serves every conversation; each
  conversation passes its own `x-three-session-id` in the call's `headers`.
- **Fail fast on misconfiguration** — `THREE_GATEWAY_URL` and `AZURE_ENDPOINT` must have
  no path, so a value like `https://gate.three.dev/v1` is rejected instead of producing
  `/v1/v1` URLs.

## Project structure

```
├── src/
│   ├── index.ts        # The conversation per provider: generateText, streamText, tool loop
│   ├── providers.ts    # Provider instances pointed at the gateway, built from .env
│   └── tools.ts        # Mock get_weather tool
├── .env.example        # Environment variable template
├── Taskfile.yml        # task install / task run / task typecheck
├── package.json
└── tsconfig.json
```
