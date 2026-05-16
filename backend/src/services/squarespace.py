"""Async Squarespace content client.

Squarespace serves the Adepthood course (https://aptitude.guru) as a
site-password-protected Squarespace site.  This module:

* Authenticates with the site password once, persists the cookie jar.
* Fetches an arbitrary chapter/resource URL.
* Strips the Squarespace shell (header, navigation, footer) and returns
  the article body ready for in-app WebView rendering.
* Caches cleaned HTML in-memory with a configurable TTL so we are not
  hammering the public site on every read.

The cleaning step is intentionally conservative — Squarespace ships rich
formatting (images, embedded videos, captions) and the goal is to
preserve that, not turn it into Markdown.  Strip what is structurally
"Squarespace chrome", leave the article.

Configuration (env vars)
========================
* ``SQUARESPACE_SITE_PASSWORD`` — required.  The site-wide password set
  in the Squarespace admin and shared via Gumroad.
* ``SQUARESPACE_BASE_URL`` — optional override of the public site root
  (defaults to ``https://aptitude.guru``).
* ``SQUARESPACE_CACHE_TTL_SECONDS`` — optional cleaned-HTML TTL.  Default
  is one hour.

Testing
=======
The HTTP layer is hidden behind a single :class:`SquarespaceClient`
class that takes an injectable ``http_client_factory``.  Tests pass a
factory that returns a ``MockTransport``-backed ``httpx.AsyncClient``;
no network access is needed.
"""

from __future__ import annotations

import asyncio
import logging
import os
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Final
from urllib.parse import urlparse

import httpx
from bs4 import BeautifulSoup, Tag

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Configuration                                                               #
# --------------------------------------------------------------------------- #

_DEFAULT_BASE_URL: Final[str] = "https://aptitude.guru"
_DEFAULT_CACHE_TTL: Final[int] = 60 * 60  # 1 hour
_REQUEST_TIMEOUT_SECONDS: Final[float] = 10.0
_HTTP_ERROR_THRESHOLD: Final[int] = 400
_USER_AGENT: Final[str] = "AdepthoodApp/1.0 (+https://adepthood.com)"
#: Selectors we strip wholesale before returning the article body.  These
#: are intentionally Squarespace-generic — site theme changes occasionally
#: rename block classes, but the *roles* (header, footer, nav) are stable.
_CHROME_SELECTORS: Final[tuple[str, ...]] = (
    "header",
    "footer",
    "nav",
    "#siteWrapper > header",
    "#siteWrapper > footer",
    "[data-section-id='header']",
    "[data-section-id='footer']",
    ".sqs-announcement-bar-dropzone",
    ".header-announcement-bar-wrapper",
    ".sqs-cookie-banner-v2",
    ".sqs-cookie-banner-v2-acceptable",
    ".user-account-page",
    "script",
    "noscript",
)
#: Candidate selectors for the main article.  Tried in order.
_ARTICLE_SELECTORS: Final[tuple[str, ...]] = (
    "article",
    "main",
    "#content",
    "#page",
    ".content-wrapper",
)


# --------------------------------------------------------------------------- #
# Public types                                                                 #
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class FetchedContent:
    """A cleaned-up Squarespace page ready for in-app rendering."""

    url: str
    title: str
    body_html: str


class SquarespaceFetchError(RuntimeError):
    """Raised when Squarespace content cannot be retrieved or parsed."""


class SquarespaceAuthError(SquarespaceFetchError):
    """Raised when the site password is missing or rejected."""


# --------------------------------------------------------------------------- #
# Client                                                                       #
# --------------------------------------------------------------------------- #


HttpClientFactory = Callable[[], Awaitable[httpx.AsyncClient]]


def _resolve_base_url(override: str | None) -> str:
    """Pick the public Squarespace URL from the constructor arg or env."""
    resolved = override or os.getenv("SQUARESPACE_BASE_URL") or _DEFAULT_BASE_URL
    return resolved.rstrip("/")


def _resolve_password(override: str | None) -> str:
    """Pick the site password from the constructor arg or env."""
    if override is not None:
        return override
    return os.getenv("SQUARESPACE_SITE_PASSWORD", "")


def _resolve_cache_ttl(override: int | None) -> int:
    """Pick the cache TTL from the constructor arg or env."""
    if override is not None:
        return override
    return int(os.getenv("SQUARESPACE_CACHE_TTL_SECONDS", str(_DEFAULT_CACHE_TTL)))


def _default_http_client_factory() -> HttpClientFactory:
    """Return a factory that builds a fresh ``httpx.AsyncClient`` per session.

    A factory (rather than a singleton) is what tests need: each test
    constructs its own ``MockTransport`` and we don't want one test's
    transport leaking into the next.
    """

    async def factory() -> httpx.AsyncClient:
        return httpx.AsyncClient(
            timeout=_REQUEST_TIMEOUT_SECONDS,
            follow_redirects=True,
            headers={"User-Agent": _USER_AGENT},
        )

    return factory


@dataclass
class _CacheEntry:
    """A cached :class:`FetchedContent` together with its expiry timestamp."""

    content: FetchedContent
    expires_at: float


class SquarespaceClient:
    """Async client for fetching cleaned Squarespace pages.

    A single instance is shared per FastAPI process — see
    :func:`get_squarespace_client`.  All public methods are async and safe
    to call concurrently; an internal lock serialises authentication so
    only one re-login happens at a time during cookie expiry races.
    """

    def __init__(
        self,
        *,
        base_url: str | None = None,
        password: str | None = None,
        cache_ttl_seconds: int | None = None,
        http_client_factory: HttpClientFactory | None = None,
    ) -> None:
        """Construct a Squarespace client; defaults come from env vars."""
        self._base_url = _resolve_base_url(base_url)
        self._password = _resolve_password(password)
        self._cache_ttl = _resolve_cache_ttl(cache_ttl_seconds)
        self._client_factory = http_client_factory or _default_http_client_factory()
        self._client: httpx.AsyncClient | None = None
        self._auth_lock = asyncio.Lock()
        self._cache: dict[str, _CacheEntry] = {}
        self._authenticated = False

    # ------------------------------------------------------------------ #
    # Lifecycle                                                          #
    # ------------------------------------------------------------------ #

    async def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = await self._client_factory()
        return self._client

    async def aclose(self) -> None:
        """Release the underlying ``httpx.AsyncClient``."""
        if self._client is not None:
            await self._client.aclose()
            self._client = None
            self._authenticated = False

    def invalidate_cache(self, url: str | None = None) -> None:
        """Drop one URL (``url=...``) or the whole cache (``url=None``)."""
        if url is None:
            self._cache.clear()
        else:
            self._cache.pop(url, None)

    # ------------------------------------------------------------------ #
    # Auth                                                                #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _looks_like_password_page(html: str) -> bool:
        """Heuristic: does this HTML look like the Squarespace lock screen?

        We deliberately don't lean on a single selector — Squarespace
        themes vary — so we OR a few signals together.  False positives
        only cost a re-auth attempt.
        """
        soup = BeautifulSoup(html, "html.parser")
        if soup.find("input", attrs={"type": "password"}):
            return True
        body_class = " ".join(soup.body.get("class", [])) if soup.body else ""
        return "password" in body_class.lower() or "site-password" in html.lower()

    async def _authenticate(self) -> None:
        """POST the site password and capture the resulting cookie.

        Squarespace site-wide passwords are submitted to the same URL as
        the page being viewed; the server then sets a ``SiteUserInfo``-
        family cookie on the domain.  We send to the site root since the
        cookie applies site-wide.
        """
        if not self._password:
            raise SquarespaceAuthError(
                "SQUARESPACE_SITE_PASSWORD is not configured on the backend.",
            )
        client = await self._ensure_client()
        try:
            response = await client.post(
                f"{self._base_url}/",
                data={"password": self._password},
            )
        except httpx.HTTPError as exc:
            raise SquarespaceFetchError(f"Network error during auth: {exc}") from exc

        if response.status_code >= _HTTP_ERROR_THRESHOLD:
            raise SquarespaceAuthError(
                f"Squarespace rejected the site password (HTTP {response.status_code}).",
            )

        # If the post still returns a password page, the password was
        # accepted-but-not-set, or wrong.  Either way, fail loudly.
        if self._looks_like_password_page(response.text):
            raise SquarespaceAuthError("Squarespace password did not unlock the site.")

        self._authenticated = True
        logger.info("squarespace_authenticated", extra={"base_url": self._base_url})

    async def _ensure_authenticated(self) -> None:
        """Authenticate once per process unless the cookie has been cleared."""
        if self._authenticated:
            return
        async with self._auth_lock:
            if self._authenticated:
                return
            await self._authenticate()

    # ------------------------------------------------------------------ #
    # Fetch                                                               #
    # ------------------------------------------------------------------ #

    def _validate_url(self, url: str) -> None:
        """Reject URLs outside the configured site root.

        This is the SSRF guard: the same client is reused across requests,
        and we never want a caller passing ``http://internal.service`` to
        get proxied through us with an authenticated session.
        """
        parsed = urlparse(url)
        base = urlparse(self._base_url)
        if parsed.scheme != base.scheme or parsed.netloc != base.netloc:
            msg = f"URL {url!r} is outside the configured site ({self._base_url})."
            raise SquarespaceFetchError(msg)

    def _prune_expired(self, now: float) -> None:
        """Drop expired entries so the cache cannot grow without bound.

        Called from every ``fetch`` so the only growth is in *live*
        entries.  Intentionally O(n) on cache size — for the expected
        workload (a few dozen URLs over the program) this is cheaper
        than wiring an LRU.  If the cache ever has to hold more than a
        few hundred entries, swap to ``cachetools.TTLCache``.
        """
        stale = [key for key, entry in self._cache.items() if entry.expires_at <= now]
        for key in stale:
            self._cache.pop(key, None)

    async def fetch(self, url: str) -> FetchedContent:
        """Return cleaned HTML for ``url``, using the cache when fresh.

        Raises :class:`SquarespaceFetchError` on network errors,
        :class:`SquarespaceAuthError` when the site password is missing
        or wrong.

        Note: with multiple uvicorn workers each holds its own cache,
        so the worst-case fetch rate is ``WEB_CONCURRENCY`` per TTL
        window per URL — by design, since we want the cache local to
        the process for the lowest possible read latency.
        """
        now = time.time()
        self._validate_url(url)
        self._prune_expired(now)
        cached = self._cache.get(url)
        if cached is not None and cached.expires_at > now:
            return cached.content

        await self._ensure_authenticated()
        content = await self._fetch_and_clean(url)

        self._cache[url] = _CacheEntry(
            content=content,
            expires_at=now + self._cache_ttl,
        )
        return content

    async def _raw_get(self, url: str) -> httpx.Response:
        client = await self._ensure_client()
        try:
            return await client.get(url)
        except httpx.HTTPError as exc:
            raise SquarespaceFetchError(f"Network error fetching {url}: {exc}") from exc

    async def _fetch_and_clean(self, url: str) -> FetchedContent:
        response = await self._raw_get(url)

        # Session might have expired between authentication and this
        # request; if so, log in once more and retry exactly once.
        if response.status_code == httpx.codes.UNAUTHORIZED or self._looks_like_password_page(
            response.text
        ):
            self._authenticated = False
            await self._ensure_authenticated()
            response = await self._raw_get(url)

        if response.status_code >= _HTTP_ERROR_THRESHOLD:
            raise SquarespaceFetchError(
                f"Squarespace returned HTTP {response.status_code} for {url}.",
            )
        if self._looks_like_password_page(response.text):
            raise SquarespaceAuthError(
                f"Page {url} still locked after authentication.",
            )

        return _extract_article(url=url, html=response.text)


# --------------------------------------------------------------------------- #
# HTML cleaning                                                                #
# --------------------------------------------------------------------------- #


def _strip_chrome(soup: BeautifulSoup) -> None:
    """Remove header/nav/footer/cookie banners from the parsed document."""
    for selector in _CHROME_SELECTORS:
        for node in soup.select(selector):
            node.decompose()


def _pick_article(soup: BeautifulSoup) -> Tag:
    """Return the most article-like element in the document.

    Falls back to ``<body>`` when no semantic landmark matches — the
    chrome has already been stripped at this point, so a ``<body>`` fallback
    is still the content the user wants.
    """
    for selector in _ARTICLE_SELECTORS:
        node = soup.select_one(selector)
        if node is not None:
            return node
    body = soup.body
    if body is None:
        msg = "Squarespace document has no <body>"
        raise SquarespaceFetchError(msg)
    return body


def _document_title(soup: BeautifulSoup, article: Tag) -> str:
    """Best-effort article title — prefer ``<h1>`` inside the article."""
    h1 = article.find("h1")
    if h1 is not None:
        return str(h1.get_text(strip=True))
    title_tag = soup.find("title")
    if title_tag is not None:
        return str(title_tag.get_text(strip=True))
    return ""


def _extract_article(url: str, html: str) -> FetchedContent:
    """Parse ``html`` and return the cleaned article body + title."""
    soup = BeautifulSoup(html, "html.parser")
    _strip_chrome(soup)
    article = _pick_article(soup)
    title = _document_title(soup, article)
    return FetchedContent(url=url, title=title, body_html=str(article))


# --------------------------------------------------------------------------- #
# Module-level singleton                                                       #
# --------------------------------------------------------------------------- #


# Mutable container so we can replace the instance without ``global``
# (and therefore without a ruff PLW0603 suppression).  The dict has
# exactly one key — ``"client"`` — and its value is the lazily-built
# singleton or ``None``.
_state: dict[str, SquarespaceClient | None] = {"client": None}


def get_squarespace_client() -> SquarespaceClient:
    """Return the process-wide :class:`SquarespaceClient`, constructed lazily.

    Lazy construction means a test run without ``SQUARESPACE_SITE_PASSWORD``
    set never instantiates the client and therefore never reads the env var
    at import time.
    """
    client = _state["client"]
    if client is None:
        client = SquarespaceClient()
        _state["client"] = client
    return client


def set_squarespace_client_for_tests(client: SquarespaceClient | None) -> None:
    """Replace (or clear) the process-wide client.

    Tests use this to swap in a ``MockTransport``-backed double for the
    duration of a test, then restore the original at teardown.  Public
    on purpose — keeps the test contract on the module's public API and
    lets us drop the ``# noqa: SLF001`` suppressions the previous
    pattern required.
    """
    _state["client"] = client


def reset_squarespace_client_for_tests() -> None:
    """Drop the singleton so the next test sees a fresh client."""
    set_squarespace_client_for_tests(None)
