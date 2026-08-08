import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";

const ANSI_ESCAPE_PATTERN = new RegExp(String.raw`\x1B\[[0-?]*[ -/]*[@-~]`, "g");

function stripAnsiCodes(text: string) {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function findBalancedJsonEnd(text: string, startIndex: number) {
  const opening = text[startIndex];
  const firstClosing = opening === "{" ? "}" : opening === "[" ? "]" : "";
  if (!firstClosing) {
    return -1;
  }

  const stack = [firstClosing];
  let inString = false;
  let escaping = false;
  for (let index = startIndex + 1; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaping) {
        escaping = false;
      } else if (char === "\\") {
        escaping = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{" || char === "[") {
      stack.push(char === "{" ? "}" : "]");
    } else if (char === "}" || char === "]") {
      if (stack.at(-1) !== char) {
        return -1;
      }
      stack.pop();
      if (stack.length === 0) {
        return index;
      }
    }
  }
  return -1;
}

function parseBalancedJsonPayloadStart(text: string) {
  const trimmedStart = text.search(/\S/u);
  if (trimmedStart < 0) {
    return undefined;
  }
  const char = text[trimmedStart];
  if (char !== "{" && char !== "[") {
    return undefined;
  }
  const end = findBalancedJsonEnd(text, trimmedStart);
  if (end <= trimmedStart) {
    return undefined;
  }
  try {
    return JSON.parse(text.slice(trimmedStart, end + 1)) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function isStructuredDiagnosticJson(value: unknown) {
  if (!isJsonRecord(value)) {
    return false;
  }
  const level = value.level ?? value.logLevel ?? value.severity;
  if (typeof level !== "string") {
    return false;
  }
  return (
    typeof value.message === "string" ||
    typeof value.msg === "string" ||
    typeof value.time === "string" ||
    typeof value.timestamp === "string"
  );
}

function isMemorySearchJsonPayload(value: unknown) {
  return isJsonRecord(value) && Array.isArray(value.results);
}

function isMemoryStatusJsonPayload(value: unknown) {
  if (Array.isArray(value)) {
    return true;
  }
  return isJsonRecord(value) && value.command === "memory" && value.subcommand === "status";
}

function resolveQaCliJsonPayloadMatcher(args: readonly string[]) {
  if (!args.includes("--json")) {
    return undefined;
  }
  if (args[0] === "memory" && args[1] === "search") {
    return isMemorySearchJsonPayload;
  }
  if (args[0] === "memory" && args[1] === "status") {
    return isMemoryStatusJsonPayload;
  }
  return undefined;
}

export function parseQaCliJsonOutput(text: string, args: readonly string[]) {
  const cleaned = stripAnsiCodes(text).trim();
  if (!cleaned) {
    return {};
  }
  const matchesExpectedPayload = resolveQaCliJsonPayloadMatcher(args);
  try {
    return JSON.parse(cleaned) as unknown;
  } catch {
    // Some startup repair logs are emitted on stdout before command JSON.
    const lines = cleaned.split(/\r?\n/);
    const candidates: unknown[] = [];
    for (const [index, line] of lines.entries()) {
      const candidate = line.trimStart();
      if (candidate !== line || (!candidate.startsWith("{") && !candidate.startsWith("["))) {
        continue;
      }
      const jsonTail = lines.slice(index).join("\n");
      try {
        candidates.push(JSON.parse(jsonTail) as unknown);
      } catch {
        const balanced = parseBalancedJsonPayloadStart(jsonTail);
        if (balanced !== undefined) {
          candidates.push(balanced);
        }
      }
    }
    const expectedPayload = candidates.find((value) => matchesExpectedPayload?.(value) === true);
    if (expectedPayload !== undefined) {
      return expectedPayload;
    }
    const payload = candidates.toReversed().find((value) => !isStructuredDiagnosticJson(value));
    if (payload !== undefined) {
      return payload;
    }
    const diagnosticOnly = candidates.at(-1);
    if (diagnosticOnly !== undefined) {
      return diagnosticOnly;
    }

    // Keep a line-oriented fallback for compact payloads followed by diagnostics.
    for (const line of lines.toReversed()) {
      const candidate = line.trim();
      if (!candidate.startsWith("{") && !candidate.startsWith("[")) {
        continue;
      }
      try {
        return JSON.parse(candidate) as unknown;
      } catch {
        // Keep looking for the actual payload line.
      }
    }
    throw new Error(`qa cli returned non-JSON stdout: ${truncateUtf16Safe(cleaned, 240)}`);
  }
}
