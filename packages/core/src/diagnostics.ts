export type ErrorCode =
  // configuration
  | 'CONFIG_NOT_FOUND'
  | 'CONFIG_INVALID'
  | 'SCHEMA_UNSUPPORTED'
  | 'SCHEMA_VIOLATION'
  | 'ENV_VAR_MISSING'
  | 'UNKNOWN_FILE_ALIAS'
  | 'UNKNOWN_PARENT_REF'
  | 'UNKNOWN_REPLACEMENT_REF'
  | 'PARENT_CYCLE'
  | 'RETIRED_ID_IN_USE'
  | 'DUPLICATE_FILE_KEY'
  | 'DUPLICATE_MAPPING'
  | 'SECRET_IN_MANIFEST'
  | 'INVALID_FIGMA_URL'
  | 'INVALID_NODE_ID'
  // annotations
  | 'MALFORMED_DIRECTIVE'
  | 'NONCANONICAL_CASE'
  | 'UNRESOLVED_REF'
  | 'DEPRECATED_REF'
  | 'ADAPTER_UNAVAILABLE'
  // Figma / network
  | 'PAT_NOT_CONFIGURED'
  | 'PAT_INVALID_OR_EXPIRED'
  | 'FILE_UNAVAILABLE'
  | 'NODE_NOT_FOUND'
  | 'RENDER_FAILED'
  | 'RENDER_TOO_LARGE'
  | 'NETWORK_UNAVAILABLE'
  | 'RATE_LIMITED'
  | 'BAD_RESPONSE'
  // Claude integration
  | 'HOOK_EVENT_INVALID'
  | 'UNTRUSTED_WORKSPACE';

export type Severity = 'error' | 'warning' | 'info';

/** Zero-based line/character positions (display adds one). */
export interface Position {
  line: number;
  character: number;
}
export interface Range {
  start: Position;
  end: Position;
}

export interface Diagnostic {
  code: ErrorCode;
  severity: Severity;
  message: string;
  /** Workspace-relative path of the file the diagnostic belongs to. */
  file: string;
  range?: Range;
  data?: Record<string, string>;
}

const PAT_PATTERN = /figd_[A-Za-z0-9_-]{8,}/g;

/** Removes anything resembling a Figma personal access token, plus explicitly known secrets. */
export function redact(text: string, secrets: readonly string[] = []): string {
  let out = text;
  for (const s of secrets) if (s.length >= 8) out = out.split(s).join('<redacted>');
  return out.replace(PAT_PATTERN, 'figd_<redacted>');
}

export function looksLikeSecret(value: string): boolean {
  return /figd_[A-Za-z0-9_-]{8,}/.test(value);
}
