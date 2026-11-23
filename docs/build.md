# Reporter contract

The package targets Node 22.13+ and ships compiled CommonJS with named exports and TypeScript declarations. Relay, push-proxy and desktop use CommonJS. The aedar-cloud Node service uses ESM and already initializes Sentry. Its migration should replace the existing reporter at startup and preserve its issue webhook and alerts. Native mobile apps share the telemetry policy and use native implementations.

Create one reporter before starting the application. The application supplies its DSN, module, environment, release, sampling probability, throttle interval and synchronous redaction function. An absent DSN or invalid configuration selects the no-op reporter. The library reads no application environment variables and installs no process hooks.

Call sites depend on ErrorReporter, which exposes captureException and captureMessage with optional context. The owner also has flush and shutdown. A capture returns immediately after applying policy and scheduling delivery. Flush waits up to the supplied deadline for pending events. Shutdown closes admission before flushing. The owner calls shutdown in its normal shutdown path and after explicitly reporting a fatal bootstrap error, before exiting. An abrupt process kill can lose buffered events.

The redactor maps each input to an approved static identity and optional string tags, code and trace ID, or returns null to drop it. It must allowlist both keys and values. Callers can supply the active 32-hex per-operation trace ID to correlate services. Never derive it from a stable user or device identifier. Policies can emit up to 20 approved breadcrumb category names per event. Only explicitly projected fields enter the adapter. Raw errors, messages, stacks, request objects, global SDK scope and automatic breadcrumbs never enter the envelope.

Sampling precedes a bounded, per-reporter throttle keyed on event kind, approved identity and call site. A busy reporter drops new identities when its throttle table is full. Backend rate limits and pending requests are bounded independently. Failures in configuration, policy or delivery must never interrupt application code.

The internal adapter uses Sentry's envelope transport. It receives only the approved event. Tests inspect actual HTTP envelopes on loopback, including cross-event isolation and rejection of raw content. Verify safety assertions by temporarily bypassing a protection and observing the test fail.

Commit dist/ alongside src/ so consumers can install from a full Git commit SHA with lifecycle scripts disabled. Keep product-specific policy, identifiers and capture points in the consuming repositories. Keep code comments limited to the API contract.
