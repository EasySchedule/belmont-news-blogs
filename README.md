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
6. **Column owner** — only the roster owner of a column may file it. The Morning
   Briefing belongs to Margaret Vance, the News Desk to Rosalind Kimbrough, and
   the Lead Desk to Danica Hoyt. Nobody else may file those columns.
   A column named in a post that **no** roster entry owns is refused for every
   byline, and the message says it is a missing registration in `roster.json`
   rather than a byline mistake, because no byline change can fix it.
7. **Sourced** — at least one source, and every source carries `type`, `title` and
   `retrieved`. `schema.json` holds those rules; an explicit empty list is also
   rejected with the file named.
8. **Date window** — nothing dated further ahead than `--future-days` from newsroom today.

An unknown front matter field is an error, so a misspelled `sourced` fails the
build instead of quietly dropping the sources list.

### The date window has no backward half

`--today` is the newsroom's publishing date. It is the **forward** bound only.

A post dated before `--today` is never an error. The archive is meant to
accumulate, and a post stays filed at its own publication day forever, so a
backward bound would fail the whole archive one day after each post shipped, for
files nobody touched. That is the reason a writer must never backdate or delete
a published post to make the gate pass: nothing in the gate asks you to.

So `node index.mjs --check --today 2026-10-03` exits 0 on an archive whose newest
post is dated 2026-10-02, and it will keep exiting 0 on every later date. The only
date rule that can fail your post is the forward one.

## Front matter

```yaml
---
title: "Headline, exactly as it prints"
dek: "One sentence under the headline"
date: 2026-10-03
edition: morning          # morning | evening | column
column: "Morning Briefing" # only when edition is column
byline: "Full name exactly as registered in roster.json"
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
