"""Exercise component selection and real Git history, including moved files."""

import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_SPEC = importlib.util.spec_from_file_location(
    "affected", Path(__file__).with_name("affected.py")
)
affected = importlib.util.module_from_spec(_SPEC)
_SPEC.loader.exec_module(affected)


class LaneSelection(unittest.TestCase):
    def test_docs_do_not_start_runtime_jobs(self):
        self.assertFalse(any(affected.affected(["docs/adr/0001.md"]).values()))

    def test_frontend_change_keeps_backend_python_jobs_off(self):
        self.assertEqual(
            affected.affected(["frontend/src/App.tsx"]),
            {
                "backend": False,
                "cross": True,
                "content": False,
                "e2e": True,
            },
        )

    def test_backend_route_keeps_frontend_contract_and_e2e_checks(self):
        self.assertEqual(
            affected.affected(["backend/src/routers/auth.py"]),
            {
                "backend": True,
                "cross": True,
                "content": False,
                "e2e": True,
            },
        )

    def test_meta_tests_do_not_boot_services(self):
        self.assertFalse(
            any(affected.affected(["backend/tests/scripts/test_gate.py"]).values())
        )

    def test_backend_test_runs_python_lanes_without_e2e(self):
        lanes = affected.affected(["backend/tests/test_auth.py"])
        self.assertTrue(lanes["backend"])
        self.assertFalse(lanes["e2e"])

    def test_content_markdown_runs_content_and_e2e(self):
        lanes = affected.affected(["backend/content/markdown/intro.md"])
        self.assertTrue(lanes["content"])
        self.assertTrue(lanes["e2e"])

    def test_dependencies_and_shared_tooling(self):
        for path in [
            "backend/requirements-lock.txt",
            "scripts/backend/export_openapi.py",
        ]:
            with self.subTest(path=path):
                self.assertTrue(affected.affected([path])["backend"])
                self.assertTrue(affected.affected([path])["e2e"])
        for path in ["scripts/ci/affected.py", ".github/workflows/_affected.yml"]:
            with self.subTest(path=path):
                self.assertTrue(all(affected.affected([path]).values()))

    def test_workflow_changes_run_their_own_jobs(self):
        lanes = affected.affected([".github/workflows/backend-ci.yml"])
        self.assertTrue(all(lanes[key] for key in ["backend", "cross", "content"]))
        self.assertTrue(affected.affected([".github/workflows/e2e.yml"])["e2e"])


class GitHistory(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.git("init", "-q")
        self.git("config", "user.email", "ci@example.test")
        self.git("config", "user.name", "CI test")
        self.write("README.md")
        self.base = self.commit()

    def git(self, *args):
        return subprocess.check_output(
            ["git", "-C", str(self.root), *args], text=True
        ).strip()

    def write(self, name):
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(name)

    def commit(self):
        self.git("add", ".")
        self.git("commit", "-qm", "fixture")
        return self.git("rev-parse", "HEAD")

    def changed(self, name, event):
        original = affected.subprocess.run
        with patch.object(
            affected.subprocess,
            "run",
            side_effect=lambda *a, **kw: original(
                *a,
                cwd=self.root,
                **kw,
            ),
        ):
            return affected.changed_paths(name, event)

    def test_push_includes_every_commit_and_deleted_paths(self):
        self.write("backend/src/a.py")
        self.commit()
        self.write("frontend/src/b.ts")
        (self.root / "README.md").unlink()
        head = self.commit()
        self.assertEqual(
            set(self.changed("push", {"before": self.base, "after": head})),
            {
                "backend/src/a.py",
                "frontend/src/b.ts",
                "README.md",
            },
        )

    def test_move_checks_both_components_and_preserves_filename(self):
        self.write("backend/src/space and\nnewline.py")
        base = self.commit()
        target = self.root / "frontend/renamed.ts"
        target.parent.mkdir()
        (self.root / "backend/src/space and\nnewline.py").rename(target)
        head = self.commit()
        self.assertEqual(
            set(self.changed("push", {"before": base, "after": head})),
            {
                "backend/src/space and\nnewline.py",
                "frontend/renamed.ts",
            },
        )

    def test_pr_uses_merge_base_not_target_branch_changes(self):
        self.git("checkout", "-qb", "topic")
        self.write("frontend/src/app.ts")
        head = self.commit()
        self.git("checkout", "-q", "--detach", self.base)
        self.write("backend/src/unrelated.py")
        base = self.commit()
        self.assertEqual(
            self.changed(
                "pull_request",
                {
                    "pull_request": {"base": {"sha": base}, "head": {"sha": head}},
                },
            ),
            ["frontend/src/app.ts"],
        )

    def test_missing_history_and_new_branches_run_everything(self):
        for base in ["0" * 40, "1" * 40]:
            self.assertIsNone(
                self.changed("push", {"before": base, "after": self.base})
            )
        self.assertIsNone(self.changed("workflow_dispatch", {}))


class WorkflowWiring(unittest.TestCase):
    def test_every_runtime_job_depends_on_the_selector(self):
        root = Path(__file__).resolve().parents[2]
        scopes = {
            "backend-ci.yml": {
                "backend-compat": "backend",
                "openapi-drift": "backend",
                "migration-drift": "backend",
                "backend-integration": "backend",
                "cross-boundary-drift": "cross",
                "content-drift": "content",
            },
            "e2e.yml": {
                "journey-ledger": "e2e",
                "e2e-journeys": "e2e",
                "browser-journey": "e2e",
            },
        }
        for name, jobs in scopes.items():
            text = (root / ".github/workflows" / name).read_text()
            self.assertIn("uses: ./.github/workflows/_affected.yml", text)
            for job, lane in jobs.items():
                with self.subTest(workflow=name, job=job):
                    self.assertIn(
                        f"  {job}:\n    needs: changes\n"
                        f"    if: needs.changes.outputs.{lane} == 'true'\n",
                        text,
                    )
            # Both events must trigger on selector changes too.
            self.assertEqual(text.count('      - ".github/workflows/_affected.yml"'), 2)
            script_trigger = (
                '      - "scripts/**"'
                if name == "backend-ci.yml"
                else ('      - "scripts/ci/**"')
            )
            self.assertEqual(text.count(script_trigger), 2)


if __name__ == "__main__":
    unittest.main()
