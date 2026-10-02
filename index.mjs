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
// build. The gates a JSON Schema cannot express are enforced here:
//
//   1. path shape      content/<YYYY>/<MM>/<YYYY-MM-DD>/<author-slug>[--<slug>].md
//   2. folder date    the day folder equals the front matter date
//   3. filename       the author segment equals the roster slug of the byline
//   4. slug match     the optional second segment equals the front matter slug
//   5. slug unique    no two posts share a slug
//   6. column owner   only the roster owner of a column may file it
//   7. sourced        at least one source, enforced by schema.json minItems
//   8. date window    no post dated more than --future-days ahead of --today

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
  --today <date>     pin newsroom today    (default: the America/New_York date)
  --future-days <n>  date window           (default ${DEFAULTS.futureDays})
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

// --------------------------------------------------- minimal front matter

// Deliberately small: the schema is YAML, but the front matter this repo emits
// is a flat block of scalars plus three list shapes. Anything more exotic is an
// error, so a broken file fails the build instead of half-parsing.
function parseFrontMatter(text, file) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) fatal(`${file} has no YAML front matter block`);
  const block = m[1];
  const body = m[2] ?? '';
  const data = {};
  let key = null;
  let listKey = null;

  for (const lineRaw of block.split(/\r?\n/)) {
    if (!lineRaw.trim() || lineRaw.trim().startsWith('#')) continue;
    const indented = /^\s/.test(lineRaw);

    if (indented) {
      if (!listKey) continue;
      const item = lineRaw.trim();
      if (item === '-') { data[listKey].push({}); continue; }
      if (item.startsWith('- ')) { data[listKey].push({}); listKey = null; pushInline(data, listKey, item.slice(2)); continue; }
      pushInline(data, listKey, item);
      continue;
    }

    const km = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(lineRaw);
    if (!km) fatal(`${file} has an unparseable front matter line: ${lineRaw.trim()}`);
    key = km[1];
    const raw = km[2].trim();
    if (raw === '') {
      // either an empty scalar or the header of a list; the next indented line decides
      data[key] = [];
      listKey = key;
      continue;
    }
    listKey = null;
    data[key] = scalar(raw);
  }
  return { data, body };
}

function pushInline(data, listKey, text) {
  if (!listKey) return;
  const arr = data[listKey];
  const last = arr[arr.length - 1];
  const kv = /^([A-Za-z_][A-Za-z0-9_-]*):\s*(.*)$/.exec(text);
  if (!kv) fatal(`unparseable list item: ${text}`);
  if (!last || Object.keys(last).length) arr.push({});
  arr[arr.length - 1][kv[1]] = scalar(kv[2].trim());
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

  validate(schema.properties, data, '', errors, rel);

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
    errors.push(`${rel}: byline '${data.byline}' does not own the column '${data.column}'`);
  }
  if (data.date && daysBetween(today, data.date) < 0) {
    errors.push(`${rel}: date ${data.date} is in the past relative to newsroom today ${today}`);
  }
  if (data.date && daysBetween(today, data.date) > opts.futureDays) {
    errors.push(`${rel}: date ${data.date} is more than ${opts.futureDays} day(s) past the newsroom date window from ${today}`);
  }
  if (Array.isArray(data.sources) && data.sources.length === 0) {
    errors.push(`${rel}: has an empty sources list. An unsourced post does not build.`);
  }

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