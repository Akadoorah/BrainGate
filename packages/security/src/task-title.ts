import { redactSecrets } from "./secret-guard.js";

/**
 * A readable name for a task, taken from the request itself.
 *
 * Tasks were recorded as "Dogfood ask T0" — the tier and nothing else — so BrainGate's own
 * history could say which models ran and what they cost but not what was asked. That made
 * `braingate status` unreadable as history and left the operator with no way to look up their
 * own past work.
 *
 * The request is the only honest label for it. It stays project-local, it is truncated on a
 * word boundary so a long task does not become a paragraph, and control characters and
 * anything secret-shaped are stripped before it is stored. It is not exported: the regression
 * feed carries ids, tiers and outcomes, never request text.
 */
export function taskTitleFor(request: string, maxLength = 120): string {
  const cleaned = redactSecrets(request)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (cleaned.length === 0) return "Untitled task";
  if (cleaned.length <= maxLength) return cleaned;
  const cut = cleaned.slice(0, maxLength);
  const lastSpace = cut.lastIndexOf(" ");
  return `${(lastSpace > maxLength * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

