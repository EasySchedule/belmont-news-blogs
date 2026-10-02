---
title: "Gate proof: an unsourced post that the build gate must reject"
dek: "A deliberate violation filed only to show that the gate blocks an empty sources list."
date: 2026-10-03
edition: morning
byline: Margaret Vance
category: gate-proof
slug: gate-proof-unsourced-post
sources: []
---

This file exists for one reason: to be rejected by the build gate.

It is correct in every other respect. The path is the four-segment form, the
day folder equals the front matter `date`, the author segment is the roster slug
for the byline, the slug is unique, and the edition and category are legal.

The `sources` list is empty, and `index.mjs` does not build a post with an
empty `sources` list. This post must never reach `main`.