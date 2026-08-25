## 🧭 Product North Star

Before building, read [`NORTH-STAR.md`](./NORTH-STAR.md) — the product thesis
("Graduated Engagement"). Adepthood is a journal-first PKM at its floor, with
optional, self-chosen depths arranged around it; the governing principle is
**"you choose your depth."** Build accordingly: nothing is gated or mandatory,
deeper rings surface only as resonant, one-tap-declinable invitations, and there
is **no gamified pressure** — no streak-shame, no guilt mechanics, no dark
patterns. The telos is to springboard people back to embodied community as Whole
Adepts; success can include a user outgrowing the app. The visual direction
lives in [`DESIGN.md`](./DESIGN.md).

## ⚙️ Agent Behavior and Development Philosophy

To set up the full development environment, run:

```bash
bash scripts/dev-setup.sh
```

Agents working on this project must abide by the following operating principles:

1. **Test-Driven Development (TDD) Is Required**
  - Write tests before or alongside new features.

  - For the backend (FastAPI), use pytest with lightweight, isolated tests.

  - Every bug fix must include a failing test that reproduces the bug before it is resolved.

2. **CI is Your Feedback Loop**
  - Run the relevant `./scripts/<side>/check-all.sh` before opening a PR; reserve
    a full `pre-commit run --all-files` sweep for a wide rename, a suspected
    cross-file type error, or a hook-config change — `git commit` already
    re-runs the hooks on your staged diff

  - GitHub Actions is the source of truth for project health.

  - CI should pass green on every merge to main.

  - If CI fails, fix it before continuing. You are not permitted to

    - Comment out the failing test.

    - Add "disable" tags before or after code in order to get tests to pass.

    - Modify test config files to bypass rules that the code is failing

    - Any other behavior that resembles the above.

  - Agents must:

    - Iterate on .github/workflows until builds, linting, typing, and tests all pass.

    - Use caching, parallelism, and fail-fast behavior where beneficial.

    - Add new jobs for new language environments or tools as needed (e.g. SwiftLint, Expo CLI, Docker health checks).

3. **Make Small, Meaningful Commits**

  - Each commit should introduce one small logical change or fix.

  - Each pull request should include:

    - A brief human-readable summary

    - A short explanation for agents (if relevant)

    - Assurance that all CI steps have passed

4. **Optimize for Learning and Maintainability**

  - Write code that teaches.

  - Comment your intentions more than your syntax.

  - Leave TODOs only if they are actionable and necessary.

  - Never introduce magic numbers or clever hacks without explanation.

5. **No Untested Assumptions**

  - Agents must validate their changes by:

    - Writing or updating relevant tests

    - Running the app in a simulated environment

    - Checking network requests for accurate backend interaction

6. **Pin GitHub Actions to Commit SHAs**

  - All `uses:` references in `.github/workflows/` must use full 40-character commit SHAs, not mutable version tags.

  - Include a version comment after the SHA for readability (e.g., `actions/checkout@<sha>  # v4.3.1`).

  - Dependabot is configured (`.github/dependabot.yml`) to propose weekly updates for pinned actions.

  - Never reference an action by tag alone (`@v4`, `@v1`) — tags can be force-pushed, enabling supply chain attacks.

7. **Every User-Facing Feature Registers a Journey**

  - Both suites are exhaustive on their own side of the wire and neither can
    tell whether the wire is connected. Six shipped features turned out to be
    reachable by nobody, and every one of them tested green the whole time.

  - A PR that adds or changes a user-facing feature adds a journey to
    `frontend/e2e/journeys.json` — either `status: "covered"`, naming the
    seam-crossing spec that drives it, or `status: "uncovered"` with a linked
    issue number.

  - Declaring a gap is allowed and expected; hiding one is not. The gate
    (`npm run check:journeys`, and the `journey-ledger` job in
    `.github/workflows/e2e.yml`) reports the uncovered count and does not fail
    on it. It *does* fail when a declared journey names a spec that was
    renamed, deleted, or turned off, when a spec crosses the seam without being
    declared, and when a screen, client wrapper, route, or table a journey
    claims to cross no longer exists under that name.

  - Do not quietly omit an uncovered journey to keep the gate green. A ledger
    that claims more coverage than exists is worse than no ledger.

8. **Respect the Archetypal Wavelength**

  - Restoration leads to Rising.

  - Agents are expected to work in cycles: test → think → implement → test → think → refine → repeat (until all green).
