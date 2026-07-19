const REDACTED = "[REDACTED]";

const EXACT_SECRET_KEYS = new Set([
  "authorization",
  "cookie",
  "credentials",
  "credential",
  "password",
  "passwd",
  "pwd",
  "secret",
  "session",
  "setcookie",
  "token",
]);

const EMBEDDED_SECRET_PATTERNS: ReadonlyArray<{
  pattern: RegExp;
  replacement: string;
}> = [
  {
    pattern: /\bAuthorization\s*:\s*Basic\s+[A-Za-z0-9+/]+={0,2}/gi,
    replacement: "Authorization: Basic " + REDACTED,
  },
  {
    pattern: /\bSet-Cookie\s*:[^\r\n]*/gi,
    replacement: "Set-Cookie: " + REDACTED,
  },
  {
    pattern: /\bCookie\s*:[^\r\n]*/gi,
    replacement: "Cookie: " + REDACTED,
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi,
    replacement: `Bearer ${REDACTED}`,
  },
  {
    pattern: /\bAuthorization\s*:\s*([A-Za-z][A-Za-z0-9._~-]*)\s+[^\r\n]*/gi,
    replacement: "Authorization: $1 " + REDACTED,
  },
  {
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/gi,
    replacement: "$1" + REDACTED + "@",
  },
  {
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    pattern: /\bAKIA[0-9A-Z]{16}\b/g,
    replacement: REDACTED,
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: REDACTED,
  },
  {
    pattern: /\b((?:WECHAT_)?CONTEXT[_-]?TOKEN)=([^\s&;,]+)/gi,
    replacement: "$1=" + REDACTED,
  },
  {
    pattern:
      /("(?:token|access_token|refresh_token|api[_-]?key|secret|password|context[_-]?token|authorization|proxy[_-]?authorization)"\s*:\s*")([^"]*)(")/gi,
    replacement: "$1" + REDACTED + "$3",
  },
  {
    pattern:
      /\b(token|access[_-]?token|refresh[_-]?token|api[_-]?key|client[_-]?secret|session|secret|password)=([^\s&;,<>"']+)/gi,
    replacement: `$1=${REDACTED}`,
  },
];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

  return (
    EXACT_SECRET_KEYS.has(normalized) ||
    normalized.endsWith("authorization") ||
    normalized.endsWith("authorizationheader") ||
    normalized.endsWith("cookieheader") ||
    normalized.endsWith("sessionid") ||
    normalized.endsWith("token") ||
    normalized.endsWith("secret") ||
    normalized.endsWith("password") ||
    normalized.endsWith("apikey") ||
    normalized.endsWith("privatekey")
  );
}

const URL_IN_TEXT = /\b[a-z][a-z0-9+.-]*:\/\/[^\s<>"']+/gi;

function redactUrlQuery(candidate: string): string {
  let urlText = candidate;
  let trailing = "";
  while (/[),.;!?]$/u.test(urlText)) {
    trailing = urlText.slice(-1) + trailing;
    urlText = urlText.slice(0, -1);
  }

  try {
    const url = new URL(urlText);
    const entries = [...url.searchParams.entries()];
    if (!entries.some(([key]) => isSecretKey(key))) {
      return candidate;
    }
    url.search = "";
    for (const [key, value] of entries) {
      url.searchParams.append(key, isSecretKey(key) ? REDACTED : value);
    }
    return url.toString() + trailing;
  } catch {
    return candidate;
  }
}

function redactString(value: string): string {
  const urlsRedacted = value.replace(URL_IN_TEXT, redactUrlQuery);
  return EMBEDDED_SECRET_PATTERNS.reduce(
    (redacted, { pattern, replacement }) => redacted.replace(pattern, replacement),
    urlsRedacted,
  );
}

function redactValue(value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (typeof value === "string") {
    return redactString(value);
  }

  if (value === null || typeof value !== "object") {
    return value;
  }

  const existing = seen.get(value);
  if (existing !== undefined) {
    return existing;
  }

  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    seen.set(value, REDACTED);
    return REDACTED;
  }

  if (Array.isArray(value)) {
    const result: unknown[] = [];
    seen.set(value, result);
    result.push(...value.map((entry) => redactValue(entry, seen)));
    return result;
  }

  if (value instanceof URL) {
    const result = redactString(value.toString());
    seen.set(value, result);
    return result;
  }

  if (value instanceof Headers) {
    const result: Record<string, unknown> = {};
    seen.set(value, result);
    for (const [key, entry] of value.entries()) {
      result[key] = isSecretKey(key) ? REDACTED : redactString(entry);
    }
    return result;
  }

  const result: Record<string, unknown> = {};
  seen.set(value, result);

  if (value instanceof Error) {
    result.name = redactString(value.name);
    result.message = redactString(value.message);
    if (value.cause !== undefined) {
      result.cause = redactValue(value.cause, seen);
    }
  }

  for (const [key, descriptor] of Object.entries(
    Object.getOwnPropertyDescriptors(value),
  )) {
    if (
      !descriptor.enumerable ||
      !("value" in descriptor) ||
      (value instanceof Error && (key === "name" || key === "message" || key === "cause"))
    ) {
      continue;
    }
    result[key] = isSecretKey(key)
      ? REDACTED
      : redactValue(descriptor.value, seen);
  }
  return result;
}

export function redactSecrets(value: unknown): unknown {
  return redactValue(value, new WeakMap());
}
