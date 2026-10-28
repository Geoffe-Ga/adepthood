"""Where an uploaded document sat in the folder it was imported from (#3554).

A folder import -- choosing an Obsidian vault and sending its notes -- puts many
files with one basename in front of the upload path: every ``Index.md`` in every
subfolder. The upload's identity therefore needs to know *where* in the folder a
note sat, or ``Work/Index.md`` and ``Home/Index.md`` would address one fragment
and each upload would overwrite the last.

That "where" is two strings a client supplies: a **namespace**, the stable name
of the import (by default, the chosen folder's own name), and a **relative
path** from that folder's root to the file, ``/``-separated. This module states
which values of either are admissible and the one normal form both are read in.

They are **identity metadata and nothing else**. Nothing ever opens, joins or
resolves them as a filesystem path; they are hashed into an opaque external id
and dropped. The rules are strict anyway, for the reason the filename rule is:
a value whose meaning we cannot state is one we should not let address a
fragment. A ``..`` component, an absolute or drive-rooted path, an empty
segment, a backslash or a hidden control character each make two spellings of
"the same place" possible, and an identity with two spellings is not one.

The rules are file-type agnostic on purpose: a note, an image or a PDF in the
folder is addressed the same way, so attachment import and a paced retry after
a ``429`` (#3553) reuse this identity unchanged.
"""

from __future__ import annotations

import re
import unicodedata
from typing import Final, Literal

# Longest namespace accepted. A folder name a person reads in a list, not a
# payload; generous for any real one.
MAX_SOURCE_NAMESPACE_LENGTH = 128

# Longest relative path accepted. Deep enough for any real vault's nesting while
# bounding what a single request can make the identity hash.
MAX_SOURCE_RELATIVE_PATH_LENGTH = 1024

# The one separator a relative path may use. A backslash is refused rather than
# translated, so ``Work\\Index.md`` and ``Work/Index.md`` cannot both name a note.
_PATH_SEPARATOR = "/"
_BACKSLASH = "\\"

# Components that mean "here" and "up": the shapes of traversal, refused.
_RELATIVE_COMPONENTS = frozenset({".", ".."})

# A Windows drive prefix (``C:``, ``c:Index.md``) roots a path somewhere other
# than the chosen folder, even without a leading separator.
_DRIVE_PREFIX = re.compile(r"[A-Za-z]:")

# The single Unicode normal form every source string is read in. Filesystems
# disagree -- macOS has historically handed out NFD, most others NFC -- and one
# folder must hash to one identity whichever produced its names.
_NORMAL_FORM: Final[Literal["NFC"]] = "NFC"


def normalize_source_text(value: str) -> str:
    """Return ``value`` in the normal form the identity is computed over."""
    return unicodedata.normalize(_NORMAL_FORM, value)


def _is_bounded_printable(value: str, limit: int) -> bool:
    """Return whether ``value`` is non-empty, within ``limit``, and printable throughout.

    ``str.isprintable`` rejects NUL, CR/LF and every other control character, and
    the zero-width and bidi-override codepoints that make a name display as
    something other than what it is -- the same reasoning as the filename rule.
    """
    return bool(value) and len(value) <= limit and value.isprintable()


def is_safe_source_namespace(value: str) -> bool:
    """Return whether ``value`` is an admissible import name, once normalized.

    Printable, not blank, not padded with whitespace, and within
    :data:`MAX_SOURCE_NAMESPACE_LENGTH`. Padding is refused rather than stripped
    so ``"My Vault"`` and ``"My Vault "`` cannot become two imports of one
    folder by accident.
    """
    normalized = normalize_source_text(value)
    if not _is_bounded_printable(normalized, MAX_SOURCE_NAMESPACE_LENGTH):
        return False
    return normalized == normalized.strip()


def _is_rooted_elsewhere(path: str) -> bool:
    """Return whether ``path`` uses a Windows or UNC spelling, or names a drive."""
    return _BACKSLASH in path or _DRIVE_PREFIX.match(path) is not None


def _is_safe_component(component: str) -> bool:
    """Return whether one ``/``-delimited segment is a plain name."""
    return bool(component) and component not in _RELATIVE_COMPONENTS


def is_safe_source_relative_path(value: str) -> bool:
    """Return whether ``value`` is an admissible folder-relative path, once normalized.

    Admitted: one or more non-empty components joined by ``/``, none of them
    ``.`` or ``..``, printable throughout, within
    :data:`MAX_SOURCE_RELATIVE_PATH_LENGTH`. Refused, each for making the
    identity ambiguous or pointing outside the chosen folder: a leading ``/``
    (absolute), a ``//`` or trailing ``/`` (empty component), a drive prefix,
    any backslash (Windows and UNC spellings), and any control character.
    """
    normalized = normalize_source_text(value)
    if not _is_bounded_printable(normalized, MAX_SOURCE_RELATIVE_PATH_LENGTH):
        return False
    if _is_rooted_elsewhere(normalized):
        return False
    return all(_is_safe_component(part) for part in normalized.split(_PATH_SEPARATOR))


def source_basename(relative_path: str) -> str:
    """Return the last component of a ``/``-separated relative path."""
    return relative_path.rsplit(_PATH_SEPARATOR, 1)[-1]
