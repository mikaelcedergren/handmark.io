# Application import fixtures

These are synthetic records only. They model every shape that Handmark's committed server history
could write without reading the operational `data/applications.jsonl` file.

The importer contract treats a physical line as one complete record. LF and CRLF are accepted, and
the final line may omit its newline. Every blank line is rejected, including a leading, middle, or
newline-only line. Empty files are valid zero-record sources.

All records have exactly the 14 historical fields. The current field types and identifiers remain
strict, while historically accepted values remain importable: weak but non-empty email text, empty
website/proof/walkthrough strings, any billing-cycle string including empty or untrimmed whitespace,
and older non-empty payment strings. The earliest writer used
`String(payload.billingCycle || 'monthly')` without trimming, so truthy arrays could persist an
empty string. One fixture reconstructs object, array, boolean, number, default, and trim coercions
across every submitted field whose value that writer persisted. Unknown, missing, or wrongly typed
fields fail the complete import.

Early 64 KiB request bodies could expand beyond 64 KiB after JavaScript string coercion and the
writer's generated/default fields. Import therefore uses a fixed 512 KiB per-record safety bound,
comfortably above the proven 491,780-byte worst-case expansion. Escaped lone UTF-16 surrogates were
also valid writer output. SQLite TEXT cannot round-trip those code units, so each row keeps
canonical JSON bytes in an authoritative BLOB; ordinary TEXT columns remain query projections and
the hash covers the canonical BLOB.

The 10,000-record and 100 MiB aggregate ceilings are migration safety gates, not historical writer
validity rules. Writers before the bounded store had no aggregate count or file-size limit. A
source beyond either gate therefore blocks the cutover before target creation and requires an
explicit higher-bound migration design; it is never split, truncated, retained, or partially
imported. Import-every-row acceptance remains an operational proof against the stopped source
snapshot.

JSON object keys must be unique after JSON escape decoding. Plain duplicates and escaped aliases
such as `id` plus `i\u0064` are ambiguous and fail before target creation. `createdAt` must also be
the exact UTC, millisecond ISO string emitted by `new Date(...).toISOString()`; parseable date-only
or offset spellings are not writer output and are rejected.

Canonical record bytes are UTF-8 bytes of `JSON.stringify` over the fixed field order in
`APPLICATION_FIELDS`, without a trailing newline and without Unicode normalisation. Each record
hash is lowercase SHA-256 of those bytes. The ordered aggregate is SHA-256 of each 64-character
record hash followed by LF, in physical intake order; the aggregate of zero records hashes zero
bytes. JSON property order, escape spelling, and source newline style therefore do not affect
record hashes, while physical record order does.

The source receipt is immutable and contains only format version, source byte length, source
SHA-256, record count, and ordered aggregate SHA-256. Repeating the exact source against the exact
target returns the identical receipt without writing. Any different source or partial/conflicting
target fails closed.
