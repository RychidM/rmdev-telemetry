"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.noopReporter = void 0;
exports.createReporter = createReporter;
const transport_1 = require("./transport");
exports.noopReporter = Object.freeze({
    captureException() { },
    captureMessage() { },
    async flush() { return true; },
    async shutdown() { return true; },
});
function createReporter(options) {
    try {
        if (!options?.dsn)
            return exports.noopReporter;
        const { module, release, environment, sampleRate, throttleMs, redact } = options;
        const { handled, fatal } = options.dailyBudget;
        if (![handled, fatal].every(limit => Number.isSafeInteger(limit) && limit >= 0))
            return exports.noopReporter;
        if (![module, release, environment].every(isLabel) || typeof redact !== "function" ||
            !Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1 ||
            !Number.isSafeInteger(throttleMs) || throttleMs < 0)
            return exports.noopReporter;
        const transport = (0, transport_1.openTransport)(options.dsn, { module, release, environment });
        const recent = new Map();
        const dayMs = 24 * 60 * 60 * 1000;
        let resetAt = performance.now() + dayMs;
        let remainingHandled = handled;
        let remainingFatal = fatal;
        let closed = false;
        function capture(input) {
            try {
                if (closed)
                    return;
                const identity = redact(input);
                if (identity instanceof Promise) {
                    void identity.catch(() => { });
                    return;
                }
                if (!identity)
                    return;
                const { name, callSite, level } = identity;
                if (!isLabel(name) || !isLabel(callSite))
                    return;
                if (input.kind === "message" && level !== "error")
                    return;
                if (level !== undefined && level !== "error" && level !== "fatal")
                    return;
                const now = performance.now();
                if (now >= resetAt) {
                    resetAt = now + dayMs;
                    remainingHandled = handled;
                    remainingFatal = fatal;
                }
                const isFatal = level === "fatal";
                let key;
                if (isFatal) {
                    if (!remainingFatal)
                        return;
                }
                else {
                    if (!remainingHandled || Math.random() >= sampleRate)
                        return;
                    if (throttleMs > 0) {
                        for (const [entry, expiry] of recent) {
                            if (expiry > now)
                                break;
                            recent.delete(entry);
                        }
                        key = JSON.stringify([input.kind, name, callSite]);
                        if (recent.has(key) || recent.size >= 1024)
                            return;
                    }
                }
                const queued = transport.send(input.kind, {
                    name, callSite, level, code: identity.code, tags: identity.tags,
                    traceId: identity.traceId, breadcrumbs: identity.breadcrumbs,
                });
                if (!queued)
                    return;
                if (isFatal)
                    remainingFatal--;
                else
                    remainingHandled--;
                if (key !== undefined)
                    recent.set(key, now + throttleMs);
            }
            catch {
                // Discard events that cannot be classified or queued.
            }
        }
        async function flush(timeoutMs = 2000) {
            try {
                if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2147483647)
                    return false;
                return await transport.flush(timeoutMs);
            }
            catch {
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
    }
    catch {
        return exports.noopReporter;
    }
}
function isLabel(value) {
    return typeof value === "string" && value.length > 0 && value.length <= 200;
}
