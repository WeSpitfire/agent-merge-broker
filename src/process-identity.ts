import { closeSync, openSync, readlinkSync, readSync } from "node:fs";

/**
 * Linux PIDs are meaningful only inside one boot and PID namespace. Hostnames and platform/arch
 * are not sufficient: containers can share both while mounting the same Git common directory.
 * No value is cached, so an unavailable or changed identity never inherits an earlier proof.
 */
export function linuxProcessIdentity(): string | undefined {
  if (process.platform !== "linux") return undefined;
  try {
    // These are fixed procfs endpoints, never caller-selected paths. Limit the boot-id read rather
    // than trusting a mounted file's reported size; namespace symlink targets are kernel-bounded.
    const namespace = readlinkSync("/proc/self/ns/pid");
    if (!/^pid:\[\d{1,20}\]$/u.test(namespace)) return undefined;
    const descriptor = openSync("/proc/sys/kernel/random/boot_id", "r");
    const bytes = Buffer.alloc(128);
    let length: number;
    try { length = readSync(descriptor, bytes, 0, bytes.length, null); } finally { closeSync(descriptor); }
    if (length === bytes.length) return undefined;
    const boot = bytes.subarray(0, length).toString("ascii").trim().toLowerCase();
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(boot)) return undefined;
    return `linux:${boot}:${namespace}`;
  } catch {
    return undefined;
  }
}

/** Legacy Linux records lack namespace provenance and require an inspected force unlock. */
export function canProbeProcessIdentity(
  recorded: unknown,
  platform: NodeJS.Platform,
  current: string | undefined,
): boolean {
  if (platform !== "linux") return recorded === undefined;
  return typeof recorded === "string" && current !== undefined && recorded === current;
}
