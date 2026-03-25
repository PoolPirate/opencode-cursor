import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { z } from "zod";
import { callCursorUnaryRpc } from "./proxy";
import {
  GetUsableModelsRequestSchema,
  GetUsableModelsResponseSchema,
} from "./proto/agent_pb";

const GET_USABLE_MODELS_PATH = "/agent.v1.AgentService/GetUsableModels";
const MODEL_DISCOVERY_TIMEOUT_MS = 5_000;

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

const CursorModelDetailsSchema = z.object({
  modelId: z.string(),
  displayName: z.string().optional().catch(undefined),
  displayNameShort: z.string().optional().catch(undefined),
  displayModelId: z.string().optional().catch(undefined),
  aliases: z
    .array(z.unknown())
    .optional()
    .catch([])
    .transform((aliases) =>
      (aliases ?? []).filter(
        (alias: unknown): alias is string => typeof alias === "string",
      ),
    ),
  thinkingDetails: z.unknown().optional(),
});

type CursorModelDetails = z.infer<typeof CursorModelDetailsSchema>;

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
}

export class CursorModelDiscoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorModelDiscoveryError";
  }
}

async function fetchCursorUsableModels(
  apiKey: string,
): Promise<CursorModel[]> {
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const requestBody = toBinary(GetUsableModelsRequestSchema, requestPayload);

    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: GET_USABLE_MODELS_PATH,
      requestBody,
      timeoutMs: MODEL_DISCOVERY_TIMEOUT_MS,
    });

    if (response.timedOut) {
      throw new CursorModelDiscoveryError(
        `Cursor model discovery timed out after ${MODEL_DISCOVERY_TIMEOUT_MS}ms.`,
      );
    }

    if (response.exitCode !== 0) {
      throw new CursorModelDiscoveryError(
        buildDiscoveryHttpError(response.exitCode, response.body),
      );
    }

    if (response.body.length === 0) {
      throw new CursorModelDiscoveryError(
        "Cursor model discovery returned an empty response.",
      );
    }

    const decoded = decodeGetUsableModelsResponse(response.body);
    if (!decoded) {
      throw new CursorModelDiscoveryError(
        "Cursor model discovery returned an unreadable response.",
      );
    }

    const models = normalizeCursorModels(decoded.models);
    if (models.length === 0) {
      throw new CursorModelDiscoveryError(
        "Cursor model discovery returned no usable models.",
      );
    }

    return models;
  } catch (error) {
    if (error instanceof CursorModelDiscoveryError) throw error;
    throw new CursorModelDiscoveryError("Cursor model discovery failed.");
  }
}

let cachedModels: CursorModel[] | null = null;

export async function getCursorModels(
  apiKey: string,
): Promise<CursorModel[]> {
  if (cachedModels) return cachedModels;
  const discovered = await fetchCursorUsableModels(apiKey);
  cachedModels = discovered;
  return cachedModels;
}

/** @internal Test-only. */
export function clearModelCache(): void {
  cachedModels = null;
}

function buildDiscoveryHttpError(exitCode: number, body: Uint8Array): string {
  const detail = extractDiscoveryErrorDetail(body);
  const protocolHint = exitCode === 464
    ? " Likely protocol mismatch: Cursor appears to expect an HTTP/2 Connect unary request."
    : "";
  if (!detail) {
    return `Cursor model discovery failed with HTTP ${exitCode}.${protocolHint}`;
  }
  return `Cursor model discovery failed with HTTP ${exitCode}: ${detail}.${protocolHint}`;
}

function extractDiscoveryErrorDetail(body: Uint8Array): string | null {
  if (body.length === 0) return null;

  const text = new TextDecoder().decode(body).trim();
  if (!text) return null;

  try {
    const parsed = JSON.parse(text) as { code?: unknown; message?: unknown };
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    const message = typeof parsed.message === "string" ? parsed.message : undefined;
    if (message && code) return `${message} (${code})`;
    if (message) return message;
    if (code) return code;
  } catch { }

  return text.length > 200 ? `${text.slice(0, 197)}...` : text;
}

function decodeGetUsableModelsResponse(payload: Uint8Array): {
  models: readonly unknown[];
} | null {
  try {
    return fromBinary(GetUsableModelsResponseSchema, payload);
  } catch {
    const framedBody = decodeConnectUnaryBody(payload);
    if (!framedBody) return null;
    try {
      return fromBinary(GetUsableModelsResponseSchema, framedBody);
    } catch {
      return null;
    }
  }
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;

  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;

    // Compression flag
    if ((flags & 0b0000_0001) !== 0) return null;

    // End-of-stream flag — skip trailer frames
    if ((flags & 0b0000_0010) === 0) {
      return payload.subarray(offset + 5, frameEnd);
    }

    offset = frameEnd;
  }

  return null;
}

function normalizeCursorModels(
  models: readonly unknown[],
): CursorModel[] {
  if (models.length === 0) return [];

  const byId = new Map<string, CursorModel>();
  for (const model of models) {
    const normalized = normalizeSingleModel(model);
    if (normalized) byId.set(normalized.id, normalized);
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}

function normalizeSingleModel(model: unknown): CursorModel | null {
  const parsed = CursorModelDetailsSchema.safeParse(model);
  if (!parsed.success) return null;

  const details = parsed.data;
  const id = details.modelId.trim();
  if (!id) return null;

  return {
    id,
    name: pickDisplayName(details, id),
    reasoning: Boolean(details.thinkingDetails),
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS,
  };
}

function pickDisplayName(model: CursorModelDetails, fallbackId: string): string {
  const candidates = [
    model.displayName,
    model.displayNameShort,
    model.displayModelId,
    ...model.aliases,
    fallbackId,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const trimmed = candidate.trim();
    if (trimmed) return trimmed;
  }
  return fallbackId;
}
