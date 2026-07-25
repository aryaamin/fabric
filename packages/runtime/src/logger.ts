import type { Logger } from "@fabric/capabilities";

export interface LogEntry {
  level: "debug" | "info" | "warn" | "error";
  msg: string;
  data?: unknown;
  at: string;
  scope: string;
}

/**
 * Structured logging. Every capability call, action run, and event is a log
 * entry, which is what powers the per-app "activity" and audit views the user
 * sees. Logs are captured in-memory here and would drain to an observability
 * backend in production.
 */
export class LogSink {
  entries: LogEntry[] = [];
  private echo: boolean;
  constructor(echo = false) {
    this.echo = echo;
  }

  scoped(scope: string): Logger {
    const write = (level: LogEntry["level"], msg: string, data?: unknown) => {
      const entry: LogEntry = { level, msg, at: new Date().toISOString(), scope, ...(data !== undefined ? { data } : {}) };
      this.entries.push(entry);
      if (this.echo) console.log(`[${level}] ${scope}: ${msg}`, data ?? "");
    };
    return {
      debug: (m, d) => write("debug", m, d),
      info: (m, d) => write("info", m, d),
      warn: (m, d) => write("warn", m, d),
      error: (m, d) => write("error", m, d),
    };
  }
}
