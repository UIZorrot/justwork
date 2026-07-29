# JustWork Backend API

This backend is the primary API surface for third-party Agents.

## Security Boundary

- Browser extension, Bridge, CLI, and third-party Agents must never connect to the database directly.
- All persistent workspace reads/writes go through the backend API.
- Real database credentials stay server-side only.
- Workspace passwords are not persisted. The backend may decrypt during a request lifecycle, then re-encrypt before saving.
- Optional API auth: set `JUSTWORK_BACKEND_TOKEN` and require `Authorization: Bearer <token>`.

## Environment file

Optional: copy `.env.example` to `.env` **in this `backend/` directory**. Variables are read when the app starts (`python-dotenv`). Do not put backend secrets in the extension root `.env`.

## Local Quick Start

Local mode does not require PostgreSQL. If `JUSTWORK_DATABASE_URL` is missing, the backend stores records in `.justwork-backend/workspaces.json`.

**Import path:** the Python package is `app` under this `backend/` directory. You must run uvicorn with the **current working directory set to `backend/`** (as below), or set `PYTHONPATH` to this folder. Running `uvicorn app.main:app` from the **repository root** causes `ModuleNotFoundError: No module named 'app'`.

Install dependencies and run from this `backend/` directory:

```powershell
cd backend
uv sync
copy .env.example .env
# edit .env if needed
uv run --env-file .env -m uvicorn app.main:app --host 127.0.0.1 --port 1446 --reload
```

For a non-reloading process, for example under PM2:

```powershell
cd backend
pm2 start uv --name justwork-backend -- run --env-file .env -m uvicorn app.main:app --host 127.0.0.1 --port 1446
```

From the repo root, the same backend uv project can be started with:

```powershell
uv run --directory backend --env-file .env -m uvicorn app.main:app --host 127.0.0.1 --port 1446 --reload
```

OpenAPI:

```text
http://127.0.0.1:1446/openapi.json
http://127.0.0.1:1446/docs
```

## PostgreSQL Mode

```powershell
cd backend
$env:JUSTWORK_DATABASE_URL="postgresql://postgres:postgres@127.0.0.1:5432/justwork"
$env:JUSTWORK_BACKEND_TOKEN="change-me"
uv sync
uv run --env-file .env -m uvicorn app.main:app --host 127.0.0.1 --port 1446 --reload
```

## Quota Controls (env)

The backend enforces workspace quotas on every persisted write (`create/update/move/trash/restore/hard-delete/patch`):

- Workspace payload bytes (decrypted JSON size)
- Page count (excludes system docs `root`/`welcome`)
- Folder count (excludes system docs)

Workspace plan is stored per workspace. `JUSTWORK_QUOTA_PLAN` remains an optional
development override:

```powershell
$env:JUSTWORK_QUOTA_PLAN="free"  # free | paid
```

Defaults:

- Free: `40MB`, pages `300`, folders `100`
- Paid: exactly 4x the configured free workspace bytes by default (`160MB` with
  the default free quota), pages `1500`, folders `500`

Override by setting:

- `JUSTWORK_QUOTA_WORKSPACE_MAX_BYTES_FREE|PAID`
- `JUSTWORK_QUOTA_PAGE_MAX_COUNT_FREE|PRO`
- `JUSTWORK_QUOTA_FOLDER_MAX_COUNT_FREE|PRO`
When page/folder/payload exceeds, API returns `409` with error codes:

- `workspace_quota_exceeded`
- `page_count_exceeded`
- `folder_count_exceeded`

## Paid workspaces (Stripe)

Paid workspace creation uses Stripe-hosted Checkout. Configure an existing Stripe
Price; the backend deliberately does not create or hard-code an amount or currency:

```text
STRIPE_SECRET_KEY=sk_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_PAID_WORKSPACE_PRICE_ID=price_...
STRIPE_PAID_WORKSPACE_CHECKOUT_MODE=payment  # payment | subscription
JUSTWORK_PAID_WORKSPACE_PRICE_LABEL=$20
JUSTWORK_PUBLIC_BASE_URL=https://api.example.com
```

Send Stripe webhooks to `POST /v1/billing/stripe/webhook`. The handler verifies the
raw request body and `Stripe-Signature`, and processes Checkout and subscription
status events idempotently. A Checkout Session can provision at most one workspace.
Paid workspaces do not count toward the five-free-workspace owner limit, retain 1000
revision events, and receive at least four times the free byte quota.
When a paid workspace uses a customer-supplied PostgreSQL route, JustWork does not
enforce workspace-byte, page-count, or folder-count limits; the database provider's
own capacity limits still apply. Revision history remains capped at 1000 events.

Use the `*_PAID` quota names for new deployments. The backend still reads the old
`*_PRO` capacity/count names as a migration fallback, but paid history is fixed at
the product-supported limit of 1000 events.

Customer-supplied PostgreSQL is optional. When the field is left blank, the paid
workspace uses JustWork's default storage. To enable this optional database route,
configure a random secret of at least 32 characters:

```text
JUSTWORK_DATABASE_ROUTING_SECRET=replace-with-a-long-random-server-secret
```

The database URL is submitted only after payment, validated as PostgreSQL, encrypted
before central route storage, and never placed in Stripe metadata. The backend needs
network access to the customer database and permission to create/migrate the
`workspaces` table. Treat this feature as outbound database access and apply an
egress allowlist in production.

## Current Agent Endpoints

- `GET /v1/health`
- `GET /v1/billing/paid-workspace/config`
- `POST /v1/billing/paid-workspace/checkout`
- `GET /v1/billing/paid-workspace/checkout/{checkout_session_id}`
- `POST /v1/workspaces/paid/complete`
- `POST /v1/billing/stripe/webhook`
- `POST /v1/workspaces`
- `POST /v1/workspaces/{workspace_id}/tree`
- `POST /v1/workspaces/{workspace_id}/revisions`
- `PUT /v1/workspaces/{workspace_id}/settings`
- `GET /v1/workspaces/{workspace_id}/quota`
- `POST /v1/workspaces/{workspace_id}/items/{item_id}/share`
- `POST /v1/workspaces/{workspace_id}/items/{item_id}`
- `POST /v1/workspaces/{workspace_id}/items`
- `PUT /v1/workspaces/{workspace_id}/items/{item_id}`
- `GET /v1/workspaces/{workspace_id}/profile`
- `PUT /v1/workspaces/{workspace_id}/profile`
- `PUT /v1/workspaces/{workspace_id}/items/{item_id}/move`
- `PUT /v1/workspaces/{workspace_id}/items/{item_id}/pin`
- `PUT /v1/workspaces/{workspace_id}/items/{item_id}/trash`
- `PUT /v1/workspaces/{workspace_id}/items/{item_id}/restore`
- `POST /v1/workspaces/{workspace_id}/items/{item_id}/hard-delete`
- `POST /v1/workspaces/{workspace_id}/search`
- `POST /v1/workspaces/{workspace_id}/items/{item_id}/outline`
- `POST /v1/workspaces/{workspace_id}/items/{item_id}/patch`
- `GET /shares/{token}` readonly share page (password required)
- `POST /v1/shares/{token}/view` resolve shared document by workspace password
- `GET /v1/workspaces/{workspace_id}` legacy encrypted payload fetch
- `PUT /v1/workspaces/{workspace_id}` disabled legacy whole-workspace replacement (`410`)

Every item mutation requires `expected_revision`. Workspace settings use
`workspace_revision` from the tree response, and member profile writes use the
member's `revision`. A stale revision returns `409`; a missing revision returns
`428`. Clients must re-read and either apply an explicit inverse operation or merge
page text through the collaborative state. The backend does not expose history
rewriting or rebase operations. Hard-delete only accepts items already in trash.

Real-time relay rooms and CRDT snapshots currently support one backend process/replica.
Do not enable multiple uvicorn workers or horizontally scale this service until the
relay is moved to shared pub/sub and shared snapshot storage. Workspace writes in
PostgreSQL remain CAS-protected, but process-local WebSocket fan-out is not a
multi-replica transport.

## Local Test

```powershell
yarn test:backend
yarn test:e2e:backend
```

The backend test verifies that an Agent can use only backend API/OpenAPI-facing paths to create a workspace, reject a wrong password, read the tree, create/update/pin/move/trash/restore/delete items, update profile, search/outline, and dry-run/apply patch.

`yarn test:e2e:backend` starts a real FastAPI process and two headless workbenches, verifies bidirectional page collaboration and merged persistence, then covers create/pin/trash/restore/hard-delete, lock, and unlock flows.

## CORS

The local backend currently allows all origins so the browser extension, local dev server, and Agent tooling can call the API during development. Production deployment should replace this with a configured allowlist.
