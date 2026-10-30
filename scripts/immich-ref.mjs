/**
 * The one place the upstream Immich revision is pinned.
 *
 * The server build, the core-plugin build and the corresponding-source package
 * all have to agree: a source tarball cut from a different revision than the
 * shipped `dist/main.js` is not the corresponding source, it is a plausible
 * looking substitute. Both assemblers read the ref from here.
 */
export const IMMICH_REF = "v3.3.5";

/** Patched relative to the repository root. */
export const PATCH_FILE = "immich/v3.3.5-desktop.patch";
