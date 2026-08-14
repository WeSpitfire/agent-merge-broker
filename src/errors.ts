export class BrokerError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "BrokerError";
    this.code = code;
    this.details = details;
  }
}

export class CommandError extends BrokerError {
  readonly command: string;
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;

  constructor(command: string, exitCode: number, stdout: string, stderr: string) {
    super("COMMAND_FAILED", `Command failed (${exitCode}): ${command}`, {
      command,
      exitCode,
      stdout,
      stderr,
    });
    this.name = "CommandError";
    this.command = command;
    this.exitCode = exitCode;
    this.stdout = stdout;
    this.stderr = stderr;
  }
}

export class ValidationError extends BrokerError {
  constructor(message: string, details?: Record<string, unknown>) {
    super("VALIDATION_FAILED", message, details);
    this.name = "ValidationError";
  }
}
