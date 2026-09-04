import path from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { spawn } from "node:child_process";
import {
  chmod,
  lchmod,
  lstat,
  mkdir,
  mkdtemp,
  opendir,
  readFile,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { BrokerError } from "./errors.js";
import { runCommand, type CommandResult } from "./process.js";
import type { SubmissionWorktreeIdentity } from "./types.js";

export interface WorktreeInfo {
  path: string;
  head: string;
  branch?: string;
  bare: boolean;
  detached: boolean;
  prunable: boolean;
}

export interface PinnedGitCommit {
  /** Broker-owned ref that keeps the commit reachable. Subsequent authority should use `oid`. */
  ref: string;
  oid: string;
}

export interface LinearCommitHistory {
  baseOid: string;
  headOid: string;
  /** Commits after `baseOid`, ordered from oldest to newest. */
  commits: string[];
}

interface RawTreeEntry {
  mode: "100644" | "100755" | "120000" | "160000";
  type: "blob" | "commit";
  oid: string;
  path: string;
}

interface PortablePathNode {
  /** Original spelling of this one component, retained to detect case aliases. */
  component: string;
  /** First complete Git path that established this node, used only for diagnostics. */
  firstPath: string;
  leaf: boolean;
  children: Map<string, PortablePathNode>;
}

interface RawTreeSnapshot {
  entries: RawTreeEntry[];
  /** Every explicit subtree reached by this snapshot, including empty directories. */
  treeOids: string[];
  pathBytes: number;
  componentVisits: number;
  /** Unique physical directories implied by the flattened tree, parents before children. */
  parentPrefixes: string[];
}

interface RawCommitIdentity {
  parents: string[];
  treeOid: string;
}

interface RawTreeChildIdentity {
  oid: string;
  nameByteLength: number;
}

interface RawTreeObjectIdentity {
  byteLength: number;
  blobs: RawTreeChildIdentity[];
  trees: RawTreeChildIdentity[];
}

interface RawWorktreeAdministration {
  destination: string;
  physicalDestination: string;
  destinationDevice?: string;
  destinationInode?: string;
  gitDir: string;
  physicalGitDir: string;
  gitDirDevice: string;
  gitDirInode: string;
  physicalCommonGitDir: string;
}

const ADOPTED_REF_PREFIX = "refs/merge-broker/adopted";
const GATE_MINIMUM_GIT: readonly [number, number] = [2, 46];
const GATE_MAX_COMMIT_BYTES = 1 * 1_024 * 1_024;
const GATE_MAX_TREE_LIST_BYTES = 32 * 1_024 * 1_024;
const GATE_MAX_BLOB_BYTES = 64 * 1_024 * 1_024;
const GATE_MAX_MATERIALIZED_BYTES = 256 * 1_024 * 1_024;
const GATE_MAX_TRACKED_PATHS = 100_000;
const GATE_MAX_PATH_BYTES = 16 * 1_024;
const GATE_MAX_PATH_DEPTH = 256;
const GATE_MAX_PATH_COMPONENT_VISITS = 1_000_000;
const GATE_MAX_PARENT_PREFIXES = 200_000;
const GATE_MAX_PARENT_PREFIX_BYTES = 64 * 1_024 * 1_024;
const GATE_MAX_OBJECT_STORE_ENTRIES = 500_000;
const GATE_MAX_CLEANUP_DIRECTORIES = 200_000;
// One protected-base snapshot plus the hard maximum retained candidate history.
const GATE_MAX_CLOSURE_COMMITS = 1_001;
const GATE_MAX_CLOSURE_ENTRIES = 1_000_000;
const GATE_MAX_CLOSURE_PATH_BYTES = 128 * 1_024 * 1_024;
const GATE_MAX_HISTORY_DIFF_BYTES = 128 * 1_024 * 1_024;
const GATE_MAX_HISTORY_DIFF_RECORDS = 1_000_000;
const GATE_MAX_CLOSURE_TREE_BYTES = 192 * 1_024 * 1_024;
const GATE_MAX_CLOSURE_BLOBS = 200_000;
const GATE_MAX_CLOSURE_TREES = 10_000;
const GATE_MAX_HISTORY_COMMITS = 1_000;
const GATE_GIT_ENVIRONMENT_OVERRIDES = [
  "GIT_INDEX_FILE",
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_NAMESPACE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
  "GIT_GRAFT_FILE",
  "GIT_SHALLOW_FILE",
  "GIT_REPLACE_REF_BASE",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_EXEC_PATH",
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_SSH_VARIANT",
  "GIT_PROXY_COMMAND",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "FTP_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "RSYNC_PROXY",
  "CURL_CA_BUNDLE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const;
const GATE_GIT_CONFIG_ARGUMENTS = [
  "-c", "core.fsmonitor=false",
  "-c", "core.untrackedCache=false",
  "-c", "core.ignoreCase=false",
  "-c", "core.sparseCheckout=false",
  "-c", "core.sparseCheckoutCone=false",
] as const;

export function isGateGitEnvironmentOverride(name: string): boolean {
  const normalized = name.toUpperCase();
  return (GATE_GIT_ENVIRONMENT_OVERRIDES as readonly string[]).includes(normalized) ||
    /^GIT_(?:HTTP|SSL)_/u.test(normalized) ||
    /^GIT_CONFIG_(?:KEY|VALUE)_\d+$/u.test(normalized);
}

function localGateGitEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = { ...process.env, GIT_NO_LAZY_FETCH: "1" };
  for (const name of Object.keys(environment)) {
    if (isGateGitEnvironmentOverride(name)) delete environment[name];
  }
  return environment;
}

/** Canonicalize a directory entry without following the entry itself. */
async function physicalDirectoryEntry(value: string): Promise<string> {
  const resolved = path.resolve(value);
  return path.join(await realpath(path.dirname(resolved)), path.basename(resolved));
}

/** Preserve platform file IDs without truncating 64-bit inode values through JS numbers. */
async function filesystemIdentity(value: string): Promise<{ device: string; inode: string }> {
  const status = await lstat(value, { bigint: true });
  return { device: status.dev.toString(), inode: status.ino.toString() };
}

/** Git learned to honor GIT_NO_LAZY_FETCH for ordinary object reads in 2.46. */
export function supportsGateGitVersion(output: string): boolean {
  const match = /(?:^|\s)git version\s+(\d+)\.(\d+)(?:\.\d+)?/iu.exec(output);
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major > GATE_MINIMUM_GIT[0] ||
    (major === GATE_MINIMUM_GIT[0] && minor >= GATE_MINIMUM_GIT[1]);
}

const HFS_IGNORABLE = /[\u200c-\u200f\u202a-\u202e\u206a-\u206f\ufeff]/gu;

/** Validate one Git path against the intersection of supported host filesystem semantics. */
export function gatePortablePathKey(relativePath: string): string {
  const parts = relativePath.split("/");
  if (
    relativePath.length === 0 ||
    relativePath.includes("\\") ||
    path.posix.isAbsolute(relativePath) ||
    /^[A-Za-z]:/u.test(relativePath) ||
    parts.some((part) => {
      const portable = part.normalize("NFC").replace(HFS_IGNORABLE, "").toLowerCase();
      const dosBase = portable.split(".")[0] ?? "";
      return part === "" ||
        part === "." ||
        part === ".." ||
        // APFS/HFS and NTFS case-fold tables are not equivalent to JavaScript's Unicode casing
        // (for example ss/ß, sigma variants, and ligatures). Restrict this first portable writer
        // to printable ASCII until we can bind against filesystem-grade folding on every host.
        /[^\x20-\x7e]/u.test(part) ||
        Buffer.byteLength(part, "utf8") > 255 ||
        /[\x00-\x1f\x7f<>:"|?*]/u.test(part) ||
        /[. ]$/u.test(part) ||
        portable === ".git" ||
        /^[A-Za-z0-9!#$%&'()@^_`{}-]{1,6}~[1-9][0-9]*(?:\.[A-Za-z0-9!#$%&'()@^_`{}~-]{1,3})?$/u.test(part) ||
        /^(?:con|prn|aux|nul|conin\$|conout\$|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])$/u.test(dosBase);
    })
  ) {
    throw new BrokerError("UNSAFE_PATH", `Gate candidate contains an unsafe Git path: ${relativePath}`);
  }
  return parts
    .map((part) => part.normalize("NFC").replace(HFS_IGNORABLE, "").toLowerCase())
    .join("/");
}

function gatePath(relativePath: string, root: string): string {
  gatePortablePathKey(relativePath);
  const parts = relativePath.split("/");
  const destination = path.resolve(root, ...parts);
  const prefix = `${path.resolve(root)}${path.sep}`;
  if (!destination.startsWith(prefix)) {
    throw new BrokerError("UNSAFE_PATH", `Gate candidate path escapes its worktree: ${relativePath}`);
  }
  return destination;
}

function decodeGatePath(pathBytes: Buffer): string {
  if (pathBytes.byteLength === 0 || pathBytes.byteLength > GATE_MAX_PATH_BYTES) {
    throw new BrokerError(
      "SUBMISSION_TOO_LARGE",
      `Gate candidate contains a path outside the 1-${GATE_MAX_PATH_BYTES} byte safety range.`,
    );
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(pathBytes);
  } catch {
    throw new BrokerError(
      "UNSAFE_PATH",
      "Gate requires tracked paths to be valid UTF-8 on every supported platform.",
    );
  }
}

/** Build the broker-owned retention ref before recording a pin intent. */
export function adoptedRef(pinId: string): string {
  const safe =
    pinId.length <= 128 &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/u.test(pinId) &&
    !pinId.includes("..") &&
    !pinId.toLowerCase().endsWith(".lock");
  if (!safe) {
    throw new BrokerError("INVALID_ARGUMENTS", `Invalid adoption pin identifier: ${pinId}`, {
      pinId,
    });
  }
  return `${ADOPTED_REF_PREFIX}/${pinId}`;
}

function splitNull(value: string): string[] {
  // `-z` output is already unambiguous. Trimming would silently change a legal Git path whose name
  // begins or ends with whitespace.
  return value.split("\0").filter((part) => part.length > 0);
}

export function remoteUrlFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function isHostQualifiedForgeRepository(value: string | undefined): value is string {
  if (!value) return false;
  const parts = value.split("/");
  return parts.length === 3 && parts.every(Boolean);
}

function forgeRepositoryFromRemote(value: string): string | undefined {
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

function canonicalRemoteUrl(value: string, repoRoot: string): string {
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

function localFileRemotePath(value: string, remote: string, purpose: "fetch" | "publication"): string {
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
function singleGitOutputRecord(output: string): string | undefined {
  // Git writes LF to its pipe on every supported host. Treating CRLF as one delimiter would remove
  // a legal final CR byte from a POSIX pathname and could bind a same-named sibling repository.
  if (!output.endsWith("\n")) return undefined;
  const value = output.slice(0, -1);
  // Node replaces malformed stdout bytes while decoding UTF-8. Refuse that ambiguity rather than
  // risk resolving the replacement-character spelling to a different repository on disk.
  return value.length > 0 && !/[\0\r\n\ufffd]/u.test(value) ? value : undefined;
}

export class GitRepository {
  readonly root: string;
  readonly commonGitDir: string;
  private readonly rawWorktreeAdministrations = new Map<string, RawWorktreeAdministration>();

  private constructor(root: string, commonGitDir: string) {
    this.root = root;
    this.commonGitDir = commonGitDir;
  }

  static async discover(cwd = process.cwd()): Promise<GitRepository> {
    const top = await runCommand("git", ["rev-parse", "--show-toplevel"], { cwd });
    const root = path.resolve(top.stdout.trim());
    const common = await runCommand("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], {
      cwd: root,
    });
    return new GitRepository(root, path.resolve(common.stdout.trim()));
  }

  async git(args: string[], cwd = this.root, allowFailure = false): Promise<CommandResult> {
    return await runCommand("git", args, { cwd, allowFailure });
  }

  /** Run Git without allowing a partial/promisor clone to fetch missing objects implicitly. */
  async localObjectGit(args: string[], cwd = this.root, allowFailure = false): Promise<CommandResult> {
    return await runCommand("git", [...GATE_GIT_CONFIG_ARGUMENTS, ...args], {
      cwd,
      allowFailure,
      env: localGateGitEnvironment(),
    });
  }

  /** Mutable transport commands can redirect an already fingerprinted locator on a second use. */
  private async assertNoUrlRewriteConfiguration(code: string): Promise<void> {
    const result = await runCommand(
      "git",
      [
        ...GATE_GIT_CONFIG_ARGUMENTS,
        "config",
        "--includes",
        "--null",
        "--get-regexp",
        "^(url\\..*\\.(insteadof|pushinsteadof)|core\\.(sshcommand|gitproxy)|http(\\..*)?\\.(proxy|proxyauthmethod|ssl[^.]*|curloptresolve|followredirects))$",
      ],
      {
        cwd: this.root,
        allowFailure: true,
        env: localGateGitEnvironment(),
        maxOutputBytes: 64 * 1_024,
      },
    );
    if (result.exitCode === 1 && result.stdout.length === 0) {
      await this.assertNoHttpRoutingHeaders(code);
      return;
    }
    if (result.exitCode === 0 && result.stdout.length > 0) {
      throw new BrokerError(
        code,
        "Git transport, proxy, TLS, or URL rewrite rules can redirect or weaken the broker's exact remote locator; remove the reported settings before retrying.",
        { configuredRules: splitNull(result.stdout).map((item) => item.split("\n", 1)[0]) },
      );
    }
    throw new BrokerError(
      code,
      "Could not prove that Git has no transport command or URL rewrite rules before exact-target access.",
      { exitCode: result.exitCode, stderr: result.stderr },
    );
  }

  /** Allow credential headers, but never let config replace the URL's HTTP authority. */
  private async assertNoHttpRoutingHeaders(code: string): Promise<void> {
    const result = await runCommand(
      "git",
      [
        ...GATE_GIT_CONFIG_ARGUMENTS,
        "config",
        "--includes",
        "--null",
        "--get-regexp",
        "^http(\\..*)?\\.extraheader$",
      ],
      {
        cwd: this.root,
        allowFailure: true,
        env: localGateGitEnvironment(),
        maxOutputBytes: 64 * 1_024,
      },
    );
    if (result.exitCode === 1 && result.stdout.length === 0) return;
    if (result.exitCode === 0 && !result.stdout.includes("... output truncated by Merge Broker ...")) {
      const routingHeader = splitNull(result.stdout).find((record) => {
        const separator = record.indexOf("\n");
        const value = separator >= 0 ? record.slice(separator + 1) : "";
        return /[\r\n]/u.test(value) || /^\s*(?:host|:authority)\s*(?::|;|$)/iu.test(value);
      });
      if (!routingHeader) return;
      throw new BrokerError(
        code,
        "Git HTTP extraHeader configuration cannot replace Host or :authority during exact-target access.",
        { configuredRule: routingHeader.slice(0, routingHeader.indexOf("\n")) },
      );
    }
    throw new BrokerError(
      code,
      "Could not prove that Git HTTP headers preserve the exact remote authority.",
      { exitCode: result.exitCode, stderr: result.stderr },
    );
  }

  /** An exact URL/path must not be reinterpreted as any mutable Git remote shorthand. */
  private async assertExactRemoteLocator(remote: string, code: string): Promise<void> {
    await this.assertNoUrlRewriteConfiguration(code);
    const effective = await runCommand(
      "git",
      [...GATE_GIT_CONFIG_ARGUMENTS, "config", "--includes", "--null", "--name-only", "--get-regexp", "^remote\\."],
      {
        cwd: this.root,
        allowFailure: true,
        env: localGateGitEnvironment(),
        maxOutputBytes: 256 * 1_024,
      },
    );
    if (effective.exitCode === 0) {
      if (effective.stdout.includes("... output truncated by Merge Broker ...")) {
        throw new BrokerError(
          code,
          "The effective Git remote configuration is too large to prove an exact target safely.",
          { remote },
        );
      }
      const collision = splitNull(effective.stdout).some((name) => {
        if (!name.startsWith("remote.")) return false;
        const variableSeparator = name.lastIndexOf(".");
        return variableSeparator > "remote.".length &&
          name.slice("remote.".length, variableSeparator) === remote;
      });
      if (collision) {
        throw new BrokerError(
          code,
          "The exact Git URL/path is also an effective remote subsection and would be reinterpreted through mutable remote settings.",
          { remote },
        );
      }
    } else if (effective.exitCode !== 1 || effective.stdout.length > 0) {
      throw new BrokerError(
        code,
        "Could not inspect effective Git remote configuration before exact-target access.",
        { remote, exitCode: effective.exitCode, stderr: effective.stderr },
      );
    }
    const configured = await runCommand(
      "git",
      [...GATE_GIT_CONFIG_ARGUMENTS, "remote", "get-url", "--push", remote],
      {
        cwd: this.root,
        allowFailure: true,
        env: localGateGitEnvironment(),
        maxOutputBytes: 64 * 1_024,
      },
    );
    if (configured.exitCode === 0) {
      throw new BrokerError(
        code,
        "The exact Git URL/path is also configured as a Git remote shorthand and would be reinterpreted through mutable remote settings.",
        { remote },
      );
    }
    // Git 2.46+ reports an unknown remote with status 2. Any other outcome is ambiguous and must
    // not authorize transport to an allegedly exact target.
    if (configured.exitCode !== 2 || configured.stdout.length > 0) {
      throw new BrokerError(
        code,
        "Could not prove that the exact Git URL/path is free of configured or legacy remote shorthands.",
        { remote, exitCode: configured.exitCode, stderr: configured.stderr },
      );
    }
  }

  /** Refuse Gate before any object lookup when Git cannot suppress promisor lazy fetching. */
  async assertGateGitSupported(): Promise<void> {
    const environmentOverride = Object.entries(process.env).find(
      ([name, value]) => isGateGitEnvironmentOverride(name) && (value ?? "").length > 0,
    )?.[0];
    if (environmentOverride) {
      throw new BrokerError(
        "SUBMISSION_GIT_UNSUPPORTED",
        `Trusted local-ref intake does not accept ambient ${environmentOverride} Git overrides.`,
        { environmentVariable: environmentOverride },
      );
    }
    const result = await runCommand("git", ["--version"], { cwd: this.root, allowFailure: true });
    if (result.exitCode === 0 && supportsGateGitVersion(result.stdout)) {
      await this.assertNoUrlRewriteConfiguration("SUBMISSION_GIT_UNSUPPORTED");
      return;
    }
    const version = result.stdout.trim() || result.stderr.trim() || "unknown";
    throw new BrokerError(
      "SUBMISSION_GIT_UNSUPPORTED",
      `Trusted local-ref intake requires Git 2.46 or newer; found ${version}.`,
      { version, minimum: "2.46" },
    );
  }

  /** Gate pins must retain objects in this repository, not merely name objects borrowed elsewhere. */
  async assertGateObjectStoreSupported(): Promise<void> {
    const objectsDirectory = path.join(this.commonGitDir, "objects");
    await this.assertPhysicalObjectStore(objectsDirectory);
    const alternatesPath = path.join(objectsDirectory, "info", "alternates");
    let unsupportedAlternates = false;
    try {
      await lstat(alternatesPath);
      // Even whitespace is a meaningful relative path to Git, and special files can redirect or
      // block the read. Fail closed on any alternates entry; only absence is unambiguous.
      unsupportedAlternates = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (unsupportedAlternates) {
      throw new BrokerError(
        "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
        "Trusted local-ref intake does not accept repositories that borrow an alternate object store.",
        { alternatesPath },
      );
    }

    // Revision expressions such as `ref~1` are resolved by Git before the raw-parent proof below.
    // Legacy grafts can rewrite that resolution even under --no-replace-objects, so refuse them at
    // Gate entry rather than allowing a friendly expression to name a graft-selected object.
    const graftsPath = path.join(this.commonGitDir, "info", "grafts");
    let unsupportedGrafts = false;
    try {
      const status = await lstat(graftsPath);
      unsupportedGrafts = !status.isFile() || status.size !== 0;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (unsupportedGrafts) {
      throw new BrokerError(
        "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
        "Trusted local-ref intake does not accept repositories with legacy Git grafts.",
        { graftsPath },
      );
    }
  }

  /** Reject any redirectable or special node anywhere in the repository's object-store tree. */
  private async assertPhysicalObjectStore(objectsDirectory: string): Promise<void> {
    let physicalRoot: string;
    try {
      const [status, physical] = await Promise.all([
        lstat(objectsDirectory),
        realpath(objectsDirectory),
      ]);
      if (!status.isDirectory() || status.isSymbolicLink()) throw new Error("redirected objects root");
      physicalRoot = physical;
    } catch (error) {
      throw new BrokerError(
        "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
        "Trusted local-ref intake requires a repository-owned, non-redirectable objects directory.",
        {
          objectsDirectory,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }

    const pending = [objectsDirectory];
    let inspected = 0;
    while (pending.length > 0) {
      const directory = pending.pop() ?? objectsDirectory;
      let entries: Awaited<ReturnType<typeof opendir>>;
      try {
        entries = await opendir(directory);
      } catch (error) {
        throw new BrokerError(
          "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
          "Trusted local-ref intake could not inspect the complete local object store.",
          { directory, cause: error instanceof Error ? error.message : String(error) },
        );
      }
      try {
        // Stream entries instead of allocating a complete directory listing: a malformed object
        // store with one enormous fanout directory must hit the count ceiling before exhausting
        // broker memory.
        for await (const entry of entries) {
          inspected += 1;
          if (inspected > GATE_MAX_OBJECT_STORE_ENTRIES) {
            throw new BrokerError(
              "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
              `Trusted local-ref intake cannot inspect object stores with more than ${GATE_MAX_OBJECT_STORE_ENTRIES} filesystem entries.`,
              { objectsDirectory, maximumEntries: GATE_MAX_OBJECT_STORE_ENTRIES },
            );
          }
          const child = path.join(directory, entry.name);
          let status: Awaited<ReturnType<typeof lstat>>;
          let physical: string;
          try {
            [status, physical] = await Promise.all([lstat(child), realpath(child)]);
          } catch (error) {
            throw new BrokerError(
              "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
              "Trusted local-ref intake found an unreadable or redirected object-store entry.",
              { path: child, cause: error instanceof Error ? error.message : String(error) },
            );
          }
          const relative = path.relative(physicalRoot, physical);
          const contained = relative !== "" &&
            relative !== ".." &&
            !relative.startsWith(`..${path.sep}`) &&
            !path.isAbsolute(relative);
          if (
            status.isSymbolicLink() ||
            (!status.isDirectory() && !status.isFile()) ||
            !contained
          ) {
            throw new BrokerError(
              "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
              "Trusted local-ref intake found a redirected or special object-store entry.",
              { path: child, physicalPath: physical },
            );
          }
          if (status.isDirectory()) pending.push(child);
        }
      } catch (error) {
        if (error instanceof BrokerError) throw error;
        throw new BrokerError(
          "SUBMISSION_OBJECT_STORE_UNSUPPORTED",
          "Trusted local-ref intake could not inspect the complete local object store.",
          { directory, cause: error instanceof Error ? error.message : String(error) },
        );
      }
    }
  }

  /** Capture bounded binary Git output without text decoding or promisor lazy fetch. */
  private async localObjectGitBuffer(
    args: string[],
    cwd: string,
    input: string | undefined,
    maxOutputBytes: number,
  ): Promise<Buffer> {
    return await new Promise<Buffer>((resolve, reject) => {
      const child = spawn("git", [...GATE_GIT_CONFIG_ARGUMENTS, ...args], {
        cwd,
        env: localGateGitEnvironment(),
        shell: false,
        stdio: "pipe",
        windowsHide: true,
      });
      const chunks: Buffer[] = [];
      const errors: Buffer[] = [];
      let outputBytes = 0;
      let errorBytes = 0;
      let overflow = false;
      let settled = false;
      const fail = (error: unknown): void => {
        if (settled) return;
        settled = true;
        reject(error);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > maxOutputBytes) {
          overflow = true;
          child.kill("SIGKILL");
          return;
        }
        chunks.push(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        if (errorBytes >= 64 * 1_024) return;
        errors.push(chunk);
        errorBytes += chunk.byteLength;
      });
      child.once("error", fail);
      child.once("close", (code, signal) => {
        if (settled) return;
        settled = true;
        const stderr = Buffer.concat(errors).subarray(0, 64 * 1_024).toString("utf8");
        if (overflow) {
          reject(new BrokerError(
            "SUBMISSION_TOO_LARGE",
            `Gate Git object output exceeds the ${maxOutputBytes}-byte safety limit.`,
            { maximumBytes: maxOutputBytes },
          ));
          return;
        }
        if (code !== 0) {
          reject(new BrokerError(
            "GIT_OBJECT_READ_FAILED",
            "Could not read the candidate's local Git objects.",
            { exitCode: code ?? (signal ? 128 : 1), stderr },
          ));
          return;
        }
        resolve(Buffer.concat(chunks, outputBytes));
      });
      child.stdin.on("error", () => {
        // A failing Git process can close stdin before Node finishes writing the bounded request.
      });
      child.stdin.end(input);
    });
  }

  /** Resolve gh's host-qualified `HOST/OWNER/REPO` selector from the exact Git push remote. */
  async forgeRepository(remote: string): Promise<string> {
    const value = await this.remotePushUrl(remote);
    return this.forgeRepositoryFromUrl(value);
  }

  forgeRepositoryFromUrl(value: string): string {
    const repository = forgeRepositoryFromRemote(value);
    if (!repository) {
      throw new BrokerError(
        "REMOTE_REPOSITORY_UNKNOWN",
        `Could not derive a GitHub repository from publication remote ${value}; refusing to use gh's ambient default.`,
        { remote: value },
      );
    }
    return repository;
  }

  async remotePushUrl(remote: string, errorCode = "REMOTE_URL_UNKNOWN"): Promise<string> {
    await this.assertNoUrlRewriteConfiguration(errorCode);
    const configured = await this.localObjectGit(["remote", "get-url", "--push", remote], this.root, true);
    const value = singleGitOutputRecord(configured.stdout);
    if (configured.exitCode !== 0 || !value) {
      throw new BrokerError("REMOTE_URL_UNKNOWN", `Could not resolve the push URL for remote ${remote}.`, { remote });
    }
    const canonical = canonicalRemoteUrl(value, this.root);
    let localPath: string | undefined;
    if (/^file:\/\//u.test(canonical)) {
      localPath = localFileRemotePath(canonical, remote, "publication");
    } else if (path.isAbsolute(canonical)) {
      localPath = canonical;
    }
    if (!localPath) {
      await this.assertNoUrlRewriteConfiguration(errorCode);
      return canonical;
    }
    try {
      // Use the physical target for both the durable fingerprint and later Git commands. Otherwise
      // a symlink (or Windows junction) can be redirected after assembly while retaining the same
      // configured URL, sending a validated batch to a different repository.
      const physical = await realpath(localPath);
      await this.assertNoUrlRewriteConfiguration(errorCode);
      return physical;
    } catch {
      throw new BrokerError(
        "REMOTE_URL_UNKNOWN",
        `Could not resolve local publication remote ${remote}.`,
        { remote, url: value },
      );
    }
  }

  /** Resolve and physically bind the URL Git uses to fetch from a named remote. */
  async remoteFetchUrl(remote: string, errorCode = "REMOTE_URL_UNKNOWN"): Promise<string> {
    await this.assertNoUrlRewriteConfiguration(errorCode);
    const configured = await this.localObjectGit(["remote", "get-url", remote], this.root, true);
    const value = singleGitOutputRecord(configured.stdout);
    if (configured.exitCode !== 0 || !value) {
      throw new BrokerError("REMOTE_URL_UNKNOWN", `Could not resolve the fetch URL for remote ${remote}.`, { remote });
    }
    const canonical = canonicalRemoteUrl(value, this.root);
    let localPath: string | undefined;
    if (/^file:\/\//u.test(canonical)) {
      localPath = localFileRemotePath(canonical, remote, "fetch");
    } else if (path.isAbsolute(canonical)) {
      localPath = canonical;
    }
    if (!localPath) {
      await this.assertNoUrlRewriteConfiguration(errorCode);
      return canonical;
    }
    try {
      const physical = await realpath(localPath);
      await this.assertNoUrlRewriteConfiguration(errorCode);
      return physical;
    } catch {
      throw new BrokerError(
        "REMOTE_URL_UNKNOWN",
        `Could not resolve local fetch remote ${remote}.`,
        { remote, url: value },
      );
    }
  }

  /** Return the exact URL whose fingerprint was bound when the batch was assembled. */
  async boundRemoteUrl(remote: string, expectedFingerprint?: string): Promise<string> {
    const value = await this.remotePushUrl(remote, "REMOTE_TARGET_CHANGED");
    if (expectedFingerprint && remoteUrlFingerprint(value) !== expectedFingerprint) {
      throw new BrokerError(
        "REMOTE_TARGET_CHANGED",
        `Remote ${remote} no longer points at the Git target recorded when this batch was assembled.`,
        { remote, expectedFingerprint, actualFingerprint: remoteUrlFingerprint(value) },
      );
    }
    return value;
  }

  /**
   * Commit-producing broker operations run with a stable committer identity, signing disabled,
   * and an empty broker-owned hook directory. Ambient user config and repository hooks must not be
   * able to inject bytes after validation or make a fresh clone fail with no Git identity.
   */
  private async brokerCommitGit(
    args: string[],
    cwd: string,
    allowFailure = false,
  ): Promise<CommandResult> {
    return await this.withIsolatedHooks(async (hooksDirectory) =>
      await runCommand("git", [
        "-c", `core.hooksPath=${hooksDirectory}`,
        "-c", "commit.gpgSign=false",
        "-c", "user.useConfigOnly=true",
        "-c", "user.name=Agent Merge Broker",
        "-c", "user.email=merge-broker@localhost",
        ...args,
      ], { cwd, allowFailure })
    );
  }

  /** Run one broker-owned Git transaction with a fresh, create-only empty hook directory. */
  private async withIsolatedHooks<T>(operation: (hooksDirectory: string) => Promise<T>): Promise<T> {
    const hooksDirectory = await mkdtemp(path.join(this.commonGitDir, "merge-broker-disabled-hooks-"));
    let expectedIdentity: { device: string; inode: string } | undefined;
    let expectedPhysical: string | undefined;
    const assertUnchangedEmptyDirectory = async (): Promise<void> => {
      const [status, identity, physicalHooks, physicalCommon] = await Promise.all([
        lstat(hooksDirectory),
        filesystemIdentity(hooksDirectory),
        realpath(hooksDirectory),
        realpath(this.commonGitDir),
      ]);
      const relative = path.relative(physicalCommon, physicalHooks);
      if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        (expectedIdentity && (
          identity.device !== expectedIdentity.device || identity.inode !== expectedIdentity.inode
        )) ||
        (expectedPhysical && physicalHooks !== expectedPhysical) ||
        relative === "" ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) ||
        relative.includes(path.sep)
      ) {
        throw new BrokerError(
          "GIT_HOOK_ISOLATION_FAILED",
          "The isolated broker Git hook directory changed or left the repository.",
          { hooksDirectory },
        );
      }
      const directory = await opendir(hooksDirectory);
      try {
        if (await directory.read() !== null) {
          throw new BrokerError(
            "GIT_HOOK_ISOLATION_FAILED",
            "The isolated broker Git hook directory is no longer empty.",
            { hooksDirectory },
          );
        }
      } finally {
        await directory.close().catch(() => undefined);
      }
      expectedIdentity ??= identity;
      expectedPhysical ??= physicalHooks;
    };
    try {
      await chmod(hooksDirectory, 0o700);
      await assertUnchangedEmptyDirectory();
      const result = await operation(hooksDirectory);
      await assertUnchangedEmptyDirectory();
      return result;
    } finally {
      // Never recursively remove a pathname that another process could swap. An unchanged isolated
      // hook directory is empty, so exact non-recursive removal is sufficient; anything else is
      // retained for inspection without touching its contents.
      const safe = await assertUnchangedEmptyDirectory().then(() => true, () => false);
      if (safe) await rmdir(hooksDirectory).catch(() => undefined);
    }
  }

  async resolveCommit(revision: string): Promise<string> {
    const result = await this.git(
      ["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      this.root,
      true,
    );
    if (result.exitCode !== 0) {
      throw new BrokerError("UNKNOWN_COMMIT", `Git revision is not a commit: ${revision}`, {
        revision,
        stderr: result.stderr,
      });
    }
    return result.stdout.trim();
  }

  async currentHead(cwd = this.root): Promise<string> {
    return await this.resolveCommitAt("HEAD", cwd);
  }

  async resolveCommitAt(revision: string, cwd: string): Promise<string> {
    const result = await this.git(["rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`], cwd, true);
    if (result.exitCode !== 0) {
      throw new BrokerError("UNKNOWN_COMMIT", `Git revision is not a commit: ${revision}`, {
        revision,
        cwd,
        stderr: result.stderr,
      });
    }
    return result.stdout.trim();
  }

  /** Resolve a commit without allowing local replacement refs to redefine its object or history. */
  private async resolveUnreplacedCommitAt(revision: string, cwd: string): Promise<string> {
    const result = await this.localObjectGit(
      ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", `${revision}^{commit}`],
      cwd,
      true,
    );
    if (result.exitCode !== 0) {
      throw new BrokerError("UNKNOWN_COMMIT", `Git revision is not a commit: ${revision}`, {
        revision,
        stderr: result.stderr,
      });
    }
    return result.stdout.trim();
  }

  private async resolveUnreplacedCommit(revision: string): Promise<string> {
    return await this.resolveUnreplacedCommitAt(revision, this.root);
  }

  /** Read identity headers from the commit object itself, bypassing graft and shallow metadata. */
  private async rawCommitIdentity(oid: string): Promise<RawCommitIdentity> {
    const object = await this.localObjectGitBuffer(
      ["--no-replace-objects", "cat-file", "commit", oid],
      this.root,
      undefined,
      GATE_MAX_COMMIT_BYTES,
    );
    const algorithm = oid.length === 64 ? "sha256" : "sha1";
    const actualOid = createHash(algorithm)
      .update(`commit ${object.byteLength}\0`)
      .update(object)
      .digest("hex");
    if (actualOid !== oid) {
      throw new BrokerError(
        "GIT_OBJECT_READ_FAILED",
        `Retained commit ${oid} does not match its Git object identity.`,
        { expectedOid: oid, actualOid },
      );
    }
    const headerEnd = object.indexOf(Buffer.from("\n\n"));
    if (headerEnd < 0) {
      throw new BrokerError("HISTORY_INSPECTION_FAILED", `Commit ${oid} has no complete header.`);
    }
    // latin1 preserves every input byte one-to-one. Node's `ascii` decoder clears the high bit,
    // which could turn a malformed `\xf0arent` header that Git ignores into `parent` here.
    const headers = object.subarray(0, headerEnd).toString("latin1").split("\n");
    const treeLine = headers[0] ?? "";
    const treeOid = treeLine.startsWith("tree ") ? treeLine.slice("tree ".length) : "";
    const parents: string[] = [];
    let headerIndex = 1;
    while ((headers[headerIndex] ?? "").startsWith("parent ")) {
      parents.push((headers[headerIndex] ?? "").slice("parent ".length));
      headerIndex += 1;
    }
    // Git recognizes ancestry only from the contiguous parent block immediately after the leading
    // tree header. Never adopt a later parent-looking extension line that Git itself ignores.
    const misplacedIdentityHeader = headers
      .slice(headerIndex)
      .some((line) => line.startsWith("tree ") || line.startsWith("parent "));
    if (
      misplacedIdentityHeader ||
      treeOid.length !== oid.length ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(treeOid) ||
      parents.some((parent) => parent.length !== oid.length || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(parent))
    ) {
      throw new BrokerError("HISTORY_INSPECTION_FAILED", `Commit ${oid} has an invalid parent header.`);
    }
    return { parents, treeOid };
  }

  /** Parse and hash one raw tree object without asking Git to trust its pathname-derived OID. */
  private parseRawTreeObjectIdentity(oid: string, object: Buffer): RawTreeObjectIdentity {
    if (object.byteLength > GATE_MAX_TREE_LIST_BYTES) {
      throw new BrokerError(
        "SUBMISSION_TOO_LARGE",
        `Retained tree ${oid} exceeds the per-tree byte safety limit.`,
        { maximumBytes: GATE_MAX_TREE_LIST_BYTES },
      );
    }
    const algorithm = oid.length === 64 ? "sha256" : "sha1";
    const actualOid = createHash(algorithm)
      .update(`tree ${object.byteLength}\0`)
      .update(object)
      .digest("hex");
    if (actualOid !== oid) {
      throw new BrokerError(
        "GIT_OBJECT_READ_FAILED",
        `Retained tree ${oid} does not match its Git object identity.`,
        { expectedOid: oid, actualOid },
      );
    }

    const oidBytes = oid.length / 2;
    const blobs: RawTreeChildIdentity[] = [];
    const trees: RawTreeChildIdentity[] = [];
    let previousSortKey: Buffer | undefined;
    let offset = 0;
    while (offset < object.byteLength) {
      const space = object.indexOf(0x20, offset);
      const terminator = space < 0 ? -1 : object.indexOf(0, space + 1);
      if (space < 0 || terminator < 0 || terminator + 1 + oidBytes > object.byteLength) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", `Retained tree ${oid} is truncated.`);
      }
      const mode = object.subarray(offset, space).toString("ascii");
      const nameBytes = object.subarray(space + 1, terminator);
      const name = decodeGatePath(nameBytes);
      if (name.includes("/")) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", `Retained tree ${oid} contains an invalid entry name.`);
      }
      gatePortablePathKey(name);
      const childOid = object.subarray(terminator + 1, terminator + 1 + oidBytes).toString("hex");
      const tree = mode === "40000";
      if (!tree && !/^(?:100644|100755|120000|160000)$/u.test(mode)) {
        throw new BrokerError(
          "GIT_OBJECT_READ_FAILED",
          `Retained tree ${oid} contains unsupported mode ${mode}.`,
        );
      }
      const sortKey = Buffer.concat([nameBytes, tree ? Buffer.from("/") : Buffer.alloc(0)]);
      if (previousSortKey && Buffer.compare(previousSortKey, sortKey) >= 0) {
        throw new BrokerError(
          "GIT_OBJECT_READ_FAILED",
          `Retained tree ${oid} is not in canonical Git entry order.`,
        );
      }
      previousSortKey = sortKey;
      const child = { oid: childOid, nameByteLength: nameBytes.byteLength };
      if (tree) trees.push(child);
      else if (mode !== "160000") blobs.push(child);
      offset = terminator + 1 + oidBytes;
    }
    return { byteLength: object.byteLength, blobs, trees };
  }

  /** Hash many already-enumerated trees per Git process so deep valid graphs remain practical. */
  private async rawTreeObjectIdentities(oids: string[]): Promise<Map<string, RawTreeObjectIdentity>> {
    const unique = [...new Set(oids)];
    if (unique.length > GATE_MAX_CLOSURE_TREES) {
      throw new BrokerError(
        "SUBMISSION_TOO_LARGE",
        `Gate candidate history references more than ${GATE_MAX_CLOSURE_TREES} unique trees.`,
        { maximumTrees: GATE_MAX_CLOSURE_TREES },
      );
    }
    const identities = new Map<string, RawTreeObjectIdentity>();
    let treeBytes = 0;
    for (let start = 0; start < unique.length; start += 1_024) {
      const chunk = unique.slice(start, start + 1_024);
      const headerAllowance = chunk.length * 128;
      const remainingBytes = GATE_MAX_CLOSURE_TREE_BYTES - treeBytes;
      const output = await this.localObjectGitBuffer(
        ["--no-replace-objects", "cat-file", "--batch"],
        this.root,
        `${chunk.join("\n")}\n`,
        remainingBytes + headerAllowance,
      );
      let offset = 0;
      for (const expectedOid of chunk) {
        const newline = output.indexOf(0x0a, offset);
        if (newline < 0) {
          throw new BrokerError("GIT_OBJECT_READ_FAILED", "Git returned a truncated tree batch header.");
        }
        const header = output.subarray(offset, newline).toString("ascii");
        const match = /^([0-9a-f]{40}|[0-9a-f]{64}) tree ([0-9]+)$/u.exec(header);
        if (!match || match[1] !== expectedOid) {
          throw new BrokerError(
            "GIT_OBJECT_READ_FAILED",
            `Git returned an unexpected object for retained tree ${expectedOid}.`,
            { header },
          );
        }
        const size = Number(match[2]);
        const contentStart = newline + 1;
        const contentEnd = contentStart + size;
        if (
          !Number.isSafeInteger(size) ||
          size < 0 ||
          contentEnd >= output.byteLength ||
          output[contentEnd] !== 0x0a
        ) {
          throw new BrokerError("GIT_OBJECT_READ_FAILED", `Git returned truncated bytes for tree ${expectedOid}.`);
        }
        const identity = this.parseRawTreeObjectIdentity(
          expectedOid,
          output.subarray(contentStart, contentEnd),
        );
        treeBytes += identity.byteLength;
        if (treeBytes > GATE_MAX_CLOSURE_TREE_BYTES) {
          throw new BrokerError(
            "SUBMISSION_TOO_LARGE",
            "Gate candidate history contains too many raw tree bytes to verify safely.",
            { maximumTreeBytes: GATE_MAX_CLOSURE_TREE_BYTES },
          );
        }
        identities.set(expectedOid, identity);
        offset = contentEnd + 1;
      }
      if (offset !== output.byteLength) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", "Git returned trailing bytes for a tree batch.");
      }
    }
    return identities;
  }

  private async rawTreeEntries(commit: string): Promise<RawTreeSnapshot> {
    const output = await this.localObjectGitBuffer(
      ["--no-replace-objects", "ls-tree", "-r", "-t", "-z", "--full-tree", commit],
      this.root,
      undefined,
      GATE_MAX_TREE_LIST_BYTES,
    );
    const entries: RawTreeEntry[] = [];
    const treeOids: string[] = [];
    const portableRoot: PortablePathNode = {
      component: "",
      firstPath: "",
      leaf: false,
      children: new Map(),
    };
    let portableNodes = 0;
    let componentVisits = 0;
    let pathBytes = 0;
    let offset = 0;
    while (offset < output.byteLength) {
      const terminator = output.indexOf(0, offset);
      if (terminator < 0) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", "Git returned an unterminated tree entry.");
      }
      const record = output.subarray(offset, terminator);
      offset = terminator + 1;
      const separator = record.indexOf(0x09);
      if (separator < 0) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", "Git returned an invalid tree entry.");
      }
      const metadata = record.subarray(0, separator).toString("ascii");
      const match = /^(040000|100644|100755|120000|160000) (tree|blob|commit) ([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(metadata);
      if (!match) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", `Gate cannot materialize tree entry: ${metadata}`);
      }
      const treeEntry = match[1] === "040000" && match[2] === "tree";
      if (!treeEntry && entries.length >= GATE_MAX_TRACKED_PATHS) {
        throw new BrokerError(
          "SUBMISSION_TOO_LARGE",
          `Gate candidate contains more than ${GATE_MAX_TRACKED_PATHS} tracked paths.`,
          { maximumPaths: GATE_MAX_TRACKED_PATHS },
        );
      }
      const relativePath = decodeGatePath(record.subarray(separator + 1));
      pathBytes += Buffer.byteLength(relativePath, "utf8");
      gatePath(relativePath, this.root);
      const parts = relativePath.split("/");
      if (parts.length > GATE_MAX_PATH_DEPTH) {
        throw new BrokerError(
          "SUBMISSION_TOO_LARGE",
          `Gate candidate path exceeds the ${GATE_MAX_PATH_DEPTH}-component depth limit: ${relativePath}`,
          { path: relativePath, maximumDepth: GATE_MAX_PATH_DEPTH },
        );
      }
      componentVisits += parts.length;
      if (componentVisits > GATE_MAX_PATH_COMPONENT_VISITS) {
        throw new BrokerError(
          "SUBMISSION_TOO_LARGE",
          `Gate candidate tree exceeds the ${GATE_MAX_PATH_COMPONENT_VISITS}-component inspection limit.`,
          { maximumComponentVisits: GATE_MAX_PATH_COMPONENT_VISITS },
        );
      }

      // A component trie makes collision detection proportional to the actual path input. Building
      // every complete prefix with slice/join is quadratic for one deep path and repeats that work
      // for every leaf below a shared directory.
      let node = portableRoot;
      for (let index = 0; index < parts.length; index += 1) {
        const component = parts[index] ?? "";
        const key = gatePortablePathKey(component);
        const leaf = index === parts.length - 1 && !treeEntry;
        let child = node.children.get(key);
        if (!child) {
          child = {
            component,
            firstPath: relativePath,
            leaf: false,
            children: new Map(),
          };
          node.children.set(key, child);
          portableNodes += 1;
          if (portableNodes > GATE_MAX_TRACKED_PATHS + GATE_MAX_PARENT_PREFIXES) {
            throw new BrokerError(
              "SUBMISSION_TOO_LARGE",
              "Gate candidate contains too many portable path-prefix nodes to inspect safely.",
              {
                maximumNodes: GATE_MAX_TRACKED_PATHS + GATE_MAX_PARENT_PREFIXES,
              },
            );
          }
        } else if (child.component !== component) {
          throw new BrokerError(
            "UNSAFE_PATH",
            `Gate candidate paths collide on a supported filesystem: ${child.firstPath} and ${relativePath}.`,
            { firstPath: child.firstPath, secondPath: relativePath },
          );
        }
        if (child.leaf || (leaf && child.children.size > 0)) {
          throw new BrokerError(
            "UNSAFE_PATH",
            `Gate candidate paths collide on a supported filesystem: ${child.firstPath} and ${relativePath}.`,
            { firstPath: child.firstPath, secondPath: relativePath },
          );
        }
        if (leaf) child.leaf = true;
        node = child;
      }
      if (treeEntry) {
        treeOids.push(match[3] ?? "");
        continue;
      }
      if (
        match[1] === "040000" ||
        match[2] === "tree" ||
        (match[1] === "160000") !== (match[2] === "commit")
      ) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", `Gate found an invalid mode/type pair at ${relativePath}.`);
      }
      const mode = match[1] as RawTreeEntry["mode"];
      const type = match[2] as RawTreeEntry["type"];
      entries.push({ mode, type, oid: match[3] ?? "", path: relativePath });
    }

    const parentPrefixes: string[] = [];
    let parentPrefixBytes = 0;
    const pending = [...portableRoot.children.values()]
      .reverse()
      .map((node) => ({ node, prefix: node.component }));
    while (pending.length > 0) {
      const current = pending.pop();
      if (!current) break;
      if (current.node.children.size > 0) {
        parentPrefixes.push(current.prefix);
        parentPrefixBytes += Buffer.byteLength(current.prefix, "utf8");
        if (
          parentPrefixes.length > GATE_MAX_PARENT_PREFIXES ||
          parentPrefixBytes > GATE_MAX_PARENT_PREFIX_BYTES
        ) {
          throw new BrokerError(
            "SUBMISSION_TOO_LARGE",
            "Gate candidate contains too many tracked parent directories to verify safely.",
            {
              maximumParentPrefixes: GATE_MAX_PARENT_PREFIXES,
              maximumParentPrefixBytes: GATE_MAX_PARENT_PREFIX_BYTES,
            },
          );
        }
      }
      const children = [...current.node.children.values()];
      for (let index = children.length - 1; index >= 0; index -= 1) {
        const child = children[index];
        if (child) pending.push({ node: child, prefix: `${current.prefix}/${child.component}` });
      }
    }
    return { entries, treeOids, pathBytes, componentVisits, parentPrefixes };
  }

  /** Resolve an already-present commit exactly, without replacement refs or promisor lazy fetch. */
  async resolveLocalCommit(revision: string): Promise<string> {
    return await this.resolveUnreplacedCommit(revision);
  }

  /**
   * Resolve a repository-local revision once and retain that exact commit under a broker-owned ref.
   * The create-only ref update is idempotent for the same OID and never follows or overwrites an
   * existing ref. Callers must use the returned OID, rather than resolving the mutable source again.
  */
  async pinLocalRef(sourceRef: string, pinId: string): Promise<PinnedGitCommit> {
    const ref = adoptedRef(pinId);
    const oid = await this.resolveUnreplacedCommit(sourceRef);
    const pinned = await this.withIsolatedHooks(
      async (hooksDirectory) => await this.localObjectGit(
        [
          "-c", `core.hooksPath=${hooksDirectory}`,
          "update-ref", "--no-deref", "-m", "merge-broker: pin adopted commit",
          ref, oid, "",
        ],
        this.root,
        true,
      ),
    );
    if (pinned.exitCode === 0) return { ref, oid };

    // A lost response is safe to retry when the direct ref already contains the same immutable
    // object. Never accept a symbolic ref: its apparent value could move with its target.
    const symbolic = await this.localObjectGit(["symbolic-ref", "-q", ref], this.root, true);
    const existing = symbolic.exitCode === 0
      ? undefined
      : await this.localObjectGit(
        ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", ref],
        this.root,
        true,
      );
    const existingOid = existing?.exitCode === 0 ? existing.stdout.trim() : undefined;
    if (existingOid === oid) return { ref, oid };
    if (symbolic.exitCode === 0 || existingOid) {
      throw new BrokerError(
        "PINNED_REF_EXISTS",
        `Adoption pin already identifies a different object: ${ref}`,
        { sourceRef, ref, oid, ...(existingOid ? { existingOid } : {}) },
      );
    }
    throw new BrokerError("PIN_REF_FAILED", `Could not retain adopted commit under ${ref}.`, {
      sourceRef,
      ref,
      oid,
      stderr: pinned.stderr,
    });
  }

  /** Prove that a broker adoption ref is still direct and still retains the recorded commit. */
  async assertPinnedLocalRef(pinId: string, expectedOid: string): Promise<void> {
    const ref = adoptedRef(pinId);
    const [symbolic, direct] = await Promise.all([
      this.localObjectGit(["symbolic-ref", "-q", ref], this.root, true),
      this.localObjectGit(
        ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", ref],
        this.root,
        true,
      ),
    ]);
    const actualOid = direct.exitCode === 0 ? direct.stdout.trim() : undefined;
    if (symbolic.exitCode === 0 || actualOid !== expectedOid) {
      throw new BrokerError(
        "SUBMISSION_REF_CHANGED",
        `The retained ref for candidate submission ${pinId} no longer identifies its recorded commit.`,
        {
          submissionId: pinId,
          ref,
          expectedOid,
          ...(symbolic.exitCode === 0
            ? { symbolicTarget: symbolic.stdout.trim() }
            : actualOid
              ? { actualOid }
              : { missing: true }),
        },
      );
    }
  }

  /** Recreate a missing adoption ref with create-only CAS; never repair a wrong or symbolic ref. */
  async retainPinnedLocalRef(
    pinId: string,
    expectedOid: string,
    beforeRepair?: () => Promise<void>,
  ): Promise<{ repaired: boolean }> {
    try {
      await this.assertPinnedLocalRef(pinId, expectedOid);
      return { repaired: false };
    } catch (error) {
      if (
        !(error instanceof BrokerError) ||
        error.code !== "SUBMISSION_REF_CHANGED" ||
        error.details?.missing !== true
      ) throw error;
    }
    await beforeRepair?.();
    await this.pinLocalRef(expectedOid, pinId);
    await this.assertPinnedLocalRef(pinId, expectedOid);
    return { repaired: true };
  }

  /**
   * Require `head` to descend from the exact base through one uninterrupted, merge-free chain.
   * Parentage comes from raw commit headers: replacement refs, grafts, and shallow boundaries cannot
   * add, hide, or rewrite an edge.
   */
  async requireLinearHistory(
    base: string,
    head: string,
    options: { maximumCommits?: number } = {},
  ): Promise<LinearCommitHistory> {
    const [baseOid, headOid] = await Promise.all([
      this.resolveUnreplacedCommit(base),
      this.resolveUnreplacedCommit(head),
    ]);
    const reverseCommits: string[] = [];
    const maximumCommits = Math.min(
      options.maximumCommits ?? GATE_MAX_HISTORY_COMMITS,
      GATE_MAX_HISTORY_COMMITS,
    );
    let cursor = headOid;
    while (cursor !== baseOid) {
      if (reverseCommits.length >= maximumCommits) {
        throw new BrokerError(
          "SUBMISSION_TOO_LARGE",
          `Candidate has more than ${maximumCommits} commits after protected base ${baseOid}.`,
          { maximum: maximumCommits, baseOid, headOid },
        );
      }
      const { parents } = await this.rawCommitIdentity(cursor);
      if (parents.length > 1) {
        throw new BrokerError(
          "NON_LINEAR_HISTORY",
          "Candidate history contains one or more merge commits.",
          { baseOid, headOid, mergeCommits: [cursor] },
        );
      }
      if (parents.length !== 1) {
        throw new BrokerError(
          "BASE_NOT_ANCESTOR",
          `Candidate ${headOid} is not a descendant of base ${baseOid}.`,
          { baseOid, headOid, stoppedAt: cursor },
        );
      }
      reverseCommits.push(cursor);
      cursor = parents[0] ?? "";
    }
    return { baseOid, headOid, commits: reverseCommits.reverse() };
  }

  /** Derive touched paths from explicit raw parent/child pairs, never Git's rewritten parent view. */
  async changedFilesForLinearHistory(
    baseOid: string,
    commits: string[],
  ): Promise<string[]> {
    const files = new Set<string>();
    const pairCache = new Map<string, string[]>();
    let inspectedBytes = 0;
    let inspectedRecords = 0;
    let parentTree = (await this.rawCommitIdentity(baseOid)).treeOid;
    for (const commit of commits) {
      const commitTree = (await this.rawCommitIdentity(commit)).treeOid;
      const pairKey = `${parentTree}\0${commitTree}`;
      let changed = pairCache.get(pairKey);
      if (!changed) {
        const remainingBytes = GATE_MAX_HISTORY_DIFF_BYTES - inspectedBytes;
        const result = await this.localObjectGitBuffer(
          [
            "--no-replace-objects",
            "diff-tree",
            "--no-commit-id",
            "--no-ext-diff",
            "--no-textconv",
            "--no-renames",
            "--name-only",
            "-r",
            "-z",
            parentTree,
            commitTree,
            "--",
          ],
          this.root,
          undefined,
          Math.min(GATE_MAX_TREE_LIST_BYTES, remainingBytes),
        );
        inspectedBytes += result.byteLength;
        changed = [];
        let offset = 0;
        while (offset < result.byteLength) {
          const terminator = result.indexOf(0, offset);
          if (terminator < 0) {
            throw new BrokerError("GIT_OBJECT_READ_FAILED", "Git returned an unterminated changed path.");
          }
          inspectedRecords += 1;
          if (inspectedRecords > GATE_MAX_HISTORY_DIFF_RECORDS) {
            throw new BrokerError(
              "SUBMISSION_TOO_LARGE",
              "Gate candidate history contains too many aggregate changed-path records to inspect safely.",
              { maximumRecords: GATE_MAX_HISTORY_DIFF_RECORDS },
            );
          }
          const file = decodeGatePath(result.subarray(offset, terminator));
          gatePath(file, this.root);
          changed.push(file);
          offset = terminator + 1;
        }
        pairCache.set(pairKey, changed);
      }
      for (const file of changed) {
        files.add(file);
        if (files.size > GATE_MAX_TRACKED_PATHS) {
          throw new BrokerError(
            "SUBMISSION_TOO_LARGE",
            `Gate candidate touches more than ${GATE_MAX_TRACKED_PATHS} paths.`,
            { maximumPaths: GATE_MAX_TRACKED_PATHS },
          );
        }
      }
      parentTree = commitTree;
    }
    return [...files].sort();
  }

  private async rawBlobs(entries: RawTreeEntry[]): Promise<Map<string, Buffer>> {
    const oids = [...new Set(
      entries.filter((entry) => entry.type === "blob").map((entry) => entry.oid),
    )];
    if (oids.length === 0) return new Map();
    const output = await this.localObjectGitBuffer(
      ["--no-replace-objects", "cat-file", "--batch"],
      this.root,
      `${oids.join("\n")}\n`,
      GATE_MAX_MATERIALIZED_BYTES + GATE_MAX_TREE_LIST_BYTES,
    );
    const blobs = new Map<string, Buffer>();
    let offset = 0;
    for (const expectedOid of oids) {
      const headerEnd = output.indexOf(0x0a, offset);
      if (headerEnd < 0) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", `Git omitted blob ${expectedOid}.`);
      }
      const header = output.subarray(offset, headerEnd).toString("ascii");
      const match = /^([0-9a-f]{40}|[0-9a-f]{64}) blob (\d+)$/u.exec(header);
      if (!match || match[1] !== expectedOid) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", `Git could not read local blob ${expectedOid}.`, {
          header,
        });
      }
      const size = Number(match[2]);
      if (!Number.isSafeInteger(size) || size < 0 || size > GATE_MAX_BLOB_BYTES) {
        throw new BrokerError(
          "SUBMISSION_TOO_LARGE",
          `Gate blob ${expectedOid} exceeds the ${GATE_MAX_BLOB_BYTES}-byte per-file limit.`,
          { oid: expectedOid, maximumBytes: GATE_MAX_BLOB_BYTES },
        );
      }
      const start = headerEnd + 1;
      const end = start + size;
      if (end >= output.byteLength || output[end] !== 0x0a) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", `Git returned a truncated blob ${expectedOid}.`);
      }
      const contents = output.subarray(start, end);
      const algorithm = expectedOid.length === 64 ? "sha256" : "sha1";
      const actualOid = createHash(algorithm)
        .update(`blob ${contents.byteLength}\0`)
        .update(contents)
        .digest("hex");
      if (actualOid !== expectedOid) {
        throw new BrokerError(
          "GIT_OBJECT_READ_FAILED",
          `Retained blob ${expectedOid} does not match its Git object identity.`,
          { expectedOid, actualOid },
        );
      }
      blobs.set(expectedOid, contents);
      offset = end + 1;
    }
    if (offset !== output.byteLength) {
      throw new BrokerError("GIT_OBJECT_READ_FAILED", "Git returned unexpected trailing object data.");
    }
    return blobs;
  }

  /**
   * Prove that every snapshot in the retained candidate chain is complete in this object store.
   * Looking only at the final tree misses blobs introduced and deleted by an earlier candidate
   * commit. The caller supplies exact OIDs (the protected base followed by retained commits), and
   * the fixed aggregate limits keep this proof independent of a permissive repository policy.
   */
  async assertLocalObjectClosure(commits: string[]): Promise<void> {
    const uniqueCommits = [...new Set(commits)];
    if (
      uniqueCommits.length === 0 ||
      uniqueCommits.length > GATE_MAX_CLOSURE_COMMITS ||
      uniqueCommits.some((oid) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(oid))
    ) {
      throw new BrokerError(
        "SUBMISSION_TOO_LARGE",
        `Gate object-closure inspection accepts 1-${GATE_MAX_CLOSURE_COMMITS} exact commit OIDs.`,
        { commits: uniqueCommits.length, maximumCommits: GATE_MAX_CLOSURE_COMMITS },
      );
    }

    let inspectedEntries = 0;
    let inspectedPathBytes = 0;
    let inspectedComponentVisits = 0;
    const uniqueBlobs = new Map<string, RawTreeEntry>();
    const rootTrees: string[] = [];
    const flattenedTrees = new Set<string>();
    const snapshots = new Map<string, RawTreeSnapshot>();
    for (const oid of uniqueCommits) {
      const commit = await this.rawCommitIdentity(oid);
      rootTrees.push(commit.treeOid);
      flattenedTrees.add(commit.treeOid);
      let snapshot = snapshots.get(commit.treeOid);
      if (!snapshot) {
        snapshot = await this.rawTreeEntries(commit.treeOid);
        snapshots.set(commit.treeOid, snapshot);
        inspectedEntries += snapshot.entries.length + snapshot.treeOids.length;
        inspectedPathBytes += snapshot.pathBytes;
        inspectedComponentVisits += snapshot.componentVisits;
      }
      const { entries, treeOids } = snapshot;
      for (const treeOid of treeOids) flattenedTrees.add(treeOid);
      if (
        inspectedEntries > GATE_MAX_CLOSURE_ENTRIES ||
        inspectedPathBytes > GATE_MAX_CLOSURE_PATH_BYTES ||
        inspectedComponentVisits > GATE_MAX_PATH_COMPONENT_VISITS
      ) {
        throw new BrokerError(
          "SUBMISSION_TOO_LARGE",
          "Gate candidate history contains too many aggregate tree entries to inspect safely.",
          {
            maximumEntries: GATE_MAX_CLOSURE_ENTRIES,
            maximumPathBytes: GATE_MAX_CLOSURE_PATH_BYTES,
            maximumComponentVisits: GATE_MAX_PATH_COMPONENT_VISITS,
          },
        );
      }
      for (const entry of entries) {
        if (entry.type === "blob") uniqueBlobs.set(entry.oid, entry);
      }
      if (uniqueBlobs.size > GATE_MAX_CLOSURE_BLOBS) {
        throw new BrokerError(
          "SUBMISSION_TOO_LARGE",
          `Gate candidate history references more than ${GATE_MAX_CLOSURE_BLOBS} unique blobs.`,
          { maximumBlobs: GATE_MAX_CLOSURE_BLOBS },
        );
      }
    }
    await this.rawBlobs([...uniqueBlobs.values()]);

    // Verify exactly the bounded tree closure rooted in these snapshots. Whole-repository fsck is
    // intentionally avoided: unrelated unreachable corruption must not reject this artifact or
    // make Gate scan objects outside the resource ceilings above.
    const verifiedTrees = await this.rawTreeObjectIdentities([...flattenedTrees]);
    const treeBlobs = new Set<string>();
    const rawChildTrees = new Set(rootTrees);
    let verifiedTreeEntries = 0;
    for (const tree of verifiedTrees.values()) {
      verifiedTreeEntries += tree.blobs.length + tree.trees.length;
      if (verifiedTreeEntries > GATE_MAX_CLOSURE_ENTRIES) {
        throw new BrokerError(
          "SUBMISSION_TOO_LARGE",
          "Gate candidate history contains too many raw tree edges to verify safely.",
          { maximumEntries: GATE_MAX_CLOSURE_ENTRIES },
        );
      }
      for (const blob of tree.blobs) treeBlobs.add(blob.oid);
      for (const child of tree.trees) rawChildTrees.add(child.oid);
    }
    if (
      treeBlobs.size !== uniqueBlobs.size ||
      [...treeBlobs].some((oid) => !uniqueBlobs.has(oid)) ||
      rawChildTrees.size !== flattenedTrees.size ||
      [...rawChildTrees].some((oid) => !flattenedTrees.has(oid))
    ) {
      throw new BrokerError(
        "GIT_OBJECT_READ_FAILED",
        "Gate's raw tree closure does not match its flattened retained snapshots.",
      );
    }
  }

  private async hashWorktreeBlob(file: string, size: number, algorithm: "sha1" | "sha256"): Promise<string> {
    const hash = createHash(algorithm).update(`blob ${size}\0`);
    for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
    return hash.digest("hex");
  }

  async changedFiles(commit: string, options: { localObjectsOnly?: boolean } = {}): Promise<string[]> {
    const execute = options.localObjectsOnly ? this.localObjectGit.bind(this) : this.git.bind(this);
    const result = await execute(
      [
        "--no-replace-objects",
        "diff-tree",
        "--root",
        "--no-commit-id",
        "--no-renames",
        "--name-only",
        "-r",
        "-z",
        commit,
        "--",
      ],
    );
    return [...new Set(splitNull(result.stdout))].sort();
  }

  async changedFilesForCommits(
    commits: string[],
    options: { localObjectsOnly?: boolean } = {},
  ): Promise<string[]> {
    const files = new Set<string>();
    for (const commit of commits) {
      for (const file of await this.changedFiles(commit, options)) files.add(file);
    }
    return [...files].sort();
  }

  async changedFilesBetween(base: string, head: string): Promise<string[]> {
    const [baseOid, headOid] = await Promise.all([
      this.resolveUnreplacedCommit(base),
      this.resolveUnreplacedCommit(head),
    ]);
    const result = await this.git([
      "--no-replace-objects",
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-renames",
      "--name-only",
      "-z",
      baseOid,
      headOid,
      "--",
    ]);
    return [...new Set(splitNull(result.stdout))].sort();
  }

  /**
   * Everything that differs from `base` in a working tree, committed or not, including files Git
   * does not track yet.
   *
   * Pre-flight validation runs while the work is still in progress, so a diff limited to `base..HEAD`
   * would miss uncommitted edits, and one limited to tracked files would miss a new module -- which
   * is exactly what a new surface adds.
   */
  async changedFilesInWorkingTree(base: string, cwd = this.root): Promise<string[]> {
    const tracked = await this.git(["diff", "--name-only", "-z", base], cwd);
    const untracked = await this.git(["ls-files", "--others", "--exclude-standard", "-z"], cwd);
    return [...new Set([...splitNull(tracked.stdout), ...splitNull(untracked.stdout)])].sort();
  }

  /**
   * Linear commits on HEAD after `base`, oldest first. `git cherry` compares patch identities, so a
   * change already contained in the base under a different SHA -- the ordinary result of a rebase --
   * is not submitted a second time.
   */
  async commitsSinceBase(cwd: string, base: string): Promise<string[]> {
    const cherry = await this.git(["cherry", base, "HEAD"], cwd);
    const notUpstream = new Set(
      cherry.stdout
        .split("\n")
        .filter((line) => line.startsWith("+ "))
        .map((line) => line.slice(2).trim()),
    );
    const listed = await this.git(["rev-list", "--reverse", "--no-merges", `${base}..HEAD`], cwd);
    return listed.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((commit) => commit !== "" && notUpstream.has(commit));
  }

  async parentCount(commit: string): Promise<number> {
    const result = await this.git(["rev-list", "--parents", "-n", "1", commit]);
    return Math.max(0, result.stdout.trim().split(/\s+/u).length - 1);
  }

  async isClean(
    cwd = this.root,
    options: { localObjectsOnly?: boolean; ignoreReplacementObjects?: boolean } = {},
  ): Promise<boolean> {
    const execute = options.localObjectsOnly ? this.localObjectGit.bind(this) : this.git.bind(this);
    const result = await execute([
      ...(options.ignoreReplacementObjects ? ["--no-replace-objects"] : []),
      "status",
      "--porcelain=v1",
      "-z",
    ], cwd);
    return result.stdout.length === 0;
  }

  /** Locate the registry entry by its trusted backlink, without consulting a mutable `.git` file. */
  private async registeredWorktreeAdministration(
    destination: string,
  ): Promise<RawWorktreeAdministration | undefined> {
    const resolvedDestination = path.resolve(destination);
    let physicalDestination: string;
    let physicalCommonGitDir: string;
    let physicalWorktreesDirectory: string;
    try {
      [physicalDestination, physicalCommonGitDir] = await Promise.all([
        physicalDirectoryEntry(resolvedDestination),
        realpath(this.commonGitDir),
      ]);
      const worktreesDirectory = path.join(this.commonGitDir, "worktrees");
      const worktreesStatus = await lstat(worktreesDirectory);
      physicalWorktreesDirectory = await realpath(worktreesDirectory);
      if (!worktreesStatus.isDirectory() || worktreesStatus.isSymbolicLink()) return undefined;
    } catch {
      return undefined;
    }

    const registrations = (await Promise.all((await this.listWorktrees()).map(async (item) => ({
      item,
      physicalPath: await physicalDirectoryEntry(item.path).catch(() => undefined),
    })))).filter(
      ({ physicalPath }) => physicalPath === physicalDestination,
    );
    if (registrations.length !== 1) return undefined;

    const physicalGitFile = path.join(physicalDestination, ".git");
    const matches: RawWorktreeAdministration[] = [];
    const worktreesDirectory = path.join(this.commonGitDir, "worktrees");
    let directory: Awaited<ReturnType<typeof opendir>>;
    try {
      directory = await opendir(worktreesDirectory);
    } catch {
      return undefined;
    }
    for await (const entry of directory) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const gitDir = path.join(worktreesDirectory, entry.name);
      try {
        const gitDirStatus = await lstat(gitDir);
        const gitDirIdentity = await filesystemIdentity(gitDir);
        const physicalGitDir = await realpath(gitDir);
        const administrationRelative = path.relative(
          physicalWorktreesDirectory,
          physicalGitDir,
        );
        if (
          !gitDirStatus.isDirectory() ||
          gitDirStatus.isSymbolicLink() ||
          administrationRelative === "" ||
          administrationRelative === ".." ||
          administrationRelative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(administrationRelative) ||
          administrationRelative.includes(path.sep)
        ) continue;

        const backlink = path.join(gitDir, "gitdir");
        const backlinkStatus = await lstat(backlink);
        if (
          !backlinkStatus.isFile() ||
          backlinkStatus.isSymbolicLink() ||
          backlinkStatus.size <= 0 ||
          backlinkStatus.size > GATE_MAX_PATH_BYTES
        ) continue;
        const backlinkContents = await readFile(backlink, "utf8");
        const backlinkMatch = /^([^\0\r\n]+)(?:\r?\n)?$/u.exec(backlinkContents);
        if (!backlinkMatch?.[1]) continue;
        const backlinkTarget = path.resolve(gitDir, backlinkMatch[1]);
        if (path.basename(backlinkTarget) !== ".git") continue;
        const physicalBacklinkWorktree = await physicalDirectoryEntry(
          path.dirname(backlinkTarget),
        );
        const canonicalBacklinkTarget = path.join(physicalBacklinkWorktree, ".git");
        if (canonicalBacklinkTarget !== physicalGitFile) continue;

        const commonLink = path.join(gitDir, "commondir");
        const commonLinkStatus = await lstat(commonLink);
        if (
          !commonLinkStatus.isFile() ||
          commonLinkStatus.isSymbolicLink() ||
          commonLinkStatus.size <= 0 ||
          commonLinkStatus.size > GATE_MAX_PATH_BYTES
        ) continue;
        const commonLinkContents = await readFile(commonLink, "utf8");
        const commonLinkMatch = /^([^\0\r\n]+)(?:\r?\n)?$/u.exec(commonLinkContents);
        if (!commonLinkMatch?.[1]) continue;
        const reportedCommon = await realpath(path.resolve(gitDir, commonLinkMatch[1]));
        if (reportedCommon !== physicalCommonGitDir) continue;

        matches.push({
          destination: resolvedDestination,
          physicalDestination,
          ...await lstat(resolvedDestination).then(
            async (status) => status.isDirectory() && !status.isSymbolicLink()
              ? await filesystemIdentity(resolvedDestination).then((identity) => ({
                destinationDevice: identity.device,
                destinationInode: identity.inode,
              }))
              : {},
            () => ({}),
          ),
          gitDir,
          physicalGitDir,
          gitDirDevice: gitDirIdentity.device,
          gitDirInode: gitDirIdentity.inode,
          physicalCommonGitDir,
        });
      } catch {
        // An unrelated malformed registry entry must not authorize or prevent repairing this one.
      }
    }
    return matches.length === 1 ? matches[0] : undefined;
  }

  /** Change one already-proven physical directory, never a symlink/junction or outside root. */
  private async makeGateCleanupDirectoryTraversable(
    directory: string,
    physicalRoot: string,
  ): Promise<void> {
    const before = await lstat(directory);
    const beforeIdentity = await filesystemIdentity(directory);
    const physical = await physicalDirectoryEntry(directory);
    const relative = path.relative(physicalRoot, physical);
    const contained = relative === "" || (
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative)
    );
    if (!before.isDirectory() || before.isSymbolicLink() || !contained) {
      throw new BrokerError(
        "WORKTREE_REMOVE_FAILED",
        `Refused to change permissions on redirected Gate worktree directory: ${directory}`,
        { directory, physicalPath: physical },
      );
    }

    // macOS exposes lchmod, which does not dereference the final path. Other supported hosts use
    // chmod only after the lstat/physical-containment proof and verify the same inode afterward.
    if (process.platform === "darwin") {
      try {
        await lchmod(directory, 0o700);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EISDIR") throw error;
        const immediatelyBefore = await lstat(directory);
        const immediatelyBeforeIdentity = await filesystemIdentity(directory);
        if (
          !immediatelyBefore.isDirectory() ||
          immediatelyBefore.isSymbolicLink() ||
          immediatelyBeforeIdentity.device !== beforeIdentity.device ||
          immediatelyBeforeIdentity.inode !== beforeIdentity.inode
        ) {
          throw new BrokerError(
            "WORKTREE_REMOVE_FAILED",
            `Gate worktree directory changed before permission repair: ${directory}`,
          );
        }
        await chmod(directory, 0o700);
      }
    } else {
      await chmod(directory, 0o700);
    }
    const after = await lstat(directory);
    const afterIdentity = await filesystemIdentity(directory);
    const physicalAfter = await physicalDirectoryEntry(directory);
    if (
      !after.isDirectory() ||
      after.isSymbolicLink() ||
      beforeIdentity.device !== afterIdentity.device ||
      beforeIdentity.inode !== afterIdentity.inode ||
      physicalAfter !== physical
    ) {
      throw new BrokerError(
        "WORKTREE_REMOVE_FAILED",
        `Gate worktree directory changed during permission repair: ${directory}`,
        { directory, physicalPath: physical, physicalPathAfter: physicalAfter },
      );
    }
  }

  /** Restore traversal inside one physically bounded directory tree without following links. */
  private async repairGateDirectoryPermissions(root: string, physicalRoot: string): Promise<void> {
    const pending = [root];
    let inspected = 0;
    while (pending.length > 0) {
      const directory = pending.pop() ?? root;
      inspected += 1;
      if (inspected > GATE_MAX_CLEANUP_DIRECTORIES) {
        throw new BrokerError(
          "WORKTREE_REMOVE_FAILED",
          `Gate cleanup refuses worktrees with more than ${GATE_MAX_CLEANUP_DIRECTORIES} directories.`,
          { maximumDirectories: GATE_MAX_CLEANUP_DIRECTORIES },
        );
      }
      await this.makeGateCleanupDirectoryTraversable(directory, physicalRoot);
      let entries: Awaited<ReturnType<typeof opendir>>;
      try {
        entries = await opendir(directory);
      } catch (error) {
        throw new BrokerError(
          "WORKTREE_REMOVE_FAILED",
          `Could not inspect Gate worktree directory during permission repair: ${directory}`,
          { directory, cause: error instanceof Error ? error.message : String(error) },
        );
      }
      for await (const entry of entries) {
        const child = path.join(directory, entry.name);
        let status: Awaited<ReturnType<typeof lstat>>;
        try {
          status = await lstat(child);
        } catch (error) {
          throw new BrokerError(
            "WORKTREE_REMOVE_FAILED",
            `Could not inspect Gate worktree entry during permission repair: ${child}`,
            { path: child, cause: error instanceof Error ? error.message : String(error) },
          );
        }
        if (status.isDirectory() && !status.isSymbolicLink()) pending.push(child);
      }
    }
  }

  /** Restore traversal only inside a backlink-bound Gate worktree so recursive removal can finish. */
  private async repairGateWorktreePermissions(
    destination: string,
    expected: RawWorktreeAdministration,
  ): Promise<void> {
    const resolvedDestination = path.resolve(destination);
    const physicalDestination = await physicalDirectoryEntry(resolvedDestination);
    if (physicalDestination !== expected.physicalDestination) {
      throw new BrokerError(
        "WORKTREE_REMOVE_FAILED",
        `Gate worktree root no longer matches its registered physical destination: ${destination}`,
      );
    }
    await this.repairGateDirectoryPermissions(resolvedDestination, physicalDestination);
  }

  /** Remove one proven stale registry entry without pruning or following its missing worktree path. */
  private async removeExactRegisteredWorktreeAdministration(
    destination: string,
    expected: RawWorktreeAdministration,
  ): Promise<void> {
    const registered = await this.registeredWorktreeAdministration(destination);
    if (
      !registered ||
      registered.physicalDestination !== expected.physicalDestination ||
      registered.physicalGitDir !== expected.physicalGitDir ||
      registered.gitDirDevice !== expected.gitDirDevice ||
      registered.gitDirInode !== expected.gitDirInode ||
      registered.physicalCommonGitDir !== expected.physicalCommonGitDir
    ) {
      throw new BrokerError(
        "WORKTREE_REMOVE_FAILED",
        `Could not prove the exact stale Gate registry entry for ${destination}.`,
      );
    }

    await this.repairGateDirectoryPermissions(expected.gitDir, expected.physicalGitDir);
    const before = await lstat(expected.gitDir);
    const beforeIdentity = await filesystemIdentity(expected.gitDir);
    if (
      !before.isDirectory() ||
      before.isSymbolicLink() ||
      beforeIdentity.device !== expected.gitDirDevice ||
      beforeIdentity.inode !== expected.gitDirInode ||
      await realpath(expected.gitDir) !== expected.physicalGitDir
    ) {
      throw new BrokerError(
        "WORKTREE_REMOVE_FAILED",
        `Gate registry entry changed before exact removal: ${expected.gitDir}`,
      );
    }

    const quarantine = path.join(
      path.dirname(expected.gitDir),
      `.merge-broker-remove-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    await rename(expected.gitDir, quarantine);
    const moved = await lstat(quarantine);
    const movedIdentity = await filesystemIdentity(quarantine);
    if (
      !moved.isDirectory() ||
      moved.isSymbolicLink() ||
      movedIdentity.device !== expected.gitDirDevice ||
      movedIdentity.inode !== expected.gitDirInode
    ) {
      await rename(quarantine, expected.gitDir).catch(() => undefined);
      throw new BrokerError(
        "WORKTREE_REMOVE_FAILED",
        `Gate registry entry changed while isolating it for removal: ${expected.gitDir}`,
      );
    }

    const movedAdministration: RawWorktreeAdministration = {
      ...expected,
      gitDir: quarantine,
      physicalGitDir: await physicalDirectoryEntry(quarantine),
    };
    this.rawWorktreeAdministrations.set(path.resolve(destination), movedAdministration);
    await rm(quarantine, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
    this.rawWorktreeAdministrations.delete(path.resolve(destination));
  }

  /** Restore only the broker worktree's marker after validating its immutable registry backlink. */
  private async repairWorktreeAdministration(
    destination: string,
    expected: RawWorktreeAdministration,
  ): Promise<void> {
    const registered = await this.registeredWorktreeAdministration(destination);
    if (
      !registered ||
      registered.physicalDestination !== expected.physicalDestination ||
      registered.physicalGitDir !== expected.physicalGitDir ||
      registered.gitDirDevice !== expected.gitDirDevice ||
      registered.gitDirInode !== expected.gitDirInode ||
      registered.physicalCommonGitDir !== expected.physicalCommonGitDir
    ) {
      throw new BrokerError(
        "WORKTREE_REMOVE_FAILED",
        `Could not prove the registered administration identity for worktree ${destination}.`,
      );
    }

    const gitFile = path.join(path.resolve(destination), ".git");
    const currentStatus = await lstat(gitFile).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (currentStatus?.isDirectory() && !currentStatus.isSymbolicLink()) {
      throw new BrokerError(
        "WORKTREE_REMOVE_FAILED",
        `Refused to replace a directory at the worktree Git marker: ${gitFile}`,
      );
    }

    const temporary = path.join(
      path.dirname(gitFile),
      `.merge-broker-gitfile-${process.pid}-${randomBytes(8).toString("hex")}`,
    );
    await writeFile(temporary, `gitdir: ${expected.gitDir}\n`, { flag: "wx", mode: 0o600 });
    try {
      try {
        await rename(temporary, gitFile);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (
          process.platform !== "win32" ||
          (code !== "EEXIST" && code !== "EPERM" && code !== "EACCES")
        ) throw error;
        await unlink(gitFile).catch((unlinkError: unknown) => {
          if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
        });
        await rename(temporary, gitFile);
      }
    } finally {
      await unlink(temporary).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      });
    }
    await this.inspectRawWorktreeAdministration(destination, expected);
  }

  /**
   * Bind a raw Gate worktree to one exact linked-worktree administration directory. Reading HEAD
   * through an untrusted `.git` marker before checking this binding would let a validator redirect
   * every later Git operation to a different, byte-identical worktree in the same repository.
   */
  private async inspectRawWorktreeAdministration(
    destination: string,
    expected?: RawWorktreeAdministration,
  ): Promise<RawWorktreeAdministration> {
    const resolvedDestination = path.resolve(destination);
    try {
      const destinationStatus = await lstat(resolvedDestination);
      const destinationIdentity = await filesystemIdentity(resolvedDestination);
      const physicalDestination = await realpath(resolvedDestination);
      if (!destinationStatus.isDirectory() || destinationStatus.isSymbolicLink()) {
        throw new Error("redirected worktree root");
      }

      const gitFile = path.join(resolvedDestination, ".git");
      const gitFileStatus = await lstat(gitFile);
      if (
        !gitFileStatus.isFile() ||
        gitFileStatus.isSymbolicLink() ||
        gitFileStatus.size <= 0 ||
        gitFileStatus.size > GATE_MAX_PATH_BYTES + 32
      ) {
        throw new Error("invalid worktree .git marker");
      }
      const gitFileContents = await readFile(gitFile, "utf8");
      const gitFileMatch = /^gitdir: ([^\0\r\n]+)(?:\r?\n)?$/u.exec(gitFileContents);
      if (!gitFileMatch?.[1]) throw new Error("invalid worktree .git marker contents");
      const gitDir = path.resolve(path.dirname(gitFile), gitFileMatch[1]);
      const gitDirStatus = await lstat(gitDir);
      const gitDirIdentity = await filesystemIdentity(gitDir);
      const physicalGitDir = await realpath(gitDir);
      if (!gitDirStatus.isDirectory() || gitDirStatus.isSymbolicLink()) {
        throw new Error("redirected linked-worktree administration directory");
      }

      // This comparison happens before invoking Git in `destination`. A swapped marker therefore
      // cannot choose the repository or index used by the checks that follow.
      if (
        expected &&
        (
          expected.destination !== resolvedDestination ||
          expected.physicalDestination !== physicalDestination ||
          (expected.destinationDevice !== undefined && expected.destinationDevice !== destinationIdentity.device) ||
          (expected.destinationInode !== undefined && expected.destinationInode !== destinationIdentity.inode) ||
          expected.physicalGitDir !== physicalGitDir ||
          expected.gitDirDevice !== gitDirIdentity.device ||
          expected.gitDirInode !== gitDirIdentity.inode
        )
      ) {
        throw new Error("worktree administration identity changed");
      }

      const commonStatus = await lstat(this.commonGitDir);
      const physicalCommonGitDir = await realpath(this.commonGitDir);
      if (!commonStatus.isDirectory() || commonStatus.isSymbolicLink()) {
        throw new Error("redirected common Git directory");
      }
      const worktreesDirectory = path.join(this.commonGitDir, "worktrees");
      const worktreesStatus = await lstat(worktreesDirectory);
      const physicalWorktreesDirectory = await realpath(worktreesDirectory);
      if (!worktreesStatus.isDirectory() || worktreesStatus.isSymbolicLink()) {
        throw new Error("redirected linked-worktree registry");
      }
      const administrationRelative = path.relative(physicalWorktreesDirectory, physicalGitDir);
      if (
        administrationRelative === "" ||
        administrationRelative === ".." ||
        administrationRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(administrationRelative) ||
        administrationRelative.includes(path.sep)
      ) {
        throw new Error("administration directory is not one linked-worktree registry entry");
      }

      const backlink = path.join(gitDir, "gitdir");
      const backlinkStatus = await lstat(backlink);
      if (
        !backlinkStatus.isFile() ||
        backlinkStatus.isSymbolicLink() ||
        backlinkStatus.size <= 0 ||
        backlinkStatus.size > GATE_MAX_PATH_BYTES
      ) {
        throw new Error("invalid linked-worktree backlink");
      }
      const backlinkContents = await readFile(backlink, "utf8");
      const backlinkMatch = /^([^\0\r\n]+)(?:\r?\n)?$/u.exec(backlinkContents);
      if (!backlinkMatch?.[1]) throw new Error("invalid linked-worktree backlink contents");
      const backlinkTarget = path.resolve(gitDir, backlinkMatch[1]);
      const [physicalBacklinkTarget, physicalGitFile] = await Promise.all([
        realpath(backlinkTarget),
        realpath(gitFile),
      ]);
      if (physicalBacklinkTarget !== physicalGitFile) {
        throw new Error("linked-worktree backlink does not identify this worktree .git marker");
      }

      const registrations = (await Promise.all((await this.listWorktrees()).map(async (item) => ({
        item,
        physicalPath: await realpath(item.path).catch(() => undefined),
      })))).filter(
        ({ item, physicalPath }) => physicalPath === physicalDestination && !item.prunable,
      );
      if (registrations.length !== 1) {
        throw new Error("worktree is not registered exactly once in this repository");
      }

      const [reportedCommon, reportedGitDir, reportedTopLevel] = await Promise.all([
        this.localObjectGit(
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          resolvedDestination,
          true,
        ),
        this.localObjectGit(["rev-parse", "--absolute-git-dir"], resolvedDestination, true),
        this.localObjectGit(
          ["rev-parse", "--path-format=absolute", "--show-toplevel"],
          resolvedDestination,
          true,
        ),
      ]);
      if (
        reportedCommon.exitCode !== 0 ||
        reportedGitDir.exitCode !== 0 ||
        reportedTopLevel.exitCode !== 0
      ) {
        throw new Error("Git could not resolve the linked-worktree administration identity");
      }
      const reportedCommonPath = path.resolve(reportedCommon.stdout.trim());
      const reportedGitDirPath = path.resolve(reportedGitDir.stdout.trim());
      const reportedTopLevelPath = path.resolve(reportedTopLevel.stdout.trim());
      const [physicalReportedCommon, physicalReportedGitDir, physicalReportedTopLevel] = await Promise.all([
        realpath(reportedCommonPath),
        realpath(reportedGitDirPath),
        realpath(reportedTopLevelPath),
      ]);
      if (
        physicalReportedGitDir !== physicalGitDir ||
        physicalReportedCommon !== physicalCommonGitDir ||
        physicalReportedTopLevel !== physicalDestination ||
        (expected && expected.physicalCommonGitDir !== physicalReportedCommon)
      ) {
        throw new Error("Git reported a different worktree administration identity");
      }

      return {
        destination: resolvedDestination,
        physicalDestination,
        destinationDevice: destinationIdentity.device,
        destinationInode: destinationIdentity.inode,
        gitDir,
        physicalGitDir,
        gitDirDevice: gitDirIdentity.device,
        gitDirInode: gitDirIdentity.inode,
        physicalCommonGitDir,
      };
    } catch (error) {
      throw new BrokerError(
        "VALIDATOR_MUTATED_WORKTREE",
        "Validator changed or redirected the Gate worktree administration metadata.",
        {
          worktree: resolvedDestination,
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  /**
   * Create a Gate-only detached worktree without asking checkout machinery to transform bytes.
   * The index is loaded from the exact tree, while every tracked path is materialized from raw blob
   * objects. Clean/smudge/process filters, ident, EOL conversion, and submodule helpers never run.
   */
  async prepareRawWorktreeRoot(destination: string): Promise<SubmissionWorktreeIdentity> {
    const resolved = path.resolve(destination);
    await mkdir(path.dirname(resolved), { recursive: true });
    try {
      await mkdir(resolved, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const [status, physical, physicalParent, identity] = await Promise.all([
      lstat(resolved),
      realpath(resolved),
      realpath(path.dirname(resolved)),
      filesystemIdentity(resolved),
    ]);
    if (
      !status.isDirectory() ||
      status.isSymbolicLink() ||
      path.dirname(physical) !== physicalParent
    ) {
      throw new BrokerError(
        "WORKTREE_IDENTITY_UNAVAILABLE",
        `Gate worktree root is not one physical directory beneath its expected parent: ${destination}`,
      );
    }
    const entries = await opendir(resolved);
    try {
      if (await entries.read() !== null) {
        throw new BrokerError(
          "WORKTREE_IDENTITY_UNAVAILABLE",
          `Gate worktree root is not empty before registration: ${destination}`,
        );
      }
    } finally {
      await entries.close().catch(() => undefined);
    }
    return identity;
  }

  async addRawDetachedWorktree(destination: string, startPoint: string): Promise<void> {
    const oid = await this.resolveUnreplacedCommit(startPoint);
    // Parse the complete entry set and collision map before creating any candidate path. This is
    // crucial on case-insensitive filesystems, where `Foo` plus `foo/payload` could otherwise turn
    // a previously written symlink into a parent-directory escape.
    const { entries } = await this.rawTreeEntries(oid);
    const blobs = await this.rawBlobs(entries);
    let materializedBytes = 0;
    for (const entry of entries) {
      if (entry.type !== "blob") continue;
      const contents = blobs.get(entry.oid);
      if (!contents) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", `Gate did not retain blob ${entry.oid}.`);
      }
      materializedBytes += contents.byteLength;
      if (materializedBytes > GATE_MAX_MATERIALIZED_BYTES) {
        throw new BrokerError(
          "SUBMISSION_TOO_LARGE",
          `Gate candidate materializes more than ${GATE_MAX_MATERIALIZED_BYTES} tracked bytes.`,
          { maximumBytes: GATE_MAX_MATERIALIZED_BYTES },
        );
      }
    }

    // Submission orchestration pre-creates and durably binds this root before Git registration.
    // Direct callers retain the convenient API, but still receive the same physical/empty proof.
    await this.prepareRawWorktreeRoot(destination);
    await this.withIsolatedHooks(async (hooksDirectory) =>
      await this.localObjectGit([
        "-c", `core.hooksPath=${hooksDirectory}`,
        "--no-replace-objects",
        "worktree",
        "add",
        "--no-checkout",
        "--detach",
        destination,
        oid,
      ])
    );
    const administration = await this.inspectRawWorktreeAdministration(destination);
    this.rawWorktreeAdministrations.set(path.resolve(destination), administration);
    await this.localObjectGit(
      ["--no-replace-objects", "read-tree", "--reset", oid],
      destination,
    );

    for (const entry of entries) {
      const target = gatePath(entry.path, destination);
      await mkdir(path.dirname(target), { recursive: true });
      if (entry.mode === "160000") {
        await mkdir(target);
        continue;
      }
      const contents = blobs.get(entry.oid);
      if (!contents) {
        throw new BrokerError("GIT_OBJECT_READ_FAILED", `Gate did not retain blob ${entry.oid}.`);
      }
      if (entry.mode === "120000") {
        let linkTarget: string;
        try {
          linkTarget = new TextDecoder("utf-8", { fatal: true }).decode(contents);
        } catch {
          throw new BrokerError(
            "UNSAFE_PATH",
            `Gate symlink target at ${entry.path} is not valid UTF-8 on every supported platform.`,
          );
        }
        try {
          await symlink(linkTarget, target);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (
            process.platform !== "win32" ||
            (code !== "EPERM" && code !== "EACCES" && code !== "UNKNOWN")
          ) throw error;
          // Git's ordinary core.symlinks=false fallback on Windows is a regular file containing the
          // link target. Preserve the raw blob bytes when the host cannot create a real symlink.
          await writeFile(target, contents, { flag: "wx", mode: 0o644 });
        }
        continue;
      }
      const mode = entry.mode === "100755" ? 0o755 : 0o644;
      await writeFile(target, contents, { flag: "wx", mode });
      if (process.platform !== "win32") await chmod(target, mode);
    }
  }

  /** Capture the physical root identity that recovery must match before recursive Gate cleanup. */
  async gateWorktreeIdentity(destination: string): Promise<SubmissionWorktreeIdentity> {
    const key = path.resolve(destination);
    const expected = this.rawWorktreeAdministrations.get(key);
    if (!expected) {
      throw new BrokerError(
        "WORKTREE_IDENTITY_UNAVAILABLE",
        `Gate worktree has no captured administration identity: ${destination}`,
      );
    }
    const verified = await this.inspectRawWorktreeAdministration(destination, expected);
    if (verified.destinationDevice === undefined || verified.destinationInode === undefined) {
      throw new BrokerError(
        "WORKTREE_IDENTITY_UNAVAILABLE",
        `Gate worktree has no physical filesystem identity: ${destination}`,
      );
    }
    return {
      device: verified.destinationDevice,
      inode: verified.destinationInode,
    };
  }

  /**
   * Compare a Gate worktree directly with the retained tree. This ignores index flags and never
   * feeds working-tree bytes through Git filters, so a clean filter cannot conceal a mutation.
   */
  async assertRawWorktree(destination: string, expectedCommit: string): Promise<void> {
    const expectedAdministration = this.rawWorktreeAdministrations.get(path.resolve(destination));
    if (!expectedAdministration) {
      throw new BrokerError(
        "VALIDATOR_MUTATED_WORKTREE",
        "Gate worktree has no broker-recorded administration identity.",
        { worktree: path.resolve(destination) },
      );
    }
    const administration = await this.inspectRawWorktreeAdministration(
      destination,
      expectedAdministration,
    );
    const physicalRoot = administration.physicalDestination;

    const symbolicHead = await this.localObjectGit(
      ["symbolic-ref", "-q", "HEAD"],
      destination,
      true,
    );
    if (symbolicHead.exitCode !== 1) {
      throw new BrokerError(
        "VALIDATOR_MUTATED_WORKTREE",
        "Validator changed the Gate worktree from a detached commit to a branch or invalid HEAD.",
        {
          ...(symbolicHead.exitCode === 0 ? { symbolicHead: symbolicHead.stdout.trim() } : {}),
          ...(symbolicHead.stderr ? { stderr: symbolicHead.stderr } : {}),
        },
      );
    }

    const actualHead = await this.resolveUnreplacedCommitAt("HEAD", destination);
    if (actualHead !== expectedCommit) {
      throw new BrokerError(
        "VALIDATOR_MUTATED_WORKTREE",
        "Validator changed the Gate worktree HEAD.",
        { expectedHead: expectedCommit, actualHead },
      );
    }
    const index = await this.localObjectGit([
      "--no-replace-objects",
      "diff-index",
      "--cached",
      "--quiet",
      "--no-ext-diff",
      expectedCommit,
      "--",
    ], destination, true);
    if (index.exitCode !== 0) {
      throw new BrokerError(
        "VALIDATOR_MUTATED_WORKTREE",
        "Validator changed the Gate worktree index.",
        { expectedHead: expectedCommit, stderr: index.stderr },
      );
    }

    const { entries, parentPrefixes } = await this.rawTreeEntries(expectedCommit);

    // Git trees contain only leaves, so a validator can replace an implicit tracked parent with a
    // symlink/junction without changing the index. `rawTreeEntries` returns the bounded unique
    // parent set from its portable trie, avoiding a second repeated-prefix traversal here.
    for (const prefix of parentPrefixes) {
      const parent = gatePath(prefix, destination);
      let status: Awaited<ReturnType<typeof lstat>>;
      let physical: string;
      try {
        [status, physical] = await Promise.all([lstat(parent), realpath(parent)]);
      } catch {
        throw new BrokerError(
          "VALIDATOR_MUTATED_WORKTREE",
          `Validator removed or redirected tracked Gate directory ${prefix}.`,
          { path: prefix },
        );
      }
      const physicalRelative = path.relative(physicalRoot, physical);
      if (
        !status.isDirectory() ||
        status.isSymbolicLink() ||
        physicalRelative === "" ||
        physicalRelative === ".." ||
        physicalRelative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(physicalRelative)
      ) {
        throw new BrokerError(
          "VALIDATOR_MUTATED_WORKTREE",
          `Validator redirected tracked Gate directory ${prefix}.`,
          { path: prefix, physicalPath: physical },
        );
      }
    }

    const algorithm = expectedCommit.length === 64 ? "sha256" : "sha1";
    for (const entry of entries) {
      const target = gatePath(entry.path, destination);
      let status: Awaited<ReturnType<typeof lstat>>;
      try {
        status = await lstat(target);
      } catch {
        throw new BrokerError(
          "VALIDATOR_MUTATED_WORKTREE",
          `Validator removed tracked Gate path ${entry.path}.`,
          { path: entry.path },
        );
      }
      if (entry.mode === "160000") {
        let emptyDirectory = false;
        if (status.isDirectory()) {
          const directory = await opendir(target);
          try {
            emptyDirectory = await directory.read() === null;
          } finally {
            await directory.close().catch(() => undefined);
          }
        }
        if (!emptyDirectory) {
          throw new BrokerError(
            "VALIDATOR_MUTATED_WORKTREE",
            `Validator changed Gitlink path ${entry.path}.`,
            { path: entry.path },
          );
        }
        continue;
      }
      if (entry.mode === "120000") {
        if (process.platform === "win32" && status.isFile()) {
          if (status.size <= GATE_MAX_BLOB_BYTES) {
            const actualOid = await this.hashWorktreeBlob(target, status.size, algorithm);
            if (actualOid === entry.oid) continue;
          }
        }
        if (!status.isSymbolicLink()) {
          throw new BrokerError(
            "VALIDATOR_MUTATED_WORKTREE",
            `Validator changed tracked symlink ${entry.path}.`,
            { path: entry.path },
          );
        }
        const targetBytes = await readlink(target, { encoding: "buffer" });
        const actualOid = createHash(algorithm)
          .update(`blob ${targetBytes.byteLength}\0`)
          .update(targetBytes)
          .digest("hex");
        if (actualOid !== entry.oid) {
          throw new BrokerError(
            "VALIDATOR_MUTATED_WORKTREE",
            `Validator changed tracked symlink ${entry.path}.`,
            { path: entry.path, expectedOid: entry.oid, actualOid },
          );
        }
        continue;
      }
      if (!status.isFile() || status.size > GATE_MAX_BLOB_BYTES) {
        throw new BrokerError(
          "VALIDATOR_MUTATED_WORKTREE",
          `Validator changed tracked file ${entry.path}.`,
          { path: entry.path },
        );
      }
      const actualOid = await this.hashWorktreeBlob(target, status.size, algorithm);
      // Git records only the owner's executable bit. Group/other execute bits must not conceal a
      // validator clearing the tracked owner bit on POSIX.
      const executable = (status.mode & 0o100) !== 0;
      const expectedExecutable = entry.mode === "100755";
      if (
        actualOid !== entry.oid ||
        (process.platform !== "win32" && executable !== expectedExecutable)
      ) {
        throw new BrokerError(
          "VALIDATOR_MUTATED_WORKTREE",
          `Validator changed tracked file ${entry.path}.`,
          { path: entry.path, expectedOid: entry.oid, actualOid },
        );
      }
    }

    let untrackedBytes: Buffer;
    try {
      // Only presence matters. Bound capture so an ordinary generator that leaves a very large
      // untracked tree cannot make rejection itself consume unbounded broker memory.
      untrackedBytes = await this.localObjectGitBuffer(
        ["--no-replace-objects", "ls-files", "--others", "--exclude-standard", "-z"],
        destination,
        undefined,
        4 * 1_024,
      );
    } catch (error) {
      if (error instanceof BrokerError && error.code === "SUBMISSION_TOO_LARGE") {
        throw new BrokerError(
          "VALIDATOR_MUTATED_WORKTREE",
          "Validator created too many non-ignored untracked bytes in the Gate worktree.",
        );
      }
      throw error;
    }
    if (untrackedBytes.byteLength > 0) {
      throw new BrokerError(
        "VALIDATOR_MUTATED_WORKTREE",
        "Validator created non-ignored untracked bytes in the Gate worktree.",
      );
    }
  }

  async addDetachedWorktree(
    destination: string,
    startPoint: string,
    options: { localObjectsOnly?: boolean; disableHooks?: boolean } = {},
  ): Promise<void> {
    await mkdir(path.dirname(destination), { recursive: true });
    // Replacement refs are local aliases, not part of the submitted Git object graph. A Gate
    // worktree must materialize the exact retained commit rather than an ambient replacement.
    const execute = options.localObjectsOnly ? this.localObjectGit.bind(this) : this.git.bind(this);
    const add = async (hooksDirectory?: string): Promise<void> => {
      await execute([
        ...(hooksDirectory ? ["-c", `core.hooksPath=${hooksDirectory}`] : []),
        "--no-replace-objects",
        "worktree",
        "add",
        "--detach",
        destination,
        startPoint,
      ]);
    };
    if (options.disableHooks) await this.withIsolatedHooks(add);
    else await add();
  }

  async removeWorktree(
    destination: string,
    options: {
      strictGateCleanup?: boolean;
      expectedRootIdentity?: SubmissionWorktreeIdentity;
    } = {},
  ): Promise<void> {
    const key = path.resolve(destination);
    const capturedGateAdministration = this.rawWorktreeAdministrations.get(key);
    const strictGateCleanup = options.strictGateCleanup === true || capturedGateAdministration !== undefined;
    if (!strictGateCleanup) {
      const ordinary = await this.git(["worktree", "remove", "--force", destination], this.root, true);
      if (ordinary.exitCode !== 0) {
        await this.git(["worktree", "prune"], this.root, true);
        throw new BrokerError(
          "WORKTREE_REMOVE_FAILED",
          `Could not remove integration worktree: ${destination}`,
          { stderr: ordinary.stderr },
        );
      }
      this.rawWorktreeAdministrations.delete(key);
      return;
    }

    const expectedRootIdentity = options.expectedRootIdentity ?? (
      capturedGateAdministration?.destinationDevice !== undefined &&
      capturedGateAdministration.destinationInode !== undefined
        ? {
          device: capturedGateAdministration.destinationDevice,
          inode: capturedGateAdministration.destinationInode,
        }
        : undefined
    );
    const administration = capturedGateAdministration ??
      await this.registeredWorktreeAdministration(destination);
    if (!administration) {
      if (!expectedRootIdentity) {
        const unboundStatus = await lstat(key).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
        if (!unboundStatus) return;
        if (unboundStatus.isDirectory() && !unboundStatus.isSymbolicLink()) {
          const entries = await opendir(key);
          let empty = false;
          try {
            empty = await entries.read() === null;
          } finally {
            await entries.close().catch(() => undefined);
          }
          if (empty) {
            // Only the pre-registration crash window can leave an unbound empty root. rmdir is
            // deliberately non-recursive, so a raced or unrelated entry is never consumed.
            await rmdir(key);
            return;
          }
        }
        throw new BrokerError(
          "WORKTREE_REMOVE_FAILED",
          `Gate cleanup could not prove the exact registered administration identity for ${destination}.`,
        );
      }
      const incompleteStatus = await lstat(key).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw error;
      });
      if (incompleteStatus) {
        const incompleteIdentity = await filesystemIdentity(key);
        if (
          !incompleteStatus.isDirectory() ||
          incompleteStatus.isSymbolicLink() ||
          incompleteIdentity.device !== expectedRootIdentity.device ||
          incompleteIdentity.inode !== expectedRootIdentity.inode
        ) {
          throw new BrokerError(
            "WORKTREE_REMOVE_FAILED",
            `Gate cleanup refused an unregistered root with a different physical identity: ${destination}.`,
          );
        }
        await this.repairGateDirectoryPermissions(key, await physicalDirectoryEntry(key));
        await rm(key, { recursive: true, force: false, maxRetries: 5, retryDelay: 100 });
      }
      // A crash inside `git worktree add` can leave only a prunable registry record. With the
      // inode-bound root now absent, ask Git to remove this exact pathname and verify that no such
      // registration remains; never run a global prune.
      await this.localObjectGit(
        ["worktree", "remove", "--force", destination],
        this.root,
        true,
      );
      const physicalKey = await physicalDirectoryEntry(key);
      const remaining = (await Promise.all((await this.listWorktrees()).map(async (item) => ({
        item,
        physicalPath: await physicalDirectoryEntry(item.path).catch(() => undefined),
      })))).filter(({ physicalPath }) => physicalPath === physicalKey);
      if (remaining.length > 0) {
        throw new BrokerError(
          "WORKTREE_REMOVE_FAILED",
          `Gate cleanup could not clear the exact partial worktree registration for ${destination}.`,
        );
      }
      this.rawWorktreeAdministrations.delete(key);
      return;
    }

    const rootStatus = await lstat(key).catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    });
    if (!rootStatus) {
      await this.removeExactRegisteredWorktreeAdministration(destination, administration);
      return;
    }
    const rootIdentity = await filesystemIdentity(key);
    if (
      expectedRootIdentity &&
      (
        rootIdentity.device !== expectedRootIdentity.device ||
        rootIdentity.inode !== expectedRootIdentity.inode
      )
    ) {
      throw new BrokerError(
        "WORKTREE_REMOVE_FAILED",
        `Gate cleanup refused a different directory moved into the validation worktree path: ${destination}.`,
        {
          expectedRootIdentity,
          actualRootIdentity: rootIdentity,
        },
      );
    }
    if (!rootStatus.isDirectory() || rootStatus.isSymbolicLink()) {
      // A redirect or non-directory at the path may itself be an unrelated entry swapped in after
      // validation began. Never unlink it without the original root identity; fail closed and let
      // an operator inspect the exact path.
      throw new BrokerError(
        "WORKTREE_REMOVE_FAILED",
        `Gate cleanup refused a non-directory or redirected validation worktree root: ${destination}.`,
      );
    }
    if (await realpath(key) !== administration.physicalDestination) {
      throw new BrokerError(
        "WORKTREE_REMOVE_FAILED",
        `Gate worktree root no longer matches its registered physical path: ${destination}.`,
      );
    }

    if (!expectedRootIdentity && !capturedGateAdministration) {
      // This is the narrow crash window after Git registered a pristine worktree but before state
      // recorded its inode. With no persisted identity, never chmod or repair an existing root;
      // require its original marker/backlink to be intact before allowing Git to remove it.
      try {
        await this.inspectRawWorktreeAdministration(destination, administration);
      } catch (error) {
        throw new BrokerError(
          "WORKTREE_REMOVE_FAILED",
          `Gate cleanup has no persisted root identity and the existing worktree is not pristine: ${destination}.`,
          { cause: error instanceof Error ? error.message : String(error) },
        );
      }
    } else {
      await this.repairGateWorktreePermissions(destination, administration);
    }
    let repaired = false;
    try {
      await this.inspectRawWorktreeAdministration(destination, administration);
    } catch {
      await this.repairWorktreeAdministration(destination, administration);
      repaired = true;
    }

    let result = await this.git(["worktree", "remove", "--force", destination], this.root, true);
    if (result.exitCode !== 0 && !repaired) {
      // A validator-spawned process may have raced the first proof. Revalidate and repair once;
      // never remove another registry entry or retry without the exact backlink-bound identity.
      await this.repairWorktreeAdministration(destination, administration);
      result = await this.git(["worktree", "remove", "--force", destination], this.root, true);
    }
    if (result.exitCode !== 0) {
      throw new BrokerError("WORKTREE_REMOVE_FAILED", `Could not remove integration worktree: ${destination}`, {
        stderr: result.stderr,
      });
    }
    this.rawWorktreeAdministrations.delete(key);
  }

  async cherryPick(cwd: string, commit: string): Promise<CommandResult> {
    return await this.brokerCommitGit(["cherry-pick", "-x", commit], cwd, true);
  }

  async abortCherryPick(cwd: string): Promise<void> {
    await this.git(["cherry-pick", "--abort"], cwd, true);
  }

  async createBranch(name: string, commit: string): Promise<void> {
    const exists = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], this.root, true);
    if (exists.exitCode === 0) {
      throw new BrokerError("BRANCH_EXISTS", `Integration branch already exists: ${name}`);
    }
    await this.git(["branch", "--", name, commit]);
  }

  async deleteBranch(name: string): Promise<void> {
    const deleted = await this.git(["branch", "-D", "--", name], this.root, true);
    if (deleted.exitCode === 0) return;
    const exists = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${name}`], this.root, true);
    if (exists.exitCode !== 0) return;
    throw new BrokerError("BRANCH_DELETE_FAILED", `Could not delete integration branch ${name}.`, {
      stdout: deleted.stdout,
      stderr: deleted.stderr,
    });
  }

  async squash(cwd: string, baseSha: string, message: string): Promise<string> {
    await this.git(["reset", "--soft", baseSha], cwd);
    await this.brokerCommitGit(["commit", "-m", message], cwd);
    return await this.currentHead(cwd);
  }

  /**
   * Best-effort refresh of the remote-tracking base. Integration must still work in a repository
   * with no remote or no network, so a failed fetch is reported rather than thrown.
   */
  async fetchBranch(remote: string, branch: string): Promise<boolean> {
    const result = await this.git(["fetch", "--quiet", "--", remote, branch], this.root, true);
    return result.exitCode === 0;
  }

  /** Fetch a branch through an exact URL without sharing FETCH_HEAD or a durable tracking ref. */
  async fetchBranchHead(remote: string, branch: string): Promise<string | undefined> {
    await this.assertExactRemoteLocator(remote, "REMOTE_TARGET_CHANGED");
    const temporaryRef = `refs/merge-broker/fetch/${process.pid}-${randomBytes(8).toString("hex")}`;
    return await this.withIsolatedHooks(async (hooksDirectory) => {
      const hookConfig = ["-c", `core.hooksPath=${hooksDirectory}`];
      const before = await this.localObjectGit(
        [...hookConfig, "show-ref", "--verify", "--quiet", temporaryRef],
        this.root,
        true,
      );
      if (before.exitCode === 0 || before.exitCode !== 1) {
        throw new BrokerError(
          "TEMPORARY_REF_CONFLICT",
          `Could not reserve the broker fetch ref ${temporaryRef}.`,
          { stderr: before.stderr },
        );
      }

      let fetched: string | undefined;
      try {
        const result = await this.localObjectGit(
          [
            ...hookConfig,
            "fetch",
            "--quiet",
            "--no-tags",
            "--no-write-fetch-head",
            "--force",
            "--",
            remote,
            `refs/heads/${branch}:${temporaryRef}`,
          ],
          this.root,
          true,
        );
        if (result.exitCode !== 0) return undefined;
        const symbolic = await this.localObjectGit(
          [...hookConfig, "symbolic-ref", "-q", temporaryRef],
          this.root,
          true,
        );
        if (symbolic.exitCode === 0) {
          throw new BrokerError(
            "FETCH_REF_INVALID",
            `Broker fetch ref ${temporaryRef} became symbolic.`,
            { target: symbolic.stdout.trim() },
          );
        }
        fetched = await this.resolveLocalCommit(temporaryRef);
        await this.assertExactRemoteLocator(remote, "REMOTE_TARGET_CHANGED");
        return fetched;
      } finally {
        const exists = await this.localObjectGit(
          ["show-ref", "--verify", "--quiet", temporaryRef],
          this.root,
          true,
        );
        if (exists.exitCode === 0) {
          const current = await this.localObjectGit(
            ["--no-replace-objects", "rev-parse", "--verify", "--end-of-options", temporaryRef],
            this.root,
            true,
          );
          if (current.exitCode !== 0) {
            throw new BrokerError(
              "TEMPORARY_REF_CLEANUP_FAILED",
              `Could not resolve the broker fetch ref ${temporaryRef} during cleanup.`,
              { stderr: current.stderr },
            );
          }
          const currentOid = current.stdout.trim();
          const deleted = await this.localObjectGit(
            [...hookConfig, "update-ref", "-d", temporaryRef, currentOid],
            this.root,
            true,
          );
          const after = await this.localObjectGit(
            ["show-ref", "--verify", "--quiet", temporaryRef],
            this.root,
            true,
          );
          if (deleted.exitCode !== 0 || after.exitCode === 0 || after.exitCode !== 1) {
            throw new BrokerError(
              "TEMPORARY_REF_CLEANUP_FAILED",
              `Could not remove the exact broker fetch ref ${temporaryRef}.`,
              { fetched, currentOid, stderr: deleted.stderr || after.stderr },
            );
          }
        } else if (exists.exitCode !== 1) {
          throw new BrokerError(
            "TEMPORARY_REF_CLEANUP_FAILED",
            `Could not inspect the broker fetch ref ${temporaryRef} during cleanup.`,
            { stderr: exists.stderr },
          );
        }
      }
    });
  }

  async commitGeneratedFile(
    cwd: string,
    relativePath: string,
    contents: string,
    message: string,
  ): Promise<string> {
    const target = path.resolve(cwd, relativePath);
    const relative = path.relative(cwd, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new BrokerError("UNSAFE_PATH", `Generated file escapes the integration worktree: ${relativePath}`);
    }
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, contents, "utf8");
    await this.git(["add", "--", relativePath], cwd);
    await this.brokerCommitGit(["commit", "-m", message], cwd);
    return await this.currentHead(cwd);
  }

  /**
   * Publishes an assembled batch from its recorded commit, never from the mutable local branch.
   * An empty expected value makes the lease a create-only guard. Git still treats a retry at the
   * same SHA as up to date, while refusing to replace any different remote value -- including a
   * value that the recorded commit could fast-forward.
   */
  async push(
    remote: string,
    branch: string,
    headSha: string,
    options: { exactRemote?: boolean } = {},
  ): Promise<void> {
    const exactRemote = options.exactRemote
      ? remote
      : await this.remotePushUrl(remote, "REMOTE_TARGET_CHANGED");
    await this.assertExactRemoteLocator(exactRemote, "REMOTE_TARGET_CHANGED");
    await this.withIsolatedHooks(async (hooksDirectory) =>
      await this.localObjectGit([
        "-c", `core.hooksPath=${hooksDirectory}`,
        "push",
        `--force-with-lease=refs/heads/${branch}:`,
        "--",
        exactRemote,
        `${headSha}:refs/heads/${branch}`,
      ])
    );
    await this.assertExactRemoteLocator(exactRemote, "REMOTE_TARGET_CHANGED");
  }

  /**
   * Advances an existing broker branch only when the remote still points at the candidate we are
   * superseding. This is the one permitted force update: it keeps a revision on the same PR while
   * refusing to overwrite somebody else's concurrent push.
   */
  async replaceRemoteBranch(
    remote: string,
    branch: string,
    nextHead: string,
    expectedHead: string,
  ): Promise<void> {
    await this.assertExactRemoteLocator(remote, "REMOTE_TARGET_CHANGED");
    await this.withIsolatedHooks(async (hooksDirectory) =>
      await this.localObjectGit([
        "-c", `core.hooksPath=${hooksDirectory}`,
        "push",
        `--force-with-lease=refs/heads/${branch}:${expectedHead}`,
        "--",
        remote,
        `${nextHead}:refs/heads/${branch}`,
      ])
    );
    await this.assertExactRemoteLocator(remote, "REMOTE_TARGET_CHANGED");
    await this.git(["branch", "-f", "--", branch, nextHead]);
  }

  async replaceLocalBranch(branch: string, nextHead: string): Promise<void> {
    await this.git(["branch", "-f", "--", branch, nextHead]);
  }

  async listWorktrees(): Promise<WorktreeInfo[]> {
    const result = await this.git(["worktree", "list", "--porcelain"]);
    const records: WorktreeInfo[] = [];
    let current: Partial<WorktreeInfo> = {};
    const flush = (): void => {
      if (current.path && current.head) {
        records.push({
          path: current.path,
          head: current.head,
          ...(current.branch ? { branch: current.branch } : {}),
          bare: current.bare ?? false,
          detached: current.detached ?? false,
          prunable: current.prunable ?? false,
        });
      }
      current = {};
    };

    for (const line of result.stdout.split("\n")) {
      if (!line) {
        flush();
        continue;
      }
      const separator = line.indexOf(" ");
      const key = separator === -1 ? line : line.slice(0, separator);
      const value = separator === -1 ? "" : line.slice(separator + 1);
      if (key === "worktree") current.path = value;
      else if (key === "HEAD") current.head = value;
      else if (key === "branch") current.branch = value.replace(/^refs\/heads\//u, "");
      else if (key === "bare") current.bare = true;
      else if (key === "detached") current.detached = true;
      else if (key === "prunable") current.prunable = true;
    }
    flush();
    return records;
  }
}
