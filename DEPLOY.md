# Quizzy — Production Deployment on a Fresh Ubuntu 26.04 Host

End-to-end runbook to deploy the `quizzy` project (https://github.com/LectureDoc2/quizzy.git)
behind Caddy with HTTPS, using the DHBW HARICA ACME endpoint, with the Node backend
running under a dedicated service user, both managed by systemd.

This document covers the **first installation** only. Keeping a deployed server up to
date is described in [UPDATE.md](UPDATE.md); running Quizzy on your own machine in
[DEVELOPMENT.md](DEVELOPMENT.md).

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

`certificates.dhbw.cloud` currently has **no IPv6 connectivity**, so:

| host | certificate method | Caddy install (§6) |
|---|---|---|
| has a reachable IPv4 address | **HTTP-01** | 6a — apt package |
| IPv6 only | **DNS-01** | 6b — built with the RFC2136 module |

If issuance fails with *both* `http-01` "Connection error" **and** `tls-alpn-01`
"Unable to retrieve server certificate", that is this condition appearing at
runtime — see the troubleshooting table.

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

If it reads `IPV6=no`, set it to `yes` and run `sudo ufw disable && sudo ufw enable`
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

## 5. Install Node.js (system-wide)

Install Node.js **24**, the LTS line the CI tests against:

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version          # expect v24.x
command -v node         # expect /usr/bin/node  (matches the systemd unit in §11)
```

> If NodeSource has no repository for Ubuntu 26.04, fall back to the distribution
> package: `sudo apt install -y nodejs npm`.

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
# binary as ./caddy, and /srv/quizzy/caddy is the TLS snippets *directory*.
mkdir -p ~/caddy-build && cd ~/caddy-build
~/go/bin/xcaddy build --with github.com/caddy-dns/rfc2136

sudo install -o root -g root -m 0755 ./caddy /usr/local/bin/caddy
/usr/local/bin/caddy list-modules | grep rfc2136   # expect dns.providers.rfc2136
```

It is installed to `/usr/local/bin/caddy`, **not** over `/usr/bin/caddy`, so that an
`apt upgrade` of the `caddy` package cannot silently replace it with a binary
lacking the module — which would leave renewals failing months later.

This binary is not updated by `apt`; [UPDATE.md §5](UPDATE.md#5-system-packages-nodejs-and-caddy)
describes how to rebuild it.

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
```

The tree stays **owned by root**, and the backend only ever reads it. That is
deliberate: a backend that can write to its own code — or to `dist/app`, which
Caddy serves to every participant — would turn any compromise of the backend into a
permanent one, and into a compromise of every browser that loads the site. Section
11a enforces the same from the systemd side; SECURITY_ARCHITECTURE.md §9 explains
the reasoning.

The repository layout is described under "Project Structure" in the README. Of it,
this document uses the `Caddyfile` and the TLS snippets in `caddy/` (§10), the
backend entry point `packages/server/src/server.js` (§11a), and `dist/`, which is not
committed: `pnpm build` generates it (§9), and Caddy serves nothing until it exists.

---

## 9. Install dependencies and build

The repo is a **pnpm workspace**; install from the repository root.

```bash
cd /srv/quizzy
sudo corepack enable
sudo pnpm install --frozen-lockfile
sudo pnpm build            # writes dist/
```

Do **not** `chown` the tree to `quizzy` (§8). Everything in it is world-readable,
which is all the backend needs.

`esbuild` is a dev dependency and is required for the build, so do **not** install
with `--prod` unless you build elsewhere and copy `dist/` over.

**About dependency build scripts.** pnpm refuses to run dependency lifecycle
scripts unless each has an explicit decision recorded, and an *undecided* package
makes `pnpm install` exit **1**. Because `pnpm build` runs a dependency-status check
first, a stray `ERR_PNPM_IGNORED_BUILDS` then aborts the build with a
`runDepsStatusCheck` stack trace rather than a useful message.

The decision is committed in `pnpm-workspace.yaml`, so a clean checkout needs no
interaction:

```yaml
allowBuilds:
  esbuild: true
```

If pnpm has written a placeholder (`esbuild: set this to true or false`) on this
host, discard the local edit: `sudo git checkout pnpm-workspace.yaml`.

`playwright` also appears in the tree — it is a dev dependency of the browser test
suite (DEVELOPMENT.md §6). It is deliberately **not** in `allowBuilds`, so its
postinstall never runs and **no browser binaries are downloaded**; the install stays
around 40 MB.

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

### 10b. Check the ACME issuer

The global options block at the top of the Caddyfile already selects the DHBW
HARICA ACME endpoint. It must: without `acme_ca`, Caddy defaults to Let's Encrypt,
which cannot validate this internal host.

```caddyfile
{
	http_port {$HTTP_PORT:80}
	https_port {$HTTPS_PORT:443}
	email michael.eichberg@dhbw.de
	acme_ca https://certificates.dhbw.cloud/acme/directory
}
```

If certificate notices should go to someone else, change `email` in
`/etc/caddy/Caddyfile`.

Leave the rest as-is. It contains two kinds of relative path, resolved differently:

- **`import {$TLS_CONFIG:caddy/tls-auto.txt}`** is resolved when the config is
  *adapted*, relative to the Caddyfile containing the import — hence
  `/etc/caddy/caddy/…`, and hence the second `cp` in 10a. Running `caddy validate`
  from `/srv/quizzy` does **not** change this.
- **`root * dist/app`** and other runtime paths resolve against the process working
  directory, i.e. the `WorkingDirectory` set in section 11.

### 10c. Create the environment file

```bash
sudo tee /etc/caddy/quizzy.env >/dev/null <<'EOF'
CADDY_HOST=quizzy.michael-eichberg-at-dhbw-de.users.dhbw.site
BACKEND_HOST=localhost
BACKEND_PORT=3000
CADDY_ADMIN=unix//run/caddy/admin.sock
EOF
sudo chown root:caddy /etc/caddy/quizzy.env
sudo chmod 640 /etc/caddy/quizzy.env
```

These are all the variables the Caddyfile reads:

| Variable | Default | Meaning |
|---|---|---|
| `CADDY_HOST` | `localhost` | Site address: here the host name. `http://localhost:8080` serves plain HTTP on that port (DEVELOPMENT.md §3) |
| `BACKEND_HOST` | `localhost` | Host of the backend; see the note below |
| `BACKEND_PORT` | `3000` | Port of the backend; must match its `PORT` (§11a) |
| `TLS_CONFIG` | `caddy/tls-auto.txt` | The TLS snippet, see below |
| `HTTP_PORT` / `HTTPS_PORT` | `80` / `443` | Caddy's HTTP and HTTPS ports. Leave them unset in production |
| `CADDY_ADMIN` | `localhost:2019` | Where Caddy's admin API listens; see the note below |
| `TSIG_KEY_NAME`, `TSIG_SECRET`, `TSIG_ALGORITHM`, `TSIG_NAMESERVER` | — | DNS-01 credentials, read by `caddy/tls-dns01.txt` (10d) |

`TLS_CONFIG` selects the snippet, and therefore how certificates are obtained:

| value | meaning |
|---|---|
| *(unset)* | `caddy/tls-auto.txt` — empty, i.e. HTTP-01 / TLS-ALPN-01 |
| `caddy/tls-dns01.txt` | DNS-01 via RFC2136 |
| `caddy/tls-mkcert.txt` | a locally trusted mkcert certificate, development only (DEVELOPMENT.md §4) |

> **Why `CADDY_ADMIN` is a socket in production.** Caddy's admin API can replace
> the whole configuration, and on its default address, `localhost:2019`, it accepts
> that from **any process on the machine** — the backend included. A compromised
> backend could then make Caddy serve its own pages to every participant, or expose
> any file and environment variable Caddy can read: the TLS keys, the TSIG secret. A
> Unix socket in `/run/caddy`, a directory only the `caddy` user can enter (§11b),
> takes that away. `systemctl reload caddy` keeps working: it runs as `caddy` and
> finds the address in the Caddyfile. Local development keeps the default.

> Leave `BACKEND_HOST=localhost` — it resolves to whichever families the host has,
> so it is correct on IPv4, IPv6 and dual-stack alike. A literal IPv6 address would
> have to be **bracketed** (`BACKEND_HOST=[::1]`): the Caddyfile appends `:port`, so
> an unbracketed `::1` becomes the invalid `::1:3000`.

#### Optional: bind the backend to loopback only

By default the backend listens on every interface, and the firewall from section 3
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
# Re-reads the practice catalog without ending running lectures.
ExecReload=/bin/kill -HUP $MAINPID
Environment=NODE_ENV=production
Environment=PORT=3000
# Anonymous usage totals of the practice quizzes (§13a). Remove both lines to
# keep the backend from writing anything at all.
Environment=PRACTICE_STATS_DIR=/var/lib/quizzy
StateDirectory=quizzy
StateDirectoryMode=0700
User=quizzy
Group=quizzy
Restart=on-failure
RestartSec=2

# --- Hardening --------------------------------------------------------------
# The backend keeps no database and no per-person data on disk. Its only
# writable path is the StateDirectory above, /var/lib/quizzy, which systemd
# creates and keeps writable despite ProtectSystem=strict -- not even its own
# checkout is writable (see §8).
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
# It talks to Caddy over loopback and to nobody else. If Caddy runs on another
# machine, add that machine's address to IPAddressAllow.
IPAddressDeny=any
IPAddressAllow=localhost
# AF_NETLINK: listing the host's addresses at startup.
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX AF_NETLINK
# Caddy's configuration, state and admin socket are none of its business.
InaccessiblePaths=-/etc/caddy -/var/lib/caddy -/run/caddy
CapabilityBoundingSet=
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
SystemCallErrorNumber=EPERM
UMask=0077
# Caps for the backend together with its render workers (child mode, §11c).
MemoryMax=1G
TasksMax=256

[Install]
WantedBy=multi-user.target
EOF
```

Further settings are added as `Environment=` lines here; section 13 lists them.

Two things are deliberately absent. `MemoryDenyWriteExecute=` would forbid the
writable-and-executable memory V8's JIT compiler needs, and Node would not start.
`ProcSubset=pid` would hide `/proc/meminfo`, from which Node sizes its heap.

Every quiz the backend is asked to show is rendered — KaTeX for formulas,
highlight.js for code — in a **separate worker process**, never in the backend
itself: anyone who can reach the WebSocket can submit a quiz, so those two parsers
see input from strangers. By default the backend spawns the worker itself, confined
by Node's permission model and by everything above. Section 11c moves it into a unit
of its own, which is stronger; SECURITY_ARCHITECTURE.md §6 compares the two.

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
# The admin socket's directory, entered by no one but caddy (§10c).
RuntimeDirectory=caddy
RuntimeDirectoryMode=0700
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
# The admin socket's directory, entered by no one but caddy (§10c).
RuntimeDirectory=caddy
RuntimeDirectoryMode=0700
ExecStart=
ExecStart=/usr/local/bin/caddy run --environ --config /etc/caddy/Caddyfile
ExecReload=
ExecReload=/usr/local/bin/caddy reload --config /etc/caddy/Caddyfile --force
EOF
```

The empty `ExecStart=` is **required**: without it systemd appends to the vendor
unit's value instead of replacing it, and the service fails to start.

### 11c. Render worker service (recommended)

Without this section the backend renders each quiz in a child process it spawns
itself (§11a). That child runs under Node's permission model — it cannot read
anything but its own code and the two libraries, cannot write, cannot start
processes — but Node's documentation is explicit that the permission model does
not hold against code that is already malicious, and Node 24 cannot restrict the
network at all. The child also inherits the backend's view of the machine, the
quiz files included.

These two units move rendering into a service of its own, started fresh for every
quiz: a throwaway user, no network whatsoever, and a file system that contains
nothing but the server package and its dependencies.

```bash
sudo tee /etc/systemd/system/quizzy-render.socket >/dev/null <<'EOF'
[Unit]
Description=Quizzy quiz renderer (socket)

[Socket]
ListenStream=/run/quizzy-render.sock
# Only the backend may connect.
SocketUser=quizzy
SocketGroup=quizzy
SocketMode=0600
# One worker process per connection, i.e. per quiz.
Accept=yes
MaxConnections=4

[Install]
WantedBy=sockets.target
EOF

sudo tee /etc/systemd/system/quizzy-render@.service >/dev/null <<'EOF'
[Unit]
Description=Quizzy quiz renderer (one quiz)

[Service]
ExecStart=/usr/bin/node --permission \
  --allow-fs-read=/srv/quizzy/packages/server --allow-fs-read=/srv/quizzy/node_modules \
  --frozen-intrinsics --disallow-code-generation-from-strings \
  --max-old-space-size=128 --disable-warning=ExperimentalWarning \
  /srv/quizzy/packages/server/src/render-worker.js
StandardInput=socket
StandardOutput=socket
StandardError=journal
DynamicUser=true
# The backend gives up after RENDER_TIMEOUT_MS (10 s); this is the backstop.
RuntimeMaxSec=15
MemoryMax=256M
CPUQuota=100%
TasksMax=32

# No network: the request arrives on the socket systemd hands over.
PrivateNetwork=true
IPAddressDeny=any
RestrictAddressFamilies=AF_UNIX
# Of /srv, only the code: no quizzes, no dist/, no .git.
TemporaryFileSystem=/srv:ro
BindReadOnlyPaths=/srv/quizzy/packages/server /srv/quizzy/node_modules
InaccessiblePaths=-/etc/caddy -/var/lib/caddy -/run/caddy
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
PrivateIPC=true
NoNewPrivileges=true
CapabilityBoundingSet=
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectKernelLogs=true
ProtectControlGroups=true
ProtectClock=true
ProtectHostname=true
ProtectProc=invisible
RestrictNamespaces=true
RestrictRealtime=true
RestrictSUIDSGID=true
LockPersonality=true
SystemCallArchitectures=native
SystemCallFilter=@system-service
SystemCallFilter=~@privileged
SystemCallErrorNumber=EPERM
UMask=0077
EOF
```

Then point the backend at the socket — add to the `[Service]` section of
`quizzy-backend.service` (§11a):

```ini
Environment=RENDER_SOCKET=/run/quizzy-render.sock
```

The `--allow-fs-read` paths are broader than in child mode, where the backend
computes the exact package directories itself; here the file system the unit sees
is the boundary, and it holds nothing but code. They do not name package versions,
so a dependency update needs no change to the unit.

---

## 12. Start and verify

The only place that starts Caddy. Nothing before this should have restarted it.

```bash
# Validate the config. On the dns-01 profile use the explicit path, so that a
# missing rfc2136 module is caught here rather than at runtime.
sudo caddy validate --config /etc/caddy/Caddyfile                    # http-01 profile
sudo /usr/local/bin/caddy validate --config /etc/caddy/Caddyfile     # dns-01 profile

sudo systemctl daemon-reload
sudo systemctl enable --now quizzy-render.socket     # only with §11c
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

# 6. The backend cannot write to its own code, and Caddy's admin API is not on TCP.
sudo -u quizzy touch /srv/quizzy/dist/app/probe     # expect "Permission denied"
curl -sS localhost:2019/config/                     # expect "Connection refused"

# 7. Where quizzes are rendered: "...rendered by the worker service at
#    /run/quizzy-render.sock" with §11c, "...in sandboxed child processes" without.
sudo journalctl -u quizzy-backend -n 20 --no-pager | grep -i rendered

# 8. How exposed each unit is. Lower is better; compare before and after §11.
systemd-analyze security quizzy-backend.service quizzy-render@x.service caddy.service
```

Then open the math demo (`/demo.html`) and start a room: formulas and code
blocks must render. A quiz refused with "could not be prepared for display" means
the worker failed; `sudo journalctl -u quizzy-backend -u 'quizzy-render@*' -n 50`
says why.

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

## 13. Backend configuration

These are all the variables the backend reads. Set them as `Environment=` lines in
the backend unit (§11a); [UPDATE.md §4](UPDATE.md#4-changing-the-configuration)
shows how to change them on a running server.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | Port the backend listens on; must match `BACKEND_PORT` (§10c) |
| `HOST` | every interface | Address the backend binds to; see "bind the backend to loopback only" in §10c |
| `ALLOWED_ORIGINS` | `*` | Comma-separated origins the API's CORS middleware accepts. Restrict it to the origins your decks are served from |
| `PRACTICE_CATALOG` | `quizzes/practice.json` in the checkout | The practice catalog; see "Practice Mode" in the README. A missing file turns practice mode off |
| `PRACTICE_STATS_DIR` | *(unset: off)* | Directory for the anonymous practice usage statistics; see 13a and "Usage statistics" in the README. The unit in §11a sets `/var/lib/quizzy` |
| `ENDED_ROOM_RETENTION_MINUTES` | 15 | How long a finished room is kept so that its results can still be exported |
| `DETACHED_RETENTION_MINUTES` | 15 | How long a participant whose connection dropped can come back with the same name and score; see 13a |
| `TRUST_PROXY` | *(unset)* | Whether to believe `X-Forwarded-For`; see 13c |
| `MAX_…`, `…_WINDOW_MS`, `IPV6_PREFIX_BITS` | see 13b | The abuse limits |
| `RENDER_SOCKET` | *(unset)* | Socket of the render worker service (§11c). Unset: the backend spawns sandboxed workers itself |
| `RENDER_TIMEOUT_MS` | 10000 | How long one quiz may take to render before it is refused |
| `RENDER_MAX_CONCURRENCY` | 2 | Quizzes rendered at the same time. Keep it at or below `MaxConnections` in §11c |
| `RENDER_MAX_QUEUE` | 16 | Quizzes waiting for a worker; beyond that, "the server is busy" |
| `RENDER_MAX_OUTPUT_BYTES` | 16777216 | Largest rendered quiz accepted (KaTeX output is large) |
| `RENDER_MEMORY_MB` | 128 | Heap limit of a child-mode worker; §11c sets its own |
| `PUBLIC_WS_PATH`, `PUBLIC_JOIN_PATH`, `PUBLIC_CONTROL_PATH`, `PUBLIC_KATEX_CSS_PATH`, `PUBLIC_HIGHLIGHT_CSS_PATH` | the standard paths | Override the paths `/api/config` reports; see "Service discovery" in the README |

### 13a. Data protection

`DETACHED_RETENTION_MINUTES` is a data-protection setting, not only a memory one:
for this long after a student's connection closes, their name, answers and score
stay in the backend's RAM. Keep the window short; nothing about a participant is
ever written to disk, and a restart still discards everything. The participant's browser keeps a random
resume key in `sessionStorage` for the same purpose — per tab, never sent anywhere
else, and deleted when the quiz ends or the tab is closed. Mention both in your
privacy notice (Datenschutzerklärung); see `PARTICIPANT-REATTACH.md` for the
reasoning.

A quiz that sets `"recordNamedResults": true` additionally asks each participant,
with an unticked checkbox on the join page, whether their **name and final
score** may appear in the results CSV. Nothing else about them is added: no
answers to individual questions, no rank. Participants see their choice for the
whole quiz and can change it until the quiz ends. If your lecturers use this,
the privacy notice should say what is collected and why, that the legal basis is
consent (Art. 6(1)(a) GDPR), that consent is optional and can be withdrawn until
the quiz ends, and that the downloaded CSV is then held by the lecturer, who is
responsible for keeping and deleting it.

**Practice usage statistics** (`PRACTICE_STATS_DIR`) contain no personal data.
They are totals per quiz and calendar day: games started, finished and
abandoned, final scores in four bands, and per question how often it was
shown, answered and answered fully correctly. No address, room id, token, name
or time of day is recorded, and no game is recorded individually: each event
only adds one to a total. That is anonymous data (GDPR Recital 26), which the
GDPR does not cover, and nothing is stored on the student's device, so there is
nothing to consent to (§ 25 TDDDG). The privacy notice need not mention them;
say so in one sentence if you want to be transparent. This holds as long as no
other log ties requests to addresses: the Caddyfile configures no access log,
and one you enable would be what needs the privacy notice.

The consent checkbox, the participant's view of their choice, and the note about
the resume key are shown in German or English, following the student's browser
(see "Language" in ARCHITECTURE.md). The exact wording is in
`packages/server/web/locales/de.json` and `en.json`, under the keys
`consent.*` and `privacy.*`, if your privacy notice should quote it.

### 13b. Sizing the abuse limits for your audience

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
| `MAX_PRACTICE_GAMES_PER_IP` | 300 | Concurrent practice games per address, counted apart from `MAX_ROOMS_PER_IP` so that practising never stops a lecture from starting. A game a student abandons counts for `DETACHED_RETENTION_MINUTES` |
| `MAX_FAILED_ATTEMPTS_PER_WINDOW` | 50 | Wrong room ids per address per minute — a six-character code invites typos, and they all come from the same address |
| `FAILED_ATTEMPT_WINDOW_MS` | 60000 | The window for the above |
| `MAX_MESSAGES_PER_WINDOW` | 60 | Messages per **socket** per window; this one is genuinely per client |
| `MESSAGE_WINDOW_MS` | 10000 | The window for the above |
| `IPV6_PREFIX_BITS` | 64 | Prefix used to group IPv6 clients. Set to `56` where subscribers get a /56 |

For example:

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

### 13c. `TRUST_PROXY`

It normally needs no setting at all. The backend believes `X-Forwarded-For` when
the connection comes from this machine, and ignores it otherwise. That is exactly
the deployment above — Caddy and the backend share a host — and it cannot be abused
from off-box, because the socket address is decided by the kernel rather than by
the peer.

Set it only for the two cases the default does not cover:

- `TRUST_PROXY=true` when the proxy is on a *different* machine. Only do this if
  that proxy is genuinely the sole route to this port; otherwise any client can
  choose its own rate-limit bucket by sending the header itself.
- `TRUST_PROXY=false` to bucket strictly by socket address, which is right only
  if there is no proxy at all.

If the backend takes loopback connections with no usable `X-Forwarded-For`, it logs
a warning once: in that situation every client counts as the same client, so the
per-address limits from 13b — `MAX_ROOMS_PER_IP` in particular — apply to the whole
deployment.

---

## 14. Troubleshooting quick reference

Problems that only appear when updating an existing server (`git pull`, file
ownership) are covered in [UPDATE.md §6](UPDATE.md#6-troubleshooting).

| symptom | cause | fix |
|---|---|---|
| `pnpm build` → `ERR_PNPM_IGNORED_BUILDS: esbuild`, then a `runDepsStatusCheck` stack trace | pnpm exits 1 for any dependency whose build script has no recorded decision, and `pnpm build` checks dependency status first | `pnpm-workspace.yaml` must contain `allowBuilds:` / `  esbuild: true` (committed). If pnpm wrote a placeholder here, `sudo git checkout pnpm-workspace.yaml` |
| `ERR_PNPM_OUTDATED_LOCKFILE` | The checkout's `pnpm-lock.yaml` is older than its `package.json` | Fix at the source: `pnpm install` locally, commit the lockfile. Do not reach for `--no-frozen-lockfile` — the frozen install is what guarantees the host gets the tested tree |
| `caddy validate` → `File to import not found: caddy/tls-auto.txt` | Only the Caddyfile was copied to `/etc/caddy`, not the snippets beside it | Run both `cp` lines from 10a |
| Every new quiz is refused with "could not be prepared for display" | The render worker fails. With §11c: the socket unit is not running, or `RENDER_SOCKET` names another path | `sudo journalctl -u quizzy-backend -u 'quizzy-render@*' -n 50`; `systemctl status quizzy-render.socket` |
| Backend or render worker exits with `status=31/SYS` | A system call the unit's `SystemCallFilter=` forbids, without `SystemCallErrorNumber=EPERM` to soften it | Keep `SystemCallErrorNumber=EPERM` (§11a, §11c); `journalctl -k` names the syscall |
| Caddy fails to start after editing the drop-in | `ExecStart=` was overridden without the empty reset line, so systemd has two `ExecStart` values | Keep the bare `ExecStart=` before the real one (§11b) |
| `caddy validate` → unknown module `dns.providers.rfc2136` | Validating with the packaged binary rather than the custom build | Use `/usr/local/bin/caddy validate …` (§12) |
| ACME `http-01` "Connection error" **and** `tls-alpn-01` "Unable to retrieve server certificate" | The CA validates by connecting *to* this host and has no IPv6 | Switch to the DNS-01 profile (§1.2, 6b, 10d). Confirm first with `curl -6 http://<HOST>/` from elsewhere — a `308` means your firewall is fine and the CA is the problem |
| `xcaddy build` → `open /srv/quizzy/caddy/caddy: permission denied`, then `install: omitting directory 'caddy'` | Built inside `/srv/quizzy`, where `caddy/` is already the snippets directory (and which is root-owned) | Build in an empty directory (§6b) |
| `curl`/`openssl` to `[::1]` → `tlsv1 alert internal error` | No SNI is sent for an IP literal, so Caddy cannot select a certificate. Not a certificate fault | Ask for the hostname and pin the address: `curl -g --resolve '<HOST>:443:[::1]' https://<HOST>/`, or `openssl s_client -servername <HOST>` |
| Connections establish, then hang on larger transfers | ICMPv6 "Packet Too Big" is blocked, so PMTUD fails | Add the `ipv6-icmp` ingress rule (§3a) |
| The name does not resolve for clients | Missing or wrong-type DNS record | §4 — `A` for IPv4, `AAAA` for IPv6 |
