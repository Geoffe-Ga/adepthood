from __future__ import annotations

import importlib
import unittest
from collections.abc import Iterable, Sequence
from types import ModuleType
from typing import ClassVar

from sqlmodel import SQLModel


class TestDataModel(unittest.TestCase):
    """Structural tests for ``app.models.data_model``.

    Importing the module executes model class bodies (fields/relationships),
    which suffices to fully cover a declarative models module without a DB.
    """

    MODULE_PATH: ClassVar[str] = "app.models.data_model"
    mod: ClassVar[ModuleType]

    @classmethod
    def setUpClass(cls) -> None:
        """Import the models module once for all tests."""
        cls.mod = importlib.import_module(cls.MODULE_PATH)

    def _iter_model_classes(self) -> Iterable[tuple[str, type[SQLModel]]]:
        """Yield (name, class) for SQLModel subclasses declared in the module."""
        for name, obj in vars(self.mod).items():
            if name.startswith("_"):
                continue
            if isinstance(obj, type) and issubclass(obj, SQLModel) and obj is not SQLModel:
                yield name, obj

    def test_module_imports(self) -> None:
        self.assertIsNotNone(self.mod, "models module should import")

    def test_discovers_at_least_one_model(self) -> None:
        discovered = tuple(self._iter_model_classes())
        self.assertGreater(
            len(discovered), 0, "Expected at least one SQLModel subclass in the module."
        )

    def test_discovered_models_have_basic_metadata(self) -> None:
        for name, cls in self._iter_model_classes():
            with self.subTest(model=name):
                self.assertTrue(isinstance(cls, type), f"{name} is not a class")
                # All classes should have these basic Python attributes.
                self.assertIsInstance(getattr(cls, "__name__", None), str)
                self.assertIsInstance(getattr(cls, "__module__", None), str)

    def test_no_runtime_side_effects_on_import(self) -> None:
        """Guard against engines/sessions created at import time."""
        prohibited: Sequence[str] = ("engine", "SessionLocal", "session", "db")
        for attr in prohibited:
            self.assertFalse(
                hasattr(self.mod, attr),
                f"Module unexpectedly defines runtime object '{attr}' at import time.",
            )


if __name__ == "__main__":
    unittest.main()
