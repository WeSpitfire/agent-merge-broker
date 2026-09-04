import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { isSafeStateDirectory } from "./config.js";
import { BrokerError } from "./errors.js";
import { GitRepository, remoteUrlFingerprint } from "./git.js";
import {
  GATE_AUTHORITY_VERSION,
  type BrokerConfig,
  type GateAuthorityRegistration,
  type GateAuthorityTarget,
} from "./types.js";

export const GATE_AUTHORITY_FILENAME = "merge-broker-gate-authority.json";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function authorityDigest(value: {
  version: number;
  kind: string;
  target: GateAuthorityTarget;
  stateDirectory: string;
}): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => allowed.has(key));
}

function validLocator(value: unknown): value is string {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !/[\x00-\x1f\x7f]/u.test(value);
}

function remoteQualifiedTarget(target: GateAuthorityTarget): boolean {
  return target.baseRef === `${target.remote}/${target.baseBranch}` ||
    target.baseRef === `refs/remotes/${target.remote}/${target.baseBranch}`;
}

function refreshableTarget(target: GateAuthorityTarget): boolean {
  return target.baseRef === target.baseBranch || remoteQualifiedTarget(target);
}

export function gateAuthorityDigest(registration: GateAuthorityRegistration): string {
  return authorityDigest({
    version: registration.version,
    kind: registration.kind,
    target: registration.target,
    stateDirectory: registration.stateDirectory,
  });
}

export function validateGateAuthority(value: unknown): GateAuthorityRegistration {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ["version", "kind", "digest", "target", "stateDirectory", "registeredAt"])
  ) {
    throw new BrokerError("GATE_AUTHORITY_CORRUPT", "Gate authority registration has an invalid shape.");
  }
  if (value.version !== GATE_AUTHORITY_VERSION) {
    throw new BrokerError(
      "GATE_AUTHORITY_VERSION",
      `Unsupported Gate authority registration version: ${String(value.version)}`,
    );
  }
  if (value.kind !== "trusted-local-ref") {
    throw new BrokerError("GATE_AUTHORITY_CORRUPT", "Gate authority registration has an invalid kind.");
  }
  if (
    !isRecord(value.target) ||
    !hasExactKeys(value.target, ["baseRef", "baseBranch", "remote", "refreshBase"], ["fetchUrlFingerprint"]) ||
    !validLocator(value.target.baseRef) ||
    !validLocator(value.target.baseBranch) ||
    !validLocator(value.target.remote) ||
    typeof value.target.refreshBase !== "boolean" ||
    (value.target.fetchUrlFingerprint !== undefined &&
      (typeof value.target.fetchUrlFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/u.test(value.target.fetchUrlFingerprint)))
  ) {
    throw new BrokerError("GATE_AUTHORITY_CORRUPT", "Gate authority target locator is invalid.");
  }
  const target: GateAuthorityTarget = {
    baseRef: value.target.baseRef,
    baseBranch: value.target.baseBranch,
    remote: value.target.remote,
    refreshBase: value.target.refreshBase,
    ...(typeof value.target.fetchUrlFingerprint === "string"
      ? { fetchUrlFingerprint: value.target.fetchUrlFingerprint }
      : {}),
  };
  if (target.refreshBase && refreshableTarget(target) && !target.fetchUrlFingerprint) {
    throw new BrokerError(
      "GATE_AUTHORITY_CORRUPT",
      "A refreshable Gate target must bind a fetch URL fingerprint.",
    );
  }
  if (!isSafeStateDirectory(value.stateDirectory)) {
    throw new BrokerError("GATE_AUTHORITY_CORRUPT", "Gate authority state directory is invalid.");
  }
  if (
    typeof value.registeredAt !== "string" ||
    !Number.isFinite(Date.parse(value.registeredAt)) ||
    typeof value.digest !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.digest)
  ) {
    throw new BrokerError("GATE_AUTHORITY_CORRUPT", "Gate authority identity metadata is invalid.");
  }
  const registration: GateAuthorityRegistration = {
    version: GATE_AUTHORITY_VERSION,
    kind: "trusted-local-ref",
    digest: value.digest,
    target,
    stateDirectory: value.stateDirectory,
    registeredAt: value.registeredAt,
  };
  if (gateAuthorityDigest(registration) !== registration.digest) {
    throw new BrokerError("GATE_AUTHORITY_CORRUPT", "Gate authority registration digest does not match its locator.");
  }
  return registration;
}

function configuredTarget(config: BrokerConfig): GateAuthorityTarget {
  return {
    baseRef: config.baseRef,
    baseBranch: config.baseBranch,
    remote: config.remote,
    refreshBase: config.integration.refreshBase,
  };
}

function locatorMismatch(
  registration: GateAuthorityRegistration,
  config: BrokerConfig,
): Record<string, unknown> | undefined {
  const actual = configuredTarget(config);
  const expected = registration.target;
  if (
    actual.baseRef === expected.baseRef &&
    actual.baseBranch === expected.baseBranch &&
    actual.remote === expected.remote &&
    actual.refreshBase === expected.refreshBase &&
    config.stateDirectory === registration.stateDirectory
  ) return undefined;
  return {
    expected: {
      baseRef: expected.baseRef,
      baseBranch: expected.baseBranch,
      remote: expected.remote,
      refreshBase: expected.refreshBase,
      stateDirectory: registration.stateDirectory,
    },
    actual: {
      ...actual,
      stateDirectory: config.stateDirectory,
    },
  };
}

export function assertGateAuthorityMatchesProtectedConfig(
  registration: GateAuthorityRegistration,
  config: BrokerConfig,
): void {
  const mismatch = locatorMismatch(registration, config);
  if (mismatch) {
    throw new BrokerError(
      "GATE_AUTHORITY_MISMATCH",
      "Protected-base configuration does not match the explicitly registered Gate target. Replace the authority registration only after reviewing the target change.",
      mismatch,
    );
  }
}

export async function assertGateAuthorityMatchesCurrentConfig(
  registration: GateAuthorityRegistration,
  config: BrokerConfig,
  repo: GitRepository,
): Promise<void> {
  const mismatch = locatorMismatch(registration, config);
  if (mismatch) {
    throw new BrokerError(
      "GATE_AUTHORITY_MISMATCH",
      "Mutable checkout configuration does not match the explicitly registered Gate target. Restore it or run candidate authority setup --replace after reviewing the change.",
      mismatch,
    );
  }

  const expectedFingerprint = registration.target.fetchUrlFingerprint;
  if (expectedFingerprint) {
    try {
      const current = await repo.remoteFetchUrl(registration.target.remote);
      if (remoteUrlFingerprint(current) !== expectedFingerprint) {
        throw new BrokerError(
          "REMOTE_TARGET_CHANGED",
          `Remote ${registration.target.remote} no longer points at the registered Gate fetch target.`,
          { expectedFingerprint, actualFingerprint: remoteUrlFingerprint(current) },
        );
      }
    } catch (error) {
      throw new BrokerError(
        "GATE_AUTHORITY_MISMATCH",
        "The configured remote no longer matches the URL fingerprint registered for Gate adoption.",
        {
          remote: registration.target.remote,
          expectedFingerprint,
          cause: errorMessage(error),
        },
      );
    }
    return;
  }
}

export async function deriveGateAuthorityRegistration(
  repo: GitRepository,
  config: BrokerConfig,
): Promise<GateAuthorityRegistration> {
  const target = configuredTarget(config);
  let canonicalRemote: string | undefined;
  try {
    canonicalRemote = await repo.remoteFetchUrl(target.remote);
  } catch (error) {
    if (target.refreshBase && refreshableTarget(target)) throw error;
  }
  const boundTarget: GateAuthorityTarget = {
    ...target,
    ...(canonicalRemote ? { fetchUrlFingerprint: remoteUrlFingerprint(canonicalRemote) } : {}),
  };
  const identity = {
    version: GATE_AUTHORITY_VERSION,
    kind: "trusted-local-ref" as const,
    target: boundTarget,
    stateDirectory: config.stateDirectory,
  };
  return {
    ...identity,
    digest: authorityDigest(identity),
    registeredAt: new Date().toISOString(),
  };
}

export class GateAuthorityStore {
  readonly file: string;

  constructor(commonGitDirectory: string) {
    this.file = path.join(path.resolve(commonGitDirectory), GATE_AUTHORITY_FILENAME);
  }

  async read(): Promise<GateAuthorityRegistration | undefined> {
    let source: string;
    try {
      source = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(source);
    } catch (error) {
      throw new BrokerError("GATE_AUTHORITY_CORRUPT", "Gate authority registration is not valid JSON.", {
        cause: errorMessage(error),
      });
    }
    return validateGateAuthority(parsed);
  }

  async require(): Promise<GateAuthorityRegistration> {
    const registration = await this.read();
    if (!registration) {
      throw new BrokerError(
        "GATE_AUTHORITY_REQUIRED",
        "Trusted local-ref adoption requires an explicit authority registration. Run candidate authority setup from the reviewed protected checkout.",
      );
    }
    return registration;
  }

  /** Caller must hold StateStore.withGateAuthorityLock across this operation. */
  async register(
    proposed: GateAuthorityRegistration,
    options: { replace?: boolean } = {},
  ): Promise<GateAuthorityRegistration> {
    const registration = validateGateAuthority(proposed);
    const existing = await this.read();
    if (existing?.digest === registration.digest) return existing;
    if (existing && !options.replace) {
      throw new BrokerError(
        "GATE_AUTHORITY_EXISTS",
        "A different Gate authority is already registered. Review the target change and pass replace explicitly.",
        { existingDigest: existing.digest, proposedDigest: registration.digest },
      );
    }
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    if (existing) await this.atomicReplace(registration);
    else return await this.createOnly(registration);
    return registration;
  }

  private async createOnly(registration: GateAuthorityRegistration): Promise<GateAuthorityRegistration> {
    const temporary = await this.writeTemporary(registration);
    try {
      await link(temporary, this.file);
      await chmod(this.file, 0o600).catch(() => undefined);
      return registration;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = await this.require();
      if (existing.digest === registration.digest) return existing;
      throw new BrokerError(
        "GATE_AUTHORITY_EXISTS",
        "A different Gate authority was registered concurrently. Review it before replacing authority.",
        { existingDigest: existing.digest, proposedDigest: registration.digest },
      );
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async atomicReplace(registration: GateAuthorityRegistration): Promise<void> {
    const temporary = await this.writeTemporary(registration);
    try {
      await rename(temporary, this.file);
      await chmod(this.file, 0o600).catch(() => undefined);
    } finally {
      await rm(temporary, { force: true });
    }
  }

  private async writeTemporary(registration: GateAuthorityRegistration): Promise<string> {
    const temporary = `${this.file}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(registration, null, 2)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    return temporary;
  }
}
