"""Verify optional ECDSA write signatures (P-256 / SHA-256) matching extension Agent signing."""

from __future__ import annotations

import base64
import hashlib
import json
import time
from datetime import datetime
from typing import Any

from cryptography import exceptions as crypto_exceptions
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec, utils
from fastapi import HTTPException, status
from pydantic import BaseModel

SIGNING_FIELD_NAMES = (
    "actor_user_id",
    "public_key",
    "signature",
    "nonce",
    "timestamp",
    "body_hash",
)

TS_MAX_SKEW_SEC = 300
NONCE_TTL_SEC = 600

_seen_nonces: dict[str, float] = {}


def _prune_nonces(now: float) -> None:
    for k, t in list(_seen_nonces.items()):
        if now - t > NONCE_TTL_SEC:
            del _seen_nonces[k]


def canonical_json(value: Any) -> str:
    """Matches TS `canonicalJson` (sorted object keys, compact arrays)."""
    if isinstance(value, list):
        return "[" + ",".join(canonical_json(v) for v in value) + "]"
    if isinstance(value, dict):
        keys = sorted(value.keys())
        return "{" + ",".join(f"{json.dumps(k, ensure_ascii=False)}:{canonical_json(value[k])}" for k in keys) + "}"
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def _b64url_decode(s: str) -> bytes:
    pad = "=" * ((4 - len(s) % 4) % 4)
    return base64.urlsafe_b64decode(s + pad)


def _b64url_encode(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).decode("ascii").rstrip("=")


def derive_user_id(public_key_jwk: dict[str, Any]) -> str:
    keys_sorted = {k: public_key_jwk[k] for k in sorted(public_key_jwk.keys())}
    digest = hashlib.sha256(canonical_json(keys_sorted).encode("utf-8")).digest()
    return "user_" + _b64url_encode(digest)


def body_hash_from_model(model: BaseModel) -> str:
    data = model.model_dump(exclude_none=True, mode="json")
    for k in SIGNING_FIELD_NAMES:
        data.pop(k, None)
    return hashlib.sha256(canonical_json(data).encode("utf-8")).hexdigest()


def build_canonical_message(
    *,
    method: str,
    path: str,
    workspace_id: str,
    target_id: str,
    body_hash: str,
    nonce: str,
    timestamp: str,
) -> str:
    return "\n".join([method.upper(), path, workspace_id, target_id, body_hash, nonce, timestamp])


def _load_ec_public_key_from_jwk(jwk: dict[str, Any]) -> ec.EllipticCurvePublicKey:
    if jwk.get("kty") != "EC" or jwk.get("crv") != "P-256":
        raise ValueError("unsupported JWK")
    x_b = _b64url_decode(jwk["x"])
    y_b = _b64url_decode(jwk["y"])
    x = int.from_bytes(x_b, "big")
    y = int.from_bytes(y_b, "big")
    pub_numbers = ec.EllipticCurvePublicNumbers(x, y, ec.SECP256R1())
    return pub_numbers.public_key()


def _verify_ecdsa_p256_sha256(public_key: ec.EllipticCurvePublicKey, message: bytes, signature_b64url: str) -> bool:
    sig_bytes = _b64url_decode(signature_b64url)
    if len(sig_bytes) == 64:
        r = int.from_bytes(sig_bytes[:32], "big")
        s = int.from_bytes(sig_bytes[32:], "big")
        sig_bytes = utils.encode_dss_signature(r, s)
    try:
        public_key.verify(sig_bytes, message, ec.ECDSA(hashes.SHA256()))
    except crypto_exceptions.InvalidSignature:
        return False
    return True


def _parse_timestamp_iso(ts: str) -> float:
    s = ts.replace("Z", "+00:00")
    try:
        dt = datetime.fromisoformat(s)
    except ValueError as exc:
        raise ValueError("bad timestamp") from exc
    if dt.tzinfo is None:
        raise ValueError("timestamp must be UTC")
    return dt.timestamp()


def verify_signed_write_body(
    body: BaseModel,
    *,
    method: str,
    path: str,
    workspace_id: str,
    target_id: str,
) -> tuple[str | None, bool, str | None]:
    """
    Returns (actor_user_id, signed, signature_digest_hex).
    When no signing envelope is present, returns (None, False, None).
    """
    data = body.model_dump(mode="json")
    present = [k for k in SIGNING_FIELD_NAMES if data.get(k) is not None]
    if not present:
        return None, False, None
    if len(present) != len(SIGNING_FIELD_NAMES):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="signing envelope incomplete",
        )

    actor_user_id = data["actor_user_id"]
    public_key = data["public_key"]
    signature = data["signature"]
    nonce = data["nonce"]
    timestamp = data["timestamp"]
    body_hash = data["body_hash"]

    if not isinstance(actor_user_id, str) or not isinstance(public_key, dict):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid signing actor")

    derived = derive_user_id(public_key)
    if derived != actor_user_id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="actor_user_id mismatch")

    expected_hash = body_hash_from_model(body)
    if expected_hash != body_hash:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="body_hash mismatch")

    msg = build_canonical_message(
        method=method,
        path=path,
        workspace_id=workspace_id,
        target_id=target_id,
        body_hash=body_hash,
        nonce=str(nonce),
        timestamp=str(timestamp),
    ).encode("utf-8")

    try:
        pub = _load_ec_public_key_from_jwk(public_key)
    except (KeyError, ValueError) as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid public_key") from exc

    if not _verify_ecdsa_p256_sha256(pub, msg, str(signature)):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid signature")

    try:
        ts_unix = _parse_timestamp_iso(str(timestamp))
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="invalid timestamp") from exc

    now = time.time()
    if abs(now - ts_unix) > TS_MAX_SKEW_SEC:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="timestamp out of window")

    nonce_key = f"{workspace_id}\n{nonce}"
    _prune_nonces(now)
    if nonce_key in _seen_nonces:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="duplicate nonce")
    _seen_nonces[nonce_key] = now

    sig_digest = hashlib.sha256(str(signature).encode("ascii")).hexdigest()
    return actor_user_id, True, sig_digest
