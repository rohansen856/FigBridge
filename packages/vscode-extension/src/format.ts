import type { FigmaError } from '@figbridge/core';

/**
 * Escapes text from manifests, Figma or source files for MarkdownString: markdown syntax, HTML
 * (hovers enable a safe HTML subset) and `$(icon)` sequences.
 */
export function escapeMd(text: string): string {
  return text
    .replace(/[\\`*_{}[\]()#+\-.!|~>]/g, '\\$&')
    .replace(/</g, '&lt;')
    .replace(/\$/g, '\\$')
    .replace(/[\r\n]+/g, ' ');
}

/** `[label](command:id?args)` with JSON-encoded arguments. `label` must already be safe. */
export function commandLink(label: string, command: string, args: unknown[]): string {
  const query = args.length ? `?${encodeURIComponent(JSON.stringify(args))}` : '';
  return `[${label}](command:${command}${query})`;
}

export function describeError(e: Pick<FigmaError, 'code' | 'message' | 'retryAfterSec' | 'planTier'>): string {
  switch (e.code) {
    case 'RATE_LIMITED': {
      const wait = e.retryAfterSec ? ` Try again in ${formatDuration(e.retryAfterSec)}.` : '';
      const tier = e.planTier ? ` (Figma plan: ${e.planTier})` : '';
      return `Figma rate limit reached${tier}.${wait}`;
    }
    case 'PAT_INVALID_OR_EXPIRED':
      return 'Figma rejected the access token — it may have expired. Run "FigBridge: Set Figma Access Token".';
    case 'PAT_NOT_CONFIGURED':
      return 'No Figma access token is set.';
    default:
      return e.message;
  }
}

export function formatDuration(sec: number): string {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${Math.round(sec / 3600)} h`;
}

export function relativeTime(epochMs: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - epochMs) / 1000));
  if (s < 45) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
