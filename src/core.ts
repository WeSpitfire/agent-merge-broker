// The supported Node API, shared by the full and core packages. Anything not exported here is an
// implementation detail and may change in any release; see docs/COMPATIBILITY.md.
export {
  MergeBroker,
  type AdoptCandidateInput,
  type ClaimTaskInput,
  type RegisterCandidateAuthorityOptions,
  type RegisterTaskInput,
} from "./broker.js";
export { defaultConfig, loadConfig, validateConfig } from "./config.js";
export {
  githubCliPublisher,
  type ForgePublisher,
  type PublicationResult,
  type PullRequestState,
} from "./publisher.js";
export {
  batchIdFromBranch,
  policyFromBase,
  verifyProvenance,
  type ProvenanceVerification,
  type VerifyProvenanceOptions,
} from "./verify.js";
export { provenanceKeyId, provenancePath, verifyBatchProvenanceSignature } from "./provenance.js";
export {
  verifySubmissionAttestation,
  SUBMISSION_ATTESTATION_PAYLOAD_TYPE,
  SUBMISSION_ATTESTATION_PREDICATE_TYPE,
  type SubmissionAttestationEnvelope,
  type SubmissionAttestationStatement,
  type SubmissionAttestationVerificationOptions,
  type SubmissionAttestationVerificationResult,
} from "./submission-attestation.js";
export { schemaFingerprint, schemaSnapshotIdentity } from "./schema-identity.js";
export { BrokerError } from "./errors.js";
// Result types of MergeBroker methods.
export type { LockStatus } from "./store.js";
export type { HookInstallation } from "./hooks.js";
export type { ServiceInstallation } from "./service.js";
export type { AgentContractResult, BootstrapPlan } from "./bootstrap.js";
export type {
  StorageCategory,
  StorageCompactionOptions,
  StorageCompactionResult,
  StorageReport,
} from "./storage.js";
export type * from "./types.js";
