import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { BrokerError } from "./errors.js";

export function remoteUrlFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isHostQualifiedForgeRepository(value: string | undefined): value is string {
  if (!value) return false;
  const parts = value.split("/");
  return parts.length === 3 && parts.every(Boolean);
}

export function forgeRepositoryFromRemote(value: string): string | undefined {
  let host: string | undefined;
  let remotePath = value;
  try {
    const parsed = new URL(remotePath);
    // gh operates on a hosted forge, not a filesystem path. Treating `/tmp/acme/repo.git` or a
    // `file:` URL as `acme/repo` would silently redirect PR operations to gh's github.com default
    // while Git pushes somewhere else.
    // `gh --repo HOST/OWNER/REPO` has no separately bound port in this adapter. Dropping an
    // explicit GHES port would query a different forge than Git pushes to, so reject it.
    if (
      !parsed.hostname ||
      parsed.protocol === "file:" ||
      parsed.port ||
      parsed.hostname.includes(":")
    ) return undefined;
    host = parsed.hostname;
    remotePath = parsed.pathname;
  } catch {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/u.exec(remotePath);
    if (scp && !/^[A-Za-z]:[\\/]/u.test(remotePath)) {
      host = scp[1];
      remotePath = scp[2] ?? "";
    }
  }
  if (!host) return undefined;
  const parts = remotePath.replace(/\\/gu, "/").split("/").filter(Boolean);
  if (parts.length < 2) return undefined;
  const repository = (parts.at(-1) ?? "").replace(/\.git$/u, "");
  const owner = parts.at(-2) ?? "";
  if (!owner || !repository) return undefined;
  return `${host.toLowerCase()}/${owner}/${repository}`;
}

export function canonicalRemoteUrl(value: string, repoRoot: string): string {
  const remote = value;
  // Do not normalize local components before realpath. For `link/../target`, the filesystem first
  // resolves `link`; lexical collapse would instead select a different sibling target.
  if (path.isAbsolute(remote) || (process.platform === "win32" && path.win32.isAbsolute(remote))) {
    return remote;
  }
  // `C:repo.git` is relative to drive C's process-specific current directory on Windows. Its text
  // is therefore not a durable locator and can resolve to another repository after a restart.
  // Reject it on every host instead of treating it as an scp-style one-letter hostname.
  if (/^[A-Za-z]:[^\\/]/u.test(remote)) {
    throw new BrokerError(
      "REMOTE_URL_UNKNOWN",
      `Drive-relative Git remote URLs are not safe durable targets: ${remote}`,
      { url: remote },
    );
  }
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(remote) && !/^[A-Za-z]:[\\/]/u.test(remote)) {
    return remote;
  }
  const scp = /^(?:[^@/]+@)?[^:/]+:.+$/u.test(remote);
  if (scp) return remote;
  // Passing a relative configured URL back to Git verbatim is ambiguous: if another remote has
  // that name, `git push <token>` selects the remote instead of the filesystem path. Resolve local
  // paths while we still know the repository directory in which Git interpreted them.
  return `${repoRoot}${path.sep}${remote}`;
}

export function localFileRemotePath(value: string, remote: string, purpose: "fetch" | "publication"): string {
  try {
    // WHATWG URL parsing removes leading/trailing C0 whitespace and embedded tabs/newlines. Git's
    // file transport can instead treat those bytes as pathname data, so accepting the raw form
    // would bind a sibling target. Percent-encoded pathname bytes are unambiguous.
    if (
      !value.startsWith("file:///") ||
      /[\u0000-\u001f\u007f\\|]/u.test(value) ||
      value.startsWith(" ") ||
      value.endsWith(" ") ||
      /\/(?:\.|%2e)(?:\.|%2e)?(?:\/|$)/iu.test(value)
    ) {
      throw new Error("ambiguous raw file URL syntax");
    }
    const parsed = new URL(value);
    // Git's file transport does not share WHATWG URL fragment/query semantics. Feeding an
    // unescaped `#` or `?` through fileURLToPath would silently drop pathname bytes and bind a
    // different repository. Percent-encoded pathname bytes remain unambiguous.
    if (parsed.hash || parsed.search) {
      throw new Error("ambiguous file URL suffix");
    }
    return fileURLToPath(parsed);
  } catch {
    throw new BrokerError(
      "REMOTE_URL_UNKNOWN",
      `Could not resolve local ${purpose} remote ${remote}.`,
      { remote, url: value },
    );
  }
}

/** Remove one command record terminator without changing legal whitespace in a local pathname. */
export function singleGitOutputRecord(output: string): string | undefined {
  // Git writes LF to its pipe on every supported host. Treating CRLF as one delimiter would remove
  // a legal final CR byte from a POSIX pathname and could bind a same-named sibling repository.
  if (!output.endsWith("\n")) return undefined;
  const value = output.slice(0, -1);
  // Node replaces malformed stdout bytes while decoding UTF-8. Refuse that ambiguity rather than
  // risk resolving the replacement-character spelling to a different repository on disk.
  return value.length > 0 && !/[\0\r\n\ufffd]/u.test(value) ? value : undefined;
}
