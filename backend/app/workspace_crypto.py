import base64
import json
import os
from dataclasses import dataclass

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC


CHECK_TEXT = "justwork"
KDF_ITERATIONS = 120_000


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
