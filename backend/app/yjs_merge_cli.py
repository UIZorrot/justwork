"""Isolated Yjs merge helper — run as ``python -m app.yjs_merge_cli``.

Reads one JSON object from stdin:
  {"updates": ["<base64>", ...]}

Writes one JSON object to stdout:
  {"ok": true, "merged": "<base64>"}
  or {"ok": false, "error": "..."}
"""
from __future__ import annotations

import base64
import json
import sys


def main() -> int:
    try:
        payload = json.load(sys.stdin)
        updates = [
            base64.b64decode(item.encode("ascii"))
            for item in (payload.get("updates") or [])
        ]
        from y_py import YDoc, apply_update, encode_state_as_update

        document = YDoc()
        for update in updates:
            apply_update(document, update)
        merged = encode_state_as_update(document)
        json.dump(
            {"ok": True, "merged": base64.b64encode(merged).decode("ascii")},
            sys.stdout,
            separators=(",", ":"),
        )
        sys.stdout.write("\n")
        return 0
    except BaseException as exc:  # noqa: BLE001
        json.dump(
            {"ok": False, "error": f"{type(exc).__name__}: {exc}"},
            sys.stdout,
            separators=(",", ":"),
        )
        sys.stdout.write("\n")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
