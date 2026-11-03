/**
 * Whether this build wears the Mac look.
 *
 * There is one look now, on both platforms: the Mac's AppKit shell, from
 * `src/styles/index.css`. The Windows sheet that shipped beside it — the glass
 * look, all blurred panes and violet aurora — is gone, so the answer is `true`
 * everywhere. The flag stays because the pieces that arrived with that look — the
 * frame colour the shell paints, the appearance picker, the circle window
 * controls — read it, and a bundle must never draw them without the sheet that
 * gives them their surfaces.
 */
export const isMac = __MAC_LOOK__;
