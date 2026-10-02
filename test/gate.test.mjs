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
  assert.match(r.stderr, /past the newsroom date window from 2026-10-02/);
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
  const r = archive([post({ day: '2026-10-02', frontMatter: validPost({ byline: 'Belmont News Staff' }) + '\n' + VALID_SOURCES })]);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /byline 'Belmont News Staff' is not in roster\.json/);
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