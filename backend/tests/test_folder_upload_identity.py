"""A folder note's upload identity: collision-safe, idempotent, and private (#3554).

Importing a whole Obsidian vault folder puts many notes with the same basename
in front of the upload path -- every ``Index.md`` in every subfolder. Hashing
only the account and the filename would address all of them to one fragment,
and each upload would overwrite the last. The fix is an optional *folder
source* -- an import namespace plus the note's path relative to the chosen
root -- hashed into the same opaque external id.

Four properties are pinned here, each at the layer that owns it:

*The identity separates what it must.* Different relative paths, namespaces or
accounts address different fragments; the same triple addresses the same one
whatever the bytes, so a re-import updates in place.

*Nothing that already exists moves.* A filename-only upload hashes to exactly
the id it always did, byte for byte, so no fragment a user already has is
orphaned by this change.

*An unsafe or half-sent source is refused before any vault is contacted*, and
the filename's own path rule is untouched.

*Names and paths are as private as bytes.* They appear in no ``repr``, no log
record, and no error message.
"""

from __future__ import annotations

import base64
import logging
from collections.abc import AsyncGenerator
from datetime import UTC, datetime
from http import HTTPStatus

import pytest
import pytest_asyncio
from httpx import AsyncClient
from pydantic import ValidationError

from dependencies.creek_vault import get_creek_vault_client
from domain.upload_source import (
    MAX_SOURCE_NAMESPACE_LENGTH,
    MAX_SOURCE_RELATIVE_PATH_LENGTH,
    is_safe_source_namespace,
    is_safe_source_relative_path,
    normalize_source_text,
    source_basename,
)
from main import app
from schemas.journal_upload import UploadDocumentRequest
from services.creek_vault_upload import (
    FolderSource,
    UploadedDocument,
    store_upload,
    upload_external_id,
)
from tests.test_corpus_import import ScriptedVault

_OWNER_ID = 7
_OTHER_OWNER_ID = 8

_NAMESPACE = "My Vault"
_OTHER_NAMESPACE = "Old Laptop Vault"

_INDEX = "Index.md"
_WORK_INDEX = "Work/Index.md"
_HOME_INDEX = "Home/Index.md"

# Today's id for ``(7, "field-notes.pdf")``, written out as a literal rather
# than recomputed: a test that derived the expectation through the function
# under test would agree with any change to it. If this ever has to change,
# every fragment an existing user uploaded has been orphaned.
_LEGACY_FILENAME = "field-notes.pdf"
_LEGACY_ID = "adepthood-upload-2a12125c4f5ec4ab41c4184e694405b3"

_IMPORT_PATH = "/corpus/import"
_SIGNUP_PASSWORD = "secret12345"  # pragma: allowlist secret

# Distinctive enough to find anywhere it must not appear. A folder name and a
# note path are the writer's own words about their life, exactly like the bytes.
_SENTINEL_NAMESPACE = "SENTINEL_NAMESPACE_DO_NOT_LOG"
_SENTINEL_FOLDER = "SENTINEL_FOLDER_DO_NOT_LOG"
_SENTINEL_PATH = f"{_SENTINEL_FOLDER}/{_INDEX}"

_CREATED_AT = datetime(2026, 10, 28, 9, 30, tzinfo=UTC)

_CONTENT_B64 = base64.b64encode(b"The first draft of the index.").decode("ascii")
_REVISED_B64 = base64.b64encode(b"The second, revised draft of the index.").decode("ascii")

# A decomposed and a precomposed spelling of the same folder name: "Résumé".
_DECOMPOSED_FOLDER = "Re\u0301sume\u0301"
_PRECOMPOSED_FOLDER = "R\u00e9sum\u00e9"

# Paths a client must never be able to name, each a distinct way out of the
# selected folder or a distinct way to make the identity ambiguous.
_UNSAFE_PATHS = (
    "../Index.md",
    "Work/../Index.md",
    "./Index.md",
    "Work/./Index.md",
    "/Index.md",
    "/etc/Index.md",
    "Work//Index.md",
    "Work/",
    "C:/Index.md",
    "c:Index.md",
    "Work\\Index.md",
    "\\\\server\\share\\Index.md",
    "//server/share/Index.md",
    "Work/\x00/Index.md",
    "Work\n/Index.md",
    "Wo\u202erk/Index.md",
    "",
)


def _folder(namespace: str = _NAMESPACE, relative_path: str = _WORK_INDEX) -> FolderSource:
    """Build a folder source with per-test overrides."""
    return FolderSource(namespace=namespace, relative_path=relative_path)


def _request(**overrides: object) -> UploadDocumentRequest:
    """Validate a request body with per-test overrides."""
    body: dict[str, object] = {
        "filename": _INDEX,
        "content_base64": _CONTENT_B64,
        "classification": "personal",
        "source_namespace": _NAMESPACE,
        "source_relative_path": _WORK_INDEX,
    }
    body.update(overrides)
    return UploadDocumentRequest.model_validate(body)


class TestFolderIdentity:
    """The external id separates folder notes and stays put across re-imports."""

    def test_same_basename_in_two_folders_yields_two_ids(self) -> None:
        """Work/Index.md and Home/Index.md are two notes, not one."""
        work = upload_external_id(_OWNER_ID, _INDEX, _folder(relative_path=_WORK_INDEX))
        home = upload_external_id(_OWNER_ID, _INDEX, _folder(relative_path=_HOME_INDEX))
        assert work != home

    def test_the_same_path_in_another_namespace_is_another_note(self) -> None:
        """Two imported vaults can each hold a Work/Index.md of their own."""
        mine = upload_external_id(_OWNER_ID, _INDEX, _folder())
        other = upload_external_id(_OWNER_ID, _INDEX, _folder(namespace=_OTHER_NAMESPACE))
        assert mine != other

    def test_the_same_path_in_another_account_is_another_note(self) -> None:
        """Two people's identically-laid-out vaults never share a fragment."""
        mine = upload_external_id(_OWNER_ID, _INDEX, _folder())
        theirs = upload_external_id(_OTHER_OWNER_ID, _INDEX, _folder())
        assert mine != theirs

    def test_the_same_triple_always_yields_the_same_id(self) -> None:
        """A re-import addresses the fragment the first import created."""
        assert upload_external_id(_OWNER_ID, _INDEX, _folder()) == upload_external_id(
            _OWNER_ID, _INDEX, _folder()
        )

    def test_a_folder_note_never_shares_the_legacy_id_of_its_basename(self) -> None:
        """A root-level folder note is domain-separated from a single-file upload."""
        folder_note = upload_external_id(_OWNER_ID, _INDEX, _folder(relative_path=_INDEX))
        assert folder_note != upload_external_id(_OWNER_ID, _INDEX)

    def test_framing_keeps_namespace_and_path_from_trading_characters(self) -> None:
        """Moving a boundary between the two fields cannot reproduce an id."""
        left = upload_external_id(
            _OWNER_ID, _INDEX, _folder(namespace="ab", relative_path="c/Index.md")
        )
        right = upload_external_id(
            _OWNER_ID, _INDEX, _folder(namespace="a", relative_path="bc/Index.md")
        )
        assert left != right

    def test_unicode_spellings_of_one_path_are_one_identity(self) -> None:
        """NFD from one filesystem and NFC from another address the same note."""
        decomposed = upload_external_id(
            _OWNER_ID, _INDEX, _folder(relative_path=f"{_DECOMPOSED_FOLDER}/{_INDEX}")
        )
        precomposed = upload_external_id(
            _OWNER_ID, _INDEX, _folder(relative_path=f"{_PRECOMPOSED_FOLDER}/{_INDEX}")
        )
        assert decomposed == precomposed

    def test_the_folder_id_embeds_neither_the_namespace_nor_the_path(self) -> None:
        """The id is a digest: no name or path rides in a request line."""
        generated = upload_external_id(
            _OWNER_ID, _INDEX, _folder(namespace=_SENTINEL_NAMESPACE, relative_path=_SENTINEL_PATH)
        )
        assert _SENTINEL_NAMESPACE not in generated
        assert _SENTINEL_FOLDER not in generated
        assert generated.startswith("adepthood-upload-")
        assert generated.removeprefix("adepthood-upload-").isalnum()


class TestLegacyIdentityUnchanged:
    """A filename-only upload keeps exactly the id it has always had."""

    def test_the_legacy_id_is_byte_for_byte_what_it_was(self) -> None:
        """Pinned literal: an existing user's fragments are not orphaned."""
        assert upload_external_id(_OWNER_ID, _LEGACY_FILENAME) == _LEGACY_ID

    def test_an_explicit_absent_source_is_the_legacy_id(self) -> None:
        """Passing ``None`` is indistinguishable from not passing a source."""
        assert upload_external_id(_OWNER_ID, _LEGACY_FILENAME, None) == _LEGACY_ID

    def test_a_document_without_a_source_defaults_to_none(self) -> None:
        """Every existing construction site keeps meaning a single-file upload."""
        document = UploadedDocument(
            owner_user_id=_OWNER_ID,
            filename=_LEGACY_FILENAME,
            content_base64=_CONTENT_B64,
            classification="personal",
            created_at=_CREATED_AT,
        )
        assert document.source is None

    def test_a_request_without_folder_fields_still_validates(self) -> None:
        """Today's clients send no folder fields and are unaffected."""
        request = _request(source_namespace=None, source_relative_path=None)
        assert request.source_namespace is None
        assert request.source_relative_path is None


class TestStoreUploadCarriesTheFolderIdentity:
    """The service hands the vault the folder id, and the basename as filename."""

    @pytest.mark.asyncio
    async def test_a_folder_note_is_uploaded_under_its_folder_id(self) -> None:
        """The request the vault receives is addressed by the folder identity."""
        vault = ScriptedVault()
        source = _folder()
        await store_upload(
            vault,
            UploadedDocument(
                owner_user_id=_OWNER_ID,
                filename=_INDEX,
                content_base64=_CONTENT_B64,
                classification="personal",
                created_at=_CREATED_AT,
                source=source,
            ),
        )
        [sent] = vault.upload_calls
        assert sent.external_id == upload_external_id(_OWNER_ID, _INDEX, source)
        assert sent.filename == _INDEX


class TestSourceValidation:
    """The pure rules that decide whether a namespace or path is admissible."""

    @pytest.mark.parametrize("path", _UNSAFE_PATHS)
    def test_unsafe_relative_paths_are_refused(self, path: str) -> None:
        """Every escape, ambiguity and hidden character is refused outright."""
        assert not is_safe_source_relative_path(path)

    @pytest.mark.parametrize(
        "path",
        [_INDEX, _WORK_INDEX, "Work/Projects 2026/Index.md", f"{_PRECOMPOSED_FOLDER}/{_INDEX}"],
    )
    def test_ordinary_relative_paths_are_admitted(self, path: str) -> None:
        """Real nested notes, spaces and non-ASCII names all pass."""
        assert is_safe_source_relative_path(path)

    def test_a_path_past_the_length_bound_is_refused(self) -> None:
        """The bound is enforced on the value the identity actually hashes."""
        too_long = "a/" * (MAX_SOURCE_RELATIVE_PATH_LENGTH // 2) + _INDEX
        assert not is_safe_source_relative_path(too_long)

    @pytest.mark.parametrize("namespace", ["", " ", " My Vault", "My Vault ", "My\nVault"])
    def test_unsafe_namespaces_are_refused(self, namespace: str) -> None:
        """A blank, padded or control-bearing name is not a stable identity."""
        assert not is_safe_source_namespace(namespace)

    def test_a_namespace_past_the_length_bound_is_refused(self) -> None:
        """A name cannot itself become a payload."""
        assert not is_safe_source_namespace("v" * (MAX_SOURCE_NAMESPACE_LENGTH + 1))

    def test_an_ordinary_namespace_is_admitted(self) -> None:
        """The selected folder's own name is a valid import name."""
        assert is_safe_source_namespace(_NAMESPACE)

    def test_normalization_is_nfc(self) -> None:
        """One normal form, used everywhere the identity is read."""
        assert normalize_source_text(_DECOMPOSED_FOLDER) == _PRECOMPOSED_FOLDER

    def test_the_basename_is_the_last_component(self) -> None:
        """The basename is what must agree with the validated filename."""
        assert source_basename(_WORK_INDEX) == _INDEX


class TestRequestSchema:
    """The request DTO admits a valid source pair and nothing else."""

    def test_a_valid_folder_source_is_admitted_and_normalized(self) -> None:
        """A decomposed spelling arrives at the service in NFC."""
        request = _request(
            source_namespace=_DECOMPOSED_FOLDER,
            source_relative_path=f"{_DECOMPOSED_FOLDER}/{_INDEX}",
        )
        assert request.source_namespace == _PRECOMPOSED_FOLDER
        assert request.source_relative_path == f"{_PRECOMPOSED_FOLDER}/{_INDEX}"

    @pytest.mark.parametrize(
        "overrides",
        [
            {"source_namespace": None},
            {"source_relative_path": None},
        ],
    )
    def test_half_a_source_is_refused(self, overrides: dict[str, object]) -> None:
        """Both fields or neither: half an identity would silently be the legacy one."""
        with pytest.raises(ValidationError):
            _request(**overrides)

    @pytest.mark.parametrize("path", [p for p in _UNSAFE_PATHS if p])
    def test_an_unsafe_path_is_refused(self, path: str) -> None:
        """The schema applies the path rule, not just the service."""
        with pytest.raises(ValidationError):
            _request(source_relative_path=path)

    def test_a_path_whose_basename_is_not_the_filename_is_refused(self) -> None:
        """The path names this document, or the identity names some other one."""
        with pytest.raises(ValidationError):
            _request(source_relative_path="Work/Other.md")

    def test_an_unsafe_namespace_is_refused(self) -> None:
        """The namespace rule is applied at the door."""
        with pytest.raises(ValidationError):
            _request(source_namespace=" padded")

    def test_an_overlong_namespace_is_refused(self) -> None:
        """The namespace bound is part of the published request schema."""
        with pytest.raises(ValidationError):
            _request(source_namespace="v" * (MAX_SOURCE_NAMESPACE_LENGTH + 1))

    def test_the_filename_rule_is_not_relaxed_by_a_source(self) -> None:
        """A path-shaped filename is still refused, folder source or not."""
        with pytest.raises(ValidationError):
            _request(filename=_WORK_INDEX)

    def test_errors_never_quote_the_namespace_or_path(self) -> None:
        """A rejection message is static: the refused value stays out of it."""
        with pytest.raises(ValidationError) as caught:
            _request(
                source_namespace=f"{_SENTINEL_NAMESPACE}\n",
                source_relative_path=f"../{_SENTINEL_PATH}",
            )
        messages = " ".join(str(error["msg"]) for error in caught.value.errors())
        assert _SENTINEL_NAMESPACE not in messages
        assert _SENTINEL_FOLDER not in messages

    def test_repr_omits_the_namespace_and_path(self) -> None:
        """The request's repr is as silent about the source as about the bytes."""
        rendered = repr(
            _request(source_namespace=_SENTINEL_NAMESPACE, source_relative_path=_SENTINEL_PATH)
        )
        assert _SENTINEL_NAMESPACE not in rendered
        assert _SENTINEL_FOLDER not in rendered


class TestInternalValuePrivacy:
    """The service's own values never render a namespace or path."""

    def test_folder_source_repr_omits_both_fields(self) -> None:
        """A traceback that renders the source renders nothing private."""
        rendered = repr(_folder(namespace=_SENTINEL_NAMESPACE, relative_path=_SENTINEL_PATH))
        assert _SENTINEL_NAMESPACE not in rendered
        assert _SENTINEL_FOLDER not in rendered

    def test_uploaded_document_repr_omits_the_source(self) -> None:
        """Nor does the document that carries it."""
        document = UploadedDocument(
            owner_user_id=_OWNER_ID,
            filename=_INDEX,
            content_base64=_CONTENT_B64,
            classification="personal",
            created_at=_CREATED_AT,
            source=_folder(namespace=_SENTINEL_NAMESPACE, relative_path=_SENTINEL_PATH),
        )
        rendered = repr(document)
        assert _SENTINEL_NAMESPACE not in rendered
        assert _SENTINEL_FOLDER not in rendered


@pytest_asyncio.fixture
async def vault() -> AsyncGenerator[ScriptedVault, None]:
    """Serve a caller who has a vault they can reach."""
    client = ScriptedVault()
    app.dependency_overrides[get_creek_vault_client] = lambda: client
    yield client
    app.dependency_overrides.pop(get_creek_vault_client, None)


async def _signup(client: AsyncClient, username: str) -> tuple[dict[str, str], int]:
    """Sign up a fresh account; return its Authorization header and user id."""
    response = await client.post(
        "/auth/signup",
        json={"email": f"{username}@example.com", "password": _SIGNUP_PASSWORD},
    )
    assert response.status_code == HTTPStatus.OK
    body = response.json()
    return {"Authorization": f"Bearer {body['token']}"}, int(body["user_id"])


def _body(
    *,
    relative_path: str | None = _WORK_INDEX,
    namespace: str | None = _NAMESPACE,
    content_base64: str = _CONTENT_B64,
) -> dict[str, object]:
    """Build an import body for one folder note."""
    body: dict[str, object] = {
        "filename": _INDEX,
        "content_base64": content_base64,
        "classification": "personal",
    }
    if namespace is not None:
        body["source_namespace"] = namespace
    if relative_path is not None:
        body["source_relative_path"] = relative_path
    return body


class TestImportRouteCarriesTheFolderIdentity:
    """Through the real HTTP surface: distinct, idempotent, refused, private."""

    @pytest.mark.asyncio
    async def test_two_index_notes_in_two_folders_are_two_fragments(
        self, async_client: AsyncClient, vault: ScriptedVault
    ) -> None:
        """The vault is handed two different ids for the two Index.md notes."""
        headers, _ = await _signup(async_client, "folder-two-notes")
        for path in (_WORK_INDEX, _HOME_INDEX):
            response = await async_client.post(
                _IMPORT_PATH, json=_body(relative_path=path), headers=headers
            )
            assert response.status_code == HTTPStatus.ACCEPTED
        work, home = vault.upload_calls
        assert work.external_id != home.external_id
        assert work.filename == home.filename == _INDEX

    @pytest.mark.asyncio
    async def test_a_reimport_with_revised_bytes_keeps_the_id(
        self, async_client: AsyncClient, vault: ScriptedVault
    ) -> None:
        """The same namespace and path update the fragment the first import made."""
        headers, _ = await _signup(async_client, "folder-reimport")
        for content in (_CONTENT_B64, _REVISED_B64):
            response = await async_client.post(
                _IMPORT_PATH, json=_body(content_base64=content), headers=headers
            )
            assert response.status_code == HTTPStatus.ACCEPTED
        first, second = vault.upload_calls
        assert first.external_id == second.external_id
        assert first.content_base64 != second.content_base64

    @pytest.mark.asyncio
    async def test_a_filename_only_import_keeps_its_legacy_id(
        self, async_client: AsyncClient, vault: ScriptedVault
    ) -> None:
        """An existing client's upload is addressed exactly as before."""
        headers, user_id = await _signup(async_client, "folder-legacy")
        response = await async_client.post(
            _IMPORT_PATH, json=_body(namespace=None, relative_path=None), headers=headers
        )
        assert response.status_code == HTTPStatus.ACCEPTED
        [sent] = vault.upload_calls
        assert sent.external_id == upload_external_id(user_id, _INDEX)

    @pytest.mark.asyncio
    async def test_the_route_hashes_the_source_it_validated(
        self, async_client: AsyncClient, vault: ScriptedVault
    ) -> None:
        """The id the vault receives is the folder id of this caller's own source."""
        headers, user_id = await _signup(async_client, "folder-hashed")
        response = await async_client.post(_IMPORT_PATH, json=_body(), headers=headers)
        assert response.status_code == HTTPStatus.ACCEPTED
        [sent] = vault.upload_calls
        assert sent.external_id == upload_external_id(user_id, _INDEX, _folder())

    @pytest.mark.asyncio
    @pytest.mark.parametrize(
        "body",
        [
            _body(relative_path="../Index.md"),
            _body(namespace=None),
            _body(relative_path=None),
            _body(relative_path="Work/Other.md"),
        ],
    )
    async def test_an_invalid_source_is_refused_before_any_vault_call(
        self, async_client: AsyncClient, vault: ScriptedVault, body: dict[str, object]
    ) -> None:
        """A static 422 and zero dials to the vault."""
        headers, _ = await _signup(async_client, "folder-refused")
        response = await async_client.post(_IMPORT_PATH, json=body, headers=headers)
        assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
        assert vault.upload_calls == []

    @pytest.mark.asyncio
    async def test_a_refusal_never_echoes_the_namespace_or_path(
        self, async_client: AsyncClient, vault: ScriptedVault
    ) -> None:
        """The 422 body carries neither the name nor the path it refused."""
        headers, _ = await _signup(async_client, "folder-refusal-private")
        response = await async_client.post(
            _IMPORT_PATH,
            json=_body(namespace=_SENTINEL_NAMESPACE, relative_path=f"../{_SENTINEL_PATH}"),
            headers=headers,
        )
        assert response.status_code == HTTPStatus.UNPROCESSABLE_ENTITY
        assert _SENTINEL_NAMESPACE not in response.text
        assert _SENTINEL_FOLDER not in response.text
        assert vault.upload_calls == []

    @pytest.mark.asyncio
    async def test_a_folder_import_logs_neither_the_namespace_nor_the_path(
        self,
        async_client: AsyncClient,
        vault: ScriptedVault,
        caplog: pytest.LogCaptureFixture,
    ) -> None:
        """Every record the import emits is silent about the source."""
        headers, _ = await _signup(async_client, "folder-logs-private")
        with caplog.at_level(logging.DEBUG):
            response = await async_client.post(
                _IMPORT_PATH,
                json=_body(namespace=_SENTINEL_NAMESPACE, relative_path=_SENTINEL_PATH),
                headers=headers,
            )
        assert response.status_code == HTTPStatus.ACCEPTED
        assert vault.upload_calls
        for record in caplog.records:
            rendered = f"{record.getMessage()} {record.__dict__}"
            assert _SENTINEL_NAMESPACE not in rendered
            assert _SENTINEL_FOLDER not in rendered
