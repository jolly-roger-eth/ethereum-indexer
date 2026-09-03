# Every command input has ONE name, and only the port may default

Every `etherfold` command resolves every input through one module (`packages/cli/src/config.ts`): a FLAG first, then the ONE environment variable behind it, then a REFUSAL that names both — never a default. The exception is the port, which falls back to `2000`, and it is the only one. The variables are the ones a deployable already publishes — the fetcher host's `INDEXING_SOURCE`, `ETH_NODE_URI`, `INGEST_ENDPOINT`, `INGEST_TOKEN`, `REQUESTS_PER_SECOND` and the Node server host's `DB`, `PORT` — and the CLI's own second name for the node URL (`ETHEREUM_NODE`) is retired, because two names for one input is how two deployments of one image end up meaning different things.

## Why only the port

Because a port is not a claim about the deployment: a wrong one fails visibly and at once, nothing is written to the wrong place, and every HTTP tool in existence already has a conventional value. Every other input fails SILENTLY when it is wrong. A defaulted database is the sharpest case and the one this rule exists for: a `serve` that quietly opened `./etherfold.db` answers, healthily, about nothing, and a `build` that quietly wrote one has produced an artifact nobody can find. A defaulted node URL indexes the wrong chain. A defaulted store enforces a retention window nobody asked for. So the general rule is a refusal, and each default has to earn itself against "what does it look like when this is wrong and nobody notices?".

The asymmetry that makes this worth recording rather than obvious: **adding a default later is free and removing one is breaking.** A deployment that came to rely on `--db` defaulting cannot have it taken away without a migration, so the direction to be wrong in is the strict one.

## Why some inputs have no variable at all

Six do and six do not, and the line is deliberate: **the environment carries what varies between deployments of ONE image** — the chain, the source, the database, the wire, the port — while a flag carries **what the image IS**: which processor module, which store, which retention window, which interface to bind. So `-p`, `--store`, `--retention`, `-d`, `--host` and `--no-auto-setup` are flags only, and a refusal for one of them says so rather than naming a variable that does not exist. Inventing `PROCESSOR` or `STORE` would have been a second way to say something a container's `CMD` already says.

## Why a flag a command does not own is REFUSED, and an ambient variable is not

An accepted-and-ignored flag is a deployment believing something untrue, so `etherfold serve -p ./processor.js` is refused with the reason a read tier holds no processor, not accepted and dropped, and not left to commander's `unknown option` — which names neither a reason nor the command that does own the input. The refused flags are therefore REGISTERED (hidden from `--help`) so that they parse and reach the resolver, which is where the reason lives. That is what makes moving between the five commands a deployment change rather than a rewrite: the flags that do not move say where they went.

An ambient VARIABLE a command does not own is a different case and is simply not read. One host runs `fetch` beside `index`, so `ETH_NODE_URI` being set while `index` runs is ordinary; refusing on it would make the split deployment this system exists for impossible to configure.

## Consequences

- Requiredness cannot live in the argument parser, because a `requiredOption` refuses without naming the variable behind it. It lives in `resolveCommandConfig`, so every refusal is a function a test calls over an options object and an environment record.
- A commander DEFAULT is likewise forbidden, and not merely discouraged: a flag that is always present can never fall back to the variable behind it. `--port`'s parser default had silently made `PORT` unreachable.
- The requiredness of all five commands lives in ONE table, so the three commands that do not exist yet consume this rather than extend it.
