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
  callSite: string;
  code?: string;
  level?: "error" | "fatal";
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
  dailyBudget: { handled: number; fatal: number };
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
    const { handled, fatal } = options.dailyBudget;
    if (![handled, fatal].every(limit => Number.isSafeInteger(limit) && limit >= 0)) return noopReporter;
    if (![module, release, environment].every(isLabel) || typeof redact !== "function" ||
        !Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1 ||
        !Number.isSafeInteger(throttleMs) || throttleMs < 0) return noopReporter;

    const transport = openTransport(options.dsn, { module, release, environment });
    const recent = new Map<string, number>();
    const dayMs = 24 * 60 * 60 * 1000;
    let resetAt = performance.now() + dayMs;
    let remainingHandled = handled;
    let remainingFatal = fatal;
    let closed = false;

    function capture(input: ReportInput): void {
      try {
        if (closed) return;
        const identity = redact(input);
        if (identity instanceof Promise) {
          void identity.catch(() => {});
          return;
        }
        if (!identity) return;
        const { name, callSite, level } = identity;
        if (!isLabel(name) || !isLabel(callSite)) return;
        if (input.kind === "message" && level !== "error") return;
        if (level !== undefined && level !== "error" && level !== "fatal") return;

        const now = performance.now();
        if (now >= resetAt) {
          resetAt = now + dayMs;
          remainingHandled = handled;
          remainingFatal = fatal;
        }
        const isFatal = level === "fatal";
        let key: string | undefined;
        if (isFatal) {
          if (!remainingFatal) return;
        } else {
          if (!remainingHandled || Math.random() >= sampleRate) return;
          if (throttleMs > 0) {
            for (const [entry, expiry] of recent) {
              if (expiry > now) break;
              recent.delete(entry);
            }
            key = JSON.stringify([input.kind, name, callSite]);
            if (recent.has(key) || recent.size >= 1024) return;
          }
        }

        const queued = transport.send(input.kind, {
          name, callSite, level, code: identity.code, tags: identity.tags,
          traceId: identity.traceId, breadcrumbs: identity.breadcrumbs,
        });
        if (!queued) return;
        if (isFatal) remainingFatal--;
        else remainingHandled--;
        if (key !== undefined) recent.set(key, now + throttleMs);
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
