import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  type AssistantMessage,
  type Context,
  type FauxResponseStep,
  type FauxProviderHandle,
  type Model,
  type ToolCall,
} from "@earendil-works/pi-ai";

export type ControlledResponse =
  | { text: string; delayMs?: number }
  | { toolCall: { name: string; arguments: Record<string, unknown>; id?: string }; delayMs?: number }
  | { error: string; delayMs?: number };

export type ControlledRequest = { context: Context; callNumber: number };
export type ControlledProvider = {
  provider: FauxProviderHandle["provider"];
  model: Model<string>;
  requests: ControlledRequest[];
  setResponses(responses: ControlledResponse[]): void;
  appendResponses(responses: ControlledResponse[]): void;
  close(): void;
};

function toMessage(response: ControlledResponse): AssistantMessage {
  if ("toolCall" in response) {
    const call: ToolCall = fauxToolCall(response.toolCall.name, response.toolCall.arguments, response.toolCall.id ? { id: response.toolCall.id } : {});
    return fauxAssistantMessage(call, { stopReason: "toolUse" });
  }
  if ("error" in response) return fauxAssistantMessage([], { stopReason: "error", errorMessage: response.error });
  return fauxAssistantMessage(response.text, { stopReason: "stop" });
}

export function createControlledProvider(initialResponses: ControlledResponse[] = []): ControlledProvider {
  const requests: ControlledRequest[] = [];
  const handle = fauxProvider({
    provider: "flowmate-controlled",
    api: "openai-completions",
    models: [{ id: "controlled", name: "Flowmate Controlled", reasoning: false }],
  });
  let responses = [...initialResponses];
  const factory: FauxResponseStep = (context, _options, state) => {
    requests.push({ context, callNumber: state.callCount });
    const next = responses.shift() ?? { text: "controlled provider exhausted" };
    if (!next.delayMs) return toMessage(next);
    return new Promise((resolve) => setTimeout(() => resolve(toMessage(next)), next.delayMs));
  };
  handle.setResponses(initialResponses.map(() => factory));
  return {
    provider: handle.provider,
    model: handle.getModel(),
    requests,
    setResponses(next) { responses = [...next]; handle.setResponses(next.map(() => factory)); },
    appendResponses(next) { responses.push(...next); handle.appendResponses(next.map(() => factory)); },
    // `fauxProvider` is an in-memory provider handle (unlike the registration
    // helper it intentionally has no unregister method). Releasing the runtime
    // drops all references; keeping this method makes test cleanup explicit.
    close() {},
  };
}
