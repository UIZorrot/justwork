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

from .models import WorkspaceRecord


class DatabaseGateway:
    def __init__(self) -> None:
        self._database_url = os.getenv("JUSTWORK_DATABASE_URL", "").strip()
        self._data_file = Path(os.getenv("JUSTWORK_BACKEND_DATA_FILE", ".justwork-backend/workspaces.json"))
        self._lock = Lock()
        if self._database_url:
            self._init_schema()
        else:
            self._data_file.parent.mkdir(parents=True, exist_ok=True)
            if not self._data_file.exists():
                self._data_file.write_text("{}", encoding="utf-8")

    def _connect(self):
        import psycopg

        return psycopg.connect(self._database_url)

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

    def _file_upsert_workspace(self, record: WorkspaceRecord) -> WorkspaceRecord:
        with self._lock:
            records = self._read_file_records()
            records[record.workspace_id] = record.model_dump()
            self._write_file_records(records)
        return record
