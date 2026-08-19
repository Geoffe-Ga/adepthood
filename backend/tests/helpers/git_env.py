"""A subprocess environment that cannot be steered by an ambient git.

Git exports ``GIT_DIR``, ``GIT_INDEX_FILE`` and ``GIT_WORK_TREE`` into every hook
process it runs, and this repository's pre-push hook runs the backend suite. Any
test fixture that builds its subprocess environment by copying ``os.environ``
therefore inherits them, and every ``git`` command it issues is redirected off its
own ``tmp_path`` and onto the repository being pushed from.

That is not a theoretical concern. It wrote fixture commits onto a live feature
branch, replaced that branch's working tree with the fixture's tree, and set
``core.bare=true`` on the shared checkout -- which breaks ``git status`` for every
linked worktree at once, not merely the one that pushed.

In the primary checkout the exported ``GIT_DIR`` is the relative ``.git``, which
re-resolves harmlessly against the fixture's own directory, so the damage only ever
appeared from a linked worktree, where the exported path is absolute. That is why
continuous integration stayed green throughout.

Every fixture in this repository that shells out to ``git`` -- or that runs a script
which does -- builds its environment here rather than from ``os.environ`` directly.
"""

from __future__ import annotations

import os

_GIT_ENV_PREFIX = "GIT_"


def detached_git_env(**overrides: str) -> dict[str, str]:
    """Return the ambient environment with inherited git state removed.

    The whole ``GIT_*`` prefix is stripped rather than the three variables known to
    cause the escape, so a future addition in that namespace cannot silently reopen
    the hole.

    Args:
        **overrides: Variables to set once the inherited ones are stripped.

    Returns:
        A copy of ``os.environ`` carrying no inherited git state.
    """
    env = {key: value for key, value in os.environ.items() if not key.startswith(_GIT_ENV_PREFIX)}
    env.update(overrides)
    return env
