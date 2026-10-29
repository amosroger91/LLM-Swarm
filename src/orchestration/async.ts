import { SwarmError } from "../errors.js";

export function combineSignals(signals: AbortSignal[]): AbortSignal {
  return AbortSignal.any(signals);
}

export async function withTimeout<T>(
  work: Promise<T>,
  ms: number,
  signal: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
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
    onAbort = fail;
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
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}
