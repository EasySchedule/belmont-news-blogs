#!/usr/bin/env node
// index.mjs - validate Belmont News posts and build the post index.
//
//   node index.mjs                       # validate content/, write build/posts-index.json
//   node index.mjs --check               # validate only, write nothing
//   node index.mjs --out ../site/build/posts-index.json
//   node index.mjs --today 2026-10-03    # pin newsroom today for the date-window gate
//   node index.mjs --help
//
// The build gate is the editorial standard. A post that cannot clear it does not
// build. schema.json holds every field-level rule; the gates a JSON Schema cannot
// express are enforced here:
//
//   1. path shape      content/<YYYY>/<MM>/<YYYY-MM-DD>/<author-slug>[--<slug>].md
//   2. folder date    the day folder equals the front matter date
//   3. filename       the author segment equals the roster slug of the byline
//   4. slug match     the optional second filename segment equals the front matter slug
//   5. slug unique    no two posts share a slug
//   6. column owner   only the roster owner of a column may file it, and a
//                     column no roster entry owns is named as a registry gap
//   7. retired byline an entry with a `retired` day may sign a post dated on or
//                     before that day and not one dated later, so a byline that
//                     leaves the newsroom stops being fileable
//   8. sourced        at least one source; schema.json minItems, plus an explicit
//                     empty list is rejected here with the file named
//   9. date window    no post dated more than --future-days ahead of --today
//
// The date window is forward only. `--today` is the newsroom's publishing date,
// never a floor the archive has to stay above: the archive keeps yesterday's
// posts forever, so a backward half would turn the whole archive red one day
// after each post was filed. Pin `--today` forward as far as you like.

import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync } from 'node:fs';
import { join, resolve, basename, dirname } from 'node:path';

const DEFAULTS = {
  content: 'content',
  schema: 'schema.json',
  roster: 'roster.json',
  out: 'build/posts-index.json',
  today: null,
  futureDays: 2,
  check: false,
};

// ---------------------------------------------------------------- CLI

const USAGE = `index.mjs - validate Belmont News posts and build the post index

Usage: node index.mjs [options]

  --content <dir>    post directory        (default ${DEFAULTS.content})
  --schema <file>    front matter schema   (default ${DEFAULTS.schema})
  --roster <file>    byline roster         (default ${DEFAULTS.roster})
  --out <file>       index output          (default ${DEFAULTS.out})
  --today <date>     pin newsroom today    (default: the America/New_York date).
                      Forward bound only. A post dated before it is not an error,
                      so the check still passes on the day after it is filed.
  --future-days <n>  forward date window   (default ${DEFAULTS.futureDays})
  --check            validate only, write nothing
  --help             this text
`;

function parseArgs(argv) {
  const o = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) fatal(`${a} needs a value`);
      return argv[++i];
    };
    switch (a) {
      case '--content': o.content = val(); break;
      case '--schema': o.schema = val(); break;
      case '--roster': o.roster = val(); break;
      case '--out': o.out = val(); break;
      case '--today': o.today = val(); break;
      case '--future-days': o.futureDays = Number(val()); break;
      case '--check': o.check = true; break;
      case '--help': process.stdout.write(USAGE); process.exit(0); break;
      default: fatal(`unknown argument ${a}`);
    }
  }
  if (o.today && !/^\d{4}-\d{2}-\d{2}$/.test(o.today)) {
    fatal(`--today must be YYYY-MM-DD, got ${o.today}`);
  }
  if (!Number.isFinite(o.futureDays)) fatal('--future-days must be a number');
  return o;
}

function fatal(msg) {
  process.stderr.write(`index.mjs: ${msg}\n`);
  process.exit(2);
}

function readJson(label, path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    fatal(`cannot read ${label} at ${path}`);
  }
  try {
    return JSON.parse(raw);
  } catch (e) {
    fatal(`${label} at ${path} is not valid JSON: ${e.message}`);
  }
}

// ------------------------------------------------------- NY newsroom date

function newsroomToday() {
  const s = new Date().toLocaleDateString('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  return s; // en-CA renders YYYY-MM-DD
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

// True when a string is a calendar day that exists, not merely one shaped like
// one. `2026-13-45` matches /^\d{4}-\d{2}-\d{2}$/ and is not a date, and anything
// that only checks the shape goes on to compare it as text, where it sorts after
// every real day and so never ages out. Round-tripping through Date.UTC is what
// turns the shape into a date.
function isRealDay(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const t = Date.UTC(+v.slice(0, 4), +v.slice(5, 7) - 1, +v.slice(8, 10));
  const d = new Date(t);
  return Number.isFinite(t)
    && d.getUTCFullYear() === +v.slice(0, 4)
    && d.getUTCMonth() === +v.slice(5, 7) - 1
    && d.getUTCDate() === +v.slice(8, 10);
}

// --------------------------------------------------- minimal front matter

const PAIR = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/;

// Deliberately small: the schema is YAML, but the front matter this repo emits
// is a flat block of scalars plus two list shapes. Anything more exotic is an
// error, so a broken file fails the build instead of half-parsing.
//
// The two list shapes are the ones the schema declares. A list of scalars:
//
//   tags:
//     - weather
//     - fair
//
// and a list of mappings, where the first field rides on the `- ` marker and the
// rest are indented continuation lines:
//
//   sources:
//     - type: document
//       title: "..."
//
// A `- ` marker always opens a new item. The first field of a mapping item rides
// on the marker and the rest are continuation lines that fill the item the
// marker opened.
function parseFrontMatter(text, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) fatal(`${file} has no YAML front matter block`);
  const block = m[1];
  const body = m[2] ?? '';
  const data = {};
  let listKey = null;

  for (const lineRaw of block.split(/\r?\n/)) {
    if (!lineRaw.trim() || lineRaw.trim().startsWith('#')) continue;
    const indented = /^\s/.test(lineRaw);

    if (indented) {
      if (!listKey) continue;
      const item = lineRaw.trim();
      if (item === '-') { data[listKey].push({}); continue; }
      if (item.startsWith('- ')) { data[listKey].push(newListItem(item.slice(2))); continue; }
      pushInline(data, listKey, item);
      continue;
    }

    const km = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lineRaw);
    if (!km) fatal(`${file} has an unparseable front matter line: ${lineRaw.trim()}`);
    const raw = km[2].trim();
    if (raw === '') {
      // either an empty scalar or the header of a list; the next indented line decides
      data[km[1]] = [];
      listKey = km[1];
      continue;
    }
    listKey = null;
    data[km[1]] = scalar(raw);
  }
  return { data, body };
}

// A list item opened by a `- ` marker: a bare scalar, or a one-field mapping that
// the following continuation lines go on to fill.
function newListItem(text) {
  const kv = PAIR.exec(text);
  if (!kv) return scalar(text);
  return { [kv[1]]: scalar(kv[2].trim()) };
}

// A continuation line: another `field: value` pair of the item above it. It must
// not open a new item, or every source of every post would collapse into one.
function pushInline(data, listKey, text) {
  if (!listKey) return;
  const arr = data[listKey];
  const kv = PAIR.exec(text);
  if (!kv) { arr.push(scalar(text)); return; }
  const last = arr[arr.length - 1];
  if (last !== null && typeof last === 'object' && !Array.isArray(last)) {
    last[kv[1]] = scalar(kv[2].trim());
    return;
  }
  arr.push({ [kv[1]]: scalar(kv[2].trim()) });
}

function scalar(raw) {
  if (raw === '[]') return [];
  const q = /^"(.*)"$/.exec(raw) || /^'(.*)'$/.exec(raw);
  if (q) return q[1];
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  return raw;
}

// ------------------------------------- serialised API response in a post body
//
// A post body is prose. BEL-132 published one that was not: a publish step took
// a document API response and wrote the whole envelope into the markdown below
// the front matter, instead of the envelope's `body` field. The front matter
// was correct, so the schema, the path, the byline, the roster and the sources
// all passed, the build succeeded and the deploy went out. The reader received
// a page whose entire body was one HTML-escaped JSON object.
//
// This is deliberately a shape test and not a key-name test. Naming
// `companyId` or `latestRevisionId` would only catch that one document store's
// envelope; the next store names its fields differently and the same mistake
// publishes again. What does not vary is that the body parses as a JSON object
// carrying a nested string body, which is what a response envelope is.
//
// The check is on the trimmed body alone and ignores a fenced code block, so a
// post that legitimately quotes a JSON document still passes. A code fence is
// the honest way to publish a JSON sample and the gate should not argue with it.
//
// Returns an error string, or null when the body is prose.
function apiEnvelopeError(body, rel) {
  const prose = stripFencedCode(body).trim();
  if (!prose.startsWith('{') || !prose.endsWith('}')) return null;

  let parsed;
  try {
    parsed = JSON.parse(prose);
  } catch {
    // Not valid JSON. Prose that opens with a brace is common enough, and a
    // parse failure here is not evidence of an envelope.
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  // An envelope carries the article inside a string field. Require that shape
  // rather than accepting any object, so a post that is legitimately a JSON
  // document about the weather is not refused for being an object.
  const inner = typeof parsed.body === 'string' ? parsed.body : null;
  if (inner === null || !inner.trim()) return null;

  return `${rel}: the post body is a serialised API response object, not prose. `
    + `The whole response was written here instead of its "body" field, so the `
    + `article is trapped inside a JSON string and the store's internal ids are `
    + `published in reader-facing HTML. Write the body's own text as the post `
    + `body. If this post genuinely has to show a JSON sample, put it in a `
    + `fenced code block.`;
}

// Remove fenced code blocks so a quoted JSON sample is not read as the body.
function stripFencedCode(body) {
  return String(body).replace(/^```[\s\S]*?^```/gm, '');
}

// --------------------------------------------- JSON Schema subset validator

function validate(schema, value, pointer, errors, path) {
  const add = (msg) => errors.push(`${path}: ${msg} (at ${pointer || '/'})`);
  const types = {
    object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
    array: Array.isArray,
    string: (v) => typeof v === 'string',
    boolean: (v) => typeof v === 'boolean',
    number: (v) => typeof v === 'number' && Number.isFinite(v),
  };

  if (schema.type && !types[schema.type](value)) {
    add(`expected ${schema.type}, got ${Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value}`);
    return;
  }
  if (schema.enum && !schema.enum.includes(value)) {
    add(`must be one of ${schema.enum.join(' | ')}, got ${JSON.stringify(value)}`);
    return;
  }
  if (schema.type === 'string') {
    if (schema.minLength && value.length < schema.minLength) add(`shorter than minLength ${schema.minLength}`);
    if (schema.maxLength && value.length > schema.maxLength) add(`longer than maxLength ${schema.maxLength}`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) add(`does not match ${schema.pattern}`);
  }
  if (schema.type === 'array') {
    if (schema.minItems && value.length < schema.minItems) add(`needs at least ${schema.minItems} item(s), got ${value.length}`);
    if (schema.maxItems && value.length > schema.maxItems) add(`allows at most ${schema.maxItems} item(s), got ${value.length}`);
    if (schema.items) value.forEach((v, i) => validate(schema.items, v, `${pointer}/${i}`, errors, path));
  }
  if (schema.type === 'object') {
    for (const r of schema.required || []) {
      if (!(r in value)) add(`missing required field '${r}'`);
    }
    if (schema.additionalProperties === false && schema.properties) {
      for (const k of Object.keys(value)) {
        if (!(k in schema.properties)) add(`unknown field '${k}'`);
      }
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (k in value) validate(sub, value[k], `${pointer}/${k}`, errors, path);
    }
  }
}

// ------------------------------------------------------------ discovery

const PATH_RE = /^content\/(\d{4})\/(\d{2})\/(\d{4}-\d{2}-\d{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)(?:--([a-z0-9]+(?:-[a-z0-9]+)*))?\.md$/;

function walk(dir, base, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    fatal(`cannot read content directory ${dir}`);
  }
  for (const name of entries.sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else if (name.endsWith('.md')) out.push(full);
  }
  return out;
}

// ----------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
const schema = readJson('schema', opts.schema);
const rosterDoc = readJson('roster', opts.roster);
const roster = new Map((rosterDoc.agents || []).map((a) => [a.name, a]));
if (!roster.size) fatal('roster.json lists no agents');

// A `retired` day is compared as text against the post's date, so a malformed one
// does not fail where you would notice it: it sorts wrong, and the retirement rule
// silently stops firing. An unpadded `2026-10-3` reads as later than every real day
// in October, so every post dated that month would pass under a byline that was
// meant to be closed, and the whole archive would stay green. Validate it at load,
// the same way `expires` is validated, so a typo in roster.json reds the build
// instead of quietly disarming the rule.
for (const agent of roster.values()) {
  if (agent.retired !== undefined && !isRealDay(agent.retired)) {
    fatal(`roster.json: '${agent.name}' has retired ${JSON.stringify(agent.retired)}, which is not a real calendar day as YYYY-MM-DD. The gate compares it as text, so a malformed day would silently stop refusing new work under that byline.`);
  }
}

// Every column any roster entry owns. A column that appears in a post and appears
// in none of these is not a byline mistake: it is a column nobody registered. The
// gate has to say so, because the two failures look identical from the writer's
// side and only one of them is fixed by changing the byline. BEL-55 sat unfixed
// for a full edition for exactly this reason.
const registeredColumns = new Map(); // column name -> [owning byline, ...]
for (const a of roster.values()) {
  for (const c of a.columns || []) {
    if (!registeredColumns.has(c)) registeredColumns.set(c, []);
    registeredColumns.get(c).push(a.name);
  }
}

const today = opts.today || newsroomToday();
const contentDir = resolve(opts.content);
const files = walk(contentDir, contentDir);

const errors = [];
const posts = [];
const seenSlugs = new Map();

for (const full of files) {
  const rel = full.replace(`${process.cwd()}/`, '');
  const m = PATH_RE.exec(rel);
  if (!m) {
    errors.push(`${rel}: path must be content/<YYYY>/<MM>/<YYYY-MM-DD>/<author-slug>[--<slug>].md`);
    continue;
  }
  const [, y, mo, folderDay, authorSeg, slugSeg] = m;

  const text = readFileSync(full, 'utf8');
  const { data, body } = parseFrontMatter(text, rel);

  // schema.json itself, not its properties map. Passing the map gave validate()
  // a schema with no type, no enum and no properties, so it validated nothing:
  // every rule in schema.json, minItems on sources and required on each source
  // included, was unreachable.
  validate(schema, data, '', errors, rel);

  if (data.date && data.date !== folderDay) {
    errors.push(`${rel}: front matter date ${data.date} does not match day folder ${folderDay}`);
  }
  if (y !== folderDay.slice(0, 4) || mo !== folderDay.slice(5, 7)) {
    errors.push(`${rel}: year/month folders disagree with the day folder ${folderDay}`);
  }

  const agent = data.byline ? roster.get(data.byline) : null;
  if (data.byline && !agent) {
    errors.push(`${rel}: byline '${data.byline}' is not in roster.json`);
  }
  // A retired byline belongs to the archive, not to the newsroom. It stays valid for
  // the posts already filed under it and is refused for anything dated after its last
  // day. Without this, extending the roster to keep the archive valid also leaves the
  // eight placeholder names fileable for new work, and a byline asserts authorship: a
  // placeholder name signing tomorrow's story is the same defect the gate exists to
  // catch, and it would reach a reader unchallenged.
  if (agent && agent.retired && String(data.date).slice(0, 10) > agent.retired) {
    errors.push(`${rel}: byline '${data.byline}' was retired after ${agent.retired} and this post is dated ${String(data.date).slice(0, 10)}. Retired bylines are for the archive only; file new work under a current byline.`);
  }
  if (agent && agent.slug !== authorSeg) {
    errors.push(`${rel}: filename author segment '${authorSeg}' is not the roster slug '${agent.slug}' for byline '${data.byline}'`);
  }
  if (slugSeg && data.slug && slugSeg !== data.slug) {
    errors.push(`${rel}: filename slug '${slugSeg}' does not match front matter slug '${data.slug}'`);
  }
  if (data.slug) {
    if (seenSlugs.has(data.slug)) {
      errors.push(`${rel}: slug '${data.slug}' is already used by ${seenSlugs.get(data.slug)}`);
    } else {
      seenSlugs.set(data.slug, rel);
    }
  }
  if (data.edition === 'column' && !data.column) {
    errors.push(`${rel}: edition is column but no 'column' field is set`);
  }
  if (data.column && agent && !(agent.columns || []).includes(data.column)) {
    const owners = registeredColumns.get(data.column);
    errors.push(owners
      ? `${rel}: byline '${data.byline}' does not own the column '${data.column}'. It is owned by ${owners.map((n) => `'${n}'`).join(' and ')}.`
      : `${rel}: byline '${data.byline}' does not own the column '${data.column}', and no agent in roster.json owns that column at all. This is a missing registration in roster.json, not a byline mistake: no byline will pass it until an owner is added under that agent's "columns".`);
  }
  // The date window is a forward window, as documented: it stops a post filed
  // beyond the newsroom's planning horizon. It deliberately has no backward
  // half. The archive keeps yesterday's posts forever, so a past-date check here
  // would fail the whole archive one day after each post was filed, and CI would
  // be red every morning for a file nobody changed. Filling an older day folder
  // is legal archive work; a date that disagrees with its own folder is already
  // an error above.
  if (data.date && daysBetween(today, data.date) > opts.futureDays) {
    errors.push(`${rel}: date ${data.date} is more than ${opts.futureDays} day(s) ahead of the newsroom date window from ${today}`);
  }
  // The optional `expires` field, when present, must be a real calendar day and
  // must not be earlier than the post's own date. This is a new, additive check
  // and it is not a change to the date window above: the window keeps its
  // forward-only shape and still has no backward half, and this rule says nothing
  // about when a post was filed, only about a field an author chose to write.
  //
  // It is here so a bad value is caught on the pull request that introduced it,
  // rather than at deploy time in the site build, which refuses the same values
  // independently. No post in the archive carries the field, so this cannot fail
  // anything that is not already new.
  if (data.expires !== undefined && data.expires !== null && String(data.expires).trim() !== '') {
    const value = String(data.expires).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !isRealDay(value)) {
      errors.push(`${rel}: expires must be a real calendar day as YYYY-MM-DD, got ${JSON.stringify(data.expires)}. A time of day is not accepted: the newsroom changes offset on 2026-11-01 and the listing rule cannot choose one for you.`);
    } else if (data.date && value < String(data.date).slice(0, 10)) {
      errors.push(`${rel}: expires ${value} is before the post's own date ${String(data.date).slice(0, 10)}. A post that expires on the day it is filed is a typo; set a later day or drop the field.`);
    }
  }
  if (Array.isArray(data.sources) && data.sources.length === 0) {
    errors.push(`${rel}: has an empty sources list. An unsourced post does not build.`);
  }

  // A post body that is a serialised API response object, rather than prose.
  //
  // BEL-132. A publish step fetched a document and pasted the whole response
  // envelope into the markdown instead of the response's `body` field. The
  // front matter was correct, so every other gate passed and the site built and
  // deployed cleanly. The reader got a page whose body was one escaped JSON
  // object: no headings, the article visible only as a JSON string, and the
  // store's internal companyId, issueId, id, createdByAgentId and
  // latestRevisionId printed in reader-facing HTML.
  //
  // It survived because the post had expired, so it dropped off the front page
  // and out of feed.xml and no QA pass ever opened it, while sitemap.xml and
  // build-info.json still pointed at it.
  //
  // This checks the shape rather than one document's key names. A body is prose
  // or it is not, and a JSON object is not prose. The front matter cannot be
  // used to tell the two apart: the envelope was pasted below it, so the front
  // matter was perfect and the page still rendered a string of JSON.
  const blob = apiEnvelopeError(body, rel);
  if (blob) errors.push(blob);

  posts.push({ file: rel, frontMatter: data, body: body.trim() });
}

posts.sort((a, b) => {
  const d = (b.frontMatter.date || '').localeCompare(a.frontMatter.date || '');
  return d !== 0 ? d : (a.frontMatter.slug || '').localeCompare(b.frontMatter.slug || '');
});

if (errors.length) {
  process.stderr.write(`index.mjs: build gate failed on ${errors.length} problem(s) in ${files.length} file(s):\n`);
  for (const e of errors) process.stderr.write(`index.mjs:   ${e}\n`);
  process.exit(1);
}

const index = {
  generated: new Date().toISOString(),
  newsroomToday: today,
  source: 'belmont-news/blogs',
  count: posts.length,
  posts: posts.map((p) => ({ file: p.file, ...p.frontMatter })),
};

if (opts.check) {
  process.stdout.write(`index.mjs: ${posts.length} post(s) pass the gate (--check, nothing written)\n`);
} else {
  const outPath = resolve(opts.out);
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(index, null, 2)}\n`);
  process.stdout.write(`index.mjs: ${posts.length} post(s) validated, wrote ${opts.out}\n`);
}

for (const p of posts) {
  const flags = [];
  if (p.frontMatter.corrections?.length) flags.push(`${p.frontMatter.corrections.length} correction(s)`);
  process.stdout.write(`index.mjs:   ${p.frontMatter.date}  ${p.frontMatter.edition.padEnd(7)} ${p.frontMatter.byline.padEnd(18)} ${p.frontMatter.slug}${flags.length ? `  [${flags.join(', ')}]` : ''}\n`);
}