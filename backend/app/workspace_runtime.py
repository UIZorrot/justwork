import re
import uuid
from datetime import datetime, timezone


ROOT_FOLDER_ID = "root"
WELCOME_DOC_ID = "welcome"


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def make_workspace_id() -> str:
    return f"workspace_{uuid.uuid4().hex}"


def make_doc_id() -> str:
    return f"doc_{uuid.uuid4().hex}"


def default_table_content() -> dict:
    return {
        "frozenHeader": True,
        "columns": [
            {"id": "col_name", "title": "Name", "type": "text", "width": 220},
            {"id": "col_notes", "title": "Notes", "type": "text", "width": 320},
        ],
        "rows": [
            {
                "id": "row_1",
                "cells": {
                    "col_name": "Untitled row",
                    "col_notes": "",
                },
            }
        ],
    }


def default_board_content() -> dict:
    return {
        "template": {
            "columnId": "template_lane",
            "title": "Card template",
            "cardTitle": "Default card",
            "fields": [
                {"id": "template_summary", "name": "Summary", "defaultValue": ""},
                {"id": "template_details", "name": "Details", "defaultValue": ""},
            ],
        },
        "columns": [
            {"id": "todo", "title": "To do", "color": "#f3c969", "cardIds": ["card_1"]},
            {"id": "doing", "title": "Doing", "color": "#9dd0ff", "cardIds": []},
            {"id": "done", "title": "Done", "color": "#a9e7b3", "cardIds": []},
        ],
        "cards": [
            {
                "id": "card_1",
                "title": "Untitled card",
                "fields": [
                    {
                        "id": "field_1",
                        "templateFieldId": "template_summary",
                        "name": "Summary",
                        "value": "",
                    },
                    {
                        "id": "field_2",
                        "templateFieldId": "template_details",
                        "name": "Details",
                        "value": "",
                    },
                ],
            },
        ],
    }


def default_content_for_kind(kind: str) -> dict | None:
    if kind == "table":
        return default_table_content()
    if kind == "board":
        return default_board_content()
    return None


def normalize_doc_payload(doc: dict) -> dict:
    next_doc = dict(doc)
    kind = str(next_doc.get("kind", "page"))
    if kind == "page":
        next_doc["markdown"] = str(next_doc.get("markdown", ""))
        next_doc["content"] = None
        return next_doc
    if kind == "folder":
        next_doc["markdown"] = ""
        next_doc["content"] = None
        return next_doc
    if kind == "table":
        next_doc["markdown"] = ""
        next_doc["content"] = next_doc.get("content") if isinstance(next_doc.get("content"), dict) else default_table_content()
        return next_doc
    if kind == "board":
        next_doc["markdown"] = ""
        next_doc["content"] = next_doc.get("content") if isinstance(next_doc.get("content"), dict) else default_board_content()
        return next_doc
    next_doc["kind"] = "page"
    next_doc["markdown"] = str(next_doc.get("markdown", ""))
    next_doc["content"] = None
    return next_doc


def display_name(nickname: str, user_id: str) -> str:
    label = nickname.strip() or "User"
    return f"{label}@{user_id[-4:]}"


def _normalize_member_payload(user_id: str, raw: object) -> dict:
    record = raw if isinstance(raw, dict) else {}
    nickname = str(record.get("nickname", "")).strip()
    joined_at = str(record.get("joinedAt", "")).strip() or now_iso()
    updated_at = str(record.get("updatedAt", "")).strip() or joined_at
    return {
        "userId": user_id,
        "nickname": nickname,
        "joinedAt": joined_at,
        "updatedAt": updated_at,
    }


def normalize_workspace_members(raw_members: object) -> dict[str, dict]:
    if not isinstance(raw_members, dict):
        return {}
    members: dict[str, dict] = {}
    for user_id, raw in raw_members.items():
        normalized_user_id = str(user_id).strip()
        if not normalized_user_id:
            continue
        members[normalized_user_id] = _normalize_member_payload(normalized_user_id, raw)
    return members


def ensure_workspace_members(state: dict, owner_user_id: str, owner_nickname: str) -> bool:
    members = normalize_workspace_members(state.get("members"))
    changed = members != state.get("members")
    owner = members.get(owner_user_id)
    if owner is None:
        joined_at = now_iso()
        members[owner_user_id] = {
            "userId": owner_user_id,
            "nickname": owner_nickname.strip(),
            "joinedAt": joined_at,
            "updatedAt": joined_at,
        }
        changed = True
    elif not owner.get("nickname") and owner_nickname.strip():
        owner["nickname"] = owner_nickname.strip()
        owner["updatedAt"] = now_iso()
        changed = True
    if changed:
        state["members"] = members
    elif "members" not in state:
        state["members"] = members
        changed = True
    return changed


def upsert_workspace_member(state: dict, user_id: str, nickname: str) -> dict:
    members = normalize_workspace_members(state.get("members"))
    current = members.get(user_id)
    now = now_iso()
    if current is None:
        current = {
            "userId": user_id,
            "nickname": nickname.strip(),
            "joinedAt": now,
            "updatedAt": now,
        }
    else:
        current = dict(current)
        current["nickname"] = nickname.strip()
        current["updatedAt"] = now
    members[user_id] = current
    state["members"] = members
    return current


def default_agent_nickname(user_id: str) -> str:
    compact = re.sub(r"[^a-zA-Z0-9]", "", user_id)
    suffix = (compact[-6:] if compact else user_id[-6:]).lower()
    return f"agent_{suffix}"


def ensure_actor_workspace_member(state: dict, owner_user_id: str, actor_user_id: str | None) -> bool:
    actor = (actor_user_id or "").strip()
    if not actor or actor == owner_user_id:
        return False
    members = normalize_workspace_members(state.get("members"))
    changed = members != state.get("members")
    current = members.get(actor)
    if current is None:
        joined_at = now_iso()
        members[actor] = {
            "userId": actor,
            "nickname": default_agent_nickname(actor),
            "joinedAt": joined_at,
            "updatedAt": joined_at,
        }
        changed = True
    elif not str(current.get("nickname", "")).strip():
        current = dict(current)
        current["nickname"] = default_agent_nickname(actor)
        current["updatedAt"] = now_iso()
        members[actor] = current
        changed = True
    if changed:
        state["members"] = members
    elif "members" not in state:
        state["members"] = members
        changed = True
    return changed


def workspace_member_views(state: dict, owner_user_id: str) -> list[dict]:
    members = normalize_workspace_members(state.get("members"))
    state["members"] = members
    views = [
        {
            "user_id": user_id,
            "nickname": member.get("nickname", ""),
            "display_name": display_name(str(member.get("nickname", "")), user_id),
            "joined_at": str(member.get("joinedAt", "")),
            "updated_at": str(member.get("updatedAt", "")),
            "is_owner": user_id == owner_user_id,
        }
        for user_id, member in members.items()
    ]
    return sorted(views, key=lambda item: (0 if item["is_owner"] else 1, item["joined_at"], item["user_id"]))


def default_workspace_title(workspace_id: str) -> str:
    return f"work_{workspace_id[-4:]}"


def normalize_workspace_title_text(title: str) -> str:
    return re.sub(r"\s+", " ", title.strip())


def normalize_workspace_title(title: str, workspace_id: str | None = None) -> str:
    normalized = normalize_workspace_title_text(title)
    if normalized:
        return normalized
    return default_workspace_title(workspace_id) if workspace_id else "Untitled workspace"


def make_initial_workspace_state(workspace_title: str, initial_doc_title: str = "Untitled") -> dict:
    now = now_iso()
    page_id = make_doc_id()
    normalized_workspace_title = normalize_workspace_title(workspace_title)
    normalized_doc_title = initial_doc_title if initial_doc_title.strip() else "Untitled"
    return {
        "activeDocId": page_id,
        "workspaceTitle": normalized_workspace_title,
        "workspaceDescription": "Backend-first JustWork workspace.",
        "members": {},
        "docs": [
            {
                "id": ROOT_FOLDER_ID,
                "title": "根目录",
                "markdown": "",
                "revision": 0,
                "updatedAt": now,
                "lastVisitedAt": now,
                "parentId": None,
                "pinned": False,
                "inTrash": False,
                "kind": "folder",
            },
            {
                "id": page_id,
                "title": normalized_doc_title,
                "markdown": "",
                "content": None,
                "revision": 0,
                "updatedAt": now,
                "lastVisitedAt": now,
                "parentId": ROOT_FOLDER_ID,
                "pinned": False,
                "inTrash": False,
                "kind": "page",
            },
        ],
    }


def find_doc(state: dict, item_id: str) -> dict | None:
    return next((doc for doc in state.get("docs", []) if doc.get("id") == item_id), None)


def is_protected_item(doc: dict) -> bool:
    return doc["id"] == ROOT_FOLDER_ID or doc.get("kind") == "welcome"


def looks_like_legacy_welcome_markdown(markdown: str) -> bool:
    return (
        "欢迎来到 JustWork" in markdown
        or "Welcome to JustWork" in markdown
        or "这里是你的文档中枢" in markdown
        or "This is your document hub" in markdown
    )


def normalize_legacy_welcome_doc(doc: dict) -> dict:
    markdown = str(doc.get("markdown", ""))
    if doc.get("kind") != "welcome" and not looks_like_legacy_welcome_markdown(markdown):
        return doc
    title = str(doc.get("title", "")).strip() or "未命名文档"
    next_doc = dict(doc)
    next_doc["kind"] = "page"
    next_doc["markdown"] = f"# {title}\n"
    return next_doc


def strip_auto_title_heading(doc: dict) -> dict:
    if doc.get("kind") != "page":
        return doc
    title = str(doc.get("title", "")).strip()
    markdown = str(doc.get("markdown", ""))
    if not title or not markdown.startswith("# "):
        return doc
    lines = markdown.splitlines()
    if not lines or lines[0].strip() != f"# {title}":
        return doc
    remainder = lines[1:]
    while remainder and remainder[0].strip() == "":
        remainder.pop(0)
    next_doc = dict(doc)
    next_doc["markdown"] = "\n".join(remainder)
    return next_doc


def normalize_workspace_state(state: dict) -> dict:
    docs = []
    for doc in state.get("docs", []):
        normalized = normalize_legacy_welcome_doc(doc)
        if doc.get("kind") != "welcome":
            normalized = strip_auto_title_heading(normalized)
        docs.append(normalize_doc_payload(normalized))
    active_doc_id = state.get("activeDocId")
    active = find_doc({**state, "docs": docs}, active_doc_id) if active_doc_id else None
    if active is None or active.get("inTrash", False):
        active_doc_id = next(
            (doc["id"] for doc in docs if doc.get("kind") != "folder" and not doc.get("inTrash", False)),
            ROOT_FOLDER_ID,
        )
    next_state = dict(state)
    next_state["docs"] = docs
    next_state["members"] = normalize_workspace_members(next_state.get("members"))
    next_state["activeDocId"] = active_doc_id
    workspace_title = normalize_workspace_title_text(str(next_state.get("workspaceTitle", "")))
    if not workspace_title:
        first_page = next((doc for doc in docs if doc.get("kind") == "page" and doc.get("id") != WELCOME_DOC_ID), None)
        workspace_title = normalize_workspace_title_text(str(first_page.get("title", ""))) if first_page else ""
    next_state["workspaceTitle"] = workspace_title or "Untitled workspace"
    return next_state


def get_workspace_title(state: dict, workspace_id: str | None = None) -> str:
    title = str(state.get("workspaceTitle", "")).strip()
    if title:
        return title
    return default_workspace_title(workspace_id) if workspace_id else "Untitled workspace"


def update_workspace_title(state: dict, title: str, workspace_id: str | None = None) -> str:
    normalized = normalize_workspace_title(title, workspace_id)
    state["workspaceTitle"] = normalized
    return normalized


def child_docs(state: dict, parent_id: str) -> list[dict]:
    return [doc for doc in state.get("docs", []) if doc.get("parentId") == parent_id]


def descendant_docs(state: dict, parent_id: str) -> list[dict]:
    descendants = []
    stack = child_docs(state, parent_id)
    while stack:
        doc = stack.pop()
        descendants.append(doc)
        stack.extend(child_docs(state, doc["id"]))
    return descendants


def choose_active_item_id(state: dict) -> str:
    active_id = state.get("activeDocId")
    active = find_doc(state, active_id) if active_id else None
    if active is not None and not active.get("inTrash", False):
        return active["id"]
    for doc in state.get("docs", []):
        if doc.get("kind") != "folder" and not doc.get("inTrash", False):
            state["activeDocId"] = doc["id"]
            return doc["id"]
    state["activeDocId"] = ROOT_FOLDER_ID
    return ROOT_FOLDER_ID


def tree_items(state: dict) -> list[dict]:
    return [
        {
            "id": doc["id"],
            "title": doc.get("title", ""),
            "kind": doc.get("kind", "page"),
            "parent_id": doc.get("parentId"),
            "pinned": bool(doc.get("pinned", False)),
            "in_trash": bool(doc.get("inTrash", False)),
            "revision": int(doc.get("revision", 0)),
            "updated_at": doc.get("updatedAt", now_iso()),
        }
        for doc in state.get("docs", [])
    ]


def item_view(doc: dict) -> dict:
    return {
        "id": doc["id"],
        "title": doc.get("title", ""),
        "markdown": doc.get("markdown", ""),
        "content": doc.get("content"),
        "kind": doc.get("kind", "page"),
        "parent_id": doc.get("parentId"),
        "pinned": bool(doc.get("pinned", False)),
        "in_trash": bool(doc.get("inTrash", False)),
        "revision": int(doc.get("revision", 0)),
        "updated_at": doc.get("updatedAt", now_iso()),
    }


def update_doc(state: dict, item_id: str, title: str | None, markdown: str | None, content: dict | None) -> dict:
    doc = find_doc(state, item_id)
    if doc is None:
        raise KeyError(item_id)
    kind = doc.get("kind")
    if kind == "folder":
        if markdown is not None:
            raise ValueError("folder markdown cannot be updated")
        if content is not None:
            raise ValueError("folder content cannot be updated")
    elif kind == "page":
        if content is not None:
            raise ValueError("page content cannot be updated")
    elif kind in ("table", "board"):
        if markdown is not None:
            raise ValueError(f"{kind} markdown cannot be updated")
    else:
        raise ValueError("unsupported item kind")
    if title is not None:
        doc["title"] = title
    if markdown is not None:
        doc["markdown"] = markdown
    if content is not None:
        doc["content"] = content
    doc["revision"] = int(doc.get("revision", 0)) + 1
    doc["updatedAt"] = now_iso()
    return doc


def create_doc(state: dict, kind: str, title: str, parent_id: str | None, doc_id: str | None = None) -> dict:
    if kind not in ("page", "folder", "table", "board"):
        raise ValueError("kind must be page, folder, table, or board")
    parent = find_doc(state, parent_id or ROOT_FOLDER_ID)
    if parent is None or parent.get("kind") != "folder":
        raise ValueError("parent must be a folder")
    if parent.get("inTrash", False):
        raise ValueError("parent cannot be in trash")

    now = now_iso()
    normalized_title = title if title.strip() else (
        "New Folder"
        if kind == "folder"
        else "Untitled Table"
        if kind == "table"
        else "Untitled Board"
        if kind == "board"
        else "Untitled"
    )
    chosen_id = str(doc_id or "").strip() or make_doc_id()
    if find_doc(state, chosen_id) is not None:
        raise ValueError("item id already exists")

    doc = {
        "id": chosen_id,
        "title": normalized_title,
        "markdown": "",
        "content": default_content_for_kind(kind),
        "revision": 0,
        "updatedAt": now,
        "lastVisitedAt": now,
        "parentId": parent["id"],
        "pinned": False,
        "inTrash": False,
        "kind": kind,
    }
    state.setdefault("docs", []).append(doc)
    if kind != "folder":
        state["activeDocId"] = doc["id"]
    return doc


def set_doc_pin(state: dict, item_id: str, pinned: bool) -> dict:
    doc = find_doc(state, item_id)
    if doc is None:
        raise KeyError(item_id)
    if is_protected_item(doc):
        raise ValueError("protected item cannot be pinned")
    doc["pinned"] = pinned
    doc["revision"] = int(doc.get("revision", 0)) + 1
    doc["updatedAt"] = now_iso()
    return doc


def trash_doc(state: dict, item_id: str) -> dict:
    doc = find_doc(state, item_id)
    if doc is None:
        raise KeyError(item_id)
    if is_protected_item(doc):
        raise ValueError("protected item cannot be trashed")
    now = now_iso()
    for target in [doc, *descendant_docs(state, item_id)]:
        target["inTrash"] = True
        target["pinned"] = False
        target["revision"] = int(target.get("revision", 0)) + 1
        target["updatedAt"] = now
    choose_active_item_id(state)
    return doc


def restore_doc(state: dict, item_id: str) -> dict:
    doc = find_doc(state, item_id)
    if doc is None:
        raise KeyError(item_id)
    if is_protected_item(doc):
        raise ValueError("protected item cannot be restored")
    parent_id = doc.get("parentId")
    parent = find_doc(state, parent_id) if parent_id else None
    if parent is not None and parent.get("inTrash", False):
        raise ValueError("parent is still in trash")
    now = now_iso()
    for target in [doc, *descendant_docs(state, item_id)]:
        target["inTrash"] = False
        target["revision"] = int(target.get("revision", 0)) + 1
        target["updatedAt"] = now
    choose_active_item_id(state)
    return doc


def hard_delete_doc(state: dict, item_id: str) -> dict:
    doc = find_doc(state, item_id)
    if doc is None:
        raise KeyError(item_id)
    if is_protected_item(doc):
        raise ValueError("protected item cannot be deleted")
    if child_docs(state, item_id):
        raise ValueError("folder must be empty before hard delete")
    state["docs"] = [entry for entry in state.get("docs", []) if entry.get("id") != item_id]
    choose_active_item_id(state)
    return doc


def move_doc(state: dict, item_id: str, parent_id: str | None) -> dict:
    doc = find_doc(state, item_id)
    if doc is None:
        raise KeyError(item_id)
    if doc["id"] == ROOT_FOLDER_ID or doc.get("kind") == "welcome":
        raise ValueError("protected item cannot be moved")
    if parent_id is not None:
        parent = find_doc(state, parent_id)
        if parent is None or parent.get("kind") != "folder":
            raise ValueError("parent must be a folder")
    doc["parentId"] = parent_id
    doc["updatedAt"] = now_iso()
    doc["revision"] = int(doc.get("revision", 0)) + 1
    return doc


def search_docs(state: dict, query: str) -> list[dict]:
    def structured_fragments(doc: dict) -> list[str]:
        content = doc.get("content")
        if not isinstance(content, dict):
            return []
        kind = doc.get("kind")
        fragments: list[str] = []
        if kind == "table":
            columns = content.get("columns", [])
            rows = content.get("rows", [])
            column_titles = {
                str(column.get("id", "")): str(column.get("title", "")).strip()
                for column in columns
                if isinstance(column, dict)
            }
            for title in column_titles.values():
                if title:
                    fragments.append(title)
            for row in rows:
                if not isinstance(row, dict):
                    continue
                cells = row.get("cells", {})
                if not isinstance(cells, dict):
                    continue
                values = []
                for column_id, value in cells.items():
                    value_text = str(value).strip()
                    if not value_text:
                        continue
                    column_title = column_titles.get(str(column_id), "").strip()
                    values.append(f"{column_title}: {value_text}" if column_title else value_text)
                if values:
                    fragments.append(" | ".join(values))
        elif kind == "board":
            template = content.get("template", {})
            if isinstance(template, dict):
                template_title = str(template.get("title", "")).strip()
                if template_title:
                    fragments.append(template_title)
                for field in template.get("fields", []):
                    if not isinstance(field, dict):
                        continue
                    field_name = str(field.get("name", "")).strip()
                    default_value = str(field.get("defaultValue", "")).strip()
                    if field_name:
                        fragments.append(field_name if not default_value else f"{field_name}: {default_value}")
            for column in content.get("columns", []):
                if not isinstance(column, dict):
                    continue
                title = str(column.get("title", "")).strip()
                if title:
                    fragments.append(title)
            for card in content.get("cards", []):
                if not isinstance(card, dict):
                    continue
                title = str(card.get("title", "")).strip()
                field_fragments: list[str] = []
                for field in card.get("fields", []):
                    if not isinstance(field, dict):
                        continue
                    field_name = str(field.get("name", "")).strip()
                    value = str(field.get("value", "")).strip()
                    if value:
                        field_fragments.append(f"{field_name}: {value}" if field_name else value)
                description = str(card.get("description", "")).strip()
                if description:
                    field_fragments.append(description)
                fragment = " - ".join(part for part in [title, " | ".join(field_fragments)] if part)
                if fragment:
                    fragments.append(fragment)
        return fragments

    needle = query.casefold()
    results = []
    for doc in state.get("docs", []):
        title = doc.get("title", "")
        markdown = doc.get("markdown", "")
        fragments = structured_fragments(doc)
        title_hit = needle in title.casefold()
        markdown_hit = needle in markdown.casefold()
        structured_source = next((fragment for fragment in fragments if needle in fragment.casefold()), "")
        structured_hit = bool(structured_source)
        if not title_hit and not markdown_hit and not structured_hit:
            continue
        source = markdown if markdown_hit else structured_source if structured_hit else title
        idx = source.casefold().find(needle)
        start = max(idx - 32, 0)
        end = min(idx + len(query) + 32, len(source))
        results.append(
            {
                "id": doc["id"],
                "title": title,
                "kind": doc.get("kind", "page"),
                "parent_id": doc.get("parentId"),
                "score": (10 if title_hit else 0) + (5 if markdown_hit else 0) + (5 if structured_hit else 0) - (4 if doc.get("kind") == "welcome" else 0),
                "excerpt": source[start:end],
            }
        )
    return sorted(results, key=lambda item: item["score"], reverse=True)


def outline(markdown: str) -> list[dict]:
    headings = []
    for line_number, line in enumerate(markdown.splitlines(), start=1):
        match = re.match(r"^(#{1,6})\s+(.+?)\s*$", line)
        if match:
            headings.append({"level": len(match.group(1)), "text": match.group(2), "line": line_number})
    return headings


def patch_doc(
    state: dict,
    item_id: str,
    find: str,
    replace: str,
    dry_run: bool,
    *,
    actor_user_id: str | None = None,
    signed: bool = False,
    signature_digest: str | None = None,
) -> tuple[dict, bool, str]:
    doc = find_doc(state, item_id)
    if doc is None:
        raise KeyError(item_id)
    if doc.get("kind") != "page":
        raise ValueError(f"{doc.get('kind')} markdown cannot be patched")
    current = doc.get("markdown", "")
    changed = find in current
    preview = current.replace(find, replace, 1) if changed else current
    if not dry_run and changed:
        doc["markdown"] = preview
        doc["revision"] = int(doc.get("revision", 0)) + 1
        doc["updatedAt"] = now_iso()
    return doc, changed, preview
