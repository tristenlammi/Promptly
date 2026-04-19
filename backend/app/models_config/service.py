"""Persistence + mapping helpers for the Models tab."""
from __future__ import annotations

from app.auth.utils import encrypt_secret
from app.models_config.models import ModelProvider
from app.models_config.schemas import ModelInfo, ProviderResponse


def mask_key(encrypted_key: str | None) -> str | None:
    """Return a short UI-friendly preview of an API key without revealing it.

    We don't decrypt the stored value — instead we expose a static placeholder
    whenever any key is present. The UI only needs to know "is it set?" plus
    enough hint to disambiguate multiple providers, and the cheapest way to
    produce that without decryption is a fixed mask.
    """
    if not encrypted_key:
        return None
    return "sk-••••••••"


def provider_to_response(provider: ModelProvider) -> ProviderResponse:
    return ProviderResponse(
        id=provider.id,
        name=provider.name,
        type=provider.type,  # type: ignore[arg-type]
        base_url=provider.base_url,
        api_key_masked=mask_key(provider.api_key),
        enabled=provider.enabled,
        models=[ModelInfo(**m) for m in (provider.models or [])],
        enabled_models=provider.enabled_models,
        created_at=provider.created_at,
    )


def encrypt_api_key(plain: str) -> str:
    return encrypt_secret(plain)
