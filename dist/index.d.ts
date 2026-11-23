type Context = Record<string, unknown>;
export interface ErrorReporter {
    captureException(error: unknown, context?: Context): void;
    captureMessage(message: string, context?: Context): void;
}
export interface Reporter extends ErrorReporter {
    flush(timeoutMs?: number): Promise<boolean>;
    shutdown(timeoutMs?: number): Promise<boolean>;
}
export type ReportInput = {
    kind: "exception";
    error: unknown;
    context?: Context;
} | {
    kind: "message";
    message: string;
    context?: Context;
};
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
    dailyBudget: {
        handled: number;
        fatal: number;
    };
    redact(input: ReportInput): ReportIdentity | null;
}
export declare const noopReporter: Reporter;
export declare function createReporter(options?: ReporterOptions): Reporter;
export {};
