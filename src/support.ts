import os from "node:os";
import type { AuditEvent } from "./types.js";

const SECRET_KEY = /(?:token|secret|password|credential|private[_-]?key)/iu;
const URL_KEY = /(?:url|uri)$/iu;

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

/** Redacts credentials, repository-local paths, home paths, and URL-bearing fields recursively. */
export function sanitizeSupportData(
  value: unknown,
  options: { repositoryRoot: string; homeDirectory?: string },
  key = "",
): unknown {
  if (SECRET_KEY.test(key)) return "<redacted-secret>";
  if (URL_KEY.test(key)) return value === undefined ? undefined : "<redacted-url>";
  if (typeof value === "string") {
    let sanitized = replaceAllLiteral(value, options.repositoryRoot, "<repository>");
    sanitized = replaceAllLiteral(sanitized, options.homeDirectory ?? os.homedir(), "<home>");
    sanitized = sanitized.replace(/https?:\/\/[^\s"']+/giu, "<redacted-url>");
    sanitized = sanitized.replace(/git@[^\s:]+:[^\s]+/giu, "<redacted-git-url>");
    return sanitized;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeSupportData(item, options));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([name, item]) => [name, sanitizeSupportData(item, options, name)]),
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
    redaction: "Repository paths, home-directory paths, URLs, and secret-bearing fields were removed. Review before sharing.",
  };
}
