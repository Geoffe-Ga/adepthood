from app.models.data_model import Goal as GoalModel
from app.schemas.goal import Goal as GoalSchema


def test_goal_schema_fields_match_model() -> None:
    """Schema exposes a subset of the model fields."""

    schema_fields = set(GoalSchema.model_fields.keys())
    model_fields = set(GoalModel.model_fields.keys())
    assert schema_fields.issubset(model_fields)


def test_goal_schema_round_trip() -> None:
    """Ensure schema serializes and deserializes database-like records."""

    record = {
        "id": 1,
        "habit_id": 2,
        "title": "Drink Water",
        "description": None,
        "tier": "clear",
        "target": 8.0,
        "target_unit": "cups",
        "frequency": 1.0,
        "frequency_unit": "per_day",
        "is_additive": True,
    }

    schema_goal = GoalSchema.model_validate(record)
    assert schema_goal.model_dump() == record
