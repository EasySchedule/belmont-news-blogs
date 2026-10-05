// The build gate, tested. Run with: node --test
//
// Every case here is a way the gate used to be wrong, or a way it has to stay
// wrong-proof. The gate is the editorial standard, so a hole in it is a hole in
// the newsroom's sourcing rule. Run this after any change to index.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GATE = join(REPO, 'index.mjs');
const ROSTER = readFileSync(join(REPO, 'roster.json'), 'utf8');
const SCHEMA = join(REPO, 'schema.json');

// --------------------------------------------------------------- fixtures

function post({ day, author = 'nathan-beausoleil', slug = 'a-post', frontMatter, body = 'Body copy.\n' }) {
  const y = day.slice(0, 4);
  const m = day.slice(5, 7);
  return {
    day,
    dir: join(y, m, day),
    file: join(y, m, day, slug === 'a-post' ? `${author}.md` : `${author}--${slug}.md`),
    frontMatter,
    body,
  };
}

function frontMatterOf(fields) {
  return Object.entries(fields)
    .map(([k, v]) => (v === undefined ? '' : `${k}: ${v}`))
    .join('\n');
}

// A complete, valid post. Spread over it to make exactly one thing wrong.
function validPost(over = {}) {
  return frontMatterOf({
    title: '"A headline long enough to clear the schema"',
    dek: '"One sentence under the headline."',
    date: '2026-10-02',
    edition: 'evening',
    byline: 'Nathan Beausoleil',
    category: 'weather',
    slug: 'belmont-county-three-day-weather-roundup',
    ...over,
  });
}

const VALID_SOURCES = [
  'sources:',
  '  - type: document',
  '    title: "Gridpoint forecast PBZ/50,48"',
  '    organization: "National Weather Service, forecast office Pittsburgh PA"',
  '    retrieved: 2026-10-02',
  '    url: "https://api.weather.gov/gridpoints/PBZ/50,48/forecast"',
  '  - type: human',
  '    title: "Jackee Pugh"',
  '    organization: "Executive Director, Belmont County Tourism Council"',
  '    retrieved: 2026-10-02',
].join('\n');

// ------------------------------------------------------------- gate runner

function writeArchive(posts) {
  const root = mkdtempSync(join(tmpdir(), 'belmont-gate-'));
  for (const p of posts) {
    const full = join(root, 'content', p.file);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, `---\n${p.frontMatter}\n---\n\n${p.body}`);
  }
  writeFileSync(join(root, 'roster.json'), ROSTER);
  return root;
}

function runGate(root, args = []) {
  try {
    const stdout = execFileSync('node', [GATE, '--content', join(root, 'content'), '--schema', SCHEMA, ...args], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status, stdout: e.stdout || '', stderr: e.stderr || '' };
  }
}

function archive(posts, args) {
  const root = writeArchive(posts);
  try {
    const result = runGate(root, args);
    const indexPath = join(root, 'build', 'posts-index.json');
    const index = (() => { try { return JSON.parse(readFileSync(indexPath, 'utf8')); } catch { return null; } })();
    return { ...result, index };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// -------------------------------------------------------- the reported bug
//
// BEL-45: `--today` was treated as a floor, so any post older than the newsroom
// date failed. On the day after each post was filed, the archive invalidated
// itself and CI went red for files nobody touched.

test('--today later than the newest post passes: the archive accumulates', () => {
  const posts = [
    post({ day: '2026-10-01', frontMatter: validPost({ date: '2026-10-01', slug: 'yesterdays-roundup', title: '"Yesterday, filed and shipped"' }) + '\n' + VALID_SOURCES }),
    post({ day: '2026-10-02', frontMatter: validPost() + '\n' + VALID_SOURCES }),
  ];
  for (const today of ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2027-01-01']) {
    const r = archive(posts, ['--check', '--today', today]);
    assert.equal(r.code, 0, `--today ${today} must pass the archive: ${r.stderr}`);
  }
});

test('the documented writer command passes on the day after a post is filed', () => {
  const posts = [post({ day: '2026-10-02', frontMatter: validPost() + '\n' + VALID_SOURCES })];
  const r = archive(posts, ['--check', '--today', '2026-10-03']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 post\(s\) pass the gate/);
});

test('the forward window still refuses a post beyond --future-days', () => {
  const posts = [post({ day: '2026-10-20', frontMatter: validPost({ date: '2026-10-20' }) + '\n' + VALID_SOURCES })];
  const r = archive(posts, ['--check', '--today', '2026-10-02']);
  assert.equal(r.code, 1);
  // The window is a forward window, so the message has to name the direction the
  // post is wrong in. It used to say "past" for a date 18 days ahead.
  assert.match(r.stderr, /ahead of the newsroom date window from 2026-10-02/);
});

test('--future-days widens the forward window only', () => {
  const posts = [post({ day: '2026-10-06', frontMatter: validPost({ date: '2026-10-06' }) + '\n' + VALID_SOURCES })];
  assert.equal(archive(posts, ['--check', '--today', '2026-10-02']).code, 1);
  assert.equal(archive(posts, ['--check', '--today', '2026-10-02', '--future-days', '7']).code, 0);
});

// -------------------------------------------------- the sourcing gate bites
//
// parseFrontMatter used to null out the list key on a `- ` marker, so every
// `sources:` block parsed to `[{}]`: one empty object, no field read at all. And
// validate() was called with schema.properties instead of the schema, so no
// schema rule ran either. A post with a garbage sources block built clean.

test('the index carries every source, not one empty object', () => {
  const r = archive([post({ day: '2026-10-02', frontMatter: validPost() + '\n' + VALID_SOURCES })]);
  assert.equal(r.code, 0, r.stderr);
  const sources = r.index.posts[0].sources;
  assert.equal(sources.length, 2);
  assert.equal(sources[0].type, 'document');
  assert.equal(sources[0].title, 'Gridpoint forecast PBZ/50,48');
  assert.equal(sources[0].retrieved, '2026-10-02');
  assert.equal(sources[1].type, 'human');
  assert.equal(sources[1].title, 'Jackee Pugh');
});

test('a source block of junk fails instead of parsing to [{}]', () => {
  const bare = archive([post({ day: '2026-10-02', frontMatter: `${validPost()}\nsources:\n  - see attached` })]);
  assert.equal(bare.code, 1);
  assert.match(bare.stderr, /\/sources\/0/);

  const mapping = archive([post({ day: '2026-10-02', frontMatter: `${validPost()}\nsources:\n  - note: "trust me"` })]);
  assert.equal(mapping.code, 1);
  assert.match(mapping.stderr, /missing required field 'type' \(at \/sources\/0\)/);
  assert.match(mapping.stderr, /missing required field 'title' \(at \/sources\/0\)/);
  assert.match(mapping.stderr, /missing required field 'retrieved' \(at \/sources\/0\)/);
});

test('a source without retrieved fails', () => {
  const junk = 'sources:\n  - type: document\n    title: "A schedule"';
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost()}\n${junk}` })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /missing required field 'retrieved' \(at \/sources\/0\)/);
});

test('a source without a title fails', () => {
  const junk = 'sources:\n  - type: document\n    retrieved: 2026-10-02';
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost()}\n${junk}` })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /missing required field 'title' \(at \/sources\/0\)/);
});

test('an empty sources list fails', () => {
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost()}\nsources: []` })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /empty sources list/);
});

test('a sources key that was never filled fails', () => {
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost()}\nsources:` })]);
  assert.equal(r.code, 1);
});

// --------------------------------------------------- schema.json really runs

test('a missing required front matter field fails', () => {
  const noDek = validPost().split('\n').filter((l) => !l.startsWith('dek:')).join('\n');
  const r = archive([post({ day: '2026-10-02', frontMatter: `${noDek}\n${VALID_SOURCES}` })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /missing required field 'dek'/);
});

test('an unknown front matter field fails, so a misspelled sourced does not pass', () => {
  const r = archive([post({
    day: '2026-10-02',
    frontMatter: validPost().replace('slug:', 'sourced:\n    - nope\nslug:'),
  })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown field 'sourced'/);
});

test('a bad edition fails', () => {
  const r = archive([post({ day: '2026-10-02', frontMatter: validPost({ edition: 'lunchtime' }) + '\n' + VALID_SOURCES })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /must be one of morning \| evening \| column/);
});

test('a slug that is not kebab-case fails', () => {
  const r = archive([post({ day: '2026-10-02', frontMatter: validPost({ slug: 'Weather_Roundup' }) + '\n' + VALID_SOURCES })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not match/);
});

// ------------------------------------------------------- the rest of the gate

test('a byline that is not on the roster fails', () => {
  // Mara Vance, the Managing Editor, is not on the roster and is not meant to be:
  // the BEL-116 ruling put four reporters and one desk line on it, and a byline
  // asserts authorship, so an editor who did not write the story cannot sign it.
  const r = archive([post({ day: '2026-10-02', frontMatter: validPost({ byline: 'Mara Vance' }) + '\n' + VALID_SOURCES })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /byline 'Mara Vance' is not in roster\.json/);
});

// ------------------------------------------------------------- the desk line
//
// BEL-116 added one desk line, `Belmont News staff`, for copy no single reporter
// files. Bylines are matched on the exact string, capitalisation included, so
// `Belmont News Staff` is a different byline and is refused. That is the intended
// direction: a name one capital letter off is refused rather than filed under the
// desk line. It is also a trap for anyone editing the roster later, so it is
// written down here rather than left to a find-and-replace.

test('the registered desk line may file a post', () => {
  const r = archive([post({
    day: '2026-10-03',
    author: 'belmont-news-staff',
    frontMatter: `${validPost({
      date: '2026-10-03',
      byline: 'Belmont News staff',
      slug: 'a-desk-notice-for-the-bulletin-board',
    })}\n${VALID_SOURCES}`,
  })]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.index.posts[0].byline, 'Belmont News staff');
});

test('a capitalised Staff is not the desk line', () => {
  const r = archive([post({
    day: '2026-10-03',
    author: 'belmont-news-staff',
    frontMatter: `${validPost({
      date: '2026-10-03',
      byline: 'Belmont News Staff',
      slug: 'a-desk-notice-with-the-wrong-capital',
    })}\n${VALID_SOURCES}`,
  })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /byline 'Belmont News Staff' is not in roster\.json/);
});

// ----------------------------------------------------------- column ownership
//
// BEL-55: the News Desk column was named in the runbook and in the Managing
// Editor's instructions but registered under no roster entry. The gate refused it
// for every byline on the roster, including the owner the runbook names, and the
// message read like a byline mistake. A writer who is not the owner cannot fix it
// by changing their byline, so the failure stayed silent for a full edition. Two
// things are locked here: the registration itself, and the message that tells a
// registry gap apart from a byline mistake.
//
// The Managing Editor ruled on BEL-116 twice. The first ruling made ownership a set,
// so a desk could have more than one reporter. The second reversed that half: a
// column is owned by exactly one reporter, and a reporter who needs a column gets one
// of his own. `Lead Desk` is Danica Hoyt's and stays hers, `Morning Briefing` is
// Margaret Vance's, `News Desk` is Rosalind Kimbrough's. Dev Okafor owns
// `County Desk` and Priya Raghunathan owns `Community Desk`, so no column is shared
// and no published column changes hands. The assertion below is therefore the
// original BEL-55 one, byte for byte what it was on `a0a5031b`: one roster entry per
// column. Misattribution is the failure this gate exists to catch, so the guard
// against a column silently changing hands is not relaxed to clear a byline.

test('every column the archive can file is owned by exactly one roster entry', () => {
  const roster = JSON.parse(ROSTER);
  const owners = new Map();
  for (const a of roster.agents) {
    for (const c of a.columns || []) {
      assert.ok(!owners.has(c), `column '${c}' is claimed by both '${owners.get(c)}' and '${a.name}'`);
      owners.set(c, a.name);
    }
  }
  // Every column any filed post uses has to be one of these. A post naming a
  // column nobody registered is the exact shape of the BEL-55 failure.
  for (const name of ['Morning Briefing', 'News Desk', 'Lead Desk']) {
    assert.ok(owners.has(name), `no roster entry owns the column '${name}'`);
  }
  assert.equal(owners.get('News Desk'), 'Rosalind Kimbrough');
});

test('the real reporters own a column each, and no published column moved', () => {
  const roster = JSON.parse(ROSTER);
  const by = (slug) => roster.agents.find((a) => a.slug === slug);

  // The placeholder owners keep the columns the live archive is filed under. Moving
  // one of these reds the gate on posts that are already published, which is the
  // failure BEL-116 was filed against.
  assert.deepEqual(by('margaret-vance').columns, ['Morning Briefing']);
  assert.deepEqual(by('danica-hoyt').columns, ['Lead Desk']);
  assert.deepEqual(by('rosalind-kimbrough').columns, ['News Desk']);

  // The reporters who need a column have one of their own, so nothing is shared.
  assert.deepEqual(by('dev-okafor').columns, ['County Desk']);
  assert.deepEqual(by('priya-raghunathan').columns, ['Community Desk']);
});

test('the roster is the eight placeholders, the four reporters and one desk line', () => {
  // Not every agent in the company. An engineer or an editor on the roster becomes
  // a valid byline for a story they did not write, which makes the gate catch less
  // and not more.
  const roster = JSON.parse(ROSTER);
  const slugs = roster.agents.map((a) => a.slug);
  assert.deepEqual(slugs, [
    'margaret-vance', 'grant-kowalczyk', 'nathan-beausoleil', 'elliot-bramwell',
    'rosalind-kimbrough', 'thandiwe-okonjo', 'corinne-ashby', 'danica-hoyt',
    'dev-okafor', 'priya-raghunathan', 'rosa-delgado', 'hana-ishikawa',
    'belmont-news-staff',
  ]);
});

test('Margaret Vance and Mara Vance are two people, and only one of them files', () => {
  const roster = JSON.parse(ROSTER);
  const margaret = roster.agents.find((a) => a.name === 'Margaret Vance');
  assert.ok(margaret, 'the published Morning Briefing byline must stay on the roster');
  assert.equal(margaret.slug, 'margaret-vance', 'the archive slug is margaret-vance and must not change');
  assert.equal(roster.agents.some((a) => a.name === 'Mara Vance'), false);
});

test('every real reporter may file a non-column edition', () => {
  for (const [author, byline] of [
    ['dev-okafor', 'Dev Okafor'],
    ['priya-raghunathan', 'Priya Raghunathan'],
    ['rosa-delgado', 'Rosa Delgado'],
    ['hana-ishikawa', 'Hana Ishikawa'],
  ]) {
    const r = archive([post({
      day: '2026-10-03',
      author,
      slug: `${author}-evening-edition`,
      frontMatter: `${validPost({
        date: '2026-10-03',
        byline,
        slug: `${author}-evening-edition`,
      })}\n${VALID_SOURCES}`,
    })]);
    assert.equal(r.code, 0, `${byline} must be able to file: ${r.stderr}`);
  }
});

test('the registered News Desk owner may file that column', () => {
  const r = archive([post({
    day: '2026-10-03',
    author: 'rosalind-kimbrough',
    frontMatter: `${frontMatterOf({
      title: '"A headline long enough to clear the schema"',
      dek: '"One sentence under the headline."',
      date: '2026-10-03',
      edition: 'column',
      column: 'News Desk',
      byline: 'Rosalind Kimbrough',
      category: 'news-desk',
      slug: 'news-desk-2026-10-03',
    })}\n${VALID_SOURCES}`,
  })]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.index.posts[0].column, 'News Desk');
});

test('a byline that does not own a registered column is told who does own it', () => {
  const r = archive([post({
    day: '2026-10-03',
    author: 'corinne-ashby',
    frontMatter: `${validPost({ edition: 'column', column: 'News Desk', byline: 'Corinne Ashby', slug: 'not-the-news-desk' })}\n${VALID_SOURCES}`,
  })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /byline 'Corinne Ashby' does not own the column 'News Desk'/);
  // The owner is named, so the writer does not have to guess.
  assert.match(r.stderr, /owned by 'Rosalind Kimbrough'/);
});

test('a reporter may file the column he owns, and only that one', () => {
  // Dev Okafor owns `County Desk`, so he can file it. The case BEL-116 was filed
  // about was a real reporter being refused every column the newsroom could file:
  // extending the roster by byline alone still refused real stories, because the
  // only registered columns belonged to the placeholder bylines.
  const r = archive([post({
    day: '2026-10-03',
    author: 'dev-okafor',
    frontMatter: `${validPost({
      date: '2026-10-03',
      edition: 'column',
      column: 'County Desk',
      byline: 'Dev Okafor',
      slug: 'the-county-desk-may-file-its-own-column',
    })}\n${VALID_SOURCES}`,
  })]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.index.posts[0].column, 'County Desk');

  // Owning one column does not carry the next one. If a reporter could file any
  // column once he owned any column, the ownership map would be decorative.
  const other = archive([post({
    day: '2026-10-03',
    author: 'dev-okafor',
    frontMatter: `${validPost({
      date: '2026-10-03',
      edition: 'column',
      column: 'Lead Desk',
      byline: 'Dev Okafor',
      slug: 'and-not-the-one-he-does-not-own',
    })}\n${VALID_SOURCES}`,
  })]);
  assert.equal(other.code, 1);
  assert.match(other.stderr, /byline 'Dev Okafor' does not own the column 'Lead Desk'/);
  assert.match(other.stderr, /owned by 'Danica Hoyt'/);
});

test('a column no roster entry owns says so, instead of reading as a byline mistake', () => {
  const r = archive([post({
    day: '2026-10-03',
    author: 'rosalind-kimbrough',
    frontMatter: `${validPost({ edition: 'column', column: 'Evening Desk', byline: 'Rosalind Kimbrough', slug: 'unregistered-column' })}\n${VALID_SOURCES}`,
  })]);
  assert.equal(r.code, 1);
  // No byline change fixes this one. The message has to say that it is a missing
  // registration in roster.json, or the writer rewrites their own front matter
  // forever and the real defect stays where it was.
  assert.match(r.stderr, /no agent in roster\.json owns that column at all/);
  assert.match(r.stderr, /missing registration in roster\.json, not a byline mistake/);
});

test('a day folder that disagrees with the front matter date fails', () => {
  const r = archive([post({ day: '2026-10-02', frontMatter: validPost({ date: '2026-10-03' }) + '\n' + VALID_SOURCES })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /does not match day folder 2026-10-02/);
});

test('an unknown front matter field on a scalar key fails', () => {
  const r = archive([post({ day: '2026-10-02', frontMatter: validPost() + '\nauthor: Nathan\n' + VALID_SOURCES })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /unknown field 'author'/);
});

// ------------------------------------------------------- the list parser

test('a list of scalars parses as scalars and survives the schema', () => {
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost()}\ntags:\n  - weather\n  - fair\n${VALID_SOURCES}` })]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.index.posts[0].tags, ['weather', 'fair']);
});

test('every list item becomes its own object, not the first one again', () => {
  const three = [
    'sources:',
    '  - type: document',
    '    title: "First"',
    '    retrieved: 2026-10-02',
    '  - type: document',
    '    title: "Second"',
    '    retrieved: 2026-10-02',
    '  - type: human',
    '    title: "Third"',
    '    retrieved: 2026-10-02',
  ].join('\n');
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost()}\n${three}` })]);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(r.index.posts[0].sources.map((s) => s.title), ['First', 'Second', 'Third']);
  assert.deepEqual(r.index.posts[0].sources.map((s) => s.type), ['document', 'document', 'human']);
});

test('a corrections list parses and reaches the index', () => {
  const corrections = 'corrections:\n  - date: 2026-10-04\n    correction: "Temperature was high, not low."';
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost()}\n${corrections}\n${VALID_SOURCES}` })]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.index.posts[0].corrections.length, 1);
  assert.equal(r.index.posts[0].corrections[0].date, '2026-10-04');
});

test('a correction without text fails', () => {
  const corrections = 'corrections:\n  - date: 2026-10-04';
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost()}\n${corrections}\n${VALID_SOURCES}` })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /missing required field 'correction'/);
});
// --------------------------------------------------- the expires field (BEL-101)
//
// `expires` is a listing field, not an editorial one: it says how long a post
// stays on the site's rolling front page, and it changes nothing about whether
// the post may be filed. These cases are about the value being well formed, so a
// typo fails at the pull request that introduced it rather than at deploy time.
//
// Nothing here touches the sourcing rule or the date window. The date window
// keeps its forward-only shape and still has no backward half.

test('a post with no expires field passes, because the field is optional', () => {
  // The default needs no field at all: the site lists a post for two newsroom
  // days counting its own. Every post in the archive relies on this.
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost()}\n${VALID_SOURCES}` })]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.index.posts[0].expires, undefined);
});

test('a plain expires day passes and reaches the index', () => {
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost({ expires: '2026-10-30' })}\n${VALID_SOURCES}` })]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.index.posts[0].expires, '2026-10-30');
});

test('an expires on the post own day passes', () => {
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost({ expires: '2026-10-02' })}\n${VALID_SOURCES}` })]);
  assert.equal(r.code, 0, r.stderr);
});

test('an expires carrying a time of day is refused', () => {
  // The newsroom changes offset on 2026-11-01. A rule that read the date part and
  // dropped the offset would be right for half the year and wrong for the other
  // half, so there is one accepted shape and it carries no time.
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost({ expires: '2026-10-30T06:00:00-04:00' })}\n${VALID_SOURCES}` })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /expires/);
});

test('an expires day that does not exist is refused', () => {
  // These all have the right shape and are not dates. Compared as text they sort
  // after every real day, so a shape-only check would hold the post listed
  // forever and report nothing wrong.
  for (const day of ['2026-13-45', '2026-02-30', '2026-00-10', '2026-10-00']) {
    const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost({ expires: day })}\n${VALID_SOURCES}` })]);
    assert.equal(r.code, 1, `${day} must be refused`);
    assert.match(r.stderr, /expires must be a real calendar day/);
  }
});

test('an expires before the posts own date is refused as a typo', () => {
  const r = archive([post({ day: '2026-10-02', frontMatter: `${validPost({ expires: '2026-10-01' })}\n${VALID_SOURCES}` })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /before the post's own date 2026-10-02/);
});

test('expires does not weaken the date window or the sourcing rule', () => {
  // The two properties the archive depends on, re-checked with the field present.
  // An old post with an expires field must still pass: expiry is a listing rule
  // and the date window keeps no backward half.
  const old = archive([
    post({ day: '2026-09-01', frontMatter: frontMatterOf({
      title: '"A headline long enough to clear the schema"',
      dek: '"One sentence under the headline."',
      date: '2026-09-01',
      edition: 'evening',
      byline: 'Nathan Beausoleil',
      category: 'weather',
      slug: 'an-old-post',
      expires: '2026-09-02',
    }) + `\n${VALID_SOURCES}` }),
  ], ['--today', '2026-10-03']);
  assert.equal(old.code, 0, `an old post with expires must still pass the window: ${old.stderr}`);

  // And an expires field does not make an unsourced post publishable.
  const unsourced = archive([post({ day: '2026-10-02', frontMatter: validPost({ expires: '2026-10-30' }) })]);
  assert.equal(unsourced.code, 1);
  assert.match(unsourced.stderr, /sources/);
});

// ------------------------------------------- BEL-132: a JSON body is not prose
//
// A publish step took a document API response and wrote the whole envelope into
// the markdown below the front matter, instead of the envelope's `body` field.
// Every other gate passed, because the front matter was correct: the path was
// right, the byline was in the roster, the sources were named. The site built,
// the deploy went out, and the reader got a page whose body was one escaped
// JSON object with the store's internal ids printed in it.
//
// The post had also expired, so it dropped off the front page and out of
// feed.xml and no QA pass opened it, while sitemap.xml still pointed at it.

const ENVELOPE_BODY = `${JSON.stringify({
  id: '022ea0dc-0996-4b21-8b25-21c2fe34e21f',
  companyId: 'e932f2d1-8b59-4754-a733-7e1f5428778c',
  issueId: '1e4c01a0-61c5-40eb-b1ad-bd8cdad57b49',
  key: 'morning-briefing-2026-10-02-evening',
  title: 'Morning Briefing - Evening Edition 2026-10-02 20:00 EDT',
  format: 'markdown',
  body: '# Morning Briefing\n\n**By Margaret Vance.** The shower chance is behind us.\n',
  latestRevisionId: '83ef1278-af12-4287-895d-637f1561d818',
  createdByAgentId: '367c5a4f-a12f-41f8-9028-facc3b20e105',
  annotations: [],
})}\n`;

test('the gate refuses a post whose body is a serialised API response', () => {
  const r = archive([post({
    day: '2026-10-02',
    frontMatter: validPost() + '\n' + VALID_SOURCES,
    body: ENVELOPE_BODY,
  })]);
  assert.equal(r.code, 1, 'an API envelope as a post body must fail the gate');
  assert.match(r.stderr, /serialised API response/);
});

test('the envelope is refused on its shape, and names the fix in the message', () => {
  // The error has to be actionable. Whoever files a post after seeing this has
  // to be told what to write instead, not just that the gate is unhappy.
  const r = archive([post({
    day: '2026-10-02',
    frontMatter: validPost() + '\n' + VALID_SOURCES,
    body: ENVELOPE_BODY,
  })]);
  assert.match(r.stderr, /"body" field/);
  assert.match(r.stderr, /fenced code block/);
});

test('the envelope is caught even when the front matter is perfectly valid', () => {
  // This is the whole failure. Nothing else about the file was wrong, so a gate
  // that only looked at the front matter would have published it.
  const only = archive([post({
    day: '2026-10-02',
    frontMatter: validPost() + '\n' + VALID_SOURCES,
    body: ENVELOPE_BODY,
  })], ['--check']);
  assert.equal(only.code, 1);
  // And the one thing it reports is the body, not a pile of unrelated noise.
  assert.equal((only.stderr.match(/serialised API response/g) || []).length, 1);
});

test('an ordinary prose body still passes', () => {
  const r = archive([post({
    day: '2026-10-02',
    frontMatter: validPost() + '\n' + VALID_SOURCES,
    body: 'The forecast reads **73 degrees** and the desk logged it.\n',
  })]);
  assert.equal(r.code, 0, `prose must pass: ${r.stderr}`);
});

test('prose that merely contains a brace or inline JSON still passes', () => {
  // A gate that refused any body starting with a brace would refuse real copy.
  for (const body of [
    'The forecast reads {high 73} today, and the desk logged it.\n',
    'The response was {"ok":true} and nothing else came back.\n',
  ]) {
    const r = archive([post({ day: '2026-10-02', frontMatter: validPost() + '\n' + VALID_SOURCES, body })]);
    assert.equal(r.code, 0, `this prose must pass: ${body.trim()} -> ${r.stderr}`);
  }
});

test('a post that quotes JSON in a fenced code block still passes', () => {
  // A JSON sample is legitimate newsroom copy when it is marked as one. The
  // check reads the body with fenced blocks removed, so quoting a payload is
  // not confused with having shipped one.
  const r = archive([post({
    day: '2026-10-02',
    frontMatter: validPost() + '\n' + VALID_SOURCES,
    body: 'A reader sent us this payload:\n\n```json\n{"id":"abc","companyId":"x","body":"hi"}\n```\n\nIt parsed clean on the first try.\n',
  })]);
  assert.equal(r.code, 0, `a fenced JSON sample must pass: ${r.stderr}`);
});

test('an object with no body field is not treated as an envelope', () => {
  // The envelope signature is a nested article string. A post that is
  // legitimately a JSON object without one is not this defect.
  const r = archive([post({
    day: '2026-10-02',
    frontMatter: validPost() + '\n' + VALID_SOURCES,
    body: '{"station":"K20","high":73}\n',
  })]);
  assert.equal(r.code, 0, r.stderr);
});
