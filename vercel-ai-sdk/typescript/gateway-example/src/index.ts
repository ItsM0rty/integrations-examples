// index.ts — a small weather assistant built on the Vercel AI SDK. Every LLM call goes
// through the Three.dev gateway (wired in providers.ts) and is recorded there.
//
// For each provider with keys in .env, the app runs one conversation of three calls:
// generateText, streamText and a tool loop. The three calls share one session id, sent
// per call as x-three-session-id, so each conversation is one session in Three.dev.
// Run with `task run` / `npm start`.

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { generateText, isStepCount, streamText } from "ai";
import { loadProviders, type ProviderTarget } from "./providers.js";
import { getWeather } from "./tools.js";

// Load .env when present (Node 22+). Variables already set in the environment win.
if (existsSync(".env")) process.loadEnvFile(".env");

const instructions = "You are a concise weather assistant. Answer in one or two sentences.";

/** The first words of an answer, for a one-line summary. */
function preview(text: string, words = 12): string {
  const parts = text.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "(no text)";
  return parts.slice(0, words).join(" ") + (parts.length > words ? " …" : "");
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function runConversation({ name, model, deploymentChatModel }: ProviderTarget) {
  // One session id per conversation. Headers passed per call merge with the provider
  // instance's headers, and the per-call value wins.
  const sessionId = randomUUID();
  const headers = { "x-three-session-id": sessionId };
  console.log(`\n[${name}] session ${sessionId}`);

  // 1. generateText
  const first = await generateText({
    model,
    instructions,
    prompt: "In one sentence, what should I pack for a spring weekend in Paris?",
    headers,
  });
  console.log(`[${name}] generateText: ${preview(first.text)}`);

  // 2. streamText, printed as it streams. textStream does not throw on errors, so keep the
  //    one reported to onError and rethrow it once the stream ends.
  let streamError: unknown;
  const stream = streamText({
    model,
    instructions,
    prompt: "Give me one tip for staying cool on a hot day in Madrid.",
    headers,
    onError: ({ error }) => {
      streamError = error;
    },
  });
  process.stdout.write(`[${name}] streamText: `);
  for await (const delta of stream.textStream) process.stdout.write(delta);
  process.stdout.write("\n");
  if (streamError) throw streamError;

  // 3. Tool loop — the model calls get_weather for each city, then answers.
  const loop = await generateText({
    model,
    instructions,
    prompt: "Which is warmer right now, Paris or Lisbon? Use the weather tool.",
    tools: { get_weather: getWeather },
    stopWhen: isStepCount(5),
    headers,
  });
  const toolCalls = loop.steps.flatMap((step) => step.toolCalls).length;
  console.log(`[${name}] tool loop (${toolCalls} tool calls): ${preview(loop.text)}`);

  // Azure only: one Chat Completions call on deployment URLs, in the same session.
  if (deploymentChatModel) {
    const chat = await generateText({
      model: deploymentChatModel,
      instructions,
      prompt: "Is Lisbon usually warm in May? Answer in one sentence.",
      headers,
    });
    console.log(`[${name}] generateText (deployment URLs, Chat Completions): ${preview(chat.text)}`);
  }
}

async function main(): Promise<void> {
  const { targets, skipped } = loadProviders();
  for (const line of skipped) console.log(`skipping ${line}`);
  if (targets.length === 0) {
    console.error("No provider keys set — add at least one to .env (see .env.example).");
    process.exitCode = 1;
    return;
  }

  const failed: string[] = [];
  for (const target of targets) {
    try {
      await runConversation(target);
    } catch (err) {
      failed.push(target.name);
      console.error(`[${target.name}] failed: ${errorMessage(err)}`);
    }
  }

  // process.exitCode instead of process.exit(), so piped output is not cut off.
  if (failed.length > 0) {
    console.error(`\nFailed: ${failed.join(", ")}.`);
    process.exitCode = 1;
  }
  if (failed.length < targets.length) {
    console.log(
      `\nDone. In Three.dev, open the use case "${process.env.USE_CASE_SLUG}": each call is on its ` +
        "Requests page, and each provider's conversation is one session on its Sessions page.",
    );
  }
}

main().catch((err) => {
  console.error(errorMessage(err));
  process.exitCode = 1;
});
