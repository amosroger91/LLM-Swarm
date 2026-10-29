export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  child(fields: Record<string, unknown>): Logger;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger(
  level: LogLevel,
  redact: (text: string) => string,
  sink: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): Logger {
  const write = (entryLevel: LogLevel, fields: Record<string, unknown>, message: string): void => {
    if (RANK[entryLevel] < RANK[level]) return;
    const payload = {
      ts: new Date().toISOString(),
      level: entryLevel,
      msg: message,
      ...fields,
    };
    sink(redact(JSON.stringify(payload)));
  };
  const logger: Logger = {
    debug: (fields, message) => write("debug", fields, message),
    info: (fields, message) => write("info", fields, message),
    warn: (fields, message) => write("warn", fields, message),
    error: (fields, message) => write("error", fields, message),
    child(extra) {
      return {
        debug: (fields, message) => logger.debug({ ...extra, ...fields }, message),
        info: (fields, message) => logger.info({ ...extra, ...fields }, message),
        warn: (fields, message) => logger.warn({ ...extra, ...fields }, message),
        error: (fields, message) => logger.error({ ...extra, ...fields }, message),
        child: (more) => logger.child({ ...extra, ...more }),
      };
    },
  };
  return logger;
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
