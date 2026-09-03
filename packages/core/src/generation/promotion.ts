/**
 * THE PROMOTION POLICY: WHEN the canonical pointer moves on its own, and what
 * happens to the generation left behind.
 *
 * The registry owns the pointer as a MECHANISM -- move it, read it, move it back
 * (`moveCanonicalTo`). This module owns the POLICY over that mechanism, and the
 * container (`Indexer`) is what applies it, because the trigger needs a running
 * indexer and the registry is exercisable with none.
 *
 * ## Three values, and `on-catch-up` is the DEFAULT EVERYWHERE
 *
 * There is deliberately **no per-runtime and no per-environment default**,
 * because the axis that would select one is NOT DETECTABLE. Choosing between
 * these values wants a DEVELOPMENT-versus-PRODUCTION distinction, and nothing in
 * a browser build can tell which it is in. An undetectable axis with a dangerous
 * default is worse than no axis at all, so the SAFE value is the default
 * everywhere and the unsafe one is a deliberate opt-in. Do not add a
 * `process.env` sniff, an `import.meta.env.DEV` check or a per-package default
 * here or in any runtime: that is the mistake this shape exists to prevent.
 *
 * ## What the POLICY does NOT gate
 *
 * `Indexer.promote(id)` -- the verb a human or an app CALLS -- is not gated by
 * any of this, under any value. The policy governs the move the container makes
 * ON ITS OWN; an explicit promotion is somebody's decision and `manual` means
 * "only that", not "never". Moving the pointer BACK is likewise always available
 * and is how a promotion is reverted (story 4).
 */

/**
 * WHEN the canonical pointer moves to a successor, without anyone asking.
 *
 * - **`on-catch-up`** (the DEFAULT, everywhere) -- it moves when the successor
 *   reaches the cursor the canonical generation had. This is what an app author
 *   shipping to users wants: the app keeps rendering the complete old answers and
 *   switches when the new fold is ready, so a user who did not ask for the
 *   reconfigure never sees the state go backwards (stories 1, 3 and 14).
 * - **`immediate`** -- the successor becomes canonical the moment it is created,
 *   before it has caught up. OPT-IN, and it is what a developer iterating on a
 *   handler wants, because stale-but-complete answers from the fold they just
 *   replaced are more confusing than incomplete answers from the new one (story
 *   13). It is not something a deployment should ever land in by accident.
 * - **`manual`** -- it moves only when asked, so an operator can inspect first.
 */
export type PromotionPolicy = 'on-catch-up' | 'immediate' | 'manual';

/** The three, as a value, so a refusal can name them and a test can enumerate them. */
export const PROMOTION_POLICIES: readonly PromotionPolicy[] = ['on-catch-up', 'immediate', 'manual'];

/** The safe one, and it is the default in EVERY runtime. See the module JSDoc. */
export const DEFAULT_PROMOTION_POLICY: PromotionPolicy = 'on-catch-up';

/** What a deployment may say about promotion. Both halves default; neither is per-runtime. */
export type PromotionConfig = {
	/** Defaults to `on-catch-up`, everywhere. */
	policy?: PromotionPolicy;
	/**
	 * DROP-ON-PROMOTION: discard the superseded generation at the promotion.
	 *
	 * Defaults to `false`, which keeps it -- a generation that is no longer
	 * canonical is what the pointer moves BACK to, and that revert is the whole
	 * reason non-canonical generations are retained rather than evicted (story 4).
	 * A deployment that would rather bound its storage than keep a way back opts
	 * IN, and gets two generations transiently instead of N.
	 *
	 * It is deliberately not called *retention*: retention is pinned to a distance
	 * in BLOCK NUMBERS (ADR-0019), and this is not measured in anything.
	 */
	dropOnPromotion?: boolean;
};

/** The same, with nothing left to decide. */
export type UsedPromotionConfig = {
	readonly policy: PromotionPolicy;
	readonly dropOnPromotion: boolean;
};

/**
 * Fill in the defaults, in ONE place.
 *
 * Mirrors `resolveStreamConfig`: the default lives with the type it belongs to
 * rather than at each caller, so a second runtime cannot fork it -- which for
 * this particular default is the point rather than tidiness.
 */
export function resolvePromotionConfig(config?: PromotionConfig): UsedPromotionConfig {
	const policy = config?.policy ?? DEFAULT_PROMOTION_POLICY;
	if (!PROMOTION_POLICIES.includes(policy)) {
		throw new TypeError(
			`unknown promotion policy ${JSON.stringify(policy)}. It must be one of ` +
				`${PROMOTION_POLICIES.map((value) => `'${value}'`).join(', ')}, and it defaults to ` +
				`'${DEFAULT_PROMOTION_POLICY}' in every runtime.`,
		);
	}
	return {policy, dropOnPromotion: config?.dropOnPromotion ?? false};
}

/**
 * THE TRIGGER: has this generation reached the cursor it is being measured
 * against?
 *
 * Cursors are `lastToBlock`, the block a fold has processed up to. A generation
 * that has no cursor has processed nothing and has therefore reached nothing --
 * including the case where the target has no cursor either, since "neither has
 * started" is not a demonstration.
 *
 * The comparison is `>=` and against the LIVE cursor of the generation being
 * measured against, not a snapshot taken when the successor was created. A
 * snapshot would let a successor be promoted while the incumbent had moved on,
 * which is precisely the state going backwards that story 14 exists to prevent;
 * and the live comparison still converges, because a successor sharing the stream
 * folds it within the same cycle the writer appends it. (The one place a SNAPSHOT
 * is right is the deferred drop under `immediate`, where the question is "has the
 * successor made up what the previous generation had AT THE PROMOTION", and the
 * previous generation may have gone on advancing since.)
 */
export function hasReachedCursor(cursor: number | undefined, target: number | undefined): boolean {
	if (cursor === undefined || target === undefined) {
		return false;
	}
	return cursor >= target;
}
