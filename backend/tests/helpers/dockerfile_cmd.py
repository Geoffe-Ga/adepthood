"""The backend image's runtime CMD, tokenised, for tests that pin its flags.

Shared by the suites that each pin one property of how uvicorn is launched --
the proxy trust set (``security/test_client_ip.py``) and the absence of
uvicorn's own access log (``security/test_telemetry_sentinels.py``) -- so both
read the CMD the same way and neither can drift into a looser parse.
"""

from __future__ import annotations

from pathlib import Path
from typing import Final

DOCKERFILE: Final = Path(__file__).resolve().parents[2] / "Dockerfile"

_CMD_DIRECTIVE: Final = "CMD "
_FLAG_VALUE_SEPARATOR: Final = "="
_CMD_JSON_PUNCTUATION: Final = '[],"'


def runtime_cmd() -> str:
    """Return the runtime image's CMD line from the backend Dockerfile."""
    lines = DOCKERFILE.read_text().splitlines()
    commands = [line for line in lines if line.startswith(_CMD_DIRECTIVE)]
    assert len(commands) == 1, "expected exactly one CMD directive in backend/Dockerfile"
    return commands[0]


def runtime_cmd_tokens() -> list[str]:
    """Return the runtime CMD split into tokens with its JSON-array punctuation stripped.

    Compared token by token, never searched as text: uvicorn spells its
    switches as ``--x/--no-x`` pairs, and the off form contains the on form.
    """
    return [token.strip(_CMD_JSON_PUNCTUATION) for token in runtime_cmd().split()]


def runtime_cmd_flag_names() -> set[str]:
    """Return every option name in the runtime CMD, discarding any attached value."""
    return {token.split(_FLAG_VALUE_SEPARATOR)[0] for token in runtime_cmd_tokens()}
