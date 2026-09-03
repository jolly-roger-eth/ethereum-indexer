import type {Abi} from 'abitype';
import type {EIP1193ProviderWithoutEvents} from 'eip-1193';
import {logs} from 'named-logs';

import {IndexerGeneration, type LoadingState, type ReconfigureOutcome} from './indexer.js';
import {
	sameGeneration,
	type GenerationId,
	type GenerationRecord,
	type GenerationRegistry,
} from './generation/registry.js';
import {streamDigestOf} from './stream/identity.js';
import {readOnlyStream} from './stream/readOnly.js';
import {resolveStreamConfig} from './internal/engine/utils.js';
import type {
	EventProcessor,
	IndexingSource,
	LastSync,
	LogEvent,
	ProcessorDriftReport,
	ProvidedIndexerConfig,
	ProvidedStreamConfig,
} from './types.js';

const namedLogger = logs('@etherfold/core');

/* ---------------------------------------------------------------------------
 * THE GENERATION CONTAINER: the indexer that HOLDS generations, one of which is
 * canonical and answers every read.
 *
 * `IndexerGeneration` is one stream plus one processor
 * plus one state, which under this model is a GENERATION and not the container.
 * This is the container, and the name follows `CONTEXT.md`, which has defined
 * *indexer* as the named unit holding generations, carrying the caps and holding
 * ONE canonical pointer since ADR-0036.
 *
 * ## What it adds, and what it deliberately does not
 *
 * It adds four things:
 *
 * 1. **Generations are BUILT from factories, not handed over already built.** A
 *    container that holds N generations cannot be given one already-constructed
 *    processor over one already-constructed store, because each generation folds
 *    into its OWN state. So a generation arrives as a `GenerationSpec`: a state
 *    factory and a processor factory, called once each, in that order.
 * 2. **Reads resolve through the CANONICAL POINTER, indirectly.** `state` is a
 *    handle that answers from whichever generation is canonical NOW, so holding
 *    a reference across a promotion is never a way to read a retired generation
 *    (story 6).
 * 3. **A pointer move is APPLIED AT A NOTIFICATION.** See `promote` for why that
 *    single rule is the whole read unit of work, and why no scope API, no
 *    transaction handle and no timer is needed to get it.
 * 4. **EVERY generation it holds ADVANCES, and HOW each one advances is
 *    DETERMINED rather than configured.** A generation that shares its stream
 *    with one already held is a FOLLOWER: it fetches nothing, writes nothing,
 *    re-folds the stored stream from the start and then follows it. A generation
 *    on its own stream is an ordinary indexer at a different address. There is no
 *    knob, and `add` is where the rule lives.
 *
 * It also PUBLISHES a discard (`publishDiscard`), which is not a fifth thing but
 * the second one applied to the case `onStateUpdated` never covered: a fold that
 * was thrown away is neither adopted nor produced, so without this a subscriber
 * holding the state it lost is told by nothing.
 *
 * It does NOT decide WHEN the pointer moves (the promotion policy is
 * `the-promotion-policy-moves-the-canonical-pointer`), it does not pause a
 * generation (`a-generation-pauses-by-cap-and-drain`), and it does not yet turn a
 * reconfigure into a new generation: `updateIndexer` and `updateProcessor` still
 * do to the canonical generation exactly what they did before.
 * ------------------------------------------------------------------------- */

/** What both of a generation's factories are told about the generation being built. */
export type GenerationContext = {
	/**
	 * The stream this generation folds, as `streamDigestOf` renders it.
	 *
	 * Handed to both factories because it is the half of a generation's identity
	 * that IS known before the fold exists -- it is a function of the source and
	 * the stream config alone -- so a runtime that addresses storage per stream
	 * can do so without waiting for a processor.
	 */
	readonly stream: string;
};

/**
 * HOW ONE GENERATION IS BUILT: its state, then the fold over it.
 *
 * The order is forced by the identity and is worth stating, because it is what
 * makes the whole shape work without a circular dependency. A generation is
 * `{stream, processor version hash}`. The stream half is known up front. The
 * FOLD half is only known once the processor exists, and the processor needs its
 * state -- so the state cannot be keyed on the finished identity, and a design
 * that tried would deadlock on the first reload (find the record to learn the
 * store to build the processor to compute the record's key).
 *
 * The way out is that the factories are supplied PER GENERATION rather than once
 * for the container: the caller's own closure is what distinguishes this
 * generation's state from the next one's, and the container registers the
 * identity AFTER building, from the processor's own `getVersionHash()`. Nothing
 * has to be declared twice, and nothing can be declared wrongly.
 */
export type GenerationSpec<ABI extends Abi, ProcessResultType = void, State = unknown> = {
	/**
	 * Build the state THIS generation folds into. Called ONCE, before the
	 * processor.
	 *
	 * The container never touches the value: it exists as a separate step (rather
	 * than being folded into `createProcessor`) so that "each generation has its
	 * own state" is structural instead of a convention a caller may forget. On the
	 * entity path it is a `StateStore`; the container names no storage seam and
	 * cannot, since `@etherfold/core` does not depend on one.
	 */
	createState: (context: GenerationContext) => State | Promise<State>;
	/**
	 * Build the processor that folds it. The FACTORY, not its result.
	 *
	 * Its `getVersionHash()` is what NAMES this generation, so two generations
	 * over one stream are two records exactly when their folds differ -- which is
	 * the common reconfigure (a processor change re-fetches nothing) made
	 * identity.
	 */
	createProcessor: (
		state: State,
		context: GenerationContext,
	) => EventProcessor<ABI, ProcessResultType> | Promise<EventProcessor<ABI, ProcessResultType>>;
	/**
	 * The state handle to answer with BEFORE this generation has folded anything.
	 *
	 * Optional, and only interesting where the state is a READ HANDLE rather than
	 * a value: on the entity path `process()` hands back the same
	 * `EntityStateView` every time, and it exists the moment the processor does,
	 * so a reader must be able to hold it before the first event arrives. Without
	 * it the container answers with the last state this generation published, and
	 * with nothing at all until it publishes one.
	 */
	stateOf?: (processor: EventProcessor<ABI, ProcessResultType>) => ProcessResultType;
	/**
	 * The FETCH FILTER this generation folds, when it is not the container's own.
	 *
	 * A stream IS its fetch filter, so this is the only way to say "a different
	 * stream" -- and saying it is what makes the container's advance rule
	 * DETERMINED rather than configured: a generation naming no source of its own
	 * shares the container's stream and therefore FOLLOWS it, while one naming a
	 * different filter must fetch, because the logs it needs were never requested
	 * under the old one. There is deliberately no flag anywhere that says which.
	 *
	 * The stream CONFIG is deliberately NOT settable per generation, and that is a
	 * limit rather than an oversight: `setStreamConfig` is a single mutable value
	 * on the ONE keeper a container holds ("one keeper serves one indexer"), so two
	 * generations under different configs would clobber each other's address. A
	 * config change is still a new stream; reaching it needs a keeper per
	 * generation, which is nobody's landable yet.
	 */
	source?: IndexingSource<ABI>;
};

/**
 * A spec whose STATE type the container does not care about, which is all of
 * them: the value goes from one of the caller's factories to the other and the
 * container never looks inside it.
 */
export type AnyGenerationSpec<ABI extends Abi, ProcessResultType = void> = GenerationSpec<
	ABI,
	ProcessResultType,
	// deliberately `any`: this is the existential the container holds, and `unknown`
	// here would force every caller to cast its own store back out again
	/* eslint-disable-next-line */ any
>;

/** What the container keeps per generation. Internal: `HeldGeneration` is what it hands out. */
type HeldEntry<ABI extends Abi, ProcessResultType> = {
	record: GenerationRecord;
	generation: IndexerGeneration<ABI, ProcessResultType>;
	processor: EventProcessor<ABI, ProcessResultType>;
	spec: AnyGenerationSpec<ABI, ProcessResultType>;
	/** Whether this generation FOLLOWS a stream another generation writes. See `add`. */
	follows: boolean;
	published?: ProcessResultType;
	/** Distinguishes "published nothing yet" from "published `undefined`", which a `void` fold does. */
	hasPublished: boolean;
	/**
	 * How many times this generation has published a state.
	 *
	 * Read ONLY as a comparison across a reconfigure, to answer "did the fold
	 * produce a state while that call was running?". A discard does not always
	 * leave nothing: when the STREAM survives (a processor swap leaves the cached
	 * events untouched, since the stream verdict is about the source and the config
	 * and not the processor), the `load` inside the verb replays it and publishes
	 * the REBUILT state before the verb returns. Dropping the handle after that
	 * would throw away the very thing the rebuild produced.
	 */
	publications: number;
};

/** One generation this container holds: its record, its engine, its fold. */
export type HeldGeneration<ABI extends Abi, ProcessResultType = void> = {
	readonly record: GenerationRecord;
	/** The engine that fetches and folds for this generation. */
	readonly generation: IndexerGeneration<ABI, ProcessResultType>;
	/** The processor this generation folds with. */
	readonly processor: EventProcessor<ABI, ProcessResultType>;
	/**
	 * Whether this generation FOLLOWS a stream another held generation writes,
	 * rather than fetching its own.
	 *
	 * REPORTED and never set: it is a consequence of sharing a stream, and a caller
	 * that could choose it would be choosing to break the one-writer rule. Exposed
	 * so a driver or a test can see what was determined instead of inferring it
	 * from a fetch count.
	 */
	readonly follows: boolean;
};

/**
 * The registry names a canonical generation this container was not given
 * factories for.
 *
 * REFUSED rather than worked around, and the two obvious ways around it are both
 * worse. Silently promoting the generation that WAS built would move the
 * canonical pointer without anybody asking, which is the one thing a container
 * that holds a revertible history must never do on its own. Running the built
 * generation while the pointer names another would answer reads from a
 * generation the registry says is not canonical -- silently, and exactly the
 * staleness the indirect handle exists to prevent.
 *
 * It is reachable today only across a restart against a DURABLE registry whose
 * pointer was moved by an earlier session. Resuming several generations is the
 * promotion policy's and the shared-stream follower's business; until they land,
 * a caller either supplies the specs for the canonical generation or moves the
 * pointer back before opening.
 */
export class CanonicalGenerationNotHeldError extends Error {
	readonly name = 'CanonicalGenerationNotHeldError';

	constructor(
		readonly canonical: GenerationId,
		readonly held: readonly GenerationId[],
	) {
		super(
			`the canonical generation {stream: ${canonical.stream}, processor: ${canonical.processor}} is not one this ` +
				`indexer was built to hold, so nothing here can answer a read. Held: ` +
				`${held.map((id) => `{stream: ${id.stream}, processor: ${id.processor}}`).join(', ') || '(none)'}. ` +
				`Supply the spec that builds the canonical generation, or move the canonical pointer to one of the held ` +
				`generations before opening -- this is never fixed by promoting one of them here, because which ` +
				`generation answers reads is not a decision an open may take on its own.`,
		);
	}
}

/** A generation the container does not hold, named to a container operation. */
export class UnheldGenerationError extends Error {
	readonly name = 'UnheldGenerationError';

	constructor(readonly id: GenerationId) {
		super(
			`this indexer holds no generation {stream: ${id.stream}, processor: ${id.processor}}. A registered ` +
				`generation this container did not build has no engine and no state here, so pointing reads at it would ` +
				`answer them from nothing.`,
		);
	}
}

/** What `openIndexer` needs: where the generations are recorded, what they index, and how to build them. */
export type IndexerOptions<ABI extends Abi, ProcessResultType = void> = {
	/** Which generations this indexer holds, which one is canonical, and the caps that refuse. */
	registry: GenerationRegistry;
	provider: EIP1193ProviderWithoutEvents;
	source: IndexingSource<ABI>;
	config?: ProvidedIndexerConfig<ABI>;
	/**
	 * The generations to build and register, in order.
	 *
	 * The FIRST one registered becomes canonical when nothing is canonical yet,
	 * which is the registry's rule and not a policy of this container's.
	 */
	generations: readonly AnyGenerationSpec<ABI, ProcessResultType>[];
	/**
	 * How a generation's ENGINE is constructed. Defaults to
	 * `new IndexerGeneration(...)`.
	 *
	 * The same seam `createIndexerState`'s `createIndexer` option is, kept at this
	 * level too so a container can be driven by a subclass, a shared instance or a
	 * spy without the generation shape leaking into a test's assertions.
	 */
	createGeneration?: (
		provider: EIP1193ProviderWithoutEvents,
		processor: EventProcessor<ABI, ProcessResultType>,
		source: IndexingSource<ABI>,
		config: ProvidedIndexerConfig<ABI>,
	) => IndexerGeneration<ABI, ProcessResultType>;
};

/** Whether a value can be reached THROUGH, which is what an indirect handle needs. */
function isIndirectable(value: unknown): value is object {
	return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/**
 * A handle with STABLE IDENTITY that reads through to whatever `resolve()`
 * currently answers.
 *
 * This is the whole of story 6's mechanism. The entity path hands a consumer a
 * read HANDLE rather than a state object -- the same `EntityStateView` every
 * time, bound to one store -- so a consumer that kept one across a promotion
 * would go on reading the retired generation's rows forever, with nothing to
 * indicate it. Reached through a resolver instead, the reference a consumer
 * holds is a reference to WHICHEVER GENERATION IS CANONICAL, and the pointer
 * move is the only thing that has to be correct.
 *
 * Every trap resolves afresh; the target is only ever the object the proxy
 * invariants are checked against. Methods are bound to the resolved target so a
 * destructured read (`const {getCurrent} = state`) cannot end up running against
 * the proxy. What it deliberately does NOT do is copy: there is no snapshot to
 * go stale.
 */
function indirectHandle<T extends object>(target: T, resolve: () => T): T {
	return new Proxy(target, {
		get(_target, property) {
			const current = resolve();
			const value = Reflect.get(current, property, current);
			return typeof value === 'function' ? (value as (...args: unknown[]) => unknown).bind(current) : value;
		},
		set(_target, property, value) {
			return Reflect.set(resolve(), property, value);
		},
		has(_target, property) {
			return Reflect.has(resolve(), property);
		},
		getPrototypeOf() {
			return Reflect.getPrototypeOf(resolve());
		},
	});
}

/**
 * The container, opened over its registry.
 *
 * Asynchronous because building a generation is: the state factory opens a
 * store, and the registry is a substrate that has to be read. See `Indexer`.
 */
export async function openIndexer<ABI extends Abi, ProcessResultType = void>(
	options: IndexerOptions<ABI, ProcessResultType>,
): Promise<Indexer<ABI, ProcessResultType>> {
	const indexer = new Indexer<ABI, ProcessResultType>(options);
	await indexer.open(options.generations);
	return indexer;
}

/**
 * AN INDEXER: several generations, one canonical pointer, one answer set.
 *
 * Built through `openIndexer`. See the module JSDoc above for what it adds over
 * a single `IndexerGeneration` and what it deliberately leaves to later work.
 */
export class Indexer<ABI extends Abi, ProcessResultType = void> {
	// ------------------------------------------------------------------------------------------------------------------
	// THE CALLBACKS, which are the GENERATION's callbacks forwarded from whichever generation is canonical
	// ------------------------------------------------------------------------------------------------------------------
	public onLoad: ((state: LoadingState) => Promise<void>) | undefined;
	/**
	 * The NOTIFICATION. It publishes the INDIRECT handle rather than the value the
	 * canonical generation produced, so a subscriber that keeps what it is handed
	 * keeps something that follows the pointer.
	 */
	public onStateUpdated: ((state: ProcessResultType) => void) | undefined;
	public onLastSyncUpdated: ((lastSync: LastSync<ABI>) => void) | undefined;
	public onProcessorDrift: ((report: ProcessorDriftReport) => void) | undefined;

	protected readonly registry: GenerationRegistry;
	protected provider: EIP1193ProviderWithoutEvents;
	protected source: IndexingSource<ABI>;
	protected config: ProvidedIndexerConfig<ABI>;
	protected readonly createGeneration: NonNullable<IndexerOptions<ABI, ProcessResultType>['createGeneration']>;

	/** The stream every generation built from here folds. Recomputed by a reconfigure. */
	protected streamDigest: string;

	protected readonly held: HeldEntry<ABI, ProcessResultType>[] = [];

	/**
	 * WHICH generation reads resolve to, and it moves ONLY inside `notifyState`.
	 *
	 * It is not the same thing as the registry's canonical pointer, and the
	 * difference IS the read unit of work: the registry records the decision the
	 * moment it is taken, and this follows it at the next notification, so no read
	 * ever observes the pointer moving under it without being told.
	 */
	protected current: HeldEntry<ABI, ProcessResultType> | undefined;

	/** The indirect handle, created once so its identity is stable. */
	protected handle: {value: ProcessResultType} | undefined;

	constructor(options: IndexerOptions<ABI, ProcessResultType>) {
		this.registry = options.registry;
		this.provider = options.provider;
		this.source = options.source;
		this.config = options.config ?? {};
		this.createGeneration =
			options.createGeneration ??
			((provider, processor, source, config) =>
				new IndexerGeneration<ABI, ProcessResultType>(provider, processor, source, config));
		this.streamDigest = this.digestOf(this.source, this.config);
	}

	/** Build and register the generations, then resolve the canonical pointer onto one of them. */
	async open(specs: readonly AnyGenerationSpec<ABI, ProcessResultType>[]): Promise<void> {
		for (const spec of specs) {
			await this.add(spec);
		}
		await this.resolveCanonical();
	}

	// ------------------------------------------------------------------------------------------------------------------
	// THE GENERATIONS
	// ------------------------------------------------------------------------------------------------------------------

	/**
	 * Build a generation and register it BESIDE the ones already held.
	 *
	 * It does not become canonical (unless nothing is, which is the registry's
	 * rule for the first one), and it DOES advance -- but how it advances is
	 * decided here and is not a choice anybody gets to make.
	 *
	 * ## The rule: a SHARED stream makes a FOLLOWER, and nothing else does
	 *
	 * A generation whose stream digest matches one already held is handed a
	 * READ-ONLY VIEW of the keeper (`readOnlyStream`) and advances with
	 * `followMore`: it fetches NOTHING, writes NOTHING, re-folds the stored stream
	 * from the start and then follows it as the indexing generation appends. A
	 * generation on a stream nobody here holds keeps the keeper itself and advances
	 * with `indexMore`, which is an ordinary indexer at a different address.
	 *
	 * There is no flag, because a flag would be wrong in both positions. "Follow a
	 * stream nobody writes" never advances; "fetch a stream somebody else writes"
	 * is a second writer, and it also makes this generation's state a function of
	 * its own fetch rather than of the stream, which is what would break the exact
	 * revert (`IndexerGeneration.followMore`). ADR-0044 records the rule and the
	 * options weighed against it.
	 *
	 * ## Which generation WRITES a stream: the first one held on it
	 *
	 * Registration order and not the canonical pointer, so the writer is stable:
	 * moving the pointer is one small record write and must not silently hand the
	 * append duty to a different engine mid-flight. The normal case makes the two
	 * the same thing anyway, since the first generation registered is the one the
	 * registry makes canonical.
	 *
	 * The registry is written BEFORE the engine exists, which is the order its own
	 * documentation asks for: a stream subtree no registered generation claims is
	 * what the sweep collects, so nothing may write a stream ahead of its
	 * registration.
	 */
	async add(spec: AnyGenerationSpec<ABI, ProcessResultType>): Promise<HeldGeneration<ABI, ProcessResultType>> {
		const source = spec.source ?? this.source;
		const context: GenerationContext = {
			stream: spec.source ? this.digestOf(spec.source, this.config) : this.streamDigest,
		};
		const state = await spec.createState(context);
		const processor = await spec.createProcessor(state, context);
		const record = await this.registry.create({stream: context.stream, processor: processor.getVersionHash()});

		const existing = this.held.find((entry) => sameGeneration(entry.record, record));
		if (existing) {
			// The same generation, named twice. The registry RESOLVES rather than
			// duplicating, and so does this: a second engine over one generation's
			// state would be two writers to it.
			namedLogger.info(
				`the generation {stream: ${record.stream}, processor: ${record.processor}} is already held, so the spec ` +
					`resolved to it rather than adding a second engine over the same state.`,
			);
			return this.heldOf(existing);
		}

		// DETERMINED, and determined HERE: everything downstream reads this rather
		// than re-deciding it, so there is one place the rule lives.
		const follows = this.held.some((entry) => entry.record.stream === record.stream);
		const config: ProvidedIndexerConfig<ABI> =
			follows && this.config.keepStream
				? {...this.config, keepStream: readOnlyStream<ABI>(this.config.keepStream)}
				: this.config;

		const generation = this.createGeneration(this.provider, processor, source, config);
		const entry: HeldEntry<ABI, ProcessResultType> = {
			record,
			generation,
			processor,
			spec,
			follows,
			hasPublished: false,
			publications: 0,
		};
		this.held.push(entry);

		generation.onLoad = async (loadingState) => {
			if (entry === this.current) {
				await this.onLoad?.(loadingState);
			}
		};
		generation.onLastSyncUpdated = (lastSync) => {
			if (entry === this.current) {
				this.onLastSyncUpdated?.(lastSync);
			}
		};
		generation.onProcessorDrift = (report) => {
			if (entry === this.current) {
				this.onProcessorDrift?.(report);
			}
		};
		generation.onStateUpdated = (published) => {
			entry.published = published;
			entry.hasPublished = true;
			entry.publications++;
			if (entry === this.current) {
				this.notifyState();
			}
		};

		return this.heldOf(entry);
	}

	/** Every generation this container holds, in the order it built them. */
	get generations(): readonly HeldGeneration<ABI, ProcessResultType>[] {
		return this.held.map((entry) => this.heldOf(entry));
	}

	/** The generation that answers reads right now. */
	get canonical(): HeldGeneration<ABI, ProcessResultType> {
		return this.heldOf(this.requireCurrent());
	}

	/**
	 * THE READ HANDLE, and it is INDIRECT.
	 *
	 * A consumer may keep it: it answers from whichever generation is canonical
	 * when the read is made, so a promotion cannot leave a held reference reading
	 * a retired generation's state (story 6). It is the same object every time,
	 * because a handle that changed identity on every publication would defeat
	 * exactly the callers who keep one.
	 *
	 * Where the state is a VALUE rather than a handle (a plain object a processor
	 * hands back, or nothing at all) there is no indirection to give: the value is
	 * returned as it is, resolved per call, and the notification is what tells a
	 * caller to read again.
	 */
	get state(): ProcessResultType {
		if (this.handle) {
			return this.handle.value;
		}
		const current = this.resolveState();
		if (!isIndirectable(current)) {
			return current;
		}
		this.handle = {value: indirectHandle(current, () => this.resolveState() as object) as ProcessResultType};
		return this.handle.value;
	}

	/**
	 * MOVE THE CANONICAL POINTER, and apply the move AT A NOTIFICATION.
	 *
	 * ## The read unit of work is the interval between notifications
	 *
	 * The pointer is recorded in the registry first (that is the durable decision:
	 * forwards it is promotion, backwards it is revert), and the READ PATH follows
	 * it inside `notifyState` and nowhere else. So the only moment a reader can
	 * observe a different generation is a moment it was told about, and every read
	 * between two notifications answers from ONE generation.
	 *
	 * That boundary already existed -- `createIndexerState` publishes through
	 * subscribable stores and the core's state callback, and an app already treats
	 * a notification as "the world moved, re-read" -- which is why there is no
	 * scope API here, no transaction handle and no timer. Inventing one would add
	 * a second thing to get right for a guarantee the existing one already gives.
	 *
	 * **The residual, stated rather than discovered:** a caller reading OUTSIDE
	 * any subscription (a one-off read in an event handler) gets per-CALL
	 * resolution, so two such reads either side of a promotion can straddle it.
	 * That is tolerable and bounded: each read is answered by a generation that
	 * was canonical when it was made, and neither read is stale.
	 */
	async promote(id: GenerationId): Promise<GenerationRecord> {
		const entry = this.held.find((held) => sameGeneration(held.record, id));
		if (!entry) {
			throw new UnheldGenerationError({stream: id.stream, processor: id.processor});
		}
		const record = await this.registry.moveCanonicalTo(id);
		this.applyAtNotification(entry);
		return record;
	}

	// ------------------------------------------------------------------------------------------------------------------
	// THE VERBS, on the canonical generation
	// ------------------------------------------------------------------------------------------------------------------
	// Delegation and nothing else, deliberately: a reconfigure that BUILDS a new
	// generation beside the live one is the promotion policy's
	// (`the-promotion-policy-moves-the-canonical-pointer`), and this batch removes
	// nothing and changes no behaviour of what a caller already had.

	get defaultFromBlock(): number {
		return this.requireCurrent().generation.defaultFromBlock;
	}

	get finalityDepth(): number {
		return this.requireCurrent().generation.finalityDepth;
	}

	get expectedFromBlock(): number {
		return this.requireCurrent().generation.expectedFromBlock;
	}

	/**
	 * Load EVERY generation, and answer with the canonical one's cursor.
	 *
	 * All of them, because a generation that has not loaded has no state and no
	 * cursor, so it could not advance afterwards -- and for a FOLLOWER the load IS
	 * the re-fold of the stored stream from the start. In HELD ORDER, which puts a
	 * stream's writer before anything following it, so a follower's first re-fold
	 * sees whatever the writer's load recovered. `load` is idempotent per
	 * generation (`_load.once()`), so naming the canonical one twice costs nothing.
	 */
	async load(): Promise<LastSync<ABI>> {
		const current = this.requireCurrent();
		for (const entry of this.held) {
			await entry.generation.load();
		}
		return current.generation.load();
	}

	/**
	 * Advance EVERY generation one step, each by the verb its stream decides, and
	 * answer with the canonical one's cursor.
	 *
	 * The order is the order they were built, which is what makes a follower's step
	 * meaningful: a stream's writer is always ahead of it in that list, so by the
	 * time a follower reads the stream this cycle's batch is already in it. A
	 * follower that ran first would simply see nothing new and catch up on the next
	 * tick, so the order is a latency decision rather than a correctness one -- but
	 * a driver that loops to the tip would otherwise leave every follower one cycle
	 * short at the end.
	 *
	 * The canonical generation is resolved BEFORE the loop, so a promotion applied
	 * mid-cycle cannot make this return a cursor from a generation that was not the
	 * one being driven.
	 */
	async indexMore(): Promise<LastSync<ABI>> {
		const current = this.requireCurrent();
		let answer: LastSync<ABI> | undefined;
		for (const entry of this.held) {
			const lastSync = entry.follows ? await entry.generation.followMore() : await entry.generation.indexMore();
			if (entry === current) {
				answer = lastSync;
			}
		}
		// The canonical generation is always one this container holds -- that is what
		// `resolveCanonical` refuses to open without -- so the loop always answered.
		return answer as LastSync<ABI>;
	}

	feed(eventStream: LogEvent<ABI>[], lastSyncFetched?: LastSync<ABI>): Promise<LastSync<ABI>> {
		return this.requireCurrent().generation.feed(eventStream, lastSyncFetched);
	}

	replay(eventStream: LogEvent<ABI>[], lastSyncStored: LastSync<ABI>): Promise<LastSync<ABI>> {
		return this.requireCurrent().generation.replay(eventStream, lastSyncStored);
	}

	/** Stop EVERY generation, because every generation is what advances. */
	disableProcessing(): void {
		for (const entry of this.held) {
			entry.generation.disableProcessing();
		}
	}

	reenableProcessing(): void {
		for (const entry of this.held) {
			entry.generation.reenableProcessing();
		}
	}

	async reset(): Promise<ReconfigureOutcome> {
		const entry = this.requireCurrent();
		const publishedBefore = entry.publications;
		const outcome = await entry.generation.reset();
		this.publishDiscard(entry, outcome, publishedBefore);
		return outcome;
	}

	async updateIndexer(update: {
		provider?: EIP1193ProviderWithoutEvents;
		source?: IndexingSource<ABI>;
		streamConfig?: ProvidedStreamConfig;
	}): Promise<ReconfigureOutcome> {
		const entry = this.requireCurrent();
		const publishedBefore = entry.publications;
		const outcome = await entry.generation.updateIndexer(update);
		// The source or the stream config may have moved, so the stream a
		// generation built from here folds has too. Recomputed rather than cached
		// once: a generation added after a reconfigure belongs to the stream running
		// NOW, and a stale digest would file it under the stream it replaced.
		this.provider = update.provider ?? this.provider;
		this.source = update.source ?? this.source;
		this.config = update.streamConfig ? {...this.config, stream: update.streamConfig} : this.config;
		this.streamDigest = this.digestOf(this.source, this.config);
		// Last, so a listener woken by the discard reads a container that has already
		// finished moving.
		this.publishDiscard(entry, outcome, publishedBefore);
		return outcome;
	}

	/**
	 * Swap the canonical generation's processor IN PLACE, exactly as before.
	 *
	 * Under the generation model a processor change is a NEW GENERATION over the
	 * same stream, built beside the live one and promoted when it is ready. That is
	 * the promotion policy's landable (`the-promotion-policy-moves-the-canonical-pointer`),
	 * and reaching for it here would be the outage-shaped in-place discard wearing
	 * a container. So this batch keeps today's behaviour and today's cost, and only
	 * keeps the container HONEST about it: the held entry now names the processor
	 * that is actually folding, so the read handle cannot answer from the fold that
	 * was replaced. The registry record still names the fold this generation was
	 * REGISTERED with, which is the drift the policy task closes by creating a
	 * generation instead of mutating one.
	 */
	async updateProcessor(
		newProcessor: EventProcessor<ABI, ProcessResultType>,
		options?: {force?: boolean},
	): Promise<ReconfigureOutcome> {
		const entry = this.requireCurrent();
		const publishedBefore = entry.publications;
		const outcome = await entry.generation.updateProcessor(newProcessor, options);
		if (outcome.stateDiscarded) {
			// Recorded BEFORE the discard is published, and unconditionally: the state to
			// publish is the NEW fold's read handle, which is a handle onto a different
			// store whenever the declarations changed.
			entry.processor = newProcessor;
		}
		this.publishDiscard(entry, outcome, publishedBefore);
		return outcome;
	}

	// ------------------------------------------------------------------------------------------------------------------
	// INTERNALS
	// ------------------------------------------------------------------------------------------------------------------

	protected digestOf(source: IndexingSource<ABI>, config: ProvidedIndexerConfig<ABI>): string {
		return streamDigestOf(source, resolveStreamConfig(config.stream));
	}

	/** What the container hands OUT for a generation it holds. */
	protected heldOf(entry: HeldEntry<ABI, ProcessResultType>): HeldGeneration<ABI, ProcessResultType> {
		return {
			record: entry.record,
			generation: entry.generation,
			processor: entry.processor,
			follows: entry.follows,
		};
	}

	/**
	 * DROP WHAT THE DISCARD DESTROYED, AND SAY SO.
	 *
	 * The three reconfiguring verbs all end in one of two places -- the fold
	 * survived, or it is gone and being rebuilt -- and `onStateUpdated` fires when a
	 * state is ADOPTED or PRODUCED, so it fires for neither. A subscriber holding
	 * the state the fold just lost is therefore told by nothing, and on the
	 * reconfigure this exists for (a contract redeployed behind its proxy, which has
	 * emitted nothing yet) the next publication never comes at all: the old
	 * contract's numbers stay on screen for the rest of the session.
	 *
	 * So the container publishes the discard, which is a NOTIFICATION and not a new
	 * state: what goes out is the same indirect handle every publication carries,
	 * now resolving to the fold that has processed nothing. `createIndexerState` did
	 * this for its own `state` store until `the-old-indexer-shape-is-deleted`; it is
	 * here because the container is what knows a verb discarded, and because every
	 * other consumer of one (a server, a CLI, a test) was never told at all.
	 *
	 * **A DISCARD DOES NOT ALWAYS LEAVE NOTHING**, which is the whole reason for the
	 * `publishedBefore` guard. When the STREAM survives -- which a processor swap
	 * always leaves it, since the stream verdict is about the source and the config
	 * and not the processor -- the `load` inside the verb REPLAYS the cached events
	 * and publishes the rebuilt state before the verb returns. That publication is
	 * the truth; dropping the handle and re-announcing an empty fold on top of it
	 * would report a correct rebuild to every subscriber as an empty state, with the
	 * cursor already past the blocks, so nothing would arrive later to correct it.
	 */
	protected publishDiscard(
		entry: HeldEntry<ABI, ProcessResultType>,
		outcome: ReconfigureOutcome,
		publishedBefore: number,
	): void {
		if (!outcome.stateDiscarded || entry.publications !== publishedBefore) {
			return;
		}
		// What this generation last published no longer exists, so the handle must stop
		// answering with it: it falls back to the fold's own read handle, which is what
		// a processor that has processed nothing has.
		entry.hasPublished = false;
		entry.published = undefined;
		if (entry === this.current) {
			this.notifyState();
		}
	}

	/** Point the read path at the generation the registry already calls canonical. */
	protected async resolveCanonical(): Promise<void> {
		const canonical = await this.registry.canonical();
		if (!canonical) {
			// Nothing is registered at all, which only happens when this container was
			// opened with no generations. Reads have nothing to answer from and say so
			// at the point of asking rather than here.
			return;
		}
		const entry = this.held.find((held) => sameGeneration(held.record, canonical));
		if (!entry) {
			throw new CanonicalGenerationNotHeldError(
				{stream: canonical.stream, processor: canonical.processor},
				this.held.map((held) => ({stream: held.record.stream, processor: held.record.processor})),
			);
		}
		this.current = entry;
	}

	protected requireCurrent(): HeldEntry<ABI, ProcessResultType> {
		if (!this.current) {
			throw new Error(
				`this indexer holds no canonical generation, so there is nothing to index with and nothing to read from. ` +
					`Open it with at least one generation spec.`,
			);
		}
		return this.current;
	}

	/** What the canonical generation answers with: what it last published, or its handle. */
	protected resolveState(): ProcessResultType {
		const entry = this.requireCurrent();
		if (entry.hasPublished) {
			return entry.published as ProcessResultType;
		}
		return entry.spec.stateOf?.(entry.processor) as ProcessResultType;
	}

	/**
	 * The one place the read path's pointer moves, and it moves WITH a
	 * notification.
	 */
	protected applyAtNotification(entry: HeldEntry<ABI, ProcessResultType>): void {
		this.current = entry;
		this.notifyState();
	}

	protected notifyState(): void {
		if (!this.onStateUpdated) {
			return;
		}
		try {
			this.onStateUpdated(this.state);
		} catch (err) {
			namedLogger.error(`onStateUpdated listener threw`, err);
		}
	}
}
