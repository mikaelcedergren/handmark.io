# Application storage cutover

Status: **maintenance boundary entered; data cutover not run**. The authorised 2026-08-28
maintenance batch already unloaded `com.handmark.server`, removed its conventional installed
plist, and proved launchd status `113` with port `3000` closed. It did not inspect the operational
queue, create `handmark.sqlite`, import data, change the backup registry, select a release, install
the target definition, or start the compiled server. The deleted installed plist was not captured
byte-for-byte. The tracked historical legacy template remains a reviewed recovery input, but it is
not evidence of the deleted installed file's exact bytes. Never describe it as such.

This procedure resumes from that honest stopped state and moves the legacy queue authority to the
compiled server. Source completion alone does not perform any remaining operational step.

The shared release, backup, health, and rollback contracts are owned by
[`SERVER-STANDARD.md`](../../SERVER-STANDARD.md). This file owns only the Handmark data cutover.

## Non-negotiable rules

- Keep the legacy daemon absent before inspecting or importing its JSONL file. The old writer has no
  migration lock, so an online copy cannot be proven complete. Its already-proved stopped state is
  the boundary; do not recreate or briefly start it merely to repeat an earlier step.
- Select exactly one sealed authority after the legacy daemon is stopped: the exact existing JSONL,
  or explicit absence when the successfully initialised legacy service has an honestly empty
  queue. A zero-byte file is still JSONL authority. Empty-absence authority never creates, moves,
  deletes, or substitutes a JSONL file. There is no dual write, fallback, compatibility reader,
  skipped row, repair mode, or partial import.
- When JSONL authority exists, keep its bytes unchanged and read-only. The importer repeatedly
  proves its inode, metadata, complete digest, and bytes while it runs. After cutover, while it
  remains at `data/applications.jsonl`, the target opens and hashes it during startup as an
  integrity witness; it is never the application store, a request-time reader, fallback, or
  dual-write target. Empty-absence mode instead pins the source parent and repeatedly proves the
  named path remains absent.
- Ordinary production startup always requires an existing selected SQLite database containing the
  one sealed legacy import receipt and matching authority kind. JSONL authority requires the source
  to remain present with an exact byte-count/SHA-256 match; deleting or moving it fails startup.
  Empty-absence authority requires the source to remain absent. Absence cannot prove that JSONL
  evidence was intentionally retired, so any future removal requires an explicit schema migration
  that durably records the approval before the file is removed. The source or its absence and
  complete parent chain must remain contained, real, non-symlinked, and identity-stable inside the
  operational root. These checks happen before retention, intake, or listening.
  Development and isolated release validation are exempt so owned synthetic roots may create fresh
  databases; they never establish operational cutover proof. Never bypass the production interlock
  by moving the source, fabricating an empty file, creating an empty database, or changing
  `DATA_DIR`.
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
- A pre-existing database, SQLite sidecar, ambiguous staging residue, changed/appearing source, or
  failed parity proof blocks cutover. Do not delete or rename conflicting evidence to make the
  import pass.
- Importer, replay, and semantic verification must execute from the exact sealed inactive server
  candidate prepared for this cutover. The mutable checkout and `server/dist` are never migration
  authority after that candidate is sealed.
- JSONL authority remains a required startup witness until a later explicit schema migration retires
  it. Before replacing the directory backup with SQLite-only backup, JSONL mode therefore requires
  a separately reviewed durable private archive containing the exact raw witness bytes and an
  extraction/digest proof. The current shared registry has no single-file snapshot method, and the
  one-database SQLite proof does not archive that witness. A receipt, an expiring routine archive,
  or an improvised copy is not a substitute. Empty-absence authority has no raw witness bytes and
  is not blocked by this conditional requirement.
- Do not resume the legacy writer after the new server has accepted a SQLite application. That
  would fork the review queue.
- Every `sudo`, service, registry, release-selection, backup, and public verification action below
  requires separate operational authorisation. Source completion is not that authorisation.

## Entry gates

Items 1–3 and 8 are source/release gates. Item 4 records the already-stopped authority. Items 5–7
run in order after that classification and before either compiled candidate is selected.

1. The required cx-framework version is published, both real Handmark dependency locks resolve that
   published GitHub commit, and a clean frozen install passes.
2. `pnpm check` and `pnpm e2e` pass from the final source.
3. A physical server artifact passes isolated identity, health, network, filesystem, dependency,
   shutdown, and deterministic-digest checks.
4. The stopped legacy authority has been classified. An existing operational JSONL fits the
   importer's explicit source, record, and per-record bounds: 100 MiB, 10,000 records, and 512 KiB
   per record. If it is absent, the recorded pre-stop health/initialisation evidence plus stable
   post-stop absence prove the legacy queue was honestly empty; uncertainty is a blocker. A bound
   or authority failure requires a reviewed migration design and is never split, truncated, or
   replaced with a fabricated file.
5. Import and exact replay run from the sealed server candidate. The candidate's immutable verifier
   reproduces the captured receipt from the published target without mutation.
6. The shared one-database proof previews and applies a disposable `sqlite-online` snapshot outside
   the operational root, safely extracts it, and the sealed product verifier reproduces the receipt
   from that restored database. In JSONL mode, the separately reviewed durable raw-witness archive
   described above also exists and has passed extraction/digest proof.
7. Only then does the canonical registry replace Handmark's legacy directory snapshot with the
   required `sqlite-online` declaration. Cleanup and backup are installed from that exact reviewed
   configuration; an authenticated preview and applied backup from the selected immutable system-job
   release, safe whole-bundle extraction, and product-owned restored-database proof reproduce the
   captured receipt exactly.
8. The new server release, launchd change, backup declaration, and recovery commands have been
   reviewed together. Automatic byte-exact legacy-plist rollback is unavailable because the
   previously installed file was deleted without capture; no step may claim otherwise.

## 0. Prepare the source-identical candidates

The retained Handmark server candidate prepared before the immutable verifier existed is historical
and must not be selected. From the final reviewed source state, use the canonical paired preparation
flow in [`server-ops/README.md`](../../server-ops/README.md#cut-over-a-browser-and-server-pair) to
prepare one inactive Handmark browser candidate and one inactive Handmark server candidate. Use
explicit, recorded release IDs:

```bash
node ../server-ops/bin/site-release.mjs \
  --site handmark --prepare-only --release-id '<browser-id>'
node ../server-ops/bin/site-release.mjs \
  --site handmark --prepare-only --release-id '<browser-id>' --apply
node ../server-ops/bin/server-release.mjs \
  --site handmark --prepare-only --release-id '<server-id>'
node ../server-ops/bin/server-release.mjs \
  --site handmark --prepare-only --release-id '<server-id>' --apply
```

Record both identities and prove their revision, source fingerprint, and dirty-state flag are
identical. Inspect the sealed server artifact and require both
`server/dist/import-applications.js` and `server/dist/verify-application-import.js`. Candidate
preparation must leave `current-browser`, `current-server`, the absent Handmark role, and the absent
conventional plist unchanged. Do not continue with a mismatched, incomplete, or unsealed candidate.

## 1. Re-prove the already-stopped boundary

Keep one operator shell open for the complete cutover. Substitute the exact IDs retained in step 0,
then initialise and freeze every authority path before inspecting operational state:

```bash
HANDMARK_REPO=/Users/cortex/Development/handmark.io
HANDMARK_OPERATIONAL_ROOT="$HANDMARK_REPO"
HANDMARK_DATA="$HANDMARK_REPO/data"
HANDMARK_SOURCE=/Users/cortex/Development/handmark.io/data/applications.jsonl
HANDMARK_TARGET=/Users/cortex/Development/handmark.io/data/handmark.sqlite
HANDMARK_EVIDENCE=/Users/cortex/Development/.run/web-architecture-migration/handmark
HANDMARK_IMPORT_RECEIPT="$HANDMARK_EVIDENCE/import-receipt.json"
HANDMARK_REPLAY_RECEIPT="$HANDMARK_EVIDENCE/import-replay-receipt.json"
HANDMARK_TARGET_VERIFY_RECEIPT="$HANDMARK_EVIDENCE/import-target-verified-receipt.json"
HANDMARK_DISPOSABLE_VERIFY_RECEIPT="$HANDMARK_EVIDENCE/import-disposable-restored-verified-receipt.json"
HANDMARK_RESTORED_VERIFY_RECEIPT="$HANDMARK_EVIDENCE/import-restored-verified-receipt.json"
HANDMARK_SQLITE_PROOF_PREVIEW="$HANDMARK_EVIDENCE/sqlite-proof-preview.txt"
HANDMARK_SQLITE_PROOF_APPLY="$HANDMARK_EVIDENCE/sqlite-proof-apply.json"
HANDMARK_SELECTED_BACKUP_PREVIEW="$HANDMARK_EVIDENCE/selected-backup-preview.txt"
HANDMARK_SELECTED_BACKUP_APPLY="$HANDMARK_EVIDENCE/selected-backup-apply.txt"
HANDMARK_EXTRACTION_PREVIEW="$HANDMARK_EVIDENCE/backup-extraction-preview.txt"
HANDMARK_EXTRACTION_APPLY="$HANDMARK_EVIDENCE/backup-extraction-apply.json"
HANDMARK_INSTALLED_PLIST=/Library/LaunchDaemons/com.handmark.server.plist
HANDMARK_CANDIDATE_RUNNER=/Users/cortex/Development/server-ops/bin/server-candidate-tool.mjs
HANDMARK_BROWSER_RELEASE_ID='<exact-browser-id-from-step-0>'
HANDMARK_SERVER_RELEASE_ID='<exact-server-id-from-step-0>'

/usr/bin/install -d -m 0700 "$HANDMARK_EVIDENCE"
if [[ ! -d "$HANDMARK_EVIDENCE" || -L "$HANDMARK_EVIDENCE" ]]; then
  echo "Handmark evidence root is not a real directory" >&2
  exit 1
fi
readonly HANDMARK_REPO HANDMARK_OPERATIONAL_ROOT HANDMARK_DATA HANDMARK_SOURCE HANDMARK_TARGET
readonly HANDMARK_EVIDENCE HANDMARK_IMPORT_RECEIPT HANDMARK_REPLAY_RECEIPT
readonly HANDMARK_TARGET_VERIFY_RECEIPT HANDMARK_DISPOSABLE_VERIFY_RECEIPT
readonly HANDMARK_RESTORED_VERIFY_RECEIPT HANDMARK_SQLITE_PROOF_PREVIEW
readonly HANDMARK_SQLITE_PROOF_APPLY HANDMARK_SELECTED_BACKUP_PREVIEW
readonly HANDMARK_SELECTED_BACKUP_APPLY HANDMARK_EXTRACTION_PREVIEW HANDMARK_EXTRACTION_APPLY
readonly HANDMARK_INSTALLED_PLIST HANDMARK_CANDIDATE_RUNNER
readonly HANDMARK_BROWSER_RELEASE_ID HANDMARK_SERVER_RELEASE_ID
```

Require the evidence root itself to be canonical, current-user-owned, and exact mode `0700`. Its
bounded initial inventory must be empty or contain only separately identified earlier migration
evidence; any unknown entry is a blocker. Every output named below is an exclusive no-replace
target, never a log file to truncate or reuse.

The migration ledger owns the earlier pre-stop PID, command, listener, health, and service evidence.
Do not recreate the old service to manufacture a fresh sample. Re-prove its exact absence now; any
other status is a blocker, including a loaded-but-stopped job or an inspection failure:

```bash
set +e
/bin/launchctl print system/com.handmark.server >/dev/null 2>&1
HANDMARK_LAUNCHCTL_STATUS=$?
set -e
if [[ "$HANDMARK_LAUNCHCTL_STATUS" -ne 113 ]]; then
  echo "Handmark is not proven absent from the system launchd domain" >&2
  exit 1
fi
if [[ -e "$HANDMARK_INSTALLED_PLIST" || -L "$HANDMARK_INSTALLED_PLIST" ]]; then
  echo "Handmark conventional LaunchDaemon definition unexpectedly exists" >&2
  exit 1
fi
if /usr/sbin/lsof -nP -iTCP:3000 -sTCP:LISTEN | /usr/bin/grep -q .; then
  echo "Handmark port 3000 still has a listener" >&2
  exit 1
fi
```

Also prove the recorded legacy command `node server/index.mjs` is absent without printing unrelated
process environments. This filename is intentional historical evidence, not the target entrypoint.

The authorised stop removed the installed plist instead of preserving it. Record that fact. Record
the tracked historical template's Git identity, size, and SHA-256 as a recovery input, but never call
it an installed-byte rollback copy. The paired operator must see exact launchd status `113`, a closed
port, and an absent conventional installed plist again immediately before selection.

## 2. Select and capture the sealed authority

Reuse the absolute paths from step 1. First record the operational root and `data/` directory
`lstat` identities, owners, and modes. Both must already exist as current-user-owned real
directories, and their canonical paths must equal the paths above. Do not change either directory
manually to make a check pass.

Select exactly one of these mutually exclusive authorities and record the selection as
`HANDMARK_IMPORT_AUTHORITY`. The importer requires the exact `applications.jsonl` path directly
beside `handmark.sqlite`; another filename or directory is not valid authority.

- `jsonl`: `HANDMARK_SOURCE` exists as one regular, single-link file. Record its `lstat` identity,
  mode, link count, size, timestamps, and SHA-256 without printing application content. Confirm
  every parent from the operational root to `data/` is real, non-symlinked, and identity-stable.
- `empty-absence`: `HANDMARK_SOURCE` is absent. This is valid only when the pre-stop health record
  proves the legacy service successfully initialised and the stopped writer's contract therefore
  makes an absent file equivalent to a zero-record queue. Record two stable `ENOENT` observations
  around an unchanged parent-chain proof and an explicit operator statement that the queue is
  empty. Do not select this mode if the file may have been deleted, moved, expired unexpectedly, or
  was never covered by a successful legacy initialisation. Do not create an empty JSONL. A present
  zero-byte file selects `jsonl`, not `empty-absence`.

Set and freeze the exact recorded value in the operator shell:

```bash
# Choose exactly one after completing the matching proof above.
HANDMARK_IMPORT_AUTHORITY=jsonl
# HANDMARK_IMPORT_AUTHORITY=empty-absence
readonly HANDMARK_IMPORT_AUTHORITY

case "$HANDMARK_IMPORT_AUTHORITY" in
  jsonl|empty-absence) ;;
  *) echo "Handmark import authority is not explicitly selected" >&2; exit 1 ;;
esac
```

For either authority, confirm that the target and all of these paths, including every
case-insensitive spelling of each SQLite sidecar name, are absent:

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

The importer will descriptor-pin the operational root and every descendant through the target
database directory. It never changes the operational root. Each required descendant must already
grant owner read, write, and execute permission; the importer may only narrow that directory's
group/other/special bits to exact mode `0700` through its open descriptor. It fails rather than
widening owner permissions. This expected, recorded `data/` permission narrowing happens before
staging or publication and is re-proven throughout the operation; unrelated ancestry is not
altered.

## 3. Run the sealed offline import

Do not rebuild after step 0. The importer and verifier used for operational evidence must execute
through the shared authenticated candidate-tool runner. Its preview and apply both require the
exact inactive candidate to match the current Git-visible source, re-prove the service family and
conventional plist absent, authenticate the sealed entrypoint, bind every declared path, and use a
sterile environment. The mutable checkout and its `server/dist` output are never migration
authority and must never be invoked directly.

All five receipt paths and every later evidence-output path from step 1 must be absent before this
begins. A present path is earlier evidence to review, not a file to overwrite:

```bash
for HANDMARK_EVIDENCE_PATH in \
  "$HANDMARK_IMPORT_RECEIPT" \
  "$HANDMARK_REPLAY_RECEIPT" \
  "$HANDMARK_TARGET_VERIFY_RECEIPT" \
  "$HANDMARK_DISPOSABLE_VERIFY_RECEIPT" \
  "$HANDMARK_RESTORED_VERIFY_RECEIPT" \
  "$HANDMARK_SQLITE_PROOF_PREVIEW" \
  "$HANDMARK_SQLITE_PROOF_APPLY" \
  "$HANDMARK_SELECTED_BACKUP_PREVIEW" \
  "$HANDMARK_SELECTED_BACKUP_APPLY" \
  "$HANDMARK_EXTRACTION_PREVIEW" \
  "$HANDMARK_EXTRACTION_APPLY"; do
  if [[ -e "$HANDMARK_EVIDENCE_PATH" || -L "$HANDMARK_EVIDENCE_PATH" ]]; then
    echo "Handmark cutover evidence path already exists" >&2
    exit 1
  fi
done

case "$HANDMARK_IMPORT_AUTHORITY" in
  jsonl) HANDMARK_IMPORT_TOOL=import-applications ;;
  empty-absence) HANDMARK_IMPORT_TOOL=import-empty-applications ;;
esac
readonly HANDMARK_IMPORT_TOOL

preview_handmark_import() {
  node "$HANDMARK_CANDIDATE_RUNNER" \
    --site handmark \
    --release-id "$HANDMARK_SERVER_RELEASE_ID" \
    --tool "$HANDMARK_IMPORT_TOOL" \
    --evidence-root "$HANDMARK_EVIDENCE" \
    --output "$1" \
    --path "operational-root=$HANDMARK_OPERATIONAL_ROOT" \
    --path "source=$HANDMARK_SOURCE" \
    --path "database=$HANDMARK_TARGET"
}

apply_handmark_import() {
  node "$HANDMARK_CANDIDATE_RUNNER" \
    --site handmark \
    --release-id "$HANDMARK_SERVER_RELEASE_ID" \
    --tool "$HANDMARK_IMPORT_TOOL" \
    --evidence-root "$HANDMARK_EVIDENCE" \
    --output "$1" \
    --path "operational-root=$HANDMARK_OPERATIONAL_ROOT" \
    --path "source=$HANDMARK_SOURCE" \
    --path "database=$HANDMARK_TARGET" \
    --expected-identity "$2" \
    --apply
}

preview_handmark_verify() {
  node "$HANDMARK_CANDIDATE_RUNNER" \
    --site handmark \
    --release-id "$HANDMARK_SERVER_RELEASE_ID" \
    --tool verify-application-import \
    --evidence-root "$HANDMARK_EVIDENCE" \
    --output "$2" \
    --path "database=$1" \
    --path "receipt=$HANDMARK_IMPORT_RECEIPT"
}

apply_handmark_verify() {
  node "$HANDMARK_CANDIDATE_RUNNER" \
    --site handmark \
    --release-id "$HANDMARK_SERVER_RELEASE_ID" \
    --tool verify-application-import \
    --evidence-root "$HANDMARK_EVIDENCE" \
    --output "$2" \
    --path "database=$1" \
    --path "receipt=$HANDMARK_IMPORT_RECEIPT" \
    --expected-identity "$3" \
    --apply
}

preview_handmark_import "$HANDMARK_IMPORT_RECEIPT"
HANDMARK_IMPORT_TOOL_IDENTITY='<exact-identity-from-preview>'
readonly HANDMARK_IMPORT_TOOL_IDENTITY
apply_handmark_import "$HANDMARK_IMPORT_RECEIPT" "$HANDMARK_IMPORT_TOOL_IDENTITY"
```

Each preview must return `{operation,state:"preview",identity,receipt}`. Review and copy its exact
`identity`; apply repeats every argument and adds only that expected identity plus `--apply`. Apply
must return `{operation,state:"applied",result}`, whose candidate/source facts still match step 0
and whose `result.output` gives the exact new receipt path, byte count, and SHA-256. The output file
itself is the candidate tool's canonical single-line JSON evidence, created exclusively at mode
`0600`; wrapper stdout is not the receipt.

Run this stopped-service migration as the documented offline Node command. Do not add Node's
`--permission` flag: that sandbox disables the filesystem `fsync` API required by the importer's
crash-safe staging and publication protocol. The sealed permission model belongs to the ordinary
long-running server artifact, not this one-time migration process.

Capture the receipt JSON. It seals `authorityKind` as either `legacy_jsonl_v1` or
`legacy_empty_absence_v1`. JSONL authority binds the exact source byte count and SHA-256 to the
record count and ordered canonical-record hash. Empty-absence authority has canonical
domain-separated empty evidence and exactly zero records; it is not the digest of a fabricated
file. The importer commits every row, receipt, and authority together, reopens and pins the result,
and proves schema, integrity, IDs, explicit intake sequence, timestamps, canonical BLOB bytes,
projections, and hashes before it returns. It builds in a private identity-proven staging
namespace, checks every case-insensitive target SQLite sidecar name before and after publication,
and retains ambiguous crash residue as evidence instead of guessing ownership. Every directory
inventory is bounded by count and total encoded filename bytes.

After the first successful run, prove the operational root has the same identity, owner, and mode
recorded in step 2. Prove `data/` has the same identity and owner and now has exact mode `0700`.
Any other ancestry or ownership change blocks cutover.

Run a new preview and applied invocation for exact replay, with its own output path and reviewed
identity. The candidate runner must return state `applied` and report the exact output path, byte
count, and SHA-256. Exact replay must return the same receipt bytes without changing the
source/absence or target. Then preview and apply the same candidate's immutable verifier against
the published target and first captured receipt:

```bash
preview_handmark_import "$HANDMARK_REPLAY_RECEIPT"
HANDMARK_REPLAY_TOOL_IDENTITY='<exact-identity-from-preview>'
readonly HANDMARK_REPLAY_TOOL_IDENTITY
apply_handmark_import "$HANDMARK_REPLAY_RECEIPT" "$HANDMARK_REPLAY_TOOL_IDENTITY"
/usr/bin/cmp -s "$HANDMARK_IMPORT_RECEIPT" "$HANDMARK_REPLAY_RECEIPT"

preview_handmark_verify "$HANDMARK_TARGET" "$HANDMARK_TARGET_VERIFY_RECEIPT"
HANDMARK_TARGET_VERIFY_TOOL_IDENTITY='<exact-identity-from-preview>'
readonly HANDMARK_TARGET_VERIFY_TOOL_IDENTITY
apply_handmark_verify \
  "$HANDMARK_TARGET" \
  "$HANDMARK_TARGET_VERIFY_RECEIPT" \
  "$HANDMARK_TARGET_VERIFY_TOOL_IDENTITY"
/usr/bin/cmp -s "$HANDMARK_IMPORT_RECEIPT" "$HANDMARK_TARGET_VERIFY_RECEIPT"
```

The verifier never reads the JSONL file and never exposes application content. It opens only the
explicit mode-`0600`, current-user-owned, single-link database through a descriptor-pinned immutable
read-only SQLite connection; requires its canonical immediate parent to remain an owned mode-`0700`
real directory; rejects every case-insensitive SQLite sidecar name; verifies the exact schema,
migration ledger, integrity, foreign keys, sealed receipt, and authority; and keeps each bounded
canonical BLOB internal while recomputing projections, sequence, row hashes, and the ordered
aggregate. Its only successful output is the receipt, and its errors contain structural facts
rather than record values. Record database identity, mode, size, SHA-256, bounded parent inventory,
and sidecar absence before and after and require exact equality.

Never switch authority modes between attempts. A different receipt, sidecar, changed inode or
digest, changed parent inventory, residue, or conflict blocks cutover. If a prior invocation was
interrupted, rerun the exact sealed command only after reviewing the preserved paths; the importer
either proves and completes its own durable operation or fails with a recovery conflict. Do not
manually finish a link window or delete a marker.

## 4. Prove a disposable SQLite snapshot before registry change

This proof must pass while the current canonical registry is still unchanged and
`release.server.firstSelectionGate` remains blocked. The evidence root from step 1 is outside the
operational root and must remain a canonical, current-user-owned, mode-`0700` directory. Define one
missing child as the proof root, preview the exact plan, and apply only the identity returned by
that preview:

```bash
HANDMARK_SQLITE_PROOF_ROOT="$HANDMARK_EVIDENCE/sqlite-proof"
HANDMARK_DISPOSABLE_RESTORED_DATABASE="$HANDMARK_SQLITE_PROOF_ROOT/restored/products/handmark/handmark.sqlite"
readonly HANDMARK_SQLITE_PROOF_ROOT HANDMARK_DISPOSABLE_RESTORED_DATABASE

if [[ -e "$HANDMARK_SQLITE_PROOF_ROOT" || -L "$HANDMARK_SQLITE_PROOF_ROOT" ]]; then
  echo "Handmark disposable SQLite proof root already exists" >&2
  exit 1
fi

(umask 077; set -C; node /Users/cortex/Development/server-ops/bin/sqlite-backup-proof.mjs \
  --operational-root "$HANDMARK_OPERATIONAL_ROOT" \
  --database "$HANDMARK_TARGET" \
  --proof-root "$HANDMARK_SQLITE_PROOF_ROOT" \
  --site handmark \
  --storage database \
  --archive-path products/handmark/handmark.sqlite \
  >"$HANDMARK_SQLITE_PROOF_PREVIEW")

HANDMARK_SQLITE_PROOF_PLAN_IDENTITY='<exact-planIdentity-from-preview>'
readonly HANDMARK_SQLITE_PROOF_PLAN_IDENTITY

(umask 077; set -C; node /Users/cortex/Development/server-ops/bin/sqlite-backup-proof.mjs \
  --operational-root "$HANDMARK_OPERATIONAL_ROOT" \
  --database "$HANDMARK_TARGET" \
  --proof-root "$HANDMARK_SQLITE_PROOF_ROOT" \
  --site handmark \
  --storage database \
  --archive-path products/handmark/handmark.sqlite \
  --expected-plan-identity "$HANDMARK_SQLITE_PROOF_PLAN_IDENTITY" \
  --apply \
  >"$HANDMARK_SQLITE_PROOF_APPLY")
```

The preview must report operation `sqlite-backup-proof`, state `preview`, the exact operational
root, database, archive path, proof root, and a `planIdentity`. Apply must report state `verified`,
the archive path, size, SHA-256, identity, restored database, and exactly equal schema-v2
`snapshotReceipt` and `restoreReceipt` values. Keep the complete proof root as evidence. A stale
identity, pre-existing proof root, changed target, unequal receipts, or source/target mutation is a
blocker.

Preview and apply the sealed product verifier on the exact `restoredDatabase` returned by apply,
then require the original receipt byte-for-byte:

```bash
preview_handmark_verify \
  "$HANDMARK_DISPOSABLE_RESTORED_DATABASE" \
  "$HANDMARK_DISPOSABLE_VERIFY_RECEIPT"
HANDMARK_DISPOSABLE_VERIFY_TOOL_IDENTITY='<exact-identity-from-preview>'
readonly HANDMARK_DISPOSABLE_VERIFY_TOOL_IDENTITY
apply_handmark_verify \
  "$HANDMARK_DISPOSABLE_RESTORED_DATABASE" \
  "$HANDMARK_DISPOSABLE_VERIFY_RECEIPT" \
  "$HANDMARK_DISPOSABLE_VERIFY_TOOL_IDENTITY"
/usr/bin/cmp -s "$HANDMARK_IMPORT_RECEIPT" "$HANDMARK_DISPOSABLE_VERIFY_RECEIPT"
```

This one-database proof intentionally contains only the SQLite snapshot and its manifest. If step 2
selected `jsonl`, stop here until a separately reviewed, durable, private product-owned archive of
the exact raw JSONL witness exists and its safe extraction and SHA-256 parity have been recorded.
The archive must be independent of routine retention and must not overlap the SQLite destination.
The current canonical registry has no single-file snapshot method, so neither a receipt, the
SQLite proof, an expiring routine archive, nor an improvised copy satisfies this gate. If step 2
selected `empty-absence`, record that there are no raw witness bytes and continue.

## 5. Activate canonical backup and prove a selected extracted restore

Only after every receipt through step 4 is byte-identical, the imported target remains unchanged,
and the conditional raw-witness gate is satisfied may the reviewed canonical
`/Users/cortex/Development/server-ops/config/sites.json` replace Handmark's existing `data`
directory-snapshot entry. Keep the runtime purge entry, remove the directory snapshot completely,
and add exactly this one product-data declaration; never keep two competing backup authorities:

```json
{
  "id": "database",
  "class": "backup",
  "path": "/Users/cortex/Development/handmark.io/data/handmark.sqlite",
  "required": true,
  "snapshot": "sqlite-online",
  "archivePath": "products/handmark/handmark.sqlite"
}
```

Keep `release.server.firstSelectionGate` in its blocked state during this transition. Run the full
server-ops source gate, then reinstall cleanup and backup together from the reviewed registry. Run
the installer as the ordinary `cortex` user: do not prefix it with `sudo`; the wrapper requests the
administrator password only for its narrow root-owned transaction.

```bash
(cd /Users/cortex/Development/server-ops && corepack pnpm check)
/Users/cortex/Development/server-ops/bin/install-system-jobs
```

A registry edit in the mutable checkout is not backup activation. Manually preview and apply only
through the selected immutable system-job release, capturing both outputs without replacement:

```bash
(umask 077; set -C; /opt/homebrew/bin/node \
  /Users/cortex/Development/server-ops/bin/system-job-launcher.mjs \
  --selected-backup-preview \
  >"$HANDMARK_SELECTED_BACKUP_PREVIEW")

HANDMARK_SELECTED_BACKUP_IDENTITY='<exact-selectionIdentity-from-first-preview-line>'
readonly HANDMARK_SELECTED_BACKUP_IDENTITY

(umask 077; set -C; /opt/homebrew/bin/node \
  /Users/cortex/Development/server-ops/bin/system-job-launcher.mjs \
  --selected-backup-apply \
  --expected-selected-backup-identity "$HANDMARK_SELECTED_BACKUP_IDENTITY" \
  >"$HANDMARK_SELECTED_BACKUP_APPLY")

HANDMARK_BACKUP_ARCHIVE='<exact-final-archive-path-from-applied-output>'
readonly HANDMARK_BACKUP_ARCHIVE
```

The first preview line must report operation `selected-system-job-backup`, state `preview`, and the
exact `releaseDigest` and `selectionIdentity`. Apply must reauthenticate that same release and both
installed cleanup/backup plist identities before the selected sealed `backup-state` process runs
with `--apply`. Require the sealed preview and final archive manifest to name
`handmark:database`, method `sqlite-online`, the canonical source above, and
`products/handmark/handmark.sqlite`. Pin the final archive identity, owner, mode `0600`, single-link
status, size, and SHA-256. Never pair this preview with mutable-checkout `backup-state.mjs --apply`.

Safely preview and extract that exact archive into another missing child of the canonical evidence
root. Do not invoke `tar` directly:

```bash
HANDMARK_RESTORE_ROOT="$HANDMARK_EVIDENCE/selected-backup-extracted"
readonly HANDMARK_RESTORE_ROOT

if [[ -e "$HANDMARK_RESTORE_ROOT" || -L "$HANDMARK_RESTORE_ROOT" ]]; then
  echo "Handmark selected-backup extraction root already exists" >&2
  exit 1
fi

(umask 077; set -C; node /Users/cortex/Development/server-ops/bin/extract-backup-archive.mjs \
  --archive "$HANDMARK_BACKUP_ARCHIVE" \
  --destination "$HANDMARK_RESTORE_ROOT" \
  >"$HANDMARK_EXTRACTION_PREVIEW")

HANDMARK_ARCHIVE_IDENTITY='<exact-archiveIdentity-from-preview>'
readonly HANDMARK_ARCHIVE_IDENTITY

(umask 077; set -C; node /Users/cortex/Development/server-ops/bin/extract-backup-archive.mjs \
  --archive "$HANDMARK_BACKUP_ARCHIVE" \
  --destination "$HANDMARK_RESTORE_ROOT" \
  --expected-archive-identity "$HANDMARK_ARCHIVE_IDENTITY" \
  --apply \
  >"$HANDMARK_EXTRACTION_APPLY")

HANDMARK_RESTORED_DATABASE="$HANDMARK_RESTORE_ROOT/products/handmark/handmark.sqlite"
readonly HANDMARK_RESTORED_DATABASE
```

Preview must report the exact archive path, size, SHA-256, identity, and missing destination. Apply
must retain the extraction and add the successful whole-bundle verification receipt. Require the
canonical restored database and its immediate parent to meet the product verifier's private
ownership, mode, link, and path rules, then preview and apply the same sealed verifier and require
receipt equality:

```bash
preview_handmark_verify "$HANDMARK_RESTORED_DATABASE" "$HANDMARK_RESTORED_VERIFY_RECEIPT"
HANDMARK_RESTORED_VERIFY_TOOL_IDENTITY='<exact-identity-from-preview>'
readonly HANDMARK_RESTORED_VERIFY_TOOL_IDENTITY
apply_handmark_verify \
  "$HANDMARK_RESTORED_DATABASE" \
  "$HANDMARK_RESTORED_VERIFY_RECEIPT" \
  "$HANDMARK_RESTORED_VERIFY_TOOL_IDENTITY"
/usr/bin/cmp -s "$HANDMARK_IMPORT_RECEIPT" "$HANDMARK_RESTORED_VERIFY_RECEIPT"
```

Record the selected authority proof, importer/replay/target/disposable/final restore receipts,
database and archive identities/digests, schema-v2 backup receipts, exact row count and ordered
canonical-record hash, raw-witness evidence when applicable, commands, exit codes, cleanup result,
and closed test ports in `WEB-ARCHITECTURE-MIGRATION.md`. Only then remove the entire
`release.server.firstSelectionGate` object from Handmark's canonical server-ops registry entry; do
not change it to a locally invented `ready` state. Re-run the complete server-ops gate and
`install-system-jobs` command above, then re-prove both loaded jobs and installed authority select
the same final immutable release. Any registry, source-gate, installation, backup, extraction,
whole-bundle, receipt-parity, witness, or non-mutation failure keeps the gate blocked and intake
offline.

## 6. Select and start the compiled pair

The conventional installed plist is currently absent, and no byte-exact copy of its deleted legacy
bytes exists. Before selection, validate that the separately tracked
`launchd/com.handmark.server.target.plist` points to:

```text
.run/site-releases/server/current-server/artifact/server/dist/index.js
```

It must also name the matching `current-server/server-release.json`, keep `HOST=127.0.0.1`,
`PORT=3000`, `NODE_ENV=production`, `APP_BASE_URL=https://handmark.io`, and the canonical non-secret
data paths. Provision one owner-controlled mode-`0600` `.env.web` regular file in the operational
root containing only `HANDMARK_PASSWORD` and `SESSION_SECRET`. The compiled target loads no other
private keys and never reads legacy `.env` as a fallback.

The preserved operational `.env` belongs to the historical MJS recovery input. Keep it unchanged
through the documented rollback window; the service is currently absent, and this file is not a
target template or a second source for the compiled server.

Use the recorded browser and server candidate IDs from step 0. Preview the pair, then apply the
offline selection while the Handmark role and conventional installed plist remain absent:

```bash
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark \
  --browser-release-id "$HANDMARK_BROWSER_RELEASE_ID" \
  --server-release-id "$HANDMARK_SERVER_RELEASE_ID" \
  --verify-path /
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark \
  --browser-release-id "$HANDMARK_BROWSER_RELEASE_ID" \
  --server-release-id "$HANDMARK_SERVER_RELEASE_ID" \
  --verify-path / \
  --apply
```

Record the returned cutover ID. Selection changes both pointers under one durable recovery journal;
it does not install or start a service. Do not use standalone browser or server publication for
this migration.

After the legacy role is stopped/unloaded, its installed definition is absent, the data/restore
proof is recorded, and server-ops has selected the paired candidates, run
`bin/install-server-daemon --apply`. The installer re-proves the selected identity and entrypoint,
the current-user-owned real operational root, the exact mode-`0700` real `data/` directory, the
owned mode-`0600` `.env.web` and database, and exact target plist before delegating the sole write
to the shared server-ops LaunchDaemon-definition transaction. It proves those directory modes but
never changes them. It never bootouts, bootstraps, kickstarts, loads, or restarts Handmark. Treat
any pre-existing different definition as a blocker; do not overwrite around it. Run the installer
directly as `cortex`, never through `sudo`; the shared server-release status authenticates the
complete selected release in the expected offline state. The wrapper then validates a private
staged copy of the target plist so concurrent checkout edits cannot change its semantics between
product validation and the shared writer's exact source snapshot. The definition writer requests
only its narrow privileged filesystem transaction itself.

Preview and then apply the exact definition-only transaction as `cortex`:

```bash
"$HANDMARK_REPO/bin/install-server-daemon" --check
"$HANDMARK_REPO/bin/install-server-daemon" --apply
```

The server accepts only exact `NODE_ENV` values `development`, `test`, and `production`; this
operational launch uses `production`. Isolated release validation also uses `production` but is
distinguished by its framework-owned validation flag.

Before the server binds, its startup interlock proves the existing selected database has the sealed
legacy import receipt and matching authority. A present file requires JSONL authority; startup pins
it and its parent chain and matches its exact bytes/hash. An absent path accepts only canonical
empty-absence authority. Deleting JSONL evidence therefore fails startup even when its sealed JSONL
receipt remains. If a file appears against empty-absence authority, startup also fails. A missing
database, missing/mismatched authority or receipt, unsafe or escaping path, linked/replaced parent,
unsafe database artifact, or changed source must exit nonzero without listening or creating a
production replacement.

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

After the definition-only installer succeeds, preview the identity-bound first bootstrap, refresh
the administrator credential, and apply only the returned identity. Run both Node commands directly
as `cortex`; the wrapper never runs as root and accepts only a cached non-interactive sudo session
for the exact launchctl operation:

```bash
node /Users/cortex/Development/server-ops/bin/bootstrap-site-services.mjs --site handmark
sudo -v
node /Users/cortex/Development/server-ops/bin/bootstrap-site-services.mjs \
  --site handmark \
  --expected-identity '<exact-identity-from-preview>' \
  --apply
```

Then verify, in order:

1. exact local `/healthz` (`app: handmark`) and `/cx-server.json` identity;
2. selected and running server-release identity match;
3. selected and served `/cx-build.json` identity match;
4. locked `/`, branded `/login`, wrong-password behavior, and selective public assets;
5. nginx-local routing for both hostnames;
6. external HTTPS for both hostnames;
7. a fresh selected immutable backup and safely extracted whole-bundle proof after startup, using
   the exclusive evidence paths below.

The product-owned semantic verifier is deliberately an offline preselection tool. Its target and
first-restored-database proofs were completed in steps 3–5 while the candidate was inactive and the
service family and installed definitions were absent. Do not try to run that candidate tool after
selection. Instead, prove the running database's actual `sqlite-online` path through a fresh
selected immutable backup and safe whole-bundle extraction without reusing any earlier no-replace
evidence path:

```bash
HANDMARK_POST_BOOTSTRAP_BACKUP_PREVIEW="$HANDMARK_EVIDENCE/post-bootstrap-backup-preview.txt"
HANDMARK_POST_BOOTSTRAP_BACKUP_APPLY="$HANDMARK_EVIDENCE/post-bootstrap-backup-apply.txt"
HANDMARK_POST_BOOTSTRAP_EXTRACTION_PREVIEW="$HANDMARK_EVIDENCE/post-bootstrap-extraction-preview.txt"
HANDMARK_POST_BOOTSTRAP_EXTRACTION_APPLY="$HANDMARK_EVIDENCE/post-bootstrap-extraction-apply.json"
HANDMARK_POST_BOOTSTRAP_RESTORE_ROOT="$HANDMARK_EVIDENCE/post-bootstrap-backup-extracted"
readonly HANDMARK_POST_BOOTSTRAP_BACKUP_PREVIEW HANDMARK_POST_BOOTSTRAP_BACKUP_APPLY
readonly HANDMARK_POST_BOOTSTRAP_EXTRACTION_PREVIEW HANDMARK_POST_BOOTSTRAP_EXTRACTION_APPLY
readonly HANDMARK_POST_BOOTSTRAP_RESTORE_ROOT

for HANDMARK_POST_BOOTSTRAP_PATH in \
  "$HANDMARK_POST_BOOTSTRAP_BACKUP_PREVIEW" \
  "$HANDMARK_POST_BOOTSTRAP_BACKUP_APPLY" \
  "$HANDMARK_POST_BOOTSTRAP_EXTRACTION_PREVIEW" \
  "$HANDMARK_POST_BOOTSTRAP_EXTRACTION_APPLY" \
  "$HANDMARK_POST_BOOTSTRAP_RESTORE_ROOT"; do
  if [[ -e "$HANDMARK_POST_BOOTSTRAP_PATH" || -L "$HANDMARK_POST_BOOTSTRAP_PATH" ]]; then
    echo "Handmark post-bootstrap evidence path already exists" >&2
    exit 1
  fi
done

(umask 077; set -C; /opt/homebrew/bin/node \
  /Users/cortex/Development/server-ops/bin/system-job-launcher.mjs \
  --selected-backup-preview \
  >"$HANDMARK_POST_BOOTSTRAP_BACKUP_PREVIEW")

HANDMARK_POST_BOOTSTRAP_BACKUP_IDENTITY='<exact-selectionIdentity-from-first-preview-line>'
readonly HANDMARK_POST_BOOTSTRAP_BACKUP_IDENTITY

(umask 077; set -C; /opt/homebrew/bin/node \
  /Users/cortex/Development/server-ops/bin/system-job-launcher.mjs \
  --selected-backup-apply \
  --expected-selected-backup-identity "$HANDMARK_POST_BOOTSTRAP_BACKUP_IDENTITY" \
  >"$HANDMARK_POST_BOOTSTRAP_BACKUP_APPLY")

HANDMARK_POST_BOOTSTRAP_BACKUP_ARCHIVE='<exact-final-archive-path-from-applied-output>'
readonly HANDMARK_POST_BOOTSTRAP_BACKUP_ARCHIVE

(umask 077; set -C; node /Users/cortex/Development/server-ops/bin/extract-backup-archive.mjs \
  --archive "$HANDMARK_POST_BOOTSTRAP_BACKUP_ARCHIVE" \
  --destination "$HANDMARK_POST_BOOTSTRAP_RESTORE_ROOT" \
  >"$HANDMARK_POST_BOOTSTRAP_EXTRACTION_PREVIEW")

HANDMARK_POST_BOOTSTRAP_ARCHIVE_IDENTITY='<exact-archiveIdentity-from-preview>'
readonly HANDMARK_POST_BOOTSTRAP_ARCHIVE_IDENTITY

(umask 077; set -C; node /Users/cortex/Development/server-ops/bin/extract-backup-archive.mjs \
  --archive "$HANDMARK_POST_BOOTSTRAP_BACKUP_ARCHIVE" \
  --destination "$HANDMARK_POST_BOOTSTRAP_RESTORE_ROOT" \
  --expected-archive-identity "$HANDMARK_POST_BOOTSTRAP_ARCHIVE_IDENTITY" \
  --apply \
  >"$HANDMARK_POST_BOOTSTRAP_EXTRACTION_APPLY")
```

Require the selected backup output to name Handmark's canonical `sqlite-online` entry and require
the extraction apply result to contain the successful whole-bundle manifest receipt. Then repeat
the ordinary live health and selected/running browser/server identity checks in items 1–3. The
post-bootstrap proof establishes the live selected backup path; it does not replace or weaken the
preselection product-semantic receipt proofs.

Do not submit a synthetic application to the real review queue merely as a health probe.

Preview and apply paired finalization only after all seven checks pass:

```bash
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --status --cutover-id '<cutover-id>'
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --finalize --cutover-id '<cutover-id>' --verify-path /
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --finalize --cutover-id '<cutover-id>' --verify-path / --apply
```

Until finalization succeeds, the open journal blocks every standalone release mutation and prune.

## 7. Rollback decision

If selection succeeded but finalization did not, stop and boot out the target service, remove its
installed definition to reviewed rollback storage, prove exact role/plist absence, and use the
paired abort preview/apply flow:

```bash
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --abort --cutover-id '<cutover-id>'
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --abort --cutover-id '<cutover-id>' --apply
```

If the cutover was finalized, use the paired revert preview/apply flow under the same offline proof:

```bash
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --revert --cutover-id '<completed-cutover-id>'
node ../server-ops/bin/full-stack-cutover.mjs \
  --site handmark --revert --cutover-id '<completed-cutover-id>' --apply
```

This first-cutover revert restores the recorded prior browser pointer and an unselected server
state. It deliberately returns Handmark to an offline, definition-absent state. The deleted legacy
installed plist was never captured byte-for-byte, so there is no automatic exact legacy service
restore. The tracked historical template and preserved legacy `.env` are only reviewed recovery
inputs; any decision to recreate and restart the old service is a separate authorised recovery
operation that must validate those inputs and the still-matching source/absence proof. Never claim
that abort or revert performed that recovery, and never run independent browser and server
rollbacks.

After any new SQLite intake, the legacy JSONL writer is no longer a safe rollback target. Stop the
new server, compare the database with the import receipt, and keep intake offline. Fix forward from
SQLite or use a separately reviewed lossless reverse migration; never resume JSONL and lose the new
row.

## 8. Preserve evidence without creating a fallback

With JSONL authority, the cutover run does not delete the original file. Keep it access-restricted
and read-only as migration/rollback evidence. At `data/applications.jsonl`, it is also the target
runtime's startup integrity witness: the process opens and hashes it to match the sealed receipt,
but never uses it as the application store, fallback, request-time reader, or dual-write target.
The separately reviewed durable raw-witness archive required before step 5 must remain covered by
its recorded retention and extraction/digest proof; the canonical SQLite-only backup does not
contain or replace it. Record a separate owner-approved retention decision that reconciles
evidence needs with Handmark's 90-day application policy; do not silently retain operational PII
forever or delete the only migration evidence during cutover. Approval alone is not yet executable:
before any later removal, add and deploy an explicit schema migration that durably records evidence
retirement and update the startup contract to verify it. Until then, removing the JSONL
intentionally blocks production startup.

With empty-absence authority, there is no JSONL artifact to preserve. Preserve the recorded stopped
service/empty-queue determination, repeated absence proof, canonical receipt, restore proof, and
release evidence. The source path must remain absent; never create a file later to make the
evidence look like the JSONL case.

Operational cutover completion requires the final authority proof, every importer and verifier
receipt, database parity, disposable and selected extracted restores, JSONL witness coverage when
applicable, release identity, health, backup, and public verification evidence in the architecture
migration ledger. The source-only architecture phase records these as explicitly deferred entry
gates; it does not perform or claim them.
