import { SwarmError, errorMessage } from "../errors.js";
import type { ProviderUsage } from "./types.js";

/**
 * Why a provider call failed, as far as routing is concerned.
 * - exhausted: rate limit, quota, or out of credit. Wait before using it again.
 * - unavailable: auth, missing binary, or bad config. Unlikely to recover soon.
 * - transient: network, timeout, 5xx, crashed CLI. Short backoff.
 * - output: the model answered, but badly (malformed JSON, tool loop, context overflow).
 *   The provider is healthy; a different model may do better.
 * - cancelled: the caller stopped. Never fail over.
 */
export type FailureKind = "exhausted" | "unavailable" | "transient" | "output" | "cancelled";

const EXHAUSTED_TEXT =
  /quota|rate.?limit|resource.?exhausted|usage limit|too many requests|insufficient.?(?:credit|balance|funds|quota)|credit balance|exceeded your current/i;

export function classifyFailure(error: unknown): FailureKind {
  const code = error instanceof SwarmError ? error.code : "unknown";
  const status = error instanceof SwarmError ? error.details.status : undefined;
  if (code === "cancelled") return "cancelled";
  if (status === 429 || status === 402 || EXHAUSTED_TEXT.test(errorMessage(error)))
    return "exhausted";
  if (
    status === 401 ||
    status === 403 ||
    status === 404 ||
    [
      "missing_secret",
      "missing_executable",
      "bad_config",
      "unknown_provider",
      "bad_parser",
    ].includes(code)
  )
    return "unavailable";
  if (["malformed", "tool_limit", "context_limit", "output_limit"].includes(code)) return "output";
  return "transient";
}

export interface ProviderHealthSnapshot {
  name: string;
  state: "healthy" | "cooling" | "unavailable";
  availableAt: string | null;
  calls: number;
  failures: number;
  consecutiveFailures: number;
  lastFailure: { kind: FailureKind; message: string; at: string } | null;
  lastSuccessAt: string | null;
  inputTokens: number;
  outputTokens: number;
}

interface Entry {
  calls: number;
  failures: number;
  consecutive: number;
  until: number;
  unavailable: boolean;
  lastFailure: ProviderHealthSnapshot["lastFailure"];
  lastSuccessAt: number | null;
  inputTokens: number;
  outputTokens: number;
}

const MINUTE = 60_000;

/** Process-wide routing memory. One scheduler process owns all calls, so this is shared. */
export class ProviderHealth {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly now: () => number = Date.now) {}

  private entry(name: string): Entry {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = {
        calls: 0,
        failures: 0,
        consecutive: 0,
        until: 0,
        unavailable: false,
        lastFailure: null,
        lastSuccessAt: null,
        inputTokens: 0,
        outputTokens: 0,
      };
      this.entries.set(name, entry);
    }
    return entry;
  }

  available(name: string): boolean {
    return this.entry(name).until <= this.now();
  }

  availableAt(name: string): number {
    return this.entry(name).until;
  }

  success(name: string, usage?: ProviderUsage): void {
    const entry = this.entry(name);
    entry.calls += 1;
    entry.consecutive = 0;
    entry.until = 0;
    entry.unavailable = false;
    entry.lastSuccessAt = this.now();
    entry.inputTokens += usage?.inputTokens ?? 0;
    entry.outputTokens += usage?.outputTokens ?? 0;
  }

  failure(name: string, error: unknown): FailureKind {
    const kind = classifyFailure(error);
    if (kind === "cancelled") return kind;
    const entry = this.entry(name);
    entry.calls += 1;
    entry.failures += 1;
    entry.consecutive += 1;
    entry.lastFailure = {
      kind,
      message: errorMessage(error).slice(0, 500),
      at: new Date(this.now()).toISOString(),
    };
    const step = Math.min(entry.consecutive - 1, 6);
    const retryAfter = error instanceof SwarmError ? error.details.retryAfterMs : undefined;
    let cooldown = 0;
    if (kind === "exhausted") cooldown = retryAfter ?? Math.min(MINUTE * 2 ** step, 30 * MINUTE);
    else if (kind === "unavailable") cooldown = 60 * MINUTE;
    else if (kind === "transient") cooldown = Math.min(15_000 * 2 ** step, 10 * MINUTE);
    // A model that keeps producing unusable output is benched briefly so others get a turn.
    else if (entry.consecutive >= 3) cooldown = 2 * MINUTE;
    entry.unavailable = kind === "unavailable";
    entry.until = Math.max(entry.until, this.now() + cooldown);
    return kind;
  }

  reset(name?: string): void {
    if (name) this.entries.delete(name);
    else this.entries.clear();
  }

  snapshot(names?: readonly string[]): ProviderHealthSnapshot[] {
    const now = this.now();
    return (names ?? [...this.entries.keys()]).map((name) => {
      const entry = this.entry(name);
      const cooling = entry.until > now;
      return {
        name,
        state: !cooling ? "healthy" : entry.unavailable ? "unavailable" : "cooling",
        availableAt: cooling ? new Date(entry.until).toISOString() : null,
        calls: entry.calls,
        failures: entry.failures,
        consecutiveFailures: entry.consecutive,
        lastFailure: entry.lastFailure,
        lastSuccessAt: entry.lastSuccessAt ? new Date(entry.lastSuccessAt).toISOString() : null,
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
      };
    });
  }
}

export const providerHealth = new ProviderHealth();
