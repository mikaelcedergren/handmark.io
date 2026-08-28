# Application storage cutover

Status: **not run**. The compiled TypeScript/SQLite source target, importer, and startup interlock
exist, but production still runs the legacy MJS/JSONL service. This is the separately authorised
operational procedure for moving that live queue to the compiled server. Source completion does
not stop a service, inspect operational applications, create the production database, select a
server release, change launchd, or alter the backup registry.

The shared release, backup, health, and rollback contracts are owned by
[`SERVER-STANDARD.md`](../../SERVER-STANDARD.md). This file owns only the Handmark data cutover.

## Non-negotiable rules

- Stop the legacy daemon before inspecting or importing its JSONL file. The old writer has no
  migration lock, so an online copy cannot be proven complete.
- Import the exact source once into an absent SQLite target. There is no dual write, JSONL fallback,
  compatibility reader, skipped row, repair mode, or partial import.
- Keep the original JSONL bytes unchanged and read-only. The importer repeatedly proves its inode,
  metadata, complete digest, and bytes while it runs. After cutover, while it remains at
  `data/applications.jsonl`, the target opens and hashes it during startup as an integrity witness;
  it is never the application store, a request-time reader, fallback, or dual-write target.
- Ordinary production startup always requires an existing selected SQLite database containing the
  one sealed legacy import receipt. That requirement survives an eventual approved removal of the
  JSONL evidence. While the source remains, the receipt's source byte count and SHA-256 must also
  match the exact file, and the source's complete parent-directory chain must remain contained,
  real, non-symlinked, and identity-stable inside the operational root. These checks happen before
  retention, intake, or listening. Development and isolated release validation are exempt so
  owned synthetic roots may create fresh databases; they never establish operational cutover
  proof. Never bypass the production interlock by moving the source, creating an empty database, or
  changing `DATA_DIR`.
- Receipt preflight uses SQLite's immutable read-only access against the descriptor-pinned main
  database. It cannot create or alter WAL/SHM files. Before writable open, the main database,
  every required rollback-journal reservation, and WAL/SHM paths must each be directory-contained,
  mode `0600`, single-link regular files whose descriptors and identities stay unchanged across the
  startup checkpoints; a clean WAL database instead proves its unused rollback-journal path stays
  absent. Existing WAL/SHM recovery files are opened and pinned in place, never discarded or
  replaced as cleanup. The sealed receipt is re-proven through the writable
  connection before configuration, schema, or storage mutations begin. A canonical earlier
  migration-ledger prefix may then advance, but every pending migration and the final
  current-schema/unchanged-receipt proof commit or roll back as one transaction.
- Main/sidecar identities and the complete directory chain remain pinned during runtime. In exempt
  synthetic contexts, a missing main database is allocated exclusively with no-follow and mode
  `0600`, then identity-proven before SQLite opens writable storage. In every mode, missing sidecar
  reservations use the same allocation discipline only after the selected main database passes its
  required proof; SQLite never creates an unowned pathname on demand.
- A pre-existing database, SQLite sidecar, ambiguous staging residue, changed source, or failed
  parity proof blocks cutover. Do not delete or rename the conflicting evidence to make the import
  pass.
- Do not resume the legacy writer after the new server has accepted a SQLite application. That
  would fork the review queue.
- Every `sudo`, service, registry, release-selection, backup, and public verification action below
  requires separate operational authorisation. Source completion is not that authorisation.

## Entry gates

Do not begin until all of these are recorded:

1. The required cx-framework version is published, both real Handmark dependency locks resolve that
   published GitHub commit, and a clean frozen install passes.
2. `pnpm check` and `pnpm e2e` pass from the final source.
3. A physical server artifact passes isolated identity, health, network, filesystem, dependency,
   shutdown, and deterministic-digest checks.
4. The stopped operational JSONL fits the importer's explicit source, record, and per-record bounds.
   The current fail-closed ceilings are 100 MiB for the source, 10,000 records, and 512 KiB per
   record. A bound failure requires a new reviewed migration design; it is never split or
   truncated.
5. A disposable extracted SQLite backup and restore reproduce the imported database exactly before
   `sqlite-online` is added to the real registry.
6. The new server release, launchd change, backup declaration, and rollback commands have been
   reviewed together. The old daemon remains available only as a pre-intake rollback path.

## 0. Prepare the source-identical candidates

Before stopping the legacy service, use the canonical paired preparation flow in
[`server-ops/README.md`](../../server-ops/README.md#cut-over-a-browser-and-server-pair) to prepare
one inactive Handmark browser candidate and one inactive Handmark server candidate. Use explicit,
recorded release IDs:

```bash
node ../server-ops/bin/site-release.mjs \
  --site handmark --prepare-only --release-id <browser-id>
node ../server-ops/bin/site-release.mjs \
  --site handmark --prepare-only --release-id <browser-id> --apply
node ../server-ops/bin/server-release.mjs \
  --site handmark --prepare-only --release-id <server-id>
node ../server-ops/bin/server-release.mjs \
  --site handmark --prepare-only --release-id <server-id> --apply
```

Record both identities and prove their revision, source fingerprint, and dirty-state flag are
identical. Candidate preparation must leave `current-browser`, `current-server`, the installed
legacy definition, and the running legacy process unchanged. Do not continue with a mismatched or
missing candidate.

## 1. Record and stop the legacy process

Keep one operator shell open for the complete cutover and initialise its paths before any service
change:

```bash
HANDMARK_REPO=/Users/cortex/Development/handmark.io
HANDMARK_SOURCE=/Users/cortex/Development/handmark.io/data/applications.jsonl
HANDMARK_TARGET=/Users/cortex/Development/handmark.io/data/handmark.sqlite
HANDMARK_EVIDENCE=/Users/cortex/Development/handmark.io/.run/application-cutover
HANDMARK_ROLLBACK_DIR="$HANDMARK_EVIDENCE/launchd-rollback"
HANDMARK_INSTALLED_PLIST=/Library/LaunchDaemons/com.handmark.server.plist
HANDMARK_LEGACY_ROLLBACK_PLIST="$HANDMARK_ROLLBACK_DIR/com.handmark.server.legacy.plist"
HANDMARK_TARGET_ROLLBACK_PLIST="$HANDMARK_ROLLBACK_DIR/com.handmark.server.target.plist"

/usr/bin/install -d -m 0700 "$HANDMARK_EVIDENCE"
sudo /usr/bin/install -d -o root -g wheel -m 0700 "$HANDMARK_ROLLBACK_DIR"
```

Require both rollback destinations to be absent. Record the current PID, command, listener, local
health response, selected browser build, and the installed plist's `lstat`, mode, owner, link count,
and SHA-256. Prove that the installed definition is a root-owned, non-symlink, single-link regular
file before treating it as rollback material. Then stop the system daemon through the normal system
launchd domain:

```bash
sudo launchctl bootout system/com.handmark.server
```

Require the exact absent-job status; any other status is a blocker, including a loaded-but-stopped
job or an inspection failure:

```bash
set +e
sudo /bin/launchctl print system/com.handmark.server >/dev/null 2>&1
HANDMARK_LAUNCHCTL_STATUS=$?
set -e
if [[ "$HANDMARK_LAUNCHCTL_STATUS" -ne 113 ]]; then
  echo "Handmark is not proven absent from the system launchd domain" >&2
  exit 1
fi
```

Verify that port `3000` has no listener and that the recorded live legacy command
`node server/index.mjs` is no longer running. This filename is intentional operational evidence,
not the target entrypoint. If either remains, stop and resolve the service state; do not import
around a live writer. Finally, remove the legacy definition from the live LaunchDaemon directory
without destroying it:

```bash
if [[ ! -e "$HANDMARK_INSTALLED_PLIST" || -e "$HANDMARK_LEGACY_ROLLBACK_PLIST" ]]; then
  echo "Legacy LaunchDaemon rollback paths are not in the required state" >&2
  exit 1
fi
sudo /bin/mv "$HANDMARK_INSTALLED_PLIST" "$HANDMARK_LEGACY_ROLLBACK_PLIST"
sudo /bin/chmod 0600 "$HANDMARK_LEGACY_ROLLBACK_PLIST"
if [[ -e "$HANDMARK_INSTALLED_PLIST" ]]; then
  echo "Legacy LaunchDaemon definition is still installed" >&2
  exit 1
fi
```

Re-record the moved file's identity and SHA-256 and match them to the pre-stop proof. The paired
operator must see both exact launchd status `113` and an absent conventional installed plist before
it may select the already prepared candidates.

## 2. Capture the immutable source proof

Reuse the absolute paths from step 1. Record the source's `lstat` identity, mode, link
count, size, timestamps, and SHA-256 without printing application content. Confirm that the source
is one regular, single-link file contained inside the operational root and that every parent from
the root to `data/` is one real, non-symlink directory whose identity remains stable through the
proof. Confirm that the target and all of these paths are absent:

```text
data/handmark.sqlite
data/handmark.sqlite-journal
data/handmark.sqlite-shm
data/handmark.sqlite-wal
```

Any unexpected target or importer-owned staging directory is evidence to investigate, not cleanup
permission. For this target, the owned recovery namespace is:

```text
data/.handmark.sqlite.import-stage
```

Only the importer may recover or remove that directory, and only after its private directory,
durable marker, stopped owner, source, target name, parent, and database inode all match the current
operation. Unknown entries or identities are preserved as conflicts.

## 3. Build and run the offline import

Build the final compiled server, then invoke only the compiled importer with explicit paths:

```bash
corepack pnpm build:server
node server/dist/import-applications.js \
  --source "$HANDMARK_SOURCE" \
  --database "$HANDMARK_TARGET"
```

Run this stopped-service migration as the documented offline Node command. Do not add Node's
`--permission` flag: that sandbox disables the filesystem `fsync` API required by the importer's
crash-safe staging and publication protocol. The sealed permission model belongs to the ordinary
long-running server artifact, not this one-time migration process.

Capture the receipt JSON. It binds the source byte count and SHA-256 to the record count and ordered
canonical-record hash. The importer validates the whole bounded source before creating a database,
commits every row and the receipt together, reopens and pins the result, and proves schema,
integrity, IDs, explicit intake sequence, timestamps, canonical BLOB bytes, projections, and hashes
before it returns. It builds in a private identity-proven staging namespace, checks every target
SQLite sidecar before and after publication, and retains ambiguous crash residue as evidence
instead of guessing ownership.

Run the same command a second time. Exact replay must return the same receipt without changing the
source or target. A different result, sidecar, changed inode, residue, or conflict blocks cutover.
If a prior invocation was interrupted, rerun the exact command only after reviewing the preserved
paths; the importer either proves and completes its own durable operation or fails with a recovery
conflict. Do not manually "finish" a link window or delete a marker.

## 4. Prove backup and restore outside production

Use an ownership-proven disposable root and the shared server-ops SQLite-online snapshot path.
Extract the snapshot into a second disposable location, open the restored database read-only, and
run the same schema/integrity/receipt/row/hash proof against it. Record:

- source proof and importer receipt;
- imported target identity, mode, size, and digest;
- backup archive identity and digest;
- restored database identity and digest;
- exact row count and ordered canonical-record hash;
- commands, exit codes, cleanup result, and closed test ports.

Only after this proof passes may the real Handmark registry replace its legacy data-directory
declaration with the required `sqlite-online` database entry. Run the shared backup flow again from
the real declaration and verify its extracted restore before enabling intake.

## 5. Select and start the compiled pair

The legacy plist captured in step 1 must remain byte-exact in rollback storage. Before selection,
validate that the separately tracked `launchd/com.handmark.server.target.plist` points to:

```text
.run/site-releases/server/current-server/artifact/server/dist/index.js
```

It must also name the matching `current-server/server-release.json`, keep `HOST=127.0.0.1`,
`PORT=3000`, `NODE_ENV=production`, `APP_BASE_URL=https://handmark.io`, and the canonical non-secret
data paths. Provision one owner-controlled mode-`0600` `.env.web` regular file in the operational
root containing only `HANDMARK_PASSWORD` and `SESSION_SECRET`. The compiled target loads no other
private keys and never reads legacy `.env` as a fallback.

The still-selected MJS daemon continues to load operational `.env` until this cutover is authorised
and completed. Preserve that file unchanged as rollback state through the documented rollback
window; it is not the target template or a second source for the compiled server.

Use the recorded browser and server candidate IDs from step 0. Preview the pair, then apply the
offline selection while the Handmark role and conventional installed plist remain absent:

```bash
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark \
  --browser-release-id <browser-id> \
  --server-release-id <server-id> \
  --verify-path /
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark \
  --browser-release-id <browser-id> \
  --server-release-id <server-id> \
  --verify-path / \
  --apply
```

Record the returned cutover ID. Selection changes both pointers under one durable recovery journal;
it does not install or start a service. Do not use standalone browser or server publication for
this migration.

After the legacy role is stopped/unloaded, its installed definition is absent, the data/restore
proof is recorded, and server-ops has selected the paired candidates, run
`bin/install-server-daemon --apply`. The installer re-proves the selected identity and entrypoint,
the owned mode-`0600` `.env.web` and database, and exact target plist before delegating the sole
write to the shared server-ops LaunchDaemon-definition transaction. It never bootouts, bootstraps,
kickstarts, loads, or restarts Handmark. Treat any pre-existing different definition as a blocker;
do not overwrite around it. Run the installer directly as `cortex`, never through `sudo`; the
shared server-release status authenticates the complete selected release in the expected offline
state. The wrapper then validates a private staged copy of the target plist so concurrent checkout
edits cannot change its semantics between product validation and the shared writer's exact source
snapshot. The definition writer requests only its narrow privileged filesystem transaction itself.

The server accepts only exact `NODE_ENV` values `development`, `test`, and `production`; this
operational launch uses `production`. Isolated release validation also uses `production` but is
distinguished by its framework-owned validation flag.

Before the server binds, its startup interlock proves the existing selected database has the sealed
legacy import receipt whether or not `data/applications.jsonl` still exists. While the source
remains, it pins the file and its parent-directory chain, matches the receipt to the exact source
bytes/hash, and proves the complete path and file did not change during that check. A missing
database, missing or mismatched receipt, unsafe or escaping path, linked/replaced parent, unsafe
database artifact, or changed source must exit nonzero without listening or creating a production
replacement.

Receipt preflight opens the pinned main database through immutable read-only SQLite, which cannot
create WAL/SHM. Before writable open, the process descriptor-pins and identity-checks the contained,
mode-`0600`, single-link main database, every required rollback-journal reservation, and WAL/SHM
paths across every startup checkpoint; a clean WAL database proves its unused rollback-journal
path stays absent. Existing WAL/SHM recovery files remain on their original inodes for SQLite
recovery. Once writable open succeeds, the process re-proves the sealed receipt before
any configuration, migration, or storage mutation; main/sidecar identities and the directory chain
then remain pinned through runtime checks. The initial retention pass runs only after the HTTP
listener binds. A bind failure such as `EADDRINUSE` must leave every application row and the sealed
receipt unchanged.

After the definition-only installer succeeds, separately bootstrap the authorised LaunchDaemon and
verify, in order:

1. exact local `/healthz` (`app: handmark`) and `/cx-server.json` identity;
2. selected and running server-release identity match;
3. selected and served `/cx-build.json` identity match;
4. locked `/`, branded `/login`, wrong-password behavior, and selective public assets;
5. nginx-local routing for both hostnames;
6. external HTTPS for both hostnames;
7. shared backup and extracted restore after startup.

Do not submit a synthetic application to the real review queue merely as a health probe.

Preview and apply paired finalization only after all seven checks pass:

```bash
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --status --cutover-id <cutover-id>
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --finalize --cutover-id <cutover-id> --verify-path /
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --finalize --cutover-id <cutover-id> --verify-path / --apply
```

Until finalization succeeds, the open journal blocks every standalone release mutation and prune.

## 6. Rollback decision

If selection succeeded but finalization did not, stop and boot out the target service, remove its
installed definition to reviewed rollback storage, prove exact role/plist absence, and use the
paired abort preview/apply flow:

```bash
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --abort --cutover-id <cutover-id>
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --abort --cutover-id <cutover-id> --apply
```

If the cutover was finalized, use the paired revert preview/apply flow under the same offline proof:

```bash
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --revert --cutover-id <completed-cutover-id>
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --revert --cutover-id <completed-cutover-id> --apply
```

This first-cutover revert restores the recorded prior browser pointer and an unselected server
state; restore the byte-exact legacy plist separately, restart the legacy daemon, and verify that
the source still matches its captured proof. Never run independent browser and server rollbacks.

After any new SQLite intake, the legacy JSONL writer is no longer a safe rollback target. Stop the
new server, compare the database with the import receipt, and keep intake offline. Fix forward from
SQLite or use a separately reviewed lossless reverse migration; never resume JSONL and lose the new
row.

## 7. Preserve evidence without creating a fallback

The cutover run does not delete the original JSONL. Keep it access-restricted and read-only as
migration/rollback evidence. While retained at `data/applications.jsonl`, it is also the target
runtime's startup integrity witness: the process opens and hashes it to match the sealed receipt,
but never uses it as the application store, fallback, request-time reader, or dual-write target.
Record a separate owner-approved retention decision that reconciles evidence needs with Handmark's
90-day application policy; do not silently retain operational PII forever and do not delete the
only migration evidence during cutover. If that later decision authorises removal, every ordinary
production startup still requires the durable sealed receipt; absence of the source does not turn
the selected database into an unproven fresh store.

Operational cutover completion requires the final source proof, both receipts, database parity,
extracted restore, release identity, health, backup, and public verification evidence in the
architecture migration ledger. The source-only architecture phase records these as explicitly
deferred entry gates; it does not perform or claim them.
