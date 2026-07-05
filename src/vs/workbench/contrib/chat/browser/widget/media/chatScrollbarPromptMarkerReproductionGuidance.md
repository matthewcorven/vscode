# Chat Scrollbar Prompt Markers — Reproduction Guidance

Goal: bring the chat scrollbar prompt-marker overlay closer to the target UX
(a right-edge gutter of small marks, one per user prompt, with hover
magnification, a preview popover, click-to-jump, and scroll-tracked selection)
**while** (a) using VS Code's own ubiquitous language and theming/layout
precedence, (b) not copying the reference's literal CSS values, and (c) not
referencing any external deconstruction material.

This document describes the deltas between our current implementation and the
target behavior, and gives concrete, VS Code-native guidance for each.

---

## 0. Scope and constraints

- **Language**: use VS Code terms already present in the codebase
  ("scrollbar prompt marker", "overview ruler", "marker descriptor",
  "marker type", "active", "in-viewport"). Do **not** introduce terms carried
  over from any external app (e.g. avoid "timeline", "rail", "tick",
  "fisheye", "dock", "bookmark" unless VS Code already has the concept).
  Where this doc needs a neutral label for the target concept, it uses
  *target* in italics.
- **Values**: do not port literal pixel/opacity/duration constants from the
  reference. Resolve every dimension from VS Code design tokens
  (`--vscode-spacing-size*`, `--vscode-cornerRadius-*`) and VS Code motion
  conventions (`monaco-enable-motion` / `monaco-reduce-motion`).
- **Self-contained**: this guidance is derived only from VS Code source. Any
  resemblance to external behavior is incidental.

---

## 1. Current implementation at a glance

Files:
- `src/vs/workbench/contrib/chat/browser/widget/chatScrollbarPromptMarkerController.ts`
  — lifecycle, layout, pointer/click handling, focus retry.
- `src/vs/workbench/contrib/chat/browser/actions/chatPromptNavigationActions.ts`
  — descriptor computation (`getScrollbarPromptMarkerDescriptors`), marker
  taxonomy (`ChatScrollbarPromptMarkerType`), priority z-ordering, and the
  Next/Previous User Prompt keyboard commands.
- `src/vs/workbench/contrib/chat/browser/widget/media/chat.css` (~L4486) —
  marker styling, hover/active/in-viewport states, HC themes.
- `src/vs/workbench/contrib/chat/common/constants.ts` —
  `ChatScrollbarPromptMarkerClickBehavior` and the
  `chat.scrollbarPromptMarkers.*` settings.

What we already have and should keep:
- Marker overlay mounted on the Monaco **overview ruler** via
  `host.getOverviewRulerLayoutInfo()`, above the scrollbar's `.visible` layer
  (z-index 12) so marker clicks are not swallowed.
- Container `pointer-events: none` with `pointer-events: auto` only on marker
  children — good baseline for a non-blocking gutter.
- A **descriptor pipeline** that is richer than the target: one prompt marker
  per surviving (deduplicated) request, plus optional response markers
  (`askQuestion`, `fileChange`, `compaction`, `error`) with z-index priority.
  Keep this taxonomy; it is a VS Code-native superset of the target's
  "neutral vs. emphasized" two-tone model.
- Center-stacked layout with stable per-descriptor ordering and element reuse
  across renders (so CSS transitions can animate).
- Robust pointer gesture handling: pointerdown activates + reveals, pointerup
  suppresses the follow-on click so the scrollbar cannot steal focus, and a
  rAF-retried focus path tolerates virtualized-tree height re-measurement.
- `aria-hidden` overlay with an explicit keyboard alternative (Next/Previous
  User Prompt commands, documented in chat accessibility help). This is a
  deliberate, defensible a11y choice — see §10 before changing it.

---

## 2. Gap analysis and guidance

### 2.1 Localized hover magnification (target: per-marker size scaling near the cursor)

**Gap.** Today, hovering the overview ruler toggles a single
`chat-scrollbar-prompt-markers-hover` class on the container, which widens
*every* marker uniformly to its `--chat-scrollbar-prompt-marker-hover-width`.
There is no notion of "the marker nearest the pointer grows most; neighbors
fall off."

**Guidance.**
- Track the **nearest-marker index** in `onOverviewRulerMouseMove` (we already
  compute candidate centers in `getTargetAtPoint` — reuse that linear scan to
  pick the closest marker center, not just a boolean hit).
- Expose the hovered index to each marker, e.g. set
  `marker.dataset.hoverDistance = String(abs(i - hoveredIndex))` (clamped to a
  small max, e.g. 3). Drive a CSS variable instead of inline pixels:
  `--chat-scrollbar-prompt-marker-hover-scale` (1.0 at distance ≥ max, growing
  to a cap at distance 0).
- In CSS, size the marker `::before` `inline-size` as a `calc()` blend between
  the resting token (`--vscode-spacing-size60`) and the hovered token
  (`--vscode-spacing-size160`) scaled by that variable — **do not** hardcode
  the reference's percentages. Pick the blend curve from VS Code's existing
  easing tokens if available; otherwise a simple linear or cosine falloff is
  fine, expressed in our own constants.
- Keep the existing `transition` gated behind `monaco-enable-motion` so reduced
  motion makes the size change instant (see §9).
- The currently-active / in-viewport marker should be pinned to full scale even
  when not under the cursor (we already single it out via `.active`).

### 2.2 Hover preview popover

**Gap.** No readable preview of the prompt the marker refers to. We currently
encode prompt length into the hover width as an indirect signal — not
discoverable.

**Guidance.**
- Add a single reusable popover element owned by the controller (created
  lazily, appended to the overview-ruler parent so it can overflow the marker
  container), shown only while a marker is hovered/focused.
- Content, using VS Code chat terminology already in the codebase:
  - The prompt's first line, truncated (reuse a sensible char cap; do not copy
    the reference's literal 60 — pick from existing chat truncation helpers or
    a small local constant).
  - A relative timestamp. VS Code has date-formatting utilities
    (`src/vs/base/common/date.ts` / `relativeDate`-style helpers and
    `localize` date labels) — use those rather than inventing a formatter.
  - The marker-type label for non-prompt markers (e.g. "File change",
    "Compaction", "Error") via existing `localize2` strings where they exist.
- Position it to the inline-start of the ruler (so it floats over the
  transcript, not off-screen), vertically centered on the hovered marker's
  center, following the marker as the pointer moves.
- Theme it with VS Code tokens: `background-color: var(--vscode-editorHoverWidget-background)`,
  `color: var(--vscode-editorHoverWidget-foreground)`,
  `border: 1px solid var(--vscode-editorHoverWidget-border)`,
  `box-shadow: var(--vscode-widget-shadow)`, radius
  `--vscode-cornerRadius-medium`. This matches the editor hover/peek widgets
  and recolors automatically in light/dark/HC.
- Use the standard `monaco-enable-motion` gate for an entry transition
  (opacity + small translate), `none` under reduced motion.
- **Grace period**: keep the popover alive briefly (a short `setTimeout`,
  ~50ms is fine but choose our own value) when the pointer leaves a marker, so
  the user can sweep onto the popover. Set a "pointer-over-popover" flag from
  the popover's own `mouseenter`/`mouseleave` to suppress dismissal while
  hovered. We already model this pattern for hover state in
  `onOverviewRulerMouseOut` (related-target check) — extend it.

### 2.3 Marker count cap and time bucketing

**Gap.** Every surviving request becomes a marker. A very long conversation can
produce hundreds of markers, which both overflows the ruler and harms
legibility. The target collapses to a bounded count.

**Guidance.**
- Introduce a **maximum marker count** constant in the descriptor module (a
  VS Code-appropriate value, e.g. 24 or 32 — choose one and document the
  rationale in the constant's doc comment; do not import the reference's
  number).
- When the raw prompt-marker count exceeds the cap, **downsample evenly**:
  always keep the first and last marker, then sample the remainder at a stable
  stride so selection/scroll tracking (§8) still maps onto a real row. Reuse
  the descriptor's stable ordering (already guaranteed by
  `getScrollbarPromptMarkerDescriptors`).
- Optionally **bucket by day** before downsampling so a cap-bounded set still
  reflects temporal distribution rather than just index stride. VS Code's
  date helpers can supply calendar-day boundaries. This is a nice-to-have;
  the cap itself is the must-have.
- Keep response-derived markers (`fileChange`, `error`, etc.) attached to
  their owning prompt marker so they collapse together — do not let them
  inflate the effective count independently.
- Expose the cap via the existing settings module (`constants.ts`) only if a
  setting is genuinely desired; otherwise a module constant is preferable to
  avoid settings surface growth.

### 2.4 Layout distribution when markers overflow

**Gap.** `renderMarkers` always center-clusters with `stackStride` capped at
`MARKER_HITBOX_HEIGHT`, so a large set compresses into the middle rather than
spanning the ruler height.

**Guidance.**
- Compute whether the natural stack fits:
  `fits = (count * restingHeight + (count - 1) * gap) <= rulerHeight - 2 * inset`.
- If it fits, keep the current **centered cluster** (tight, centered) — this
  matches the target's "fits → centered" behavior.
- If it does not fit, switch to **even distribution across the full height**
  (top inset to bottom inset), i.e. stride =
  `(rulerHeight - 2 * inset - hitboxHeight) / (count - 1)`. This is the VS
  Code-native equivalent of the target's "spread evenly" branch; express the
  inset with a spacing token, not a literal.
- The hitbox height used for hit-testing should remain the resting height so
  dense stacks still resolve by nearest-center (we already do
  nearest-center resolution in `getTargetAtPoint` — keep it).

### 2.5 Theming: remove hardcoded hex for the prompt type

**Gap.** The `prompt` marker type uses literal hex colors in light/dark/HC:
`#bcc0c5`, `#30353d`, `#59636e`, `#656c76`. Every other marker type correctly
uses `var(--vscode-charts-*)`. This breaks theme integration and HC contrast.

**Guidance.**
- Replace the prompt-type colors with VS Code theme variables. Because prompt
  markers are the "neutral baseline" of the gutter, the most consistent choice
  is the scrollbar family itself (the marker lives on the scrollbar):
  - resting: `var(--vscode-scrollbarSlider-background)`
  - hover/active/in-viewport: `var(--vscode-scrollbarSlider-hoverBackground)` /
    `var(--vscode-scrollbarSlider-activeBackground)`
  This keeps the prompt marker visually subordinate to the semantic
  (file-change/error/etc.) markers, which use `--vscode-charts-*` — matching
  the target's "ordinary dim, semantic bright" hierarchy with VS Code tokens.
- Remove the `.vs-dark` / `.hc-black` hex overrides entirely; the theme
  variables already adapt. Keep only the HC border treatment (§9).
- Confirm contrast in HC by keeping the existing
  `var(--vscode-contrastBorder)` outline on `.active` and the HC `border`
  rules — those are already correct and should stay.

### 2.6 Full-gutter click-catcher band

**Gap.** Clicks resolve only over marker hitboxes (plus an expanded
hover-bounds region used for hover state). The target makes the entire
vertical band spanning the marker cluster clickable, so the user doesn't have
to hit a 2px-tall pill.

**Guidance.**
- Add an invisible **click-catcher** element spanning the cluster's top inset
  to bottom inset (the same insets computed in §2.4), full width of the
  container, `pointer-events: auto`, behind the markers.
- On pointerdown, resolve the target by **nearest marker center to `clientY`**
  (we already have this logic in `getTargetAtPoint`'s candidate sort — reuse
  it without the hitbox containment filter, falling back to nearest-center
  across the whole band).
- When the gutter is hovered/activated, widen the catcher conceptually to the
  full container width (we already expand hover bounds via
  `getExpandedHoverWidth`; unify that with the catcher width).
- Keep the existing pointerdown→reveal + pointerup click-suppression +
  focus-retry pipeline; the catcher just feeds `clientY` into the same
  `revealItem` path.

### 2.7 Click alignment: center vs. bottom for the last marker

**Gap.** `revealItem` calls `this.host.reveal(item)` with no `relativeTop`,
so every marker reveals to the tree's default. The target centers non-last
prompts and bottom-anchors the most recent one (so it lands near the
composer).

**Guidance.**
- In `revealItem`, detect whether the target is the **last** descriptor (the
  most recent prompt). If so, reveal with `relativeTop` that anchors it toward
  the bottom of the viewport — e.g.
  `this.host.reveal(item, /* relativeTop near bottom */)`. VS Code's
  `reveal(element, relativeTop)` already takes a `relativeTop` in `[0,1]`
  (0 = top of viewport, 1 = bottom); use a value close to 1 for the last
  marker, and the default (center-ish) for the rest.
- Alternatively, expose this through the existing
  `ChatScrollbarPromptMarkerClickBehavior` setting rather than hardcoding, so
  the alignment is user-tunable. Either is acceptable; do not copy the
  reference's literal "center"/"bottom" enum verbatim — use VS Code's
  `relativeTop` semantics.

### 2.8 Selection tracks the visible scroll position

**Gap.** The `.active` class follows `host.getFocus()` (the focused chat row),
and `.in-viewport` is a per-marker boolean. There is no single "the marker
representing the prompt currently in view" signal, and scrolling the chat
does not move the active marker unless focus changes.

**Guidance.**
- Add a host capability (extend `IChatScrollbarPromptMarkerHost`) to report
  the **currently-visible prompt row**, e.g.
  `getVisiblePromptRowId(): string | undefined`. The list widget already
  tracks viewport membership (`isElementInViewport`); add a method that
  returns the first/nearest in-viewport request row id.
- In `renderMarkers`, set `.active` on the marker whose descriptor maps to
  that visible row (with a nearest-preceding fallback when the visible row is
  a response between two prompts — reuse the descriptor's `requestId`
  linkage). This gives the target's bidirectional sync:
  - user scrolls chat → visible row changes → active marker moves;
  - user clicks marker → chat scrolls → active marker settles on that marker.
- Keep `getFocus()`-based active highlighting as a secondary signal (e.g. a
  separate `.focused` class) if you want keyboard focus to still be visually
  distinct from scroll position; the target conflates them, but VS Code can
  express both.
- Subscribe to the list widget's scroll/viewport change notifications (the
  controller already gets `refresh()` on model/layout changes — wire the
  visible-row change to the same `refresh()` path so selection updates live
  during scroll).

### 2.9 Reduced motion and HC

**Gap.** We gate the 0.5s size transition behind `monaco-enable-motion`, which
correctly disables it under reduced motion. But once §2.1/§2.2 land, there
are new animations (fisheye size changes, popover entry) that must also
respect reduced motion.

**Guidance.**
- For every new transition/animation, scope it under
  `.monaco-workbench.monaco-enable-motion ...` (the existing pattern) so
  `monaco-reduce-motion` users get instant changes.
- Keep the **magnification itself** (the size change) even under reduced
  motion — only the *animation* is suppressed, not the state change. This
  matches VS Code's convention (state changes still happen, just instantly).
- For the popover entry keyframe, define it under a `monaco-enable-motion`
  selector and set `animation: none` for the reduce case.
- HC: keep the existing `--vscode-contrastBorder` outlines on markers and add
  a contrast border to the popover (`var(--vscode-contrastBorder)`). Do not
  rely on color alone for marker-type distinction in HC — the existing HC
  border treatment plus the marker-type legend in the popover covers this.

### 2.10 Keyboard interaction

**Gap (intentional divergence).** The overlay is `aria-hidden` and keyboard
users navigate via the Next/Previous User Prompt commands. The target makes
each marker a focusable button with `aria-current`.

**Guidance.**
- This is a **judgment call**, not a defect. VS Code's pattern for
  non-essential visual aids on scrollbars is to keep them out of the a11y tree
  and provide command-based alternatives (which we have, with keybindings and
  accessibility-help documentation). Retaining this is acceptable and arguably
  more consistent with VS Code than making the gutter keyboard-navigable.
- If parity is still desired: make markers `role="button"` with
  `tabindex="-1"` (focusable via a dedicated "Focus scrollbar markers"
  command, not in the tab order), `aria-label` from the prompt's first line,
  and `aria-current="location"` on the active one. Only do this if the
  keyboard pathway is requested; otherwise leave as-is and document the
  decision in a code comment near the `aria-hidden` assignment.
- Either way, ensure the preview popover (§2.2) is also accessible when shown
  (it can mirror the active marker's `aria-label`) so screen-reader users get
  the same information sighted users get on hover.

---

## 3. Suggested implementation order

1. **Theme fix (§2.5)** — smallest, highest-value change; removes hardcoded
   hex and restores HC/theme correctness. No behavior change.
2. **Layout distribution (§2.4)** — even-spread when overflowing; unblocks
   long-conversation usability.
3. **Marker cap + optional bucketing (§2.3)** — bounds the DOM and legibility.
4. **Full-gutter click-catcher (§2.6)** — large hit target; reuses existing
   nearest-center resolution.
5. **Click alignment (§2.7)** — last-marker bottom-anchor via `relativeTop`.
6. **Scroll-tracked selection (§2.8)** — extends the host interface; needs a
   list-widget viewport-change hook.
7. **Localized hover magnification (§2.1)** — the signature visual effect;
   depends on the nearest-index work already needed for §2.6.
8. **Hover preview popover (§2.2)** — largest new surface; depends on §2.1's
   hovered-index signal and reuses §2.8's visible-row data.
9. **Motion/HC hardening (§2.9)** — final pass over all new animations.
10. **Keyboard decision (§2.10)** — confirm and document; implement only if
    requested.

Each step is independently shippable and behind the existing
`chat.scrollbarPromptMarkers.enabled` setting, so partial progress is safe.

---

## 4. Things explicitly NOT to do

- Do **not** introduce the reference's component/role vocabulary
  ("timeline", "rail", "tick", "fisheye", "dock", "bookmark") into VS Code
  identifiers, class names, aria-labels, or doc comments. Use VS Code's
  existing "scrollbar prompt marker" / "overview ruler" / "marker" language.
- Do **not** copy literal CSS values (px widths, opacity 0.4, 75ms/150ms
  durations, the cosine easing constants, the `9999px` radius). Resolve from
  `--vscode-spacing-size*`, `--vscode-cornerRadius-*`, VS Code motion gates,
  and our own opacity/transition conventions.
- Do **not** add a "bookmark" concept to VS Code chat to mirror the target;
  VS Code chat has no prompt-bookmark feature, and inventing one is out of
  scope. The `active`/`in-viewport` and marker-type taxonomy already provide
  the visual emphasis hierarchy.
- Do **not** couple marker rendering to a specific virtualizer's imperative
  scroll API. We correctly go through `host.reveal()`/`host.focusItem()`;
  keep that indirection so the controller stays host-agnostic and testable
  (the test file already exercises it via `IChatScrollbarPromptMarkerHost`).
