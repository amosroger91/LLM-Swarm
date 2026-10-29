import { SwarmError } from "../errors.js";

export interface ParsedOutput {
  text: string;
  structured?: unknown;
}

export type OutputParser = (stdout: string, stderr: string) => ParsedOutput;

const parsers = new Map<string, OutputParser>();

export function registerOutputParser(name: string, parser: OutputParser): void {
  parsers.set(name, parser);
}

export function parseProviderOutput(mode: string, stdout: string, stderr: string): ParsedOutput {
  const parser = parsers.get(mode);
  if (!parser) {
    throw new SwarmError(`No output parser registered for ${mode}`, "bad_parser");
  }
  return parser(stdout, stderr);
}

export function extractJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new SwarmError("Provider returned an empty response", "malformed", true);
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    // Fall through to fenced or embedded JSON.
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/gi;
  let match: RegExpExecArray | null;
  let last: string | undefined;
  while ((match = fence.exec(text)) !== null) {
    last = match[1];
  }
  if (last) {
    try {
      return JSON.parse(last.trim()) as unknown;
    } catch {
      // Fall through.
    }
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1)) as unknown;
    } catch {
      // Reported below.
    }
  }
  throw new SwarmError("Provider response did not contain a JSON object", "malformed", true);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function findText(value: unknown, depth = 0): string | undefined {
  if (depth > 6) return undefined;
  if (typeof value === "string" && value.trim()) return value;
  if (Array.isArray(value)) {
    const parts = value
      .map((item) => findText(item, depth + 1))
      .filter((item): item is string => Boolean(item));
    return parts.length > 0 ? parts.join("\n") : undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  for (const key of ["text", "response", "content", "message", "result", "output", "part"]) {
    if (key in record) {
      const found = findText(record[key], depth + 1);
      if (found) return found;
    }
  }
  return undefined;
}

function withStructured(text: string): ParsedOutput {
  try {
    return { text, structured: extractJsonValue(text) };
  } catch {
    return { text };
  }
}

registerOutputParser("text", (stdout) => ({ text: stdout }));
registerOutputParser("json", (stdout) => {
  const structured = extractJsonValue(stdout);
  const text = findText(structured) ?? stdout;
  return { text, structured };
});
registerOutputParser("fenced-json", (stdout) => withStructured(stdout));
registerOutputParser("grok-json", (stdout) => {
  try {
    const envelope = JSON.parse(stdout) as unknown;
    return withStructured(findText(envelope) ?? stdout);
  } catch {
    return withStructured(stdout);
  }
});
registerOutputParser("gemini-json", (stdout) => {
  try {
    const envelope = JSON.parse(stdout) as unknown;
    return withStructured(findText(envelope) ?? stdout);
  } catch {
    return withStructured(stdout);
  }
});
registerOutputParser("opencode-events", (stdout) => {
  const parts: string[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const text = findText(JSON.parse(trimmed) as unknown);
      if (text) parts.push(text);
    } catch {
      parts.push(trimmed);
    }
  }
  return withStructured(parts.join("\n") || stdout);
});
