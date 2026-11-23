import { openTransport } from "./transport";

type Context = Record<string, unknown>;

export interface ErrorReporter {
  captureException(error: unknown, context?: Context): void;
  captureMessage(message: string, context?: Context): void;
}

export interface Reporter extends ErrorReporter {
  flush(timeoutMs?: number): Promise<boolean>;
  shutdown(timeoutMs?: number): Promise<boolean>;
}

export type ReportInput =
  | { kind: "exception"; error: unknown; context?: Context }
  | { kind: "message"; message: string; context?: Context };

export interface ReportIdentity {
  name: string;
  callSite?: string;
  code?: string;
  level?: "info" | "warning" | "error" | "fatal";
  traceId?: string;
  breadcrumbs?: readonly string[];
  tags?: Readonly<Record<string, string>>;
}

export interface ReporterOptions {
  dsn?: string;
  module: string;
  release: string;
  environment: string;
  sampleRate: number;
  throttleMs: number;
  redact(input: ReportInput): ReportIdentity | null;
}

export const noopReporter: Reporter = Object.freeze({
  captureException() {},
  captureMessage() {},
  async flush() { return true; },
  async shutdown() { return true; },
});

export function createReporter(options?: ReporterOptions): Reporter {
  try {
    if (!options?.dsn) return noopReporter;
    const { module, release, environment, sampleRate, throttleMs, redact } = options;
    if (![module, release, environment].every(isLabel) || typeof redact !== "function" ||
        !Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1 ||
        !Number.isSafeInteger(throttleMs) || throttleMs < 0) return noopReporter;

    const transport = openTransport(options.dsn, { module, release, environment });
    const recent = new Map<string, number>();
    let closed = false;

    function capture(input: ReportInput): void {
      try {
        if (closed || Math.random() >= sampleRate) return;
        const identity = redact(input);
        if (identity instanceof Promise) {
          void identity.catch(() => {});
          return;
        }
        if (!identity || !isLabel(identity.name)) return;
        if (identity.callSite !== undefined && !isLabel(identity.callSite)) return;
        if (throttleMs > 0) {
          const now = performance.now();
          for (const [key, expiry] of recent) {
            if (expiry > now) break;
            recent.delete(key);
          }
          const key = JSON.stringify([input.kind, identity.name, identity.callSite]);
          if (recent.has(key) || recent.size >= 1024) return;
          recent.set(key, now + throttleMs);
        }
        transport.send(input.kind, identity);
      } catch {
        // Discard events that cannot be classified or queued.
      }
    }

    async function flush(timeoutMs = 2000): Promise<boolean> {
      try {
        if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647) return false;
        return await transport.flush(timeoutMs);
      } catch {
        return false;
      }
    }

    return {
      captureException: (error, context) => capture({ kind: "exception", error, context }),
      captureMessage: (message, context) => capture({ kind: "message", message, context }),
      flush,
      shutdown(timeoutMs) {
        closed = true;
        recent.clear();
        return flush(timeoutMs);
      },
    };
  } catch {
    return noopReporter;
  }
}

function isLabel(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 200;
}
