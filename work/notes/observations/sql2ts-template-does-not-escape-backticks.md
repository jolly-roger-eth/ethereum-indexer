---
title: The house template's sql2ts emits unparseable TypeScript for ordinary SQL
date: 2026-08-22
---

`sql2ts.cjs`, copied from `~/dev/github/wighawag/template-agnositic-server`, turns each `.sql` file into `export default \`<contents>\`` with no escaping. Any backtick, `${`, or backslash in the SQL therefore lands raw inside a template literal.

Hit immediately: a single backtick in a SQL comment (naming a package) produced a generated file that failed with a wall of TS1005/TS1434 parse errors pointing at the *generated* file, which is gitignored. The cause is several steps from the symptom, and the fix ("do not use backticks in SQL comments") is not something anyone would guess.

Our copy now escapes backslashes, backticks and `${`. That is a deliberate divergence from the template.

Two things worth doing beyond this repo:

1. **Push the escaping upstream** to `template-agnositic-server`, and from there to anything else grown from it (`wighawag/push-notification` carries the same generator). This is what the template-tree reconciliation flow is for: the fix belongs at the template, not in each descendant.
2. **Consider whether the generated file should be committed rather than gitignored.** It is currently ignored here, so a parse failure names a file the reader cannot open from a clean checkout.

Related, found in the same sitting but fixed rather than deferred: splitting that SQL into statements on `;` is wrong if comments are present, because a semicolon inside a `--` comment cuts the next statement in half. The template never hit either problem because its schema is a single uncommented statement.
