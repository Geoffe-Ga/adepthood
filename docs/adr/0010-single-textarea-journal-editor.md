# ADR 0010: The journal editor stays one text area under a styled mirror

- **Status:** Accepted
- **Date:** 2026-11-26
- **Issue:** [#3801](https://github.com/Geoffe-Ga/adepthood/issues/3801)
  (closed as not planned by this decision),
  [#3800](https://github.com/Geoffe-Ga/adepthood/issues/3800)
- **Related:** epic [#3249](https://github.com/Geoffe-Ga/adepthood/issues/3249)
  (the journal Markdown dialect),
  [#3252](https://github.com/Geoffe-Ga/adepthood/issues/3252) (hanging indent
  in read mode)

## Context

The journal editor is a single multi-line text field. On web its glyphs are
transparent and a styled copy of the same text, the live mirror, is drawn
behind it (#2887, #2888). Every live style is advance-neutral: it may change a
colour or a weight that the face draws at the same width, but never how far a
glyph moves the pen, so the caret always sits on the glyph the writer sees
(`frontend/src/features/Journal/LiveMarkdownStyles.ts`). On iOS and Android the
visible text is the native field itself.

A text field wraps every line to its own left edge. Nothing in React Native or
the DOM gives one field a per-paragraph hanging indent, so a list item long
enough to wrap puts its second visual line under the marker, not under the
item's text. The owner reported this on 2026-11-25 for all three list kinds.

Three things rest on the editor being one field over one string:

- **The stored body is the typed text.** The body saved to the server is the
  field's value, byte for byte. Markers are hidden at render time and never
  rewritten.
- **Anchors are code-point offsets into that string.** Margin notes and
  promoted quotes store `anchor_start` / `anchor_end` against the body, and
  each edit is one `MarkdownEdit` that shifts them (#2965).
- **The platform owns caret, selection, undo, paste, dictation and IME.** The
  editor reconciles a change after the field has made it; it does not
  re-implement any of them.

#3801 listed the ways to hang a wrapped line while typing: one field per block
with the marker drawn outside it (options 1 and 2), a rich-text component
(option 4), or leaving soft wraps alone and hanging only where the layout is
free to (option 3).

## Decision 1 — One text area; wrapped list lines hang only in read mode

The journal editor stays one text area under one mirror. A soft-wrapped list
line in the editor returns to the field's left edge, as any wrapped line does.

Read mode has no caret to keep true, so it lays each list line out as a row:
indent, a marker column that is one width for the whole block, and a text cell
that wraps on its own left edge (`JournalListBlock.tsx`, #3252). That is where
a list hangs exactly.

## Decision 2 — Shift+Return continuation lines are indented by character count

Shift+Return on a list item inserts a line feed, the item's indent, and one
space for each character of its marker (`- ` is 2, `10. ` is 4, `- [ ] ` is 6).
Those spaces are real characters in the stored body. A line that follows a list
item, carries no marker of its own and is indented at least that far is a
continuation line of the item; the rule is stated once, on `continuedItem` in
`journalMarkdownLines.ts`.

In read mode a continuation line is a row of its item's block and its text
starts on the item's text column exactly (0 px in Chromium at 390 and 1280 px
wide, for bullets, numbers and checkboxes, nested or not).

In the editor it starts a few pixels to the left of the item's text, because
the body is set in a proportional face and a space is narrower than a digit, a
bracket or a hyphen. Measured in Chromium at the commit that shipped #3800:
1.5 px for a bullet, 4.5 px for a one-digit number and an open checkbox, and
9 px for a two-digit number and a checked box. This is accepted.

Choosing the number of spaces by measured width is declined. It would be exact
in one face on one device and wrong elsewhere, and the stored body would then
differ by the device that typed it.

## Decision 3 — Per-block fields and a rich-text editor are declined

Splitting the editor into one field per block, or replacing it with a
rich-text component, is not planned. The reasons, in order of weight:

1. **Caret, selection, undo and IME.** With one field per block, moving the
   caret across a block boundary, selecting across items, undo and redo over
   more than one block, paste that spans blocks, dictation and IME composition
   all stop being the platform's and become ours to rebuild and keep right.
2. **Anchors.** Margin notes and promoted quotes address code points of one
   string. A block model or a rich-text document has its own positions, and
   every anchor would need a mapping that holds through every edit.
3. **The stored body must stay byte-identical.** A rich-text component
   serialises its own document. Round-tripping a writer's Markdown through it
   without changing a byte is not something those components promise.
4. **Two native platforms.** The rework would be built and tested three times
   (web, iOS, Android) or would leave the platforms behaving differently.

The gain set against that risk is how a wrapped line looks only while it is
being typed. Reading is already exact.

## When to reopen

This decision is worth revisiting if any of these becomes true:

- React Native and the web gain a per-paragraph indent for a single text
  field, so a line can hang with no change to the model.
- The product needs content a single string cannot hold in the editor (inline
  images, tables, embedded blocks), so a block or rich-text model is being
  adopted for its own sake.
- Anchors stop being code-point offsets into the body for some other reason,
  which removes the largest cost above.
- Writers report the editor's wrap as a reason they do not use lists, with
  enough weight to justify the rebuild.

Nothing shipped under #3800 or #3252 closes the door: continuation lines are
plain indented text, and read mode already draws rows.

## Consequences

- A long list item wraps to the left edge while it is being written and hangs
  under its text once the entry is read.
- A writer who wants a second line inside an item uses Shift+Return. That works
  on web and desktop only: the native text field reports the key without its
  modifiers, so on a phone Return is always a plain Return, with or without a
  hardware keyboard.
- A continuation line in the editor sits 1.5 to 9 px left of its item's text,
  by marker. No code measures glyph widths to correct it.
- The stored body, the anchor model and the platform's own editing behaviour
  are unchanged, on all three platforms.
- Anything that reads list lines (renumbering, indent and outdent, the list
  toolbar commands) has to treat an item and its continuation lines as one
  unit.
