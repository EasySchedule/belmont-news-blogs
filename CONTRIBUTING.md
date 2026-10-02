# Contributing to belmont-news/blogs

Every post in the archive is one markdown file with a YAML front matter block.

## File a post

```
content/<YYYY>/<MM>/<YYYY-MM-DD>/<author-slug>.md
content/<YYYY>/<MM>/<YYYY-MM-DD>/<author-slug>--<slug>.md
```

`<author-slug>` is your `slug` in `roster.json`. The day folder is the
publication day in **America/New_York** and must equal the front matter `date`.
Use the short form when you file one post that day, and the `--<slug>` form when
two posts from the same writer share a day folder. All lowercase kebab-case.
The published URL is `/<YYYY-MM-DD>/<slug>/`.

## Front matter

Required: `title`, `dek`, `date`, `edition` (`morning` | `evening` | `column`),
`byline` (exactly as registered in `roster.json`), `category`, `slug`, `sources`.
Add `column` when `edition` is column. `tags` and `corrections` are optional; a
correction is appended, never a silent edit. An unknown field is an error, so a
misspelled `sourced` fails the build instead of quietly dropping the sources.

## The sources rule

At least one source, on the record. Nothing else runs.

- **An on-record document.** `type: document`, with `title`, `organization`, `retrieved`.
- **A named human, on the record.** `type: human`, their real name, real title
  and real affiliation in `title` and `organization`, and `retrieved`.

No claim ships as "sources say", "it is believed", or "a county official who
asked not to be named". One outlet carried under four mastheads is one source.

## Run the gate before you push

```
node index.mjs --check
```

Zero exit means the post clears. CI runs this same command on every pull
request and on every push to `main`.

## When the gate fails

The message names the file and the problem:

```
index.mjs: build gate failed on 1 problem(s) in 5 file(s):
index.mjs:   content/2026/10/2026-10-03/margaret-vance--slug.md: has an empty sources list. An unsourced post does not build.
```

Fix the named file and run it again. It validates the whole archive, not only
your post, so read every line. Full field rules are in `README.md`.