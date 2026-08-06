# Technical backlog

This file records accepted technical work that is important but does not block the current release.

## Deferred encryption work

The current backend provides password-derived AES-GCM encryption at rest for the workspace JSON payload and persisted Yjs snapshots/updates. It is not end-to-end or zero-knowledge encryption because workspace passwords and plaintext content are available to the backend during a request.

- Encrypt archived image bytes and metadata at rest.
- Encrypt local drafts, offline mutation payloads, Yjs recovery snapshots, cached assets, and local identity private keys.
- Stop storing remembered workspace passwords as plaintext browser/extension storage values, or clearly limit the feature to an explicitly accepted device-risk mode.
- Require production secrets at startup. In particular, production must not use the development share-secret fallback.
- Version and strengthen password KDF parameters while preserving migration compatibility.
- Decide whether the product promise is encrypted-at-rest or true browser-side E2EE; do not claim zero knowledge with the current server-side search and Agent API design.
- If E2EE is selected, add per-member wrapped workspace keys, revocation, password/key rotation, and encrypted collaboration frames.
- Make signed writes mandatory where identity-based authorization is expected, and move replay protection to shared durable storage for multi-instance deployments.

## Event-driven performance work

The durable database event tables remain the recovery source of truth. Event delivery should wake consumers; it must not replace durability.

### P0: remove avoidable full workspace reads

- Do not fetch the full tree after a successful local mutation when the mutation response already contains the canonical changed item.
- Add `workspace_revision`, changed item IDs, and the minimal canonical structural result to mutation responses.
- Attach an origin session or mutation ID to invalidations so a client can ignore the invalidation caused by its own already-applied operation.
- Replace generic `workspace.invalidated` handling with typed structural/member/settings events. Fetch only an affected item when a payload cannot safely carry the full delta.
- Keep a full-tree reconciliation only for reconnect, visibility resume, detected revision gaps, and a very low-frequency safety audit.

### P0: replace per-WebSocket database polling

- Use PostgreSQL `LISTEN/NOTIFY` (or a dedicated pub/sub service) only as a wake-up signal.
- Continue writing collaborative and workspace events transactionally before notifying; after wake-up, consume the durable event cursor.
- Maintain one listener per backend process and multiplex notifications to local workspace/room subscribers instead of polling once per connected WebSocket.
- Use a dedicated PostgreSQL session for `LISTEN`; transaction-pooling proxies cannot safely host a persistent listener.
- On listener reconnect, resume from durable cursors so dropped notifications cannot lose updates.

### P1: make frontend background work demand-driven

- Replace the 500 ms collaboration retry interval with one timer scheduled for the nearest unacknowledged update deadline. Arm it only while pending updates exist and re-arm on ACK/socket-open.
- Derive health state from request failures, `online`/`offline`, WebSocket open/close, focus, and visibility events. Retain a slow health probe only when no live transport exists.
- Observe `chrome.storage.onChanged` in the extension and the `storage` event or `BroadcastChannel` on the web build for cross-view offline queue, draft, identity, and settings changes.
- Pause all nonessential reconciliation while hidden and perform one coalesced refresh after visibility resumes.
- Treat editor render, autosave batching, table emission, and snapshot timers as event debounces rather than polling; retain them unless profiling identifies a measurable hot path.

### Verification

- Add counters for tree reads, item reads, quota reads, workspace-event queries, collaborative-event queries, writes, and WebSocket fanout.
- Test idle workspaces, active typing, multi-tab use, multi-worker use, listener reconnect, missed notification recovery, and long hidden-tab resume.
- Set measurable budgets for database queries per idle client and per edit burst before removing the recovery polling path.
