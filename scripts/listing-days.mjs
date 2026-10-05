// listing-days.mjs - the one place in this repository that knows how long a post
// stays on the front page.
//
//   import { DEFAULT_LISTING_DAYS } from './scripts/listing-days.mjs';
//
// WHY THIS FILE EXISTS, AND WHY IT IS A MIRROR
//
// The rule itself is not ours. `DEFAULT_LISTING_DAYS` is defined in the site
// repository, EasySchedule/belmont-news-site, at scripts/expiry.mjs, and that
// file's own header explains the choice of two days at length. This file is a
// mirror of that constant, and it is a mirror because of where CI runs:
//
//   - The editorial gate runs in EasySchedule/belmont-news-blogs. It checks out
//     this repository and nothing else. It cannot import a constant from the
//     site repository, and it must not reach across to raw.githubusercontent.com
//     at build time to read one, because a build that depends on a second
//     network fetch is a build that fails when someone else's cache does.
//   - The alternative is worse: a literal `2` written into the scan script, or
//     into gate.yml, where nothing marks it as a copy of another repository's
//     decision. A stale window is then invisible. The scan would keep printing
//     a confident, wrong "in-window" against posts the site had already dropped
//     from the front page, and no test would fail, because the number under
//     test is the number in the wrong file.
//
// So the number is mirrored once, here, in a file whose entire purpose is to be
// the number, and everything that needs it reads it from here and prints it.
//
// WHEN YOU CHANGE IT
//
// Change it in the same pull request that changes DEFAULT_LISTING_DAYS in
// scripts/expiry.mjs of EasySchedule/belmont-news-site, and change it in the
// same pull request that alters the site's behaviour. One PR, both sides.
//
// What this file cannot do is prove the mirror still matches. Proving that needs
// the other repository, which is precisely what CI here does not have. That is
// a known, accepted gap and it is the one thing in this file worth arguing
// about: if the newsroom later wants the mirror to be self-checking, the honest
// answer is a separate job that checks out both repositories, not a network
// read from inside this one.
//
// This is also not `futureDays` in index.mjs. That constant bounds how far
// ahead of the newsroom day a post may be *filed*. This one bounds how long a
// filed post stays *listed*. Two rules, two names, two files.

export const DEFAULT_LISTING_DAYS = 2;

export default DEFAULT_LISTING_DAYS;