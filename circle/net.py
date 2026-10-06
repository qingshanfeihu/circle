"""HTTPS for the requests Circle makes itself: model discovery, web fetch, web search and
updates. (The model clients use httpx, which brings its own certificates.)"""

from __future__ import annotations

import os
import ssl
import sys


def tls_context() -> ssl.SSLContext:
    """The system's trust store. A frozen program can be left without one: Python builds point
    OpenSSL at a certificate file that only exists on the machine that built them, and every
    HTTPS request then fails its certificate check. In that case fall back to the bundle that
    ships with certifi (httpx, which the model clients use, needs it anyway). Windows reads its
    own certificate store, so nothing is added there. ``SSL_CERT_FILE`` still wins."""
    context = ssl.create_default_context()
    if sys.platform == "win32":
        return context
    paths = ssl.get_default_verify_paths()
    if any(p and os.path.exists(p) for p in (paths.cafile, paths.capath)):
        return context
    try:
        import certifi

        context.load_verify_locations(certifi.where())
    except (ImportError, OSError):
        pass
    return context


def is_certificate_error(exc: BaseException) -> bool:
    """A failed certificate check, possibly wrapped in a URLError."""
    reason = getattr(exc, "reason", exc)
    return isinstance(reason, ssl.SSLCertVerificationError) or (
        isinstance(reason, ssl.SSLError) and "CERTIFICATE" in str(reason).upper())
