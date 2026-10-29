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
}

export interface ProviderResponse {
  text: string;
  structured?: unknown;
  provider: string;
  model?: string;
  usage?: ProviderUsage;
  truncated?: boolean;
}

export interface AgentProvider {
  readonly name: string;
  readonly model?: string;
  readonly capabilities: ProviderCapabilities;
  complete(request: ProviderRequest): Promise<ProviderResponse>;
}
