const { createReporter } = require("@rmdev/telemetry");

const reporter = createReporter({
  dsn: process.argv[2],
  module: "fixture",
  release: "test",
  environment: "test",
  dailyBudget: { handled: 1, fatal: 1 },
  sampleRate: 1,
  throttleMs: 60_000,
  redact(input) {
    if (input.kind === "exception" && input.context?.site === "crash") {
      return { name: "UnhandledError", callSite: "bootstrap", level: "fatal" };
    }
    if (input.kind === "message" && input.message === "job.exhausted") {
      return { name: "JobExhausted", callSite: "job", level: "error" };
    }
    return null;
  },
});

process.once("uncaughtException", async error => {
  reporter.captureException(error, { site: "crash" });
  await reporter.shutdown();
  process.exit(1);
});

for (let i = 0; i < 10_000; i++) console.warn("retry scheduled");
reporter.captureMessage("job.exhausted");
reporter.captureMessage("job.exhausted");
throw new Error("private fatal error content");
