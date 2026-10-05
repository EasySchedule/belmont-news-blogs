// The build gate, tested. Run with: node --test
//
// Every case here is a way the gate used to be wrong, or a way it has to stay
// wrong-proof. The gate is the editorial standard, so a hole in it is a hole in
// the newsroom's sourcing rule. Run this after any change to index.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
  // A current byline, not the fixture default. The default is a retired name and
  // this post is dated after the retirement day, so leaving it would have this
  // test measuring the retirement rule instead of the date window.
  const posts = [post({
    day: '2026-10-06',
    author: 'dev-okafor',
    frontMatter: validPost({ date: '2026-10-06', byline: 'Dev Okafor' }) + '\n' + VALID_SOURCES,
  })];
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
// Margaret Vance's. Dev Okafor owns `County Desk` and Priya Raghunathan owns
// `Community Desk`, so no column is shared. The assertion below is therefore the
// original BEL-55 one, byte for byte what it was on `a0a5031b`: one roster entry per
// column. Misattribution is the failure this gate exists to catch, so the guard
// against a column silently changing hands is not relaxed to clear a byline.
//
// BEL-192 moved one column. `News Desk` was registered under `Rosalind Kimbrough`,
// a placeholder byline, and PR #18 retires that byline at 2026-10-03. A retired
// byline may file the archive and nothing after it, so once #18 lands no byline at
// all can file `News Desk`. The desk ruled the column transfers to a live byline,
// `Rosa Delgado`. Nothing in the archive moves with it: no post has ever named
// `News Desk` as its column, so there is no published post filed under the old owner
// to go red. The transfer is a change of name in the registry, not a rewrite of
// published bylines.

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
  for (const name of ['Morning Briefing', 'News Desk', 'Lead Desk', 'County Desk', 'Community Desk']) {
    assert.ok(owners.has(name), `no roster entry owns the column '${name}'`);
  }
  assert.equal(owners.get('News Desk'), 'Rosa Delgado');
});

test('the real reporters own a column each, and no published column moved', () => {
  const roster = JSON.parse(ROSTER);
  const by = (slug) => roster.agents.find((a) => a.slug === slug);

  // The placeholder owners keep the columns the live archive is filed under. Moving
  // one of these reds the gate on posts that are already published, which is the
  // failure BEL-116 was filed against.
  assert.deepEqual(by('margaret-vance').columns, ['Morning Briefing']);
  assert.deepEqual(by('danica-hoyt').columns, ['Lead Desk']);

  // `News Desk` used to sit here and does not any more. Rosalind Kimbrough owns no
  // column now: PR #18 retires her byline, so a column filed under her would be
  // unfileable the moment that PR lands. Pinned because the move is the ruling and
  // the suite is where the ruling stops drifting.
  assert.deepEqual(by('rosalind-kimbrough').columns, []);

  // The reporters who need a column have one of their own, so nothing is shared.
  assert.deepEqual(by('dev-okafor').columns, ['County Desk']);
  assert.deepEqual(by('priya-raghunathan').columns, ['Community Desk']);
  assert.deepEqual(by('rosa-delgado').columns, ['News Desk']);
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

// ------------------------------------------------------- retired bylines
//
// Keeping the eight placeholders on the roster is what keeps the published posts
// valid: every one of them is bylined to a placeholder name, and dropping an
// entry reds the gate on those posts and stops the site updating for everyone.
// It also leaves those names fileable for new work, so a placeholder name could
// sign tomorrow's story and the gate would pass it — a byline asserting
// authorship for a writer who does not exist, which is the exact defect the gate
// exists to catch, and the one already found once on the live site. A retired
// entry closes that without touching the archive: valid up to its last day,
// refused after it.

test('every placeholder byline is retired and no real byline is', () => {
  const roster = JSON.parse(ROSTER);
  const placeholders = roster.agents.slice(0, 8).map((a) => a.slug);
  for (const a of roster.agents) {
    if (placeholders.includes(a.slug)) {
      assert.match(a.retired || '', /^\d{4}-\d{2}-\d{2}$/, `${a.slug} must carry a retirement day`);
    } else {
      assert.equal(a.retired, undefined, `${a.slug} is a current byline and must not be marked retired`);
    }
  }
  // One day, for all eight, and it is the newest post already filed under them.
  const days = new Set(roster.agents.map((a) => a.retired).filter(Boolean));
  assert.equal(days.size, 1, `the placeholders should retire on one day, got ${[...days]}`);
});

test('the retirement day is the newest published post under a placeholder byline', () => {
  // If a post is ever filed under a placeholder byline dated after the
  // retirement day, the archive and the gate disagree and the fix is wrong. This
  // reads the archive rather than trusting the constant.
  const roster = JSON.parse(ROSTER);
  const retired = roster.agents.filter((a) => a.retired);
  const names = new Set(retired.map((a) => a.name));
  const days = new Set(retired.map((a) => a.retired));
  assert.equal(days.size, 1, 'the eight placeholders must retire together');
  const cutoff = [...days][0];

  let newest = null;
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.md')) continue;
      const text = readFileSync(full, 'utf8');
      const byline = /^byline:\s*(.+)$/m.exec(text)?.[1]?.trim();
      const date = /^date:\s*(\d{4}-\d{2}-\d{2})$/m.exec(text)?.[1];
      if (!byline || !date || !names.has(byline)) continue;
      if (!newest || date > newest) newest = date;
    }
  };
  walk(join(REPO, 'content'));
  assert.ok(newest, 'no published post is bylined to a placeholder name');
  assert.ok(newest <= cutoff,
    `a published post is bylined to a placeholder on ${newest}, after the retirement day ${cutoff}`);
});

test('a malformed retirement day is refused at load, not silently ignored', () => {
  // The rule compares `retired` as text against the post's date, so a malformed day
  // does not fail where anyone would notice: it sorts wrong and the rule stops
  // firing. An unpadded `2026-10-3` reads as later than every real day in October,
  // so a post dated the 20th would be accepted under a byline meant to be closed,
  // with the whole archive green. Measured on this branch before fixing it.
  //
  // So the day is validated when the roster loads, like `expires` is. The message
  // has to name the entry and the value, because a roster typo has to be fixable
  // from the message alone.
  const root = writeArchive([post({
    day: '2026-10-06',
    author: 'danica-hoyt',
    slug: 'new-work-after-a-malformed-retirement-day',
    frontMatter: `${validPost({ date: '2026-10-06', byline: 'Danica Hoyt', slug: 'new-work-after-a-malformed-retirement-day' })}\n${VALID_SOURCES}`,
  })]);
  try {
    for (const bad of ['2026-10-3', '2026-13-01', '2026-02-30', 'Oct 3 2026', '']) {
      const roster = JSON.parse(ROSTER);
      roster.agents.find((a) => a.slug === 'danica-hoyt').retired = bad;
      writeFileSync(join(root, 'roster.json'), JSON.stringify(roster, null, 2));
      const r = runGate(root, []);
      assert.equal(r.code, 2, `retired ${JSON.stringify(bad)} must fail the build: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /'Danica Hoyt' has retired/);
      assert.match(r.stderr, /real calendar day as YYYY-MM-DD/);
    }
    // A real day in the same field must still be accepted, or the check above would
    // pass by refusing everything. The post is dated 2026-10-06, so a retirement on
    // that same day is the boundary: on or before it may still sign the post.
    const roster = JSON.parse(ROSTER);
    roster.agents.find((a) => a.slug === 'danica-hoyt').retired = '2026-10-06';
    writeFileSync(join(root, 'roster.json'), JSON.stringify(roster, null, 2));
    const good = runGate(root, []);
    assert.equal(good.code, 0, `a real retirement day must still be accepted: ${good.stderr}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a retired byline is refused for new work', () => {
  for (const a of JSON.parse(ROSTER).agents.filter((x) => x.retired)) {
    const day = '2026-10-06';
    assert.ok(day > a.retired, `${a.slug} must already be retired by ${day}`);
    const r = archive([post({
      day,
      author: a.slug,
      slug: 'new-work-under-a-retired-byline',
      frontMatter: `${validPost({ date: day, byline: a.name, slug: 'new-work-under-a-retired-byline' })}\n${VALID_SOURCES}`,
    })]);
    assert.equal(r.code, 1, `${a.name} must not be able to sign a post dated ${day}: ${r.stderr}`);
    assert.match(r.stderr, new RegExp(`byline '${a.name}' was retired after ${a.retired}`));
    // The message has to say what to do, or the writer is left guessing.
    assert.match(r.stderr, /archive only/);
    assert.match(r.stderr, /file new work under a current byline/);
  }
});

test('a retired byline is still accepted for the archive', () => {
  // The fix must not invalidate filed work. The published posts are all dated on
  // or before the retirement day, so they keep building.
  for (const a of JSON.parse(ROSTER).agents.filter((x) => x.retired)) {
    for (const day of [a.retired, '2026-10-02']) {
      const r = archive([post({
        day,
        author: a.slug,
        slug: 'archived-work-under-a-placeholder-byline',
        frontMatter: `${validPost({ date: day, byline: a.name, slug: 'archived-work-under-a-placeholder-byline' })}\n${VALID_SOURCES}`,
      })]);
      assert.equal(r.code, 0, `${a.name} must still file an archive post dated ${day}: ${r.stderr}`);
    }
  }
});

test('the real newsroom is not affected by the retirement rule', () => {
  for (const [slug, name] of [
    ['dev-okafor', 'Dev Okafor'],
    ['priya-raghunathan', 'Priya Raghunathan'],
    ['rosa-delgado', 'Rosa Delgado'],
    ['hana-ishikawa', 'Hana Ishikawa'],
    ['belmont-news-staff', 'Belmont News staff'],
  ]) {
    const r = archive([post({
      day: '2026-10-06',
      author: slug,
      slug: 'current-byline-new-work',
      frontMatter: `${validPost({ date: '2026-10-06', byline: name, slug: 'current-byline-new-work' })}\n${VALID_SOURCES}`,
    })]);
    assert.equal(r.code, 0, `${name} must be able to file new work: ${r.stderr}`);
  }
});

test('a reporter keeps the column ownership the roster gives them', () => {
  // The two rulings have to hold together: Dev Okafor owns the County Desk and
  // Priya Raghunathan the Community Desk, and retiring the placeholders must not
  // cost either of them that.
  for (const [slug, name, column] of [
    ['dev-okafor', 'Dev Okafor', 'County Desk'],
    ['priya-raghunathan', 'Priya Raghunathan', 'Community Desk'],
  ]) {
    const r = archive([post({
      day: '2026-10-06',
      author: slug,
      slug: 'desk-column-from-the-real-desk',
      frontMatter: `${validPost({
        date: '2026-10-06',
        edition: 'column',
        column,
        byline: name,
        slug: 'desk-column-from-the-real-desk',
      })}\n${VALID_SOURCES}`,
    })]);
    assert.equal(r.code, 0, `${name} must still be able to file the ${column}: ${r.stderr}`);
  }

  // The refusal is the half that matters. Everything above would still pass if the
  // retirement rule had quietly widened who may file a column, because it only ever
  // asks the gate to let someone through. This asks it to turn someone away.
  const notHis = archive([post({
    day: '2026-10-06',
    author: 'rosa-delgado',
    slug: 'county-desk-from-a-reporter-who-does-not-own-it',
    frontMatter: `${validPost({
      date: '2026-10-06',
      edition: 'column',
      column: 'County Desk',
      byline: 'Rosa Delgado',
      slug: 'county-desk-from-a-reporter-who-does-not-own-it',
    })}\n${VALID_SOURCES}`,
  })]);
  assert.equal(notHis.code, 1, 'a live reporter must still be refused a column nobody gave him');
  assert.match(notHis.stderr, /byline 'Rosa Delgado' does not own the column 'County Desk'/);
  assert.match(notHis.stderr, /owned by 'Dev Okafor'/);
  // The refusal has to be about ownership, not retirement: Rosa Delgado is a current
  // byline, so if the retirement rule were what stopped her the message would name a
  // day instead of an owner.
  assert.doesNotMatch(notHis.stderr, /retired/);

  // And the other direction: a placeholder who still owns a column keeps it for the
  // archive. Danica Hoyt retires on 2026-10-03 and owns Lead Desk, so on that day
  // she may still sign it.
  const archiveDay = archive([post({
    day: '2026-10-03',
    author: 'danica-hoyt',
    slug: 'lead-desk-under-a-retired-byline',
    frontMatter: `${validPost({
      date: '2026-10-03',
      edition: 'column',
      column: 'Lead Desk',
      byline: 'Danica Hoyt',
      slug: 'lead-desk-under-a-retired-byline',
    })}\n${VALID_SOURCES}`,
  })]);
  assert.equal(archiveDay.code, 0, `a retired byline must still file its own column on its last day: ${archiveDay.stderr}`);
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
    day: '2026-10-05',
    author: 'rosa-delgado',
    frontMatter: `${frontMatterOf({
      title: '"A headline long enough to clear the schema"',
      dek: '"One sentence under the headline."',
      date: '2026-10-05',
      edition: 'column',
      column: 'News Desk',
      byline: 'Rosa Delgado',
      category: 'news-desk',
      slug: 'news-desk-2026-10-05',
    })}\n${VALID_SOURCES}`,
  })]);
  assert.equal(r.code, 0, r.stderr);
  assert.equal(r.index.posts[0].column, 'News Desk');
});

test('News Desk has a live owner, so the placeholder retirement cannot close it', () => {
  // The BEL-192 defect, stated as an assertion. PR #18 retires eight placeholder
  // bylines at 2026-10-03 and refuses them for anything dated after that day. While
  // the only registered owner of `News Desk` was one of those bylines, the column had
  // no fileable owner at all and the refusal named an owner who could no longer sign
  // anything. A live owner is what closes it, so the roster entry is checked for the
  // property the ruling is actually about: not retired, and a distinct person from
  // the eight placeholders.
  const roster = JSON.parse(ROSTER);
  const newsDesk = roster.agents.find((a) => (a.columns || []).includes('News Desk'));
  assert.ok(newsDesk, 'no roster entry owns the column \'News Desk\'');

  const placeholders = [
    'margaret-vance', 'grant-kowalczyk', 'nathan-beausoleil', 'elliot-bramwell',
    'rosalind-kimbrough', 'thandiwe-okonjo', 'corinne-ashby', 'danica-hoyt',
  ];
  assert.ok(!placeholders.includes(newsDesk.slug),
    `News Desk is owned by the placeholder byline '${newsDesk.name}', who PR #18 retires`);
  // Only the retirement rule PR #18 adds can close a column, and it keys off this.
  assert.equal(newsDesk.retired, undefined,
    `the owner of News Desk is retired at ${newsDesk.retired}, so no byline can file it`);
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
  assert.match(r.stderr, /owned by 'Rosa Delgado'/);
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
    post({ day: '2026-09-01', author: 'dev-okafor', frontMatter: frontMatterOf({
      title: '"A headline long enough to clear the schema"',
      dek: '"One sentence under the headline."',
      date: '2026-09-01',
      edition: 'evening',
      byline: 'Dev Okafor',
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

// ============================================================ the tense scan
//
// BEL-309, authorised on BEL-317 (Mara Vance) and shaped on BEL-316 (Tobias
// Nkemelu). scripts/tense-scan.mjs reports candidate time-anchored phrases as
// pull-request annotations. It exits 0 always, writes nothing, and is never a
// reason to stop a merge.
//
// What these cases protect, in order of how badly it would hurt if they broke:
//
//   1. That the scan still finds anything. A warning tool that quietly finds
//      nothing is the same failure as a gate that quietly reads no source, and
//      this repo has already paid for that twice.
//   2. That the line numbers are the numbers in the file. The entire value of
//      the tool is "open this line". A line number off by one and the person
//      opens the wrong sentence and stops trusting it.
//   3. That an allowance covers ONE occurrence, and only with a reason.
//   4. That it cannot fail a build, including when it is broken itself.
//
// The counts here are against a frozen fixture, never against the live archive.
// Mara's correction on BEL-317: the moment somebody corrects a post the live
// count drops and a word-list assertion fails, which is the failing gate she
// banned arriving through the test suite instead of the workflow. The live
// archive gets exit 0 and a printed window value, and nothing else.

const SCAN = join(REPO, 'scripts', 'tense-scan.mjs');

function runScan(contentDir, args = []) {
  const r = { code: 0, stdout: '', stderr: '' };
  try {
    r.stdout = execFileSync('node', [SCAN, '--content', contentDir, ...args], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (e) {
    r.code = e.status;
    r.stdout = e.stdout || '';
    r.stderr = e.stderr || '';
  }
  return r;
}

function scanFixture(posts, args = []) {
  const root = mkdtempSync(join(tmpdir(), 'belmont-tense-'));
  try {
    for (const p of posts) {
      const full = join(root, 'content', p.file);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, `---\n${p.frontMatter}\n---\n\n${p.body}`);
    }
    const r = runScan(join(root, 'content'), ['--json', ...args]);
    let report = null;
    try { report = JSON.parse(r.stdout); } catch { /* left null so the assertion says so */ }
    return { ...r, report };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// The known hits, frozen. Nine hits across eight lines, which is what the
// archive carries for QA's token list on BEL-162, copied out of `main` at 4164531
// as literals so this suite does not start failing because a desk corrected a
// post. That is the whole point of freezing them. One line carries two hits
// (the career-expo promotions line reads both "Today" and "today"), which is
// why the count and the line count are not the same number.
//
// Four of the nine are the National Weather Service period name "Tonight" and
// three are copy the human pass has already ruled correct. One is the live
// defect: "Council meets tonight." in a post with no weather source of any kind.
// slug, the line as the post writes it, and the hits that line carries, in the
// casing the post uses. A line can carry more than one: the promotions line
// below reads both "Today" and "today", which is why nine hits live on eight
// lines and why this is a list of lists rather than a list of words.
const KNOWN_LINES = [
  ['morning-briefing-2026-10-02', 'period "Tonight". Cleared.', ['Tonight']],
  ['weather-roundup', 'Its OHZ059 segment reads: tonight, "Considerable cloudiness."', ['tonight']],
  ['wall-that-heals-lead', '**last chance** - hours, address, what happened that evening.', ['last chance']],
  ['morning-briefing-2026-10-03', 'Source: NWS, period 1 "Tonight" (2026-10-02T18:00).', ['Tonight']],
  ['barnesville', 'Council meets tonight. The village posted a notice.', ['tonight']],
  ['career-expo-lanes', 'Two lanes are currently maintained on I-70 in both directions.', ['currently']],
  ['career-expo-promos', '- **Today, Mon. Oct. 5** - Promotions begin today and run through Oct. 26.', ['Today', 'today']],
  ['wall-that-heals-26', 'A re-check at roughly 09:2x-09:3x EDT today, to a plain fetch.', ['today']],
];

const KNOWN_HITS = KNOWN_LINES.flatMap(([, , hits]) => hits);

function fixturePost({ day = '2026-10-03', slug, frontMatter, body = 'Body copy.\n' }) {
  return post({ day, slug, author: 'nathan-beausoleil', frontMatter: frontMatter ?? validPost({ date: day }), body });
}

test('the scan finds all nine known lines and reports each one', () => {
  const posts = KNOWN_LINES.map(([slug, line]) => fixturePost({
    slug,
    body: `## Section\n\n${line}\n`,
  }));
  const { code, report } = scanFixture(posts, ['--today', '2026-10-06']);
  assert.equal(code, 0, `the scan must exit 0: ${JSON.stringify(report)?.slice(0, 400)}`);
  assert.ok(report, 'the scan must print a report');
  assert.equal(report.hits.length, 9, 'nine hits are known here, across eight lines');
  // `token` is the canonical word from QA's list; `match` is what the post
  // actually says. Comparing the match pins the casing as well, which is part
  // of what a reader sees on the line.
  const found = report.hits.map((h) => h.match).sort();
  assert.deepEqual(
    found,
    KNOWN_HITS.slice().sort(),
    'every known hit must still be found, with the casing the post uses. If this fails, the scan has stopped reading the prose and the tool is worse than nothing.',
  );
});

test('every hit carries the file, the line, the date and the window it read', () => {
  const posts = KNOWN_LINES.map(([slug, line]) => fixturePost({
    slug,
    body: `## Section\n\n${line}\n`,
  }));
  const { report } = scanFixture(posts, ['--today', '2026-10-06']);
  assert.equal(report.listingDays, 2, 'the window must be read from scripts/listing-days.mjs');
  assert.equal(report.listingDaysSource, 'scripts/listing-days.mjs');
  for (const h of report.hits) {
    assert.match(h.file, /\.md$/, 'a hit must name its file');
    assert.ok(Number.isInteger(h.line) && h.line > 0, `a hit must name its line: ${JSON.stringify(h)}`);
    assert.equal(h.date, '2026-10-03', 'a hit must carry the post date');
    assert.equal(h.window, 'out-of-window', `2026-10-03 is out of a 2-day window on 2026-10-06: ${h.window}`);
    assert.equal(h.eventEnds, null, 'eventEnds is absent, which is a complete answer');
  }
});

test('a hit carries the line number a human sees in the file', () => {
  // The one property the whole tool rests on: the printed line is the line in
  // the editor. Front matter is skipped, so the body line numbers must not
  // restart at 1. This pins an off-by-one that would otherwise ship silently.
  const front = [
    'title: "A headline long enough to clear the schema"',
    'dek: "One sentence under the headline."',
    'date: 2026-10-03',
    'edition: evening',
    'byline: Nathan Beausoleil',
    'category: weather',
    'slug: line-numbers',
    'tags:',
    '  - weather',
    'corrections:',
    '  - date: 2026-10-05',
    '    correction: "The headline read showers, and the sentence said tonight."',
  ].join('\n');
  const body = 'Line one.\n\nLine two.\n\nCouncil meets tonight.\n\nLine four.\n';
  const { report } = scanFixture([fixturePost({ slug: 'line-numbers', frontMatter: front, body })], ['--today', '2026-10-06']);

  assert.equal(report.hits.length, 1, `exactly one hit expected: ${JSON.stringify(report.hits)}`);
  // 13 front matter lines, plus the opening and closing delimiters, plus the
  // blank line index.mjs writes: the body's first line is 16.
  const written = body.split('\n').findIndex((l) => l.includes('tonight')) + 1;
  assert.equal(report.hits[0].line, 15 + written, `line number must match the body text, got ${report.hits[0].line} for body line ${written}`);
});

test('front matter is skipped, so the record of a correction is not a live hit', () => {
  // Two of the nine known hits on `main` are corrections[] entries recording the
  // 2026-10-05 correction for this exact defect. A scan that flags the record of
  // a fix teaches reporters to hate it.
  const front = validPost({ slug: 'fm-skip' }) + '\n' + VALID_SOURCES + '\n' + [
    'corrections:',
    '  - date: 2026-10-05',
    '    correction: "The headline read showers before eight tonight, and the sentence agreed."',
  ].join('\n');
  const { report } = scanFixture([fixturePost({ slug: 'fm-skip', frontMatter: front, body: 'Ordinary copy with no bare token.\n' })], ['--today', '2026-10-06']);
  assert.deepEqual(report.hits, [], 'front matter must not be scanned');
});

test('fenced code is skipped, and a fenced line keeps its number', () => {
  const body = [
    'Council meets tonight.',            // line 1 of the body
    '',
    'A reader sent us this transcript:',
    '',
    '```',
    'Tonight  Clear.  Cleared.  tonight.',
    '```',
    '',
    'It parsed clean on the first try.',
  ].join('\n');
  const { report } = scanFixture([fixturePost({ slug: 'fenced', body: body + '\n' })], ['--today', '2026-10-06']);
  assert.equal(report.hits.length, 1, `only the prose line is a hit: ${JSON.stringify(report.hits)}`);
  assert.match(report.hits[0].text, /^Council meets tonight/);
});

test('there is no block-quote exemption, deliberately', () => {
  // BEL-317 condition 6: skip front matter and fenced code, nothing else. On
  // `main` there are three block-quote lines in the whole archive, all of them a
  // street address, and the authorised-looking NWS hit is our own prose OUTSIDE
  // the quotation marks. A block-quote skip would exempt nothing. Pinned so a
  // future reader does not add one on the assumption that it helps.
  const { report } = scanFixture([fixturePost({
    slug: 'quoted',
    body: '> Council meets tonight and the hall fills up.\n',
  })], ['--today', '2026-10-06']);
  assert.equal(report.hits.length, 1, 'a block-quoted line is still reported');
  assert.equal(report.hits[0].token, 'tonight');
});

test('an allowance needs context and a reason, and covers one occurrence only', () => {
  // Ruled on BEL-316: context is the verbatim substring of the line the token
  // sits on, so an entry exempts that occurrence. Mara on BEL-317: no reason, no
  // allowance. Both enforced here, and the schema enforces them independently.
  const front = validPost({ slug: 'allowance' }) + '\n' + VALID_SOURCES + '\n' + [
    'quotedTokens:',
    '  - token: tonight',
    '    context: "segment reads: tonight"',
    '    reason: "NWS Zone Forecast Product FPUS51 KPBZ 022102, issued 2026-10-02"',
  ].join('\n');
  const body = [
    'Its OHZ059 segment reads: tonight, "Considerable cloudiness."',
    '',
    'Council meets tonight, and the hall fills up.',
  ].join('\n') + '\n';
  const { report } = scanFixture([fixturePost({ slug: 'allowance', frontMatter: front, body })], ['--today', '2026-10-06']);

  assert.deepEqual(report.allowanceProblems, [], 'a complete allowance must raise no problem');
  assert.equal(report.allowed.length, 1, 'the covered occurrence is recorded as allowed');
  assert.match(report.allowed[0].reason, /FPUS51 KPBZ 022102/);
  assert.equal(report.hits.length, 1, 'the second occurrence of the same word is still reported');
  assert.match(report.hits[0].text, /^Council meets tonight/);
});

test('an allowance whose context is not the line does not exempt anything', () => {
  const front = validPost({ slug: 'bad-context' }) + '\n' + VALID_SOURCES + '\n' + [
    'quotedTokens:',
    '  - token: tonight',
    '    context: "Tonight, capitalised, and the wrong line"',
    '    reason: "NWS Zone Forecast Product FPUS51 KPBZ 022102, issued 2026-10-02"',
  ].join('\n');
  const { report } = scanFixture([fixturePost({
    slug: 'bad-context',
    frontMatter: front,
    body: 'Its OHZ059 segment reads: tonight, "Considerable cloudiness."\n',
  })], ['--today', '2026-10-06']);
  assert.equal(report.allowed.length, 0, 'a context that is not on the line exempts nothing');
  assert.equal(report.hits.length, 1, 'the hit is still reported');
});

test('an allowance with no reason is not an allowance', () => {
  const front = validPost({ slug: 'no-reason' }) + '\n' + VALID_SOURCES + '\n' + [
    'quotedTokens:',
    '  - token: tonight',
    '    context: "segment reads: tonight"',
  ].join('\n');
  const { report } = scanFixture([fixturePost({
    slug: 'no-reason',
    frontMatter: front,
    body: 'Its OHZ059 segment reads: tonight, "Considerable cloudiness."\n',
  })], ['--today', '2026-10-06']);
  assert.equal(report.allowed.length, 0, 'no reason, no allowance');
  assert.equal(report.hits.length, 1, 'the hit is still reported');
  assert.match(report.allowanceProblems.join('\n'), /no reason/);
});

test('an inline quotedTokens array is refused by the gate, and the block form is not', () => {
  // The ruling on BEL-316 rests on this: index.mjs reads front matter with a
  // hand-rolled reader whose scalar() has no inline-array support, so
  // `quotedTokens: ["tonight"]` parses to a string and the gate rejects it. If a
  // future change gives index.mjs a YAML library, this case starts failing and
  // that is the moment to re-read the ruling rather than relax the test.
  const inline = [
    'title: "A headline long enough to clear the schema"',
    'dek: "One sentence under the headline."',
    'date: 2026-10-02',
    'edition: evening',
    'byline: Nathan Beausoleil',
    'category: weather',
    'slug: belmont-county-three-day-weather-roundup',
    'sources:',
    '  - type: document',
    '    title: "Gridpoint forecast PBZ/50,48"',
    '    retrieved: 2026-10-02',
    'quotedTokens: ["tonight"]',
  ].join('\n');
  const bad = archive([post({ day: '2026-10-02', frontMatter: inline, body: 'Copy.\n' })]);
  assert.notEqual(bad.code, 0, 'an inline array must not pass the gate');
  assert.match(bad.stderr, /expected array, got string/);

  const block = inline.replace('quotedTokens: ["tonight"]', [
    'quotedTokens:',
    '  - token: tonight',
    '    context: "segment reads: tonight"',
    '    reason: "NWS Zone Forecast Product FPUS51 KPBZ 022102, issued 2026-10-02"',
  ].join('\n'));
  const good = archive([post({ day: '2026-10-02', frontMatter: block, body: 'Copy.\n' })]);
  assert.equal(good.code, 0, `the block form must pass: ${good.stderr}`);
});

test('an allowance with no reason is refused by the gate, not only by the scan', () => {
  // Belt and braces. Mara's condition 8 has to hold for a post whose author never
  // runs the scan, and schema.json is what every pull request goes through.
  const front = [
    'title: "A headline long enough to clear the schema"',
    'dek: "One sentence under the headline."',
    'date: 2026-10-02',
    'edition: evening',
    'byline: Nathan Beausoleil',
    'category: weather',
    'slug: belmont-county-three-day-weather-roundup',
    'sources:',
    '  - type: document',
    '    title: "Gridpoint forecast PBZ/50,48"',
    '    retrieved: 2026-10-02',
    'quotedTokens:',
    '  - token: tonight',
    '    context: "segment reads: tonight"',
  ].join('\n');
  const r = archive([post({ day: '2026-10-02', frontMatter: front, body: 'Copy.\n' })]);
  assert.notEqual(r.code, 0, 'an allowance with no reason must not pass the gate');
  assert.match(r.stderr, /missing required field 'reason'/);
});

test('eventEnds is accepted as a real day and refused as a phrase', () => {
  const withField = (v) => [
    'title: "A headline long enough to clear the schema"',
    'dek: "One sentence under the headline."',
    'date: 2026-10-02',
    'edition: evening',
    'byline: Nathan Beausoleil',
    'category: weather',
    'slug: belmont-county-three-day-weather-roundup',
    'sources:',
    '  - type: document',
    '    title: "Gridpoint forecast PBZ/50,48"',
    '    retrieved: 2026-10-02',
    `eventEnds: ${v}`,
  ].join('\n');

  const absent = archive([post({ day: '2026-10-02', frontMatter: withField('2026-10-04'), body: 'Copy.\n' })]);
  assert.equal(absent.code, 0, `a real day must pass: ${absent.stderr}`);

  const datetime = archive([post({ day: '2026-10-02', frontMatter: withField('2026-10-04T14:00:00-04:00'), body: 'Copy.\n' })]);
  assert.equal(datetime.code, 0, `a date-time must pass: ${datetime.stderr}`);

  for (const phrase of ['Sunday', 'now', '2026-13-45', '""']) {
    const r = archive([post({ day: '2026-10-02', frontMatter: withField(phrase), body: 'Copy.\n' })]);
    assert.notEqual(r.code, 0, `"${phrase}" is not a date and must not pass`);
  }
});

test('the scan exits 0 even when it cannot run', () => {
  // The one property that makes this safe to put in a workflow at all. If this
  // case ever fails, the scan has become a failing gate and BEL-317 is void.
  for (const args of [
    ['--content', join(tmpdir(), 'belmont-tense-does-not-exist-' + process.pid)],
    ['--content', 'content', '--listing-days', '0'],
    ['--content', 'content', '--today', 'not-a-day'],
    ['--content', 'content', '--nonsense'],
  ]) {
    const r = runScan(args[1], args.slice(2));
    assert.equal(r.code, 0, `must exit 0 for ${args.join(' ')}: ${r.stderr}`);
  }
});

test('the scan over the live archive exits 0 and prints the window it read', () => {
  // Deliberately asserts nothing about how many hits there are. That number
  // goes down every time a desk corrects a post, and a test that fails when the
  // newsroom improves is the failing gate arriving through the suite. See
  // BEL-317 condition 1 and the note above.
  const r = runScan(join(REPO, 'content'), ['--today', '2026-10-06', '--json']);
  assert.equal(r.code, 0, `the live archive must scan clean: ${r.stderr}`);
  const report = JSON.parse(r.stdout);
  assert.equal(report.listingDays, 2);
  assert.equal(report.listingDaysSource, 'scripts/listing-days.mjs');
  assert.ok(report.postsScanned > 0, 'it must actually have read the posts');
  assert.equal(report.exitCode, 0, 'the report states its own exit code, and it is 0');
});
