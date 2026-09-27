"""Keep mounted-secret ownership aligned with the immutable runtime identity."""

from pathlib import Path

_DOCKERFILE = Path(__file__).resolve().parents[1] / "Dockerfile"
_RUNTIME_ID = "10001"


def test_backend_image_pins_the_runtime_uid_and_gid() -> None:
    dockerfile = _DOCKERFILE.read_text(encoding="utf-8")

    assert f"groupadd --gid {_RUNTIME_ID} appuser" in dockerfile
    assert f"useradd --uid {_RUNTIME_ID} --gid {_RUNTIME_ID}" in dockerfile
    assert f"USER {_RUNTIME_ID}:{_RUNTIME_ID}" in dockerfile
    assert "USER appuser" not in dockerfile
