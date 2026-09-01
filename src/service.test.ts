import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  currentServicePlatform,
  launchdPlist,
  installService,
  serviceFilePath,
  serviceName,
  systemdUnit,
  uninstallService,
  type ServiceOptions,
} from "./service.js";
import { BrokerError } from "./errors.js";

function options(overrides: Partial<ServiceOptions> = {}): ServiceOptions {
  return {
    repositoryRoot: "/Users/dev/Projects/PowerHouse-CRM",
    nodePath: "/usr/local/bin/node",
    cliPath: "/Users/dev/Projects/PowerHouse-CRM/node_modules/agent-merge-broker/dist/cli.js",
    intervalSeconds: 15,
    eager: true,
    pathEntries: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"],
    logFile: "/Users/dev/Library/Logs/merge-broker/serve.log",
    ...overrides,
  };
}

test("names the service per repository, not per project", () => {
  // Two checkouts of one project is a real arrangement, and a shared label
  // would leave one of them silently unserved.
  const first = serviceName("/Users/dev/Projects/PowerHouse-CRM");
  const second = serviceName("/Users/dev/Projects/PowerHouse-CRM-canvassing-release");
  const same = serviceName("/Users/dev/Projects/PowerHouse-CRM");
  assert.notEqual(first, second);
  assert.equal(first, same);
  assert.match(first, /^merge-broker\.serve\.[a-z0-9-]+\.[0-9a-f]{8}$/);
});

test("distinguishes two checkouts whose directory names match", () => {
  assert.notEqual(
    serviceName("/Users/dev/a/PowerHouse-CRM"),
    serviceName("/Users/dev/b/PowerHouse-CRM"),
  );
});

test("the launchd agent carries a PATH", () => {
  // A launchd agent inherits almost no environment. Without this the loop
  // starts, cannot find git or the forge CLI, and does nothing at all — which
  // looks identical to the broker having nothing to do.
  const plist = launchdPlist(options());
  assert.match(plist, /<key>PATH<\/key>/);
  assert.match(plist, /\/opt\/homebrew\/bin:\/usr\/local\/bin:\/usr\/bin:\/bin/);
});

test("the launchd agent publishes, restarts, and logs", () => {
  const plist = launchdPlist(options());
  assert.match(plist, /<string>serve<\/string>/);
  assert.match(plist, /<string>--publish<\/string>/);
  assert.match(plist, /<string>--eager<\/string>/);
  assert.match(plist, /<key>KeepAlive<\/key>\s*<true\/>/);
  assert.match(plist, /<key>RunAtLoad<\/key>\s*<true\/>/);
  assert.match(plist, /serve\.log/);
});

test("omits --eager when it was not asked for", () => {
  assert.doesNotMatch(launchdPlist(options({ eager: false })), /--eager/);
  assert.doesNotMatch(systemdUnit(options({ eager: false })), /--eager/);
});

test("escapes a repository path that would otherwise break the plist", () => {
  const plist = launchdPlist(options({ repositoryRoot: "/Users/dev/Ben & Co <work>" }));
  assert.match(plist, /Ben &amp; Co &lt;work&gt;/);
  assert.doesNotMatch(plist, /Ben & Co <work>/);
});

test("quotes systemd arguments so a spaced path stays one argument", () => {
  const unit = systemdUnit(options({ repositoryRoot: "/srv/two words" }));
  assert.match(unit, /ExecStart=.*"\/srv\/two words"/);
  assert.match(unit, /StandardOutput="append:.*serve\.log"/);
  assert.match(unit, /StandardError="append:.*serve\.log"/);
  assert.match(unit, /Restart=always/);
});

test("rejects an invalid service interval before writing a supervisor file", () => {
  assert.throws(
    () => systemdUnit(options({ intervalSeconds: 0 })),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_INTERVAL",
  );
  assert.throws(
    () => launchdPlist(options({ intervalSeconds: Number.NaN })),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_INTERVAL",
  );
});

test("installs into the per-user location, never a system one", () => {
  assert.equal(
    serviceFilePath("launchd", "merge-broker.serve.x.0000ffff", "/Users/dev"),
    path.join("/Users/dev", "Library", "LaunchAgents", "merge-broker.serve.x.0000ffff.plist"),
  );
  assert.equal(
    serviceFilePath("systemd", "merge-broker.serve.x.0000ffff", "/home/dev"),
    path.join("/home/dev", ".config", "systemd", "user", "merge-broker.serve.x.0000ffff.service"),
  );
});

test("refuses a platform it cannot supervise instead of writing a file nothing reads", () => {
  assert.equal(currentServicePlatform("darwin"), "launchd");
  assert.equal(currentServicePlatform("linux"), "systemd");
  assert.throws(() => currentServicePlatform("win32"), (error: unknown) => {
    assert.ok(error instanceof BrokerError);
    assert.equal(error.code, "UNSUPPORTED_PLATFORM");
    return true;
  });
});

test(
  "refuses to overwrite or remove a supervisor file it does not own",
  async (context) => {
    const root = await mkdtemp(path.join(tmpdir(), "merge-broker-service-"));
    const home = path.join(root, "home");
    const repositoryRoot = path.join(root, "repo");
    await mkdir(repositoryRoot, { recursive: true });
    const configured = options({
      repositoryRoot,
      logFile: path.join(root, "serve.log"),
    });
    const file = serviceFilePath(currentServicePlatform(), serviceName(repositoryRoot), home);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, "# somebody else's service\n", "utf8");
    context.after(async () => {
      await rm(root, { recursive: true, force: true });
    });

    await assert.rejects(
      installService(configured, home),
      (error: unknown) => error instanceof BrokerError && error.code === "SERVICE_FILE_CONFLICT",
    );
    await assert.rejects(
      uninstallService(repositoryRoot, home),
      (error: unknown) => error instanceof BrokerError && error.code === "SERVICE_FILE_CONFLICT",
    );
  },
);
