"""Launcher for the live server the frontend end-to-end lane drives.

Nothing here is collected by pytest: the package holds a runnable module, not
tests. It lives under ``tests/`` so the repo's Python gates (ruff, mypy, bandit)
still apply to it while the coverage source set (``src``, ``scripts``) does not.
"""
