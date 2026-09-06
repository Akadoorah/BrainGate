import { existsSync, realpathSync } from "node:fs";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { BrainGateInvariantError } from "@braingate/core";

const DIRECT_BILLING_ENV = new Set([
  "ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CODE_USE_FOUNDRY", "AWS_BEARER_TOKEN_BEDROCK", "OPENAI_API_KEY", "OPENAI_BASE_URL",
  "GEMINI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GEMINI_BASE_URL", "XAI_API_KEY",
  "COPILOT_PROVIDER_API_KEY", "COPILOT_PROVIDER_BASE_URL", "COPILOT_PROVIDER_TYPE",
]);

const SAFE_ENV = new Set([
  "PATH", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "HOME", "USERPROFILE", "TMP", "TEMP",
  "LANG", "LC_ALL", "LC_CTYPE", "CI", "NO_COLOR", "TERM",
]);

const SENSITIVE_BASENAMES = new Set([
  ".env", ".npmrc", ".pypirc", ".netrc", "credentials", "credentials.json", "application_default_credentials.json",
  "service-account.json", "config.json", "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519", "known_hosts",
]);

const SENSITIVE_SEGMENTS = new Set([".ssh", ".aws", ".gnupg"]);
const SENSITIVE_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".jks", ".keystore"];

const REDACTIONS: readonly [RegExp, string][] = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gi, "[REDACTED_PRIVATE_KEY]"],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "[REDACTED_GITHUB_TOKEN]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_AWS_KEY]"],
  [/\b(?:sk|xai)-[A-Za-z0-9_-]{16,}\b/g, "[REDACTED_API_TOKEN]"],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{16,}=*/gi, "Bearer [REDACTED]"],
  [/\b(api[_-]?key|password|passwd|secret|access[_-]?token|refresh[_-]?token)\s*([:=])\s*([^\s'\"]{8,})/gi, "$1$2[REDACTED]"],
];

function normalizeParts(path: string): string[] {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).map((part) => part.toLowerCase());
}

export function isSensitivePath(path: string): boolean {
  const parts = normalizeParts(path);
  const file = (parts.at(-1) ?? "").toLowerCase();
  if (file === ".env" || file.startsWith(".env.")) return true;
  if (SENSITIVE_BASENAMES.has(file)) return true;
  if (SENSITIVE_EXTENSIONS.some((extension) => file.endsWith(extension))) return true;
  if (parts.some((part) => SENSITIVE_SEGMENTS.has(part))) return true;
  if (parts.includes(".docker") && file === "config.json") return true;
  if (parts.includes("gcloud") && file === "application_default_credentials.json") return true;
  return false;
}

export function redactSecrets(value: string): string {
  let redacted = value;
  for (const [pattern, replacement] of REDACTIONS) redacted = redacted.replace(pattern, replacement);
  return redacted;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

export class SecretGuard {
  assertReadablePath(rootPath: string, requestedPath: string): string {
    const root = realpathSync.native(rootPath);
    const candidate = resolve(root, requestedPath);
    if (!existsSync(candidate)) {
      throw new BrainGateInvariantError("SECRET_PATH_NOT_FOUND", `Requested path does not exist: ${requestedPath}`);
    }
    const real = realpathSync.native(candidate);
    if (!isWithin(root, real)) {
      throw new BrainGateInvariantError("SECRET_PATH_ESCAPE", "Requested path escapes the approved project/worktree root.");
    }
    const rel = relative(root, real);
    if (isSensitivePath(rel) || isSensitivePath(basename(real))) {
      throw new BrainGateInvariantError("SECRET_PATH_BLOCKED", `Sensitive path is blocked: ${rel}`);
    }
    return real;
  }

  buildEnvironment(
    base: NodeJS.ProcessEnv,
    options: { allowedAdditionalKeys?: readonly string[]; overrides?: Readonly<Record<string, string>> } = {},
  ): { readonly env: NodeJS.ProcessEnv; readonly removed: readonly string[] } {
    const allowed = new Set([...SAFE_ENV, ...(options.allowedAdditionalKeys ?? [])]);
    const env: NodeJS.ProcessEnv = {};
    const removed: string[] = [];
    for (const [key, value] of Object.entries(base)) {
      if (value === undefined) continue;
      if (DIRECT_BILLING_ENV.has(key) || !allowed.has(key)) removed.push(key);
      else env[key] = value;
    }
    for (const [key, value] of Object.entries(options.overrides ?? {})) {
      if (DIRECT_BILLING_ENV.has(key)) {
        throw new BrainGateInvariantError("SECRET_ENV_DIRECT_BILLING", `Direct-billing environment override is forbidden: ${key}`);
      }
      if (!allowed.has(key)) {
        throw new BrainGateInvariantError("SECRET_ENV_NOT_ALLOWED", `Environment key is not allowlisted: ${key}`);
      }
      env[key] = value;
    }
    env.NO_COLOR ??= "1";
    return { env, removed: Object.freeze([...new Set(removed)].sort()) };
  }
}
