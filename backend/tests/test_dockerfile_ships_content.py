"""Guard that the runtime image actually ships the vendored course content.

The content repository and the startup seeder read ``backend/content`` at
``/app/content`` inside the container.  Tests run from the repo (where the dir
exists) so they pass regardless, which is exactly how the image-packaging gap
behind #773 stayed green while production shipped empty (``content_version:
none``).  These meta-tests assert the Dockerfile copies the content tree *and*
that the ``*.md`` exclusion in the Dockerfile-scoped ignore file is negated for
it, so the chapter bodies are not stripped from the build context.
"""

from __future__ import annotations

from pathlib import Path

_BACKEND = Path(__file__).resolve().parents[1]
_DOCKERFILE = _BACKEND / "Dockerfile"
_DOCKERIGNORE = _BACKEND / "Dockerfile.dockerignore"


def test_dockerfile_copies_the_content_dir() -> None:
    """The runtime image must COPY backend/content so the manifest exists."""
    text = _DOCKERFILE.read_text()
    assert "COPY backend/content/ content/" in text, (
        "Dockerfile must ship backend/content (manifest + chapter bodies); "
        "without it /health reports content_version: none (#773)."
    )


def test_dockerignore_keeps_the_content_markdown() -> None:
    """The blanket ``*.md`` exclusion must be negated for the content tree.

    Otherwise the COPY ships ``manifest.json`` but the chapter ``.md`` bodies are
    filtered out of the build context and never reach the image.
    """
    lines = _DOCKERIGNORE.read_text().splitlines()
    assert "!backend/content/**" in lines, (
        "Dockerfile.dockerignore must re-include backend/content/** so the "
        "*.md rule does not strip vendored chapter bodies (#773)."
    )
    # The negation must come after the broad markdown exclusion, or it is a no-op.
    assert lines.index("**/*.md") < lines.index("!backend/content/**")


def test_vendored_manifest_is_present_to_ship() -> None:
    """Sanity: the content the COPY relies on is actually in the repo."""
    assert (_BACKEND / "content" / "manifest.json").is_file()
