import base64
import json
import os
import hashlib
from collections import OrderedDict
from threading import Lock
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


CHECK_TEXT = "justwork"
KDF_ITERATIONS = 120_000
COLLABORATION_KDF_ITERATIONS = 310_000
COLLABORATION_MAGIC = b"JWC1"
_COLLABORATION_KEY_CACHE_MAX = 256
_collaboration_key_cache: OrderedDict[str, bytes] = OrderedDict()
_collaboration_key_cache_lock = Lock()


class InvalidWorkspacePassword(Exception):
    pass


def _b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def _unb64url(value: str) -> bytes:
    padded = value + ("=" * ((4 - len(value) % 4) % 4))
    return base64.urlsafe_b64decode(padded.encode("ascii"))


def _derive_key(password: str, salt: str, iterations: int) -> bytes:
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_unb64url(salt),
        iterations=iterations,
    )
    return kdf.derive(password.encode("utf-8"))


def _encrypt_box(key: bytes, plaintext: str) -> dict[str, str]:
    iv = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(iv, plaintext.encode("utf-8"), None)
    return {"iv": _b64url(iv), "ciphertext": _b64url(ciphertext)}


def _decrypt_box(key: bytes, box: dict[str, str]) -> str:
    plaintext = AESGCM(key).decrypt(_unb64url(box["iv"]), _unb64url(box["ciphertext"]), None)
    return plaintext.decode("utf-8")


def encrypt_workspace_payload(workspace_id: str, state: dict, password: str) -> str:
    salt = _b64url(os.urandom(16))
    key = _derive_key(password, salt, KDF_ITERATIONS)
    encrypted = {
        "version": 1,
        "workspaceId": workspace_id,
        "algorithm": "AES-GCM",
        "kdf": {
            "name": "PBKDF2",
            "hash": "SHA-256",
            "iterations": KDF_ITERATIONS,
            "salt": salt,
        },
        "check": _encrypt_box(key, CHECK_TEXT),
        "payload": _encrypt_box(key, json.dumps(state, ensure_ascii=False)),
    }
    return json.dumps(encrypted, separators=(",", ":"), ensure_ascii=False)


def decrypt_workspace_payload(encrypted_payload: str, password: str) -> dict:
    encrypted = json.loads(encrypted_payload)
    key = _derive_key(password, encrypted["kdf"]["salt"], encrypted["kdf"]["iterations"])
    try:
        check = _decrypt_box(key, encrypted["check"])
        if check != CHECK_TEXT:
            raise InvalidWorkspacePassword()
        plaintext = _decrypt_box(key, encrypted["payload"])
    except (InvalidTag, KeyError, ValueError, InvalidWorkspacePassword) as exc:
        raise InvalidWorkspacePassword("invalid workspace password") from exc
    return json.loads(plaintext)


def derive_workspace_collaboration_key(workspace_id: str, password: str) -> bytes:
    """Derive a stable, workspace-scoped key without persisting the password.

    The workspace id is a public, unique salt. A separate KDF domain keeps this
    key independent from the rotating salt used by the encrypted JSON payload.
    """
    salt = hashlib.sha256(f"justwork:collaboration:{workspace_id}".encode("utf-8")).digest()[:16]
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=salt,
        iterations=COLLABORATION_KDF_ITERATIONS,
    )
    return kdf.derive(password.encode("utf-8"))


def cached_workspace_collaboration_key(workspace_id: str, password: str) -> bytes:
    """Cache only the derived key after the caller verified the workspace password."""
    with _collaboration_key_cache_lock:
        existing = _collaboration_key_cache.get(workspace_id)
        if existing is not None:
            _collaboration_key_cache.move_to_end(workspace_id)
            return existing
    derived = derive_workspace_collaboration_key(workspace_id, password)
    with _collaboration_key_cache_lock:
        _collaboration_key_cache[workspace_id] = derived
        _collaboration_key_cache.move_to_end(workspace_id)
        while len(_collaboration_key_cache) > _COLLABORATION_KEY_CACHE_MAX:
            _collaboration_key_cache.popitem(last=False)
    return derived


def encrypt_collaboration_bytes(key: bytes, plaintext: bytes, *, aad: str) -> bytes:
    nonce = os.urandom(12)
    ciphertext = AESGCM(key).encrypt(nonce, plaintext, aad.encode("utf-8"))
    return COLLABORATION_MAGIC + nonce + ciphertext


def decrypt_collaboration_bytes(key: bytes, payload: bytes, *, aad: str) -> tuple[bytes, bool]:
    """Return plaintext and whether the input used the encrypted JWC1 format.

    Pre-0.0.7 rooms contained raw Yjs updates. Treating only values without the
    magic header as legacy lets a correct-password access migrate them safely.
    """
    if not payload.startswith(COLLABORATION_MAGIC):
        return payload, False
    if len(payload) < len(COLLABORATION_MAGIC) + 12 + 16:
        raise InvalidWorkspacePassword("invalid collaborative payload")
    nonce_start = len(COLLABORATION_MAGIC)
    nonce = payload[nonce_start:nonce_start + 12]
    ciphertext = payload[nonce_start + 12:]
    try:
        return AESGCM(key).decrypt(nonce, ciphertext, aad.encode("utf-8")), True
    except InvalidTag as exc:
        raise InvalidWorkspacePassword("invalid collaborative payload") from exc
