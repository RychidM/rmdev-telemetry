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
        if (![module, release, environment].every(isLabel) || typeof redact !== "function" ||
            !Number.isFinite(sampleRate) || sampleRate < 0 || sampleRate > 1 ||
            !Number.isSafeInteger(throttleMs) || throttleMs < 0)
            return exports.noopReporter;
        const transport = (0, transport_1.openTransport)(options.dsn, { module, release, environment });
        const recent = new Map();
        let closed = false;
        function capture(input) {
            try {
                if (closed || Math.random() >= sampleRate)
                    return;
                const identity = redact(input);
                if (identity instanceof Promise) {
                    void identity.catch(() => { });
                    return;
                }
                if (!identity || !isLabel(identity.name))
                    return;
                if (identity.callSite !== undefined && !isLabel(identity.callSite))
                    return;
                if (throttleMs > 0) {
                    const now = performance.now();
                    for (const [key, expiry] of recent) {
                        if (expiry > now)
                            break;
                        recent.delete(key);
                    }
                    const key = JSON.stringify([input.kind, identity.name, identity.callSite]);
                    if (recent.has(key) || recent.size >= 1024)
                        return;
                    recent.set(key, now + throttleMs);
                }
                transport.send(input.kind, identity);
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
