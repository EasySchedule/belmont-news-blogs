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

Every source is read. The gate checks `type`, `title` and `retrieved` on each one,
so a `sources:` block of placeholders fails the build instead of passing as a list
of one blank entry.

No claim ships as "sources say", "it is believed", or "a county official who
asked not to be named". One outlet carried under four mastheads is one source.

## Run the gate before you push

```
node index.mjs --check
```

Zero exit means the post clears. CI runs this same command on every pull
request and on every push to `main`.

### Never change a published post to make the gate pass

The gate has no backward date bound. A post dated yesterday is not an error, and
will not become one tomorrow. If the gate ever asks you to backdate a post, remove
a source, or delete a file you already shipped to make it pass, that is a bug in
the gate: report it, do not edit the archive.

## When the gate fails

The message names the file and the problem:

```
index.mjs: build gate failed on 1 problem(s) in 5 file(s):
index.mjs:   content/2026/10/2026-10-03/margaret-vance--slug.md: has an empty sources list. An unsourced post does not build.
```

Fix the named file and run it again. It validates the whole archive, not only
your post, so read every line. Full field rules are in `README.md`.

## The gate has tests

```
node --test
```

They cover the date window in both directions and every field rule that has to
reject a post. CI runs them next to the gate, so a pull request that reopens one
of these holes goes red.