"""The web build's post-export hardening steps fail on a real violation.

ADR 0009 phase (b) opens with an enforced CSP and Subresource Integrity on the
web client (#3067). Two build-time steps carry it, and both are gates: a step
that printed a warning and exited 0 would ship a bundle the browser refuses or,
worse, one it loads without the protection the record says is live.

- ``frontend/web-hardening/sri.js stamp <dist>`` writes a ``sha384`` integrity hash
  onto every script and stylesheet each built HTML page serves, then verifies
  the result. ``verify <dist>`` only verifies. Either exits 1 when a served
  script or stylesheet has no integrity, when a hash does not match its file,
  when a page ships an inline script (``script-src 'self'`` refuses it) or a
  script from another origin, and when a page serves no script at all.
- ``frontend/web-hardening/csp.js <template> <output>`` renders ``nginx.conf``,
  replacing the connect-src placeholder with the API origin the bundle was
  built against (and the Sentry origin when one is set). It exits 1 when there
  is no https API origin to render or no placeholder to render it into.

Each test runs the real script with ``node`` against a fabricated ``dist`` in
``tmp_path`` and checks the hash independently with :mod:`hashlib`, so a
script that wrote the wrong digest cannot agree with itself. The wiring tests
pin that every build path that produces a deployable bundle runs the stamp.
"""

from __future__ import annotations

import base64
import hashlib
import os
import re
import shutil
import subprocess
from pathlib import Path

import pytest

_REPO_ROOT = Path(__file__).resolve().parents[3]
_FRONTEND = _REPO_ROOT / "frontend"
_SRI = _FRONTEND / "web-hardening" / "sri.js"
_CSP = _FRONTEND / "web-hardening" / "csp.js"
_NGINX_CONF = _FRONTEND / "nginx.conf"
_DOCKERFILE = _FRONTEND / "Dockerfile"
_BUNDLE_SCRIPT = _REPO_ROOT / "scripts" / "frontend" / "bundle.sh"
_FRONTEND_CI = _REPO_ROOT / ".github" / "workflows" / "frontend-ci.yml"
_PACKAGE_JSON = _FRONTEND / "package.json"

_TOKEN = "__BUILD_CONNECT_ORIGINS__"
_SUBPROCESS_TIMEOUT_SECONDS = 60
_EXIT_OK = 0
_EXIT_VIOLATION = 1
_EXIT_USAGE = 2

_SCRIPT_PATH = "_expo/static/js/web/index-0123abcd.js"
_STYLE_PATH = "_expo/static/css/app-4567ef.css"
_SCRIPT_BODY = b"console.log('the bundle');\n"
_STYLE_BODY = b"body { margin: 0; }\n"

_INDEX = f"""<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Adepthood</title>
    <style id="expo-reset">#root {{ display: flex; }}</style>
    <link rel="icon" href="/favicon.ico"/>
    <link rel="stylesheet" href="/{_STYLE_PATH}">
  </head>
  <body>
    <div id="root"></div>
  <script src="/{_SCRIPT_PATH}" defer></script>
</body>
</html>
"""

pytestmark = pytest.mark.skipif(shutil.which("node") is None, reason="node is not installed")


def _sha384(body: bytes) -> str:
    """The SRI value a browser computes for ``body``."""
    return "sha384-" + base64.b64encode(hashlib.sha384(body).digest()).decode("ascii")


def _dist(tmp_path: Path, index: str = _INDEX) -> Path:
    """A built web export: one page, one bundle, one stylesheet."""
    dist = tmp_path / "dist"
    (dist / _SCRIPT_PATH).parent.mkdir(parents=True)
    (dist / _STYLE_PATH).parent.mkdir(parents=True)
    (dist / _SCRIPT_PATH).write_bytes(_SCRIPT_BODY)
    (dist / _STYLE_PATH).write_bytes(_STYLE_BODY)
    (dist / "index.html").write_text(index, encoding="utf-8")
    return dist


def _node(
    script: Path, *args: str, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess[str]:
    """Run ``script`` under node, never raising on a non-zero exit."""
    node = shutil.which("node")
    assert node is not None
    return subprocess.run(
        [node, str(script), *args],
        capture_output=True,
        text=True,
        check=False,
        timeout=_SUBPROCESS_TIMEOUT_SECONDS,
        env=env,
    )


def _tag(html: str, pattern: str) -> str:
    """The single tag in ``html`` matching ``pattern``."""
    found = re.findall(pattern, html)
    assert len(found) == 1, found
    return str(found[0])


def _integrity_of(tag: str) -> str | None:
    """The tag's ``integrity`` attribute value, or None."""
    match = re.search(r'\sintegrity="([^"]*)"', tag)
    return match.group(1) if match else None


def _stamped(tmp_path: Path) -> Path:
    """A dist the real script has stamped, asserting the stamp succeeded."""
    dist = _dist(tmp_path)
    result = _node(_SRI, "stamp", str(dist))
    assert result.returncode == _EXIT_OK, result.stdout + result.stderr
    return dist


def test_stamp_writes_the_browser_digest_onto_every_script_and_stylesheet(tmp_path: Path) -> None:
    """Each served script and stylesheet carries the sha384 of its own bytes."""
    html = (_stamped(tmp_path) / "index.html").read_text(encoding="utf-8")

    script = _tag(html, r"<script\b[^>]*>")
    style = _tag(html, r'<link\b[^>]*rel="stylesheet"[^>]*>')
    assert _integrity_of(script) == _sha384(_SCRIPT_BODY)
    assert _integrity_of(style) == _sha384(_STYLE_BODY)
    # Everything else on the page is untouched, the icon link included.
    assert '<link rel="icon" href="/favicon.ico"/>' in html
    assert f'src="/{_SCRIPT_PATH}"' in html
    assert "defer" in script


def test_stamp_is_idempotent(tmp_path: Path) -> None:
    """A second stamp replaces the hash rather than adding another attribute."""
    dist = _stamped(tmp_path)
    first = (dist / "index.html").read_text(encoding="utf-8")

    again = _node(_SRI, "stamp", str(dist))

    assert again.returncode == _EXIT_OK, again.stderr
    assert (dist / "index.html").read_text(encoding="utf-8") == first
    assert first.count("integrity=") == 2


def test_verify_passes_a_stamped_build(tmp_path: Path) -> None:
    """The control: a correctly stamped build verifies clean."""
    result = _node(_SRI, "verify", str(_stamped(tmp_path)))

    assert result.returncode == _EXIT_OK, result.stdout + result.stderr


def test_verify_fails_an_unstamped_build_naming_each_asset(tmp_path: Path) -> None:
    """A script or stylesheet with no integrity attribute fails the build."""
    result = _node(_SRI, "verify", str(_dist(tmp_path)))

    assert result.returncode == _EXIT_VIOLATION
    assert _SCRIPT_PATH in result.stderr
    assert _STYLE_PATH in result.stderr
    assert "no integrity" in result.stderr


def test_verify_fails_when_a_file_changed_after_stamping(tmp_path: Path) -> None:
    """A hash that no longer matches its file is a failure, not a warning."""
    dist = _stamped(tmp_path)
    (dist / _SCRIPT_PATH).write_bytes(_SCRIPT_BODY + b"/* injected */\n")

    result = _node(_SRI, "verify", str(dist))

    assert result.returncode == _EXIT_VIOLATION
    assert _SCRIPT_PATH in result.stderr
    assert "does not match" in result.stderr
    assert _STYLE_PATH not in result.stderr


@pytest.mark.parametrize(
    ("tag", "reason"),
    [
        ("<script>window.__boot = 1;</script>", "inline script"),
        ('<script src="https://cdn.example.test/lib.js"></script>', "not served by this build"),
        ('<script src="//cdn.example.test/lib.js"></script>', "not served by this build"),
        ('<script src="/_expo/static/js/web/missing.js"></script>', "no such file"),
        ('<script src="/../outside.js"></script>', "not served by this build"),
    ],
)
def test_verify_refuses_scripts_the_policy_or_the_hash_cannot_cover(
    tmp_path: Path, tag: str, reason: str
) -> None:
    """Inline, foreign, escaping or missing scripts fail even when stamping is attempted."""
    dist = _dist(tmp_path, _INDEX.replace("</body>", f"{tag}\n</body>"))

    result = _node(_SRI, "stamp", str(dist))

    assert result.returncode == _EXIT_VIOLATION
    assert reason in result.stderr


def test_verify_fails_a_page_that_serves_no_script(tmp_path: Path) -> None:
    """A build that changed shape so no script is found must not pass vacuously."""
    index = re.sub(r"<script\b[^>]*></script>", "", _INDEX)
    result = _node(_SRI, "verify", str(_dist(tmp_path, index)))

    assert result.returncode == _EXIT_VIOLATION
    assert "serves no script" in result.stderr


def test_sri_usage_errors_exit_two(tmp_path: Path) -> None:
    """A bad invocation is distinguishable from a violation."""
    assert _node(_SRI).returncode == _EXIT_USAGE
    assert _node(_SRI, "stamp").returncode == _EXIT_USAGE
    assert _node(_SRI, "sign", str(tmp_path)).returncode == _EXIT_USAGE
    assert _node(_SRI, "verify", str(tmp_path / "absent")).returncode == _EXIT_USAGE


def _render_env(**values: str) -> dict[str, str]:
    """The ambient env with the two build-time origins replaced by ``values``."""
    env = {
        key: value
        for key, value in os.environ.items()
        if key not in {"EXPO_PUBLIC_API_BASE_URL", "EXPO_PUBLIC_SENTRY_DSN"}
    }
    env.update(values)
    return env


def _connect_src(conf: str) -> list[list[str]]:
    """The connect-src source list of every enforced CSP header in ``conf``."""
    lists = []
    for policy in re.findall(r'add_header\s+Content-Security-Policy\s+"([^"]+)"', conf):
        for directive in policy.split(";"):
            name, *sources = directive.split()
            if name == "connect-src":
                lists.append(sources)
    return lists


def test_render_narrows_connect_src_to_the_built_api_origin(tmp_path: Path) -> None:
    """The real nginx.conf renders with the API origin in place of the placeholder."""
    out = tmp_path / "default.conf"
    env = _render_env(EXPO_PUBLIC_API_BASE_URL="https://api.example.test/base/")

    result = _node(_CSP, str(_NGINX_CONF), str(out), env=env)

    assert result.returncode == _EXIT_OK, result.stderr
    rendered = out.read_text(encoding="utf-8")
    assert _TOKEN not in rendered
    lists = _connect_src(rendered)
    assert len(lists) >= 2
    for sources in lists:
        assert sources == [
            "'self'",
            "https://api.example.test",
            "https://api.openai.com",
            "https://api.anthropic.com",
        ]


def test_render_adds_the_sentry_ingest_origin_when_a_dsn_is_set(tmp_path: Path) -> None:
    """Crash reports POST to the DSN's host, so that origin is allowed too."""
    out = tmp_path / "default.conf"
    env = _render_env(
        EXPO_PUBLIC_API_BASE_URL="https://api.example.test",
        EXPO_PUBLIC_SENTRY_DSN="https://publickey@o42.ingest.sentry.example/7",
    )

    result = _node(_CSP, str(_NGINX_CONF), str(out), env=env)

    assert result.returncode == _EXIT_OK, result.stderr
    for sources in _connect_src(out.read_text(encoding="utf-8")):
        assert sources[:3] == [
            "'self'",
            "https://api.example.test",
            "https://o42.ingest.sentry.example",
        ]


@pytest.mark.parametrize(
    ("values", "reason"),
    [
        ({}, "EXPO_PUBLIC_API_BASE_URL"),
        ({"EXPO_PUBLIC_API_BASE_URL": "http://api.example.test"}, "https"),
        ({"EXPO_PUBLIC_API_BASE_URL": "not a url"}, "EXPO_PUBLIC_API_BASE_URL"),
        (
            {
                "EXPO_PUBLIC_API_BASE_URL": "https://api.example.test",
                "EXPO_PUBLIC_SENTRY_DSN": "http://k@s.example/1",
            },
            "EXPO_PUBLIC_SENTRY_DSN",
        ),
    ],
)
def test_render_refuses_an_origin_it_cannot_vouch_for(
    tmp_path: Path, values: dict[str, str], reason: str
) -> None:
    """No https API origin means no deployable conf: fail rather than fall open."""
    out = tmp_path / "default.conf"

    result = _node(_CSP, str(_NGINX_CONF), str(out), env=_render_env(**values))

    assert result.returncode == _EXIT_VIOLATION
    assert reason in result.stderr
    assert not out.exists()


def test_render_refuses_a_template_without_the_placeholder(tmp_path: Path) -> None:
    """A conf that lost its placeholder would ship a policy nobody rendered."""
    template = tmp_path / "nginx.conf"
    template.write_text(
        _NGINX_CONF.read_text(encoding="utf-8").replace(_TOKEN, ""), encoding="utf-8"
    )
    env = _render_env(EXPO_PUBLIC_API_BASE_URL="https://api.example.test")

    result = _node(_CSP, str(template), str(tmp_path / "out.conf"), env=env)

    assert result.returncode == _EXIT_VIOLATION
    assert _TOKEN in result.stderr


def test_render_usage_error_exits_two() -> None:
    """A bad invocation is distinguishable from a refusal."""
    assert _node(_CSP).returncode == _EXIT_USAGE


def test_every_deployable_build_path_stamps_and_renders() -> None:
    """The image, the npm build, the local gate and CI all run the steps after export."""
    dockerfile = _DOCKERFILE.read_text(encoding="utf-8")
    export_step = dockerfile.index("RUN npx expo export --platform web\n")
    stamp_step = dockerfile.index("RUN node web-hardening/sri.js stamp dist\n")
    render_step = dockerfile.index("RUN node web-hardening/csp.js nginx.conf ")
    assert export_step < stamp_step < render_step
    assert re.search(r"RUN node web-hardening/csp\.js nginx\.conf (\S+)", dockerfile)
    rendered = re.search(r"RUN node web-hardening/csp\.js nginx\.conf (\S+)", dockerfile)
    assert rendered is not None
    assert (
        f"COPY --from=builder /app/{rendered.group(1)} /etc/nginx/conf.d/default.conf" in dockerfile
    )
    assert "COPY frontend/nginx.conf" not in dockerfile

    package = _PACKAGE_JSON.read_text(encoding="utf-8")
    web_build = "expo export --platform web && node web-hardening/sri.js stamp dist"
    assert f'"web:build": "{web_build}"' in package

    bundle = _BUNDLE_SCRIPT.read_text(encoding="utf-8")
    export_at = bundle.index("expo export --platform web")
    stamp_at = bundle.index("node web-hardening/sri.js stamp dist")
    assert export_at < stamp_at

    ci = _FRONTEND_CI.read_text(encoding="utf-8")
    assert "run: npm run web:build" in ci
