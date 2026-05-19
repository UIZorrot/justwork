"""
Single database access gateway.

Rule:
- Plugin / Bridge / CLI / external agents never touch DB directly.
- All persistence must pass through this module.
"""

import os
import json
from pathlib import Path
from threading import Lock
from typing import Optional
from contextlib import contextmanager

from .models import WorkspaceRecord


class DatabaseUnavailableError(RuntimeError):
    """Raised when the database transport is temporarily unavailable."""


class DatabaseGateway:
    def __init__(self) -> None:
        self._database_url = os.getenv("JUSTWORK_DATABASE_URL", "").strip()
        self._data_file = Path(os.getenv("JUSTWORK_BACKEND_DATA_FILE", ".justwork-backend/workspaces.json"))
        self._lock = Lock()
        self._pool = None
        if self._database_url:
            self._pool = self._create_pool()
            self._init_schema()
        else:
            self._data_file.parent.mkdir(parents=True, exist_ok=True)
            if not self._data_file.exists():
                self._data_file.write_text("{}", encoding="utf-8")

    def _create_pool(self):
        from psycopg_pool import ConnectionPool

        connect_timeout = max(1, int(os.getenv("JUSTWORK_DB_CONNECT_TIMEOUT_SECONDS", "5")))
        pool_timeout = max(1, int(os.getenv("JUSTWORK_DB_POOL_TIMEOUT_SECONDS", "5")))
        min_size = max(1, int(os.getenv("JUSTWORK_DB_POOL_MIN_SIZE", "1")))
        max_size = max(min_size, int(os.getenv("JUSTWORK_DB_POOL_MAX_SIZE", "5")))
        pool = ConnectionPool(
            conninfo=self._database_url,
            min_size=min_size,
            max_size=max_size,
            timeout=pool_timeout,
            kwargs={
                "connect_timeout": connect_timeout,
                "prepare_threshold": None,
            },
            open=True,
        )
        try:
            pool.wait()
        except Exception as exc:  # noqa: BLE001
            raise DatabaseUnavailableError("database unavailable") from exc
        return pool

    @contextmanager
    def _connect(self):
        if self._pool is None:
            raise DatabaseUnavailableError("database unavailable")
        try:
            with self._pool.connection() as conn:
                yield conn
        except Exception as exc:  # noqa: BLE001
            try:
                self._pool.check()
            except Exception:  # noqa: BLE001
                pass
            raise DatabaseUnavailableError("database unavailable") from exc

    def _init_schema(self) -> None:
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS workspaces (
                      workspace_id TEXT PRIMARY KEY,
                      owner_user_id TEXT NOT NULL,
                      owner_nickname TEXT NOT NULL DEFAULT '',
                      encrypted_payload TEXT NOT NULL,
                      updated_at TEXT NOT NULL
                    )
                    """
                )
                cur.execute("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_nickname TEXT NOT NULL DEFAULT ''")
            conn.commit()

    def get_workspace(self, workspace_id: str) -> Optional[WorkspaceRecord]:
        if not self._database_url:
            return self._file_get_workspace(workspace_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT workspace_id, owner_user_id, owner_nickname, encrypted_payload, updated_at
                    FROM workspaces
                    WHERE workspace_id = %s
                    """,
                    (workspace_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                return WorkspaceRecord(
                    workspace_id=row[0],
                    owner_user_id=row[1],
                    owner_nickname=row[2],
                    encrypted_payload=row[3],
                    updated_at=row[4],
                )

    def count_workspaces_by_owner(self, owner_user_id: str) -> int:
        if not self._database_url:
            return self._file_count_workspaces_by_owner(owner_user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT COUNT(*)
                    FROM workspaces
                    WHERE owner_user_id = %s
                    """,
                    (owner_user_id,),
                )
                row = cur.fetchone()
                return int(row[0]) if row else 0

    def insert_workspace_with_owner_limit(self, record: WorkspaceRecord, max_workspaces: int) -> WorkspaceRecord | None:
        if not self._database_url:
            return self._file_insert_workspace_with_owner_limit(record, max_workspaces)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_xact_lock(hashtext(%s))", (record.owner_user_id,))
                cur.execute(
                    """
                    SELECT COUNT(*)
                    FROM workspaces
                    WHERE owner_user_id = %s
                    """,
                    (record.owner_user_id,),
                )
                row = cur.fetchone()
                if row and int(row[0]) >= max_workspaces:
                    conn.rollback()
                    return None
                cur.execute(
                    """
                    INSERT INTO workspaces (workspace_id, owner_user_id, owner_nickname, encrypted_payload, updated_at)
                    VALUES (%s, %s, %s, %s, %s)
                    """,
                    (
                        record.workspace_id,
                        record.owner_user_id,
                        record.owner_nickname,
                        record.encrypted_payload,
                        record.updated_at,
                    ),
                )
            conn.commit()
        return record

    def upsert_workspace(self, record: WorkspaceRecord) -> WorkspaceRecord:
        if not self._database_url:
            return self._file_upsert_workspace(record)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO workspaces (workspace_id, owner_user_id, owner_nickname, encrypted_payload, updated_at)
                    VALUES (%s, %s, %s, %s, %s)
                    ON CONFLICT (workspace_id) DO UPDATE
                    SET owner_user_id = EXCLUDED.owner_user_id,
                        owner_nickname = EXCLUDED.owner_nickname,
                        encrypted_payload = EXCLUDED.encrypted_payload,
                        updated_at = EXCLUDED.updated_at
                    """,
                    (
                        record.workspace_id,
                        record.owner_user_id,
                        record.owner_nickname,
                        record.encrypted_payload,
                        record.updated_at,
                    ),
                )
            conn.commit()
        return record

    def _read_file_records(self) -> dict:
        return json.loads(self._data_file.read_text(encoding="utf-8"))

    def _write_file_records(self, records: dict) -> None:
        self._data_file.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")

    def _file_get_workspace(self, workspace_id: str) -> Optional[WorkspaceRecord]:
        with self._lock:
            data = self._read_file_records().get(workspace_id)
        return WorkspaceRecord(**data) if data else None

    def _file_count_workspaces_by_owner(self, owner_user_id: str) -> int:
        with self._lock:
            records = self._read_file_records().values()
            return sum(1 for record in records if record.get("owner_user_id") == owner_user_id)

    def _file_insert_workspace_with_owner_limit(
        self,
        record: WorkspaceRecord,
        max_workspaces: int,
    ) -> WorkspaceRecord | None:
        with self._lock:
            records = self._read_file_records()
            owned_count = sum(1 for entry in records.values() if entry.get("owner_user_id") == record.owner_user_id)
            if owned_count >= max_workspaces:
                return None
            records[record.workspace_id] = record.model_dump()
            self._write_file_records(records)
        return record

    def _file_upsert_workspace(self, record: WorkspaceRecord) -> WorkspaceRecord:
        with self._lock:
            records = self._read_file_records()
            records[record.workspace_id] = record.model_dump()
            self._write_file_records(records)
        return record
