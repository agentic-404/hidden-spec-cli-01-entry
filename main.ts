// mend: one patch tool for every AI edit format.
//
// Applies an edit an AI model wrote to a tree of text files, in four formats:
// unified diffs (often with wrong line numbers), SEARCH/REPLACE blocks, the
// V4A patch format, and text-editor tool calls as JSON. Reads SPEC.md's
// contract exactly: three tiers of line matching (exact, trailing
// whitespace, leading and trailing whitespace), atomic all-or-none writes,
// exact stdout lines and exit codes. Node 22, the standard library alone;
// run it as `node main.ts [options] [PATCH]`.
//
// The last lines hand a trial over to runner.ts when MAKEFUN_ENV_URL is set:
// keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** Leading spaces and tabs of a line. */
function lead(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
}
const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');

/** A file as lines: its line break, its lines, and whether it ends with one. */
interface FileDoc {
  lines: string[];
  br: string;
  final: boolean;
}
function parseFile(text: string): FileDoc {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const final = text.endsWith(br);
  const body = final ? text.slice(0, -br.length) : text;
  return { lines: body.split(br), br, final };
}
function renderFile(d: FileDoc): string {
  if (d.lines.length === 0) return '';
  return d.lines.join(d.br) + (d.final ? d.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** One line of N: `oPos` is its index in O when it is a context line, else -1. */
interface NewLine {
  text: string;
  oPos: number;
}

/** Equality of one line at a matching tier (SPEC.md section 5). */
function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return stripTrail(a) === stripTrail(b);
  return stripBoth(a) === stripBoth(b);
}

/** Every 0-based position at or after `from` where O occurs at `tier`; occurrences may overlap. */
function occurrences(O: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(O[j], lines[i + j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function findTier(O: string[], lines: string[], strict: boolean, from: number): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(O, lines, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The lines N writes over the matched lines at `pos`: a context line is the file's own matched line; at tier 2
 * every other line that is not empty or only whitespace and starts with O's first line's indent has that indent
 * replaced by the file's first matched line's indent. */
function buildNew(O: string[], N: NewLine[], fileLines: string[], pos: number, tier: number): string[] {
  const p = O.length > 0 ? lead(O[0]) : '';
  const f = lead(fileLines[pos]);
  return N.map((n) => {
    if (n.oPos >= 0) return fileLines[pos + n.oPos];
    if (tier === 2 && n.text !== '' && n.text.trim() !== '' && n.text.startsWith(p)) return f + n.text.slice(p.length);
    return n.text;
  });
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** A unified hunk (SPEC.md section 6): A is the old start line, O the context and `-` lines, N the context and
 * `+` lines, `noEol` whether a `\` line follows the hunk's last context or `+` line, `lastPlusNoEol` whether one
 * follows its last `+` line. */
interface Hunk {
  a: number;
  o: string[];
  n: NewLine[];
  noEol: boolean;
  lastPlusNoEol: boolean;
  hasPlus: boolean;
}

interface UniSection {
  diffOld: string | null;
  diffNew: string | null;
  dashOld: string | null;
  dashNew: string | null;
  renOld: string | null;
  renNew: string | null;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

/** The path of a `--- ` or `+++ ` line: the text after the four characters, up to the first tab, with surrounding
 * spaces removed, and one leading `a/` or `b/` removed. `/dev/null` means no file. */
function dashPath(line: string): string {
  const t = line.slice(4);
  const tab = t.indexOf('\t');
  const s = (tab >= 0 ? t.slice(0, tab) : t).trim();
  if (s === '/dev/null') return s;
  if (s.startsWith('a/') || s.startsWith('b/')) return s.slice(2);
  return s;
}

/** Apply one unified hunk to `doc`; returns the section's new drift d. */
function applyHunk(doc: FileDoc, hunk: Hunk, d: number, strict: boolean, path: string): number {
  if (hunk.o.length === 0) {
    const oldLen = doc.lines.length;
    const at = Math.max(0, Math.min(hunk.a + d, oldLen));
    const texts = hunk.n.map((n) => n.text);
    doc.lines.splice(at, 0, ...texts);
    if (at === oldLen) doc.final = !hunk.noEol;
    return d + hunk.n.length;
  }
  const found = findTier(hunk.o, doc.lines, strict, 0);
  if (found === null) throw new Fail('no-match', path);
  const target = hunk.a - 1 + d;
  let best = found.occ[0];
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const pos = best;
  const endAtEnd = pos + hunk.o.length === doc.lines.length;
  const repl = buildNew(hunk.o, hunk.n, doc.lines, pos, found.tier);
  doc.lines.splice(pos, hunk.o.length, ...repl);
  if (endAtEnd) doc.final = !hunk.noEol;
  return d + (hunk.n.length - hunk.o.length);
}

/** The unified patch's sections as edits (SPEC.md section 6). */
function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  const hunkRe = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffRe = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
  const sections: UniSection[] = [];
  const fresh = (): UniSection => ({
    diffOld: null,
    diffNew: null,
    dashOld: null,
    dashNew: null,
    renOld: null,
    renNew: null,
    newFile: false,
    deletedFile: false,
    hunks: [],
  });
  let cur: UniSection | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = diffRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = fresh();
      cur.diffOld = m[1];
      cur.diffNew = m[2];
      sections.push(cur);
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1];
      if (next !== undefined && next.startsWith('+++ ')) {
        const oldP = dashPath(line);
        const newP = dashPath(next);
        if (cur !== null && cur.hunks.length === 0) {
          cur.dashOld = oldP;
          cur.dashNew = newP;
        } else {
          cur = fresh();
          cur.dashOld = oldP;
          cur.dashNew = newP;
          sections.push(cur);
        }
        i += 2;
        continue;
      }
      if (cur !== null && cur.hunks.length === 0) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && cur.hunks.length === 0) cur.dashNew = dashPath(line);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkRe.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const hunk: Hunk = { a: parseInt(m[1], 10), o: [], n: [], noEol: false, lastPlusNoEol: false, hasPlus: false };
      cur.hunks.push(hunk);
      i++;
      const body: string[] = [];
      while (i < lines.length) {
        const b = lines[i];
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && lines[i + 1] !== undefined && lines[i + 1].startsWith('+++ ')) break;
        if (b === '' || b.startsWith(' ') || b.startsWith('-') || b.startsWith('+') || b.startsWith('\\')) {
          body.push(b);
          i++;
        } else break;
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      const isCtxOrPlus = (b: string): boolean => b === '' || b.startsWith(' ') || b.startsWith('+');
      let lastCp = -1;
      let lastPlus = -1;
      for (let k = 0; k < body.length; k++) {
        if (isCtxOrPlus(body[k])) lastCp = k;
        if (body[k].startsWith('+')) lastPlus = k;
      }
      if (lastCp >= 0 && lastCp + 1 < body.length && body[lastCp + 1].startsWith('\\')) hunk.noEol = true;
      if (lastPlus >= 0) {
        hunk.hasPlus = true;
        if (lastPlus + 1 < body.length && body[lastPlus + 1].startsWith('\\')) hunk.lastPlusNoEol = true;
      }
      for (const b of body) {
        if (b.startsWith('\\')) continue;
        if (b === '') {
          const oi = hunk.o.length;
          hunk.o.push('');
          hunk.n.push({ text: '', oPos: oi });
        } else if (b[0] === ' ') {
          const oi = hunk.o.length;
          hunk.o.push(b.slice(1));
          hunk.n.push({ text: b.slice(1), oPos: oi });
        } else if (b[0] === '-') {
          hunk.o.push(b.slice(1));
        } else if (b[0] === '+') {
          hunk.n.push({ text: b.slice(1), oPos: -1 });
        }
      }
      continue;
    }
    if (cur !== null && cur.hunks.length === 0) {
      if (line.startsWith('rename from ')) cur.renOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
    }
    i++;
  }
  return sections.map((sec) => {
    const oldP = sec.dashOld ?? sec.renOld ?? sec.diffOld ?? '';
    const newP = sec.dashNew ?? sec.renNew ?? sec.diffNew ?? '';
    return (tree: Tree): void => {
      const isCreate = oldP === '/dev/null' || sec.newFile;
      const isDelete = newP === '/dev/null' || sec.deletedFile;
      if (isCreate) {
        if (!safe(newP)) throw new Fail('unsafe', newP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const created: string[] = [];
        for (const h of sec.hunks) for (const n of h.n) if (n.oPos < 0) created.push(n.text);
        let noEol = false;
        for (const h of sec.hunks) if (h.hasPlus) noEol = h.lastPlusNoEol;
        const doc: FileDoc = { lines: created, br: '\n', final: created.length > 0 && !noEol };
        tree.now.set(newP, renderFile(doc));
        return;
      }
      if (isDelete) {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (tree.get(oldP) === null) throw new Fail('missing', oldP);
        tree.now.set(oldP, null);
        return;
      }
      if (oldP !== newP) {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.get(newP) !== null) throw new Fail('exists', newP);
        const doc = parseFile(before);
        let d = 0;
        for (const h of sec.hunks) d = applyHunk(doc, h, d, strict, oldP);
        tree.now.set(oldP, null);
        tree.now.set(newP, renderFile(doc));
        tree.moves.push([oldP, newP]);
        return;
      }
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      const doc = parseFile(before);
      let d = 0;
      for (const h of sec.hunks) d = applyHunk(doc, h, d, strict, oldP);
      tree.now.set(oldP, renderFile(doc));
    };
  });
}

/** One SEARCH/REPLACE block (SPEC.md section 7). */
function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const doc = parseFile(before);
    const found = findTier(oldLines, doc.lines, strict, 0);
    if (found === null) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0];
    const repl = buildNew(oldLines, newLines.map((t) => ({ text: t, oPos: -1 })), doc.lines, pos, found.tier);
    doc.lines.splice(pos, oldLines.length, ...repl);
    tree.now.set(path, renderFile(doc));
  };
}

/** The patch's SEARCH/REPLACE blocks as edits (SPEC.md section 7). */
function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let i = 0;
  let prevPath: string | null = null;
  let prevEnd = -1;
  for (;;) {
    let s = -1;
    for (let k = i; k < lines.length; k++) {
      if (lines[k].trimEnd() === '<<<<<<< SEARCH') {
        s = k;
        break;
      }
    }
    if (s < 0) break;
    let m = -1;
    for (let k = s + 1; k < lines.length; k++) {
      if (lines[k].trimEnd() === '=======') {
        m = k;
        break;
      }
    }
    if (m < 0) throw new Exit2(`error: parse ${s + 1}`);
    let r = -1;
    for (let k = m + 1; k < lines.length; k++) {
      if (lines[k].trimEnd() === '>>>>>>> REPLACE') {
        r = k;
        break;
      }
    }
    if (r < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let k = s - 1; k > prevEnd; k--) {
      const t = lines[k].trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${s + 1}`);
      path = prevPath;
    }
    edits.push(searchReplaceEdit(path, lines.slice(s + 1, m), lines.slice(m + 1, r), strict));
    prevPath = path;
    prevEnd = r;
    i = r + 1;
  }
  return edits;
}

/** A V4A chunk (SPEC.md section 8): `anchor` null when the `@@` line held no text, `eof` when a
 * `*** End of File` line ended it. */
interface V4aChunk {
  anchor: string | null;
  o: string[];
  n: NewLine[];
  eof: boolean;
}

interface V4aSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  moveTo: string | null;
  lines: string[];
  chunks: V4aChunk[];
  updateLine: number;
}

/** Apply one V4A chunk to `doc`; returns the cursor just after the lines written. */
function applyV4aChunk(doc: FileDoc, ch: V4aChunk, cursor: number, strict: boolean, path: string): number {
  let from = cursor;
  if (ch.anchor !== null) {
    const found = findTier([ch.anchor], doc.lines, strict, cursor);
    if (found === null) throw new Fail('no-match', path);
    from = found.occ[0] + 1;
  }
  if (ch.o.length === 0) {
    const at = ch.eof ? doc.lines.length : from;
    const texts = ch.n.map((n) => n.text);
    doc.lines.splice(at, 0, ...texts);
    return at + texts.length;
  }
  const found = findTier(ch.o, doc.lines, strict, from);
  if (found === null) throw new Fail('no-match', path);
  let occ = found.occ;
  if (ch.eof) {
    occ = occ.filter((p) => p + ch.o.length === doc.lines.length);
    if (occ.length === 0) throw new Fail('no-match', path);
  }
  const pos = occ[0];
  const repl = buildNew(ch.o, ch.n, doc.lines, pos, found.tier);
  doc.lines.splice(pos, ch.o.length, ...repl);
  return pos + repl.length;
}

/** One V4A section as an edit (SPEC.md section 8). */
function v4aEdit(sec: V4aSection, strict: boolean): Edit {
  return (tree) => {
    if (sec.kind === 'add') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) !== null) throw new Fail('exists', sec.path);
      tree.now.set(sec.path, sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n');
      return;
    }
    if (sec.kind === 'delete') {
      if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
      if (tree.get(sec.path) === null) throw new Fail('missing', sec.path);
      tree.now.set(sec.path, null);
      return;
    }
    if (!safe(sec.path)) throw new Fail('unsafe', sec.path);
    if (sec.moveTo !== null && !safe(sec.moveTo)) throw new Fail('unsafe', sec.moveTo);
    const before = tree.get(sec.path);
    if (before === null) throw new Fail('missing', sec.path);
    if (sec.moveTo !== null && tree.get(sec.moveTo) !== null) throw new Fail('exists', sec.moveTo);
    const doc = parseFile(before);
    let cursor = 0;
    for (const ch of sec.chunks) cursor = applyV4aChunk(doc, ch, cursor, strict, sec.path);
    const out = renderFile(doc);
    if (sec.moveTo !== null) {
      tree.now.set(sec.path, null);
      tree.now.set(sec.moveTo, out);
      tree.moves.push([sec.path, sec.moveTo]);
    } else {
      tree.now.set(sec.path, out);
    }
  };
}

/** The patch's V4A sections as edits (SPEC.md section 8). */
function v4aEdits(lines: string[], strict: boolean): Edit[] {
  let first = -1;
  for (let k = 0; k < lines.length; k++) {
    if (lines[k].trim() !== '') {
      first = k;
      break;
    }
  }
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first].trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (lines[k].trim() !== '') {
      last = k;
      break;
    }
  }
  if (lines[last].trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    while (i < last && lines[i].trim() === '') i++;
    if (i >= last) break;
    const line = lines[i];
    let sec: V4aSection;
    if (line.startsWith('*** Add File: ')) sec = { kind: 'add', path: line.slice(14).trim(), moveTo: null, lines: [], chunks: [], updateLine: 0 };
    else if (line.startsWith('*** Delete File: ')) sec = { kind: 'delete', path: line.slice(17).trim(), moveTo: null, lines: [], chunks: [], updateLine: 0 };
    else if (line.startsWith('*** Update File: ')) sec = { kind: 'update', path: line.slice(17).trim(), moveTo: null, lines: [], chunks: [], updateLine: i + 1 };
    else throw new Exit2(`error: parse ${i + 1}`);
    i++;
    const raw: { text: string; num: number }[] = [];
    while (i < last) {
      const b = lines[i];
      if (b.startsWith('*** Add File: ') || b.startsWith('*** Delete File: ') || b.startsWith('*** Update File: ')) break;
      raw.push({ text: b, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && raw[raw.length - 1].text.trim() === '') raw.pop();
    if (sec.kind === 'add') {
      for (const r of raw) {
        if (r.text.startsWith('+')) sec.lines.push(r.text.slice(1));
        else if (r.text === '') sec.lines.push('');
        else throw new Exit2(`error: parse ${r.num}`);
      }
    } else if (sec.kind === 'delete') {
      for (const r of raw) {
        if (r.text.trim() !== '') throw new Exit2(`error: parse ${r.num}`);
      }
    } else {
      let chunk: V4aChunk | null = null;
      let chunkStarted = false;
      let firstLine = true;
      for (const r of raw) {
        const t = r.text;
        if (t.startsWith('*** Move to: ')) {
          if (!firstLine) throw new Exit2(`error: parse ${r.num}`);
          sec.moveTo = t.slice('*** Move to: '.length).trim();
          firstLine = false;
          continue;
        }
        firstLine = false;
        if (t.startsWith('@@')) {
          const anchor = t.slice(2).trim();
          chunk = { anchor: anchor === '' ? null : anchor, o: [], n: [], eof: false };
          sec.chunks.push(chunk);
          chunkStarted = true;
          continue;
        }
        if (t === '*** End of File') {
          if (chunk === null) throw new Exit2(`error: parse ${r.num}`);
          chunk.eof = true;
          chunk = null;
          continue;
        }
        if (chunk === null) {
          if (chunkStarted) throw new Exit2(`error: parse ${r.num}`);
          chunk = { anchor: null, o: [], n: [], eof: false };
          sec.chunks.push(chunk);
          chunkStarted = true;
        }
        if (t === '') {
          const oi = chunk.o.length;
          chunk.o.push('');
          chunk.n.push({ text: '', oPos: oi });
        } else if (t[0] === ' ') {
          const oi = chunk.o.length;
          chunk.o.push(t.slice(1));
          chunk.n.push({ text: t.slice(1), oPos: oi });
        } else if (t[0] === '-') {
          chunk.o.push(t.slice(1));
        } else if (t[0] === '+') {
          chunk.n.push({ text: t.slice(1), oPos: -1 });
        } else {
          throw new Exit2(`error: parse ${r.num}`);
        }
      }
      if (sec.chunks.length === 0 && sec.moveTo === null) throw new Exit2(`error: parse ${sec.updateLine}`);
    }
    edits.push(v4aEdit(sec, strict));
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? unifiedEdits(lines, strict)
          : kind === 'search-replace'
            ? searchReplaceEdits(lines, strict)
            : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = [...tree.moves];
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = 0;
      for (const m of movesBefore) tree.moves.push(m);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  interface Row {
    key: string;
    line: string;
    acts: { path: string; content: string | null }[];
  }
  const rows: Row[] = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of tree.moves) {
    const wasOld = tree.original(oldP);
    const wasNew = tree.original(newP);
    const nowOld = tree.now.get(oldP);
    const nowNew = tree.now.get(newP);
    if (wasOld !== null && wasNew === null && nowOld === null && nowNew !== null) {
      covered.add(oldP);
      covered.add(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}`, acts: [{ path: oldP, content: null }, { path: newP, content: nowNew }] });
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    const line = was === null ? `A ${p}` : now === null ? `D ${p}` : `M ${p}`;
    rows.push({ key: p, line, acts: [{ path: p, content: now }] });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out: string[] = [];
  for (const r of rows) {
    out.push(r.line);
    if (check) continue;
    for (const a of r.acts) {
      if (a.content === null) rmSync(a.path, { force: true });
      else {
        mkdirSync(dirname(a.path), { recursive: true });
        writeFileSync(a.path, a.content);
      }
    }
  }
  return { code: 0, out: [...out, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
