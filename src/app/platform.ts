/**
 * Whether this build is the Mac one.
 *
 * The hub is drawn twice — the Mac's AppKit shell and the Windows look — and the
 * build loads exactly one stylesheet, chosen in `vite.config.ts` from the
 * platform that ran the build. This reads the same choice rather than sniffing
 * the browser, so the pieces that belong to the Mac look alone — the frame colour
 * the shell paints, the appearance picker, the circle window controls — can never
 * disagree with the sheet that is actually loaded.
 */
export const isMac = __MAC_LOOK__;
