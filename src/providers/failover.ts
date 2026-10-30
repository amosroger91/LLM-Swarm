import { SwarmError, errorMessage } from "../errors.js";
import { providerHealth, type FailureKind, type ProviderHealth } from "./health.js";
import type { AgentProvider, ProviderRequest, ProviderResponse } from "./types.js";

export interface FailoverAttempt {
  provider: string;
  kind: FailureKind;
  error: string;
}

/**
 * Tries an ordered chain of interchangeable providers. Members must share a prompt contract
 * (validated in config), so any member can take over a request unchanged.
 *
 * Order: healthy members first, starting at an offset derived from metadata.attempt so a task
 * retry after a bad result goes to a different model. Members in cooldown are tried last, by
 * soonest recovery, so a job is never failed without asking everyone.
 */
export class FailoverProvider implements AgentProvider {
  readonly name: string;
  readonly capabilities: AgentProvider["capabilities"];
  readonly maxAttempts: number;

  constructor(
    private readonly members: readonly AgentProvider[],
    private readonly health: ProviderHealth = providerHealth,
    private readonly onFailover?: (attempt: FailoverAttempt, next: string) => void,
  ) {
    if (members.length === 0) throw new SwarmError("Failover needs a provider", "bad_config");
    this.name = members[0]!.name;
    this.capabilities = members[0]!.capabilities;
    this.maxAttempts = members.length;
  }

  get model(): string | undefined {
    return this.members[0]!.model;
  }

  order(attempt = 1): AgentProvider[] {
    const offset = Math.max(0, attempt - 1) % this.members.length;
    const rotated = [...this.members.slice(offset), ...this.members.slice(0, offset)];
    const ready = rotated.filter((member) => this.health.available(member.name));
    const cooling = rotated
      .filter((member) => !this.health.available(member.name))
      .sort((a, b) => this.health.availableAt(a.name) - this.health.availableAt(b.name));
    return [...ready, ...cooling];
  }

  async complete(request: ProviderRequest): Promise<ProviderResponse> {
    const order = this.order(Number(request.metadata?.attempt ?? 1) || 1);
    const failures: FailoverAttempt[] = [];
    for (const [index, member] of order.entries()) {
      request.signal?.throwIfAborted();
      try {
        const response = await member.complete(request);
        this.health.success(member.name, response.usage);
        if (failures.length) response.failover = failures;
        return response;
      } catch (error) {
        const kind = this.health.failure(member.name, error);
        if (kind === "cancelled" || request.signal?.aborted) throw error;
        const attempt = { provider: member.name, kind, error: errorMessage(error).slice(0, 300) };
        failures.push(attempt);
        const next = order[index + 1];
        if (!next) {
          if (order.length === 1) throw error;
          throw new SwarmError(
            `All ${order.length} providers failed: ${failures.map((item) => `${item.provider} (${item.kind}): ${item.error}`).join(" | ")}`,
            error instanceof SwarmError ? error.code : "provider_exhausted",
            true,
          );
        }
        this.onFailover?.(attempt, next.name);
      }
    }
    throw new SwarmError("Failover chain was empty", "bad_config");
  }
}
