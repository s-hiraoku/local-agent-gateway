const ABSOLUTE_PATH_PATTERNS = [
  /\\\\[^\s\\/"'`<>]+\\[^\s"'`<>]+/g,
  /\b[A-Za-z]:[\\/][^\s"'`<>]+/g,
  /(?<![:\w])\/(?:Volumes|Users|home|workspace|workspaces|private|tmp|var|opt|srv|mnt|media|root|app|repo|project|builds|runner|github)\/[^\s"'`<>]+/g
];

export function sanitizePublicText(text: string): string {
  let sanitized = text;
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    sanitized = sanitized.replace(pattern, "[redacted-path]");
  }
  return sanitized;
}

/**
 * Structure-preserving sanitization for JSON values. Only string leaf values
 * are scrubbed; keys, numbers, booleans, nulls, and the object/array shape
 * are left intact. Running sanitizePublicText over a serialized JSON blob
 * instead would corrupt it (the path patterns match across quotes), so
 * structured task output must always go through this function on egress.
 */
export function sanitizePublicJson(value: unknown): unknown {
  if (typeof value === "string") {
    return sanitizePublicText(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizePublicJson(item));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, sanitizePublicJson(item)])
    );
  }
  return value;
}
