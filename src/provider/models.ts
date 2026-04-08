import { CURSOR_PROVIDER_ID } from "../constants";
import type { CursorModel } from "../models";
import { estimateModelCost } from "./model-cost";

const SDK_WRAPPER_PATH = new URL("../sdk-wrapper.js", import.meta.url).href;

export interface ProviderWithModels {
  models?: Record<string, unknown>;
}

export function setProviderModels(
  provider: unknown,
  models: Record<string, unknown>,
): void {
  if (!provider || typeof provider !== "object") return;
  (provider as ProviderWithModels).models = models;
}

export function buildCursorProviderModels(
  models: CursorModel[],
  port: number,
): Record<string, unknown> {
  return Object.fromEntries(
    models.map((model) => [
      model.id,
      {
        id: model.id,
        providerID: CURSOR_PROVIDER_ID,
        api: {
          id: model.id,
          url: `http://localhost:${port}/v1`,
          npm: SDK_WRAPPER_PATH,
        },
        name: model.name,
        capabilities: {
          temperature: true,
          reasoning: model.reasoning,
          attachment: false,
          toolcall: true,
          input: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          output: {
            text: true,
            audio: false,
            image: false,
            video: false,
            pdf: false,
          },
          interleaved: false,
        },
        cost: estimateModelCost(model.id),
        limit: {
          context: model.contextWindow,
          output: model.maxTokens,
        },
        status: "active" as const,
        options: {},
        headers: {},
        release_date: "",
        variants: {},
      },
    ]),
  );
}

export function buildDisabledProviderConfig(
  message: string,
): Record<string, unknown> {
  return {
    baseURL: "http://127.0.0.1/cursor-disabled/v1",
    apiKey: "cursor-disabled",
    async fetch() {
      return new Response(
        JSON.stringify({
          error: {
            message,
            type: "server_error",
            code: "cursor_model_discovery_failed",
          },
        }),
        {
          status: 503,
          headers: { "Content-Type": "application/json" },
        },
      );
    },
  };
}

export function stripAuthorizationHeader(
  init?: RequestInit,
): RequestInit | undefined {
  if (!init?.headers) return init;

  if (init.headers instanceof Headers) {
    init.headers.delete("authorization");
    return init;
  }

  if (Array.isArray(init.headers)) {
    init.headers = init.headers.filter(
      ([key]) => key.toLowerCase() !== "authorization",
    );
    return init;
  }

  delete (init.headers as Record<string, string>)["authorization"];
  delete (init.headers as Record<string, string>)["Authorization"];
  return init;
}
