"""A link to this server's map, for anything that draws one."""
from __future__ import annotations

import asyncio

from app.auth.models import User


async def basemap_link(user: User) -> str | None:
    from app.files import media_urls

    from . import data

    path = await asyncio.to_thread(data.basemap_path)
    if path is None:
        return None
    return media_urls.sign_basemap(user.id, user.token_version, await asyncio.to_thread(data.basemap_tag, path))
