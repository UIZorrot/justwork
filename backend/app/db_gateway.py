"""
Single database access gateway.

Rule:
- Plugin / Bridge / CLI / external agents never touch DB directly.
- All persistence must pass through this module.
"""

from __future__ import annotations

import os
import json
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Callable, Optional, TypeVar
from contextlib import contextmanager

from .database_routing import decrypt_database_url
from .models import PaidCheckoutRecord, WorkspaceRecord, WorkspaceRouteRecord


T = TypeVar("T")


@dataclass(frozen=True)
class CollaborativeRoomRecord:
    workspace_id: str
    item_id: str
    room_epoch: str
    snapshot: bytes | None
    version: int
    bootstrap_lease_until: float
    snapshot_version: int = 0
    updates: tuple[tuple[int, bytes], ...] = ()


@dataclass(frozen=True)
class CollaborativeRoomMutation:
    room_epoch: str | None
    snapshot: bytes | None
    bootstrap_lease_until: float
    result: Any
    persist: bool = True
    update_payload: bytes | None = None
    compact: bool = True
    update_id: str | None = None
    event_payload: bytes | None = None


@dataclass(frozen=True)
class CollaborativeEventRecord:
    event_id: int
    room_epoch: str
    room_version: int
    update_id: str
    payload: bytes


class DatabaseUnavailableError(RuntimeError):
    """Raised when the database transport is temporarily unavailable."""


class DatabaseGateway:
    def __init__(
        self,
        *,
        database_url: str | None = None,
        data_file: Path | None = None,
        routing_enabled: bool = True,
    ) -> None:
        self._database_url = (database_url if database_url is not None else os.getenv("JUSTWORK_DATABASE_URL", "")).strip()
        self._data_file = data_file or Path(os.getenv("JUSTWORK_BACKEND_DATA_FILE", ".justwork-backend/workspaces.json"))
        self._control_file = self._data_file.with_name(f"{self._data_file.stem}.control.json")
        self._routing_enabled = routing_enabled
        self._route_gateways: dict[str, DatabaseGateway] = {}
        self._lock = Lock()
        self._pool = None
        self._transaction_connection: ContextVar[Any | None] = ContextVar(
            f"justwork_transaction_connection_{id(self)}", default=None
        )
        self._after_commit_hooks: ContextVar[list[Callable[[], None]] | None] = ContextVar(
            f"justwork_after_commit_hooks_{id(self)}", default=None
        )
        if self._database_url:
            self._pool = self._create_pool()
            self._init_schema()
        else:
            self._data_file.parent.mkdir(parents=True, exist_ok=True)
            if not self._data_file.exists():
                self._data_file.write_text("{}", encoding="utf-8")
            if self._routing_enabled and not self._control_file.exists():
                self._control_file.write_text(
                    json.dumps({"paid_checkouts": {}, "workspace_routes": {}, "stripe_events": []}, indent=2),
                    encoding="utf-8",
                )

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
                      updated_at TEXT NOT NULL,
                      plan TEXT NOT NULL DEFAULT 'free',
                      billing_status TEXT NOT NULL DEFAULT 'free',
                      stripe_customer_id TEXT,
                      stripe_subscription_id TEXT
                    )
                    """
                )
                cur.execute("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS owner_nickname TEXT NOT NULL DEFAULT ''")
                cur.execute("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'free'")
                cur.execute("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS billing_status TEXT NOT NULL DEFAULT 'free'")
                cur.execute("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT")
                cur.execute("ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT")
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS collaborative_rooms (
                      workspace_id TEXT NOT NULL,
                      item_id TEXT NOT NULL,
                      room_epoch TEXT NOT NULL,
                      snapshot BYTEA,
                      version BIGINT NOT NULL DEFAULT 0,
                      snapshot_version BIGINT NOT NULL DEFAULT 0,
                      bootstrap_lease_until DOUBLE PRECISION NOT NULL DEFAULT 0,
                      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                      PRIMARY KEY (workspace_id, item_id)
                    )
                    """
                )
                cur.execute(
                    "ALTER TABLE collaborative_rooms ADD COLUMN IF NOT EXISTS snapshot_version BIGINT NOT NULL DEFAULT 0"
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS collaborative_updates (
                      workspace_id TEXT NOT NULL,
                      item_id TEXT NOT NULL,
                      room_epoch TEXT NOT NULL,
                      room_version BIGINT NOT NULL,
                      payload BYTEA NOT NULL,
                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                      PRIMARY KEY (workspace_id, item_id, room_version)
                    )
                    """
                )
                cur.execute(
                    "CREATE INDEX IF NOT EXISTS collaborative_updates_room_idx "
                    "ON collaborative_updates (workspace_id, item_id, room_version)"
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS collaborative_update_receipts (
                      workspace_id TEXT NOT NULL,
                      item_id TEXT NOT NULL,
                      update_id TEXT NOT NULL,
                      room_epoch TEXT NOT NULL,
                      room_version BIGINT NOT NULL,
                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
                      PRIMARY KEY (workspace_id, item_id, update_id)
                    )
                    """
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS collaborative_events (
                      event_id BIGSERIAL PRIMARY KEY,
                      workspace_id TEXT NOT NULL,
                      item_id TEXT NOT NULL,
                      room_epoch TEXT NOT NULL,
                      room_version BIGINT NOT NULL,
                      update_id TEXT NOT NULL,
                      payload BYTEA NOT NULL,
                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                cur.execute(
                    "CREATE INDEX IF NOT EXISTS collaborative_events_room_idx "
                    "ON collaborative_events (workspace_id, item_id, event_id)"
                )
                cur.execute(
                    """
                    CREATE TABLE IF NOT EXISTS workspace_events (
                      event_id BIGSERIAL PRIMARY KEY,
                      workspace_id TEXT NOT NULL,
                      event_type TEXT NOT NULL,
                      payload JSONB NOT NULL,
                      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                    )
                    """
                )
                cur.execute(
                    "CREATE INDEX IF NOT EXISTS workspace_events_workspace_idx "
                    "ON workspace_events (workspace_id, event_id)"
                )
                if self._routing_enabled:
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS paid_workspace_checkouts (
                          purchase_token TEXT PRIMARY KEY,
                          owner_user_id TEXT NOT NULL,
                          checkout_session_id TEXT NOT NULL UNIQUE,
                          status TEXT NOT NULL,
                          stripe_customer_id TEXT,
                          stripe_subscription_id TEXT,
                          consumed_workspace_id TEXT,
                          created_at TEXT NOT NULL,
                          updated_at TEXT NOT NULL
                        )
                        """
                    )
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS workspace_routes (
                          workspace_id TEXT PRIMARY KEY,
                          owner_user_id TEXT NOT NULL,
                          plan TEXT NOT NULL,
                          billing_status TEXT NOT NULL,
                          stripe_customer_id TEXT,
                          stripe_subscription_id TEXT,
                          database_url_ciphertext TEXT,
                          updated_at TEXT NOT NULL
                        )
                        """
                    )
                    cur.execute(
                        """
                        CREATE TABLE IF NOT EXISTS stripe_webhook_events (
                          event_id TEXT PRIMARY KEY,
                          processed_at TEXT NOT NULL
                        )
                        """
                    )
            conn.commit()

    @staticmethod
    def _workspace_from_row(row) -> WorkspaceRecord:
        return WorkspaceRecord(
            workspace_id=row[0],
            owner_user_id=row[1],
            owner_nickname=row[2],
            encrypted_payload=row[3],
            updated_at=row[4],
            plan=row[5] or "free",
            billing_status=row[6] or "free",
            stripe_customer_id=row[7],
            stripe_subscription_id=row[8],
        )

    def _workspace_route(self, workspace_id: str) -> WorkspaceRouteRecord | None:
        if not self._routing_enabled:
            return None
        return self.get_workspace_route(workspace_id)

    def _routed_gateway(self, route: WorkspaceRouteRecord | None) -> DatabaseGateway | None:
        if route is None or not route.database_url_ciphertext:
            return None
        cached = self._route_gateways.get(route.workspace_id)
        if cached is not None:
            return cached
        database_url = decrypt_database_url(route.database_url_ciphertext)
        gateway = DatabaseGateway(database_url=database_url, routing_enabled=False)
        self._route_gateways[route.workspace_id] = gateway
        return gateway

    @staticmethod
    def _apply_route_metadata(record: WorkspaceRecord, route: WorkspaceRouteRecord | None) -> WorkspaceRecord:
        if route is None:
            return record
        return record.model_copy(
            update={
                "plan": route.plan,
                "billing_status": route.billing_status,
                "stripe_customer_id": route.stripe_customer_id,
                "stripe_subscription_id": route.stripe_subscription_id,
                "custom_database": bool(route.database_url_ciphertext),
            }
        )

    def get_workspace(self, workspace_id: str) -> Optional[WorkspaceRecord]:
        route = self._workspace_route(workspace_id)
        routed = self._routed_gateway(route)
        if routed is not None:
            record = routed.get_workspace(workspace_id)
            return self._apply_route_metadata(record, route) if record else None
        if not self._database_url:
            record = self._file_get_workspace(workspace_id)
            return self._apply_route_metadata(record, route) if record else None
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT workspace_id, owner_user_id, owner_nickname, encrypted_payload, updated_at,
                           plan, billing_status, stripe_customer_id, stripe_subscription_id
                    FROM workspaces
                    WHERE workspace_id = %s
                    """,
                    (workspace_id,),
                )
                row = cur.fetchone()
                if row is None:
                    return None
                return self._apply_route_metadata(self._workspace_from_row(row), route)

    def count_workspaces_by_owner(self, owner_user_id: str) -> int:
        if not self._database_url:
            return self._file_count_workspaces_by_owner(owner_user_id)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT COUNT(*)
                    FROM workspaces
                    WHERE owner_user_id = %s AND plan = 'free'
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
                    WHERE owner_user_id = %s AND plan = 'free'
                    """,
                    (record.owner_user_id,),
                )
                row = cur.fetchone()
                if row and int(row[0]) >= max_workspaces:
                    conn.rollback()
                    return None
                cur.execute(
                    """
                    INSERT INTO workspaces (
                      workspace_id, owner_user_id, owner_nickname, encrypted_payload, updated_at,
                      plan, billing_status, stripe_customer_id, stripe_subscription_id
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    """,
                    (
                        record.workspace_id,
                        record.owner_user_id,
                        record.owner_nickname,
                        record.encrypted_payload,
                        record.updated_at,
                        record.plan,
                        record.billing_status,
                        record.stripe_customer_id,
                        record.stripe_subscription_id,
                    ),
                )
            conn.commit()
        return record

    def insert_workspace(self, record: WorkspaceRecord) -> WorkspaceRecord:
        if not self._database_url:
            return self._file_insert_workspace(record)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO workspaces (
                      workspace_id, owner_user_id, owner_nickname, encrypted_payload, updated_at,
                      plan, billing_status, stripe_customer_id, stripe_subscription_id
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (workspace_id) DO NOTHING
                    """,
                    (
                        record.workspace_id,
                        record.owner_user_id,
                        record.owner_nickname,
                        record.encrypted_payload,
                        record.updated_at,
                        record.plan,
                        record.billing_status,
                        record.stripe_customer_id,
                        record.stripe_subscription_id,
                    ),
                )
            conn.commit()
        return record

    def insert_paid_workspace(
        self,
        record: WorkspaceRecord,
        route: WorkspaceRouteRecord,
    ) -> WorkspaceRecord:
        # Persist routing first. If the customer database is temporarily
        # unavailable, the same claimed Checkout Session can safely retry and
        # resolve the intended target instead of orphaning a workspace elsewhere.
        self.save_workspace_route(route)
        routed = self._routed_gateway(route)
        target = routed or self
        target.insert_workspace(record)
        if routed is not None:
            self._route_gateways[route.workspace_id] = routed
        return record

    def upsert_workspace(self, record: WorkspaceRecord) -> WorkspaceRecord:
        routed = self._routed_gateway(self._workspace_route(record.workspace_id))
        if routed is not None:
            return routed.upsert_workspace(record)
        if not self._database_url:
            return self._file_upsert_workspace(record)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO workspaces (
                      workspace_id, owner_user_id, owner_nickname, encrypted_payload, updated_at,
                      plan, billing_status, stripe_customer_id, stripe_subscription_id
                    )
                    VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (workspace_id) DO UPDATE
                    SET owner_user_id = EXCLUDED.owner_user_id,
                        owner_nickname = EXCLUDED.owner_nickname,
                        encrypted_payload = EXCLUDED.encrypted_payload,
                        updated_at = EXCLUDED.updated_at,
                        plan = EXCLUDED.plan,
                        billing_status = EXCLUDED.billing_status,
                        stripe_customer_id = EXCLUDED.stripe_customer_id,
                        stripe_subscription_id = EXCLUDED.stripe_subscription_id
                    """,
                    (
                        record.workspace_id,
                        record.owner_user_id,
                        record.owner_nickname,
                        record.encrypted_payload,
                        record.updated_at,
                        record.plan,
                        record.billing_status,
                        record.stripe_customer_id,
                        record.stripe_subscription_id,
                    ),
                )
            conn.commit()
        return record

    def compare_and_swap_workspace(
        self,
        record: WorkspaceRecord,
        expected_encrypted_payload: str,
    ) -> WorkspaceRecord | None:
        """Persist only when the workspace has not changed since it was read."""
        routed = self._routed_gateway(self._workspace_route(record.workspace_id))
        if routed is not None:
            return routed.compare_and_swap_workspace(record, expected_encrypted_payload)
        if not self._database_url:
            return self._file_compare_and_swap_workspace(record, expected_encrypted_payload)
        active_conn = self._transaction_connection.get()
        if active_conn is not None:
            return self._compare_and_swap_workspace_on_connection(
                active_conn, record, expected_encrypted_payload
            )
        with self._connect() as conn:
            saved = self._compare_and_swap_workspace_on_connection(
                conn, record, expected_encrypted_payload
            )
            if saved is None:
                conn.rollback()
                return None
            conn.commit()
        return saved

    def _compare_and_swap_workspace_on_connection(
        self,
        conn: Any,
        record: WorkspaceRecord,
        expected_encrypted_payload: str,
    ) -> WorkspaceRecord | None:
        with conn.cursor() as cur:
            cur.execute(
                    """
                    UPDATE workspaces
                    SET owner_user_id = %s,
                        owner_nickname = %s,
                        encrypted_payload = %s,
                        updated_at = %s,
                        plan = %s,
                        billing_status = %s,
                        stripe_customer_id = %s,
                        stripe_subscription_id = %s
                    WHERE workspace_id = %s
                      AND encrypted_payload = %s
                    """,
                    (
                        record.owner_user_id,
                        record.owner_nickname,
                        record.encrypted_payload,
                        record.updated_at,
                        record.plan,
                        record.billing_status,
                        record.stripe_customer_id,
                        record.stripe_subscription_id,
                        record.workspace_id,
                        expected_encrypted_payload,
                    ),
                )
            if cur.rowcount != 1:
                return None
        return record

    def defer_until_after_commit(
        self, callback: Callable[[], None], workspace_id: str | None = None
    ) -> bool:
        if workspace_id:
            routed = self._routed_gateway(self._workspace_route(workspace_id))
            if routed is not None:
                return routed.defer_until_after_commit(callback)
        routed_hooks = self._after_commit_hooks.get()
        if routed_hooks is None:
            return False
        routed_hooks.append(callback)
        return True

    def supports_collaborative_storage(self, workspace_id: str) -> bool:
        """Return whether this workspace is routed to PostgreSQL-backed storage."""
        routed = self._routed_gateway(self._workspace_route(workspace_id))
        if routed is not None:
            return True
        return bool(self._database_url)

    def mutate_collaborative_room(
        self,
        workspace_id: str,
        item_id: str,
        mutate: Callable[[CollaborativeRoomRecord | None], CollaborativeRoomMutation],
    ) -> T:
        """Serialize a room mutation in PostgreSQL and return the callback result.

        The advisory transaction lock also covers a room that has no row yet, so
        two backend processes cannot both become bootstrap owner. The callback is
        intentionally executed while that lock is held because it performs the
        Yjs merge against the exact state selected below.
        """
        routed = self._routed_gateway(self._workspace_route(workspace_id))
        if routed is not None:
            return routed.mutate_collaborative_room(
                workspace_id,
                item_id,
                mutate,
            )
        if not self._database_url:
            raise RuntimeError("collaborative PostgreSQL storage is unavailable")
        after_commit: list[Callable[[], None]] = []
        with self._connect() as conn:
            connection_token = self._transaction_connection.set(conn)
            hooks_token = self._after_commit_hooks.set(after_commit)
            try:
                result = self._mutate_collaborative_room_on_connection(
                    conn, workspace_id, item_id, mutate
                )
                conn.commit()
            finally:
                self._after_commit_hooks.reset(hooks_token)
                self._transaction_connection.reset(connection_token)
        for callback in after_commit:
            callback()
        return result

    def _mutate_collaborative_room_on_connection(
        self,
        conn: Any,
        workspace_id: str,
        item_id: str,
        mutate: Callable[[CollaborativeRoomRecord | None], CollaborativeRoomMutation],
    ) -> T:
        with conn.cursor() as cur:
            cur.execute(
                    "SELECT pg_advisory_xact_lock(hashtext(%s), hashtext(%s))",
                    (workspace_id, item_id),
                )
            cur.execute(
                    """
                    SELECT room_epoch, snapshot, version, snapshot_version, bootstrap_lease_until
                    FROM collaborative_rooms
                    WHERE workspace_id = %s AND item_id = %s
                    FOR UPDATE
                    """,
                    (workspace_id, item_id),
                )
            row = cur.fetchone()
            updates: tuple[tuple[int, bytes], ...] = ()
            if row:
                cur.execute(
                        """
                        SELECT room_version, payload
                        FROM collaborative_updates
                        WHERE workspace_id = %s AND item_id = %s AND room_version > %s
                        ORDER BY room_version ASC
                        """,
                        (workspace_id, item_id, int(row[3])),
                    )
                updates = tuple((int(entry[0]), bytes(entry[1])) for entry in cur.fetchall())
            current = CollaborativeRoomRecord(
                    workspace_id=workspace_id,
                    item_id=item_id,
                    room_epoch=row[0],
                    snapshot=bytes(row[1]) if row[1] is not None else None,
                    version=int(row[2]),
                    snapshot_version=int(row[3]),
                    updates=updates,
                    bootstrap_lease_until=float(row[4] or 0),
            ) if row else None
            mutation = mutate(current)
            if not mutation.persist:
                return mutation.result
            if mutation.update_id is not None:
                cur.execute(
                    """
                    SELECT 1 FROM collaborative_update_receipts
                    WHERE workspace_id = %s AND item_id = %s AND update_id = %s
                    """,
                    (workspace_id, item_id, mutation.update_id),
                )
                if cur.fetchone() is not None:
                    return False
            if mutation.room_epoch is None:
                cur.execute(
                        "DELETE FROM collaborative_updates WHERE workspace_id = %s AND item_id = %s",
                        (workspace_id, item_id),
                    )
                cur.execute(
                    "DELETE FROM collaborative_rooms WHERE workspace_id = %s AND item_id = %s",
                    (workspace_id, item_id),
                )
                cur.execute(
                    "DELETE FROM collaborative_update_receipts WHERE workspace_id = %s AND item_id = %s",
                    (workspace_id, item_id),
                )
                cur.execute(
                    "DELETE FROM collaborative_events WHERE workspace_id = %s AND item_id = %s",
                    (workspace_id, item_id),
                )
            else:
                next_version = (current.version if current else 0) + 1
                snapshot = mutation.snapshot if mutation.compact else current.snapshot if current else mutation.snapshot
                snapshot_version = next_version if mutation.compact else current.snapshot_version if current else 0
                cur.execute(
                        """
                        INSERT INTO collaborative_rooms (
                          workspace_id, item_id, room_epoch, snapshot, version, snapshot_version,
                          bootstrap_lease_until, updated_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s, NOW())
                        ON CONFLICT (workspace_id, item_id) DO UPDATE
                        SET room_epoch = EXCLUDED.room_epoch,
                            snapshot = EXCLUDED.snapshot,
                            version = EXCLUDED.version,
                            snapshot_version = EXCLUDED.snapshot_version,
                            bootstrap_lease_until = EXCLUDED.bootstrap_lease_until,
                            updated_at = NOW()
                        """,
                        (
                            workspace_id,
                            item_id,
                            mutation.room_epoch,
                            snapshot,
                            next_version,
                            snapshot_version,
                            mutation.bootstrap_lease_until,
                        ),
                    )
                if mutation.update_payload is not None:
                    cur.execute(
                            """
                            INSERT INTO collaborative_updates (
                              workspace_id, item_id, room_epoch, room_version, payload
                            ) VALUES (%s, %s, %s, %s, %s)
                            """,
                            (workspace_id, item_id, mutation.room_epoch, next_version, mutation.update_payload),
                        )
                if mutation.compact:
                    cur.execute(
                            """
                            DELETE FROM collaborative_updates
                            WHERE workspace_id = %s AND item_id = %s
                              AND room_version <= %s
                            """,
                            (workspace_id, item_id, next_version),
                        )
                if mutation.update_id is not None:
                    cur.execute(
                        """
                        INSERT INTO collaborative_update_receipts (
                          workspace_id, item_id, update_id, room_epoch, room_version
                        ) VALUES (%s, %s, %s, %s, %s)
                        """,
                        (workspace_id, item_id, mutation.update_id, mutation.room_epoch, next_version),
                    )
                if mutation.event_payload is not None and mutation.update_id is not None:
                    cur.execute(
                        """
                        INSERT INTO collaborative_events (
                          workspace_id, item_id, room_epoch, room_version, update_id, payload
                        ) VALUES (%s, %s, %s, %s, %s, %s)
                        """,
                        (
                            workspace_id,
                            item_id,
                            mutation.room_epoch,
                            next_version,
                            mutation.update_id,
                            mutation.event_payload,
                        ),
                    )
                if next_version % 256 == 0:
                    cur.execute(
                        """
                        DELETE FROM collaborative_events
                        WHERE workspace_id = %s AND item_id = %s AND event_id IN (
                          SELECT event_id FROM collaborative_events
                          WHERE workspace_id = %s AND item_id = %s
                          ORDER BY event_id DESC OFFSET 4096
                        )
                        """,
                        (workspace_id, item_id, workspace_id, item_id),
                    )
                    cur.execute(
                        """
                        DELETE FROM collaborative_update_receipts
                        WHERE workspace_id = %s AND item_id = %s AND update_id IN (
                          SELECT update_id FROM collaborative_update_receipts
                          WHERE workspace_id = %s AND item_id = %s
                          ORDER BY created_at DESC OFFSET 8192
                        )
                        """,
                        (workspace_id, item_id, workspace_id, item_id),
                    )
        return mutation.result

    def collaborative_event_cursor(self, workspace_id: str, item_id: str) -> int:
        routed = self._routed_gateway(self._workspace_route(workspace_id))
        if routed is not None:
            return routed.collaborative_event_cursor(workspace_id, item_id)
        if not self._database_url:
            return 0
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COALESCE(MAX(event_id), 0) FROM collaborative_events WHERE workspace_id = %s AND item_id = %s",
                    (workspace_id, item_id),
                )
                row = cur.fetchone()
                return int(row[0]) if row else 0

    def collaborative_events_since(
        self, workspace_id: str, item_id: str, after_event_id: int, limit: int = 256
    ) -> list[CollaborativeEventRecord]:
        routed = self._routed_gateway(self._workspace_route(workspace_id))
        if routed is not None:
            return routed.collaborative_events_since(
                workspace_id, item_id, after_event_id, limit
            )
        if not self._database_url:
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT event_id, room_epoch, room_version, update_id, payload
                    FROM collaborative_events
                    WHERE workspace_id = %s AND item_id = %s AND event_id > %s
                    ORDER BY event_id ASC LIMIT %s
                    """,
                    (workspace_id, item_id, after_event_id, max(1, min(limit, 1000))),
                )
                return [
                    CollaborativeEventRecord(
                        event_id=int(row[0]),
                        room_epoch=str(row[1]),
                        room_version=int(row[2]),
                        update_id=str(row[3]),
                        payload=bytes(row[4]),
                    )
                    for row in cur.fetchall()
                ]

    def publish_workspace_event(
        self, workspace_id: str, event_type: str, payload: dict[str, Any]
    ) -> None:
        routed = self._routed_gateway(self._workspace_route(workspace_id))
        if routed is not None:
            routed.publish_workspace_event(workspace_id, event_type, payload)
            return
        if not self._database_url:
            return
        active_conn = self._transaction_connection.get()
        if active_conn is not None:
            with active_conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO workspace_events (workspace_id, event_type, payload) VALUES (%s, %s, %s::jsonb)",
                    (workspace_id, event_type, json.dumps(payload, separators=(",", ":"))),
                )
                cur.execute(
                    """
                    DELETE FROM workspace_events
                    WHERE workspace_id = %s AND event_id IN (
                      SELECT event_id FROM workspace_events
                      WHERE workspace_id = %s ORDER BY event_id DESC OFFSET 4096
                    )
                    """,
                    (workspace_id, workspace_id),
                )
            return
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO workspace_events (workspace_id, event_type, payload) VALUES (%s, %s, %s::jsonb)",
                    (workspace_id, event_type, json.dumps(payload, separators=(",", ":"))),
                )
                cur.execute(
                    """
                    DELETE FROM workspace_events
                    WHERE workspace_id = %s AND event_id IN (
                      SELECT event_id FROM workspace_events
                      WHERE workspace_id = %s ORDER BY event_id DESC OFFSET 4096
                    )
                    """,
                    (workspace_id, workspace_id),
                )
            conn.commit()

    def workspace_event_cursor(self, workspace_id: str) -> int:
        routed = self._routed_gateway(self._workspace_route(workspace_id))
        if routed is not None:
            return routed.workspace_event_cursor(workspace_id)
        if not self._database_url:
            return 0
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "SELECT COALESCE(MAX(event_id), 0) FROM workspace_events WHERE workspace_id = %s",
                    (workspace_id,),
                )
                row = cur.fetchone()
                return int(row[0]) if row else 0

    def workspace_events_since(
        self, workspace_id: str, after_event_id: int, limit: int = 256
    ) -> list[tuple[int, str, dict[str, Any]]]:
        routed = self._routed_gateway(self._workspace_route(workspace_id))
        if routed is not None:
            return routed.workspace_events_since(workspace_id, after_event_id, limit)
        if not self._database_url:
            return []
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT event_id, event_type, payload
                    FROM workspace_events
                    WHERE workspace_id = %s AND event_id > %s
                    ORDER BY event_id ASC LIMIT %s
                    """,
                    (workspace_id, after_event_id, max(1, min(limit, 1000))),
                )
                return [
                    (int(row[0]), str(row[1]), dict(row[2]))
                    for row in cur.fetchall()
                ]

    def save_paid_checkout(self, checkout: PaidCheckoutRecord) -> None:
        if not self._routing_enabled:
            raise RuntimeError("billing control storage is unavailable")
        if not self._database_url:
            with self._lock:
                control = self._read_control_records_unlocked()
                control["paid_checkouts"][checkout.checkout_session_id] = checkout.model_dump()
                self._write_control_records_unlocked(control)
            return
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO paid_workspace_checkouts (
                      purchase_token, owner_user_id, checkout_session_id, status,
                      stripe_customer_id, stripe_subscription_id, consumed_workspace_id,
                      created_at, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (checkout_session_id) DO UPDATE
                    SET status = EXCLUDED.status,
                        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, paid_workspace_checkouts.stripe_customer_id),
                        stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, paid_workspace_checkouts.stripe_subscription_id),
                        consumed_workspace_id = COALESCE(EXCLUDED.consumed_workspace_id, paid_workspace_checkouts.consumed_workspace_id),
                        updated_at = EXCLUDED.updated_at
                    """,
                    (
                        checkout.purchase_token,
                        checkout.owner_user_id,
                        checkout.checkout_session_id,
                        checkout.status,
                        checkout.stripe_customer_id,
                        checkout.stripe_subscription_id,
                        checkout.consumed_workspace_id,
                        checkout.created_at,
                        checkout.updated_at,
                    ),
                )
            conn.commit()

    def get_paid_checkout(self, checkout_session_id: str) -> PaidCheckoutRecord | None:
        if not self._database_url:
            with self._lock:
                value = self._read_control_records_unlocked()["paid_checkouts"].get(checkout_session_id)
            return PaidCheckoutRecord(**value) if value else None
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT purchase_token, owner_user_id, checkout_session_id, status,
                           stripe_customer_id, stripe_subscription_id, consumed_workspace_id,
                           created_at, updated_at
                    FROM paid_workspace_checkouts WHERE checkout_session_id = %s
                    """,
                    (checkout_session_id,),
                )
                row = cur.fetchone()
        return PaidCheckoutRecord(
            purchase_token=row[0],
            owner_user_id=row[1],
            checkout_session_id=row[2],
            status=row[3],
            stripe_customer_id=row[4],
            stripe_subscription_id=row[5],
            consumed_workspace_id=row[6],
            created_at=row[7],
            updated_at=row[8],
        ) if row else None

    def claim_paid_checkout(
        self,
        checkout_session_id: str,
        owner_user_id: str,
        workspace_id: str,
        updated_at: str,
    ) -> PaidCheckoutRecord:
        if not self._database_url:
            with self._lock:
                control = self._read_control_records_unlocked()
                value = control["paid_checkouts"].get(checkout_session_id)
                if not value or value.get("owner_user_id") != owner_user_id:
                    raise ValueError("paid checkout does not belong to this user")
                if value.get("status") != "paid":
                    raise ValueError("paid checkout is not complete")
                value["consumed_workspace_id"] = value.get("consumed_workspace_id") or workspace_id
                value["updated_at"] = updated_at
                control["paid_checkouts"][checkout_session_id] = value
                self._write_control_records_unlocked(control)
                return PaidCheckoutRecord(**value)
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT purchase_token, owner_user_id, checkout_session_id, status,
                           stripe_customer_id, stripe_subscription_id, consumed_workspace_id,
                           created_at, updated_at
                    FROM paid_workspace_checkouts
                    WHERE checkout_session_id = %s
                    FOR UPDATE
                    """,
                    (checkout_session_id,),
                )
                row = cur.fetchone()
                if row is None or row[1] != owner_user_id:
                    conn.rollback()
                    raise ValueError("paid checkout does not belong to this user")
                if row[3] != "paid":
                    conn.rollback()
                    raise ValueError("paid checkout is not complete")
                consumed_workspace_id = row[6] or workspace_id
                cur.execute(
                    """
                    UPDATE paid_workspace_checkouts
                    SET consumed_workspace_id = %s, updated_at = %s
                    WHERE checkout_session_id = %s
                    """,
                    (consumed_workspace_id, updated_at, checkout_session_id),
                )
            conn.commit()
        return PaidCheckoutRecord(
            purchase_token=row[0],
            owner_user_id=row[1],
            checkout_session_id=row[2],
            status=row[3],
            stripe_customer_id=row[4],
            stripe_subscription_id=row[5],
            consumed_workspace_id=consumed_workspace_id,
            created_at=row[7],
            updated_at=updated_at,
        )

    def save_workspace_route(self, route: WorkspaceRouteRecord) -> None:
        if not self._routing_enabled:
            raise RuntimeError("workspace route storage is unavailable")
        if not self._database_url:
            with self._lock:
                control = self._read_control_records_unlocked()
                control["workspace_routes"][route.workspace_id] = route.model_dump()
                self._write_control_records_unlocked(control)
            return
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    INSERT INTO workspace_routes (
                      workspace_id, owner_user_id, plan, billing_status,
                      stripe_customer_id, stripe_subscription_id, database_url_ciphertext, updated_at
                    ) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
                    ON CONFLICT (workspace_id) DO UPDATE
                    SET billing_status = EXCLUDED.billing_status,
                        stripe_customer_id = COALESCE(EXCLUDED.stripe_customer_id, workspace_routes.stripe_customer_id),
                        stripe_subscription_id = COALESCE(EXCLUDED.stripe_subscription_id, workspace_routes.stripe_subscription_id),
                        database_url_ciphertext = COALESCE(EXCLUDED.database_url_ciphertext, workspace_routes.database_url_ciphertext),
                        updated_at = EXCLUDED.updated_at
                    """,
                    (
                        route.workspace_id,
                        route.owner_user_id,
                        route.plan,
                        route.billing_status,
                        route.stripe_customer_id,
                        route.stripe_subscription_id,
                        route.database_url_ciphertext,
                        route.updated_at,
                    ),
                )
            conn.commit()

    def get_workspace_route(self, workspace_id: str) -> WorkspaceRouteRecord | None:
        if not self._routing_enabled:
            return None
        if not self._database_url:
            with self._lock:
                value = self._read_control_records_unlocked()["workspace_routes"].get(workspace_id)
            return WorkspaceRouteRecord(**value) if value else None
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    """
                    SELECT workspace_id, owner_user_id, plan, billing_status,
                           stripe_customer_id, stripe_subscription_id, database_url_ciphertext, updated_at
                    FROM workspace_routes WHERE workspace_id = %s
                    """,
                    (workspace_id,),
                )
                row = cur.fetchone()
        return WorkspaceRouteRecord(
            workspace_id=row[0],
            owner_user_id=row[1],
            plan=row[2],
            billing_status=row[3],
            stripe_customer_id=row[4],
            stripe_subscription_id=row[5],
            database_url_ciphertext=row[6],
            updated_at=row[7],
        ) if row else None

    def update_billing_status_by_subscription(self, subscription_id: str, status: str, updated_at: str) -> None:
        if not subscription_id:
            return
        if not self._database_url:
            with self._lock:
                control = self._read_control_records_unlocked()
                for route in control["workspace_routes"].values():
                    if route.get("stripe_subscription_id") == subscription_id:
                        route["billing_status"] = status
                        route["updated_at"] = updated_at
                for checkout in control["paid_checkouts"].values():
                    if checkout.get("stripe_subscription_id") == subscription_id:
                        checkout["status"] = status
                        checkout["updated_at"] = updated_at
                self._write_control_records_unlocked(control)
            return
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "UPDATE workspace_routes SET billing_status = %s, updated_at = %s WHERE stripe_subscription_id = %s",
                    (status, updated_at, subscription_id),
                )
                cur.execute(
                    "UPDATE paid_workspace_checkouts SET status = %s, updated_at = %s WHERE stripe_subscription_id = %s",
                    (status, updated_at, subscription_id),
                )
            conn.commit()

    def record_stripe_event_once(self, event_id: str, processed_at: str) -> bool:
        if not self._database_url:
            with self._lock:
                control = self._read_control_records_unlocked()
                if event_id in control["stripe_events"]:
                    return False
                control["stripe_events"].append(event_id)
                control["stripe_events"] = control["stripe_events"][-5000:]
                self._write_control_records_unlocked(control)
                return True
        with self._connect() as conn:
            with conn.cursor() as cur:
                cur.execute(
                    "INSERT INTO stripe_webhook_events (event_id, processed_at) VALUES (%s, %s) ON CONFLICT DO NOTHING",
                    (event_id, processed_at),
                )
                inserted = cur.rowcount == 1
            conn.commit()
        return inserted

    def _read_control_records_unlocked(self) -> dict:
        if not self._control_file.exists():
            return {"paid_checkouts": {}, "workspace_routes": {}, "stripe_events": []}
        value = json.loads(self._control_file.read_text(encoding="utf-8"))
        value.setdefault("paid_checkouts", {})
        value.setdefault("workspace_routes", {})
        value.setdefault("stripe_events", [])
        return value

    def _write_control_records_unlocked(self, records: dict) -> None:
        self._control_file.write_text(json.dumps(records, ensure_ascii=False, indent=2), encoding="utf-8")

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
            return sum(
                1
                for record in records
                if record.get("owner_user_id") == owner_user_id and record.get("plan", "free") == "free"
            )

    def _file_insert_workspace_with_owner_limit(
        self,
        record: WorkspaceRecord,
        max_workspaces: int,
    ) -> WorkspaceRecord | None:
        with self._lock:
            records = self._read_file_records()
            owned_count = sum(
                1
                for entry in records.values()
                if entry.get("owner_user_id") == record.owner_user_id and entry.get("plan", "free") == "free"
            )
            if owned_count >= max_workspaces:
                return None
            records[record.workspace_id] = record.model_dump()
            self._write_file_records(records)
        return record

    def _file_insert_workspace(self, record: WorkspaceRecord) -> WorkspaceRecord:
        with self._lock:
            records = self._read_file_records()
            records.setdefault(record.workspace_id, record.model_dump())
            self._write_file_records(records)
        return record

    def _file_upsert_workspace(self, record: WorkspaceRecord) -> WorkspaceRecord:
        with self._lock:
            records = self._read_file_records()
            records[record.workspace_id] = record.model_dump()
            self._write_file_records(records)
        return record

    def _file_compare_and_swap_workspace(
        self,
        record: WorkspaceRecord,
        expected_encrypted_payload: str,
    ) -> WorkspaceRecord | None:
        with self._lock:
            records = self._read_file_records()
            current = records.get(record.workspace_id)
            if current is None or current.get("encrypted_payload") != expected_encrypted_payload:
                return None
            records[record.workspace_id] = record.model_dump()
            self._write_file_records(records)
        return record
