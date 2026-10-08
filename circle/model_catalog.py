"""What Circle knows about a model: its context window, its output limit and its
pay-as-you-go price, all from models.dev.

- **The data.** A trimmed snapshot of models.dev ships with Circle
  (``circle/data/models_dev.json.gz``). A newer copy is kept in
  ``~/.circle/cache/models-dev.json``: once it is a day old, Circle fetches
  https://models.dev/api.json again in the background. Without the network the copy or the
  snapshot answers.
- **Which entry.** models.dev lists a model once per provider, and the same model can have a
  different window or price at another provider. Circle takes the entries of the providers
  whose API host is the host of the configured base URL. Providers whose own SDK knows the
  address (Anthropic, OpenAI, Google …) have none in models.dev; their usual host is in
  ``_SDK_HOSTS``.
- **The window** is ``settings.models["<model>"]["context_window"]`` when set, else the
  models.dev entry's ``limit.context``, else 128,000 (pi's fallback). The footer and the
  automatic compaction use this one number; a fallback window is shown as ``N/A``.
- **The price** is the pay-as-you-go one, in US dollars per million tokens. When the host
  has both a pay-as-you-go and a subscription entry (``…-coding-plan``, ``…-token-plan``),
  the pay-as-you-go one counts. When it has only a subscription, whose models.dev prices are
  0, the same vendor's pay-as-you-go entry is the reference (``alibaba-token-plan-cn`` →
  ``alibaba-cn``). No price is shown as ``N/A``.
"""

from __future__ import annotations

import gzip
import json
import logging
import os
import re
import threading
import time
import urllib.request
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

SOURCE_URL = "https://models.dev/api.json"
SNAPSHOT = Path(__file__).resolve().parent / "data" / "models_dev.json.gz"
SCHEMA = "circle.models-dev/v1"
CACHE_NAME = "models-dev.json"
REFRESH_AFTER_S = 24 * 3600
FALLBACK_WINDOW = 128_000
TIER_KEY = "context_over_200k"
_PRICE_KEYS = ("input", "output", "cache_read", "cache_write")

# models.dev gives no API address for providers whose own SDK knows it
_SDK_HOSTS = {
    "api.anthropic.com": "anthropic",
    "api.openai.com": "openai",
    "generativelanguage.googleapis.com": "google",
    "api.x.ai": "xai",
    "api.mistral.ai": "mistral",
    "api.groq.com": "groq",
    "api.together.xyz": "togetherai",
    "api.deepinfra.com": "deepinfra",
    "api.cerebras.ai": "cerebras",
    "api.perplexity.ai": "perplexity",
}
# The host of a connection that has no base URL (an OAuth sign-in)
_PROTOCOL_HOSTS = {"anthropic": "api.anthropic.com", "openai": "api.openai.com"}
# A subscription provider; its pay-as-you-go twin is the same id without this part
_PLAN = re.compile(r"-(?:coding|code|token|step)-plan")
# … or, where that id does not exist, this one (whose model ids may carry the vendor's prefix)
_PLAN_TWINS = {"kimi-code-plan-cn": ("moonshotai-cn", "kimi-"),
               "kimi-code-plan-global": ("moonshotai", "kimi-")}
# Providers that are the model's own vendor: by name, their entry is the reference
_VENDORS = tuple(dict.fromkeys(_SDK_HOSTS.values()))


# ── the data ─────────────────────────────────────────────────────────────


def _number(value: Any) -> float | None:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    return float(value) if value >= 0 else None


def _prices(cost: Any) -> dict[str, Any]:
    if not isinstance(cost, Mapping):
        return {}
    out: dict[str, Any] = {}
    for key in _PRICE_KEYS:
        number = _number(cost.get(key))
        if number is not None:
            out[key] = number
    tier = cost.get(TIER_KEY)
    if isinstance(tier, Mapping):
        rates = {key: number for key in _PRICE_KEYS
                 if (number := _number(tier.get(key))) is not None}
        if rates:
            out[TIER_KEY] = rates
    return out


def slim(raw: Any) -> dict[str, Any]:
    """The parts of models.dev's ``api.json`` Circle reads: each provider's API address and,
    per model, the context window, the output limit and the prices."""
    providers: dict[str, Any] = {}
    for pid, provider in (raw.items() if isinstance(raw, Mapping) else ()):
        if not isinstance(provider, Mapping):
            continue
        models: dict[str, Any] = {}
        raw_models = provider.get("models")
        for mid, model in (raw_models.items() if isinstance(raw_models, Mapping) else ()):
            if not isinstance(model, Mapping):
                continue
            limit = model.get("limit") if isinstance(model.get("limit"), Mapping) else {}
            entry: dict[str, Any] = {}
            for key in ("context", "output"):
                value = limit.get(key)
                if isinstance(value, int) and not isinstance(value, bool) and value > 0:
                    entry[key] = value
            prices = _prices(model.get("cost"))
            if prices:
                entry["cost"] = prices
            if entry:
                models[str(mid)] = entry
        if models:
            providers[str(pid)] = {"api": str(provider.get("api") or ""), "models": models}
    return {"schema": SCHEMA, "providers": providers}


def _whole(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value > 0


def _valid(data: Any) -> bool:
    """The shape ``slim`` writes, all the way down: a copy written by another version of
    Circle, or damaged, is not used (the snapshot answers instead)."""
    if not (isinstance(data, Mapping) and data.get("schema") == SCHEMA
            and isinstance(data.get("providers"), Mapping) and data["providers"]):
        return False
    for provider in data["providers"].values():
        if not (isinstance(provider, Mapping) and isinstance(provider.get("api", ""), str)
                and isinstance(provider.get("models"), Mapping)):
            return False
        for entry in provider["models"].values():
            if not isinstance(entry, Mapping):
                return False
            if any(key in entry and not _whole(entry[key]) for key in ("context", "output")):
                return False
            if "cost" in entry and not isinstance(entry["cost"], Mapping):
                return False
    return True


def cache_path(home: Path | None = None) -> Path:
    from circle.paths import circle_home

    return circle_home(home) / "cache" / CACHE_NAME


def _read_cache(home: Path | None) -> dict[str, Any] | None:
    try:
        data = json.loads(cache_path(home).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    return data if _valid(data) else None


def _read_snapshot() -> dict[str, Any] | None:
    try:
        data = json.loads(gzip.decompress(SNAPSHOT.read_bytes()).decode("utf-8"))
    except (OSError, ValueError, EOFError):
        logger.warning("models.dev snapshot unreadable: %s", SNAPSHOT, exc_info=True)
        return None
    return data if _valid(data) else None


@dataclass
class _Store:
    lock: threading.RLock = field(default_factory=threading.RLock)
    providers: dict[str, Any] | None = None
    source: str = ""
    home: Path | None = None
    generation: int = 0


_store = _Store()


def _providers() -> dict[str, Any]:
    with _store.lock:
        if _store.providers is None:
            data = _read_cache(_store.home)
            source = "cache"
            if data is None:
                data, source = _read_snapshot(), "snapshot"
            _store.providers = dict((data or {}).get("providers") or {})
            _store.source = source if data else ""
        return _store.providers


def reset(home: Path | None = None) -> None:
    """Forget what is loaded and read it again from ``home``'s copy or the snapshot (the
    start of a session; each test, with a home of its own)."""
    with _store.lock:
        _store.providers = None
        _store.source = ""
        _store.home = home
        _store.generation += 1
        _facts_cache.clear()


def set_catalog(data: Mapping[str, Any] | None, *, source: str = "test") -> None:
    """Replace what is loaded (``None`` reloads from the cache or the snapshot). For tests,
    and for a refresh that has just written a new copy."""
    with _store.lock:
        _store.providers = dict(data.get("providers") or {}) if data is not None else None
        _store.source = source if data is not None else ""
        _store.generation += 1
        _facts_cache.clear()


def source() -> str:
    """Where the loaded data came from: ``cache``, ``snapshot``, ``test`` or ``""``."""
    _providers()
    return _store.source


# ── refreshing ───────────────────────────────────────────────────────────


def fetch(timeout: float = 20.0) -> Any:
    """models.dev's ``api.json``, parsed. Its CDN refuses Python's default User-Agent."""
    from circle import __version__
    from circle.net import tls_context

    request = urllib.request.Request(SOURCE_URL, headers={
        "User-Agent": f"circle/{__version__}", "Accept": "application/json"})
    with urllib.request.urlopen(request, timeout=timeout,  # noqa: S310 — https only
                                context=tls_context()) as response:
        return json.loads(response.read().decode("utf-8"))


def refresh(home: Path | None = None, *, timeout: float = 20.0) -> bool:
    """Fetch models.dev now, keep the trimmed copy and use it. False when it failed."""
    try:
        data = slim(fetch(timeout))
    except Exception:  # noqa: BLE001 — offline or a changed format: keep what is there
        logger.debug("models.dev refresh failed", exc_info=True)
        return False
    if not _valid(data):
        return False
    path = cache_path(home)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + ".tmp")
        tmp.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")),
                       encoding="utf-8")
        os.replace(tmp, path)
    except OSError:
        logger.debug("models.dev copy not written", exc_info=True)
    set_catalog(data, source="cache")
    return True


def refresh_in_background(home: Path | None = None, *, max_age_s: float = REFRESH_AFTER_S,
                          on_refreshed: Callable[[], None] | None = None
                          ) -> threading.Thread | None:
    """Fetch models.dev in a background thread when the kept copy is missing or older than a
    day; ``on_refreshed`` runs in that thread after new data is in use. Returns the thread,
    or ``None`` when the copy is fresh."""
    with _store.lock:
        _store.home = home
    if os.environ.get("CIRCLE_NO_MODELS_REFRESH"):
        return None
    try:
        age = time.time() - cache_path(home).stat().st_mtime
    except OSError:
        age = float("inf")
    if age < max_age_s:
        return None

    def work() -> None:
        if refresh(home) and on_refreshed is not None:
            try:
                on_refreshed()
            except Exception:  # noqa: BLE001 — a display update must not kill the thread
                logger.debug("models.dev refresh callback failed", exc_info=True)

    thread = threading.Thread(target=work, name="circle-models-dev", daemon=True)
    thread.start()
    return thread


# ── which entry, and what it says ────────────────────────────────────────


@dataclass(frozen=True)
class Endpoint:
    host: str = ""
    windows: tuple[tuple[str, int], ...] = ()


_endpoint = Endpoint()


def host_of(base_url: str, protocol: str = "") -> str:
    host = (urlparse(base_url or "").hostname or "").lower()
    return host or _PROTOCOL_HOSTS.get(protocol or "", "")


def window_overrides(models: Any) -> dict[str, int]:
    """``settings.models`` → ``{model: context_window}``; entries without a positive whole
    number are left out."""
    out: dict[str, int] = {}
    for name, entry in (models.items() if isinstance(models, Mapping) else ()):
        value = entry.get("context_window") if isinstance(entry, Mapping) else None
        if isinstance(value, int) and not isinstance(value, bool) and value > 0:
            out[str(name)] = value
    return out


def bind(settings: Any) -> None:
    """Use this connection's host and window overrides from now on (the model being built)."""
    auth = getattr(settings, "auth", None)
    bind_endpoint(str(getattr(auth, "base_url", "") or ""),
                  str(getattr(auth, "protocol", "") or ""),
                  window_overrides(getattr(settings, "models", None)))


def bind_endpoint(base_url: str = "", protocol: str = "",
                  windows: Mapping[str, int] | None = None) -> None:
    global _endpoint
    with _store.lock:
        _endpoint = Endpoint(host_of(base_url, protocol),
                             tuple(sorted((windows or {}).items())))
        _facts_cache.clear()


@dataclass(frozen=True)
class ModelFacts:
    model: str
    context_window: int
    window_known: bool
    window_source: str  # "settings" | "models.dev" | "fallback"
    output_limit: int | None
    rates: Mapping[str, Any] | None  # USD per million tokens; None = no price known
    provider: str  # the models.dev provider the window came from
    price_provider: str  # … and the price


def _find(models: Mapping[str, Any], model: str) -> Mapping[str, Any] | None:
    if model in models:
        return models[model]
    low = model.lower()
    tail = low.rsplit("/", 1)[-1]
    for mid, entry in models.items():
        name = mid.lower()
        if name == low or name.rsplit("/", 1)[-1] == tail:
            return entry
    return None


def _priced(entry: Mapping[str, Any]) -> bool:
    cost = entry.get("cost") or {}
    return any((cost.get(key) or 0) > 0 for key in ("input", "output"))


def _choose(providers: Mapping[str, Any], model: str, host: str
            ) -> tuple[tuple[str, Mapping[str, Any]] | None, tuple[str, Mapping[str, Any]] | None]:
    """``(entry for the window, entry for the price)``, each as ``(provider id, entry)``."""
    if not host or not model:
        return None, None
    ids = sorted(pid for pid, provider in providers.items()
                 if host_of(str(provider.get("api") or "")) == host)
    sdk = _SDK_HOSTS.get(host)
    if sdk and sdk in providers and sdk not in ids:
        ids.append(sdk)
    found = [(pid, entry) for pid in ids
             if (entry := _find(providers[pid].get("models") or {}, model)) is not None]
    if not found:
        return None, None
    order = lambda item: (bool(_PLAN.search(item[0])), item[0])  # noqa: E731
    paid = sorted((item for item in found if _priced(item[1])), key=order)
    if paid:
        return paid[0], paid[0]
    window = sorted(found, key=order)[0]
    for pid, _entry in found:
        if _PLAN.search(pid):
            twin, prefix = _PLAN_TWINS.get(pid, (_PLAN.sub("", pid), ""))
            twin_models = (providers.get(twin) or {}).get("models") or {}
            entry = _find(twin_models, model)
            if entry is None and prefix:
                entry = _find(twin_models, prefix + model)
            if entry is not None and _priced(entry):
                return window, (twin, entry)
    if not _PLAN.search(window[0]) and "cost" in window[1]:
        return window, window  # a free endpoint (a local server): models.dev says it costs 0
    return window, None


def _by_name(providers: Mapping[str, Any], model: str
             ) -> tuple[tuple[str, Mapping[str, Any]] | None, tuple[str, Mapping[str, Any]] | None]:
    """For a host models.dev does not list (a gateway, a proxy, a server of your own): the
    model by its name, the vendor's own entry first, a subscription's last."""
    if not model:
        return None, None
    found = [(pid, entry) for pid, provider in providers.items()
             if (entry := _find(provider.get("models") or {}, model)) is not None]
    order = lambda item: (item[0] not in _VENDORS, bool(_PLAN.search(item[0])), item[0])  # noqa: E731
    sized = sorted((item for item in found if isinstance(item[1].get("context"), int)), key=order)
    paid = sorted((item for item in found if _priced(item[1])), key=order)
    return (sized[0] if sized else None), (paid[0] if paid else None)


_facts_cache: dict[tuple[str, Endpoint, int], ModelFacts] = {}


def _env_window() -> int | None:
    """``CIRCLE_MODEL_CTX``: one window for every model (a setting per model wins)."""
    raw = (os.environ.get("CIRCLE_MODEL_CTX") or "").strip().replace("_", "")
    try:
        value = int(raw)
    except ValueError:
        return None
    return value if value > 0 else None


def facts(model: str) -> ModelFacts:
    """What the bound endpoint's model looks like: see the module docstring for the rules."""
    model = str(model or "").strip()
    with _store.lock:
        key = (model, _endpoint, _store.generation)
        cached = _facts_cache.get(key)
        if cached is not None:
            return cached
        endpoint = _endpoint
        providers = _providers()
        window_item, price_item = _choose(providers, model, endpoint.host)
        if window_item is None or price_item is None:
            # the host is not in models.dev, or does not list this model: go by its name
            named_window, named_price = _by_name(providers, model)
            if window_item is None:
                window_item = named_window
            if price_item is None and named_price is not None and (
                    window_item is None or _PLAN.search(window_item[0])
                    or window_item is named_window):
                price_item = named_price
        overrides = dict(endpoint.windows)
        window_entry = window_item[1] if window_item else {}
        every = _env_window()
        if model in overrides:
            window, known, origin = overrides[model], True, "settings"
        elif every:
            window, known, origin = every, True, "settings"
        elif isinstance(window_entry.get("context"), int):
            window, known, origin = int(window_entry["context"]), True, "models.dev"
        else:
            window, known, origin = FALLBACK_WINDOW, False, "fallback"
        output = window_entry.get("output")
        result = ModelFacts(
            model=model, context_window=window, window_known=known, window_source=origin,
            output_limit=int(output) if isinstance(output, int) else None,
            rates=dict(price_item[1].get("cost") or {}) if price_item else None,
            provider=window_item[0] if window_item else "",
            price_provider=price_item[0] if price_item else "",
        )
        _facts_cache[key] = result
        return result
