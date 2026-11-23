# @rmdev/telemetry

Policy-controlled error reporting for Node.js 22.13+ with a Sentry transport. The package supports ESM and CommonJS.

```ts
import { createReporter } from "@rmdev/telemetry";

const reporter = createReporter({
  dsn: config.reportingDsn,
  module: "worker",
  environment: config.environment,
  release: config.release,
  dailyBudget: { handled: config.handledLimit, fatal: config.crashLimit },
  sampleRate: 1,
  throttleMs: config.repeatIntervalMs,
  redact(input) {
    if (input.kind === "exception" && input.context?.site === "startup") {
      return { name: "StartupFailure", callSite: "startup", level: "fatal" };
    }
    if (input.kind === "message" && input.message === "job.exhausted") {
      return { name: "JobExhausted", callSite: "job", level: "error" };
    }
    return null;
  },
});
```

Use the application's logger for status, retries and recoveries. Call `reporter.captureMessage("job.exhausted")` when a job first enters a state that requires intervention. The reporter accepts messages only when the application's policy explicitly assigns error severity and an approved call site.

At a fatal startup boundary, call `reporter.captureException(error, { site: "startup" })`, then `await reporter.shutdown(2000)` before exiting. The application owns its process handlers. A successful flush means pending sends settled. Delivery can still fail or be rate-limited by the backend.

Each reporter has separate 24-hour limits for handled failures and crashes. A service supplies both limits at startup. For example, a handled limit of five allows one running copy to attempt five handled reports during its window. Each replica and each restarted process has a fresh allowance.

Build and test with `npm ci && npm test`. Consumers can install from a full Git commit SHA with lifecycle scripts disabled. The compiled package is in `dist/`. See the [build and rollout spec](docs/build.md).

## GitHub releases

To release a new version, run `npm version patch --no-git-tag-version` (or use `minor` or `major`) and include the package and lockfile changes in the pull request. After CI passes on the merged commit, GitHub Actions publishes a release tagged with the package version, such as `v0.1.0`. Merges at an already released version keep the existing tag.
