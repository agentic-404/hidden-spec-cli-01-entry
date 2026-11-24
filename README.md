# mend: one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agentic-404/hidden-spec-cli-01-entry/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/agentic-404/hidden-spec-cli-01-entry/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies an edit an AI model wrote to a tree of text files. Models write
edits in four formats, and `mend` reads all four to one written contract:

- **unified diffs**, often with wrong line numbers — hunks are found by content,
  nearest the stated line, with the drift of earlier hunks taken into account;
- **SEARCH/REPLACE blocks** — the path is the nearest non-blank, non-fence line
  above the block, and a block that matches twice is ambiguous;
- **V4A patches** — `*** Begin Patch` sections with anchors, a cursor, and
  `*** End of File` chunks;
- **JSON text-editor tool calls** — one array or one edit object per line
  (`create`, `str_replace`, `insert`).

## Matching

An edit's old lines are found at the first of three tiers at which they occur:

- tier 0: every line equal;
- tier 1: every line equal once trailing spaces and tabs are removed;
- tier 2: every line equal once leading and trailing spaces and tabs are removed.

At tier 2 the new lines are re-indented to the file's own indent. `--strict`
matches tier 0 only. A context line is always written as the file's own
matched line, never the patch's.

## Guarantees

- **All or nothing**: every file is changed or none is. A failed edit changes
  nothing, and the edits after it still run, so every failure is reported.
- **Exact output**: one line per changed path (`A`, `D`, `M`, or `R old -> new`
  for a move), then `ok: <n> files`; failures print one `error: <code> <path>`
  line each, then `failed: <k> of <n> edits`; usage, read, format and parse
  faults print one `error:` line and exit 2.
- **Safe paths**: a path is safe when it is not empty, does not start with `/`,
  holds no `\`, and none of its segments is empty, `.` or `..`.
- **`--check`** does everything but write: the same output and exit code, and
  no file is created, changed or deleted.
- **Deterministic**: the same input gives byte-identical output every run.

## Usage

```
node main.ts [--format=NAME] [--check] [--strict] [PATCH]
```

`--format` is `auto` (the default), `unified`, `search-replace`, `v4a` or
`json`. `PATCH` is the patch file, or `-` (or absent) to read it from standard
input. The working directory is the root of the tree.

## Files

- `main.ts` — the CLI, Node 22 and its standard library alone.
- `runner.ts` — the kit's runner, unchanged: in a trial it reads the checks
  from the env and runs `main.ts` on each one.

## Local scores

Practice instance, 100 checks (unified 30, SEARCH/REPLACE 20, V4A 20, JSON 15,
CLI 15): **100 of 100 passed, practice score 1000**, confirmed both by the
kit's `check.ts` and by `makefun grade-local` (sealed scorer, replayed byte
for byte). An additional 80 hand-written edge cases from round 1 plus 26 new
edge cases for this correction round (sentences the practice set does not
show) all pass.

## r2 — what changed from r1

One behavioral correction, from re-reading SPEC.md section 6 word by word:
the `diff --git` line is now read strictly, exactly as the spec writes it
(`diff --git a/<X> b/<Y>`). A trailing space or tab after `b/<Y>` is
`error: parse <its line>`. The spec states every leniency it allows —
surrounding spaces on `--- `/`+++ ` paths, trailing text after `@@`, trailing
whitespace on SEARCH/REPLACE markers — and states none for this line. The
four judgment calls from r1 (lone `--- ` after hunks read as prose, hunk-less
sections counted as one edit, `*** End of File` with no open chunk and body
lines after an EOF-closed chunk as parse errors, a `\` line after a `-` line
not removing the final break) were each re-read and kept: in every case the
spec's own wording supports r1's reading and no stronger alternative reading
was found.
