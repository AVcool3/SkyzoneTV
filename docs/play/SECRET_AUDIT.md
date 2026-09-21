# ParkCast Player — Secret & Credential Audit

Audit date: 2026-09-21. Scope: the `android-player/` tree (working copy **and** full git
history), plus server secret handling. Methods: file reads, pattern greps
(`password|secret|token|api[_-]?key|Bearer|AKIA|AIza`), `git log --oneline --follow`,
`git log --all --diff-filter=A --name-only`, `git log -S`, and `git show` on historical
blobs. Secret **values** seen during verification are not reproduced in this document.

---

## 1. KNOWN FINDING (restated with commit refs): upload keystore + passwords were in git

`git log --oneline --follow -- android-player/keystore/` and
`git log --all --oneline --name-only -- 'android-player/keystore/*'`:

| Commit | Date | What happened to the keystore files |
|--------|------|-------------------------------------|
| `7834ba9` — "Store-ready release builds: signing, target SDK 36, store assets, publishing guide" | 2026-09-09 | **Added** `android-player/keystore/upload.jks` (binary, ~2.6 KB) and `android-player/keystore/keystore.properties`. Verified via `git show 7834ba9:android-player/keystore/keystore.properties`: the file contains real values for all four keys — `storeFile`, `storePassword`, `keyAlias`, `keyPassword` |
| `13df5a8` — "Rename store app to ParkCast Player (neutral store branding)" | — | Modified `upload.jks` (re-generated for the rename) |
| `ebf2f34` — "Audit wave 3: keystore out of git, CI covers cloud mode, infra and docs truth" | — | **Removed both files** (`upload.jks Bin 2650 -> 0 bytes`, `keystore.properties | 4 -`) and added the `.gitignore` rule |

Corroborating searches: `git log --all -S "storePassword" --oneline` → exactly
`7834ba9` and `ebf2f34` (introduction and removal; no other commit ever touched the
password material).

**Current state (verified):**
- `android-player/keystore/` does **not** exist in the working tree (`ls` fails).
- Root `.gitignore` ignores `android-player/keystore/` with an explicit warning comment
  ("They were tracked before Sept 2026 — treat that key as burned…").
- `app/build.gradle.kts:12-15` loads `keystore/keystore.properties` only `if (f.exists())`,
  with empty-string fallbacks (37-41), so CI/other machines build without the secret.
  (Re-verified after the v1.3.1 changes in 48d305c: the signing block is unchanged in
  substance; the default `keyAlias` fallback is now `"parkcast"`, line 39 — a name,
  not a secret.)
- **History was NOT rewritten**: `git show 7834ba9:android-player/keystore/keystore.properties`
  still returns the passwords, and the `.jks` blob is still retrievable from any clone
  of this repo. Anyone with repo read access holds the upload key and its passwords.

**Required remediation (already planned, restated):** enroll in **Play App Signing** at
first upload, then **reset the upload key** (Play Console → Setup → App signing →
Request upload key reset) with a freshly generated keystore kept out of the repo —
procedure and keytool command are in `docs/STORE-PUBLISHING.md:12-21`. Until the reset
completes, treat the key as compromised: it must never become the app signing key.
(Optional extra: rewrite history with `git filter-repo` — worthwhile only if the repo
will ever gain more readers; the key rotation is the real fix.)

## 2. App source & build config: no baked-in secrets (verified clean)

- Grep of `android-player/app/src` for `password|secret|token|api[_-]?key|Bearer|AKIA|AIza`
  (case-insensitive): **zero matches**.
- `BuildConfig` (generated `.../buildConfig/release/com/parkcast/player/BuildConfig.java`)
  contains exactly one custom field: `DEFAULT_SERVER_URL = "https://parkcast.onrender.com"`
  (defined at app/build.gradle.kts:30; the checked-in generated copy under `app/build/`
  predates the v1.3.1 bump but carries the identical field). This is a **public** service URL — the
  same one printed on the privacy policy and typed into TVs — not a secret. Fine to ship.
- `strings.xml`, `themes.xml`: branding and dialog text only (strings.xml:1-18,
  including the new exit-dialog strings added in 9693c6f — nothing secret).
- `android-player/gradle.properties`: `org.gradle.jvmargs` and `android.useAndroidX`
  only.
- The app has **no auth material at all by design**: players are unauthenticated and
  pair by on-screen code (server/src/index.js:47, 553-568, 570-604). There is no API
  key, no client secret, no bearer token anywhere in the APK.
- Complete list of every file ever committed under `android-player/`
  (`git log --all --diff-filter=A --name-only`): 14 paths — the Kotlin sources (old
  `com.skyzone.tvplayer` and current package), manifest, 3 gradle files,
  gradle.properties, res files, and the two keystore files. Only the keystore files
  were ever secret material.

## 3. False positive, on the record

`git log --all -S "AKIA"` flags commit `bc03c7c` ("Media accepts PowerPoint decks…").
Investigated: the string `AKIAqgCyALoAYABoAGAAaABg` occurs once inside
`server/public/dashboard/vendor/html2canvas.min.js` — it is a fragment of the library's
embedded base64 text-segmentation data (mixed-case continuation, not the
`AKIA[A-Z0-9]{16}` AWS access-key shape). Not a credential. `AIza` (Google API key
prefix): zero matches anywhere in history.

## 4. Server secret handling (env vars only — verified)

Every server credential is read from the environment, never from tracked files:

| Secret | Read at | Notes |
|--------|---------|-------|
| `ADMIN_PASSWORD` (legacy default-venue login) | server/src/index.js:34 | Fallback: auto-generated on first boot (`crypto.randomBytes(4).toString('hex')`, index.js:37) and stored in `db.json` — which lives under `server/data/`, gitignored (root `.gitignore`) or under the Render disk (`DATA_DIR=/data`, render.yaml) |
| `OWNER_EMAIL` | server/src/index.js:49 | Config, not a credential, but personal — env-only |
| `ROLLER_CLIENT_ID` / `ROLLER_CLIENT_SECRET` | server/src/roller.js:30-31 | Booking-system OAuth pair — env-only |

- `render.yaml` declares all four with `sync: false` (values live only in the Render
  dashboard, never in the repo).
- **No `.env` file exists anywhere in the repo** (verified:
  `find . -name ".env*"` excluding node_modules → nothing), and no dotenv loader is
  present (server/package.json has only express/multer/ws).
- `git log --all -S "ROLLER_CLIENT_SECRET"` → `80dc8aa`, `ebf2f34`: both are references
  to the **variable name** in code/docs (`roller.js`, render.yaml), never a value.
- `ops/venues.json` and `deploy/install-linux.sh`: URLs and setup steps only; a
  secret-pattern grep across `deploy/`, `ops/`, `docs/`, `README.md` found no hardcoded
  values.

## 5. Two server-side observations (not app blockers, worth tracking)

1. **`ADMIN_PASSWORD` is printed to stdout on every startup** (server/src/index.js:1681-1682)
   — deliberate for LAN self-hosting, but on Render the venue's live admin password
   lands in the platform's retained service logs on every deploy/restart. Recommend
   printing it only when auto-generated (first boot) or masking when
   `process.env.ADMIN_PASSWORD` is set. (Flagged; do not fix in this audit pass.)
2. The auto-generated fallback password is 8 hex chars / 32 bits (index.js:37) — behind
   per-IP lockout (index.js:296-310) this is acceptable for LAN mode, and cloud deploys
   set their own via env, but a longer default would cost nothing.

## 6. Verdict

- App + BuildConfig: **clean** — nothing secret ships in the APK/AAB.
- Repo working tree: **clean**.
- Git history: **one confirmed exposure** (upload keystore + passwords,
  `7834ba9`..`ebf2f34^`, still retrievable) — mitigated by gitignore, **closed only by
  the pending Play App Signing upload-key reset**. This is a release-process blocker,
  not a listing-content blocker.
- Server: secrets are env-only; two log-hygiene observations above.
