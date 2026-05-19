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

From the repo root you can use:

```powershell
yarn dev:backend
```

Or:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
# edit .env if needed
uvicorn app.main:app --host 127.0.0.1 --port 1446 --reload
```

From the repo root without `cd`, PowerShell:

```powershell
$env:PYTHONPATH = (Resolve-Path .\backend).Path
python -m uvicorn app.main:app --host 127.0.0.1 --port 1446 --reload
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
uvicorn app.main:app --host 127.0.0.1 --port 1446 --reload
```

## Quota Controls (env)

The backend enforces workspace quotas on every persisted write (`create/update/move/trash/restore/hard-delete/patch`):

- Workspace payload bytes (decrypted JSON size)
- Page count (excludes system docs `root`/`welcome`)
- Folder count (excludes system docs)

Set plan via:

```powershell
$env:JUSTWORK_QUOTA_PLAN="free"  # free | pro
```

Defaults:

- Free: `40MB`, pages `300`, folders `100`
- Pro (reserved): `200MB`, pages `1500`, folders `500`

Override by setting:

- `JUSTWORK_QUOTA_WORKSPACE_MAX_BYTES_FREE|PRO`
- `JUSTWORK_QUOTA_PAGE_MAX_COUNT_FREE|PRO`
- `JUSTWORK_QUOTA_FOLDER_MAX_COUNT_FREE|PRO`
When page/folder/payload exceeds, API returns `409` with error codes:

- `workspace_quota_exceeded`
- `page_count_exceeded`
- `folder_count_exceeded`

## Current Agent Endpoints

- `GET /v1/health`
- `POST /v1/workspaces`
- `POST /v1/workspaces/{workspace_id}/tree`
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
- `PUT /v1/workspaces/{workspace_id}` legacy encrypted payload upsert

## Local Test

```powershell
yarn test:backend
yarn test:e2e:backend
```

The backend test verifies that an Agent can use only backend API/OpenAPI-facing paths to create a workspace, reject a wrong password, read the tree, create/update/pin/move/trash/restore/delete items, update profile, search/outline, and dry-run/apply patch.

`yarn test:e2e:backend` starts a real FastAPI process and a headless workbench, switches chrome storage to Backend mode, creates a workspace, saves through the plugin UI, creates a folder/page, pins, trashes, restores, hard-deletes, checks backend state, locks, and unlocks again.

## CORS

The local backend currently allows all origins so the browser extension, local dev server, and Agent tooling can call the API during development. Production deployment should replace this with a configured allowlist.
