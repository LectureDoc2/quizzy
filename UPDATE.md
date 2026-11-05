# Quizzy — Updating a Production Server

How to keep a Quizzy server up to date that was installed as described in
[DEPLOY.md](DEPLOY.md): the checkout in `/srv/quizzy`, owned by root and only read by
the backend; the backend running as `quizzy-backend.service`; Caddy configured from
the copies in `/etc/caddy`. References like "DEPLOY.md §10a" point into that
document. A server set up before the checkout became root-owned needs §7 once.

**Restarting the backend ends every running lecture and practice game**, because
room state lives only in its memory. Restart it when no lecture is running. The
steps below say which of them restart something:

| Step | Ends running lectures? |
|---|---|
| §1 Updating the application | **yes** — restarts the backend |
| §2 Caddyfile or TLS snippet changed | no — but connected clients reconnect |
| §3 Changing the practice quizzes | no |
| §4 Changing the configuration | backend: **yes**; Caddy: no, but clients reconnect |
| §5 System packages, Node.js and Caddy | when Node.js changed: **yes** |
| §7 Moving to the hardened layout (once) | **yes** — restarts the backend |

---

## 1. Updating the application

First see what the update brings:

```bash
cd /srv/quizzy
sudo git fetch
sudo git log --oneline HEAD..@{u}       # the new commits
sudo git diff --stat HEAD @{u}          # the files they change
```

- Only files under `quizzes/` change → §3 is enough; nothing needs a restart.
- `Caddyfile` or `caddy/` changes → this section, then §2.
- Anything else → this section.

Then update, build and restart:

```bash
cd /srv/quizzy
sudo git pull
sudo pnpm install --frozen-lockfile
sudo pnpm build
sudo systemctl restart quizzy-backend
```

- **Everything runs as root**, which owns the tree (DEPLOY.md §8). The backend only
  reads it, so nothing needs to be handed back to `quizzy` afterwards.
- **`pnpm install`** is cheap when the dependencies did not change, and it is what
  keeps `node_modules` matching the lockfile when they did.
- **`pnpm build`** regenerates `dist/`, which is not committed. After a release of
  the component this is what publishes its new versioned URL; [PUBLISH.md](PUBLISH.md)
  §4 describes what happens to the old one.
- **The restart** loads the new backend code. Caddy needs nothing: it serves `dist/`
  straight from disk, so the new pages are live as soon as the build finishes.

Check the result:

```bash
systemctl status quizzy-backend --no-pager
sudo journalctl -u quizzy-backend -n 20 --no-pager   # "Quizzy backend listening on …"
curl -s https://<HOST>/component/version.json       # the deployed component version
curl -s https://<HOST>/api/config                   # serverVersion, protocolVersion
```

---

## 2. When the Caddyfile or a TLS snippet changed

Caddy runs on the copies in `/etc/caddy`, not on the checkout, so a pull never
changes its configuration by itself. Compare the two:

```bash
sudo diff /srv/quizzy/Caddyfile /etc/caddy/Caddyfile
sudo diff -r /srv/quizzy/caddy /etc/caddy/caddy
```

No output means there is nothing to do. Otherwise:

1. Copy both again with the two `cp` lines of DEPLOY.md §10a.
2. If you changed `email` in the installed Caddyfile (DEPLOY.md §10b), make that
   change again.
3. Validate with the `caddy validate` line for your profile from DEPLOY.md §12.
4. Reload:

   ```bash
   sudo systemctl reload caddy
   ```

A reload leaves the backend and its rooms alone. A configuration Caddy rejects is
not applied — the running one stays in place, and `sudo journalctl -u caddy -n 20`
says why. Caddy does close the WebSocket connections it proxies, though, so
connected participants and presenters reconnect.

---

## 3. Changing the practice quizzes

The practice catalog (`quizzes/practice.json`, or the file `PRACTICE_CATALOG`
names) and the quiz files it lists are read when the backend starts and again on
reload. A reload, unlike a restart, leaves every running lecture alone.

When an update changes nothing but the files in `quizzes/` (§1 tells you), no
install, build or restart is needed:

```bash
cd /srv/quizzy
sudo git pull
sudo systemctl reload quizzy-backend
sudo journalctl -u quizzy-backend -n 20 --no-pager   # "Practice catalog …: N quiz(zes) available."
```

The log also names every entry that was skipped. Games already in progress finish
with the quiz they started with.

Change the catalog in the repository and pull it, rather than editing it in
`/srv/quizzy`: a local edit there can make the next `git pull` fail. To keep a
catalog that exists only on this server, put it outside the checkout, together
with the quiz files it lists, and point `PRACTICE_CATALOG` at it (§4). Do not put it
under `/home`: the backend unit's `ProtectHome=true` hides that from the backend.

---

## 4. Changing the configuration

**Backend** — the variables are listed in DEPLOY.md §13. They live in the unit file:

```bash
sudo systemctl edit --full quizzy-backend    # add or change Environment= lines
sudo systemctl restart quizzy-backend
```

`systemctl edit` reloads systemd's view of the unit when the editor closes; the
restart is what makes the backend see the new values.

To switch on the [practice usage statistics](README.md#usage-statistics) on a
server set up before they existed, add these lines to the `[Service]` section
the same way (DEPLOY.md §11a):

```ini
Environment=PRACTICE_STATS_DIR=/var/lib/quizzy
StateDirectory=quizzy
StateDirectoryMode=0700
```

After the restart, the backend's log says `Practice statistics are kept in
/var/lib/quizzy.` The CSV files appear a few minutes after midnight following
the first day with practice games: `sudo ls -l /var/lib/quizzy`.

**Caddy** — host name, backend address, TLS snippet and DNS-01 credentials are in
`/etc/caddy/quizzy.env` (DEPLOY.md §10c, §10d):

```bash
sudoedit /etc/caddy/quizzy.env
sudo systemctl restart caddy
```

Restart rather than reload here: values such as `{env.TSIG_SECRET}` are read from
the environment of the running Caddy process, which only a restart replaces.
Running lectures survive it; connected clients reconnect.

---

## 5. System packages, Node.js and Caddy

```bash
sudo apt update && sudo apt upgrade
```

This also updates Node.js (from the NodeSource repository) and, on the `http-01`
profile, Caddy. The backend keeps running on the old Node.js until it is restarted:

```bash
sudo systemctl restart quizzy-backend
```

To move to another Node.js major version, run the NodeSource setup script of that
line (DEPLOY.md §5, e.g. `setup_26.x` instead of `setup_24.x`), then
`sudo apt install -y nodejs`, check `node --version`, and restart the backend.

**`dns-01` profile only:** Caddy runs as `/usr/local/bin/caddy`, which `apt` never
touches (DEPLOY.md §6b). Rebuild it when a Caddy release matters to you: repeat
part 2 of DEPLOY.md §6b, which fetches the latest `xcaddy`, builds the latest Caddy
release and installs it, then `sudo systemctl restart caddy`.

---

## 6. Troubleshooting

Errors from `pnpm install` or `pnpm build` (`ERR_PNPM_…`) are covered in
[DEPLOY.md §14](DEPLOY.md#14-troubleshooting-quick-reference).

| symptom | cause | fix |
|---|---|---|
| `git pull` → `detected dubious ownership in repository` | The tree is still owned by `quizzy`, from before the hardened layout | §7 |
| `git pull` → `cannot open '.git/FETCH_HEAD': Permission denied` | The pull ran without `sudo` | Pull with `sudo`: the tree belongs to root |
| `git pull` → `Your local changes … would be overwritten` | A file was edited inside `/srv/quizzy`, e.g. `pnpm-workspace.yaml` by pnpm or the practice catalog by hand | `sudo git status` shows which. Discard with `sudo git checkout <file>`; keep a server-only catalog outside the checkout (§3) |
| Every new quiz is refused with "could not be prepared for display" | The render worker fails | [DEPLOY.md §14](DEPLOY.md#14-troubleshooting-quick-reference) |
| `systemctl reload caddy` fails | Caddy rejected the new configuration and kept the old one | `sudo journalctl -u caddy -n 20`; validate as in §2 |

---

## 7. Moving to the hardened layout (once)

Servers installed before this layout ran the backend with write access to its own
checkout, let Caddy's admin API listen on `localhost:2019`, and rendered quizzes
inside the backend. SECURITY_ARCHITECTURE.md explains why each of those mattered.
Moving over takes one backend restart, so do it when no lecture is running.

1. **Update the application** as in §1 — but skip its restart for now.
2. **Give the tree back to root:**

   ```bash
   sudo chown -R root:root /srv/quizzy
   ```

   The `safe.directory` exception recorded for root (former DEPLOY.md §8) is no
   longer needed; it does no harm if it stays.
3. **Replace the backend unit** with the one in DEPLOY.md §11a, keeping your own
   `Environment=` lines:

   ```bash
   sudo systemctl edit --full quizzy-backend
   ```

4. **Optional, recommended: the render worker service.** Create the two units of
   DEPLOY.md §11c and add `Environment=RENDER_SOCKET=/run/quizzy-render.sock` to the
   backend unit.
5. **Caddy:** add `CADDY_ADMIN=unix//run/caddy/admin.sock` to
   `/etc/caddy/quizzy.env` (DEPLOY.md §10c), add the two `RuntimeDirectory` lines to
   the drop-in (DEPLOY.md §11b), and install the new Caddyfile as in §2.
6. **Restart everything:**

   ```bash
   sudo systemctl daemon-reload
   sudo systemctl enable --now quizzy-render.socket     # only with step 4
   sudo systemctl restart quizzy-backend caddy
   ```

7. **Check** with items 6–8 of the verification checklist in DEPLOY.md §12, and
   open a room with the math demo.
