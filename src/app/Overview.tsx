import { useEffect, useRef, useState } from "react";
import { connection, library, services as mockServices, type ServiceState } from "@/app/data";
import { ImportCard } from "@/app/ImportCard";
import { phoneQr, serverUrl, type Status } from "@/app/runtime";
import { Button } from "@/ui/Button";
import { Panel } from "@/ui/Panel";
import { Switch } from "@/ui/Switch";

type Row = {
  id: string;
  name: string;
  detail: string;
  port: string;
  state: ServiceState | "failed";
};

const stateLabel: Record<string, string> = {
  running: "Running",
  starting: "Starting",
  stopped: "Stopped",
  offline: "Stopped",
  absent: "Not installed",
  failed: "Failed",
};

/** The dot classes the stylesheet knows: running, starting, offline, absent. */
const dotClass = (state: string) =>
  state === "running" || state === "starting" || state === "absent" ? state : "offline";

type Props = {
  status: Status | null;
  live: boolean;
  error: string | null;
  onStart: () => void;
  onStop: () => void;
  onOpenLibrary: () => void;
  onAllowPhones: (enabled: boolean) => void;
  onAllowFirewall: () => void;
  libraryError: string | null;
};

function rows(status: Status | null, live: boolean): Row[] {
  if (live && status) {
    return status.services.map((service) => ({
      id: service.id,
      name: service.name,
      detail: service.detail,
      port: service.port ? `:${service.port}` : "",
      state: service.state === "stopped" ? "offline" : service.state,
    }));
  }
  return mockServices.map((service) => ({
    id: service.id,
    name: service.name,
    detail: service.detail,
    port: service.state === "absent" ? "Not installed" : service.port,
    state: service.state,
  }));
}

function Services({ status, live }: { status: Status | null; live: boolean }) {
  const list = rows(status, live);
  const running = list.filter((row) => row.state === "running").length;

  return (
    <Panel index={2}>
      <div className="section-head">
        <p className="eyebrow">Services</p>
        <span className="section-head__note">
          {running} of {list.length} running
        </span>
      </div>
      <div className="services">
        {list.map((row) => (
          <div className="service" key={row.id}>
            <span
              className={`service__dot service__dot--${dotClass(row.state)}`}
              role="img"
              aria-label={stateLabel[row.state] ?? row.state}
            />
            <div className="service__name">{row.name}</div>
            <div className="service__detail">{row.detail}</div>
            <div className="service__port">{row.port}</div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function PhoneCard({
  status,
  live,
  onAllowPhones,
  onAllowFirewall,
}: {
  status: Status | null;
  live: boolean;
  onAllowPhones: (enabled: boolean) => void;
  onAllowFirewall: () => void;
}) {
  // The switch is the server's listening address, not a local preference: off
  // means loopback only, so the address below is not reachable from a phone.
  const phones = status?.allowPhones ?? true;
  const [copied, setCopied] = useState<"idle" | "done" | "failed">("idle");
  const [code, setCode] = useState("");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  const url = live && status ? serverUrl(status) : connection.url;
  const waiting = live && !status?.lanAddress;
  // The code is generated from the same string the card prints, so a phone that
  // scans it cannot end up on a different server than a phone that copied it.
  const scanable = !waiting && url.startsWith("http");
  const blocked = live && phones && status?.firewall === false;

  useEffect(() => {
    if (!live || !scanable) {
      setCode("");
      return;
    }
    let alive = true;
    phoneQr(url).then(
      (markup) => {
        if (alive) {
          setCode(markup);
        }
      },
      () => {
        if (alive) {
          setCode("");
        }
      },
    );
    return () => {
      alive = false;
    };
  }, [url, live, scanable]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied("done");
    } catch {
      // The webview can refuse clipboard access; the address stays selectable.
      setCopied("failed");
    }
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCopied("idle"), 1800);
  };

  return (
    <Panel index={1} blur>
      <div className="phone">
        <div>
          <p className="eyebrow">Phone connection</p>
          <p className="phone__address">{url}</p>
          <p className="hint">
            {waiting
              ? "The address appears once the server runs and this computer is on a network."
              : "Paste this into the Immich app on your phone. It only changes when this computer's network address does."}
          </p>
          <div className="phone__actions">
            <Button variant="primary" onClick={() => void copy()} disabled={waiting}>
              {copied === "done" ? "Copied" : "Copy address"}
            </Button>
            <Switch checked={phones} onChange={onAllowPhones} label="Allow phones" />
          </div>
          <ul className="phone__steps">
            <li>
              <strong aria-hidden="true">1</strong> Join the same Wi-Fi as this computer.
            </li>
            <li>
              <strong aria-hidden="true">2</strong> In the Immich app, open Server URL.
            </li>
            <li>
              <strong aria-hidden="true">3</strong> Paste the address and sign in.
            </li>
          </ul>
          {copied === "failed" ? (
            <p className="hint">
              The clipboard is blocked here. Select the address above and copy it yourself.
            </p>
          ) : null}
          {blocked ? (
            <>
              <p className="hint">
                Windows blocks this app on the local network, so the phone cannot reach the
                address above. Allow it once, and Windows shows its prompt.
              </p>
              <div className="phone__actions">
                <Button onClick={onAllowFirewall}>Allow through firewall</Button>
              </div>
            </>
          ) : null}
        </div>
        {code ? (
          <div className="phone__qr" dangerouslySetInnerHTML={{ __html: code }} />
        ) : (
          <div className="phone__qr phone__qr--empty" aria-hidden="true">
            QR appears
            <br />
            after setup
          </div>
        )}
      </div>
    </Panel>
  );
}

function LibrarySummary({ status, live }: { status: Status | null; live: boolean }) {
  const folder = live && status ? status.folder : library.folder;
  const ready = live ? Boolean(status?.initialised) : false;
  const value = live ? (ready ? 100 : 0) : library.share;

  return (
    <Panel index={4}>
      <div className="section-head">
        <p className="eyebrow">Library</p>
        <span className="section-head__note">
          {live ? (ready ? "database ready" : "not initialised") : `${library.used} used`}
        </span>
      </div>
      <div className="mono" style={{ fontSize: 12, color: "var(--ink-2)" }}>
        {folder}
      </div>
      <div className="meter">
        <div className="meter__head">
          <span>
            {live
              ? ready
                ? "Postgres cluster initialised"
                : "First run will initialise the cluster"
              : `${library.photos.toLocaleString()} photos · ${library.videos} videos`}
          </span>
          <span>{live ? "sizes on Storage" : `${library.free} free`}</span>
        </div>
        <div
          className="meter__track"
          role="meter"
          aria-valuenow={value}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label="Library setup"
        >
          <div className="meter__fill" style={{ width: `${value}%` }} />
        </div>
      </div>
    </Panel>
  );
}

export function Overview({
  status,
  live,
  error,
  onStart,
  onStop,
  onOpenLibrary,
  onAllowPhones,
  onAllowFirewall,
  libraryError,
}: Props) {
  const running = status?.services.some((service) => service.state === "running") ?? false;
  // Between the click and the first health check the supervisor is already
  // wanted, so the action must not offer to start it again.
  const starting = !running && (status?.desired ?? false);

  const port = status?.serverPort;
  const address = live ? (status?.lanAddress ?? "this computer only") : connection.host;
  const folder = live && status ? status.folder : library.folder;
  const leaf = folder.split(/[\\/]/).filter(Boolean).pop() ?? folder;

  return (
    <div className="page">
      <div className="hero">
        <Panel index={0} className="hero__intro panel--hero">
          <p className="eyebrow">On this machine</p>
          <h1 className="display display--gradient">Your photos, on your machine.</h1>
          <p className="lede">
            Starting the server also starts its Postgres database and its job queue, without
            Docker and without a terminal. All three run out of the folder you chose, and your
            phone reaches them over the local network.
          </p>

          {live ? (
            <div className="hero__actions">
              {running ? (
                <>
                  <Button variant="primary" onClick={onOpenLibrary}>
                    Open library
                  </Button>
                  <Button onClick={onStop}>Stop server</Button>
                </>
              ) : starting ? (
                <Button disabled>Starting the server</Button>
              ) : (
                <Button variant="primary" onClick={onStart}>
                  Start server
                </Button>
              )}
              {status?.message ? <span className="hint">{status.message}</span> : null}
              {libraryError ? <span className="hint">{libraryError}</span> : null}
            </div>
          ) : null}
          {error ? <p className="hint">Supervisor: {error}</p> : null}

          <dl className="vitals">
            <div className="vital">
              <dt className="vital__label">Port</dt>
              <dd className="vital__value">{port ? `:${port}` : ":2283"}</dd>
            </div>
            <div className="vital">
              <dt className="vital__label">Reachable at</dt>
              <dd className="vital__value" title={address}>
                {address}
              </dd>
            </div>
            <div className="vital">
              <dt className="vital__label">Library</dt>
              <dd className="vital__value" title={folder}>
                {leaf}
              </dd>
            </div>
          </dl>
        </Panel>

        <PhoneCard
          status={status}
          live={live}
          onAllowPhones={onAllowPhones}
          onAllowFirewall={onAllowFirewall}
        />
      </div>

      <Services status={status} live={live} />

      <div className="split">
        <ImportCard status={status} live={live} running={running} />
        <LibrarySummary status={status} live={live} />
      </div>
    </div>
  );
}
