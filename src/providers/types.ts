import type { ProviderCapabilities } from "../config/schema.js";

export interface ProviderUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface ProviderRequest {
  prompt: string;
  system?: string;
  cwd?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
  expectJson?: boolean;
  metadata?: Record<string, string>;
  tools?: AgentTool[];
  maxPromptChars?: number;
  totalTimeoutMs?: number;
  /** Longest Retry-After a provider should sleep through instead of failing. */
  maxRateLimitWaitMs?: number;
  validateResponse?: (response: ProviderResponse) => void;
  onFailover?: (event: { from: string; to: string | null; reason: string }) => void;
  onCall?: (call: {
    provider: string;
    model?: string;
    durationMs: number;
    usage?: ProviderUsage;
    error?: string;
  }) => void;
  onContextCompacted?: (before: number, after: number) => void;
}

export interface AgentTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: unknown): Promise<unknown>;
}

export interface ProviderResponse {
  text: string;
  structured?: unknown;
  provider: string;
  model?: string;
  usage?: ProviderUsage;
  truncated?: boolean;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
}

export interface AgentProvider {
  readonly name: string;
  readonly model?: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
