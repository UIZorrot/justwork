from __future__ import annotations

import copy
import secrets

from .workspace_runtime import now_iso


MAX_WORKSPACE_REVISIONS_FREE = 200
MAX_WORKSPACE_REVISIONS_PAID = 1000


def item_snapshot(item: dict | None) -> dict:
    if not item:
        return {}
    snapshot = {
        "title": str(item.get("title", "")),
        "markdown": str(item.get("markdown", "")),
        "content": copy.deepcopy(item.get("content")),
        "pinned": bool(item.get("pinned", False)),
        "inTrash": bool(item.get("inTrash", False)),
        "parentId": item.get("parentId"),
        "orderKey": float(item.get("orderKey", 0)),
        "revision": int(item.get("revision", 0)),
        "kind": str(item.get("kind", "page")),
    }
    if "nickname" in item:
        snapshot["nickname"] = str(item.get("nickname", ""))
        snapshot["title"] = snapshot["nickname"]
    if "userId" in item:
        snapshot["userId"] = str(item.get("userId", ""))
    if "role" in item:
        snapshot["role"] = str(item.get("role", "member"))
    return snapshot


def append_workspace_revision(
    state: dict,
    *,
    operation: str,
    item_id: str,
    title: str,
    before: dict | None,
    after: dict | None,
    actor_user_id: str | None,
    mutation_id: str | None = None,
) -> dict:
    event = {
        "id": f"rev_{secrets.token_urlsafe(12)}",
        "operation": operation,
        "itemId": item_id,
        "title": title,
        "before": item_snapshot(before),
        "after": item_snapshot(after),
        "actorUserId": actor_user_id,
        "mutationId": mutation_id,
        "timestamp": now_iso(),
    }
    history = state.setdefault("revisionHistory", [])
    if not isinstance(history, list):
        history = []
        state["revisionHistory"] = history
    history.append(event)
    configured_limit = state.get("historyLimit")
    default_limit = (
        MAX_WORKSPACE_REVISIONS_PAID
        if state.get("billingPlan") == "paid"
        else MAX_WORKSPACE_REVISIONS_FREE
    )
    try:
        requested_limit = int(configured_limit or default_limit)
    except (TypeError, ValueError):
        requested_limit = default_limit
    limit = max(1, min(MAX_WORKSPACE_REVISIONS_PAID, requested_limit))
    if len(history) > limit:
        del history[:-limit]
    return event


def list_workspace_revisions(state: dict, item_id: str | None = None) -> list[dict]:
    history = state.get("revisionHistory", [])
    if not isinstance(history, list):
        return []
    events = [event for event in history if isinstance(event, dict)]
    if item_id:
        events = [event for event in events if event.get("itemId") == item_id]
    return list(reversed(copy.deepcopy(events)))
