import { SwarmError, errorMessage } from "../errors.js";
import type { AgentProvider, ProviderRequest, ProviderResponse } from "./types.js";

export interface FailoverCandidate {
  name: string;
  model?: string;
  timeoutMs: number;
  toolCalling: boolean;
  fileEditing: boolean;
  costAllowed?: boolean;
  create(): AgentProvider;
}

const RECOVERABLE = new Set([
  "http",
  "timeout",
  "malformed",
  "tool_limit",
  "tool_loop",
  "context_limit",
  "missing_secret",
  "unknown_provider",
]);

/** One attempt per configured candidate, sharing a deadline and the existing worktree. */
export class FailoverProvider implements AgentProvider {
  readonly name: string;
  readonly model?: string;
  readonly capabilities: AgentProvider["capabilities"];

  constructor(
    private readonly primary: AgentProvider,
    private readonly candidates: FailoverCandidate[],
    private readonly cooldowns: Map<string, number>,
    private readonly redact: (text: string) => string,
  ) {
    this.name = primary.name;
    this.model = primary.model;
    this.capabilities = primary.capabilities;
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const deadline = Date.now() + (request.totalTimeoutMs ?? request.timeoutMs ?? 120000);
    const failures: string[] = [];
    let previous = this.name;
    for (let index = 0; index < this.candidates.length; index++) {
      request.signal?.throwIfAborted();
      const candidate = this.candidates[index]!;
      const key = `${candidate.name}:${candidate.model ?? ""}`;
      let reason: string | undefined;
      if (candidate.costAllowed === false) reason = "blocked by local/free-only cost policy";
      if ((this.cooldowns.get(key) ?? 0) > Date.now())
        reason = "provider is cooling down after a recent failure";
      if (request.tools?.length && this.candidates[0]!.fileEditing && !candidate.fileEditing)
        reason = "candidate cannot preserve the required file-editing capability";
      if (reason) {
        failures.push(`${candidate.name}: ${reason}`);
        request.onFailover?.({ from: candidate.name, to: null, reason });
        continue;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      // Reserve time for every remaining candidate rather than exhausting the turn on the first.
      const budget = Math.max(1, Math.floor(remaining / (this.candidates.length - index)));
      const timeout = AbortSignal.timeout(budget);
      const signal = request.signal ? AbortSignal.any([request.signal, timeout]) : timeout;
      if (index > 0)
        request.onFailover?.({
          from: previous,
          to: candidate.name,
          reason: failures.at(-1) ?? "configured fallback",
        });
      let observed = false;
      const pendingTools = new Set<Promise<unknown>>();
      const started = Date.now();
      const onCall: ProviderRequest["onCall"] = (call) => {
        observed = true;
        request.onCall?.(call);
      };
      try {
        const provider = index === 0 ? this.primary : candidate.create();
        const response = await new Promise<ProviderResponse>((resolve, reject) => {
          const abort = () =>
            reject(new SwarmError("Provider attempt deadline exceeded", "timeout", true));
          signal.addEventListener("abort", abort, { once: true });
          const attempted = Promise.resolve().then(() =>
            provider.complete({
              ...request,
              signal,
              onCall,
              prompt:
                index === 0
                  ? request.prompt
                  : `${request.prompt}\n\nA previous provider attempt failed. Its partial edits may remain in the assigned worktree. Inspect current files before continuing; preserve valid work and the original scope and checks.`,
              tools: request.tools?.map((tool) => ({
                ...tool,
                execute: async (args) => {
                  signal.throwIfAborted();
                  const pending = tool.execute(args);
                  pendingTools.add(pending);
                  try {
                    return await pending;
                  } finally {
                    pendingTools.delete(pending);
                  }
                },
              })),
              timeoutMs: Math.min(
                candidate.timeoutMs,
                request.timeoutMs ?? candidate.timeoutMs,
                budget,
              ),
            }),
          );
          attempted.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
        });
        request.validateResponse?.(response);
        if (!observed)
          onCall({
            provider: response.provider,
            model: response.model,
            durationMs: Date.now() - started,
            usage: response.usage,
          });
        this.cooldowns.delete(key);
        return response;
      } catch (error) {
        // Never let old tool operations race a replacement provider in the same checkout.
        await Promise.allSettled([...pendingTools]);
        if (request.signal?.aborted) throw error;
        const failure = timeout.aborted
          ? new SwarmError("Provider attempt deadline exceeded", "timeout", true)
          : error;
        if (!(failure instanceof SwarmError) || !RECOVERABLE.has(failure.code)) throw failure;
        const reason = this.redact(errorMessage(failure)).slice(0, 1500);
        if (!observed)
          onCall({
            provider: candidate.name,
            model: candidate.model,
            durationMs: Date.now() - started,
            error: reason,
          });
        this.cooldowns.set(key, Date.now() + 60000);
        failures.push(`${candidate.name}: ${reason}`);
        previous = candidate.name;
      }
    }
    const reason = this.redact(
      `All configured providers failed or are unavailable: ${failures.join("; ")}`,
    );
    request.onFailover?.({ from: previous, to: null, reason });
    throw new SwarmError(reason, "providers_exhausted");
  }
}
