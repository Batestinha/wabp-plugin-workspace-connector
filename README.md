# Workspace Connector

Connect WABP scopes to a compatible workspace using the versioned workspace protocol, command aliases, durable sessions, staged media and delivery receipts.

Standalone WABS package `official.workspace-connector` version `0.6.1`, requiring WABP core API `^0.3.0`. Existing plugin IDs, scoped settings, allowed capabilities, session keys, actor bindings, media references and receipt formats remain unchanged. Deployment connection settings are supplied by the host. This repository contains no deployment credentials.

The package includes the SDK, Zod, Portuguese translations and the unmodified v1/v2 workspace protocol contract. Its upstream commit, checksum and license are recorded in `contracts/provenance.json`; packaging rejects contract drift. WABP owns scoped storage, media staging, authentication configuration, transport authorization and job persistence.

Install through a trusted WABS registry entry. Installation and scope enablement are separate operations. Exact package checksums and publisher signatures establish artifact identity.

Run `npm ci --ignore-scripts`, `npm test`, then `npm run release:archive`. Tests use fixture identifiers, in-memory storage and mocked network requests. CI checks Node22.23.2 and24.15.0, reproducible archives and execution outside the repository.

`provenance.json` records imported source history and the exact SDK archive. Runtime dependencies retain their licenses. No host database, queue implementation or application runtime is included.
