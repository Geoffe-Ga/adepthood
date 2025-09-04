## ⚙️ Agent Behavior and Development Philosophy

To set up the full development environment, run:

```bash
bash /scripts/dev-setup.sh
```

Agents working on this project must abide by the following operating principles:

1. **Test-Driven Development (TDD) Is Required**
  - Write tests before or alongside new features.

  - For the backend (FastAPI), use pytest with lightweight, isolated tests.

  - Every bug fix must include a failing test that reproduces the bug before it is resolved.

2. **CI is Your Feedback Loop**
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

6. **Respect the Archetypal Wavelength**

  - Restoration leads to Rising.

  - Agents are expected to work in cycles: test → think → implement → test → think → refine → repeat (until all green).
