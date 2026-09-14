# Backup and restore

What a restore point consists of, how to take one, and how to get back.

## What is actually at risk

Four things, and they fail differently.

| Thing | Where it lives | If it were lost |
|---|---|---|
| The code | this repo, GitHub | recoverable from any clone |
| The deployed site | Cloudflare Pages | rebuildable with `./build-deploy.sh --deploy` |
| The queue | Cloudflare D1, table `jobs` | **1089 rows, including 149 submitted applications and their outcomes**. Ingest could refill the open rows; it could not recreate which ones he applied to or when |
| The researched people | `web/outreach/data/contacts.json` | **46 people across 9 employers.** No ingest run recreates this. It came from reading leadership pages, press releases and GitHub profiles one at a time |

The last two are the reason this document exists. The first two look scarier and
are not.

## Taking one

```bash
node ingest/snapshot.mjs
```

Writes to `~/backups/apply-dashboard/<timestamp>/`, **outside this repo**. This
repo is public, and a 1.2MB queue dump committed on a schedule would both bloat
it and publish the shape of his search. A snapshot is a backup, not a
deliverable.

Three files travel together, because none of them alone rebuilds the state:

- `jobs.json` — every row the API serves
- `contacts.json` — the researched people
- `manifest.json` — row counts, a sha256 per file, the live build stamp, and the
  git commit

The manifest is the part that matters. A dump with no checksum and no commit
cannot be told apart from a truncated dump, and the failure mode of a backup is
learning that at the moment you need it. So `snapshot.mjs` re-reads what it just
wrote and verifies it before exiting, and it refuses to write a snapshot at all
if a source returns zero rows.

## Checking one

```bash
node ingest/snapshot.mjs --verify ~/backups/apply-dashboard/<timestamp>
```

Exits non-zero on any missing file or hash mismatch. Proved against both: one
altered word inside `contacts.json` fails it, and so does deleting the file.

## Restoring

### The researched people

The simplest and most likely restore. Copy the file back and redeploy:

```bash
cp ~/backups/apply-dashboard/<timestamp>/contacts.json web/outreach/data/contacts.json
node tests/outreach.mjs <url>        # expect every guard green
./build-deploy.sh --deploy
```

The suite is the check that the restore is sound: the page refuses to render a
person with no source, and refuses a profile link the file does not declare.

### The queue

D1 is the source of truth and it does not pause or expire, so a full restore
should never be needed. If rows were deleted in error, the snapshot holds every
column the API serves, and `ingest/sync-to-d1.mjs` is the write path. Two things
to know before writing any of it back:

1. **`status` and `submitted_at` are the irreplaceable columns.** An open row can
   be re-ingested from its board; the fact that he applied on a given date
   cannot. Restore those first and separately.
2. `decide()` in `sync-to-d1.mjs` is the gate every write passes. Bypassing it to
   force old rows back in would also bypass the role, location and pay rules,
   and put rows on the list that the current rules would reject.

### The code and the site

```bash
git checkout <tag>          # release tags are v1.0.0 through v25.0.0
./build-deploy.sh --deploy
```

Then confirm the deploy actually landed, which is not the same as wrangler
reporting success: fetch the production page and match its build stamp against
`.deploy/index.html`. The bare alias is edge-cached for up to about a minute
after a deploy, so a stamp mismatch in the first seconds is propagation, not
failure.

## The skill

`brian-voice` had no version control until 2026-09-14. It is now a **private**
GitHub repo at `brianference/brian-voice`, tagged `v6.3.0`, living at
`~/.claude/skills/brian-voice`.

It must stay private. `references/` holds 35 of his sent emails, 42 timestamped
Slack messages and the voice evidence measured from them. Privacy was confirmed
three ways at creation: `gh` reports `isPrivate=true`, an anonymous API call
returns 403, and an anonymous raw fetch of a voice sample returns 404.

To restore it:

```bash
git clone git@github.com:brianference/brian-voice.git ~/.claude/skills/brian-voice
cd ~/.claude/skills/brian-voice && C:/Python313/python.exe -m pytest tests/ -q
```

233 tests should pass. The packaged `.skill` zip is gitignored, being a build
artifact of that tree; rebuild it when a copy is needed rather than restoring
one.

## A cadence worth keeping

Snapshots are manual on purpose: an automated daily dump to a public repo is the
exact mistake this layout avoids, and a scheduled job writing to a home
directory only helps on the machine that already has the data. Take one before
anything that rewrites rows in bulk. The three jobs that do are
`ingest/repair-fields.mjs`, `ingest/dedupe-repair.mjs` and
`ingest/closed-check.mjs --write`.
