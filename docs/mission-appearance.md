# Mission — appearance: Glass and Stone

The hub has one hand-built look. This mission made it a setting: the Glass design
stays exactly as it was, a second style called **Stone** sits beside it, and the
person using the app chooses between them from Settings.

Status: **implemented**. This document is the brief it was built from, kept as the
record of what was decided and why.

## 1. Objective, and the test of it

One sentence: *the app ships two complete visual styles and the person using it
picks one without rebuilding.*

Done means all of these are true at once:

- A fresh launch shows Glass, and Glass looks exactly as it did before.
- Settings → Appearance → Stone re-skins the entire hub — titlebar, sidebar,
  topbar, every panel — without a reload.
- Quitting and relaunching lands on Stone with no flash of the other style.
- `settings.json` records the choice, and a hand-edited value is honoured.
- The library page is untouched and still opens with native macOS chrome.
- The before/after screenshots of Glass are identical.

## 2. Locked decisions

| # | Decision | Locked to | Why |
| --- | --- | --- | --- |
| 1 | Styles shipped | **Glass + Stone** | Two proves the mechanism; a third is one more file, not a different architecture |
| 2 | Name of the new style | **Stone** | Pairs with Glass as a material, and the spec calls it "warm stone"; `Hairline` stays the spec's internal name |
| 3 | Source of Stone's look | §01 of `skills/references/ui-styles.md` (Avalon workspace skill set) | One authority for the palette; no invented colours |
| 4 | Where the choice lives | A **Settings** view, reached from the sliders button at the sidebar foot | The user asked for a settings menu somewhere logical in the hub |
| 5 | How it is offered | A horizontal **appearance bar**, `role="radiogroup"`, applies on selection | The user asked for a bar; instant apply means no Save button and no dirty state |
| 6 | Persistence | `settings.json` field `uiStyle`, mirrored to `localStorage` | Durable across reinstall; the mirror is what prevents a flash |
| 7 | Default style | `glass` | It is the look the app has shipped with |
| 8 | Window chrome | Follows the style: `set_background_color` + `set_theme` | A light page in a `#080711` frame with dark dialogs is two apps |
| 9 | Library page | **Untouched** — Immich's own appearance, native decorations | Its DOM churns between versions; styling it from outside breaks on upgrade |
| 10 | macOS control dots | Platform colours (`#ff5f57 #febc2e #28c840`) in both styles | Users read those colours, not our palette |
| 11 | QR code | Always dark on white | Scanability, already forced in `qr.rs` |
| 12 | Glass fidelity | **Pixel-identical** before and after the work | The refactor must not be a redesign in disguise |
| 13 | Scope of the CSS lift | All 55 literal colours plus the 4 Glass-only structures | Partial lift equals a style that half-works |
| 14 | Relationship between styles | Complete files; no style imports or blends another | A blend has no owner for any decision |

## 3. The contract

Three rules, and every later step depends on them:

1. Every style defines every token in the table below. A token missing from a
   style is a bug, not a default.
2. No component CSS may use a literal colour. The only exceptions are the two
   columns at the end of this section.
3. Token names describe a job, not a paint. `--panel-edge`, never
   `--violet-mint-gradient`.

| Token | Glass | Stone |
| --- | --- | --- |
| `--bg` | `#080711` | `#f1efea` |
| `--bg-art` | two radials + veil | `none` |
| `--panel` | `rgba(19,16,33,.62)` | `#faf9f6` |
| `--panel-sheen` | white 8.5% → 1.2% gradient | `none` |
| `--line-edge` | violet → mint 1px gradient | `rgba(26,25,22,.16)` |
| `--panel-blur` | `blur(20px)` | `none` |
| `--panel-shadow` | inset white hairline | `none` |
| `--ink` | `#f3f0ff` | `#1a1916` |
| `--ink-2` | `rgba(243,240,255,.70)` | `#4f4b45` |
| `--ink-3` | `rgba(243,240,255,.55)` | `#6b675f` (measured; the spec's `#8b857c` is 3.18:1) |
| `--line` | `rgba(255,255,255,.14)` | `rgba(26,25,22,.16)` |
| `--line-strong` | `rgba(255,255,255,.22)` | `rgba(26,25,22,.28)` |
| `--line-control` | `rgba(255,255,255,.14)` | `rgba(26,25,22,.5)` — 3.25:1, a control's only boundary |
| `--line-field` | `rgba(255,255,255,.08)` | `rgba(26,25,22,.5)` |
| `--accent` | `#a78bfa` | `#2f6b4f` |
| `--accent-soft` | `rgba(167,139,250,.16)` | `rgba(47,107,79,.12)` |
| `--on-accent` | `#120c24` | `#f5fbf8` |
| `--mint` | `#2ee6c5` | `#2f6b4f` |
| `--flag` | `#ff8f9c` | `#a63b28` |
| `--glow-accent`, `--glow-accent-tight`, `--glow-mint`, `--glow-flag` | real glows | `none` |
| `--logo-mark` | sampled gradient | sampled gradient (unchanged) |
| `--btn-face` | violet gradient | flat `--accent` |
| `--display-tint` | ink → accent → mint text | solid `--ink` |
| `--press` | `scale(.98)` | `translateY(2px)` + inset lip |
| `--selection` | violet .35 | green .18 |
| `--scroll-thumb` / `--scroll-thumb-hover` | white .14 / .26 | ink .18 / .32 |
| `--radius` / `-sm` / `-xs` | `22px` / `12px` / `8px` | `8px` / `5px` / `4px` |
| `--dur` / `--ease` | `240ms` / `cubic-bezier(.16,1,.3,1)` | `180ms` / `cubic-bezier(.23,1,.32,1)` |
| `--font-sans` / `--font-mono` | Segoe UI / Cascadia | same families |

Three names changed while building, and the code is the authority: the brief said
`--sheen` and `--panel-edge`, but `--panel-sheen` and `--line-edge` already existed
and were in use, and renaming a used token buys the reader nothing. `--panel-raised`
was dropped; no component ever needed a second pane colour. `--line-control` and
`--line-field` were added after the contrast pass in §7 showed a single hairline
value cannot serve both a divider and a control's only boundary.

**Allowed literals, and only these:**

- The three macOS control colours, in `app.css`.
- The QR's black and white, in `qr.rs` and `.phone__qr`.
- `transparent`, `none`, `currentColor`, and `#000` used inside mask gradients.

## 4. File map

| Path | Action |
| --- | --- |
| `src/styles/tokens.css` | Reduced to the shared type families. No palette. |
| `src/styles/styles/glass.css` | `[data-style="glass"]` with the shipped values. |
| `src/styles/styles/stone.css` | `[data-style="stone"]` with §01's values, plus its skin section. |
| `src/styles/app.css` | 55 literals → tokens; four structural rules became token-driven. |
| `index.html` | Inline `data-style` boot script before the module, plus the static default. |
| `src/app/style.ts` | Style ids, guard, `useStyle`, persistence. |
| `src/app/App.tsx` | Provides the style; renders the new view. |
| `src/app/Settings.tsx` | The appearance bar and its section shell. |
| `src/app/view.ts`, `src/app/Sidebar.tsx` | `settings` view; sliders button at the sidebar foot. |
| `src-tauri/src/settings.rs` | `ui_style` field, default `glass`, with a compatibility test. |
| `src-tauri/src/lib.rs` | `set_ui_style`, registered; window chrome applied at startup and on change. |
| `src-tauri/src/runtime.rs` | `StatusView.ui_style` for reconciliation. |
| `src-tauri/tauri.conf.json` | Kept the Glass values as the startup default. No structural change. |
| `README.md`, `PLATFORMS.md` | Appearance section; window-theme note. |

## 5. What was built, step by step

1. **Split the styles.** Glass's tokens moved into `styles/glass.css` under
   `[data-style="glass"]`; `tokens.css` kept only the type families;
   `index.html` ships `data-style="glass"` statically.
2. **Lifted the literals.** All 55 sites became contract tokens, and the four
   Glass-only structures became data: `.aurora` takes `--bg-art`,
   `.panel::before` takes `--line-edge`, `.panel--blur` takes `--panel-blur`,
   `.btn:active` takes `--press`. Gate: only the traffic lights, the QR plate and
   the mask colour remain literal in `app.css`.
3. **Wrote Stone** from §01 plus a skin section that switches off the three Glass
   shapes a value cannot express: no entrance, no shine, a press that sinks.
4. **Boot and plumbing.** An inline head script applies the cached style before
   first paint; `useStyle` applies, mirrors, persists, and adopts the saved value
   when `settings.json` disagrees.
5. **Rust.** `ui_style` in settings, `set_ui_style` validating against the same id
   list, `StatusView.ui_style`, and window chrome (`set_background_color`,
   `set_theme`) applied once at startup and only when the style changes.
6. **Settings view.** A radiogroup of two cards; each swatch is the real
   primitives inside its own `data-style` subtree, so it cannot drift.
7. **Contrast pass.** Measured, then corrected; see §7.
8. **Docs.** README, PLATFORMS, and a header comment in each style file.

## 6. Verification

| Check | Result |
| --- | --- |
| `npm run typecheck` | clean |
| `npm run build` | clean, no CSS parse error |
| Literal gate in `app.css` | only the traffic lights, the QR plate, and `#000` in the mask |
| Glass fidelity | computed values of the pill, panel shadow, panel sheen, nav gradient, primary button and topbar blur all still equal the old literals; before/after screenshots match |
| Stone, four sections + Settings + first run | no haze, no invisible label, no glow |
| Style round trip | seeded `"uiStyle": "stone"`, launched the packaged app: it opens in Stone with live data; a hand-edited value is honoured; the first status then reconciles the cached copy |
| Keyboard only | Arrow keys move the selection and focus follows; `aria-checked` tracks it |
| 640px and 900px | the appearance bar wraps; Settings stays reachable from the foot |
| Reduced motion | Stone has no entrance at all; the global reduce block still present |
| Packaged | `bash scripts/build-mac.sh` — app 1.46 GiB and dmg 574 MiB, 2,102 links repaired, re-signed, copied to `~/Downloads` |
| `cargo test` | 19 tests pass, including a settings file written before styles existed |

## 7. Measured contrast (Stone)

| Pair | Ratio |
| --- | --- |
| `--ink` on page / panel | 15.30 / 16.70 |
| `--ink-2` on page / panel | 7.54 / 8.23 |
| `--ink-3` on page / panel / well | 4.90 / 5.35 / 5.16 |
| accent label on page / panel | 5.48 / 5.98 |
| flag text on page / panel | 5.58 / 6.09 |
| `--line-control` on page / panel | 3.25 / 3.32 |
| the style set's own `#8b857c` on page / panel | 3.18 / 3.47 — fails for text, hence the correction |

## 8. Out of scope — deliberately not done

- A third style, or porting the remaining five from the spec.
- A dark variant of Stone. *(Done later — §11.)*
- Following the system appearance.
- Restyling Immich's page, or pushing a theme into its API.
- An animation or CSS-in-JS library; the app stays hand-written CSS.
- Touching the runtime, the supervisor, the build scripts, or the icons.

## 9. Deferred, with what would reopen them

- **Stone Dark.** *(Built — §11.)* The spec's own note held: flip the stone ladder rather
  than inverting tokens.
- **Follow the system.** Cheap once two styles exist, but it turns a user choice
  into a suggestion; wait until someone asks.
- **A third style.** One new file plus one contrast pass. Reasons to pick next:
  Blueprint for the logs-heavy views, or Editorial if the app ever grows a
  reading surface.

## 10. Risks, and what holds them

- **The 55 literals.** One missed is a white haze or an invisible label that shows
  up only in Stone. Held by the grep gate and an eight-screen pass in both styles.
- **The lift breaking Glass.** The before/after comparison, in computed values and
  in screenshots.
- **Chrome setters resetting the frame.** `set_background_color`/`set_theme` run
  only when the style actually changed — the trap the decorations switch hit.
- **Two sources of truth.** `settings.json` wins; `localStorage` is a cache; a
  mismatch is reconciled from `StatusView.ui_style` once. Verified live: the app
  started with a cached Stone and a Glass default, reconciled, and rewrote the
  cache.

## 11. Later — Stone Dark, and the ladder underneath it

Stone was one flat block of tokens, so a dark variant had nothing to derive from. It is now
thirteen ordered rungs — page, sunk, raised, seam, hairline, boundary, ink faint/mid/primary,
accent, on-colour, flag, shadow — declared once per walk under `[data-style="stone"]` and
`[data-style="stone-dark"]`, with the token contract written once against the rungs for both.
A variant changes a rung; it never restates a token.

The dark walk starts at the other end of the ladder: the page takes the ink end (`#1a1916`),
sunk goes below it (`#141311`), cards climb to `#201f1c`, and ink takes the paper end
(`#f1efea`). Three rungs are re-measured rather than mirrored, because the flip reads wrong on
them — this is the whole reason the mission asked for a walk and not an inversion:

| Rung | Mirror would be | Shipped | Measured on its real background |
| --- | --- | --- | --- |
| ink faint | `#6b675f` → 1.9:1 | `#9a948b` | 5.48 on the card (`#201f1c`), 6.98 on the page |
| control boundary | 16% white → 1.49:1 | 42% white | 3.64 on the card, 3.70 on the page |
| accent | `#2f6b4f` → 2.1:1 | `#6db894` | 7.48 as text; 7.40 with `--on-accent` `#0e1d17` |

Live measurements in the running hub, dark walk: body `#c9c3ba` on the card 9.42, ink `#f1efea`
on the well 16.16, primary button label on the accent fill 7.40, the eyebrow tier over the card
5.48. The current-page pill's 30%-accent edge is 1.81:1 — the same weak edge the light walk has
(1.6:1), and it is not the only cue: the pill also carries the accent dot and primary ink. Left
as shipped rather than made an outline.

**One bug this surfaced.** A style with no glow set its glow tokens to `none`, and components
write `box-shadow: <edge>, var(--glow-…)`. `none` cannot stand inside a list, so the whole
declaration was dropped and the edge with it — the switch track, the tabs thumb, the drop-zone
focus ring and the QR plate each silently lost their hairline. The zero shadow
`0 0 0 0 transparent` composes; `none` does not.

**Verified.** All three cards switch live; `stone-dark` survives a reload with no flash (the
boot script sets the attribute before first paint, and the page reports `color-scheme: dark`,
`#1a1916` background, `#f1efea` ink on the first frame after reload); `set_ui_style` persists it
to `settings.json` and restyles the window frame; `npm run typecheck` and `npm run build` are
clean. **Not verified this pass:** a click on the packaged app's card — the settings write path
is still covered by symmetry with `set_allow_phones` and the Rust tests rather than by a click.

**A note for the next variant.** The contract now asks thirteen rungs of any new material, and
three of the thirteen are the ones that need measuring rather than deriving: the faintest ink,
the control boundary, and the accent. Everything else is a position on the scale.

## 12. Later — the Apple material, and geometry as a token

The fourth and fifth styles are one material in two walks, `src/styles/styles/apple.css`, and
they are the first ones written *from the platform* rather than from the style set. What AppKit
actually draws, at the sizes this hub renders:

| Thing | AppKit | Shipped |
| --- | --- | --- |
| window | `NSWindow.backgroundColor` | `#ECECEC` light, `#1E1E1E` dark |
| sidebar | `NSVisualEffectView` `.sidebar` | `blur(28px) saturate(180%)` over a 72% wash |
| content card | `controlBackgroundColor` | `#FFFFFF`, `#2C2C2E` dark |
| separator | `separatorColor` | `rgba(60,60,67,.29)`, `rgba(84,84,88,.65)` dark |
| label | `labelColor` | `#1D1D1F`, `#F2F2F7` dark |
| accent | `controlAccentColor` | `#0066CC` light, `#409CFF` dark |
| push button | 28px (22 small) | 28 / 22, measured in the running hub |
| text field | 30px | 30.8 |
| segmented control | 24px, 7px corner | 25, `--radius-segment: 7px` |
| sidebar row | 28px, 6px corner | 29, 6px |

**Geometry became part of the token contract.** A style cannot be native through colour alone:
`.btn` was 38px because `padding: 9px 16px` sat in `app.css`. Five paddings (`--pad-btn`,
`--pad-btn-sm`, `--pad-btn-quiet`, `--pad-field`, `--pad-row`, `--pad-tab`), a segment radius and
a disabled opacity now sit in every style, so the same `.btn` is 38px in Glass and 28px in Apple
without a single per-style component rule. Glass and Stone were given their shipped literals, and
the button, row, field and tab heights measured identical before and after the change. The
`--font-label` token came out of the same pass: the labels were mono in every style, which is the
single loudest "this is not macOS" cue, so Apple sets them in the text face while ports, paths and
log lines stay mono.

**Two blues in the dark walk.** `--accent` has to be legible as 9.5px text on the card and the
button label has to be legible on the accent fill, and one blue cannot do both: `#409CFF` gives
5.9:1 as text but 2.8:1 under white. The dark walk therefore sets `--btn-face` to `#0A63C9`
(5.8:1 with white) while text, dots and edges keep `#409CFF`. AppKit draws the same split between
a tinted control and a filled one.

**Measured, both walks, on their real composited surfaces:**

| | Apple light | Apple dark |
| --- | --- | --- |
| `--ink` on card | 16.83 | 12.49 |
| `--ink-2` on card | 8.07 | 7.79 |
| `--ink-3` on card / page | 5.63 / 5.08 | 5.52 / 6.19 |
| accent as text on card | 5.57 (4.71 on page) | 4.92 |
| button label on its fill | 5.57 | 5.77 |
| control boundary on card / page | 3.44 / 3.22 | 3.37 / 3.59 |
| field edge inside a well | 3.32 | 3.64 |
| flag on card | 5.38 | 4.94 |
| healthy dot on card | 4.4 | 6.89 |

Two of those were wrong on the first measurement and were fixed rather than explained: the light
boundary at 55% measured **2.87:1** on the page and the field edge 2.94, so the rung is 60% now.
The card-on-page contrast is 1.18 — Apple separates surfaces with the hairline, not with
luminance, and a container is not a control.

**Verified in the packaged app, with real mouse clicks** (30 Oct, the bundle built that morning,
driven through CGEvent clicks at the window's own coordinates):

| Entry clicked | `settings.json` after the click | Hub after the click |
| --- | --- | --- |
| Glass | `"glass"` | violet pane, `IN USE` on Glass |
| Stone | `"stone"` | `#f1efea` page, green, no glow |
| Stone Dark | `"stone-dark"` | `#1a1916` page, one green |
| Apple | `"apple"` | `#ececec` window, white cards, blue selection |
| Apple Dark | `"apple-dark"` | `#1e1e1e` window, `#2c2c2e` cards |

Every one re-skinned the whole window in place — no reload, same picker, same live data — and the
same value landed in the `uiStyle` cache the pre-paint script reads. The native theme follows the
style: the folder picker (`NSOpenPanel`) opens dark under Apple Dark and light under Apple, from
the same `set_theme` call. Quitting and relaunching with Apple Dark saved produced a first frame
of `#1e1e1e`, and with Apple saved a first frame of `#ebebeb` — the saved style's page rung, not
the `#080711` the window is configured with, so the frame is restyled before the webview paints
and nothing flashes. Overview, Storage, Backups and Logs were walked in both Apple walks and
render whole: live QR, switch, disabled backup button at `0.32`, the 7px segmented control, and
real log text. `cargo test` 20 pass, including one that every style in `UI_STYLES` has its own
frame colour and that each `-dark` walk pairs with a light base; `npm run typecheck` and
`npm run build` clean; the literal gate in the stylesheets is unchanged.

What a click could not reach: the hub's first-run screen and folder picker (the library is
already configured), a 640px window (the packaged window is fixed at 1024x720 and borderless, so
it has no resize affordance to drag), and the Windows glyph path.

**What this material deliberately does not do.** The hub's shell is floating cards with a 14px
gap; AppKit's is a flush sidebar against a content edge. Making Apple full-bleed would be a
layout change only one style wants, so the material makes the surfaces, controls and type native
and leaves the shell alone. That is the next real step if it ever matters more than the cost of
two shells.

## Final state — two walks, named plainly

The end of the work is smaller than the middle of it. The shell composition did become part of
the material contract (the shell-composition hooks, then still in `tokens.css`), so the AppKit
window became full-bleed: a sidebar that climbs under the titlebar, content directly on the
window, separators doing the containing. Once that material was right, the app kept only it:
**Stone** and **Stone Dark** were removed, **Glass** was removed, and the **Apple** naming went
with the old picker.

The shipped file is `src/styles/styles/system.css`, with two walks of the one ladder —
`[data-style="light"]` and `[data-style="dark"]` — and the appearance bar lists exactly two
cards, **Light** and **Dark**. Dark is the default and the fallback for any id an older build
wrote, so `glass`, `stone`, `stone-dark`, `apple` and `apple-dark` all open as Dark instead of
leaving the window unstyled. The ladder and the contrast numbers above are unchanged: what went
away is the second and third material, not the ladder that made them cheap.

The one-implementation layers went after them. With a single look, the shell-composition hooks
every material used to answer, the `tokens.css` defaults they fell back to, and the effect slots
that existed only to switch Glass's aurora, shine and press off (`--bg-art`, `--glow-*`,
`--shine`, `--press`, `--display-tint` and friends) were all indirection with one value. They are
replaced by the composition stated directly in the stylesheet split (`shell.css`, `page.css`,
`controls.css`) and the handful of shared values in `system.css`; the walk naming and the appearance bar are untouched. The ladder itself was then
narrowed to the ten rungs both walks genuinely read — page, sunk, hairline, boundary, three ink
tiers, accent, on-colour, flag — and the three that only a card surface or a solid seam would
need (raised, seam, shadow) were removed rather than left defined and unread.

The two-card bar was driven with real HID clicks in the packaged bundle on 30 Oct 2026: each
click wrote its id to `settings.json` and re-themed the page and the window frame live, and a
quit-and-relaunch painted the saved walk from the first frame. Details in `README.md` § Appearance
and `README.md` § State.

## The split, 30 October 2026

`src/styles/app.css` was 1,450 lines holding the shell, the sidebar, the titlebar, every page and
the appearance bar, so a change to one of them could not be read on its own. It is now one file
per concern — `base.css`, `shell.css`, `page.css`, `controls.css`, `pages/*.css`, `responsive.css`
— with `index.css` stating the cascade order once, look first and responsive last. No selector and
no value changed; the pre-split file's 187 rules and the split files' 187 rules are the same text,
and no selector appears in two files except the responsive overrides, which stay last. The look
file still owns only what is about a look — colours, type and the few values both walks share.
The literal gate moved with the rules: it now counts the component files and still finds only the
three traffic lights and the QR plate.

## Windows keeps its own look, 30 October 2026

Everything above is the Mac build. The Windows build wears the look it has always worn, and the two
are now kept apart on purpose rather than by accident. `vite.config.ts` chooses one stylesheet from
the platform running the build — `src/styles/index.css` on a Mac, `src/styles/windows/app.css` on
Windows, the latter restored verbatim from the last commit before the split — and exposes the same
answer to the app as `__MAC_LOOK__`, read once in `src/app/platform.ts`. The Mac-only pieces hang
off that: the appearance picker and its sidebar entry are not rendered on Windows, the footer keeps
the version line it shipped with, and `apply_style_chrome` in `lib.rs` compiles to a no-op there.

The sheets cannot be merged, which is the whole point: both draw `.panel`, `.shell`, `.btn` and
`.navitem`, and mean different things by them. Because the Mac look is a different composition of
the same class names, loading both would leave Windows restyled by whichever came second. The
cost is that the components have moved on — the Settings page, the sidebar foot link, `Panel`
without its stagger props — so a few Windows-only rules are still owed, and only a Windows machine
can see them.

## One window on both platforms, 3 November 2026

The Windows sheet is gone. `src/styles/windows/` — the glass look of the earlier work, a violet
aurora behind blurred panes with a white sheen on every card — has been deleted, and every build
now loads `src/styles/index.css`. The Mac composition is the one that was kept: it is the same
window at the same size, its controls are the desktop sizes rather than the iOS ones, and it
already ships two appearances where the glass sheet shipped one.

What that moved:

- `vite.config.ts` has one `@look` alias and `macLook` pinned to `true`, so `__MAC_LOOK__` answers
  the same on both platforms. Its readers — the appearance picker and its sidebar entry, the
  circle window controls, the frame colour the shell paints — therefore apply on Windows too.
- No glass survives. `backdrop-filter` appears nowhere in the stylesheets, the toolbar content
  scrolls under and the sidebar beside it are solid (`#f6f6f6` in Light, `#2c2c2e` and `#262628`
  in Dark), and the `--panel-blur` token went with the last of them. A window drawn with nothing
  behind the webview had nothing to blur anyway.
- `apply_style_chrome` in `lib.rs` paints the frame and the native theme on every platform instead
  of compiling to a no-op off macOS, and `tauri.conf.json` opens the window on `#1e1e1e` rather
  than the glass look's `#080711`.

The 30 October section above stays as the record of what was true then; the split it describes is
the thing this replaces.
