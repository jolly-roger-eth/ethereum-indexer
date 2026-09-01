import type {RetentionSetting} from '@etherfold/processor-entities';

/**
 * The flags `etherfold index` takes, exactly as commander hands them over.
 *
 * Everything a deployment CHOOSES is a string here, including `--store`, and it
 * is validated by `resolveIndexOptions` rather than by the parser: the refusals
 * are the interesting part of this command's contract (a kind that does not
 * match its store, a `--folder` on a path that has no folder), so they are
 * testable functions and not commander configuration.
 */
export type Options = {
	processor: string;
	nodeUrl: string;
	/** `file` or `sqlite`. REQUIRED: see `resolveIndexOptions`. */
	store?: string;
	/** Where the free-form state file goes. Required with `--store file`, refused otherwise. */
	folder?: string;
	/** A libSQL url. Required with `--store sqlite`, refused otherwise. */
	db?: string;
	/** A number of BLOCKS, `revert-only` or `unbounded`. Only meaningful with `--store sqlite`. */
	retention?: string;
	deployments?: string;
	rps?: number;
};

/**
 * WHERE the indexed state goes, after the flags have been read.
 *
 * The discriminant is `store` and not `kind`, deliberately: `CONTEXT.md` gives
 * "processor kind" to the `'js-object'` / `'entities'` pair, which is a fact
 * about the MODULE, and this is the fact the operator states on the command
 * line. They are checked against each other (`assertKindMatchesStore`); making
 * them share a word would have made that check read as a tautology.
 */
export type StoreTarget =
	| {readonly store: 'file'; readonly folder: string}
	| {readonly store: 'sqlite'; readonly db: string; readonly retention: RetentionSetting};

/** The options with the store choice resolved, which is what the indexing path is built from. */
export type ResolvedOptions = {
	processor: string;
	nodeUrl: string;
	deployments?: string;
	rps?: number;
	target: StoreTarget;
};
