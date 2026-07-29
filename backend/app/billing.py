from __future__ import annotations

import hashlib
import hmac
import json
import os
import time
from dataclasses import dataclass
from typing import Any

import httpx


class BillingConfigurationError(RuntimeError):
    pass


class BillingProviderError(RuntimeError):
    pass


@dataclass(frozen=True)
class PaidWorkspaceBillingConfig:
    enabled: bool
    checkout_mode: str
    price_id: str
    price_label: str


class StripeBillingService:
    def __init__(self) -> None:
        self._secret_key = os.getenv("STRIPE_SECRET_KEY", "").strip()
        self._webhook_secret = os.getenv("STRIPE_WEBHOOK_SECRET", "").strip()
        self._price_id = os.getenv("STRIPE_PAID_WORKSPACE_PRICE_ID", "").strip()
        requested_mode = os.getenv("STRIPE_PAID_WORKSPACE_CHECKOUT_MODE", "payment").strip().lower()
        self._checkout_mode = requested_mode if requested_mode in {"payment", "subscription"} else "payment"
        self._price_label = os.getenv("JUSTWORK_PAID_WORKSPACE_PRICE_LABEL", "Stripe Checkout").strip()
        self._public_base = os.getenv("JUSTWORK_PUBLIC_BASE_URL", "http://127.0.0.1:1446").strip().rstrip("/")
        self._api_base = os.getenv("STRIPE_API_BASE", "https://api.stripe.com").strip().rstrip("/")

    def config(self) -> PaidWorkspaceBillingConfig:
        return PaidWorkspaceBillingConfig(
            enabled=bool(self._secret_key and self._price_id),
            checkout_mode=self._checkout_mode,
            price_id=self._price_id,
            price_label=self._price_label or "Stripe Checkout",
        )

    def _require_enabled(self) -> None:
        if not self.config().enabled:
            raise BillingConfigurationError(
                "paid workspaces require STRIPE_SECRET_KEY and STRIPE_PAID_WORKSPACE_PRICE_ID"
            )

    def _request(
        self,
        method: str,
        path: str,
        *,
        data: list[tuple[str, str]] | None = None,
        idempotency_key: str | None = None,
    ) -> dict[str, Any]:
        self._require_enabled()
        headers = {"Authorization": f"Bearer {self._secret_key}"}
        if idempotency_key:
            headers["Idempotency-Key"] = idempotency_key
        try:
            response = httpx.request(
                method,
                f"{self._api_base}{path}",
                headers=headers,
                data=data,
                timeout=15.0,
            )
        except httpx.HTTPError as exc:
            raise BillingProviderError("Stripe is temporarily unavailable") from exc
        try:
            payload = response.json()
        except ValueError as exc:
            raise BillingProviderError("Stripe returned an invalid response") from exc
        if response.status_code >= 400:
            message = str(payload.get("error", {}).get("message", "Stripe request failed"))
            raise BillingProviderError(message)
        if not isinstance(payload, dict):
            raise BillingProviderError("Stripe returned an invalid response")
        return payload

    def create_paid_workspace_checkout(self, owner_user_id: str, purchase_token: str) -> dict[str, Any]:
        success_url = (
            f"{self._public_base}/billing/paid-workspace/success"
            "?session_id={CHECKOUT_SESSION_ID}"
        )
        cancel_url = f"{self._public_base}/billing/paid-workspace/cancel"
        data = [
            ("mode", self._checkout_mode),
            ("line_items[0][price]", self._price_id),
            ("line_items[0][quantity]", "1"),
            ("client_reference_id", owner_user_id),
            ("success_url", success_url),
            ("cancel_url", cancel_url),
            ("metadata[intent]", "paid_workspace"),
            ("metadata[purchase_token]", purchase_token),
            ("metadata[owner_user_id]", owner_user_id),
        ]
        metadata_prefix = "subscription_data" if self._checkout_mode == "subscription" else "payment_intent_data"
        data.extend(
            [
                (f"{metadata_prefix}[metadata][intent]", "paid_workspace"),
                (f"{metadata_prefix}[metadata][purchase_token]", purchase_token),
                (f"{metadata_prefix}[metadata][owner_user_id]", owner_user_id),
            ]
        )
        return self._request(
            "POST",
            "/v1/checkout/sessions",
            data=data,
            idempotency_key=f"paid-workspace:{purchase_token}",
        )

    def retrieve_checkout(self, session_id: str) -> dict[str, Any]:
        return self._request("GET", f"/v1/checkout/sessions/{session_id}")

    @staticmethod
    def checkout_is_paid(session: dict[str, Any]) -> bool:
        return session.get("status") == "complete" and session.get("payment_status") in {
            "paid",
            "no_payment_required",
        }

    def verify_webhook(self, payload: bytes, signature_header: str, tolerance_seconds: int = 300) -> dict[str, Any]:
        if not self._webhook_secret:
            raise BillingConfigurationError("STRIPE_WEBHOOK_SECRET is not configured")
        timestamp = ""
        signatures: list[str] = []
        for part in signature_header.split(","):
            key, separator, value = part.strip().partition("=")
            if not separator:
                continue
            if key == "t":
                timestamp = value
            elif key == "v1":
                signatures.append(value)
        try:
            timestamp_value = int(timestamp)
        except ValueError as exc:
            raise ValueError("invalid Stripe signature timestamp") from exc
        if abs(int(time.time()) - timestamp_value) > tolerance_seconds:
            raise ValueError("expired Stripe webhook signature")
        signed_payload = timestamp.encode("ascii") + b"." + payload
        expected = hmac.new(self._webhook_secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()
        if not any(hmac.compare_digest(expected, candidate) for candidate in signatures):
            raise ValueError("invalid Stripe webhook signature")
        event = json.loads(payload.decode("utf-8"))
        if not isinstance(event, dict) or not isinstance(event.get("id"), str):
            raise ValueError("invalid Stripe webhook event")
        return event
