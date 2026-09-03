# The CLI's `test:manual` script invokes a command form that no longer exists

**2026-09-03**, noticed while wiring `one-configuration-path-for-every-command`.

`packages/cli/package.json`'s `test:manual` still runs `node ./dist/cli.js -p … -n … -f output.json -d …`: no command word (the default command was dropped by `the-one-shot-is-build-and-serve-is-only-the-read-tier`) and `-f`, the free-form state file flag deleted with the js-object path (ADR-0037). It cannot have run since either landed; it is a manual script so nothing goes red.
