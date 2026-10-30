export interface SwarmErrorDetails {
  /** HTTP status reported by a provider, when there was one. */
  status?: number;
  /** Provider-requested wait before the next request, in milliseconds. */
  retryAfterMs?: number;
}

export class SwarmError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: SwarmErrorDetails;

  constructor(message: string, code: string, retryable = false, details: SwarmErrorDetails = {}) {
    super(message);
    this.name = "SwarmError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

export function isRetryable(error: unknown): boolean {
  return error instanceof SwarmError && error.retryable;
}
