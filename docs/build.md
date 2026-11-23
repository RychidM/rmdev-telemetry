# Reporter contract

The package targets Node 22.13+ and ships compiled CommonJS with named exports and TypeScript declarations. Relay, push-proxy and desktop use CommonJS. The aedar-cloud Node service uses ESM and already initializes Sentry. Its migration should replace the existing reporter at startup and preserve its issue webhook and alerts. Native mobile apps share the telemetry policy and use native implementations.

Create one reporter before starting the application. The application supplies its DSN, module, environment, release, handled-event sampling probability, throttle interval, separate 24-hour handled and fatal budgets, and synchronous redaction function. An absent DSN or invalid configuration selects the no-op reporter. The library reads no application environment variables and installs no process hooks.

Call sites depend on ErrorReporter, which exposes captureException and captureMessage with optional context. The owner also has flush and shutdown. A capture returns immediately after applying policy and scheduling delivery. Flush waits up to the supplied deadline for pending events. Shutdown closes admission before flushing. The owner calls shutdown in its normal shutdown path and after explicitly reporting a fatal bootstrap error, before exiting. An abrupt process kill can lose buffered events.

The redactor maps each input to an approved static identity, call site and optional string tags, code and trace ID, or returns null to drop it. It must allowlist both keys and values. Callers can supply the active 32-hex per-operation trace ID to correlate services. Never derive it from a stable user or device identifier. Policies can emit up to 20 approved breadcrumb category names per event. Only explicitly projected fields enter the adapter. Raw errors, messages, stacks, request objects, global SDK scope and automatic breadcrumbs never enter the envelope.

## Quota and capture policy

The logger handles routine operations, provider bounces, retry attempts and successful recovery. The package installs no logger bridge. A service explicitly reports an unexpected failed interactive operation or the transition of background work into operator review. For a durable job, report after its transition commits. Subsequent polling of the same state must not capture it again. An unclassified message or a policy output at debug, info or warning level is discarded. A fatal classification is accepted only for an exception.

Configure `dailyBudget.handled` and `dailyBudget.fatal` as nonnegative integers. Zero disables that category. These limits bound attempted reports for one reporter instance during a fixed 24-hour window. They reset on restart. Service owners allocate the account allowance across modules, replicas and scheduled processes at rollout. The package chooses no production allowance.

Handled events are sampled and throttled by kind, approved name and call site. Request IDs never split a throttle bucket. A full throttle table drops new handled identities until space expires. Fatal exceptions bypass handled sampling and throttling and have a reserved transport slot. Both categories respect backend rate limits. Failures in classification, initialization or delivery must leave the application running according to its own error policy.

The internal adapter uses Sentry's envelope transport. It receives only the approved event. Tests inspect actual HTTP envelopes on loopback, including cross-event isolation and rejection of raw content. Verify safety assertions by temporarily bypassing a protection and observing the test fail.

Commit dist/ alongside src/ so consumers can install from a full Git commit SHA with lifecycle scripts disabled. Keep product-specific policy, identifiers and capture points in the consuming repositories. Keep code comments limited to the API contract.
