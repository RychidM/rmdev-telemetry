import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { createReporter, noopReporter } from "@rmdev/telemetry";

const options = {
  module: "worker", release: "beta.1", environment: "test", sampleRate: 1, throttleMs: 0,
  dailyBudget: { handled: 5, fatal: 1 },
  redact: () => ({ name: "service.failed", callSite: "run", level: "error" }),
};

async function receiver(t, respond = res => res.end()) {
  const events = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const [header, item, event] = body.trim().split("\n").map(line => JSON.parse(line));
    events.push({ header, item, event, url: req.url });
    respond(res);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    return new Promise(resolve => server.close(resolve));
  });
  return { server, events, dsn: `http://public@127.0.0.1:${server.address().port}/prefix/7` };
}

test("CJS and ESM expose the same no-op and invalid configuration stays inert", async () => {
  assert.equal(createRequire(import.meta.url)("@rmdev/telemetry").noopReporter, noopReporter);
  for (const config of [undefined, {}, { ...options, dsn: "malformed" },
    { ...options, dsn: "https://key@invalid.test/1", redact: undefined },
    { ...options, dsn: "https://key@invalid.test/1", sampleRate: NaN },
    { ...options, dsn: "https://key@invalid.test/1", dailyBudget: undefined },
    { ...options, dsn: "https://key@invalid.test/1", dailyBudget: { handled: -1, fatal: 1 } }]) {
    const reporter = createReporter(config);
    assert.equal(reporter, noopReporter);
    reporter.captureException(new Error());
    assert.equal(await reporter.shutdown(), true);
  }
});

test("only approved identity and per-event metadata reach the wire", async t => {
  const { dsn, events } = await receiver(t);
  const secret = "sensitive-content-in-input";
  const traceId = "0123456789abcdef0123456789abcdef";
  const reporter = createReporter({ ...options, dsn, redact(input) {
    if (input.kind === "message") return input.message === "job.failed" ? { name: "job.failed", callSite: "job", level: "error" } : null;
    return {
      name: "IOError", code: "EIO", callSite: "write", traceId, breadcrumbs: ["queued"], tags: { component: "io" },
      extra: input.context, stack: input.error.stack, request: { url: secret },
    };
  } });
  reporter.captureException(new Error(secret), { password: secret });
  reporter.captureMessage("job.failed", { private: secret });
  reporter.captureMessage(secret);
  assert.equal(await reporter.shutdown(), true);
  reporter.captureMessage("job.failed");
  assert.equal(events.length, 2);
  const failure = events.find(e => e.event.exception);
  const terminal = events.find(e => e.event.message);
  assert.equal(failure.header.event_id, failure.event.event_id);
  assert.equal(failure.item.type, "event");
  assert.match(failure.url, /^\/prefix\/api\/7\/envelope\/\?/);
  assert.deepEqual(failure.event.exception.values, [{ type: "IOError" }]);
  assert.deepEqual(failure.event.tags, { module: "worker", component: "io", call_site: "write", code: "EIO" });
  assert.equal(failure.event.contexts.trace.trace_id, traceId);
  assert.deepEqual(failure.event.breadcrumbs, [{ category: "queued" }]);
  assert.equal(terminal.event.breadcrumbs, undefined);
  assert.equal(failure.event.release, "beta.1");
  assert.equal(failure.event.environment, "test");
  assert.deepEqual(terminal.event.tags, { module: "worker", call_site: "job" });
  assert.equal(terminal.event.level, "error");
  assert.equal(terminal.event.contexts, undefined);
  assert.ok(!JSON.stringify(events).includes(secret));
});

test("sampling, policy failures and repeated call sites drop independently", async t => {
  const { events, dsn } = await receiver(t);
  const silent = createReporter({ ...options, dsn, sampleRate: 0 });
  silent.captureMessage("ignored");
  const reporter = createReporter({ ...options, dsn, throttleMs: 60_000, redact(input) {
    if (input.message === "throw") throw Error();
    return { name: "Timeout", callSite: input.message, level: "error" };
  } });
  for (const message of ["throw", "one", "one", "two"]) reporter.captureMessage(message);
  await reporter.flush();
  assert.deepEqual(events.map(e => e.event.tags.call_site).sort(), ["one", "two"]);
});

test("bounded shutdown stops captures and can be awaited again", async t => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const { events, dsn } = await receiver(t, res => { pending.then(() => res.end()); });
  const reporter = createReporter({ ...options, dsn });
  reporter.captureMessage("first");
  assert.equal(await reporter.shutdown(5), false);
  reporter.captureMessage("after shutdown");
  finish();
  assert.equal(await reporter.shutdown(), true);
  assert.equal(events.length, 1);
});

test("transport failures stay contained and server backoff suppresses delivery", async t => {
  const { dsn, events } = await receiver(t, res => {
    res.writeHead(429, { "Retry-After": "60" });
    res.end();
  });
  const reporter = createReporter({ ...options, dsn });
  reporter.captureMessage("before");
  await reporter.flush();
  reporter.captureMessage("during backoff");
  await reporter.flush();
  assert.equal(events.length, 1);
  const offline = createReporter({ ...options, dsn: "http://key@127.0.0.1:1/1" });
  offline.captureMessage("unavailable");
  assert.equal(await offline.shutdown(), true);
});

test("10,000 logger calls, an exhausted job and a real process crash yield exactly two events", async t => {
  const { dsn, events } = await receiver(t);
  const child = spawn(process.execPath, [fileURLToPath(new URL("./fixtures/crashing-service.cjs", import.meta.url)), dsn], {
    stdio: "ignore",
  });
  assert.deepEqual(await once(child, "close"), [1, null]);
  assert.deepEqual(events.map(({ event }) => [event.level, event.tags.call_site]).sort(), [
    ["error", "job"], ["fatal", "bootstrap"],
  ]);
  assert.ok(!JSON.stringify(events).includes("private fatal error content"));
});

test("misrouted log levels and unclassified messages consume no budget", async t => {
  const { dsn, events } = await receiver(t);
  const reporter = createReporter({ ...options, dsn, dailyBudget: { handled: 1, fatal: 1 },
    redact: input => ({ name: input.message, callSite: "job", level: input.context?.level }),
  });
  for (const level of [undefined, "debug", "info", "warning", "fatal"]) {
    reporter.captureMessage("a log", { level });
  }
  reporter.captureMessage("job exhausted", { level: "error" });
  await reporter.flush();
  assert.deepEqual(events.map(({ event }) => [event.level, event.message]), [["error", "job exhausted"]]);
});

test("daily ceilings are independent of request IDs and renew after 24 hours", async t => {
  const { dsn, events } = await receiver(t);
  let now = 500;
  t.mock.method(performance, "now", () => now);
  const reporter = createReporter({ ...options, dsn, throttleMs: 10, dailyBudget: { handled: 2, fatal: 1 },
    redact: input => ({ name: "Failure", callSite: input.context.site, level: input.context.level,
      tags: { request_id: input.context.id } }),
  });
  const report = (site, level, id) => reporter.captureException(new Error(), { site, level, id });
  report("A", "error", "one");
  report("A", "error", "two");
  now += 10;
  report("A", "error", "three");
  report("B", "error", "four");
  report("A", "fatal", "five");
  report("C", "fatal", "six");
  await reporter.flush();
  assert.deepEqual(events.map(e => e.event.tags.request_id).sort(), ["five", "one", "three"]);
  assert.deepEqual(events.find(e => e.event.tags.request_id === "one").event.fingerprint,
    events.find(e => e.event.tags.request_id === "three").event.fingerprint);
  now += 86_400_000;
  report("B", "error", "seven");
  report("A", "fatal", "eight");
  await reporter.flush();
  assert.deepEqual(events.slice(3).map(e => e.event.tags.request_id).sort(), ["eight", "seven"]);
});

test("fatal exceptions bypass handled sampling and a full handled transport queue", async t => {
  const { dsn, events } = await receiver(t);
  const redact = input => ({ name: "Failure", callSite: "run", level: input.context?.level });
  const busy = createReporter({ ...options, dsn, dailyBudget: { handled: 1000, fatal: 1 }, redact });
  for (let i = 0; i < 100; i++) busy.captureException(new Error());
  busy.captureException(new Error(), { level: "fatal" });
  await busy.shutdown();
  assert.equal(events.filter(e => e.event.level === "error").length, 63);
  assert.equal(events.filter(e => e.event.level === "fatal").length, 1);
  const zero = createReporter({ ...options, dsn, sampleRate: 0, dailyBudget: { handled: 0, fatal: 1 }, redact });
  zero.captureException(new Error());
  zero.captureException(new Error(), { level: "fatal" });
  await zero.shutdown();
  assert.equal(events.length, 65);
  assert.equal(events.at(-1).event.level, "fatal");
});
