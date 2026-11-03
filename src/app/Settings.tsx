import { useCallback, useEffect, useState } from "react";
import type { KeyboardEvent } from "react";
import {
  checkForUpdate,
  inTauri,
  installUpdate,
  type UpdateCheck,
} from "@/app/runtime";
import { UI_STYLES, type StyleId } from "@/app/style";
import { Button } from "@/ui/Button";
import { Pill } from "@/ui/Pill";

function messageOf(cause: unknown): string {
  // A rejected command arrives as a string; a broken import arrives as an Error.
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * The update row.
 *
 * The release channel is this project's GitHub releases, and the endpoint and
 * signing key live in `tauri.conf.json` — not here — so the page cannot be
 * pointed at another manifest. Opening Settings is the check: the answer is what
 * the section is for, and asking on demand too is one button. Nothing downloads
 * until the user presses install, and an update never touches the library
 * folder: it replaces the app beside it.
 */
function Updates() {
  const [check, setCheck] = useState<UpdateCheck | null>(null);
  const [busy, setBusy] = useState<"checking" | "installing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [percent, setPercent] = useState<number | null>(null);

  const run = useCallback(async () => {
    setBusy("checking");
    setError(null);
    try {
      setCheck(await checkForUpdate());
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }, []);

  // Once per visit, and only inside the app: a browser preview has no shell to
  // ask, and `inTauri` is false there.
  useEffect(() => {
    if (inTauri) {
      void run();
    }
  }, [run]);

  // Download progress, one event per percent (see `update_install`).
  useEffect(() => {
    if (!inTauri) {
      return;
    }
    let stop: (() => void) | undefined;
    let cancelled = false;
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen<{ received: number; total: number | null }>("update-progress", (event) => {
        const { received, total } = event.payload;
        setPercent(total ? Math.min(100, Math.round((received / total) * 100)) : null);
      }).then((unlisten) => {
        // The page can unmount while the import is still in flight.
        if (cancelled) {
          unlisten();
        } else {
          stop = unlisten;
        }
      }),
    );
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  const install = useCallback(async () => {
    setBusy("installing");
    setError(null);
    setPercent(null);
    try {
      await installUpdate();
      // A successful install restarts the app, so this line is only reached when
      // the new build was installed but the process was not replaced.
      setError("The update was installed. Quit the app and open it again to use it.");
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
      setPercent(null);
    }
  }, []);

  const available = check?.available ?? null;
  const state = !inTauri
    ? "The app checks for updates; this preview cannot."
    : busy === "installing"
      ? percent === null
        ? "Downloading and verifying the new build…"
        : `Downloading and verifying the new build… ${percent}%`
      : busy === "checking"
        ? "Asking GitHub for the newest release…"
        : available
          ? `Version ${available.version} is ready to install.`
          : check
            ? "This is the newest build."
            : "Not checked yet.";

  return (
    <section className="panel settings">
      <p className="eyebrow">UPDATES</p>
      <h2 className="display display--sm">Keep it current</h2>
      <p className="lede">
        Immich Desktop reads this project&rsquo;s releases on GitHub. The download is verified
        against the key built into the app before it runs, and your library folder is never
        touched.
      </p>

      <div className="update">
        <dl className="update__facts">
          <div>
            <dt>This build</dt>
            <dd>{check?.current ?? "—"}</dd>
          </div>
          <div>
            <dt>Newest release</dt>
            <dd>{available ? available.version : check ? "Same as this build" : "—"}</dd>
          </div>
        </dl>

        <p className="update__state" aria-live="polite">
          {state}
        </p>

        {percent !== null ? (
          <div
            className="update__bar"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span className="update__fill" style={{ width: `${percent}%` }} />
          </div>
        ) : null}

        {available?.notes ? (
          <p className="update__notes">{available.notes}</p>
        ) : null}

        <div className="update__actions">
          {available ? (
            <Button
              variant="primary"
              onClick={() => void install()}
              disabled={busy !== null}
            >
              {busy === "installing" ? "Installing…" : `Install ${available.version} and restart`}
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void run()}
              disabled={busy !== null || !inTauri}
            >
              {busy === "checking" ? "Checking…" : "Check for updates"}
            </Button>
          )}
          {available ? (
            <Button variant="quiet" onClick={() => void run()} disabled={busy !== null}>
              Check again
            </Button>
          ) : null}
          {available ? <Pill tone="idle">{`${available.version} available`}</Pill> : null}
        </div>

        {error ? <p className="hint hint--flag">{error}</p> : null}
      </div>
    </section>
  );
}

type Props = {
  style: StyleId;
  onSelect: (style: StyleId) => void;
  error: string | null;
};

/**
 * The appearance bar.
 *
 * A radio group, not a grid of screenshots: each option renders a miniature
 * from the real primitives — the same `panel`, `btn` and `pill` classes, inside
 * its own `data-style` subtree — so a swatch cannot drift from the style it
 * promises. There is no second drawing of the design to keep in step.
 *
 * Choosing applies immediately; there is nothing to save, and nothing that can
 * be left dirty.
 */
export function Settings({ style, onSelect, error }: Props) {
  // Arrow keys move the selection and focus follows it, as a radio group does.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const keys = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"];
    if (!keys.includes(event.key)) {
      return;
    }
    event.preventDefault();
    const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : -1;
    const index = UI_STYLES.findIndex((option) => option.id === style);
    const next = UI_STYLES[(index + step + UI_STYLES.length) % UI_STYLES.length];
    onSelect(next.id);
    document.getElementById(`style-${next.id}`)?.focus();
  };

  return (
    <div className="page">
      <section className="panel settings">
        <p className="eyebrow">APPEARANCE</p>
        <h2 className="display display--sm">Choose a look</h2>
        <p className="lede">
          Every style is a complete design: the same window, the same controls, drawn differently.
          The choice is stored on this machine, and the library keeps Immich&rsquo;s own
          appearance either way.
        </p>

        <div
          className="styles"
          role="radiogroup"
          aria-label="Interface style"
          onKeyDown={onKeyDown}
        >
          {UI_STYLES.map((option) => {
            const selected = option.id === style;
            return (
              <button
                key={option.id}
                id={`style-${option.id}`}
                type="button"
                role="radio"
                aria-checked={selected}
                tabIndex={selected ? 0 : -1}
                className="stylecard"
                onClick={() => onSelect(option.id)}
              >
                <span className="stylecard__head">
                  <span className="stylecard__name">{option.name}</span>
                  {/* Always rendered, so choosing cannot resize the card. */}
                  <span className="stylecard__state" aria-live="polite">
                    {selected ? "In use" : ""}
                  </span>
                </span>

                {/* Its own tokens, on its own subtree: the swatch is the style. */}
                <span className="stylecard__frame" data-style={option.id} aria-hidden="true">
                  <span className="stylecard__panel panel">
                    <span className="stylecard__lines">
                      <span className="stylecard__line stylecard__line--short" />
                      <span className="stylecard__line" />
                    </span>
                    <span className="stylecard__controls">
                      <span className="btn btn--primary btn--sm">Copy address</span>
                      <Pill tone="live">live</Pill>
                    </span>
                  </span>
                </span>

                <span className="stylecard__note">{option.note}</span>
              </button>
            );
          })}
        </div>

        {error ? <p className="hint hint--flag">{error}</p> : null}
      </section>

      <Updates />
    </div>
  );
}
