/**
 * What the integration loop says while it runs.
 *
 * `serve` used to write only on a merge, a closure, an error, or a *completed*
 * integration. Nothing marked the start of one — so a batch spending five
 * minutes in validators produced an empty log, and a healthy busy service was
 * indistinguishable from a dead one. The service installed by
 * `install-service` made that worse by moving the loop out of a terminal,
 * where at least somebody could see it was alive.
 *
 * Every line is timestamped, because a log file without timestamps cannot
 * answer the only question anybody asks of it: was it still working when the
 * thing I care about happened?
 */

export type ServeEvent =
  | {
      kind: "started";
      version: string;
      repository: string;
      intervalSeconds: number;
      publish: boolean;
      eager: boolean;
    }
  | { kind: "integrating"; tasks: string[] }
  | { kind: "recovered"; batches: string[]; tasks: string[] }
  | { kind: "integrated"; batchId: string; state: string; published: boolean }
  | { kind: "merged"; batchId: string }
  | { kind: "closed"; batchId: string }
  | { kind: "failed"; message: string }
  | { kind: "sync-failed"; batchId: string; message: string }
  | { kind: "idle"; waiting: number; quietSeconds: number }
  | { kind: "stopped"; signal: string };

/** How long the loop may say nothing before it says it is idle. */
export const HEARTBEAT_INTERVAL_MS = 600_000;

export function isErrorEvent(event: ServeEvent): boolean {
  return event.kind === "failed" || event.kind === "sync-failed" || event.kind === "closed";
}

export function describeServeEvent(event: ServeEvent): string {
  switch (event.kind) {
    case "started":
      return `serve ${event.version} watching ${event.repository} every ${event.intervalSeconds}s`
        + ` (publish=${event.publish}, eager=${event.eager})`;
    case "integrating":
      // The line whose absence made a working service look dead.
      return `integrating ${event.tasks.length} task(s): ${event.tasks.join(", ")}`;
    case "recovered":
      return `recovered ${event.batches.length} abandoned batch(es); requeued ${event.tasks.length} task(s)`;
    case "integrated":
      return `batch ${event.batchId} ${event.state}${event.published ? " and published" : ""}`;
    case "merged":
      return `batch ${event.batchId} merged`;
    case "closed":
      return `batch ${event.batchId} closed without merging; its tasks returned to the queue`;
    case "failed":
      return `integration attempt failed: ${event.message}`;
    case "sync-failed":
      return `could not sync batch ${event.batchId}: ${event.message}`;
    case "idle":
      return event.waiting > 0
        ? `idle for ${Math.round(event.quietSeconds)}s with ${event.waiting} task(s) waiting to fill a batch`
        : `idle for ${Math.round(event.quietSeconds)}s, nothing submitted`;
    case "stopped":
      return `stopping on ${event.signal}`;
  }
}

export function formatServeEvent(event: ServeEvent, now: Date): string {
  return `${now.toISOString()} ${describeServeEvent(event)}`;
}

export function serveEventJson(event: ServeEvent, now: Date): string {
  return JSON.stringify({ at: now.toISOString(), ...event });
}

/**
 * A quiet loop still has to prove it is alive, but at a 15 second poll a line
 * per cycle is 5,760 lines a day and nobody reads that. Idleness is reported
 * on its own slower clock.
 */
export function shouldReportIdle(
  lastOutputAtMs: number,
  nowMs: number,
  intervalMs: number = HEARTBEAT_INTERVAL_MS,
): boolean {
  return nowMs - lastOutputAtMs >= intervalMs;
}
