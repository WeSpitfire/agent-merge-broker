import { pathToFileURL } from "node:url";
import path from "node:path";

/** Keep release candidates off npm's default install channel. Fail closed on contradictory metadata. */
export function releaseChannel(version, prerelease) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/u.exec(version);
  if (!match || match[0] !== version || match[4]?.split(".").some((part) => /^0\d+$/u.test(part))) {
    throw new Error("Release versions must be valid SemVer without build metadata.");
  }
  if (prerelease !== "true" && prerelease !== "false") {
    throw new Error("The GitHub release prerelease flag must be true or false.");
  }
  if (Boolean(match[4]) !== (prerelease === "true")) {
    throw new Error("The version suffix and GitHub release prerelease flag must agree.");
  }
  return match[4] ? "next" : "latest";
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 4) throw new Error("Usage: release-channel.mjs <version> <true|false>");
    console.log(releaseChannel(process.argv[2], process.argv[3]));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
