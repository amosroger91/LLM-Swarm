import { SwarmError } from "../errors.js";

export function combineSignals(signals: AbortSignal[]): AbortSignal {
  const controller = new AbortController();
  const abortFrom = (signal: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(signal.reason);
  };
  for (const signal of signals) {
    if (signal.aborted) {
      abortFrom(signal);
      break;
    }
    signal.addEventListener("abort", () => abortFrom(signal), { once: true });
  }
  return controller.signal;
}

export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  void work.then(
    () => undefined,
    () => undefined,
  );
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new SwarmError(`Timed out after ${ms}ms`, "timeout", true));
    }, ms);
  });
  const aborted = new Promise<never>((_, reject) => {
    const fail = (): void => {
      const reason = signal.reason;
      const message =
        reason instanceof Error ? reason.message : typeof reason === "string" ? reason : "aborted";
      reject(new SwarmError(message, message === "cancelled" ? "cancelled" : "aborted"));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
  try {
    return await Promise.race([work, timeout, aborted]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
