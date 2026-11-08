"""Breach alerts for people's own email addresses, from Have I Been Pwned.

Kept apart from ``app.passwords`` on purpose. It never touches a vault: it works on
addresses the server already has (the account's, and connected Mail accounts'). Its
one secret, the admin's HIBP key, is Fernet-encrypted like the SMTP password, which
nothing in ``app.passwords`` may use. And the arq worker that runs it must not import
``app.passwords`` (``tests/test_passwords.py`` holds both). Passwords' Security page
reaches it through ``app.passwords.breaches``.
"""
