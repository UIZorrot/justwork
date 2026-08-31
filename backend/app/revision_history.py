from __future__ import annotations

import copy
import json
import secrets

from .workspace_runtime import now_iso


MAX_WORKSPACE_REVISIONS_FREE = 200
MAX_WORKSPACE_REVISIONS_PAID = 1000
REVISION_DELTA_VERSION = 1
BODY_FIELDS = ("markdown", "content")


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
        "orderRank": str(item.get("orderRank", "")),
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


def _body_text(field: str, value: object) -> str:
    if field == "markdown":
        return str(value or "")
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _body_value(field: str, value: str) -> object:
    if field == "markdown":
        return value
    return json.loads(value)


def _text_delta(before: str, after: str) -> dict | None:
    if before == after:
        return None
    prefix = 0
    prefix_limit = min(len(before), len(after))
    while prefix < prefix_limit and before[prefix] == after[prefix]:
        prefix += 1
    suffix = 0
    suffix_limit = min(len(before) - prefix, len(after) - prefix)
    while suffix < suffix_limit and before[len(before) - suffix - 1] == after[len(after) - suffix - 1]:
        suffix += 1
    before_end = len(before) - suffix if suffix else len(before)
    after_end = len(after) - suffix if suffix else len(after)
    return {
        "prefix": prefix,
        "suffix": suffix,
        "removed": before[prefix:before_end],
        "added": after[prefix:after_end],
    }


def _apply_text_delta(value: str, delta: dict, *, reverse: bool) -> str:
    prefix = int(delta.get("prefix", 0))
    suffix = int(delta.get("suffix", 0))
    removed = str(delta.get("removed", ""))
    added = str(delta.get("added", ""))
    expected = added if reverse else removed
    replacement = removed if reverse else added
    end = len(value) - suffix if suffix else len(value)
    if prefix < 0 or suffix < 0 or end < prefix or value[prefix:end] != expected:
        raise ValueError("revision body delta does not match its reconstruction base")
    return value[:prefix] + replacement + value[end:]


def _compact_event(event: dict) -> None:
    if event.get("deltaVersion") == REVISION_DELTA_VERSION:
        return
    before = event.get("before")
    after = event.get("after")
    if not isinstance(before, dict) or not isinstance(after, dict):
        return
    body_delta: dict[str, dict] = {}
    for field in BODY_FIELDS:
        delta = _text_delta(_body_text(field, before.get(field)), _body_text(field, after.get(field)))
        if delta is not None:
            body_delta[field] = delta
        before.pop(field, None)
        after.pop(field, None)
    event["deltaVersion"] = REVISION_DELTA_VERSION
    if body_delta:
        event["bodyDelta"] = body_delta


def compact_workspace_revisions(state: dict) -> None:
    history = state.get("revisionHistory", [])
    if not isinstance(history, list):
        return
    for event in history:
        if isinstance(event, dict):
            _compact_event(event)


def _current_item_snapshot(state: dict, item_id: str) -> dict:
    if item_id == "workspace":
        return item_snapshot({
            "title": str(state.get("workspaceTitle", "")),
            "revision": int(state.get("workspaceRevision", 0)),
        })
    members = state.get("members", {})
    if isinstance(members, dict) and isinstance(members.get(item_id), dict):
        return item_snapshot(members[item_id])
    for item in state.get("docs", []):
        if isinstance(item, dict) and item.get("id") == item_id:
            return item_snapshot(item)
    return item_snapshot(None)


def _materialize_revisions(state: dict, events: list[dict]) -> list[dict]:
    body_cursor: dict[str, dict[str, object]] = {}
    materialized: list[dict] = []
    for source in reversed(events):
        event = copy.deepcopy(source)
        before = event.get("before") if isinstance(event.get("before"), dict) else {}
        after = event.get("after") if isinstance(event.get("after"), dict) else {}
        item_id = str(event.get("itemId", ""))
        if event.get("deltaVersion") == REVISION_DELTA_VERSION:
            current = body_cursor.get(item_id)
            if current is None:
                snapshot = _current_item_snapshot(state, item_id)
                current = {field: copy.deepcopy(snapshot.get(field)) for field in BODY_FIELDS}
            next_cursor = copy.deepcopy(current)
            deltas = event.get("bodyDelta") if isinstance(event.get("bodyDelta"), dict) else {}
            for field in BODY_FIELDS:
                after_value = copy.deepcopy(current.get(field))
                before_value = after_value
                delta = deltas.get(field)
                if isinstance(delta, dict):
                    try:
                        before_text = _apply_text_delta(_body_text(field, after_value), delta, reverse=True)
                        before_value = _body_value(field, before_text)
                    except (TypeError, ValueError, json.JSONDecodeError):
                        # Preserve history availability if a legacy/manual state edit
                        # broke a reconstruction chain; metadata remains usable.
                        before_value = after_value
                before[field] = copy.deepcopy(before_value)
                after[field] = copy.deepcopy(after_value)
                next_cursor[field] = copy.deepcopy(before_value)
            body_cursor[item_id] = next_cursor
        else:
            body_cursor[item_id] = {
                field: copy.deepcopy(before.get(field))
                for field in BODY_FIELDS
            }
        event["before"] = before
        event["after"] = after
        materialized.append(event)
    materialized.reverse()
    return materialized


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
    source_revision_id: str | None = None,
) -> dict:
    compact_workspace_revisions(state)
    event = {
        "id": f"rev_{secrets.token_urlsafe(12)}",
        "operation": operation,
        "itemId": item_id,
        "title": title,
        "before": item_snapshot(before),
        "after": item_snapshot(after),
        "actorUserId": actor_user_id,
        "mutationId": mutation_id,
        "sourceRevisionId": source_revision_id,
        "timestamp": now_iso(),
    }
    _compact_event(event)
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
    events = _materialize_revisions(state, events)
    if item_id:
        events = [event for event in events if event.get("itemId") == item_id]
    return list(reversed(copy.deepcopy(events)))
