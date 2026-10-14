// providers.ts — one Vercel AI SDK provider instance per provider, pointed at the Three.dev
// gateway. This is the whole integration: the rest of the app is ordinary AI SDK code.
//
// Each instance keeps the app's own provider key (apiKey) and changes two things:
//   - baseURL: the gateway path for that provider (see the table in the README)
//   - headers: x-three-api-key, x-three-use-case and x-three-ai-provider, sent on every
//     request made with the instance. The session id is sent per call (see index.ts).
//
// Use a provider instance (createOpenAI, createAnthropic, ...), not the default export
// (`import { openai } from "@ai-sdk/openai"`): the default export cannot carry the headers.

import { createAnthropic } from "@ai-sdk/anthropic";
import { createAzure } from "@ai-sdk/azure";
import { createGoogle } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

/** One provider the app talks to, with the models its conversation uses. */
export interface ProviderTarget {
  /** Label printed in the output. */
  name: string;
  /** Model used for the three calls (generateText, streamText, tool loop). */
  model: LanguageModel;
  /** Azure only: a Chat Completions model on deployment URLs, run once when set. */
  deploymentChatModel?: LanguageModel;
}

function env(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function requireEnv(name: string): string {
  const value = env(name);
  if (!value) throw new Error(`Missing required env var: ${name} (see .env.example)`);
  return value;
}

// The per-provider paths are appended to these URLs, so a path here (e.g. the /v1 that
// the OpenAI SDK example puts in THREE_GATEWAY_URL) would produce URLs like /v1/v1.
function originOnly(name: string, value: string, example: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${name} is not a valid URL: ${value}`);
  }
  if (url.pathname !== "/" || url.search || url.hash) {
    throw new Error(`${name} must have no path, e.g. ${example} (got ${value})`);
  }
  return url.origin;
}

/** Build the provider instances for every provider whose keys are set in .env. */
export function loadProviders(): { targets: ProviderTarget[]; skipped: string[] } {
  const gateway = originOnly(
    "THREE_GATEWAY_URL",
    env("THREE_GATEWAY_URL") ?? "https://gate.three.dev",
    "https://gate.three.dev",
  );

  // Headers shared by every provider; x-three-ai-provider is added per provider below.
  const three = {
    "x-three-api-key": requireEnv("THREE_API_KEY"),
    "x-three-use-case": requireEnv("USE_CASE_SLUG"),
  };

  const targets: ProviderTarget[] = [];
  const skipped: string[] = [];

  // OpenAI — openai(model) uses the Responses API; openai.chat(model) Chat Completions.
  const openaiKey = env("OPENAI_API_KEY");
  if (openaiKey) {
    const openai = createOpenAI({
      apiKey: openaiKey,
      baseURL: `${gateway}/v1`,
      headers: { ...three, "x-three-ai-provider": "openai" },
    });
    targets.push({ name: "openai", model: openai(env("OPENAI_MODEL") ?? "gpt-5.4-mini") });
  } else {
    skipped.push("openai (OPENAI_API_KEY not set)");
  }

  // Anthropic — the baseURL includes /v1, unlike the Anthropic SDK's.
  const anthropicKey = env("ANTHROPIC_API_KEY");
  if (anthropicKey) {
    const anthropic = createAnthropic({
      apiKey: anthropicKey,
      baseURL: `${gateway}/v1`,
      headers: { ...three, "x-three-ai-provider": "anthropic" },
    });
    targets.push({
      name: "anthropic",
      model: anthropic(env("ANTHROPIC_MODEL") ?? "claude-haiku-5-5"),
    });
  } else {
    skipped.push("anthropic (ANTHROPIC_API_KEY not set)");
  }

  // Gemini — the baseURL ends in /v1beta and the provider value is "gemini".
  const googleKey = env("GOOGLE_GENERATIVE_AI_API_KEY");
  if (googleKey) {
    const google = createGoogle({
      apiKey: googleKey,
      baseURL: `${gateway}/v1beta`,
      headers: { ...three, "x-three-ai-provider": "gemini" },
    });
    targets.push({ name: "gemini", model: google(env("GOOGLE_MODEL") ?? "gemini-3.8-flash") });
  } else {
    skipped.push("gemini (GOOGLE_GENERATIVE_AI_API_KEY not set)");
  }

  // OpenRouter — through the OpenAI-compatible provider; the gateway needs OpenRouter's
  // own base URL in x-three-ai-provider-baseurl.
  const openrouterKey = env("OPENROUTER_API_KEY");
  if (openrouterKey) {
    const openrouter = createOpenAICompatible({
      name: "openrouter",
      apiKey: openrouterKey,
      baseURL: `${gateway}/v1`,
      headers: {
        ...three,
        "x-three-ai-provider": "openrouter",
        "x-three-ai-provider-baseurl": "https://openrouter.ai/api/v1",
      },
    });
    targets.push({
      name: "openrouter",
      model: openrouter(env("OPENROUTER_MODEL") ?? "qwen/qwen3.8-27b"),
    });
  } else {
    skipped.push("openrouter (OPENROUTER_API_KEY not set)");
  }

  // Azure OpenAI — the model is the deployment name, and AZURE_ENDPOINT is the resource
  // address with no path (https://<resource>.openai.azure.com).
  const azureKey = env("AZURE_API_KEY");
  const azureEndpointValue = env("AZURE_ENDPOINT");
  const azureDeployment = env("AZURE_DEPLOYMENT");
  if (azureKey && azureEndpointValue && azureDeployment) {
    const azureEndpoint = originOnly(
      "AZURE_ENDPOINT",
      azureEndpointValue,
      "https://<resource>.openai.azure.com",
    );

    // v1 URLs: azure(deployment) uses the Responses API; azure.chat(deployment) Chat
    // Completions.
    const azure = createAzure({
      apiKey: azureKey,
      baseURL: `${gateway}/v1`,
      headers: {
        ...three,
        "x-three-ai-provider": "azure_openai",
        "x-three-ai-provider-baseurl": `${azureEndpoint}/openai/v1`,
      },
    });

    // Deployment URLs, only when AZURE_API_VERSION is set. It is an Azure API version such
    // as 2025-04-01-preview, not the model version; a wrong value gets 404 from Azure.
    const apiVersion = env("AZURE_API_VERSION");
    const azureDeployments = apiVersion
      ? createAzure({
          apiKey: azureKey,
          baseURL: `${gateway}/openai`,
          useDeploymentBasedUrls: true,
          apiVersion,
          headers: {
            ...three,
            "x-three-ai-provider": "azure_openai",
            "x-three-ai-provider-baseurl": azureEndpoint,
          },
        })
      : undefined;

    targets.push({
      name: "azure",
      model: azure(azureDeployment),
      deploymentChatModel: azureDeployments?.chat(azureDeployment),
    });
  } else {
    skipped.push("azure (AZURE_API_KEY, AZURE_ENDPOINT and AZURE_DEPLOYMENT not all set)");
  }

  return { targets, skipped };
}
