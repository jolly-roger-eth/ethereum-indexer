import type {AbiEvent} from 'abitype';
import {toEventSelector, toEventSignature} from 'viem';

/**
 * WHAT MAKES TWO DECLARATIONS THE SAME EVENT. One answer, in one place.
 *
 * Two things in this package have to agree about it and would drift apart with
 * their own copies: the fetch filter (`LogEventFetcher`, which collapses the
 * declarations that ARE the same event and refuses the ones nothing tells
 * apart) and the block ranges an event is live over (`eventRanges`, which
 * groups occurrences of one event before unioning their ranges). If those two
 * disagreed, a source could carry two ranges for what the fetcher considers one
 * event, or one range for what it considers two.
 */

/**
 * The canonical signature -- `Transfer(address,address,uint256)` -- which is
 * what `topic0` is the hash of, and therefore the identity a LOG carries.
 *
 * Deliberately not the NAME: two versions of one event across an upgrade, and
 * two contracts declaring same-named events, share a name and are trivially
 * told apart on the wire.
 */
export function canonicalSignatureOf(event: AbiEvent): string {
	return toEventSignature(event);
}

/**
 * The `topic0` an event's logs carry, or `undefined` for an ANONYMOUS event,
 * which carries none.
 *
 * Computed per EVENT and never by name, which is the whole point:
 * `encodeEventTopics` selects an ABI item by NAME, so two events sharing a name
 * resolve to whichever one it found first, and the other's topic0 could never
 * enter the fetch filter.
 */
export function topic0Of(event: AbiEvent): `0x${string}` | undefined {
	return event.anonymous ? undefined : toEventSelector(event);
}

/** An event as an operator would recognise it in the ABI, for a refusal message. */
export function describeEventDeclaration(event: AbiEvent): string {
	const inputs = event.inputs
		.map((input) => `${input.type}${input.indexed ? ' indexed' : ''}${input.name ? ` ${input.name}` : ''}`)
		.join(', ');
	return `${event.anonymous ? 'anonymous ' : ''}event ${event.name}(${inputs})`;
}

/**
 * What decoding a log against this event actually READS.
 *
 * Deliberately NOT `internalType`, which is a Solidity-side annotation that two
 * compilations of the same event routinely disagree about (`address` vs
 * `contract IERC20`). Refusing on it would reject an ABI that is genuinely the
 * same event, and this refusal stops the indexer starting, so it has to be
 * about the wire and nothing else. A missing parameter name reads as `''` for
 * the same reason.
 *
 * It is also what an event entry is HASHED on for invalidation, so that
 * regenerating an ABI and getting a different `internalType` does not discard a
 * user's whole indexed history.
 */
export function decodingShapeOf(event: AbiEvent): unknown {
	const shapeOfParameter = (parameter: any): unknown => ({
		name: parameter.name ?? '',
		type: parameter.type,
		indexed: !!parameter.indexed,
		components: parameter.components ? parameter.components.map(shapeOfParameter) : undefined,
	});
	return {anonymous: !!event.anonymous, inputs: event.inputs.map(shapeOfParameter)};
}
