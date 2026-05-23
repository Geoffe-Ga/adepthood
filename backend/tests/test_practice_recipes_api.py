"""Tests for /practice-recipes CRUD + apply endpoints."""

from __future__ import annotations

from http import HTTPStatus
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from models.practice import Practice
from models.practice_recipe import PracticeRecipe, PracticeRecipeStep
from models.stage_progress import StageProgress


async def _signup(client: AsyncClient, username: str = "owner") -> tuple[dict[str, str], int]:
    resp = await client.post(
        "/auth/signup",
        json={
            "email": f"{username}@example.com",
            "password": "securepassword123",  # pragma: allowlist secret
        },
    )
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    return {"Authorization": f"Bearer {body['token']}"}, body["user_id"]


def _sense_grounding_steps() -> list[dict[str, Any]]:
    return [
        {
            "tag_slug": "sight",
            "tag_label": "Sight",
            "prompt_label": "Name 5 things you can see",
            "target_count": 5,
        },
        {
            "tag_slug": "touch",
            "tag_label": "Touch",
            "prompt_label": "Name 4 things you can touch",
            "target_count": 4,
        },
    ]


def _tallied_steps() -> list[dict[str, Any]]:
    return [
        {"tag_slug": "red", "tag_label": "Red", "prompt_label": "Find red", "target_count": 1},
        {"tag_slug": "blue", "tag_label": "Blue", "prompt_label": "Find blue", "target_count": 1},
    ]


def _sense_recipe_body(slug: str = "my_sense") -> dict[str, Any]:
    return {
        "slug": slug,
        "name": "My Sense Recipe",
        "description": "",
        "mode": "sense_grounding",
        "rounds": 1,
        "steps": _sense_grounding_steps(),
    }


def _tallied_recipe_body(slug: str = "my_tallied", rounds: int = 2) -> dict[str, Any]:
    return {
        "slug": slug,
        "name": "My Tallied Recipe",
        "description": "",
        "mode": "tallied_grounding",
        "rounds": rounds,
        "steps": _tallied_steps(),
    }


async def _seed_system_recipe(db_session: AsyncSession, slug: str = "system_one") -> PracticeRecipe:
    recipe = PracticeRecipe(
        slug=slug,
        name="System Recipe",
        description="",
        owner_user_id=None,
        mode="tallied_grounding",
        rounds=1,
    )
    db_session.add(recipe)
    await db_session.commit()
    await db_session.refresh(recipe)
    assert recipe.id is not None
    db_session.add(
        PracticeRecipeStep(
            recipe_id=recipe.id,
            position=0,
            tag_slug="red",
            tag_label="Red",
            prompt_label="Find red",
            target_count=1,
        )
    )
    await db_session.commit()
    return recipe


# -- Create -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_sense_recipe_201(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.post("/practice-recipes/", json=_sense_recipe_body(), headers=headers)
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    body = resp.json()
    assert body["slug"] == "my_sense"
    assert body["mode"] == "sense_grounding"
    assert body["owner_user_id"] is not None
    assert len(body["steps"]) == 2
    assert body["steps"][0]["position"] == 0
    assert body["steps"][1]["position"] == 1


@pytest.mark.asyncio
async def test_create_tallied_recipe_201(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    resp = await async_client.post(
        "/practice-recipes/", json=_tallied_recipe_body(rounds=3), headers=headers
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    body = resp.json()
    assert body["rounds"] == 3
    assert body["mode"] == "tallied_grounding"


@pytest.mark.asyncio
async def test_create_sense_with_rounds_gt_1_rejected(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    payload = _sense_recipe_body()
    payload["rounds"] = 2
    resp = await async_client.post("/practice-recipes/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_tallied_duplicate_slug_within_recipe_rejected(
    async_client: AsyncClient,
) -> None:
    headers, _ = await _signup(async_client)
    payload = _tallied_recipe_body()
    payload["steps"] = [
        {"tag_slug": "red", "tag_label": "R", "prompt_label": "x", "target_count": 1},
        {"tag_slug": "red", "tag_label": "R", "prompt_label": "y", "target_count": 1},
    ]
    resp = await async_client.post("/practice-recipes/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


@pytest.mark.asyncio
async def test_create_duplicate_user_slug_409(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    await async_client.post("/practice-recipes/", json=_sense_recipe_body("dup"), headers=headers)
    resp = await async_client.post(
        "/practice-recipes/", json=_sense_recipe_body("dup"), headers=headers
    )
    assert resp.status_code == HTTPStatus.CONFLICT
    assert resp.json()["detail"] == "recipe_slug_taken"


@pytest.mark.asyncio
async def test_create_unknown_mode_422(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    payload = _sense_recipe_body()
    payload["mode"] = "meditation_timer"
    resp = await async_client.post("/practice-recipes/", json=payload, headers=headers)
    assert resp.status_code == HTTPStatus.UNPROCESSABLE_ENTITY


# -- List + read ------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_returns_system_and_own(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    await _seed_system_recipe(db_session, slug="seed_one")
    headers, _ = await _signup(async_client)
    await async_client.post(
        "/practice-recipes/", json=_tallied_recipe_body("user_one"), headers=headers
    )
    resp = await async_client.get("/practice-recipes/", headers=headers)
    slugs = {r["slug"] for r in resp.json()}
    assert {"seed_one", "user_one"} <= slugs


@pytest.mark.asyncio
async def test_list_filters_by_mode(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    await async_client.post(
        "/practice-recipes/", json=_sense_recipe_body("only_sense"), headers=headers
    )
    await async_client.post(
        "/practice-recipes/", json=_tallied_recipe_body("only_tallied"), headers=headers
    )
    resp = await async_client.get("/practice-recipes/?mode=sense_grounding", headers=headers)
    slugs = {r["slug"] for r in resp.json()}
    assert "only_sense" in slugs
    assert "only_tallied" not in slugs


@pytest.mark.asyncio
async def test_list_excludes_other_users(async_client: AsyncClient) -> None:
    headers_alice, _ = await _signup(async_client, "alice")
    headers_bob, _ = await _signup(async_client, "bob")
    await async_client.post(
        "/practice-recipes/", json=_sense_recipe_body("alice_secret"), headers=headers_alice
    )
    resp = await async_client.get("/practice-recipes/", headers=headers_bob)
    slugs = {r["slug"] for r in resp.json()}
    assert "alice_secret" not in slugs


@pytest.mark.asyncio
async def test_get_recipe_includes_steps(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    recipe = await _seed_system_recipe(db_session)
    headers, _ = await _signup(async_client)
    resp = await async_client.get(f"/practice-recipes/{recipe.id}", headers=headers)
    assert resp.status_code == HTTPStatus.OK
    body = resp.json()
    assert len(body["steps"]) == 1
    assert body["steps"][0]["tag_slug"] == "red"


# -- Update -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_update_personal_recipe(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    create = await async_client.post(
        "/practice-recipes/", json=_tallied_recipe_body(), headers=headers
    )
    recipe_id = create.json()["id"]
    new_steps = [
        {"tag_slug": "green", "tag_label": "Green", "prompt_label": "g", "target_count": 1},
    ]
    resp = await async_client.patch(
        f"/practice-recipes/{recipe_id}",
        json={
            "name": "Renamed",
            "description": "new desc",
            "rounds": 5,
            "steps": new_steps,
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    body = resp.json()
    assert body["name"] == "Renamed"
    assert body["rounds"] == 5
    assert len(body["steps"]) == 1
    assert body["steps"][0]["tag_slug"] == "green"


@pytest.mark.asyncio
async def test_update_system_recipe_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    recipe = await _seed_system_recipe(db_session)
    headers, _ = await _signup(async_client)
    resp = await async_client.patch(
        f"/practice-recipes/{recipe.id}",
        json={
            "name": "x",
            "description": "",
            "rounds": 1,
            "steps": _tallied_steps(),
        },
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.FORBIDDEN
    assert resp.json()["detail"] == "cannot_modify_system_recipe"


# -- Delete -----------------------------------------------------------------


@pytest.mark.asyncio
async def test_delete_personal_recipe(async_client: AsyncClient) -> None:
    headers, _ = await _signup(async_client)
    create = await async_client.post(
        "/practice-recipes/", json=_tallied_recipe_body("doomed"), headers=headers
    )
    recipe_id = create.json()["id"]
    resp = await async_client.delete(f"/practice-recipes/{recipe_id}", headers=headers)
    assert resp.status_code == HTTPStatus.NO_CONTENT
    get_resp = await async_client.get(f"/practice-recipes/{recipe_id}", headers=headers)
    assert get_resp.status_code == HTTPStatus.NOT_FOUND


@pytest.mark.asyncio
async def test_delete_system_recipe_403(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    recipe = await _seed_system_recipe(db_session)
    headers, _ = await _signup(async_client)
    resp = await async_client.delete(f"/practice-recipes/{recipe.id}", headers=headers)
    assert resp.status_code == HTTPStatus.FORBIDDEN


# -- Apply ------------------------------------------------------------------


async def _seed_catalog_practice(
    db_session: AsyncSession, mode: str, mode_config: dict[str, Any]
) -> Practice:
    practice = Practice(
        stage_number=1,
        name=f"Catalog {mode}",
        description="x",
        instructions="x",
        default_duration_minutes=5,
        approved=True,
        mode=mode,
        mode_config=mode_config,
    )
    db_session.add(practice)
    await db_session.commit()
    await db_session.refresh(practice)
    return practice


async def _setup_user_practice(
    async_client: AsyncClient,
    db_session: AsyncSession,
    headers: dict[str, str],
    user_id: int,
    practice: Practice,
) -> int:
    db_session.add(StageProgress(user_id=user_id, current_stage=practice.stage_number))
    await db_session.commit()
    resp = await async_client.post(
        "/user-practices/",
        json={"practice_id": practice.id, "stage_number": practice.stage_number},
        headers=headers,
    )
    assert resp.status_code == HTTPStatus.CREATED, resp.text
    return int(resp.json()["id"])


@pytest.mark.asyncio
async def test_apply_recipe_to_matching_mode(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers, user_id = await _signup(async_client)
    catalog = await _seed_catalog_practice(
        db_session,
        mode="tallied_grounding",
        mode_config={
            "mode": "tallied_grounding",
            "rounds": 1,
            "categories": [{"key": "red", "label": "Red", "target_count": 1}],
        },
    )
    up_id = await _setup_user_practice(async_client, db_session, headers, user_id, catalog)
    create_recipe = await async_client.post(
        "/practice-recipes/", json=_tallied_recipe_body("apply_me", rounds=3), headers=headers
    )
    recipe_id = create_recipe.json()["id"]

    resp = await async_client.post(
        f"/practice-recipes/{recipe_id}/apply-to/{up_id}", headers=headers
    )
    assert resp.status_code == HTTPStatus.OK, resp.text
    eff_cfg = resp.json()["effective_config"]
    assert eff_cfg["mode"] == "tallied_grounding"
    assert eff_cfg["rounds"] == 3
    assert {c["key"] for c in eff_cfg["categories"]} == {"red", "blue"}


@pytest.mark.asyncio
async def test_apply_mode_mismatch_400(async_client: AsyncClient, db_session: AsyncSession) -> None:
    headers, user_id = await _signup(async_client)
    catalog = await _seed_catalog_practice(
        db_session,
        mode="sense_grounding",
        mode_config={
            "mode": "sense_grounding",
            "prompts": [{"sense": "sight", "label": "x"}],
        },
    )
    up_id = await _setup_user_practice(async_client, db_session, headers, user_id, catalog)
    create_recipe = await async_client.post(
        "/practice-recipes/", json=_tallied_recipe_body(), headers=headers
    )
    recipe_id = create_recipe.json()["id"]

    resp = await async_client.post(
        f"/practice-recipes/{recipe_id}/apply-to/{up_id}", headers=headers
    )
    assert resp.status_code == HTTPStatus.BAD_REQUEST
    assert resp.json()["detail"] == "mode_mismatch"


@pytest.mark.asyncio
async def test_apply_other_users_practice_forbidden(
    async_client: AsyncClient, db_session: AsyncSession
) -> None:
    headers_alice, alice_id = await _signup(async_client, "alice")
    headers_bob, _ = await _signup(async_client, "bob")
    catalog = await _seed_catalog_practice(
        db_session,
        mode="tallied_grounding",
        mode_config={
            "mode": "tallied_grounding",
            "rounds": 1,
            "categories": [{"key": "red", "label": "Red", "target_count": 1}],
        },
    )
    alice_up = await _setup_user_practice(
        async_client, db_session, headers_alice, alice_id, catalog
    )
    create_recipe = await async_client.post(
        "/practice-recipes/", json=_tallied_recipe_body("bobs"), headers=headers_bob
    )
    recipe_id = create_recipe.json()["id"]

    resp = await async_client.post(
        f"/practice-recipes/{recipe_id}/apply-to/{alice_up}", headers=headers_bob
    )
    assert resp.status_code in {HTTPStatus.NOT_FOUND, HTTPStatus.FORBIDDEN}


@pytest.mark.asyncio
async def test_unauthenticated_rejected(async_client: AsyncClient) -> None:
    resp = await async_client.get("/practice-recipes/")
    assert resp.status_code == HTTPStatus.UNAUTHORIZED
