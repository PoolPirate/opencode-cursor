import {
  createOpenAICompatible,
  type OpenAICompatibleProviderSettings,
} from "@ai-sdk/openai-compatible";

type StreamPart = {
  type: string;
  id?: string;
  [key: string]: unknown;
};

function fixInterleavingTransform(): TransformStream<StreamPart, StreamPart> {
  let textCount = 0;
  let reasoningCount = 0;
  let activeTextId: string | null = null;
  let activeReasoningId: string | null = null;

  return new TransformStream({
    transform(chunk: StreamPart, controller) {
      switch (chunk.type) {
        case "reasoning-start":
          if (activeTextId) {
            controller.enqueue({ type: "text-end", id: activeTextId });
            activeTextId = null;
          }
          activeReasoningId = `reasoning-${reasoningCount++}`;
          controller.enqueue({ ...chunk, id: activeReasoningId });
          break;

        case "reasoning-delta":
          controller.enqueue({ ...chunk, id: activeReasoningId ?? chunk.id });
          break;

        case "reasoning-end":
          controller.enqueue({ ...chunk, id: activeReasoningId ?? chunk.id });
          activeReasoningId = null;
          break;

        case "text-start":
          activeTextId = `txt-${textCount++}`;
          controller.enqueue({ ...chunk, id: activeTextId });
          break;

        case "text-delta":
          if (!activeTextId) {
            activeTextId = `txt-${textCount++}`;
            controller.enqueue({ type: "text-start", id: activeTextId });
          }
          controller.enqueue({ ...chunk, id: activeTextId });
          break;

        case "text-end":
          controller.enqueue({ ...chunk, id: activeTextId ?? chunk.id });
          activeTextId = null;
          break;

        default:
          controller.enqueue(chunk);
      }
    },
    flush(controller) {
      if (activeReasoningId) {
        controller.enqueue({ type: "reasoning-end", id: activeReasoningId });
      }
      if (activeTextId) {
        controller.enqueue({ type: "text-end", id: activeTextId });
      }
    },
  });
}

export function createCursorCompatible(
  options: OpenAICompatibleProviderSettings,
) {
  const sdk = createOpenAICompatible(options);

  function wrapLanguageModel(modelId: string) {
    const model = sdk.languageModel(modelId);
    const origDoStream = model.doStream.bind(model);

    model.doStream = async (opts: Parameters<typeof origDoStream>[0]) => {
      const result = await origDoStream(opts);
      return {
        ...result,
        stream: (result.stream as ReadableStream<StreamPart>).pipeThrough(
          fixInterleavingTransform(),
        ) as typeof result.stream,
      };
    };

    return model;
  }

  const provider = ((modelId: string) =>
    wrapLanguageModel(modelId)) as ReturnType<typeof createOpenAICompatible>;

  provider.languageModel = wrapLanguageModel;
  provider.chatModel = wrapLanguageModel;

  return provider;
}
