# Workspace Connector

Connect WABP scopes to a compatible workspace using the versioned workspace protocol, command aliases, durable sessions, staged media and delivery receipts.

Standalone WABS package `official.workspace-connector` version `0.8.2`, requiring WABP core API `^0.3.9`. Existing plugin IDs, scoped settings, allowed capabilities, session keys, actor bindings, media references and receipt formats remain unchanged. Deployment connection settings are supplied by the host. This repository contains no deployment credentials.

The package includes the SDK, Zod, Portuguese translations and the unmodified v1/v2 workspace protocol contract. Its upstream commit, checksum and license are recorded in `contracts/provenance.json`; packaging rejects contract drift. WABP owns scoped storage, media staging, authentication configuration, transport authorization and job persistence.

Install through a trusted WABS registry entry. Installation and scope enablement are separate operations. Exact package checksums and publisher signatures establish artifact identity.

Run `npm ci --ignore-scripts`, `npm test`, then `npm run release:archive`. Tests use fixture identifiers, in-memory storage and mocked network requests. CI checks Node22.23.2 and24.15.0, reproducible archives and execution outside the repository.

`provenance.json` records imported source history and the exact SDK archive. Runtime dependencies retain their licenses. No host database, queue implementation or application runtime is included.

In the operator console, open Workspace Connector settings in the account's
Global scope when present, or its existing enabled connector scope, and use `Sign-in codes` to enable sending the OTP on its own before
an explanatory message that quotes it. Optional sign-in and password-recovery
explanations override localized defaults. When no Global scope exists, all enabled connector scopes must agree on these
account-wide private authentication settings. Conflicts reject delivery before a code is sent. The default keeps the existing combined
message. Requires WABP core API 0.3.9 or later; the host continues to enforce the
sensitive delivery endpoint's acknowledgement, deadline, replay, and privacy rules.


Version 0.8.0 supports neutral server-initiated private sessions (`start_session`)
using the Workspace 0.4.0 contract. Delivery polling advertises the current
per-scope capability allowlist. A session starts only for a current managed-scope
member and an enabled, authenticated interactive capability. It never replaces
an existing conversation. Continuations use the sender's current stable identity
and verified phone number, and refresh membership evidence.

Version 0.8.1 polls v2 deliveries directly when the v2 catalog is installed;
installations without a v2 catalog retain the legacy v1 delivery path.

Version 0.8.2 gives private Workspace prompts to WABP FlowEngine. Human choices
and following text questions stay bound to the current identity, runtime and
remote session; failed callbacks retain their durable choice lock for retry.
Prompt delivery and reply receipts prevent duplicate sends and completed-session
reopening. On activation, unexpired private sessions from older versions are
re-presented after transport readiness, asking the user to review the previous
request; no previous answer is replayed. Cancellation also closes the owned prompt.
Deploy with WABP's recoverable prompt reply-ownership fix so additional replies
while a callback is retrying remain with FlowEngine.
