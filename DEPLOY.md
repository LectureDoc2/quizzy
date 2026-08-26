# Quizzy — Production Deployment on a Fresh Ubuntu 26.04 Host

End-to-end runbook to deploy the `quizzy` project (https://github.com/LectureDoc2/quizzy.git)
behind Caddy with HTTPS, using the DHBW HARICA ACME endpoint, with the Node backend
running under a dedicated service user, both managed by systemd.

Replace the example values (host name, address, DNS server, TSIG key) with your own.
Throughout, `<HOST>` means your fully-qualified name, e.g.
`quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site`.

**Read section 1 before running anything.** It fixes three choices that the rest of
the document depends on. Everything after it is linear: each file is written by
exactly one step, and Caddy is installed, configured and started once.

---

## 0. Prerequisites

- A host on the **DHBW network** with a fixed **internal address** — IPv4
  (example: `141.72.12.141`), IPv6 (example: `2001:7c0:1b20:c913:1::2aa`), or both.
  The address is routable only inside the DHBW network, so clients must be on
  campus or on the DHBW VPN.
- A subdomain allocated to you, e.g. `quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site`.
- A **TSIG key** (RFC2136) from the platform team, plus the DNS server address
  (example: `ns.cloud-ns.dhbw-mannheim.de:53`). You need it in section 4, and again
  in section 10 if your profile uses DNS-01.
- `sudo`/root access on the host.
- Ports **80 and 443** reachable from within the DHBW network, **on every address
  family the host actually uses**.
- On a cloud platform (OpenStack and the like) there are **two** firewalls — the
  provider's security group and the host's own `ufw`. Section 3 covers both.

---

## 1. Choose your deployment profile

Three properties of the host determine everything that varies below. Decide them
now; each later step states which profile it applies to.

```bash
ip -brief address                 # which families does this host actually have?
```

### 1.1 Address families

| the host has | firewall rules (§3) | DNS record (§4) |
|---|---|---|
| IPv4 only | IPv4 rules | `A` |
| IPv6 only | **IPv6 rules, including ICMPv6** | `AAAA` |
| dual-stack | both | both |

### 1.2 Certificate method

This is the choice that matters most, and it is **not** simply "IPv4 vs IPv6". The
question is whether the CA can open a connection *to* your host:

- **HTTP-01** (the default) — the CA connects to port 80 to fetch a challenge file.
  Works whenever the CA can reach you.
- **DNS-01** — Caddy publishes a TXT record and the CA only reads DNS. Needs no
  inbound reachability at all.

At the time of writing, `certificates.dhbw.cloud` has **no IPv6 connectivity**, so:

| host | certificate method | Caddy install (§6) |
|---|---|---|
| has a reachable IPv4 address | **HTTP-01** | 6a — apt package |
| IPv6 only | **DNS-01** | 6b — built with the RFC2136 module |

If issuance later fails with *both* `http-01` "Connection error" **and**
`tls-alpn-01` "Unable to retrieve server certificate", that is this condition
appearing at runtime — see the troubleshooting table.

### 1.3 Record your choices

Everything below refers back to these:

```text
PROFILE_FAMILIES = ipv4 | ipv6 | dual
PROFILE_CERT     = http-01 | dns-01
HOST             = quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site
HOST_ADDRESS     = <the global address from `ip -brief address`>
```

---

## 2. System preparation

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y git curl ufw dnsutils
```

---

## 3. Firewalls

Do this **before** enabling anything. A rule that exists only for IPv4 leaves an
IPv6-only host unreachable, SSH included.

### 3a. Provider security group (cloud hosts only)

The built-in `SSH`, `HTTP` and `HTTPS` presets in the OpenStack web UI create
**IPv4-only** rules. For an IPv6 or dual-stack profile you must add IPv6 rules
explicitly — the presets will not do it:

```bash
SG=<your-security-group>
openstack security group rule create --ingress --ethertype IPv6 --protocol tcp --dst-port 22  --remote-ip ::/0 $SG
openstack security group rule create --ingress --ethertype IPv6 --protocol tcp --dst-port 80  --remote-ip ::/0 $SG
openstack security group rule create --ingress --ethertype IPv6 --protocol tcp --dst-port 443 --remote-ip ::/0 $SG
openstack security group rule create --ingress --ethertype IPv6 --protocol ipv6-icmp --remote-ip ::/0 $SG
```

The **ICMPv6 rule is not optional** the way IPv4 ICMP is. IPv6 routers never
fragment, so endpoints discover the path MTU from ICMPv6 type 2 ("Packet Too Big").
Block it and connections still establish — then hang once packets grow, which here
means the 1 MB quiz upload and TLS handshakes with a full certificate chain. It
looks like a working deployment until a real lecture hits it.

Restrict SSH to the campus prefix rather than `::/0` if you can.

### 3b. Host firewall (`ufw`)

Enabling `ufw` without allowing SSH first will lock you out.

```bash
sudo ufw allow OpenSSH          # keep your SSH session alive
sudo ufw allow 80,443/tcp       # HTTP (ACME challenge + redirect) and HTTPS
sudo ufw enable
sudo ufw status verbose
```

`ufw` writes rules for both families from those same commands, but only when IPv6
support is on. It is the default; confirm rather than assume:

```bash
grep '^IPV6=' /etc/default/ufw          # expect IPV6=yes
sudo ufw status verbose | grep '(v6)'   # expect (v6) entries for 22/80/443
```

If it read `IPV6=no`, set it to `yes` and run `sudo ufw disable && sudo ufw enable`
to rebuild the rules.

Unlike a cloud security group, `ufw` already permits the essential ICMPv6 types in
`/etc/ufw/before6.rules`, so PMTUD works here without extra configuration — the rule
in 3a is needed because the provider's firewall has no such default.

---

## 4. Set the DNS record

**Before** anything tries to obtain a certificate. Without the right record the name
does not resolve for clients, and with HTTP-01 the CA cannot reach the host either —
issuance then fails with a connection error that never mentions DNS.

The `users.dhbw.site` zone is managed centrally; you set your own record by
authenticated dynamic update (RFC2136 + TSIG). Set the type that matches your
profile — `A` for IPv4, `AAAA` for IPv6, both for dual-stack.

```bash
# IPv4 profile
nsupdate -y "hmac-sha512:<KEY_NAME>:<TSIG_SECRET>" <<EOF
server ns.cloud-ns.dhbw-mannheim.de 53
zone michael-eichberg-at-dhbw-de.users.dhbw.site
update delete <HOST>. IN A
update add    <HOST>. 300 IN A 141.72.12.141
send
EOF

# IPv6 profile (the host's GLOBAL address, never a link-local fe80:: one)
nsupdate -y "hmac-sha512:<KEY_NAME>:<TSIG_SECRET>" <<EOF
server ns.cloud-ns.dhbw-mannheim.de 53
zone michael-eichberg-at-dhbw-de.users.dhbw.site
update delete <HOST>. IN AAAA
update add    <HOST>. 300 IN AAAA 2001:7c0:1b20:c913:1::2aa
send
EOF

# Verify whichever you set, from the authoritative server and from public DNS
dig @ns.cloud-ns.dhbw-mannheim.de <HOST> A    +short
dig @ns.cloud-ns.dhbw-mannheim.de <HOST> AAAA +short
dig <HOST> AAAA +short
```

> `ip -6 addr show scope global` gives the address to publish. A link-local
> `fe80::` address is not reachable off-link and must never go into DNS.

> **Security:** the TSIG secret grants write access to your DNS zone — treat it like
> a password. Never commit it or paste it into logs or chat. If it has been exposed,
> ask the platform team to rotate it.

---

## 5. Install Node.js (current LTS, system-wide)

Node.js **24** is the Active LTS line as of mid-2026 (Node 22 is in maintenance,
Node 26 is still "Current").

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version          # expect v24.x
command -v node         # expect /usr/bin/node  (matches the systemd unit in §11)
```

> If NodeSource has no repository for Ubuntu 26.04 yet, fall back to the
> distribution package: `sudo apt install -y nodejs npm`.

A system-wide install puts `node` in `/usr/bin`, executable by every user —
including the login-less service user created in section 7. Do **not** use `nvm`: it
installs per-user under `~/.nvm` and cannot be used by a `nologin` account.

---

## 6. Install Caddy

Take **6a or 6b**, according to `PROFILE_CERT` from section 1.2. This is the only
place Caddy is installed; section 11 writes the matching systemd override.

### 6a. HTTP-01 profile — apt package

```bash
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy
```

The package creates the **`caddy` system user** and an enabled `caddy.service`,
which section 11 points at our configuration. Caddy keeps receiving security updates
through `apt`.

### 6b. DNS-01 profile — built with the RFC2136 module

DNS-01 needs a DNS provider module, and the packaged binary contains none. Build one
that does. It is a strict superset: it still performs HTTP-01 exactly as the package
would, so nothing else in this document changes.

Install the package first anyway — it creates the `caddy` user, the service unit and
`/etc/caddy`, all of which are still used:

```bash
# 1. the package, for the user + unit + /etc/caddy (its binary is then superseded)
sudo apt install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt update
sudo apt install -y caddy

# 2. the custom binary
sudo apt install -y golang-go
go install github.com/caddyserver/xcaddy/cmd/xcaddy@latest

# Build in an empty directory of your own -- NOT in /srv/quizzy. xcaddy writes its
# binary as ./caddy, and /srv/quizzy/caddy already exists as the TLS snippets
# *directory*, so building there fails with "open /srv/quizzy/caddy/caddy:
# permission denied" and the install then reports "omitting directory 'caddy'".
mkdir -p ~/caddy-build && cd ~/caddy-build
~/go/bin/xcaddy build --with github.com/caddy-dns/rfc2136

sudo install -o root -g root -m 0755 ./caddy /usr/local/bin/caddy
/usr/local/bin/caddy list-modules | grep rfc2136   # expect dns.providers.rfc2136
```

It is installed to `/usr/local/bin/caddy`, **not** over `/usr/bin/caddy`, so that an
`apt upgrade` of the `caddy` package cannot silently replace it with a binary
lacking the module — which would leave renewals failing months later.

> **Maintenance:** this binary is not updated by `apt`. Rebuild it when a Caddy
> release matters to you, with the same two commands.

---

## 7. Create the backend service user

A system account with no home directory and no login shell:

```bash
sudo useradd --system --no-create-home --shell /usr/sbin/nologin quizzy
getent passwd quizzy     # verify: low UID, shell /usr/sbin/nologin
```

---

## 8. Deploy the application code

```bash
sudo git clone https://github.com/LectureDoc2/quizzy.git /srv/quizzy

# Section 9 hands the tree to the `quizzy` service user while you keep operating on
# it as root. Git refuses to touch a repository owned by someone else ("detected
# dubious ownership"), so record the exception once, for root:
sudo git config --global --add safe.directory /srv/quizzy
```

> **The `sudo` is not optional, on either command.** Run `git config` without it and
> the exception lands in `/home/<you>/.gitconfig` — fixing the ownership complaint
> for the wrong account. The next unprivileged `git pull` then fails one step later
> with `error: cannot open '.git/FETCH_HEAD': Permission denied`, because your login
> user can read the `quizzy`-owned tree but not write to it. Verify with
> `sudo git config --global --get-all safe.directory`.

Directory layout after checkout:

```text
/srv/quizzy/
├── Caddyfile                 # template (installed to /etc/caddy in §10)
├── caddy/
│   ├── tls-auto.txt          # empty  -> automatic HTTPS via HTTP-01
│   ├── tls-dns01.txt         # DNS-01 via RFC2136
│   └── tls-mkcert.txt        # local development only
├── package.json              # workspace root: build scripts
├── pnpm-workspace.yaml
├── build.js                  # esbuild -> dist/
├── packages/
│   ├── ld-quiz/              # embeddable <ld-quiz> web component (browser)
│   └── server/               # Node backend
│       ├── src/server.js     # entry point (listens on PORT || 3000)
│       ├── web/              # HTML/CSS/page scripts (build input)
│       └── package.json      # deps: express, ws, katex, highlight.js
└── dist/                     # BUILD OUTPUT, served by Caddy (not in git)
```

> **`dist/` is not committed.** Regenerate it with `pnpm build` after every checkout
> and every `git pull`. Caddy serves nothing until it exists.

---

## 9. Install dependencies and build

The repo is a **pnpm workspace**; install from the repository root.

```bash
cd /srv/quizzy
sudo corepack enable
sudo pnpm install --frozen-lockfile
sudo pnpm build            # writes dist/
sudo chown -R quizzy:quizzy /srv/quizzy
```

The final `chown` matters: `sudo pnpm build` leaves root-owned files behind, and the
backend runs as `quizzy`. Repeat it after every update.

`esbuild` is a dev dependency and is required for the build, so do **not** install
with `--prod` unless you build elsewhere and copy `dist/` over.

**About dependency build scripts.** pnpm 10+ refuses to run dependency lifecycle
scripts unless each has an explicit decision recorded, and an *undecided* package
makes `pnpm install` exit **1**. That matters more than it sounds: `pnpm build` runs
a dependency-status check first, so a stray `ERR_PNPM_IGNORED_BUILDS` aborts the
build with a `runDepsStatusCheck` stack trace rather than a useful message.

The decision is committed in `pnpm-workspace.yaml`, so a clean checkout needs no
interaction:

```yaml
allowBuilds:
  esbuild: true
```

If pnpm has written a placeholder (`esbuild: set this to true or false`) on this
host, discard the local edit: `sudo git checkout pnpm-workspace.yaml`.

`playwright` also appears in the tree — it is a dev dependency of the browser test
suite. It is deliberately **not** in `allowBuilds`, so its postinstall never runs and
**no browser binaries are downloaded**; the install stays around 40 MB.

---

## 10. Caddy configuration

### 10a. Install the Caddyfile and its snippets

```bash
sudo cp /srv/quizzy/Caddyfile /etc/caddy/Caddyfile
sudo cp -r /srv/quizzy/caddy /etc/caddy/
```

Both lines are required. The Caddyfile imports a TLS snippet from `caddy/`, and that
path is resolved **relative to the Caddyfile itself**, so the snippets must sit next
to the installed copy at `/etc/caddy/caddy/`.

### 10b. Add the ACME issuer

The repository Caddyfile does **not** contain the issuer — without it Caddy defaults
to Let's Encrypt, which cannot validate this internal host. Edit the global options
block at the top of `/etc/caddy/Caddyfile`:

```caddyfile
{
	http_port {$HTTP_PORT:80}
	https_port {$HTTPS_PORT:443}
	email michael.eichberg@dhbw.de
	acme_ca https://certificates.dhbw.cloud/acme/directory
}
```

Leave the rest as-is. It contains two kinds of relative path, resolved differently:

- **`import {$TLS_CONFIG:caddy/tls-auto.txt}`** is resolved when the config is
  *adapted*, relative to the Caddyfile containing the import — hence
  `/etc/caddy/caddy/…`, and hence the second `cp` in 10a. Running `caddy validate`
  from `/srv/quizzy` does **not** change this.
- **`root * dist`** and other runtime paths resolve against the process working
  directory, i.e. the `WorkingDirectory` set in section 11.

### 10c. Create the environment file

```bash
sudo tee /etc/caddy/quizzy.env >/dev/null <<'EOF'
CADDY_HOST=quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site
BACKEND_HOST=localhost
BACKEND_PORT=3000
EOF
sudo chown root:caddy /etc/caddy/quizzy.env
sudo chmod 640 /etc/caddy/quizzy.env
```

`TLS_CONFIG` selects the snippet, and therefore how certificates are obtained:

| value | meaning |
|---|---|
| *(unset)* | `caddy/tls-auto.txt` — empty, i.e. HTTP-01 / TLS-ALPN-01 |
| `caddy/tls-dns01.txt` | DNS-01 via RFC2136 |
| `caddy/tls-mkcert.txt` | a local self-signed certificate, development only |

> Leave `BACKEND_HOST=localhost` — it resolves to whichever families the host has,
> so it is correct on IPv4, IPv6 and dual-stack alike. A literal IPv6 address would
> have to be **bracketed** (`BACKEND_HOST=[::1]`): the Caddyfile appends `:port`, so
> an unbracketed `::1` becomes the invalid `::1:3000`.

#### Optional: bind the backend to loopback only

By default the backend listens on every interface, and the firewall from section 5
is what keeps port 3000 private. If you would rather it were not reachable at all
from outside the machine, set `HOST` on the backend service — but it must name the
**same family Caddy will connect over**, or Caddy gets "connection refused":

| Profile | `BACKEND_HOST` (Caddy) | `HOST` (backend) |
|---|---|---|
| IPv4 only | `localhost` | `127.0.0.1` |
| IPv6 only | `localhost` | `::1` |
| dual-stack | `localhost` | *leave unset* — one `listen()` call binds one family, so pinning either one can strand Caddy on the other |

Note the asymmetry, which is easy to get backwards: `HOST` takes a **bare** `::1`
because Node's `listen()` wants an address, while `BACKEND_HOST` needs
**`[::1]`** because the Caddyfile appends `:port` to it.

### 10d. DNS-01 credentials — `PROFILE_CERT = dns-01` only

Append the TSIG credentials. They grant dynamic-update rights over your zone, so
they belong only in this file (`root:caddy`, mode `640`) and never in the repository:

```bash
sudo tee -a /etc/caddy/quizzy.env >/dev/null <<'EOF'
TLS_CONFIG=caddy/tls-dns01.txt
TSIG_KEY_NAME=user-key-...
TSIG_SECRET=...
TSIG_ALGORITHM=hmac-sha512
TSIG_NAMESERVER=ns.cloud-ns.dhbw-mannheim.de:53
EOF
```

> If Caddy rejects `key_alg`, use the lower-case form (`hmac-sha512`) — the platform
> documents it as `HMAC-SHA512`, but the module expects lower case. If it cannot
> reach the nameserver, drop the trailing dot or use the server's IP address.

> **Alternative: certbot.** The platform documents `certbot-dns-rfc2136`, which
> avoids building Caddy and can issue wildcards. The cost is that Caddy stops
> managing its own certificates: point the site block at the issued files with `tls
> /etc/letsencrypt/live/<HOST>/fullchain.pem /etc/letsencrypt/live/<HOST>/privkey.pem`,
> give the `caddy` user read access, and add a renewal deploy-hook running
> `systemctl reload caddy`. Prefer the Caddy module unless you need wildcards.

---

## 11. systemd units

### 11a. Backend service

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

### 11b. Caddy drop-in override

Gives the packaged `caddy.service` the working directory and environment it needs,
without editing the vendor unit. **Write this file once**, using the variant that
matches your profile.

`PROFILE_CERT = http-01` (apt binary from 6a):

```bash
sudo mkdir -p /etc/systemd/system/caddy.service.d
sudo tee /etc/systemd/system/caddy.service.d/override.conf >/dev/null <<'EOF'
[Service]
WorkingDirectory=/srv/quizzy
EnvironmentFile=/etc/caddy/quizzy.env
EOF
```

`PROFILE_CERT = dns-01` (custom binary from 6b) — the same file, plus the lines that
redirect the unit to `/usr/local/bin/caddy`:

```bash
sudo mkdir -p /etc/systemd/system/caddy.service.d
sudo tee /etc/systemd/system/caddy.service.d/override.conf >/dev/null <<'EOF'
[Service]
WorkingDirectory=/srv/quizzy
EnvironmentFile=/etc/caddy/quizzy.env
ExecStart=
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
EOF
```

The empty `ExecStart=` is **required**: without it systemd appends to the vendor
unit's value instead of replacing it, and the service fails to start.

---

## 12. Start and verify

The only place that starts Caddy. Nothing before this should have restarted it.

```bash
# Validate the config. On the dns-01 profile use the explicit path, so that a
# missing rfc2136 module is caught here rather than at runtime.
sudo caddy validate --config /etc/caddy/Caddyfile                    # http-01 profile
sudo /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile     # dns-01 profile

sudo systemctl daemon-reload
sudo systemctl enable --now quizzy-backend
sudo systemctl restart caddy

# Watch the first certificate issuance (Ctrl-C to exit)
sudo journalctl -u caddy -f
```

Expect `trying to solve challenge` with your profile's `challenge_type`, then
`certificate obtained successfully`. DNS-01 is slower than HTTP-01 because Caddy
waits for the TXT record to propagate. Renewals are automatic thereafter.

### Verification checklist

```bash
# 1. Both services are up
systemctl status caddy quizzy-backend --no-pager

# 2. A certificate actually exists
sudo ls -R /var/lib/caddy/.local/share/caddy/certificates/

# 3. The site answers
curl -I https://<HOST>/

# 4. The served certificate is the real one, not Caddy's internal CA.
#    -servername is mandatory: Caddy selects the certificate by SNI, and a
#    connection without SNI is refused with "tlsv1 alert internal error".
echo | openssl s_client -connect '<HOST>:443' -servername '<HOST>' 2>/dev/null \
  | openssl x509 -noout -issuer -subject -dates

# 5. A large response completes rather than stalling. A hang here means PMTUD is
#    blackholed -- check the ICMPv6 rule in 3a.
curl -o /dev/null -w 'transferred %{size_download} bytes in %{time_total}s\n' \
  https://<HOST>/js/quiz-control.js
```

On an IPv6 or dual-stack profile, add `-6` to the curl commands to force the family,
and check the loopback path too. Note this asks for the **hostname** and only pins
the address — requesting `https://[::1]/` directly cannot work, because curl sends
no SNI for an IP literal (RFC 6066) and Caddy then has no certificate to select:

```bash
curl -6 -I https://<HOST>/
curl -g -I --resolve '<HOST>:443:[::1]' https://<HOST>/
```

Finally, open `https://<HOST>/` in a browser **on the DHBW network or VPN**.

Running the test suite once on the host is a good smoke test of its networking:

```bash
cd /srv/quizzy && pnpm --filter ld-quiz-server test
```

It binds to whichever loopback family the host provides, so a failure there means
the host's networking is not what you think it is.

---

## 13. Updating the application

```bash
cd /srv/quizzy
sudo git pull
sudo pnpm install --frozen-lockfile
sudo pnpm build
sudo chown -R quizzy:quizzy /srv/quizzy
sudo systemctl restart quizzy-backend
```

Caddy only needs restarting if you changed the `Caddyfile` or a TLS snippet, in
which case repeat 10a first and then `sudo systemctl reload caddy`.

---

## 14. Troubleshooting quick reference

| symptom | cause | fix |
|---|---|---|
| `git pull` → `detected dubious ownership in repository` | The tree is owned by `quizzy`, but you are pulling as root | `sudo git config --global --add safe.directory /srv/quizzy` (§8) |
| `git pull` → `cannot open '.git/FETCH_HEAD': Permission denied` | `safe.directory` was set for your login user, so the pull runs unprivileged against a `quizzy`-owned tree | Re-run **both** commands with `sudo` |
| Backend fails to start right after an update | `sudo git pull` / `sudo pnpm build` left root-owned files | `sudo chown -R quizzy:quizzy /srv/quizzy` |
| `pnpm build` → `ERR_PNPM_IGNORED_BUILDS: esbuild`, then a `runDepsStatusCheck` stack trace | pnpm exits 1 for any dependency whose build script has no recorded decision, and `pnpm build` checks dependency status first | `pnpm-workspace.yaml` must contain `allowBuilds:` / `  esbuild: true` (committed). If pnpm wrote a placeholder here, `sudo git checkout pnpm-workspace.yaml` |
| `ERR_PNPM_OUTDATED_LOCKFILE` | The checkout's `pnpm-lock.yaml` is older than its `package.json` | Fix at the source: `pnpm install` locally, commit the lockfile. Do not reach for `--no-frozen-lockfile` — the frozen install is what guarantees the host gets the tested tree |
| `caddy validate` → `File to import not found: caddy/tls-auto.txt` | Only the Caddyfile was copied to `/etc/caddy`, not the snippets beside it | Run both `cp` lines from 10a |
| Caddy fails to start after editing the drop-in | `ExecStart=` was overridden without the empty reset line, so systemd has two `ExecStart` values | Keep the bare `ExecStart=` before the real one (§11b) |
| `caddy validate` → unknown module `dns.providers.rfc2136` | Validating with the packaged binary rather than the custom build | Use `/usr/local/bin/caddy validate …` (§12) |
| ACME `http-01` "Connection error" **and** `tls-alpn-01` "Unable to retrieve server certificate" | The CA validates by connecting *to* this host and has no IPv6 | Switch to the DNS-01 profile (§1.2, 6b, 10d). Confirm first with `curl -6 http://<HOST>/` from elsewhere — a `308` means your firewall is fine and the CA is the problem |
| `xcaddy build` → `open /srv/quizzy/caddy/caddy: permission denied`, then `install: omitting directory 'caddy'` | Built inside `/srv/quizzy`, where `caddy/` is already the snippets directory (and which is root-owned) | Build in an empty directory (§6b) |
| `curl`/`openssl` to `[::1]` → `tlsv1 alert internal error` | No SNI is sent for an IP literal, so Caddy cannot select a certificate. Not a certificate fault | Ask for the hostname and pin the address: `curl -g --resolve '<HOST>:443:[::1]' https://<HOST>/`, or `openssl s_client -servername <HOST>` |
| Connections establish, then hang on larger transfers | ICMPv6 "Packet Too Big" is blocked, so PMTUD fails | Add the `ipv6-icmp` ingress rule (§3a) |
| The name does not resolve for clients | Missing or wrong-type DNS record | §4 — `A` for IPv4, `AAAA` for IPv6 |

---

## Notes

- **The presenter token is derived from the quiz file.** Anyone who can reconstruct
  the quiz JSON can compute it, so an encrypted quiz should carry a high-entropy
  `secret` field. See the README.
- **Room state is in memory only.** Restarting the backend ends every running
  session; there is no persistence and none is intended.
- **`ENDED_ROOM_RETENTION_MINUTES`** (default 15) controls how long a finished room
  is kept so its results can still be exported. Set it on the backend service if you
  want longer.
### Sizing the abuse limits for your audience

**Read this before the first large lecture.** Every "per IP" limit in the backend
is really *per egress address*, and an audience almost never has one address each:

- a campus or corporate network NATs hundreds of people behind **one IPv4 address**;
- on IPv6 the backend buckets clients by **/64 prefix**, deliberately — a host can
  otherwise pick a fresh address per connection and evade every limit — so an
  audience inside one /64 is likewise one bucket.

Either way, one lecture hall counts as one client. The defaults are sized for that
(a few hundred participants and a couple of dozen concurrent rooms per address),
but they are the right thing to raise if a deployment is bigger, and the right
thing to lower if it is a single classroom exposed to the open internet.

| Variable | Default | What it bounds |
|---|---|---|
| `MAX_SOCKETS_PER_IP` | 500 | Concurrent connections per address: one per participant, plus presenter and control window |
| `MAX_ROOMS_PER_IP` | 25 | Concurrent rooms per address: one per lecture in progress |
| `MAX_FAILED_ATTEMPTS_PER_WINDOW` | 50 | Wrong room ids per address per minute — a six-character code invites typos, and they all come from the same address |
| `FAILED_ATTEMPT_WINDOW_MS` | 60000 | The window for the above |
| `MAX_MESSAGES_PER_WINDOW` | 60 | Messages per **socket** per window; this one is genuinely per client |
| `MESSAGE_WINDOW_MS` | 10000 | The window for the above |
| `IPV6_PREFIX_BITS` | 64 | Prefix used to group IPv6 clients. Set to `56` where subscribers get a /56 |

Set them like any other variable in the unit file:

```ini
Environment=MAX_SOCKETS_PER_IP=1500
Environment=MAX_ROOMS_PER_IP=50
```

A value that is empty, zero, negative or unparseable is **ignored with a warning**
and the default is kept, so a stray `Environment=MAX_SOCKETS_PER_IP=` in a unit
file cannot accidentally refuse every connection.

Raising these is safer than it looks. Room ids are six characters from a
32-symbol alphabet — about 10^9 of them, of which a handful are live — so guessing
one is hopeless whether an attacker gets ten tries a minute or fifty. What the
limits really protect is memory, and a socket is cheap.

**Symptom to recognise:** participants who cannot join a lecture that is already
running, or a lecturer who cannot open a room while colleagues are presenting,
with everything working fine for the first N people. That is a limit, not a bug —
check the backend log, which names the limit it refused on.

- **`TRUST_PROXY` normally needs no setting at all.** The backend believes
  `X-Forwarded-For` when the connection comes from this machine, and ignores it
  otherwise. That is exactly the deployment above -- Caddy and the backend share a
  host -- and it cannot be abused from off-box, because the socket address is
  decided by the kernel rather than by the peer.

  Set it only for the two cases the default does not cover:

  - `TRUST_PROXY=true` when the proxy is on a *different* machine. Only do this if
    that proxy is genuinely the sole route to this port; otherwise any client can
    choose its own rate-limit bucket by sending the header itself.
  - `TRUST_PROXY=false` to bucket strictly by socket address, which is right only
    if there is no proxy at all.

  If the backend ever finds itself taking loopback connections with no usable
  `X-Forwarded-For`, it logs a warning once: in that situation every client counts
  as the same client, so `maxRoomsPerIp` (5) silently becomes a limit on the whole
  deployment. That warning previously did not exist and the symptom was a sixth
  lecture that simply could not start a room.
