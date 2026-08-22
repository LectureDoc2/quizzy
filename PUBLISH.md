# Publishing `@lecturedoc2/quizzy`

The component is published from GitHub Actions, so that
every release carries a **provenance attestation** — a signed, publicly logged
statement of which commit of which repository was built by which workflow to
produce that exact tarball.

Steps are grouped by how often you have to do them. If the release you are about
to cut is a routine one and trusted publishing is already configured, only
[§3 Cutting a release](#3-cutting-a-release) applies.

- [1. One-time setup](#1-one-time-setup)
- [2. The 72-hour part](#2-the-72-hour-part-and-how-to-stop-doing-it)
- [3. Cutting a release](#3-cutting-a-release)
- [4. After the publish](#4-after-the-publish)
- [5. When something fails](#5-when-something-fails)

Server deployment is a separate runbook: see `DEPLOY.md`.

---

## 1. One-time setup

Done once for the repository. Skip to §3 if the badge on the package page
already shows a provenance attestation.

**The repository environment.** `release.yml` pins its publish job to an
environment named `npm-publish`, which is where the credential lives and where a
required reviewer can be attached.

```bash
gh api --method PUT repos/LectureDoc2/quizzy/environments/npm-publish
```

Or: repository **Settings → Environments → New environment**. On a public
repository, add yourself under *Required reviewers* — a `v*` tag then pauses for
an explicit approval before anything reaches npm, which is worth having on a
step that cannot be undone.

**Trusted publishing.** This is the end state and it removes the token
entirely. It cannot be configured until the package exists on the registry, so
the *first* release has to go out on a token (§2); do this immediately
afterwards:

```bash
npm trust github @lecturedoc2/quizzy \
    --file .github/workflows/release.yml \
    --env npm-publish
```

Repository, workflow filename and environment must match what `release.yml`
actually uses. Then:

1. Delete the two lines in `release.yml` marked `BOOTSTRAP ONLY`.
2. Revoke the `NPM_TOKEN` on npmjs.com and delete the secret:
   `gh secret delete NPM_TOKEN --env npm-publish --repo LectureDoc2/quizzy`

From that point there is no long-lived credential anywhere, and §2 stops
applying — permanently.

---

## 2. The 72-hour part (and how to stop doing it)

**Only needed before trusted publishing is configured**, or if a trusted
publisher is ever revoked. A publish-capable npm token is short-lived by policy:
npm caps write-scoped granular tokens at 90 days, and a tighter expiry is better
still. Whatever the expiry, it will lapse between releases, and the failure looks
like an authentication error in the publish step.

Re-minting is three steps:

1. **npmjs.com → Access Tokens → Generate New Token → Granular Access Token.**
   - Packages: only the `@lecturedoc2` scope, **Read and write**
   - Expiration: as short as you will tolerate
   - **Enable "Bypass 2FA".** npm enforces 2FA on write tokens by default, and
     a token without this set cannot publish unattended — CI has no way to
     answer the prompt. This is the single most common reason a freshly minted
     token still fails.
2. **Store it on the environment**, not the repository, so nothing else in the
   repo can read it:

   ```bash
   gh secret set NPM_TOKEN --env npm-publish --repo LectureDoc2/quizzy
   ```

   (Prompts for the value. UI equivalent: the environment's page →
   *Environment secrets* → *Add environment secret*.)
3. **Revoke the previous token** if it has not expired on its own.

Then continue with §3. Nothing in the repository changes — the workflow reads
the secret by name.

> If you find yourself here more than once, do §1's trusted-publishing step
> instead. It exists precisely to delete this section.

---

## 3. Cutting a release

**Decide the version.** Semantic, and it means the component's public surface:
the `<ld-quiz>` element, its attributes, and the package's exports.

`PROTOCOL_VERSION` in `packages/ld-quiz/src/protocol.js` is deliberately
*not* tied to this. Bump it only when the wire format changes in a way that
would make an old client and a new server misbehave — and remember that a bumped
protocol invalidates every deck with an older bundled copy, which is the whole
reason the two numbers are separate.

```bash
cd ~/Code/Quizzy26
# edit packages/ld-quiz/package.json -> "version"
git add -A && git commit -m "release <version>"
git push
```

**Rehearse.** Run *Actions → Release → Run workflow* with **dry-run** left on.
It installs, runs the full test suite, packs, and stops without publishing.

**Tag and push.** The tag drives everything:

```bash
git tag v1.2.3 && git push origin v1.2.3
```

The workflow refuses if the tag and `packages/ld-quiz/package.json` disagree, so
a mismatched tag costs a red run rather than an unfindable version on the
registry.

If a required reviewer is configured, approve the run when it pauses.

---

## 4. After the publish

**Verify the attestation.** The package page should show a *Provenance* panel
naming the workflow, the commit and the runner. From a checkout:

```bash
npm audit signatures
```

**Re-deploy the quiz server.** `build.js` takes the immutable client URL from
this same version, so a release means `/client/<new-version>/ld-quiz.js` does not
exist on the server until you rebuild and deploy:

```bash
pnpm build      # writes dist/client/<version>/ and the moving alias
```

Then follow `DEPLOY.md`. Decks that pinned an older versioned URL keep working —
that is what pinning is for — but nothing can pin the new one until it is served.

**Update consumers.** LectureDoc2 depends on `^1.0.0`, so a minor or patch is
picked up by a plain `npm install`; a major needs the range widened in
`LectureDoc2/package.json` and its `dist/` rebuilt.

---

## 5. When something fails

| Symptom | Cause |
|---|---|
| `401`/`403` in the publish step | token expired, or minted without **Bypass 2FA** — see §2 |
| `ENEEDAUTH` after configuring trusted publishing | the trusted publisher's repository, workflow filename or environment does not match `release.yml` exactly; check with `npm trust list @lecturedoc2/quizzy` |
| `tag … does not match package version` | the guard did its job — fix the manifest or the tag, do not bypass it |
| Provenance panel missing, publish otherwise fine | the job lost `id-token: write`, or `--provenance` was dropped from the publish command |
| `You cannot publish over the previously published versions` | that version is already on the registry; npm versions are immutable, so bump and re-tag |
| Workflow never starts on a tag push | the tag does not match `v*`, or the tag was pushed without `git push origin <tag>` |

A failed publish is safe to retry: nothing is written to the registry unless the
whole command succeeds.
