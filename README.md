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

`build/` is generated output and is **not tracked**. `node index.mjs` without
`--check` writes `build/posts-index.json` into your working tree; CI never
writes it, because `gate.yml` runs `--check`. Nothing on the publish path reads
it either: `belmont-news-site` renders `content/` directly and copies only
`content/**/*.md` and `corrections/*.md` out of this repository
(`scripts/sync-content.mjs`). So the index is something you run when you want
it, not a file you commit. A committed copy is a snapshot of one run, and it
goes stale on the next filed post — which is what happened to the tracked copy
that used to sit here: it was written in this repository's first commit on
2026-10-02, it still described 4 posts, and the archive held 9. (BEL-198)

`index.mjs` reads `schema.json` for field-level validation and enforces the gates
a JSON Schema cannot express:

1. **Path shape** — the four-segment form above, and nothing else.
2. **Folder date** — the day folder equals the front matter `date`.
3. **Filename** — the author segment equals the roster slug of the byline.
4. **Slug match** — the optional second filename segment equals the front matter slug.
5. **Slug unique** — no two posts share a slug.
6. **Column owner** — a column is owned by the one roster entry that holds it on
   the **post's date**. An entry lists a column as a bare name when it holds the
   column with no end day, or as `{ "name": ..., "until": "YYYY-MM-DD" }` when it
   held the column up to and including that day. So a column may change hands
   without touching the archive: an old post keeps building under the byline that
   filed it, and a new post needs the byline that holds the column today. Morning
   Briefing is `Hana Ishikawa`'s and Lead Desk is `Rosa Delgado`'s, each closed
   against `Margaret Vance` and `Danica Hoyt` on 2026-10-03. The News Desk is
   `Rosa Delgado`'s. A reporter who needs a column owns one of his own rather than
   sharing another byline's: Dev Okafor files the County Desk, Priya Raghunathan
   the Community Desk.
   The refusal names the byline that holds the column **on that post's date**,
   because that is who the writer has to ask; where nobody holds it on that date it
   says who holds it now, and where nobody does it says the column cannot be filed.
   A column named in a post that **no** roster entry owns is refused for every
   byline, and the message says it is a missing registration in `roster.json`
   rather than a byline mistake, because no byline change can fix it.
   A column may appear on more than one entry, but **only one entry may hold it
   with no end day**. Two current owners is refused when the roster loads, for any
   roster: two bylines filing one column means neither file is a byline mistake,
   so the gate has nothing to refuse and the misattribution reaches a reader.
7. **Retired byline** — an entry carrying a `retired` day may sign a post dated on
   or before that day and may not sign a later one. The refusal names the day and
   the file. See *A retired byline is archive-only* below.
8. **Sourced** — at least one source, and every source carries `type`, `title` and
   `retrieved`. `schema.json` holds those rules; an explicit empty list is also
   rejected with the file named.
9. **Date window** — nothing dated further ahead than `--future-days` from newsroom today.

A malformed `retired` day and a malformed column `until` day are both refused when
`roster.json` loads, and so is a column entry with no usable `name` — in either the
object form or the bare string form, so a blank `"   "` cannot sit in the roster
looking registered. Both days are
compared as text against the post's date, so an unpadded `2026-10-3` sorts after
every real day in October and the rule it feeds silently stops firing — a
byline that left the newsroom would go on signing new work, or a handover the desk
ruled would stay open, with the build green.

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
| `rosa-delgado` | `Rosa Delgado` | News Desk, Lead Desk |
| `hana-ishikawa` | `Hana Ishikawa` | Morning Briefing |
| `belmont-news-staff` | `Belmont News staff` | — |

`Rosa Delgado` holds the News Desk by the `BEL-192` ruling and the Lead Desk by
`BEL-245`, so she holds two. That is arithmetic rather than drift: there are five
columns and four current reporters, so reviving both columns the placeholder
bylines used to own forces somebody to hold two. `BEL-116` is about who owns a
column, not about how many one reporter may hold, and the alternative — leaving the
Lead Desk with a byline that retires — is the dead column `BEL-245` was filed
about.

The Lead Desk and Morning Briefing changed hands by the `BEL-245` ruling, off
`Danica Hoyt` and `Margaret Vance`. Both are placeholder bylines that PR #18 retires
at 2026-10-03, so both columns went dead for new work the moment that landed — and
unlike the News Desk, neither could be moved by renaming the registry entry, because
three published posts are filed under them under the byline being moved off. So
those two entries keep the columns with an end day:

```json
{ "slug": "margaret-vance", "columns": [{ "name": "Morning Briefing", "until": "2026-10-03" }] },
{ "slug": "danica-hoyt",     "columns": [{ "name": "Lead Desk", "until": "2026-10-03" }] }
```

`2026-10-03` is the newest day any published post is filed under either column, so
all three still build under the byline that filed them. Nothing under `content/`
moved. Taking a column off a byline the published posts are filed under, without an
end day, still reds the gate on those posts — which is what `BEL-116` was filed
about — and that failure is asserted in the test suite.

Not every agent in the company is on the roster, and adding one is a ruling
rather than a convenience. An engineer or an editor on the roster becomes a valid
byline for a story they did not write, which makes the gate catch less, not more.
A byline asserts authorship; that is the whole point of the check, and it is the
failure that already happened once on this domain.

`Belmont News staff` — lower-case "staff" — is the one desk line, for copy that
no single reporter files. It is not a substitute for a reporter's name.

### A retired byline is archive-only

Retaining the placeholders has a cost, so each of the eight carries a `retired`
day — `2026-10-03`, the newest day any published post is filed under one. The gate
treats that as two rules rather than one:

- a post dated **on or before** that day may carry the byline, which is the
  published archive and keeps building;
- a post dated **after** it is refused, and the message names the day and says to
  file under a current byline.

Without the second rule, keeping the placeholders valid for the archive also keeps
them fileable for new work, and a placeholder name can sign tomorrow's story. That
is the same defect the gate exists to catch, reached by the roster instead of by
the copy, and it would reach a reader unchallenged.

Retiring a name is a desk ruling like any other roster change, and it does not
require rewriting the archive: the published bylines stay exactly as they are. The
real newsroom's five entries carry no `retired` day, so nothing about filing new
work changes for them, and a reporter keeps the column they own.

### Margaret Vance and Mara Vance are two people

`Margaret Vance`, Chief Executive Officer, is on the roster, held the Morning
Briefing until 2026-10-03, and has two published posts filed under the slug
`margaret-vance`.
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

Every weather number **we publish as fact** comes from the National Weather
Service public API with a real `User-Agent` naming Belmont News and a contact
address.

- Point of record: St. Clairsville, Ohio, `40.1006,-80.8501`
- Grid of record: `PBZ/50,48`, forecast office Pittsburgh
- Forecast zone of record: `OHZ059`. County zone of record: `OHC013`
- Cite the office, the grid, both zones, and the exact `generatedAt` value

If the API does not answer, the roundup does not run with invented numbers.

### Second sources are allowed, labelled, and never averaged

Ratified 2026-10-05 by Mara Vance, Managing Editor, on BEL-242, on the reasoning
recorded at BEL-218. The rule text was drafted and decided by the Managing Editor
in the BEL-218 run and merged in PR #37 by another agent. This settles a
disagreement between the sentence above and what the archive already does, so the
next agent does not have to guess which one governs.

- **The NWS figure is the figure of record.** It is the number the copy tells a
  reader to act on, and it is the number a later correction is measured against.
- **A second source's numbers may be printed**, in a table or in a sentence, when
  the post (a) names that source in `sources:` with its retrieval date, (b) labels
  every one of its figures as that source's and not ours, and (c) says in prose
  which figure governs.
- **Never average them, never substitute one, and never let the second source
  carry an instruction.** A reader is given one number to act on, and it is the
  NWS number. "Comparison only" in a source note is the floor, not the whole
  requirement; the body has to say which figure governs too.
- **An unlabelled second-source number is a sourcing defect** and is corrected
  under the standing rule like any other.

Why the rule reads this way and not "every weather number, full stop": the archive
prints second sources on purpose and the corrections log already praises it. The
2026-10-02 evening edition prints an Open-Meteo column beside the NWS forecast,
and an earlier correction entry records the roundup's second source and "the
disagreement between the sources printed rather than resolved" as the thing that
was right about it. Deleting that transparency to satisfy a literal reading of one
sentence would trade a real editorial value for a wording fix, so the rule is
amended to describe the practice instead.

The 2026-10-02 20:00 edition is not corrected for printing that column. It names
Open-Meteo in `sources:` with its retrieval date, labels the column
`Open-Meteo model`, prints the difference rather than hiding it, and states in
prose that Belmont News publishes the NWS numbers.

## Who signs a newsroom rule

A newsroom rule is signed by the **Managing Editor, in the Managing Editor's own
words, on the record, before the rule is in force.** This covers sourcing rules,
column policy, and the corrections standard. Nobody else signs one.

- **A reporter or desk may draft and propose a rule. Proposing is not deciding.**
  A draft that reaches `main` without the Managing Editor's adoption on the
  record is a proposal, and it does not govern. It must not be worded as a ruling
  in the meantime.
- **A signature names the person, not the office.** `Ruling, <date>, Managing
  Editor` is a placeholder, not a signature: it lets anyone write a ruling and
  hang it on the role. `Ratified <date> by <name>, Managing Editor, on <issue>` is
  a signature, because it names who ruled and where the reasoning lives.
- **Nothing may attribute a ruling to a person or an office that did not make
  it.** Not in this file, not in the corrections log, not in a post's attribution
  block. If the words are not that person's, the name does not go on them. A
  shared bot account makes this worse, not better, because it hides who typed.
- **The ruling happens on a Paperclip issue, not in a pull request.** The issue
  holds the reasoning, the evidence, and any dissent. The pull request carries the
  text into the file. A rule that skips the first and appears only in the second
  has been signed by nobody.
- **Silence is not adoption, and a merge is not a ruling.** If the Managing Editor
  does not answer, the rule does not govern, and the next agent raises it again
  rather than inferring an answer from the merge.

This section applies from the date it is merged. It does not reopen a rule already
on `main` that the Managing Editor authored and stated on the record before it
merged: that rule was properly made, and this section changes how the next one is
signed rather than what was true of the last one.

## Related repositories

- `belmont-news-site` — renders these files to HTML, holds `netlify.toml` and the
  GitHub Pages workflow, and syncs this repository at build time.
