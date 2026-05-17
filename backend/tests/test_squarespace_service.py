"""Unit tests for :mod:`services.squarespace`.

These tests never hit the network.  Each test builds an ``httpx.MockTransport``
that responds to specific URLs, hands it to a :class:`SquarespaceClient`
via the ``http_client_factory`` injection point, and asserts the visible
behaviour.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable

import pytest
from httpx import AsyncClient, MockTransport, Request, Response

from services.squarespace import (
    SquarespaceAuthError,
    SquarespaceClient,
    SquarespaceFetchError,
    _extract_article,
)

_PASSWORD_PAGE = """
<!doctype html><html><head><title>Locked</title></head>
<body class="site-password">
  <form method="post">
    <input type="password" name="password" />
  </form>
</body></html>
""".strip()

_ARTICLE_PAGE = """
<!doctype html><html><head><title>Chapter 1</title></head>
<body>
  <header>SITE HEADER</header>
  <nav>SITE NAV</nav>
  <article>
    <h1>Chapter 1: The Body Calls</h1>
    <p>This is the body content.</p>
  </article>
  <footer>SITE FOOTER</footer>
</body></html>
""".strip()

_BASE_URL = "https://aptitude.guru"
_CHAPTER_URL = f"{_BASE_URL}/course/beige-1"


def _build_factory(
    transport: MockTransport,
) -> Callable[[], Awaitable[AsyncClient]]:
    """Wrap a ``MockTransport`` in the factory shape the client expects."""

    async def factory() -> AsyncClient:
        return AsyncClient(transport=transport, follow_redirects=True)

    return factory


@pytest.mark.asyncio
async def test_fetch_authenticates_once_then_returns_clean_article() -> None:
    """First call: auth POST, then GET. Subsequent calls reuse the cookie."""
    auth_posts: list[Request] = []
    page_gets: list[Request] = []

    def handler(request: Request) -> Response:
        if request.method == "POST" and request.url.path == "/course/beige-1":
            auth_posts.append(request)
            return Response(200, html="<html><body>OK</body></html>")
        if request.method == "GET" and request.url.path == "/course/beige-1":
            page_gets.append(request)
            return Response(200, html=_ARTICLE_PAGE)
        return Response(404)

    transport = MockTransport(handler)
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="open-sesame",  # pragma: allowlist secret
        http_client_factory=_build_factory(transport),
        cache_ttl_seconds=60,
    )

    fetched = await client.fetch(_CHAPTER_URL)

    assert "Chapter 1" in fetched.title
    assert "<article>" in fetched.body_html
    assert "SITE HEADER" not in fetched.body_html
    assert "SITE FOOTER" not in fetched.body_html
    assert len(auth_posts) == 1
    assert len(page_gets) == 1

    # Second fetch hits the cache — no extra GET, no re-auth.
    await client.fetch(_CHAPTER_URL)
    assert len(page_gets) == 1
    assert len(auth_posts) == 1

    await client.aclose()


@pytest.mark.asyncio
async def test_fetch_reauthenticates_when_session_expires() -> None:
    """If a GET comes back as the password page, the client retries auth."""
    request_log: list[tuple[str, str]] = []
    gets = 0

    def handler(request: Request) -> Response:
        nonlocal gets
        request_log.append((request.method, request.url.path))
        if request.method == "POST" and request.url.path == "/course/beige-1":
            return Response(200, html="<html><body>OK</body></html>")
        if request.method == "GET" and request.url.path == "/course/beige-1":
            gets += 1
            # First GET pretends the session has expired.
            if gets == 1:
                return Response(200, html=_PASSWORD_PAGE)
            return Response(200, html=_ARTICLE_PAGE)
        return Response(404)

    transport = MockTransport(handler)
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="open-sesame",  # pragma: allowlist secret
        http_client_factory=_build_factory(transport),
    )

    fetched = await client.fetch(_CHAPTER_URL)
    assert "<article>" in fetched.body_html
    # Initial auth POST, first GET (locked), re-auth POST, second GET (article).
    methods = [m for m, _ in request_log]
    assert methods.count("POST") == 2
    assert methods.count("GET") == 2
    await client.aclose()


@pytest.mark.asyncio
async def test_missing_password_raises_auth_error() -> None:
    """An empty password is fail-fast, not a silent 401."""
    transport = MockTransport(lambda _r: Response(200, html="<html></html>"))
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="",
        http_client_factory=_build_factory(transport),
    )
    with pytest.raises(SquarespaceAuthError):
        await client.fetch(_CHAPTER_URL)
    await client.aclose()


@pytest.mark.asyncio
async def test_wrong_password_raises_auth_error() -> None:
    """If the auth POST still returns a password page, we surface AuthError."""

    def handler(request: Request) -> Response:
        if request.method == "POST":
            return Response(200, html=_PASSWORD_PAGE)
        return Response(404)

    transport = MockTransport(handler)
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="wrong",  # pragma: allowlist secret
        http_client_factory=_build_factory(transport),
    )
    with pytest.raises(SquarespaceAuthError):
        await client.fetch(_CHAPTER_URL)
    await client.aclose()


@pytest.mark.asyncio
async def test_upstream_5xx_raises_fetch_error() -> None:
    """A 5xx response from Squarespace becomes :class:`SquarespaceFetchError`."""

    def handler(request: Request) -> Response:
        if request.method == "POST":
            return Response(200, html="<html></html>")
        return Response(503)

    transport = MockTransport(handler)
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="ok",  # pragma: allowlist secret
        http_client_factory=_build_factory(transport),
    )
    with pytest.raises(SquarespaceFetchError):
        await client.fetch(_CHAPTER_URL)
    await client.aclose()


@pytest.mark.asyncio
async def test_rejects_off_site_urls() -> None:
    """SSRF guard: a URL outside ``base_url`` is rejected before any I/O."""
    transport = MockTransport(lambda _r: Response(200))
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="ok",  # pragma: allowlist secret
        http_client_factory=_build_factory(transport),
    )
    with pytest.raises(SquarespaceFetchError):
        await client.fetch("https://attacker.example/internal")
    await client.aclose()


@pytest.mark.asyncio
async def test_invalidate_cache_forces_refetch() -> None:
    """After ``invalidate_cache``, the next fetch hits the network again."""
    gets = 0

    def handler(request: Request) -> Response:
        nonlocal gets
        if request.method == "POST":
            return Response(200, html="<html></html>")
        if request.method == "GET":
            gets += 1
            return Response(200, html=_ARTICLE_PAGE)
        return Response(404)

    transport = MockTransport(handler)
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="ok",  # pragma: allowlist secret
        http_client_factory=_build_factory(transport),
    )
    await client.fetch(_CHAPTER_URL)
    await client.fetch(_CHAPTER_URL)  # cached
    assert gets == 1

    client.invalidate_cache(_CHAPTER_URL)
    await client.fetch(_CHAPTER_URL)
    assert gets == 2

    client.invalidate_cache()
    await client.fetch(_CHAPTER_URL)
    assert gets == 3
    await client.aclose()


@pytest.mark.asyncio
async def test_fetch_skips_auth_for_public_pages() -> None:
    """Public pages outside ``/course`` are not gated and must skip auth."""
    auth_posts: list[Request] = []
    page_gets: list[Request] = []

    def handler(request: Request) -> Response:
        if request.method == "POST":
            auth_posts.append(request)
            return Response(200, html="<html><body>OK</body></html>")
        if request.method == "GET" and request.url.path == "/about":
            page_gets.append(request)
            return Response(200, html=_ARTICLE_PAGE)
        return Response(404)

    transport = MockTransport(handler)
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="open-sesame",  # pragma: allowlist secret
        http_client_factory=_build_factory(transport),
    )

    await client.fetch(f"{_BASE_URL}/about")

    assert len(auth_posts) == 0
    assert len(page_gets) == 1
    await client.aclose()


@pytest.mark.asyncio
async def test_fetch_public_page_works_when_password_unset() -> None:
    """A missing password must not break public-page fetches."""
    page_gets: list[Request] = []

    def handler(request: Request) -> Response:
        if request.method == "GET" and request.url.path == "/philosophy":
            page_gets.append(request)
            return Response(200, html=_ARTICLE_PAGE)
        return Response(404)

    transport = MockTransport(handler)
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="",
        http_client_factory=_build_factory(transport),
    )

    fetched = await client.fetch(f"{_BASE_URL}/philosophy")
    assert "<article>" in fetched.body_html
    assert len(page_gets) == 1
    await client.aclose()


@pytest.mark.asyncio
async def test_public_page_401_does_not_trigger_reauth() -> None:
    """A 401 on a public URL must surface as a fetch error, not re-auth.

    ``_requires_auth`` documents the public-page contract; the
    ``_fetch_and_clean`` retry path must honour it or a misconfigured
    public page would attempt to authenticate with an empty password
    and surface ``SquarespaceAuthError`` instead of the real upstream
    failure.
    """
    auth_posts: list[Request] = []

    def handler(request: Request) -> Response:
        if request.method == "POST":
            auth_posts.append(request)
            return Response(200, html="<html><body>OK</body></html>")
        if request.method == "GET" and request.url.path == "/philosophy":
            return Response(401, html="<html><body>Forbidden</body></html>")
        return Response(404)

    transport = MockTransport(handler)
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="open-sesame",  # pragma: allowlist secret
        http_client_factory=_build_factory(transport),
    )

    with pytest.raises(SquarespaceFetchError):
        await client.fetch(f"{_BASE_URL}/philosophy")
    assert len(auth_posts) == 0
    await client.aclose()


@pytest.mark.asyncio
async def test_auth_failure_logs_response_details(
    caplog: pytest.LogCaptureFixture,
) -> None:
    """On a 4xx auth response, the warning log carries enough to debug."""

    def handler(request: Request) -> Response:
        if request.method == "POST":
            return Response(
                403,
                text="Host not in allowlist",
                headers={"content-type": "text/plain", "server": "envoy"},
            )
        return Response(404)

    transport = MockTransport(handler)
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="open-sesame",  # pragma: allowlist secret
        http_client_factory=_build_factory(transport),
    )

    with (
        caplog.at_level("WARNING", logger="services.squarespace"),
        pytest.raises(SquarespaceAuthError),
    ):
        await client.fetch(_CHAPTER_URL)

    record = next(r for r in caplog.records if r.message == "squarespace_auth_http_error")
    # ``logger.warning(..., extra={...})`` merges the dict into the record's
    # ``__dict__`` but those attributes are invisible to static analysis.
    fields = record.__dict__
    assert fields["status"] == 403
    assert fields["auth_url"] == _CHAPTER_URL
    assert "Host not in allowlist" in fields["body_preview"]
    assert fields["content_type"] == "text/plain"
    await client.aclose()


@pytest.mark.asyncio
async def test_auth_posts_password_to_target_url() -> None:
    """The auth POST goes to the URL we're fetching, not a hardcoded path.

    Squarespace's section-scoped password gate is configured on real
    pages — POSTing to a non-existent section root returns 404 even
    when the password is correct.  Verifying the POST target equals
    the requested URL pins the fix for the production regression where
    we POSTed to ``/course`` (which 404s on aptitude.guru) instead of
    ``/course/beige-1`` (a real page).
    """
    posted_paths: list[str] = []

    def handler(request: Request) -> Response:
        if request.method == "POST":
            posted_paths.append(request.url.path)
            return Response(200, html="<html><body>OK</body></html>")
        if request.method == "GET" and request.url.path == "/course/beige-1":
            return Response(200, html=_ARTICLE_PAGE)
        return Response(404)

    transport = MockTransport(handler)
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="open-sesame",  # pragma: allowlist secret
        http_client_factory=_build_factory(transport),
    )

    await client.fetch(_CHAPTER_URL)
    assert posted_paths == ["/course/beige-1"]
    await client.aclose()


@pytest.mark.asyncio
async def test_404_during_auth_post_raises_fetch_error_not_auth_error() -> None:
    """A 404 on the auth POST is a missing page, not a rejected password.

    Mapping 4xx-as-AuthError would mask content-config bugs (e.g. a
    SiteResource pointing at a URL that doesn't exist on Squarespace)
    behind a 503 ``cms_auth_failed``.  401/403 mean the password is
    wrong; 404/5xx mean the page or upstream is the problem.
    """

    def handler(request: Request) -> Response:
        if request.method == "POST":
            return Response(404, text="Not found")
        return Response(404)

    transport = MockTransport(handler)
    client = SquarespaceClient(
        base_url=_BASE_URL,
        password="open-sesame",  # pragma: allowlist secret
        http_client_factory=_build_factory(transport),
    )

    with pytest.raises(SquarespaceFetchError) as exc_info:
        await client.fetch(_CHAPTER_URL)
    assert not isinstance(exc_info.value, SquarespaceAuthError)
    await client.aclose()


def test_extract_article_falls_back_to_body_when_no_landmark() -> None:
    """No ``<article>``/``<main>``? Use ``<body>`` — chrome is already stripped."""
    html = """
    <html><body>
      <header>HDR</header>
      <div>Just some content.</div>
    </body></html>
    """
    fetched = _extract_article(url="https://aptitude.guru/x", html=html)
    assert "Just some content" in fetched.body_html
    assert "HDR" not in fetched.body_html


def test_extract_article_keeps_images_and_links() -> None:
    """Rich content survives the cleaning pass."""
    html = """
    <html><body>
      <article>
        <h1>Hi</h1>
        <p><img src="/x.png" alt="X"/> See <a href="/elsewhere">elsewhere</a>.</p>
      </article>
    </body></html>
    """
    fetched = _extract_article(url="https://aptitude.guru/x", html=html)
    assert 'src="/x.png"' in fetched.body_html
    assert 'href="/elsewhere"' in fetched.body_html
