# @rmdev/telemetry

Error reporting for Node.js 22.13+ with a Sentry transport and a redaction policy supplied by the application. The package supports ESM and CommonJS.

```ts
import { createReporter } from "@rmdev/telemetry";

const reporter = createReporter({
  dsn: process.env.REPORTING_DSN,
  module: "worker",
  environment: "production",
  release: "stable.1",
  sampleRate: 1,
  throttleMs: 30_000,
  redact(input) {
    if (input.kind === "exception" && input.context?.callSite === "write") {
      return { name: "WriteFailure", callSite: "write" };
    }
    return null;
  },
});

try {
  await write();
} catch (error) {
  reporter.captureException(error, { callSite: "write" });
  throw error;
}
```

Pass the reporter to application code as an `ErrorReporter`. The process owner calls `await reporter.shutdown(2000)` before exit. A successful flush means pending sends settled. It does not guarantee backend acceptance.

Build and test with `npm ci && npm test`. Install from a full Git commit SHA. The compiled package is included in `dist/`. See the [build and rollout spec](docs/build.md) for configuration and privacy requirements.
