import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";
import { createReporter, noopReporter } from "@rmdev/telemetry";

const options = {
  module: "worker", release: "beta.1", environment: "test", sampleRate: 1, throttleMs: 0,
  redact: () => ({ name: "service.failed" }),
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
    { ...options, dsn: "https://key@invalid.test/1", sampleRate: NaN }]) {
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
    if (input.kind === "message") return input.message === "retry" ? { name: "retry", level: "warning" } : null;
    return {
      name: "IOError", code: "EIO", callSite: "write", traceId, breadcrumbs: ["queued"], tags: { component: "io" },
      extra: input.context, stack: input.error.stack, request: { url: secret },
    };
  } });
  reporter.captureException(new Error(secret), { password: secret });
  reporter.captureMessage("retry", { private: secret });
  reporter.captureMessage(secret);
  assert.equal(await reporter.shutdown(), true);
  reporter.captureMessage("retry");
  assert.equal(events.length, 2);
  const failure = events.find(e => e.event.exception);
  const warning = events.find(e => e.event.message);
  assert.equal(failure.header.event_id, failure.event.event_id);
  assert.equal(failure.item.type, "event");
  assert.match(failure.url, /^\/prefix\/api\/7\/envelope\/\?/);
  assert.deepEqual(failure.event.exception.values, [{ type: "IOError" }]);
  assert.deepEqual(failure.event.tags, { module: "worker", component: "io", call_site: "write", code: "EIO" });
  assert.equal(failure.event.contexts.trace.trace_id, traceId);
  assert.deepEqual(failure.event.breadcrumbs, [{ category: "queued" }]);
  assert.equal(warning.event.breadcrumbs, undefined);
  assert.equal(failure.event.release, "beta.1");
  assert.equal(failure.event.environment, "test");
  assert.deepEqual(warning.event.tags, { module: "worker" });
  assert.equal(warning.event.level, "warning");
  assert.equal(warning.event.contexts, undefined);
  assert.ok(!JSON.stringify(events).includes(secret));
});

test("sampling, policy failures and repeated call sites drop independently", async t => {
  const { events, dsn } = await receiver(t);
  const silent = createReporter({ ...options, dsn, sampleRate: 0 });
  silent.captureMessage("ignored");
  const reporter = createReporter({ ...options, dsn, throttleMs: 60_000, redact(input) {
    if (input.message === "throw") throw Error();
    return { name: "Timeout", callSite: input.message };
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
