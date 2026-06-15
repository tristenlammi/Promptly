"""Workspaces — chat bundles with shared instructions, pinned files,
RAG, and collaborator sharing. Formerly "Chat Projects".

The ORM models (:class:`Workspace`, :class:`WorkspaceFile`,
:class:`WorkspaceShare`, :class:`ConversationExcludedWorkspaceFile`)
still live in :mod:`app.chat.models`; this package owns the router,
schemas, knowledge/RAG, and share lifecycle.
"""
