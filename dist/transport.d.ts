import type { ReportIdentity, ReportInput, ReporterOptions } from "./index";
export declare function openTransport(dsn: string, deployment: Pick<ReporterOptions, "module" | "release" | "environment">): {
    send: (kind: ReportInput["kind"], identity: ReportIdentity) => void;
    flush: (timeout?: number) => PromiseLike<boolean>;
};
