---
title: "Merge proof: a post the required gate check must keep out of main"
dek: "A deliberate violation, filed to prove that main cannot be reached without a green gate."
date: 2026-10-03
edition: morning
byline: Margaret Vance
category: gate-proof
slug: gate-block-proof
sources: []
---

This file exists for one reason: to be rejected, and to make the rejection
unbypassable.

It is correct in every other respect. The path is the four-segment form, the
day folder equals the front matter `date`, the author segment is the roster slug
for the byline, the slug is unique, and the edition and category are legal.

The `sources` list is empty, so `index.mjs` does not build it. The
`Editorial gate` check on `main` is now a required status check, so this pull
request cannot be merged and the post cannot reach the archive. **Do not merge.
It will be closed unmerged.**