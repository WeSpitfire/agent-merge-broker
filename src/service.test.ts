import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  currentServicePlatform,
  launchdPlist,
  installService,
  quoteWindowsArgument,
  serviceFilePath,
  serviceName,
  systemdUnit,
  uninstallService,
  windowsTaskXml,
  type ServiceOptions,
} from "./service.js";
import { BrokerError } from "./errors.js";
import { runCommand } from "./process.js";
import { fileURLToPath } from "node:url";

function options(overrides: Partial<ServiceOptions> = {}): ServiceOptions {
  return {
    repositoryRoot: "/Users/dev/Projects/PowerHouse-CRM",
    nodePath: "/usr/local/bin/node",
    cliPath: "/Users/dev/Projects/PowerHouse-CRM/node_modules/agent-merge-broker/dist/cli.js",
    intervalSeconds: 15,
    eager: true,
    pathEntries: ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"],
    logFile: "/Users/dev/Library/Logs/merge-broker/serve.log",
    userId: "S-1-5-21-1000",
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

test(
  "systemd accepts the generated unit",
  { skip: process.platform === "linux" ? false : "systemd-analyze runs on Linux" },
  async (context) => {
    const analyze = await runCommand("systemd-analyze", ["--version"], { cwd: process.cwd(), allowFailure: true })
      .catch(() => undefined);
    if (!analyze || analyze.exitCode !== 0) {
      context.skip("systemd-analyze is unavailable");
      return;
    }
    const directory = await mkdtemp(path.join(tmpdir(), "merge-broker-unit-"));
    context.after(async () => await rm(directory, { recursive: true, force: true }));
    const unit = path.join(directory, "merge-broker-test.service");
    // Reference real executables so verification reports only formatting problems.
    await writeFile(unit, systemdUnit(options({
      repositoryRoot: directory,
      nodePath: process.execPath,
      cliPath: fileURLToPath(new URL("./cli.js", import.meta.url)),
      logFile: path.join(directory, "serve.log"),
    })), "utf8");
    const verified = await runCommand("systemd-analyze", ["verify", unit], { cwd: directory, allowFailure: true });
    assert.equal(verified.exitCode, 0, `${verified.stdout}\n${verified.stderr}`);
  },
);

test("escapes a repository path that would otherwise break the plist", () => {
  const plist = launchdPlist(options({ repositoryRoot: "/Users/dev/Ben & Co <work>" }));
  assert.match(plist, /Ben &amp; Co &lt;work&gt;/);
  assert.doesNotMatch(plist, /Ben & Co <work>/);
});

test("quotes systemd arguments so a spaced path stays one argument", () => {
  const unit = systemdUnit(options({ repositoryRoot: "/srv/two words" }));
  assert.match(unit, /ExecStart=.*"\/srv\/two words"/);
  assert.match(unit, /Restart=always/);
});

test("writes systemd path settings unquoted and escapes specifier characters", () => {
  const unit = systemdUnit(options({ repositoryRoot: "/srv/100% both$ words" }));
  // systemd does not strip quotes from these settings: a quoted path is not an absolute path,
  // and a quoted append: target is ignored, so the service would fail to start or lose its log.
  assert.match(unit, /\nWorkingDirectory=\/srv\/100%% both\$ words\n/u);
  assert.match(unit, /\nStandardOutput=append:\/[^"\n]*serve\.log\n/u);
  assert.match(unit, /\nStandardError=append:\/[^"\n]*serve\.log\n/u);
  // Inside quoted command words, % starts a specifier and $ starts a variable reference.
  assert.match(unit, /ExecStart=.*"\/srv\/100%% both\$\$ words"/u);
});

test("the Windows scheduled task is per-user, restartable, logged, and safely quoted", () => {
  const xml = windowsTaskXml(options({
    repositoryRoot: "/Users/dev/Two Words & Co",
    cliPath: "/Users/dev/Two Words & Co/dist/cli.js",
  }));
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/u);
  assert.match(xml, /<UserId>[^<]+<\/UserId>/u);
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/u);
  assert.match(xml, /<RestartOnFailure>/u);
  assert.match(xml, /<Interval>PT1M<\/Interval><Count>255<\/Count>/u);
  assert.match(xml, /--log-file/u);
  assert.match(xml, /Two Words &amp; Co/u);
  assert.equal(quoteWindowsArgument("C:\\Program Files\\nodejs\\"), '"C:\\Program Files\\nodejs\\\\"');
});

test("requires a Windows user SID rather than guessing a service identity", () => {
  const missingIdentity = options();
  delete missingIdentity.userId;
  assert.throws(
    () => windowsTaskXml(missingIdentity),
    (error: unknown) => error instanceof BrokerError && error.code === "INVALID_SERVICE_USER",
  );
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
  assert.equal(
    serviceFilePath("windows", "merge-broker.serve.x.0000ffff", "C:\\Users\\dev"),
    "C:\\Users\\dev\\AppData\\Local\\AgentMergeBroker\\Tasks\\merge-broker.serve.x.0000ffff.xml",
  );
});

test("selects a supported per-user service supervisor on every host platform", () => {
  assert.equal(currentServicePlatform("darwin"), "launchd");
  assert.equal(currentServicePlatform("linux"), "systemd");
  assert.equal(currentServicePlatform("win32"), "windows");
  assert.throws(() => currentServicePlatform("freebsd"), (error: unknown) => {
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
