import { useState } from "react";
import { library } from "@/app/data";
import { Button } from "@/ui/Button";
import { Field } from "@/ui/Field";
import { Panel } from "@/ui/Panel";

type Props = {
  folder: string | null;
  live: boolean;
  onChooseFolder: (path: string) => Promise<void>;
};

export function Storage({ folder, live, onChooseFolder }: Props) {
  const path = folder ?? library.folder;
  const [picking, setPicking] = useState(false);

  const choose = async () => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({
      directory: true,
      multiple: false,
      title: "Choose the photo folder",
      defaultPath: folder ?? undefined,
    });
    if (!picked) {
      return;
    }
    setPicking(true);
    try {
      await onChooseFolder(String(picked));
    } finally {
      setPicking(false);
    }
  };

  return (
    <div className="page">
      <header>
        <p className="eyebrow">Storage</p>
        <h1 className="display display--sm">Where the photos live</h1>
        <p className="lede">
          One folder holds the library, the database cluster, the queue and the backups.
          Point this at a local disk — never a network share or a synced folder.
        </p>
      </header>

      <Panel index={1}>
        <Field
          label="Photo folder"
          mono
          readOnly
          value={path}
          hint="Changing this switches the app to that folder. Nothing is moved: the photos and the account in the old folder stay there, and an empty folder starts a fresh library."
          action={
            <Button
              size="sm"
              variant="ghost"
              disabled={!live || picking}
              onClick={() => void choose()}
            >
              {picking ? "Switching" : "Change"}
            </Button>
          }
        />
      </Panel>

      <Panel index={2}>
        <div className="section-head">
          <p className="eyebrow">This library</p>
          <span className="section-head__note">
            {library.used} of {library.free} free
          </span>
        </div>
        <div className="meter">
          <div className="meter__head">
            <span>
              {library.photos.toLocaleString()} photos · {library.videos} videos
            </span>
            <span>{library.share}% of the volume</span>
          </div>
          <div
            className="meter__track"
            role="meter"
            aria-valuenow={library.share}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Disk used by the library"
          >
            <div className="meter__fill" style={{ width: `${library.share}%` }} />
          </div>
        </div>
        <dl className="kv" style={{ marginTop: 18 }}>
          <dt>Originals</dt>
          <dd className="mono">media/upload · media/library</dd>
          <dt>Thumbnails</dt>
          <dd className="mono">media/thumbs</dd>
          <dt>Database</dt>
          <dd className="mono">database/pgdata</dd>
        </dl>
      </Panel>

      <Panel index={3}>
        <p className="eyebrow">Checks before setup</p>
        <div className="empty" style={{ marginTop: 12 }}>
          <span className="empty__title">Folder checks run before the switch</span>
          <span className="empty__note">
            Network shares, removable volumes and OneDrive-style synced folders are
            refused before the database is created, because Postgres over a sync client
            corrupts.
          </span>
        </div>
      </Panel>
    </div>
  );
}
