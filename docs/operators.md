# Operating the Candyriya PacketManager

The packetmanager is the public plugin registry for Candyriya. It stores signed
plugin bundles on disk, serves the public index over HTTP, and checks
compatibility against the running proxy's plugin API level. This page is
everything you need to run it in production.

## Requirements

- **Bun** — a current stable release. The service is TypeScript on Elysia;
  there is no build step, `bun run start` is the whole thing.
- **Linux or another Unix-like OS.** You want a dedicated system uid/gid for
  the service; the data directory carries strict permission expectations
  (see below).
- **Disk for `$PM_DATA_DIR`.** Grows with the number of plugins times the
  average bundle size — small for the foreseeable future, and it only grows
  when someone publishes.
- **One free TCP port** — 8093 by default.
- **No outbound network** is needed at runtime. Inbound access can be limited
  to your reverse proxy.

## Install and run

```console
git clone https://github.com/CandyriyaMC/packetmanager.git /opt/candyriya-packetmanager
cd /opt/candyriya-packetmanager
bun install
bun run start
```

The service binds all interfaces by default, so keep 8093 behind the proxy and
firewalled off the public internet, and do not expose it until `PM_API_KEY`
is set — without the key, publish is hard-unauthorized (see below).
Sanity-check it:

```console
curl -fsS http://127.0.0.1:8093/health   # {"status":"ok"}
```

## Environment variables

| Variable     | Default          | Purpose                                        |
| ------------ | ---------------- | ---------------------------------------------- |
| `PM_DATA_DIR` | `./data`         | Where bundles and manifests live               |
| `PORT`       | `8093`           | Listen port                                    |
| `PM_API_KEY` | *(unset)*        | Publish key — see below                        |

**`PM_API_KEY` is required for publish, period.** Without it the publish
endpoint is hard-unauthorized in production — the registry does not publish,
and `POST /api/v1/plugins/publish` answers `401`. That is a hard failure, not
a warning, not "advisory", not a dev-mode passthrough you should ever expose.
If you run the service without `PM_API_KEY`, keep the port completely off the
network.

Generate a key and store it in an env file, never in the repo:

```console
printf 'PM_API_KEY=%s\n' "$(openssl rand -hex 32)" > /etc/candyriya-packetmanager.env
chmod 0600 /etc/candyriya-packetmanager.env
```

`PM_BASE_URL` is read by the bootstrap but currently unused — ignore it.

## Endpoints

| Endpoint                          | Purpose                              | Auth          |
| --------------------------------- | ------------------------------------ | ------------- |
| `GET /health`                     | Liveness probe                       | none          |
| `GET /ready`                      | Readiness probe                      | none          |
| `GET /metrics`                    | Prometheus metrics                   | none          |
| `GET /api/v1/plugins`             | List published plugins               | none          |
| `GET /api/v1/plugins/:id`         | Plugin detail                        | none          |
| `GET /api/v1/plugins/:id/download` | Bundle bytes                        | none          |
| `POST /api/v1/plugins/publish`    | Publish a bundle                     | `x-api-key`   |

`/metrics` is specified by the phase 1 epic as Prometheus text exposition; if
your checkout answers 404 there, the epic work has not landed yet — `/health`
and `/ready` are the built-in probes today.

## Exposing it

Pick one. All of these assume the env file from above and a dedicated
`candyriya-pm` uid (see permissions below).

### nginx (TLS termination + reverse proxy)

```nginx
server {
    listen 443 ssl;
    server_name pm.example.org;

    ssl_certificate     /etc/letsencrypt/live/pm.example.org/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/pm.example.org/privkey.pem;

    client_max_body_size 64m;   # room for .plugin bundles; raise if yours outgrow it

    location / {
        proxy_pass http://127.0.0.1:8093;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }
}
```

Reload with `nginx -s reload`. `proxy_pass` on a loopback upstream means 8093
never needs to be reachable from outside — enforce that at the firewall
(`ufw deny 8093/tcp`, keep `allow 443/tcp`).

### systemd

```ini
# /etc/systemd/system/candyriya-packetmanager.service
[Unit]
Description=Candyriya PacketManager
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=candyriya-pm
Group=candyriya-pm
Environment=PM_DATA_DIR=/var/lib/candyriya-packetmanager
Environment=PORT=8093
EnvironmentFile=/etc/candyriya-packetmanager.env
WorkingDirectory=/opt/candyriya-packetmanager
ExecStart=/usr/local/bin/bun run src/index.ts
Restart=on-failure
RestartSec=2
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=/var/lib/candyriya-packetmanager
ProtectHome=true

[Install]
WantedBy=multi-user.target
```

`systemctl daemon-reload && systemctl enable --now candyriya-packetmanager`.
Note there is no `-` on `EnvironmentFile`: if the env file is missing the
service fails to start, which is the fail-closed behavior you want.
Adjust the bun path to wherever `command -v bun` points.

### OpenRC / runit (systemd-style service managers)

runit style — `/etc/sv/candyriya-packetmanager/run` (chmod 0755):

```sh
#!/bin/sh
set -a; . /etc/candyriya-packetmanager.env; set +a
export PM_DATA_DIR=/var/lib/candyriya-packetmanager PORT=8093
exec chpst -u candyriya-pm /usr/local/bin/bun run /opt/candyriya-packetmanager/src/index.ts
```

Then `ln -s /etc/sv/candyriya-packetmanager /var/service/`. On OpenRC, use
the same wrapper pattern: an `init.d` script whose `start()` sources the env
file and launches bun with `command_user=candyriya-pm`. Same idea, same env
file, same rules.

### supervisor

supervisor does not read env files natively, so use a tiny wrapper:

```sh
# /opt/candyriya-packetmanager/run.sh (chmod 0755, root-owned)
#!/bin/sh
set -a; . /etc/candyriya-packetmanager.env; set +a
export PM_DATA_DIR=/var/lib/candyriya-packetmanager PORT=8093
exec /usr/local/bin/bun run src/index.ts
```

```ini
# /etc/supervisor/conf.d/candyriya-packetmanager.conf
[program:candyriya-packetmanager]
command=/opt/candyriya-packetmanager/run.sh
directory=/opt/candyriya-packetmanager
user=candyriya-pm
autorestart=true
stopasgroup=true
stdout_logfile=/var/log/candyriya-packetmanager.log
stdout_logfile_maxbytes=10MB
stdout_logfile_backups=5
```

`supervisorctl reread && supervisorctl update`. Keep the supervisor config
`0640` — it contains no secrets (the key lives in the env file), but there is
no reason to make it world-readable.

## Data directory: layout and backup

The registry is stateless apart from the disk. Everything it knows lives under
`$PM_DATA_DIR`:

```
$PM_DATA_DIR/
  my-plugin/
    manifest.json     # id, name, version, publishedAt
    plugin.wasm       # bundle bytes served by /api/v1/plugins/my-plugin/download
  other-plugin/
    manifest.json
    plugin.wasm
```

The epic contemplates SQLite as an alternative backend; if that ever lands,
backup becomes a database dump instead of a tree walk — env vars, endpoints
and everything else on this page stay the same.

**Snapshot the whole tree.** Either with the service stopped, or off a
filesystem snapshot (btrfs/zfs/LVM) so the archive is consistent:

```console
systemctl stop candyriya-packetmanager
tar -czpf /var/backups/pm-data-$(date +%F).tgz -C "$PM_DATA_DIR" .
systemctl start candyriya-packetmanager

# live-system variant (small race; prefer the filesystem snapshot if the FS supports it)
rsync -a --delete "$PM_DATA_DIR/" "/var/backups/pm-data/"
```

Restore is the reverse: stop the service, empty the directory, unpack the
archive into it, fix ownership and permissions back to `candyriya-pm:candyriya-pm`
with `0700`/`0600`, start the service, then diff reality against the backup:

```console
systemctl stop candyriya-packetmanager
find "$PM_DATA_DIR" -mindepth 1 -delete
tar -xzpf /var/backups/pm-data-2026-11-18.tgz -C "$PM_DATA_DIR"
chown -R candyriya-pm:candyriya-pm "$PM_DATA_DIR"
find "$PM_DATA_DIR" -type d -exec chmod 0700 {} +
find "$PM_DATA_DIR" -type f -exec chmod 0600 {} +
systemctl start candyriya-packetmanager

```console
ls "$PM_DATA_DIR" | wc -l
curl -fsS http://127.0.0.1:8093/api/v1/plugins | jq length
```

Those two numbers should match.

## File permissions

`$PM_DATA_DIR` holds signed bundles and the manifests the index is rebuilt
from, so it should not be readable or writable by anyone but the service.
Run once as root:

```console
groupadd --system candyriya-pm
useradd --system --gid candyriya-pm --no-create-home --shell /usr/sbin/nologin candyriya-pm

install -d -o candyriya-pm -g candyriya-pm -m 0700 /var/lib/candyriya-packetmanager
find /var/lib/candyriya-packetmanager -type f -exec chmod 0600 {} +

# the env file with PM_API_KEY: root-owned, group-readable by the service only
chown root:candyriya-pm /etc/candyriya-packetmanager.env
chmod 0640 /etc/candyriya-packetmanager.env
```

Rules of thumb: the data directory is `0700`, everything in it `0600`, the key
file `0600` or `0640 root:candyriya-pm`. Nothing in `$PM_DATA_DIR` should ever
be group- or world-writable — a tampered manifest is a tampered index.

## Health and metrics

```console
curl -fsS http://127.0.0.1:8093/health   # {"status":"ok"}    liveness — is the process up?
curl -fsS http://127.0.0.1:8093/ready    # {"status":"ready"}  readiness — is it serving?
```

Point uptime checks and alerting at `/health`, load balancers at `/ready`.
Wire Prometheus at `/metrics`:

```yaml
scrape_configs:
  - job_name: packetmanager
    static_configs:
      - targets: ['127.0.0.1:8093']
```

## Recovery: rebuilding the index from disk

The index is derived state — rebuilt deterministically from the bundles and
manifests on disk. If the index is lost, corrupted, or you simply do not
trust it, the procedure is:

1. **Quiesce writes.** Stop the service, or work off a snapshot. Never
   rebuild against a live directory being written to.
2. **Walk the tree.** `ls "$PM_DATA_DIR"` — one directory per plugin id.
   Anything that is not a directory, or has no `manifest.json`, is not
   served and is skipped.
3. **Read every manifest.** For each plugin id, parse `manifest.json` and
   require `id`, `name`, `version`. Unreadable or invalid entries are skipped
   and logged, never half-published.
4. **Verify signatures.** Check each bundle's detached ed25519 signature
   against the publisher key list (and the registry's release key for the
   index itself). Entries that fail verification do not enter the index.
5. **Sort deterministically.** By `id` ascending, then semver ascending.
6. **Write atomically.** Emit the new index to a temporary file, fsync,
   then rename into place. Readers see either the old index or the new one,
   never a partial file.
7. **Verify.** Restart the service, then
   `curl -fsS http://127.0.0.1:8093/api/v1/plugins` — the set you get back
   must match the set you walked in step 2–4, exactly.

A read-only inventory of what is on disk (safe to run any time, changes
nothing):

```console
for d in "$PM_DATA_DIR"/*/; do
  jq -r '"\(.id)\t\(.version)"' "$d/manifest.json"
done | sort
```

The phase 1 epic specifies this rebuild but ships no rebuild tool yet — this
section is the specification the tool will implement, not a script to
copy-paste. Do not hand-edit an index file if you find one; indexes rebuilt
by hand drift. Re-run the walk, or wait for the rebuild tool.

## Upgrading

```console
cd /opt/candyriya-packetmanager
git pull
bun install
systemctl restart candyriya-packetmanager   # or your supervisor equivalent
```

The index rebuilds from disk on start, so bundles survive upgrades untouched.
Take a `$PM_DATA_DIR` snapshot before upgrading anything that touches the
manifest format.
