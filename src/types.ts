export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
  raw_args?: string;
  argument_error?: string;
}
export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens?: number;
  cache_write_1h_tokens?: number;
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  model?: string;
  request_model?: string;
  content: string;
  attachments?: MediaAttachment[];
  shell?: { command: string; output: string; exit_code: number };
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  status?: 'success' | 'error';
  display?: string;
  /** Long pastes that `display` shows folded as `[Pasted text #N]`, by number. */
  pastes?: Record<string, string>;
  provider_content?: unknown[];
  usage?: Usage;
  cost?: import('./pricing.js').PriceReceipt;
  internal?: string;
  truncated?: boolean;
  recoverable?: boolean;
  legacy_data?: { type: string; data: Record<string, unknown> };
}
export type Effect = 'read' | 'write' | 'execute' | 'unknown';
export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  effect: Effect;
  approval?: boolean;
  run(args: Record<string, unknown>, context: ToolContext): Promise<string>;
}
export interface ToolContext {
  signal: AbortSignal;
  sessionId: string;
  emitAttachments?: (attachments: MediaAttachment[]) => void;
}
export interface MediaAttachment {
  kind: 'image' | 'document';
  mime_type:
    'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | 'application/pdf';
  filename: string;
  data: string;
  sha256: string;
}
export interface ModelRequest {
  system: string;
  messages: Message[];
  tools: Tool[];
  signal: AbortSignal;
  token: (text: string, thinking?: boolean) => void;
  progress?: (
    kind: 'connected' | 'keepalive' | 'text' | 'thinking' | 'tool' | 'usage',
  ) => void;
  notice?: (event: ModelNotice) => void;
}
export interface ModelNotice {
  event: string;
  [key: string]: unknown;
}
export interface ModelResponse {
  message: Message;
  usage: Usage;
}
export interface ChatModel {
  model: string;
  contextWindow?: number;
  outputBudget?: number;
  modelFacts?: import('./model_catalog.js').ModelFacts;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
export const emptyUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
});
export function addUsage(target: Usage, source: Usage): void {
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_write_tokens',
    'cache_write_1h_tokens',
  ] as const) {
    if (source[key] !== undefined)
      target[key] = (target[key] ?? 0) + source[key]!;
  }
}
