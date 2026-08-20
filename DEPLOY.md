# Quizzy — Production Deployment on a Fresh Ubuntu 26.04 Host

End-to-end runbook to deploy the `quizzy` project (https://github.com/Delors/quiz.git)
behind Caddy with HTTPS, using the DHBW HARICA ACME endpoint, the Node backend
running under a dedicated service user, both managed by systemd.

Replace the example values (host name, IP, DNS server, TSIG key) with your own.

---

## 0. Prerequisites

- A host on the **DHBW network** with a fixed **internal IP** (example: `141.72.12.141`).
  The IP is only routable inside the DHBW network — clients must be on campus or on
  the DHBW VPN to reach the service.
- A subdomain allocated to you, e.g. `quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site`.
- A **TSIG key** (RFC2136) from the platform team to set your DNS `A` record,
  plus the DNS server address (example: `141.72.5.244`).
- `sudo`/root access on the host.
- Ports **80 and 443** reachable on the host from within the DHBW network
  (required for the ACME HTTP-01 challenge and for serving the site).

> Throughout this document the placeholder `<HOST>` means, e.g., 
> `quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site`.

---

## 1. System preparation

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl ufw
```

---

## 2. Firewall (do this before enabling it!)

Enabling `ufw` without allowing SSH first will lock you out of the host.

```bash
sudo ufw allow OpenSSH          # keep your SSH session alive
sudo ufw allow 80,443/tcp       # HTTP (ACME challenge + redirect) and HTTPS
sudo ufw enable
sudo ufw status verbose
```

---

## 3. Install Node.js (current LTS, system-wide)

Node.js **24** is the Active LTS line as of mid-2026 (Node 22 is in maintenance,
Node 26 is still "Current" and not yet recommended for production).

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version          # expect v24.x
command -v node         # expect /usr/bin/node  (matches the systemd unit below)
```

> If NodeSource does not yet provide a repository for Ubuntu 26.04, fall back to the
> distribution package: `sudo apt install -y nodejs npm` (version may lag slightly).

A system-wide install puts `node` in `/usr/bin`, executable by every user — including
the login-less service user created in step 5. Do **not** use `nvm` here: it installs
per-user under `~/.nvm` and cannot be used by a `nologin` service account.

---

## 4. Install Caddy (system-wide, with systemd service)

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

The package automatically creates the **`caddy` system user** and an enabled
`caddy.service`. We point that service at our own config in steps 8–9.

---

## 5. Create the backend service user

A system account with no home directory and no login shell:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin quizzy
getent passwd quizzy     # verify: low UID, shell /usr/sbin/nologin
```

---

## 6. Deploy the application code

```bash
sudo git clone https://github.com/Delors/quiz.git /srv/quizzy
```

Directory layout after checkout:

```
/srv/quizzy/
├── Caddyfile                 # template (copied to /etc/caddy in step 8)
├── caddy/
│   ├── tls-auto.txt          # empty  -> automatic HTTPS (production)
│   └── tls-mkcert.txt        # local dev only
├── package.json              # workspace root: build scripts
├── pnpm-workspace.yaml
├── build.js                  # esbuild -> dist/
├── packages/
│   ├── ld-quiz/              # embeddable <ld-quiz> web component (browser)
│   └── server/               # Node backend
│       ├── src/server.js     # entry point  (listens on PORT || 3000)
│       ├── web/              # HTML/CSS/page scripts (build input)
│       └── package.json      # deps: express, ws, katex
└── dist/                     # BUILD OUTPUT, served by Caddy (not in git)
```

> **`dist/` is not committed.** It must be regenerated with `pnpm build` after every
> checkout and after every `git pull`. Caddy serves nothing until it exists.

---

## 7. Install dependencies and build

The repo is a **pnpm workspace**; install from the repository root, not from a
subdirectory. `@lecturedoc2/libcrypto` is fetched from npm.

```bash
cd /srv/quizzy
sudo corepack enable
sudo pnpm install --frozen-lockfile
sudo pnpm build            # writes dist/
```

`esbuild` is a dev dependency and is required for the build, so do **not** install with
`--prod` unless you build elsewhere and copy `dist/` over.

Then hand the whole tree to the service user (default read permissions let the
`caddy` user serve the static files):

```bash
sudo chown -R quizzy:quizzy /srv/quizzy
```

---

## 8. Caddy configuration

### 8a. Install the Caddyfile

```bash
sudo cp /srv/quizzy/Caddyfile /etc/caddy/Caddyfile
```

### 8b. Add the HARICA ACME settings to the global block

The repository Caddyfile does **not** contain the ACME issuer — without this, Caddy
would default to Let's Encrypt, which cannot validate this internal host. Edit the
global options block at the top of `/etc/caddy/Caddyfile` so it reads:

```caddyfile
{
	http_port {$HTTP_PORT:80}
	https_port {$HTTPS_PORT:443}
	email michael.eichberg@dhbw.de
	acme_ca https://certificates.dhbw.cloud/acme/directory
}
```

Leave the rest of the file as-is. The site block uses relative paths
(`import {$TLS_CONFIG:caddy/tls-auto.txt}`, `root * dist`, …); they resolve
against the `WorkingDirectory` set in step 9b. `caddy/tls-auto.txt` is intentionally
empty, which enables automatic HTTPS via the issuer above.

### 8c. Create the environment file

```bash
sudo tee /etc/caddy/quizzy.env >/dev/null <<'EOF'
CADDY_HOST=quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site
BACKEND_HOST=localhost
BACKEND_PORT=3000
EOF
sudo chown root:caddy /etc/caddy/quizzy.env
sudo chmod 640 /etc/caddy/quizzy.env
```

> Do **not** set `TLS_CONFIG` here. Omitting it lets the Caddyfile default to the empty
> `caddy/tls-auto.txt`, i.e. automatic HTTPS. Pointing it at `tls-mkcert.txt` would serve
> a self-signed certificate instead.

---

## 9. systemd units

### 9a. Backend service

```bash
sudo tee /etc/systemd/system/quizzy-backend.service >/dev/null <<'EOF'
[Unit]
Description=Quizzy Node backend
After=network.target

[Service]
Type=simple
WorkingDirectory=/srv/quizzy
ExecStart=/usr/bin/node packages/server/src/server.js
Environment=NODE_ENV=production
Environment=PORT=3000
User=quizzy
Group=quizzy
Restart=on-failure
RestartSec=2
# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
ReadWritePaths=/srv/quizzy

[Install]
WantedBy=multi-user.target
EOF
```

### 9b. Caddy drop-in override

Gives the packaged `caddy.service` the working directory and environment it needs,
without editing the vendor unit:

```bash
sudo mkdir -p /etc/systemd/system/caddy.service.d
sudo tee /etc/systemd/system/caddy.service.d/override.conf >/dev/null <<'EOF'
[Service]
WorkingDirectory=/srv/quizzy
EnvironmentFile=/etc/caddy/quizzy.env
EOF
```

---

## 10. Set the DNS A record

The host has an internal-only IP, and the `users.dhbw.site` zone is managed centrally;
you set your own `A` record via authenticated dynamic update (RFC2136 + TSIG). Only
needed if your subdomain does not already point at this host.

```bash
nsupdate -y "hmac-sha512:<KEY_NAME>:<TSIG_SECRET>" <<EOF
server 141.72.5.244 53
zone michael-eichberg-at-dhbw-de.users.dhbw.site
update delete quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site. IN A
update add    quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site. 60 IN A 141.72.12.141
send
EOF

# Verify
dig @141.72.5.244 -p 53 quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site A +short
```

> **Security:** the TSIG secret grants write access to your DNS zone — treat it like a
> password. Never commit it to the repo or paste it into logs/chat. If it has been
> exposed, ask the platform team to rotate it.

---

## 11. Validate, start, and verify

```bash
# Sanity-check the config before starting
sudo caddy validate --config /etc/caddy/Caddyfile

# Load units and start everything
sudo systemctl daemon-reload
sudo systemctl enable --now quizzy-backend
sudo systemctl restart caddy

# Watch the first certificate issuance (Ctrl-C to exit)
sudo journalctl -u caddy -f
```

On first start Caddy requests the certificate from HARICA via HTTP-01. Success looks
like a `certificate obtained successfully` line; renewals are then automatic.

Verification checklist:

```bash
# 1. All three listeners are up (caddy on 80/443, node on 3000)
sudo ss -ltnp | grep -E ':(80|443|3000)'

# 2. The backend is healthy
systemctl status quizzy-backend --no-pager

# 3. Local request returns a real response (redirect / 200 / 404 — all fine)
curl -I https://quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site/

# 4. The served certificate is from HARICA, not Caddy's local CA
echo | openssl s_client -connect 127.0.0.1:443 \
  -servername quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```

Finally, open `https://<HOST>/` in a browser **while on the DHBW network or VPN**
(the IP is not routable from the public internet).

Day-to-day: after any config change use `sudo systemctl reload caddy` (zero-downtime)
rather than a restart.

---

## 12. Troubleshooting quick reference

| Symptom | Likely cause | Check / fix |
|---|---|---|
| Local `curl https://<HOST>/` → `tlsv1 alert internal error` | `CADDY_HOST` not loaded → site fell back to `localhost`, no matching cert | `sudo journalctl -u caddy -b \| grep CADDY_HOST`; ensure the drop-in `EnvironmentFile` and `/etc/caddy/quizzy.env` exist |
| Caddy log: `finalize … HTTP 500 serverInternal / enrollment failed` | HARICA/RA backend side, **not** your config | Escalate to the platform team with the ACME **order ID**, account ID, and timestamp from the log |
| ACME log: `Connection error` / challenge never validates | HARICA validator cannot reach port 80 | Confirm `ufw` allows 80/443 and the host is reachable on 80 from another DHBW machine |
| `dig … +short` returns nothing (NXDOMAIN) | `A` record not set for this exact name | Re-run step 10; note `quiz` ≠ `quizzy` |
| `quizzy-backend` fails with `status=1`, ~150 ms | Script crashed on startup | `journalctl -u quizzy-backend -n 60`; usually wrong `WorkingDirectory`, missing deps, or `EADDRINUSE` |
| `EADDRINUSE :::3000` | A stray hand-started `node` still holds the port | `sudo ss -ltnp \| grep :3000`; stop the old process / any pm2 daemon |
| `Start request repeated too quickly` | Restart limiter tripped after repeated failures | `sudo systemctl reset-failed quizzy-backend` before restarting |

---

## Notes

- **One supervisor only.** systemd manages both services; do not also run the backend
  under pm2 — two supervisors competing for the same process causes "won't die / keeps
  restarting" behaviour.
- **Secrets** (TSIG key, any future API tokens) belong in root-owned `0640` env files
  referenced from the units, never in the Caddyfile or the git repo.
- **Updating the app:** `cd /srv/quizzy && sudo git pull`, then
  `sudo pnpm install --frozen-lockfile && sudo pnpm build` (always — `dist/` is not in
  git), `sudo chown -R quizzy:quizzy /srv/quizzy`, then
  `sudo systemctl restart quizzy-backend` and `sudo systemctl reload caddy`.
