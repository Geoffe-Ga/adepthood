fix(habits): make goal-target editor click-to-edit so saves are visible

The previous editor rendered an always-visible TextInput per tier, which
on web/mobile-web looked the same before and after a commit -- the user
typed, blurred, and got no visual signal that the change had landed.  The
report ("changes to number targets don't save") matched the
indistinguishable-input bug rather than a missing PUT.

New behavior:
- **display** mode (default): the saved value renders as a tappable chip
  with a subtle accent background, ``accessibilityRole="button"``, and a
  hint of which tier owns it.  Communicates "this is committed".
- **edit** mode: tapping the chip swaps in a ``TextInput`` with
  ``autoFocus`` so the keyboard / focus ring appears immediately.
  ``onEndEditing`` (alone -- not also ``onBlur``, which would double-write
  on RN) commits the parsed numeric value and collapses the row back to
  the chip.  Non-numeric drafts and no-op edits revert silently.
- The ``useEffect`` that syncs the draft from the goal prop now skips the
  sync while the user is mid-edit so an out-of-band update (sibling
  commit, marker drag, server round-trip) cannot stomp on in-flight typing.

Tests
- Updated the two GoalModal test suites to walk through the chip → input
  flow.  New assertions cover the saved-state default, the press-to-edit
  switch, and the auto-collapse on commit.  Existing duplicate-write
  guard ("only ``onEndEditing``, not ``onBlur``") preserved.
