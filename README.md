# belmont-news/blogs

The markdown store for Belmont News. Every post in the archive lives here as one
markdown file with a YAML front matter block. Nothing else is edited in here.

## Filing rule

```
content/<YYYY>/<MM>/<YYYY-MM-DD>/<author-slug>.md
content/<YYYY>/<MM>/<YYYY-MM-DD>/<author-slug>--<slug>.md
```

- `<author-slug>` is the writer's `slug` in `roster.json`. Nothing else.
- `<YYYY-MM-DD>` is the publication day in **America/New_York** and must equal
  the front matter `date`.
- `<slug>` must equal the front matter `slug`. It is optional: use the short form
  when a writer files one post that day, and the `--<slug>` form when two posts
  from the same writer share a day folder.
- All lowercase kebab-case ASCII. No spaces. No dates in the filename beyond the
  folder.

The published URL is `/<YYYY-MM-DD>/<slug>/`, so the folder and the URL agree and
the archive is date-addressable.

## The build gate

```
node index.mjs                       # validate content/, write build/posts-index.json
node index.mjs --check               # validate only, write nothing (use this in CI)
node index.mjs --out ../site/build/posts-index.json
node index.mjs --today 2026-10-03    # pin newsroom today for the date window
node --test                          # run the gate's own tests
```

`index.mjs` reads `schema.json` for field-level validation and enforces the gates
a JSON Schema cannot express:

1. **Path shape** — the four-segment form above, and nothing else.
2. **Folder date** — the day folder equals the front matter `date`.
3. **Filename** — the author segment equals the roster slug of the byline.
4. **Slug match** — the optional second filename segment equals the front matter slug.
5. **Slug unique** — no two posts share a slug.
6. **Column owner** — a column is owned by **exactly one** roster entry: the one
   that lists it under `columns`, and no other, and the refusal message names that
   owner. The Morning Briefing is owned by Margaret Vance, the News Desk by
   Rosalind Kimbrough, and the Lead Desk by Danica Hoyt. A reporter who needs a
   column owns one of his own rather than sharing another byline's: Dev Okafor
   files the County Desk, Priya Raghunathan the Community Desk. Ownership is never
   *transferred* either: taking a column off the byline the
   published posts are filed under reds the gate on those posts, which is what
   BEL-116 was filed about.
   A column named in a post that **no** roster entry owns is refused for every
   byline, and the message says it is a missing registration in `roster.json`
   rather than a byline mistake, because no byline change can fix it.
7. **Retired byline** — an entry carrying a `retired` day may sign a post dated on
   or before that day and may not sign a later one. The refusal names the day and
   the file. See *A retired byline is archive-only* below.
8. **Sourced** — at least one source, and every source carries `type`, `title` and
   `retrieved`. `schema.json` holds those rules; an explicit empty list is also
   rejected with the file named.
9. **Date window** — nothing dated further ahead than `--future-days` from newsroom today.

An unknown front matter field is an error, so a misspelled `sourced` fails the
build instead of quietly dropping the sources list.

## The roster

`roster.json` is the list of bylines the gate accepts. A byline is matched on the
exact name string, capitalisation included, and a name that is not on the roster
does not build. There is no fallback and no "closest match".

It holds thirteen entries in two groups.

**The eight placeholders**, retained on purpose. Every post in the published
archive is bylined to one of these names, so removing an entry does not clean up
the roster, it invalidates filed work: the build goes red on the five posts
already published and the site stops updating for everyone. `BEL-116` extended
this list rather than replacing it, which is an editorial decision to leave to the
Managing Editor and not a thing to undo in a plumbing change.

**The four reporters and one desk line**, added by the same ruling:

| slug | byline | columns |
| --- | --- | --- |
| `dev-okafor` | `Dev Okafor` | County Desk |
| `priya-raghunathan` | `Priya Raghunathan` | Community Desk |
| `rosa-delgado` | `Rosa Delgado` | — |
| `hana-ishikawa` | `Hana Ishikawa` | — |
| `belmont-news-staff` | `Belmont News staff` | — |

Not every agent in the company is on the roster, and adding one is a ruling
rather than a convenience. An engineer or an editor on the roster becomes a valid
byline for a story they did not write, which makes the gate catch less, not more.
A byline asserts authorship; that is the whole point of the check, and it is the
failure that already happened once on this domain.

### A retired byline is archive-only

Retaining the placeholders has a cost, so each of the eight carries a `retired`
day — `2026-10-03`, the newest day any published post is filed under one. The gate
treats it as two rules rather than one:

- a post dated **on or before** that day may carry the byline, which is the
  published archive and keeps building;
- a post dated **after** it is refused, and the message names the day and says to
  file under a current byline.

Without the second rule, keeping the placeholders valid for the archive also keeps
them fileable for new work, and a placeholder name can sign tomorrow's story. That
is the same defect the gate exists to catch, reached by the roster instead of by
the copy, and it would reach a reader unchallenged.

Retiring a name is a desk ruling like any other roster change, and it does not
require rewriting the archive. The real newsroom's five entries carry no `retired`
day, so nothing about filing new work changes for them.

`Belmont News staff` — lower-case "staff" — is the one desk line, for copy that
no single reporter files. It is not a substitute for a reporter's name.

### Margaret Vance and Mara Vance are two people

`Margaret Vance`, Chief Executive Officer, is on the roster, owns the Morning
Briefing, and has two published posts filed under the slug `margaret-vance`.
`Mara Vance` is the Managing Editor, is not on the roster, and takes corrections
credit lines rather than bylines.

A find-and-replace across the archive from `Mara` to `Margaret`, or the reverse,
will rename a slug and red the build on the two Morning Briefing posts. Change
neither name. The test `Margaret Vance and Mara Vance are two people, and only one
of them files` holds the slug in place.

### The date window has no backward half

`--today` is the newsroom's publishing date. It is the **forward** bound only.

A post dated before `--today` is never an error. The archive is meant to
accumulate, and a post stays filed at its own publication day forever, so a
backward bound would fail the whole archive one day after each post shipped, for
files nobody touched. That is the reason a writer must never backdate or delete
a published post to make the gate pass: nothing in the gate asks you to.

So `node index.mjs --check --today 2026-10-03` exits 0 on an archive whose newest
post is dated 2026-10-02, and it will keep exiting 0 on every later date. `--today`
never fails a post for being old. Two rules read the post's own `date`: the forward
window, and a retired byline's cut-off, which refuses a post dated after the day
that byline was retired. Nothing else reaches back in time.

## Front matter

```yaml
---
title: "Headline, exactly as it prints"
dek: "One sentence under the headline"
date: 2026-10-03
edition: morning          # morning | evening | column
column: "Morning Briefing" # only when edition is column
byline: "Full name exactly as registered in roster.json, capitalisation included"
category: "kebab-case desk slug"
slug: "url-slug, unique across the archive"
tags:
  - weather
sources:
  - type: document          # document | human
    title: "Document title, or the person's name when type is human"
    organization: "Issuing body, or the person's affiliation"
    retrieved: 2026-10-02
    url: "https://..."
    note: "optional"
corrections:                # optional. A correction is appended, never a silent edit
  - date: 2026-10-04
    correction: "What was wrong. / What is right."
---
```

## Sources

Two forms, and nothing else runs.

**An on-record document.** Issuing body, document title, retrieval date.

```yaml
  - type: document
    title: "Gridpoint forecast PBZ/50,48, API generatedAt 2026-10-02T20:32:27+00:00"
    organization: "National Weather Service, forecast office Pittsburgh PA"
    retrieved: 2026-10-02
    url: "https://api.weather.gov/gridpoints/PBZ/50,48/forecast"
```

**A named human source, on the record.** Real name, real title, real affiliation.

```yaml
  - type: human
    title: "Jackee Pugh"
    organization: "Executive Director, Belmont County Tourism Council"
    retrieved: 2026-10-02
```

No claim ships as "sources say", "it is believed", or "a county official who
asked not to be named".

## Weather sourcing

Every weather number comes from the National Weather Service public API with a
real `User-Agent` naming Belmont News and a contact address.

- Point of record: St. Clairsville, Ohio, `40.1006,-80.8501`
- Grid of record: `PBZ/50,48`, forecast office Pittsburgh
- Forecast zone of record: `OHZ059`. County zone of record: `OHC013`
- Cite the office, the grid, both zones, and the exact `generatedAt` value

If the API does not answer, the roundup does not run with invented numbers.

## Related repositories

- `belmont-news-site` — renders these files to HTML, holds `netlify.toml` and the
  GitHub Pages workflow, and syncs this repository at build time.
