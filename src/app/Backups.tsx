import { backups } from "@/app/data";
import { Button } from "@/ui/Button";
import { Panel } from "@/ui/Panel";

export function Backups() {
  return (
    <div className="page">
      <header>
        <p className="eyebrow">Backups</p>
        <h1 className="display display--sm">A copy you can restore</h1>
        <p className="lede">
          A backup is a database dump plus the settings file. Photos are not copied — they
          are already yours, in the folder you chose.
        </p>
      </header>

      <Panel>
        <div className="section-head">
          <p className="eyebrow">Schedule</p>
          <span className="section-head__note">{backups.schedule}</span>
        </div>
        <div className="empty">
          <span className="empty__title">No backups yet</span>
          <span className="empty__note">
            Nightly dumps with retention arrive in M5, along with restore. Until then the
            button stays off rather than pretending to protect anything.
          </span>
        </div>
        <div className="phone__actions">
          <Button variant="primary" disabled>
            Back up now
          </Button>
          <Button variant="quiet" disabled>
            Open backup folder
          </Button>
        </div>
      </Panel>
    </div>
  );
}
