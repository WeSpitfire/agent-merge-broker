// Internal launch programs. No command begins until the broker has durably registered the
// supervisor and sent the start message. Neither program loads repository code before that handoff.
export const POSIX_SUPERVISOR = String.raw`
const { spawn } = require("node:child_process");
let child;
let started = false;
const stop = () => { try { process.kill(-process.pid, "SIGKILL"); } catch { process.exit(128); } };
process.on("SIGTERM", () => {});
process.once("disconnect", stop);
process.on("message", (message) => {
  if (message.type === "terminate") {
    try { process.kill(-process.pid, "SIGTERM"); } catch {}
    setTimeout(stop, 2000).unref();
    return;
  }
  if (message.type !== "start" || started) return;
  started = true;
  child = spawn(message.executable, message.args, {
    cwd: message.cwd, env: message.env, shell: false, detached: false,
    stdio: ["pipe", "inherit", "inherit"],
  });
  const finish = (result) => {
    if (!process.connected) return stop();
    process.send({ type: "result", ...result }, stop);
  };
  child.once("error", (error) => finish({ error: error.message, errorCode: error.code }));
  child.once("close", (code, signal) => finish({ exitCode: code ?? (signal ? 128 : 1) }));
  child.stdin.on("error", () => {});
  child.stdin.end(message.input);
});
process.send({ type: "ready" });
`;

// This Node child is assigned to the Windows job BEFORE it is given its command. Creating an
// ordinary executable and assigning its job afterward would let it spawn uncontained descendants.
const WINDOWS_EXECUTOR = String.raw`
const { spawn } = require("node:child_process");
let text = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  text += chunk;
  if (!text.includes("\n")) return;
  process.stdin.removeAllListeners("data");
  const message = JSON.parse(text.slice(0, text.indexOf("\n")));
  process.env.NoDefaultCurrentDirectoryInExePath = "1";
  const child = spawn(message.executable, message.args, {
    cwd: message.cwd, env: message.env, shell: false, windowsHide: true,
    stdio: ["pipe", "inherit", "inherit"],
  });
  child.once("error", (error) => { console.error(error.message); process.exit(127); });
  child.once("close", (code) => process.exit(code ?? 128));
  child.stdin.on("error", () => {});
  child.stdin.end(message.input);
});
process.stdin.once("end", () => { if (!text.includes("\n")) process.exit(128); });
`;

// Windows PowerShell/.NET ships with the OS. The supervisor holds the sole job handle; unexpected
// death therefore kills the job too. Normal completion writes a durable marker only after the
// kernel reports zero active processes. Unexpected supervisor death retains the guard for inspected
// recovery because kernel termination can still be finishing pending I/O after the PID disappears.
const WINDOWS_SOURCE = String.raw`
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Collections.Generic;
public static class MergeBrokerSupervisor {
  [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
    public long ProcessTime, JobTime; public uint Flags; public UIntPtr MinWorkingSet, MaxWorkingSet;
    public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass, SchedulingClass;
  }
  [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
    public BasicLimit Basic; public IoCounters Io; public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [StructLayout(LayoutKind.Sequential)] struct Accounting {
    public long A, B, C, D; public uint E, Total, Active, Terminated;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimit value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int type, out Accounting value, uint size, IntPtr length);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
  static void Check(bool ok) { if (!ok) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error()); }
  static string Quote(string value) {
    var result = new StringBuilder("\""); int slashes = 0;
    foreach (char c in value) {
      if (c == '\\') { slashes++; continue; }
      if (c == '"') { result.Append('\\', slashes * 2 + 1); result.Append('"'); }
      else { result.Append('\\', slashes); result.Append(c); }
      slashes = 0;
    }
    result.Append('\\', slashes * 2); result.Append('"'); return result.ToString();
  }
  public static int Run() {
    IntPtr job = IntPtr.Zero; Process executor = null;
    string guard = null, nonce = null; bool assigned = false;
    try {
      job = CreateJobObject(IntPtr.Zero, null); Check(job != IntPtr.Zero);
      var limits = new ExtendedLimit(); limits.Basic.Flags = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
      Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimit))));
      Console.Error.WriteLine("MERGE_BROKER_SUPERVISOR_READY"); Console.Error.Flush();
      var incoming = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false), false);
      string line = incoming.ReadLine(); if (line == null) return 128;
      var input = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
      guard = input.ContainsKey("guardFile") ? (string)input["guardFile"] : null;
      nonce = input.ContainsKey("guardNonce") ? (string)input["guardNonce"] : null;
      var info = new ProcessStartInfo((string)input["node"], "--input-type=commonjs -e " + Quote((string)input["executor"]));
      info.UseShellExecute = false; info.CreateNoWindow = true; info.RedirectStandardInput = true;
      info.RedirectStandardOutput = true; info.RedirectStandardError = true;
      executor = Process.Start(info);
      Check(AssignProcessToJobObject(job, executor.Handle)); assigned = true;
      Task stdout = executor.StandardOutput.BaseStream.CopyToAsync(Console.OpenStandardOutput());
      Task stderr = executor.StandardError.BaseStream.CopyToAsync(Console.OpenStandardError());
      byte[] invocation = new UTF8Encoding(false).GetBytes(line + "\n");
      executor.StandardInput.BaseStream.Write(invocation, 0, invocation.Length);
      executor.StandardInput.BaseStream.Flush(); executor.StandardInput.Close();
      Task exited = Task.Run(() => executor.WaitForExit());
      // EOF means parent death; any second line is the parent's timeout request.
      Task disconnected = Task.Run(() => incoming.ReadLine());
      int winner = Task.WaitAny(exited, disconnected);
      int code = winner == 0 ? executor.ExitCode : 128;
      Check(TerminateJobObject(job, 128));
      Accounting accounting;
      do {
        Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero));
        if (accounting.Active != 0) Thread.Sleep(10);
      } while (accounting.Active != 0);
      if (guard != null) {
        using (var stream = new FileStream(guard + ".done", FileMode.CreateNew, FileAccess.Write, FileShare.Read)) {
          byte[] bytes = Encoding.UTF8.GetBytes(nonce); stream.Write(bytes, 0, bytes.Length); stream.Flush(true);
        }
      }
      // Parent death can break the output pipes. Persist the already-proven empty job first so
      // a diagnostic copy failure cannot strand automatic recovery after a normal disconnect.
      Task.WaitAll(stdout, stderr);
      // A clean host exit is not proof that the command ran. Only this launch-bound frame, after
      // executor completion and job quiescence, authorizes the broker to accept its exit status.
      Console.Error.Write("\u001eMERGE_BROKER_SUPERVISOR_RESULT:" + (string)input["protocolNonce"] + ":" + code + "\u001f");
      Console.Error.Flush();
      return code;
    } catch (Exception error) {
      Console.Error.WriteLine("Validator supervisor failed: " + error.Message);
      // A child awaiting assignment has received no command. Closing its stdin makes it exit.
      if (executor != null && !assigned) { try { executor.StandardInput.Close(); } catch {} }
      return 127;
    } finally {
      if (job != IntPtr.Zero) CloseHandle(job);
    }
  }
}
`;

export const WINDOWS_SUPERVISOR = Buffer.from(
  `$ErrorActionPreference = 'Stop'\n$ProgressPreference = 'SilentlyContinue'\nAdd-Type -ReferencedAssemblies 'System.Web.Extensions' -TypeDefinition @'\n${WINDOWS_SOURCE}\n'@\nexit ([MergeBrokerSupervisor]::Run())`,
  "utf16le",
).toString("base64");

// PowerShell's console host can exit without executing its command under DETACHED_PROCESS. A
// detached Node relay survives broker death, while its non-detached PowerShell child retains the
// working CREATE_NO_WINDOW launch mode. Keep all pipes referenced until PowerShell has drained its
// job; relay death instead closes libuv's kill-on-close job, killing PowerShell and its validator job.
export const WINDOWS_RELAY = String.raw`
const { spawn } = require("node:child_process");
process.env.NoDefaultCurrentDirectoryInExePath = "1";
const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", ${JSON.stringify(WINDOWS_SUPERVISOR)}], {
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true, detached: false,
});
const relay = (source, destination) => {
  let open = true;
  destination.on("error", () => { open = false; source.resume(); });
  destination.on("drain", () => source.resume());
  source.on("data", (chunk) => {
    if (open && !destination.write(chunk)) source.pause();
  });
  return () => open;
};
relay(child.stdout, process.stdout);
const errorOpen = relay(child.stderr, process.stderr);
child.stdin.on("error", () => {});
process.stdin.pipe(child.stdin);
process.stdin.on("error", () => child.stdin.end());
child.once("error", (error) => { if (errorOpen()) console.error(error.message); process.exitCode = 127; });
child.once("close", (code) => { process.stdin.destroy(); process.exitCode = code ?? 128; });
`;

export function windowsSupervisorInput(input: Record<string, unknown>): string {
  return `${JSON.stringify({ ...input, node: process.execPath, executor: WINDOWS_EXECUTOR })}\n`;
}
