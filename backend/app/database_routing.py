from __future__ import annotations

import base64
import hashlib
import os
from urllib.parse import urlparse

from cryptography.fernet import Fernet, InvalidToken


class DatabaseRoutingConfigurationError(RuntimeError):
    pass


def validate_custom_database_url(database_url: str) -> str:
    normalized = database_url.strip()
    parsed = urlparse(normalized)
    if parsed.scheme not in {"postgres", "postgresql"}:
        raise ValueError("custom database must use a PostgreSQL connection URL")
    if not parsed.hostname or not parsed.path or parsed.path == "/":
        raise ValueError("custom database URL must include a host and database name")
    if parsed.username is None:
        raise ValueError("custom database URL must include database credentials")
    return normalized


def _routing_cipher() -> Fernet:
    secret = os.getenv("JUSTWORK_DATABASE_ROUTING_SECRET", "").strip()
    if len(secret) < 32:
        raise DatabaseRoutingConfigurationError(
            "JUSTWORK_DATABASE_ROUTING_SECRET must contain at least 32 characters"
        )
    key = base64.urlsafe_b64encode(hashlib.sha256(secret.encode("utf-8")).digest())
    return Fernet(key)


def encrypt_database_url(database_url: str) -> str:
    normalized = validate_custom_database_url(database_url)
    return _routing_cipher().encrypt(normalized.encode("utf-8")).decode("ascii")


def decrypt_database_url(ciphertext: str) -> str:
    try:
        value = _routing_cipher().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except (InvalidToken, UnicodeDecodeError, ValueError) as exc:
        raise DatabaseRoutingConfigurationError("custom database route cannot be decrypted") from exc
    return validate_custom_database_url(value)
