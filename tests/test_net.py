"""Circle's own HTTPS requests trust certifi when the program's OpenSSL points nowhere, as a
frozen release does; model discovery says so when a certificate check fails."""

from __future__ import annotations

import ssl
import sys
import urllib.error
from types import SimpleNamespace

import pytest

import circle.probe as probe
from circle.net import is_certificate_error, tls_context


@pytest.mark.skipif(sys.platform == "win32", reason="Windows uses its own certificate store")
def test_a_program_without_a_trust_store_uses_certifi(monkeypatch):
    monkeypatch.setattr(ssl, "get_default_verify_paths", lambda: SimpleNamespace(
        cafile="/nonexistent/cert.pem", capath="/nonexistent/certs"))
    loaded: list[str] = []
    real = ssl.SSLContext.load_verify_locations

    def remember(self, cafile=None, *args, **kwargs):
        loaded.append(cafile)
        return real(self, cafile, *args, **kwargs)

    monkeypatch.setattr(ssl.SSLContext, "load_verify_locations", remember)
    context = tls_context()
    assert loaded and loaded[0].endswith("cacert.pem")
    assert context.get_ca_certs(), "certifi's authorities are trusted"


def test_discovery_asks_with_that_context(monkeypatch):
    seen: dict = {}

    class Answer:
        status = 200

        def read(self):
            return b'{"data": [{"id": "m1"}]}'

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

    def urlopen(request, timeout=None, context=None):
        seen["context"] = context
        return Answer()

    monkeypatch.setattr(probe.urllib.request, "urlopen", urlopen)
    result = probe.resolve_endpoint("https://gateway.example/v1", "sk")
    assert result.models == ["m1"] and isinstance(seen["context"], ssl.SSLContext)


def test_a_certificate_failure_is_named_in_the_result(monkeypatch):
    def fail(*_args, **_kwargs):
        raise urllib.error.URLError(ssl.SSLCertVerificationError("certificate verify failed"))

    monkeypatch.setattr(probe, "_get", fail)
    result = probe.resolve_endpoint("https://gateway.example/v1", "sk")
    assert result.status == "failed"
    assert "TLS certificate could not be verified" in result.summary()
    assert "SSL_CERT_FILE" in result.summary()
    assert is_certificate_error(urllib.error.URLError(ssl.SSLCertVerificationError("x")))
    assert not is_certificate_error(urllib.error.URLError(ConnectionRefusedError()))
