import type {LogIngestion} from '@etherfold/core';
import type {Context} from 'hono';
import type {Bindings} from 'hono/types';

/**
 * ONE named indexer this host was built with, as the ingest routes see it.
 *
 * A NAMED INDEXER is the server's multi-tenancy unit: one indexed answer set
 * over one chain, fully isolated from every other (ADR-0036). The name arrives
 * at DEPLOY time -- an operator supplies it and a host registers the N it was
 * built with -- so nothing here loads code, resolves a module or invents a name
 * for a caller that gave none.
 *
 * ## Why an ENTRY OBJECT rather than the `LogIngestion` itself
 *
 * Because what a name resolves to is going to GROW, and the resolver's return
 * type should not have to. A registry entry becomes several live wire contexts
 * at once when a generation is created beside a live one
 * (`work/specs/proposed/the-server-and-cli-hold-generations-too.md`): the route
 * then selects the INDEXER and the batch's own `{source, config}` selects which
 * stream-builder within it receives the batch. Handing back a bare `LogIngestion`
 * today would make that an incompatible change to every host's resolver instead
 * of one additive field here.
 *
 * The NAME is deliberately NOT a field on it. The route segment is the one
 * source of that value, and a second copy an entry could disagree with is a
 * discriminator a write path might key on wrongly.
 */
export type IndexerRegistryEntry = {
	/**
	 * The stream-builder this named indexer folds through: authoritative about
	 * where the next batch must start, deriving every reorg, chain-free.
	 *
	 * Exactly ONE live wire context here, which is all a single generation needs.
	 */
	ingestion: LogIngestion;
};

/**
 * How a host resolves ONE name into the entry it registered under it.
 *
 * A FUNCTION rather than a record, per REQUEST, for the same reason `getDB` is
 * one: on Cloudflare the bindings arrive on the request's `env` and there is no
 * app-construction moment at which they exist.
 *
 * `undefined` means "this host was not built with that name", which the routes
 * REFUSE rather than default: a batch that reached the wrong tenant silently is
 * the failure this whole discriminator exists to make impossible.
 */
export type IndexerResolver<Env extends Bindings = Bindings> = (
	c: Context<{Bindings: Env}>,
	name: string,
) => IndexerRegistryEntry | undefined;

/**
 * The registry a host that knows all its named indexers up front can pass
 * straight to `createServer`.
 *
 * Sugar over the resolver and nothing more: a host whose set of names depends on
 * the request (a Worker reading a binding) writes its own function instead. The
 * lookup is an OWN-PROPERTY read, so a name like `constructor` or `toString`
 * resolves to nothing rather than to something off `Object.prototype`.
 */
export function indexerRegistry<Env extends Bindings = Bindings>(
	indexers: Readonly<Record<string, LogIngestion>>,
): IndexerResolver<Env> {
	return (_c, name) =>
		Object.prototype.hasOwnProperty.call(indexers, name) ? {ingestion: indexers[name] as LogIngestion} : undefined;
}
