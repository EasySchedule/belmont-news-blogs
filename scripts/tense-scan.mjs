// tense-scan.mjs - report candidate time-anchored phrases in the store. Never
// refuses anything.
//
//   node scripts/tense-scan.mjs [--content content] [--listing-days 2] [--today YYYY-MM-DD] [--json]
//
// WHAT THIS IS NOT
//
// This is not a gate and it is not a check on the list of required status
// checks. It is the reason somebody reads the line next to the one the scan
// flagged, and nothing else.
//
// The ruling that authorises it is Mara Vance's, in
// expired-post-standard on BEL-139, amended on BEL-317:
//
//   The human QA gate is the enforcement point. Alongside the human pass, a
//   scan of the store reports candidate time-anchored phrases as pull-request
//   annotations. It exits 0 always, is never a required status check, never
//   edits copy, and shares its token list with QA. A hit is a pointer for a
//   human, not a verdict, and never a reason to stop a merge.
//
// Why a word list cannot be the fix, in her words and it is worth keeping in
// view of the code: every instance of the defect was copy whose meaning came
// from the line *after* it. "Council meets tonight." is not wrong until you read
// the next line. A word-list scanner reads one line at a time by construction.
// So it is a supplement to a human pass, not a second opinion, and authority to
// send a draft back stays with a person.
//
// CONSEQUENCES WRITTEN INTO THIS FILE
//
// 1. It exits 0. Always. Including when its own parsing throws, including when a
//    post has no front matter, including when `--listing-days` was not supplied.
//    An internal error is a printed warning, not an exit code. If this file ever
//    exits non-zero it is a bug in this file, and that bug fails a build.
//
// 2. It never writes. There is no code path here that opens a post for writing.
//    The only way off a hit is the QA rejection path that already exists.
//
// 3. It shares QA's token list and nothing else. The list below is the list in
//    time-anchored-copy-check on BEL-162, copied, not paraphrased, because the
//    drift between QA's list and the scanner's list is how this defect got past
//    three times. Adding a token here without a QA ruling, or dropping one,
//    reopens that. `at press time` is deliberately absent: Tobias ruled it out
//    on BEL-316, and a reporter's hedge about our own access does not rot.
//
// 4. It reports every hit, in the window or out of it, and prints the window
//    state for each. The window says how serious a hit is. It does not decide
//    whether a human sees it before the merge, because the cheapest fix in this
//    whole system is the one made while the sentence is still being written.
//
// 5. It reads the listing window from scripts/listing-days.mjs, or from
//    --listing-days, and prints the value it used. If it cannot read it, it says
//    so loudly and reports the window as unknown rather than guessing two.
//
// 6. It skips front matter and fenced code, and implements no other exemption.
//    Front matter is skipped because two of the known hits on `main` are
//    corrections[] entries recording the 2026-10-05 correction for this very
//    defect, and a scanner that flags the record of a fix teaches reporters to
//    hate it. Fenced code is skipped for the reason index.mjs skips it: a fenced
//    JSON or transcript sample is legitimate copy, marked as one.
//    There is deliberately no block-quote exemption. On `main` there are three
//    block-quote lines in the entire archive, all of them a street address. The
//    authorised-looking NWS hit is our own prose labelling a period, sitting
//    outside the quotation marks, so a structural skip would not have exempted
//    it anyway.
//
// 7. It exempts a token only where a human declared it, in the post's own front
//    matter, with the verbatim context it applies to and a reason. See
//    readAllowances below. A post may not exempt itself quietly, and it may not
//    exempt a word "somewhere in this file".
//
// 8. It never edits copy, never rewrites tense, and never proposes a rewrite.
//    Mara's standard bans automatic tense rewriting at expiry, by the template
//    or by anyone else, for the same reason: a template that bends tense is
//    publishing sentences no human checked.

// ------------------------------------------------------------------ imports

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import process from 'node:process';

// -------------------------------------------------- the list, from QA's ruling
//
// time-anchored-copy-check, BEL-162, "Banned outright, in headline, dek, body,
// subheads, lists". Do not edit without a QA ruling on BEL-162 or its
// successor. If QA changes the list, this changes in the same pull request, and
// the pull request says which ruling moved it.
//
// The same ruling bans "any forecast framing that implies a live forecast
// period". That clause is a judgement about meaning, not a string, and it is
// not implemented here. A word list cannot recognise framing. It stays with the
// human pass, and the run prints that fact on every run so nobody reads a clean
// report as a clean forecast check.

const QA_TOKENS = [
  'today',
  'tonight',
  'tomorrow',
  'last chance',
  'this weekend',
  'right now',
  'currently',
  'still open',
];

// ------------------------------------------------------------- newsroom time
//
// The same clock and the same shape as index.mjs: America/New_York, rendered
// en-CA so it comes out YYYY-MM-DD. A scanner that used UTC would call every
// post in-window or out of it one day off from the gate on the evening of a
// publish, which is the only time anyone is looking at this.

function newsroomToday() {
  return new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
}

function isRealDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10));
  const d = new Date(t);
  return Number.isFinite(t)
    && d.getUTCFullYear() === +v.slice(0, 4)
    && d.getUTCMonth() === +v.slice(5, 7) - 1
    && d.getUTCDate() === +v.slice(8, 10);
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// ------------------------------------------------------- reading a post file
//
// Front matter is split with the same expression index.mjs uses, and it has to
// stay the same one. The allowance below is read out of front matter, and an
// allowance the gate cannot parse is an allowance that gets the post rejected,
// so the two readers have to agree on where front matter stops. index.mjs is a
// script with top-level side effects and calls process.exit, so it cannot be
// imported; the split is duplicated deliberately and test/gate.test.mjs pins the
// two against the same fixture so a drift here is a failing test rather than a
// silent disagreement.

const FM_SPLIT = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;
// The header alone, delimiters included, so the number of lines before the body
// can be counted rather than assumed.
const FM_HEADER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

function splitPost(text) {
  const h = FM_HEADER.exec(text);
  const m = FM_SPLIT.exec(text);
  if (!m) return { frontMatterLines: [], bodyLines: text.split(/\r?\n/), consumed: 0 };
  // Count the lines the header actually occupies rather than assuming a blank
  // line follows the closing delimiter. `---\nfm\n---\nbody` and `---\nfm\n---\n\nbody`
  // both put the body one line further down, and a human's line numbers have to
  // be right for both.
  const consumed = h[0].split(/\r?\n/).length - 1;
  return {
    frontMatterLines: m[1].split(/\r?\n/),
    bodyLines: (m[2] ?? '').split(/\r?\n/),
    consumed,
  };
}

// A top-level scalar out of the front matter block. Only the three fields this
// scan reports on are read: date, eventEnds, quotedTokens. It is not a YAML
// parser and does not try to be one.
function topLevelScalar(fmLines, key) {
  for (const line of fmLines) {
    if (/^\s/.test(line)) continue;
    const km = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (!km || km[1] !== key) continue;
    const raw = km[2].trim();
    const q = /^"(.*)"$/.exec(raw) || /^'(.*)'$/.exec(raw);
    return q ? q[1] : raw;
  }
  return undefined;
}

// ------------------------------------------------- the declared allowance
//
// Ruled on BEL-316 by Tobias Nkemelu, and the shape is not a matter of taste:
// index.mjs parses front matter with a hand-rolled reader whose scalar() handles
// only [], quoted strings, booleans, integers and bare text. An inline array
//
//   quotedTokens: ["tonight", "today"]
//
// parses to the *string* '["tonight", "today"]' and fails the schema with
// "expected array, got string". The only working form is a block list, the same
// shape `sources` and `corrections` already use:
//
//   quotedTokens:
//     - token: tonight
//       context: "OHZ059 segment reads: tonight"
//       reason: "NWS Zone Forecast Product FPUS51 KPBZ 022102, issued 2026-10-02"
//
// `context` is required and it is the point. A bare list of words says "this
// word is fine somewhere in this post", which is a hole wide enough to walk a
// real defect through - the live instance on `main` is
// `dev-okafor--barnesville-...md:103`, "Council meets tonight.", in a post with
// no weather source of any kind, which a word-level allowance would have let a
// reporter silence. Requiring the verbatim context means one entry covers one
// occurrence.
//
// `reason` is required too, from Mara's condition 8 on BEL-317: no reason, no
// allowance. The two rulings are combined here deliberately, and both were
// checked against each other first. A token or context with no reason is not an
// exemption: the hit is still reported, and the bad allowance is reported
// beside it.

function readAllowances(fmLines, rel) {
  const out = [];
  const problems = [];
  let start = -1;

  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (/^quotedTokens:\s*$/.test(line)) { start = i + 1; break; }
    if (/^quotedTokens:\s*\S/.test(line)) {
      problems.push(`${rel}: quotedTokens is written inline. index.mjs cannot parse an inline array here; use the block form, one "- token:" per occurrence. The allowance was not applied.`);
      return { entries: out, problems };
    }
  }
  if (start < 0) return { entries: out, problems };

  let current = null;
  const close = () => {
    if (!current) return;
    const token = (current.token || '').trim();
    const context = (current.context || '').trim();
    const reason = (current.reason || '').trim();
    if (!token) {
      problems.push(`${rel}: a quotedTokens entry has no token. It was not applied.`);
    } else if (!context) {
      problems.push(`${rel}: quotedTokens entry for "${token}" has no context, so it would cover every occurrence of that word in this post. Not an allowance, so it was not applied. Give the verbatim substring of the line it covers.`);
    } else if (!reason) {
      problems.push(`${rel}: quotedTokens entry for "${token}" has no reason, and an allowance without a reason is not an allowance (BEL-317). Not applied.`);
    } else {
      out.push({ token: token.toLowerCase(), context, reason });
    }
    current = null;
  };

  for (let i = start; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) { close(); break; } // a new top-level key ends the list
    const item = line.trim();
    if (item === '-') { close(); current = {}; continue; }
    if (item.startsWith('- ')) { close(); const f = readField(item.slice(2)); current = f ? { [f[0]]: f[1] } : {}; continue; }
    if (!current) continue;
    const field = readField(item);
    if (field) current[field[0]] = field[1];
  }
  close();
  return { entries: out, problems };
}

// True when the hit at `index` sits inside the allowance's context substring.
//
// The context is located by position, and the FIRST occurrence on the line is
// the one that counts. An allowance naming a context that appears twice on one
// line therefore covers the earlier pair and not the later, which is the correct
// reading of "the occurrence this entry is about": the entry was written against
// a specific piece of text, and if that text genuinely occurs twice the reporter
// owes the reader two entries.
function covers(context, line, index) {
  const at = line.indexOf(context);
  if (at < 0) return false;
  return index >= at && index < at + context.length;
}

function readField(text) {
  const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(text.trim());
  if (!kv) return null;
  const raw = kv[2].trim();
  const q = /^"(.*)"$/.exec(raw) || /^'(.*)'$/.exec(raw);
  return [kv[1], q ? q[1] : raw];
}

// ------------------------------------------------------------ fenced code
//
// index.mjs has stripFencedCode, and this is not it. That one blanks a fenced
// block with a regex and leaves the remaining text shorter than the file, which
// is fine for a shape test and wrong here: this scan has to print the line a
// human has to open, so blanking a block in place and keeping every line number
// is the whole difference. Fence detection is otherwise identical, so the two
// cannot disagree about *whether* a line is inside a fence.

// Fence detection follows CommonMark, because getting it wrong is not a cosmetic
// problem here.
//
// index.mjs strips fenced code with a regex that recognises backtick runs of any
// length and ignores tildes. That is fine for its job, which is one shape test
// on the whole body. This is not that job: this has to decide, line by line,
// whether a given line is prose a reader reads. Two ways to get it wrong:
//
//   - A `~~~` fence is not recognised, so its contents are read as prose and a
//     JSON or transcript sample produces false hits.
//   - A close must use the opener's character and be at least as long. With a
//     naive "line starts with ```" rule, a ``` line inside a ```` block closes it
//     early. Everything after is then read as prose, and — worse — the real
//     prose after the block is blanked as if it were still inside the fence.
//
// That second one is the failure this file must never have: silently not reading
// real prose is precisely how a gate that reads nothing still exits 0. Line
// numbers stay correct either way, which is what makes it easy to miss.
//
// The two files therefore differ here on purpose: this one is correct about
// fences, index.mjs is unchanged and stays narrow. They check different things,
// and a stricter fence rule here can only remove false hits, never add one.
function blankFencedCode(lines) {
  const out = [];
  let fence = null; // { ch, len } of the open fence, or null
  for (const line of lines) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      // A line closes the fence only with the opener's character, at least as
      // long, and nothing after it on the line.
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len && m[2].trim() === '') {
        fence = null;
      }
      out.push('');
      continue;
    }
    // An opener is a fence, not a close. A backtick fence's info string may not
    // itself contain a backtick, which is what stops "```json" being read as a
    // close by the line above.
    if (m && !(m[1][0] === '`' && m[2].includes('`'))) {
      fence = { ch: m[1][0], len: m[1].length };
      out.push('');
      continue;
    }
    out.push(line);
  }
  return out;
}

// ----------------------------------------------------------------- matching
//
// Case-insensitive, on word boundaries, so `tonight` is found in "Tonight." and
// not inside a longer word. Multi-word tokens are phrases and are matched as
// phrases. No other exemptions are applied and none are implied: the only two
// regions skipped are front matter and fenced code, per BEL-317 condition 6.

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const TOKEN_RES = QA_TOKENS.map((t) => ({ token: t, re: new RegExp(`\\b${escapeRe(t)}\\b`, 'gi') }));

function scanLine(line) {
  const found = [];
  for (const { token, re } of TOKEN_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      found.push({ token, index: m.index, match: m[0] });
      if (m.index === re.lastIndex) re.lastIndex++;
    }
  }
  return found.sort((a, b) => a.index - b.index);
}

// ------------------------------------------------------------------- walking

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else if (name.endsWith('.md')) out.push(full.slice(base.length + 1).split('\\').join('/'));
  }
  return out;
}

// -------------------------------------------------------------- window state
//
// "Listed for newsroom days D and D+1, out at 00:00 on D+2" - the rule in the
// site repository's scripts/expiry.mjs, which listing-days.mjs mirrors. A post
// dated D is in the window while daysBetween(D, today) < listingDays.

function windowState(postDate, today, listingDays) {
  if (!isRealDay(postDate)) return 'unknown-date';
  if (!listingDays) return 'unknown';
  return daysBetween(postDate, today) < listingDays ? 'in-window' : 'out-of-window';
}

// --------------------------------------------------------------------- main

function main(argv) {
  const opts = { content: 'content', listingDays: null, today: null, json: false, listingDaysSource: 'unset' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--content': opts.content = val(); break;
      case '--listing-days': opts.listingDays = Number(val()); opts.listingDaysSource = 'argument'; break;
      case '--today': opts.today = val(); break;
      case '--json': opts.json = true; break;
      case '--help': process.stdout.write(USAGE); return { opts, hits: [], problems: [], files: [] };
      default: throw new Error(`unknown argument ${a}`);
    }
  }

  return Promise.resolve(readListingDays(opts)).then((listing) => run(opts, listing));
}

// The window is read once, from one file, and the source is carried into the
// report so the number on screen is never a number nobody can name.
function readListingDays(opts) {
  if (opts.listingDays !== null) {
    if (!Number.isInteger(opts.listingDays) || opts.listingDays < 1) {
      throw new Error(`--listing-days must be a whole number of at least 1, got ${opts.listingDays}`);
    }
    return { days: opts.listingDays, source: 'argument' };
  }
  try {
    // Read synchronously on purpose: a scan that depends on a dynamic import
    // resolving is a scan whose behaviour depends on module resolution, and the
    // failure mode of that is a build that fails for no stated reason.
    const src = readFileSync(new URL('./listing-days.mjs', import.meta.url), 'utf8');
    const m = /export const DEFAULT_LISTING_DAYS\s*=\s*(\d+)\s*;/.exec(src);
    if (!m) return { days: null, source: 'unreadable (no DEFAULT_LISTING_DAYS in scripts/listing-days.mjs)' };
    return { days: Number(m[1]), source: 'scripts/listing-days.mjs' };
  } catch (e) {
    return { days: null, source: `unreadable (${e.message})` };
  }
}

function run(opts, listing) {
  opts.listingDays = listing.days;
  opts.listingDaysSource = listing.source;
  if (opts.today === null) opts.today = newsroomToday();
  if (!isRealDay(opts.today)) throw new Error(`--today must be YYYY-MM-DD, got ${opts.today}`);

  const hits = [];
  const problems = [];
  const files = walk(resolve(opts.content));

  for (const rel of files) {
    const text = readFileSync(join(resolve(opts.content), rel), 'utf8');
    const { frontMatterLines, bodyLines, consumed } = splitPost(text);
    const date = topLevelScalar(frontMatterLines, 'date');
    const eventEnds = topLevelScalar(frontMatterLines, 'eventEnds');
    const { entries, problems: ap } = readAllowances(frontMatterLines, rel);
    problems.push(...ap);

    const lines = blankFencedCode(bodyLines);
    const state = windowState(date, opts.today, opts.listingDays);

    for (let i = 0; i < lines.length; i++) {
      const raw = bodyLines[i];
      const line = lines[i];
      if (!line.trim()) continue;
      const lineNo = consumed + i + 1;
      // One allowance covers ONE occurrence, and this is where that is enforced.
      //
      // An entry matches when the token is the same word and the hit's position
      // falls inside the entry's context. Position matters: a line can carry the
      // same word twice — the career-expo promotions line reads both "Today" and
      // "today" — and a context that happens to span both would otherwise let one
      // entry silence both, which is the hole Tobias ruled shut on BEL-316.
      //
      // An entry is also consumed by the hit it covers, so one entry cannot
      // silence the same context repeated on a later line. Without that, a
      // context string is a licence for the word everywhere it recurs, which is
      // what "one entry per occurrence" in schema.json and in the README says and
      // what this used not to do.
      for (const f of scanLine(line)) {
        const used = entries.find((e) =>
          !e.used
          && e.token === f.token.toLowerCase()
          && covers(e.context, line, f.index));
        if (used) used.used = true;
        const allowance = used || null;
        hits.push({
          file: rel,
          line: lineNo,
          token: f.token,
          match: f.match,
          date,
          newsroomToday: opts.today,
          window: state,
          eventEnds: eventEnds ?? null,
          text: raw.trim().slice(0, 160),
          allowed: Boolean(allowance),
          reason: allowance ? allowance.reason : null,
        });
      }
    }
  }

  report({ opts, hits, problems, files });
  return 0;
}

// ------------------------------------------------------------------ output
//
// The annotation form is the point of the whole file. A hit that only exists in
// a build log is a hit nobody reads, and this newsroom has already paid for
// that lesson once: the drift check ran three times a day against a */15
// schedule while failing outright for two days, because nothing put it in front
// of anyone. `::warning` with file and line renders as an annotation on the
// pull request diff, which is the one surface a reporter is already looking at
// when they write the sentence.

function report({ opts, hits, problems, files }) {
  const warned = hits.filter((h) => !h.allowed);
  const allowed = hits.filter((h) => h.allowed);

  if (opts.json) {
    process.stdout.write(`${JSON.stringify({
      tool: 'tense-scan',
      exitCode: 0,
      newsroomToday: opts.today,
      listingDays: opts.listingDays,
      listingDaysSource: opts.listingDaysSource,
      postsScanned: files.length,
      hits: warned,
      allowed,
      allowanceProblems: problems,
    }, null, 2)}\n`);
    return;
  }

  process.stdout.write(`tense-scan: newsroom day ${opts.today}\n`);
  process.stdout.write(`tense-scan: listing window ${opts.listingDays === null ? 'UNKNOWN' : opts.listingDays} day(s), read from ${opts.listingDaysSource}\n`);
  if (opts.listingDays === null) {
    process.stdout.write('tense-scan: WARNING the listing window could not be read, so every hit below reports its window as unknown. Read it from scripts/listing-days.mjs or pass --listing-days. This does not fail anything.\n');
  }
  process.stdout.write(`tense-scan: ${files.length} post(s) scanned, ${warned.length} hit(s) reported, ${allowed.length} covered by a declared allowance\n`);
  process.stdout.write('tense-scan: token list is QA\'s, from BEL-162. A hit is a pointer for a human, not a verdict, and it never stops a merge.\n');
  process.stdout.write('tense-scan: forecast framing that implies a live forecast period is ruled at BEL-162 and is NOT implemented here. It stays with the human pass, so a clean report is not a clean forecast check.\n');
  process.stdout.write('tense-scan: front matter is skipped per BEL-316, which includes the dek. The dek is in scope for the human pass, so a bare token in a dek is not reported by this scan.\n');

  if (opts.listingDays !== null) {
    process.stdout.write(`tense-scan: this window mirrors DEFAULT_LISTING_DAYS in EasySchedule/belmont-news-site scripts/expiry.mjs. If the site changed and this did not, every "in-window" below is wrong and nothing here will notice.\n`);
  }

  for (const h of warned) {
    const ann = `::warning file=${h.file},line=${h.line},title=Tense scan: ${h.token} in ${h.window === 'out-of-window' ? 'an out-of-window' : h.window === 'unknown' ? 'a post of unknown window state' : 'an in-window'} post::${h.text.replace(/[\r\n%]/g, ' ')}`;
    process.stdout.write(`${ann}\n`);
    process.stdout.write(`tense-scan:   ${h.file}:${h.line}  "${h.match}"  date ${h.date ?? 'unknown'}  window ${h.window}${h.eventEnds ? `  eventEnds ${h.eventEnds}` : '  eventEnds absent'}\n`);
  }

  for (const h of allowed) {
    process.stdout.write(`tense-scan:   ${h.file}:${h.line}  "${h.match}"  covered by a declared allowance - ${h.reason}\n`);
  }
  for (const p of problems) {
    process.stdout.write(`::warning file=${p.split(':')[0]},title=Tense scan: allowance problem::${p.replace(/[\r\n%]/g, ' ')}\n`);
    process.stdout.write(`tense-scan:   ${p}\n`);
  }
}

const USAGE = `tense-scan.mjs - report candidate time-anchored phrases. Exits 0 always.

  --content <dir>        post directory        (default content)
  --listing-days <n>     listing window days   (default: scripts/listing-days.mjs,
                          which mirrors the site repository's DEFAULT_LISTING_DAYS)
  --today <date>         pin the newsroom day  (default: America/New_York today)
  --json                 machine-readable report on stdout
  --help                 this text

This is not a gate. It exits 0 even when it fails, never writes, and never stops
a merge. See the header and BEL-317.
`;

// Every exit from this file is 0, including the ones that are failures. The
// try/catch turns a throw into a printed warning, and an unhandled rejection
// gets the same treatment, because a warning-mode tool that can turn a build
// red on its own bug is exactly the failing gate BEL-317 banned.
process.exitCode = 0;
process.on('uncaughtException', (e) => {
  process.stderr.write(`tense-scan: internal error, reported as a warning and not a failure: ${e && e.message ? e.message : e}\n`);
  process.exitCode = 0;
});
process.on('unhandledRejection', (e) => {
  process.stderr.write(`tense-scan: internal error, reported as a warning and not a failure: ${e && e.message ? e.message : e}\n`);
  process.exitCode = 0;
});

try {
  main(process.argv.slice(2));
} catch (e) {
  process.stderr.write(`tense-scan: could not run: ${e && e.message ? e.message : e}\n`);
  process.stderr.write('tense-scan: reported as a warning. This tool cannot fail a build.\n');
  process.exitCode = 0;
}