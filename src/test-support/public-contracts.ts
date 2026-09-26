import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { runCommand } from "../process.js";

/** Readable, deterministic snapshots; never rewrite a baseline as part of a test run. */
export function canonicalJson(value: unknown): string {
  const sort = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(sort);
    if (entry !== null && typeof entry === "object") {
      return Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, child]) => [key, sort(child)]));
    }
    return entry;
  };
  return `${JSON.stringify(sort(value), null, 2)}\n`;
}

/**
 * Root export lists and the emitted declarations that back them. This intentionally uses the
 * compiler's text output, not an unstable compiler API or a second TypeScript dependency. A root
 * export addition must also update this explicit selection when it introduces another module.
 */
export async function publicDeclarationsSnapshot(): Promise<string> {
  const selection: Record<string, "all" | string[]> = {
    core: "all", index: "all", broker: "all", types: "all", mcp: "all",
    config: ["defaultConfig", "loadConfig", "validateConfig"],
    publisher: ["ForgePublisher", "PublicationResult", "PullRequestState", "githubCliPublisher"],
    verify: ["batchIdFromBranch", "policyFromBase", "verifyProvenance", "ProvenanceVerification", "VerifyProvenanceOptions"],
    provenance: ["provenanceKeyId", "provenancePath", "verifyBatchProvenanceSignature"],
    // The generated schemas back the exported z.infer aliases, so include them in this guard.
    "submission-attestation": [
      "SUBMISSION_ATTESTATION_PAYLOAD_TYPE", "SUBMISSION_ATTESTATION_PREDICATE_TYPE",
      "submissionAttestationStatementSchema", "submissionAttestationEnvelopeSchema",
      "SubmissionAttestationStatement", "SubmissionAttestationEnvelope", "SubmissionAttestationVerificationOptions",
      "SubmissionAttestationVerificationResult", "verifySubmissionAttestation",
    ],
    "schema-identity": ["schemaFingerprint", "schemaSnapshotIdentity"],
    errors: ["BrokerError"], "error-codes": ["BROKER_ERROR_CATEGORIES", "BROKER_ERROR_CODES", "BrokerErrorCategory", "BrokerErrorCode"],
    store: ["LockStatus"], hooks: ["HookInstallation"], service: ["ServiceInstallation"],
    bootstrap: ["AgentContractResult", "BootstrapPlan"],
    storage: ["StorageCategory", "StorageCompactionOptions", "StorageCompactionResult", "StorageReport"],
  };
  const sections: string[] = [];
  for (const [module, names] of Object.entries(selection)) {
    const source = (await readFile(new URL(`../../dist/${module}.d.ts`, import.meta.url), "utf8"))
      .replace(/\r\n/gu, "\n").replace(/\/\*[\s\S]*?\*\//gu, "")
      .replace(/^\s*private (?!constructor\()[^\n]*\n/gmu, "");
    const chunks = source.split(/(?=^export )/mu);
    const selected = names === "all" ? chunks : chunks.filter((chunk) => {
      const name = /^export (?:declare )?(?:class|interface|type|function|const) ([A-Za-z0-9_]+)/u.exec(chunk)?.[1];
      return name !== undefined && names.includes(name);
    });
    if (names !== "all" && selected.length !== names.length) throw new Error(`Declaration selection is incomplete for ${module}.`);
    const normalized = selected.join("").split("\n").map((line) => line.trimEnd()).filter((line) => line.trim() !== "").join("\n");
    sections.push(`// ${module}.d.ts\n${normalized}`);
  }
  return `${sections.join("\n\n")}\n`;
}

/** Representative CLI success/error documents; dynamic identities are checked before normalization. */
export async function cliJsonContract(repo: string): Promise<unknown> {
  const source = import.meta.url.endsWith(".ts");
  const cli = fileURLToPath(new URL(source ? "../cli.ts" : "../cli.js", import.meta.url));
  const normalize = (value: unknown, key = ""): unknown => {
    if (Array.isArray(value)) return value.map((entry) => normalize(entry));
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, normalize(entry, name)]));
    }
    if (key === "message") {
      if (typeof value !== "string" || value.length === 0) throw new Error("JSON error message must be a nonempty string.");
      return "<message>";
    }
    if (key === "createdAt" || key === "updatedAt") {
      if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${key}.`);
      return "<timestamp>";
    }
    if (key === "baseSha") {
      if (typeof value !== "string" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value)) throw new Error("Invalid baseSha.");
      return "<commit>";
    }
    if (typeof value === "string" && value.startsWith(repo)) return value.replace(repo, "<repo>").replaceAll("\\", "/");
    return value;
  };
  const results: Record<string, unknown> = {};
  const commands: Record<string, string[]> = {
    register: ["task", "register", "CONTRACT", "--title", "Compatibility fixture", "--path", "src/**"],
    task: ["task", "show", "CONTRACT"],
    plan: ["plan"],
    migrate: ["migrate"],
    missingTask: ["task", "show", "MISSING"],
    invalidArguments: ["task", "claim"],
  };
  for (const [name, args] of Object.entries(commands)) {
    const result = await runCommand(process.execPath, [
      ...(source ? ["--import", "tsx"] : []), cli, "--cwd", repo, "--json", ...args,
    ], { cwd: fileURLToPath(new URL("../../", import.meta.url)), allowFailure: true });
    results[name] = {
      exitCode: result.exitCode,
      stdout: result.stdout === "" ? null : normalize(JSON.parse(result.stdout)),
      stderr: result.stderr === "" ? null : normalize(JSON.parse(result.stderr)),
    };
  }
  return results;
}
