import type {RetentionSetting} from '@etherfold/processor-entities';

/**
 * The flags `etherfold build` takes, exactly as commander hands them over.
 *
 * Everything a deployment CHOOSES is a string here, including `--store`, and it
 * is validated by `resolveIndexOptions` rather than by the parser: the refusals
 * are the interesting part of this command's contract (a `--db` nothing writes,
 * a `--retention` nothing enforces), so they are testable functions and not
 * commander configuration.
 */
export type Options = {
	processor: string;
	nodeUrl: string;
	/** `sqlite`, the one store there is. REQUIRED: see `resolveIndexOptions`. */
	store?: string;
	/** A libSQL url. Required. */
	db?: string;
	/** A number of BLOCKS, `revert-only` or `unbounded`. */
	retention?: string;
	deployments?: string;
	rps?: number;
};

/**
 * WHERE the indexed state goes, after the flags have been read.
 *
 * ONE arm, and still a discriminated shape: `--store` is the axis a second
 * backend arrives on, and this is the type it arrives in. It named two stores
 * until the free-form `file` blob went with the processor path that wrote it
 * (ADR-0037).
 */
export type StoreTarget = {readonly store: 'sqlite'; readonly db: string; readonly retention: RetentionSetting};

/** The options with the store choice resolved, which is what the indexing path is built from. */
export type ResolvedOptions = {
	processor: string;
	nodeUrl: string;
	deployments?: string;
	rps?: number;
	target: StoreTarget;
};
