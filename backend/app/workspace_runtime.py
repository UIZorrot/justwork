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


def make_event_id() -> str:
    return f"evt_{uuid.uuid4().hex}"


def display_name(nickname: str, user_id: str) -> str:
    label = nickname.strip() or "User"
    return f"{label}@{user_id[-4:]}"


def make_initial_workspace_state(title: str) -> dict:
    now = now_iso()
    page_id = make_doc_id()
    return {
        "activeDocId": page_id,
        "workspaceDescription": "Backend-first JustWork workspace.",
        "history": [],
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
                "id": WELCOME_DOC_ID,
                "title": "欢迎来到 JustWork",
                "markdown": "# 欢迎来到 JustWork\n\n这是你的 Backend-first 工作区。\n",
                "revision": 0,
                "updatedAt": now,
                "lastVisitedAt": now,
                "parentId": None,
                "pinned": True,
                "inTrash": False,
                "kind": "welcome",
            },
            {
                "id": page_id,
                "title": title,
                "markdown": f"# {title}\n",
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
        if doc.get("kind") in ("page", "welcome") and not doc.get("inTrash", False):
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
        "kind": doc.get("kind", "page"),
        "parent_id": doc.get("parentId"),
        "pinned": bool(doc.get("pinned", False)),
        "in_trash": bool(doc.get("inTrash", False)),
        "revision": int(doc.get("revision", 0)),
        "updated_at": doc.get("updatedAt", now_iso()),
    }


def update_doc(state: dict, item_id: str, title: str | None, markdown: str | None) -> dict:
    doc = find_doc(state, item_id)
    if doc is None:
        raise KeyError(item_id)
    if doc.get("kind") == "folder" and markdown is not None:
        raise ValueError("folder markdown cannot be updated")
    if title is not None:
        doc["title"] = title
    if markdown is not None:
        doc["markdown"] = markdown
    doc["revision"] = int(doc.get("revision", 0)) + 1
    doc["updatedAt"] = now_iso()
    return doc


def create_doc(state: dict, kind: str, title: str, parent_id: str | None) -> dict:
    if kind not in ("page", "folder"):
        raise ValueError("kind must be page or folder")
    parent = find_doc(state, parent_id or ROOT_FOLDER_ID)
    if parent is None or parent.get("kind") != "folder":
        raise ValueError("parent must be a folder")
    if parent.get("inTrash", False):
        raise ValueError("parent cannot be in trash")

    now = now_iso()
    normalized_title = title.strip() or ("New Folder" if kind == "folder" else "Untitled")
    doc = {
        "id": make_doc_id(),
        "title": normalized_title,
        "markdown": "" if kind == "folder" else f"# {normalized_title}\n",
        "revision": 0,
        "updatedAt": now,
        "lastVisitedAt": now,
        "parentId": parent["id"],
        "pinned": False,
        "inTrash": False,
        "kind": kind,
    }
    state.setdefault("docs", []).append(doc)
    if kind == "page":
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


def ensure_history(state: dict) -> list[dict]:
    history = state.setdefault("history", [])
    if not isinstance(history, list):
        state["history"] = []
    return state["history"]


def record_history(
    state: dict,
    op: str,
    before_doc: dict,
    after_doc: dict,
    *,
    actor_user_id: str | None = None,
    signed: bool = False,
    signature_digest: str | None = None,
) -> dict:
    event = {
        "id": make_event_id(),
        "op": op,
        "item_id": after_doc["id"],
        "timestamp": now_iso(),
        "title": after_doc.get("title", ""),
        "before_markdown": before_doc.get("markdown", ""),
        "after_markdown": after_doc.get("markdown", ""),
        "actor_user_id": actor_user_id,
        "signed": signed,
        "signature_digest": signature_digest,
    }
    ensure_history(state).insert(0, event)
    return event


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
    needle = query.casefold()
    results = []
    for doc in state.get("docs", []):
        title = doc.get("title", "")
        markdown = doc.get("markdown", "")
        title_hit = needle in title.casefold()
        markdown_hit = needle in markdown.casefold()
        if not title_hit and not markdown_hit:
            continue
        source = markdown if markdown_hit else title
        idx = source.casefold().find(needle)
        start = max(idx - 32, 0)
        end = min(idx + len(query) + 32, len(source))
        results.append(
            {
                "id": doc["id"],
                "title": title,
                "kind": doc.get("kind", "page"),
                "parent_id": doc.get("parentId"),
                "score": (10 if title_hit else 0) + (5 if markdown_hit else 0) - (4 if doc.get("kind") == "welcome" else 0),
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
    if doc.get("kind") == "folder":
        raise ValueError("folder markdown cannot be patched")
    current = doc.get("markdown", "")
    changed = find in current
    preview = current.replace(find, replace, 1) if changed else current
    if not dry_run and changed:
        before = dict(doc)
        doc["markdown"] = preview
        doc["revision"] = int(doc.get("revision", 0)) + 1
        doc["updatedAt"] = now_iso()
        record_history(
            state,
            "doc.patch",
            before,
            doc,
            actor_user_id=actor_user_id,
            signed=signed,
            signature_digest=signature_digest,
        )
    return doc, changed, preview


def revert_history_event(
    state: dict,
    event_id: str,
    *,
    actor_user_id: str | None = None,
    signed: bool = False,
    signature_digest: str | None = None,
) -> dict:
    event = next((entry for entry in ensure_history(state) if entry.get("id") == event_id), None)
    if event is None:
        raise KeyError(event_id)
    doc = find_doc(state, event["item_id"])
    if doc is None:
        raise KeyError(event["item_id"])
    before = dict(doc)
    doc["markdown"] = event["before_markdown"]
    doc["revision"] = int(doc.get("revision", 0)) + 1
    doc["updatedAt"] = now_iso()
    record_history(
        state,
        "history.revert",
        before,
        doc,
        actor_user_id=actor_user_id,
        signed=signed,
        signature_digest=signature_digest,
    )
    return doc
