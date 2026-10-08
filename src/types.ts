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
}
export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  thinking?: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
  status?: 'success' | 'error';
  display?: string;
  provider_content?: unknown[];
  usage?: Usage;
  internal?: string;
  truncated?: boolean;
  recoverable?: boolean;
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
  complete(request: ModelRequest): Promise<ModelResponse>;
}
export const emptyUsage = (): Usage => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
});
