import os from "node:os";
import type { AuditEvent } from "./types.js";

const SECRET_KEY =
  /(?:token|secret|password|passphrase|credential|private[_-]?key|signing[_-]?key|api[_-]?key|authorization|auth[_-]?header|cookie|session)/iu;
const URL_KEY = /(?:url|uri)$/iu;
const OPERATOR_TEXT_KEY = /^abandon[_-]?reason$/iu;

export interface SupportBundle {
  version: 1;
  brokerVersion: string;
  generatedAt: string;
  platform: { platform: string; release: string; architecture: string };
  diagnostics: unknown;
  recentEvents: unknown;
  redaction: string;
}

function replaceAllLiteral(value: string, search: string, replacement: string): string {
  return search ? value.split(search).join(replacement) : value;
}

/**
 * Replace a filesystem path wherever it appears. Windows paths are compared without case, and both
 * separators are accepted because diagnostics mix Git's forward slashes with native paths.
 */
function replacePath(value: string, directory: string, replacement: string): string {
  if (!directory) return value;
  const variants = new Set([directory, directory.replaceAll("\\", "/"), directory.replaceAll("/", "\\")]);
  let sanitized = value;
  for (const variant of variants) {
    sanitized = replaceAllLiteral(sanitized, variant, replacement);
    if (process.platform === "win32") {
      const pattern = new RegExp(variant.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "giu");
      sanitized = sanitized.replace(pattern, replacement);
    }
  }
  return sanitized;
}

/** Redacts credentials, repository-local paths, home paths, and URL-bearing fields recursively. */
export function sanitizeSupportData(
  value: unknown,
  options: { repositoryRoot: string; homeDirectory?: string },
  key = "",
): unknown {
  if (SECRET_KEY.test(key)) return "<redacted-secret>";
  if (URL_KEY.test(key)) return value === undefined ? undefined : "<redacted-url>";
  if (OPERATOR_TEXT_KEY.test(key)) return "<redacted-operator-text>";
  if (typeof value === "string") {
    let sanitized = replacePath(value, options.repositoryRoot, "<repository>");
    sanitized = replacePath(sanitized, options.homeDirectory ?? os.homedir(), "<home>");
    // Key material and bearer tokens travel inside free text such as validator output and Git stderr.
    sanitized = sanitized.replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gu,
      "<redacted-private-key>",
    );
    // An authorization header carries a scheme before its credential; a bare scheme can also appear.
    sanitized = sanitized.replace(
      /\b(proxy-authorization|authorization)\b\s*[:=]\s*(?:[A-Za-z]+\s+)?\S+/giu,
      "$1 <redacted-secret>",
    );
    sanitized = sanitized.replace(/\b(bearer|basic|token)\b\s*[:=]?\s+\S+/giu, "$1 <redacted-secret>");
    // Any scheme can carry credentials, and an scp-style locator names a host without one.
    sanitized = sanitized.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"']+/giu, "<redacted-url>");
    sanitized = sanitized.replace(/\b[\w.-]+@[\w.-]+:[^\s"']+/gu, "<redacted-git-url>");
    return sanitized;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSupportData(item, options));
  }
  if (value && typeof value === "object") {
    // An abandonment reason is unrestricted operator prose. Do not infer that it is safe merely
    // because its words do not resemble a URL or a secret-bearing field name. Other audit reasons
    // are machine diagnostics and retain their existing treatment.
    const record = value as Record<string, unknown>;
    const abandonment = record.event === "submission.abandoned";
    return Object.fromEntries(
      Object.entries(record).map(([name, item]) => {
        const sanitizedInput = record.status === "abandoned" && record.errorCode === "SUBMISSION_ABANDONED" && name === "error"
          ? "<redacted-operator-text>"
          : abandonment && name === "details" && item && typeof item === "object"
            ? { ...item, reason: "<redacted-operator-text>" }
            : item;
        return [name, sanitizeSupportData(sanitizedInput, options, name)];
      }),
    );
  }
  return value;
}

export function createSupportBundle(options: {
  brokerVersion: string;
  repositoryRoot: string;
  diagnostics: unknown;
  recentEvents: AuditEvent[];
  at?: Date;
  platform?: { platform: string; release: string; architecture: string };
}): SupportBundle {
  const redaction = { repositoryRoot: options.repositoryRoot };
  return {
    version: 1,
    brokerVersion: options.brokerVersion,
    generatedAt: (options.at ?? new Date()).toISOString(),
    platform: options.platform ?? {
      platform: process.platform,
      release: os.release(),
      architecture: process.arch,
    },
    diagnostics: sanitizeSupportData(options.diagnostics, redaction),
    recentEvents: sanitizeSupportData(options.recentEvents, redaction),
    redaction: "Repository paths, home-directory paths, URLs, private keys, bearer tokens, secret-bearing fields, and free-form abandonment reasons were removed. Redaction is best effort over unbounded validator output. Review before sharing.",
  };
}
