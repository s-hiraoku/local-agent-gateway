import { GatewayError } from "../../domain/errors.js";
import type { PublicJob } from "../../domain/jobs.js";
import { SecretBox } from "../../infrastructure/crypto.js";

export const OPENAI_COMPATIBILITY_MODEL = "codex-subscription";

export type OpenAIResponseRequest = {
  model: typeof OPENAI_COMPATIBILITY_MODEL;
  input: string;
  instructions?: string;
  stream?: boolean;
};

export type OpenAIResponseStatus = "in_progress" | "completed" | "failed";

export function toInferencePrompt(request: OpenAIResponseRequest): string {
  if (!request.instructions) return request.input;
  return [
    "Client instructions:",
    "<client_instructions>",
    request.instructions,
    "</client_instructions>",
    "",
    "User input:",
    "<user_input>",
    request.input,
    "</user_input>"
  ].join("\n");
}

export function compatibilityIds(jobId: string, secrets: SecretBox): { responseId: string; messageId: string } {
  return {
    responseId: `resp_${secrets.digest(`openai-response:${jobId}`).slice(0, 48)}`,
    messageId: `msg_${secrets.digest(`openai-message:${jobId}`).slice(0, 48)}`
  };
}

export function responseObject(
  job: PublicJob,
  request: OpenAIResponseRequest,
  status: OpenAIResponseStatus,
  secrets: SecretBox
): Record<string, unknown> {
  const { responseId, messageId } = compatibilityIds(job.id, secrets);
  const completed = status === "completed";
  const failed = status === "failed";
  const text = completed ? job.result ?? "" : "";
  return {
    id: responseId,
    object: "response",
    created_at: Math.floor(Date.parse(job.createdAt) / 1000),
    status,
    completed_at: completed && job.completedAt ? Math.floor(Date.parse(job.completedAt) / 1000) : null,
    error: failed
      ? {
          code: job.error?.code ?? "CODEX_EXECUTION_FAILED",
          message: job.error?.message ?? "The Codex-backed response failed"
        }
      : null,
    incomplete_details: null,
    instructions: request.instructions ?? null,
    max_output_tokens: null,
    model: OPENAI_COMPATIBILITY_MODEL,
    output: completed
      ? [{
          id: messageId,
          type: "message",
          status: "completed",
          role: "assistant",
          content: [{ type: "output_text", text, annotations: [] }]
        }]
      : [],
    parallel_tool_calls: false,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    text: { format: { type: "text" } },
    tool_choice: "none",
    tools: [],
    temperature: null,
    top_p: null,
    truncation: "disabled",
    usage: null,
    user: null,
    metadata: {}
  };
}

export function openAIErrorEnvelope(error: GatewayError): Record<string, unknown> {
  const type = error.statusCode === 401
    ? "authentication_error"
    : error.statusCode === 429
      ? "rate_limit_error"
      : error.statusCode >= 500
        ? "api_error"
        : "invalid_request_error";
  return {
    error: {
      message: error.message,
      type,
      param: null,
      code: error.code
    }
  };
}
