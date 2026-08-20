# Quizzy — Production Deployment on a Fresh Ubuntu 26.04 Host

End-to-end runbook to deploy the `quizzy` project (https://github.com/Delors/quiz.git)
behind Caddy with HTTPS, using the DHBW HARICA ACME endpoint, the Node backend
running under a dedicated service user, both managed by systemd.

Replace the example values (host name, IP, DNS server, TSIG key) with your own.

---

## 0. Prerequisites

- A host on the **DHBW network** with a fixed **internal address** — IPv4
  (example: `141.72.12.141`), IPv6 (example: `2001:db8:1:2::10`), or both. The
  address is only routable inside the DHBW network, so clients must be on campus
  or on the DHBW VPN to reach the service.
- A subdomain allocated to you, e.g. `quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site`.
- A **TSIG key** (RFC2136) from the platform team to set your DNS record, plus the
  DNS server address (example: `141.72.5.244`). You need an `A` record on IPv4, an
  `AAAA` record on IPv6, or both on a dual-stack host — see step 10.
- `sudo`/root access on the host.
- Ports **80 and 443** reachable on the host from within the DHBW network
  (required for the ACME HTTP-01 challenge and for serving the site), **on every
  address family the host actually uses**.
- On a cloud platform (OpenStack and the like) there are **two** firewalls: the
  provider's security group and the host's own `ufw`. Both must allow 80/443, and
  a rule that exists only for IPv4 leaves an IPv6-only host unreachable. Step 2
  covers both.

> **Working on IPv6?** The application itself needs no changes — the backend binds
> dual-stack by default and Caddy follows DNS. What does need attention is the
> surrounding infrastructure: the `AAAA` record, both firewalls, and ICMPv6. Every
> IPv6-specific step below is marked **IPv6**.

> Throughout this document the placeholder `<HOST>` means, e.g., 
> `quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site`.

---

## 1. System preparation

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl ufw
```

---

## 2. Firewalls (do this before enabling anything!)

### 2a. Provider security group (cloud hosts only)

If the host runs on OpenStack or a similar platform, its security group is a second
firewall in front of `ufw`, and it is **per address family**: the built-in `SSH`,
`HTTP` and `HTTPS` presets in the web UI create IPv4-only rules. On an IPv6-only
host those presets leave the machine completely unreachable, SSH included.

**IPv6** — add ingress rules for TCP 22, 80 and 443 with remote `::/0`, plus one
for ICMPv6:

```bash
SG=<your-security-group>
openstack security group rule create --ingress --ethertype IPv6 --protocol tcp --dst-port 22  --remote-ip ::/0 $SG
openstack security group rule create --ingress --ethertype IPv6 --protocol tcp --dst-port 80  --remote-ip ::/0 $SG
openstack security group rule create --ingress --ethertype IPv6 --protocol tcp --dst-port 443 --remote-ip ::/0 $SG
openstack security group rule create --ingress --ethertype IPv6 --protocol ipv6-icmp --remote-ip ::/0 $SG
```

The ICMPv6 rule is **not** optional the way IPv4 ICMP is. IPv6 routers never
fragment, so endpoints discover the path MTU from ICMPv6 type 2 ("Packet Too Big").
Block it and connections still establish — then hang once packets grow, which here
means the 1 MB quiz upload and TLS handshakes with a full certificate chain. It
looks like a working deployment until a real lecture hits it.

Restrict SSH to the campus prefix rather than `::/0` if you can.

### 2b. Host firewall (`ufw`)

Enabling `ufw` without allowing SSH first will lock you out of the host.

```bash
sudo ufw allow OpenSSH          # keep your SSH session alive
sudo ufw allow 80,443/tcp       # HTTP (ACME challenge + redirect) and HTTPS
sudo ufw enable
sudo ufw status verbose
```

**IPv6** — `ufw` writes both families from those same commands, but only when IPv6
support is switched on, which is the default and worth confirming rather than
assuming:

```bash
grep '^IPV6=' /etc/default/ufw        # expect IPV6=yes
sudo ufw status verbose | grep '(v6)' # expect (v6) entries for 22/80/443
```

If it read `IPV6=no`, set it to `yes` and run `sudo ufw disable && sudo ufw enable`
to rebuild the rules.

Unlike a cloud security group, `ufw` already permits the essential ICMPv6 types in
`/etc/ufw/before6.rules`, so PMTUD works without extra configuration here — the
ICMPv6 rule in 2a is needed because the provider's firewall has no such default.

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

# Step 7 hands the tree to the `quizzy` service user, but you keep operating on it
# as root via sudo. Git refuses to touch a repository owned by someone else
# ("detected dubious ownership"), so record the exception once, for root:
sudo git config --global --add safe.directory /srv/quizzy
```

> Without that last line, every later `sudo git pull` fails with
> `fatal: detected dubious ownership in repository at '/srv/quizzy'`.
>
> **The `sudo` is not optional, on either command.** Run `git config` without it and
> the exception goes into `/home/<you>/.gitconfig`, which fixes the ownership
> complaint for the wrong account; the next unprivileged `git pull` then fails one
> step later with `error: cannot open '.git/FETCH_HEAD': Permission denied`, because
> your login user can read the `quizzy`-owned tree but not write to it. Configure it
> for root, and pull as root:
>
> ```bash
> sudo git config --global --get-all safe.directory   # expect /srv/quizzy
> sudo git pull
> ```

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

**About dependency build scripts.** pnpm 10+ refuses to run the lifecycle scripts of
dependencies unless each one has an explicit decision recorded, and an *undecided*
package makes `pnpm install` exit **1**. That matters more than it sounds: `pnpm
build` runs a dependency-status check before your script, so a stray
`ERR_PNPM_IGNORED_BUILDS` aborts the build with a `runDepsStatusCheck` stack trace
rather than a useful message.

The decision is committed in `pnpm-workspace.yaml`, so a clean checkout needs no
interaction:

```yaml
allowBuilds:
  esbuild: true
```

If pnpm has written a placeholder (`esbuild: set this to true or false`) into that
file on this host, discard the local edit and take the committed version:
`sudo git checkout pnpm-workspace.yaml`.

`playwright` also appears in the tree — it is a dev dependency of the browser test
suite, and this step cannot use `--prod` because the build needs `esbuild`. It is
deliberately **not** listed in `allowBuilds`, so its postinstall never runs and **no
browser binaries are downloaded**; the install stays around 40 MB.

If `--frozen-lockfile` fails with `ERR_PNPM_OUTDATED_LOCKFILE`, the checkout has a
`pnpm-lock.yaml` older than its `package.json` — someone changed a dependency
without regenerating the lockfile. Fix it **at the source** (`pnpm install` locally,
then commit `pnpm-lock.yaml`) rather than reaching for `--no-frozen-lockfile` here:
the whole point of the frozen install is that the host gets the exact tree that was
tested.

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

> **IPv6:** leave `BACKEND_HOST=localhost` — it resolves to whichever families the
> host has, so it is correct on IPv4, IPv6 and dual-stack alike. If you ever replace
> it with a literal address, an IPv6 one must be **bracketed** (`BACKEND_HOST=[::1]`):
> the Caddyfile appends `:port`, so an unbracketed `::1` becomes the invalid
> `::1:3000`.

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

## 10. Set the DNS record (`A` and/or `AAAA`)

The host has an internal-only address, and the `users.dhbw.site` zone is managed
centrally; you set your own record via authenticated dynamic update (RFC2136 +
TSIG). Only needed if your subdomain does not already point at this host.

Set the record type that matches the host: `A` for IPv4, **`AAAA` for IPv6**, both
on a dual-stack host. Getting this wrong is the most common IPv6 deployment
failure — without an `AAAA` record the name simply does not resolve for clients,
and the ACME validator cannot reach the host either, so certificate issuance fails
with a connection error rather than anything that names DNS.

```bash
# IPv4 host
nsupdate -y "hmac-sha512:<KEY_NAME>:<TSIG_SECRET>" <<EOF
server 141.72.5.244 53
zone michael-eichberg-at-dhbw-de.users.dhbw.site
update delete quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site. IN A
update add    quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site. 60 IN A 141.72.12.141
send
EOF

# IPv6 host (use the host's real global address, not a link-local fe80:: one)
nsupdate -y "hmac-sha512:<KEY_NAME>:<TSIG_SECRET>" <<EOF
server 141.72.5.244 53
zone michael-eichberg-at-dhbw-de.users.dhbw.site
update delete quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site. IN AAAA
update add    quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site. 60 IN AAAA 2001:db8:1:2::10
send
EOF

# Verify whichever you set (both on a dual-stack host)
dig @141.72.5.244 -p 53 quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site A    +short
dig @141.72.5.244 -p 53 quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site AAAA +short
```

> The address to publish is the host's **global** IPv6 address — `ip -6 addr show
> scope global`. A link-local `fe80::` address is not reachable off-link and must
> never go into DNS.

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
#    (on an IPv6-only host use [::1]:443 -- 127.0.0.1 does not exist there)
echo | openssl s_client -connect 127.0.0.1:443 \
  -servername quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site 2>/dev/null \
  | openssl x509 -noout -issuer -dates
```

**IPv6** — two extra checks worth doing before you trust the deployment:

```bash
# 5. The site answers over IPv6 specifically (-6 forces the family, -g allows
#    a bracketed literal). Also confirm the loopback path on an IPv6-only host.
curl -6 -I https://quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site/
curl -g -I https://[::1]:443/ --resolve '*:443:[::1]' -k

# 6. PMTUD is not being silently blackholed: a large response must complete,
#    not stall. A hang here points at a missing ICMPv6 rule in step 2a.
curl -6 -o /dev/null -w 'transferred %{size_download} bytes in %{time_total}s\n' \
  https://quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site/client/quiz-control.js
```

Also run the test suite on the host once (`pnpm --filter ld-quiz-server test`); it
binds to whichever loopback family the host provides, so a failure there means the
host's networking is not what you think it is.

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
| ACME log: `Connection error` / challenge never validates | HARICA validator cannot reach port 80 | Confirm **both** firewalls allow 80/443 for the host's address family (steps 2a and 2b) and that the host is reachable on 80 from another DHBW machine |
| `dig … +short` returns nothing (NXDOMAIN) | `A`/`AAAA` record not set for this exact name | Re-run step 10; note `quiz` ≠ `quizzy` |
| **IPv6:** site unreachable, SSH included, right after provisioning | Security-group rules are IPv4-only — the UI's `SSH`/`HTTP`/`HTTPS` presets do not create IPv6 rules | Add the `::/0` rules from step 2a |
| **IPv6:** page loads but large transfers hang (quiz upload, TLS handshake) | ICMPv6 "Packet Too Big" blocked, so PMTUD fails | Add the `ipv6-icmp` rule from step 2a; verify with check 6 in step 11 |
| **IPv6:** browser cannot resolve `<HOST>`, ACME reports a connection error | `AAAA` record missing (an `A` record alone is useless on an IPv6-only host) | `dig … AAAA +short`; re-run step 10 |
| **IPv6:** `ufw status` shows no `(v6)` rules | `IPV6=no` in `/etc/default/ufw` | Set `IPV6=yes`, then `sudo ufw disable && sudo ufw enable` |
| **IPv6:** something fails to bind with `EADDRNOTAVAIL` on `127.0.0.1` | A tool or script hardcodes the IPv4 loopback, which does not exist on an IPv6-only host | Use `[::1]`, or a name that resolves to whichever family is present |
| `quizzy-backend` fails with `status=1`, ~150 ms | Script crashed on startup | `journalctl -u quizzy-backend -n 60`; usually wrong `WorkingDirectory`, missing deps, or `EADDRINUSE` |
| `EADDRINUSE :::3000` | A stray hand-started `node` still holds the port | `sudo ss -ltnp \| grep :3000`; stop the old process / any pm2 daemon |
| `Start request repeated too quickly` | Restart limiter tripped after repeated failures | `sudo systemctl reset-failed quizzy-backend` before restarting |
| `git pull` → `detected dubious ownership in repository` | The tree is owned by `quizzy`, but you are pulling as root | `sudo git config --global --add safe.directory /srv/quizzy` (step 6) |
| `git pull` → `cannot open '.git/FETCH_HEAD': Permission denied` | `safe.directory` was set for your login user instead of root, so the pull is running unprivileged against a `quizzy`-owned tree | Re-run both with `sudo`: `sudo git config --global --add safe.directory /srv/quizzy`, then `sudo git pull` |
| Backend fails to start right after an update | `sudo git pull` / `sudo pnpm build` left root-owned files behind | `sudo chown -R quizzy:quizzy /srv/quizzy` |
| `pnpm install` → `ERR_PNPM_OUTDATED_LOCKFILE` | `pnpm-lock.yaml` in the checkout predates a `package.json` change | Regenerate and commit the lockfile on the development machine, push, pull here. Do not paper over it with `--no-frozen-lockfile` |
| `pnpm build` → `ERR_PNPM_IGNORED_BUILDS: esbuild`, then a `runDepsStatusCheck` stack trace | pnpm 10+ exits 1 for any dependency whose build script has no recorded decision, and `pnpm build` checks dependency status before running | `pnpm-workspace.yaml` must contain `allowBuilds:` / `  esbuild: true` (it is committed). If pnpm wrote a `set this to true or false` placeholder here, `sudo git checkout pnpm-workspace.yaml` |

---

## Notes

- **One supervisor only.** systemd manages both services; do not also run the backend
  under pm2 — two supervisors competing for the same process causes "won't die / keeps
  restarting" behaviour.
- **Secrets** (TSIG key, any future API tokens) belong in root-owned `0640` env files
  referenced from the units, never in the Caddyfile or the git repo.
- **Updating the app:** `cd /srv/quizzy && sudo git pull` (needs the
  `safe.directory` exception from step 6), then
  `sudo pnpm install --frozen-lockfile && sudo pnpm build` (always — `dist/` is not in
  git), `sudo chown -R quizzy:quizzy /srv/quizzy`, then
  `sudo systemctl restart quizzy-backend` and `sudo systemctl reload caddy`.
