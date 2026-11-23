"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.openTransport = openTransport;
const node_crypto_1 = require("node:crypto");
const core_1 = require("@sentry/core");
function openTransport(dsn, deployment) {
    const url = new URL(dsn);
    const project = url.pathname.split("/").pop() ?? "";
    if (!["https:", "http:"].includes(url.protocol) || !/^\w+$/.test(url.username) ||
        !/^\d+$/.test(project) || url.search || url.hash)
        throw new Error("Invalid DSN");
    const endpoint = (0, core_1.getEnvelopeEndpointWithUrlEncodedAuth)({
        protocol: url.protocol === "https:" ? "https" : "http",
        host: url.hostname, port: url.port, publicKey: url.username, pass: "",
        path: url.pathname.slice(1, url.pathname.lastIndexOf("/")), projectId: project,
    });
    const transport = (0, core_1.createTransport)({ recordDroppedEvent() { } }, async ({ body }) => {
        const response = await fetch(endpoint, {
            method: "POST", headers: { "content-type": "application/x-sentry-envelope" },
            body: typeof body === "string" ? body : Buffer.from(body),
            signal: AbortSignal.timeout(5000), redirect: "error",
        });
        await response.body?.cancel();
        return {
            statusCode: response.status,
            headers: {
                "retry-after": response.headers.get("retry-after"),
                "x-sentry-rate-limits": response.headers.get("x-sentry-rate-limits"),
            },
        };
    });
    function send(kind, identity) {
        const { name, callSite, code, traceId, level = "error" } = identity;
        if (typeof name !== "string" || !name || name.length > 200)
            return;
        if (callSite !== undefined && (typeof callSite !== "string" || !callSite || callSite.length > 200))
            return;
        if (!["info", "warning", "error", "fatal"].includes(level))
            return;
        const tags = Object.create(null);
        for (const [key, value] of Object.entries(identity.tags ?? {})) {
            if (!/^[\w.-]{1,32}$/.test(key) || typeof value !== "string" || value.length > 200)
                return;
            tags[key] = value;
        }
        tags.module = deployment.module;
        if (callSite !== undefined)
            tags.call_site = callSite;
        if (code !== undefined) {
            if (typeof code !== "string" || code.length > 200)
                return;
            tags.code = code;
        }
        const event = {
            event_id: (0, node_crypto_1.randomUUID)().replaceAll("-", ""), timestamp: Date.now() / 1000,
            platform: "node", level, tags, release: deployment.release, environment: deployment.environment,
        };
        event.fingerprint = [kind, name, callSite ?? "", code ?? ""];
        if (identity.breadcrumbs !== undefined) {
            if (!Array.isArray(identity.breadcrumbs) || identity.breadcrumbs.length > 20)
                return;
            event.breadcrumbs = [];
            for (const marker of identity.breadcrumbs) {
                if (typeof marker !== "string" || !marker || marker.length > 100)
                    return;
                event.breadcrumbs.push({ category: marker });
            }
        }
        if (traceId !== undefined) {
            if (typeof traceId !== "string" || !/^[0-9a-f]{32}$/.test(traceId) || /^0+$/.test(traceId))
                return;
            event.contexts = { trace: { trace_id: traceId, span_id: (0, node_crypto_1.randomBytes)(8).toString("hex") } };
        }
        if (kind === "exception")
            event.exception = { values: [{ type: name }] };
        else
            event.message = name;
        Promise.resolve(transport.send((0, core_1.createEventEnvelope)(event))).catch(() => { });
    }
    return { send, flush: transport.flush };
}
