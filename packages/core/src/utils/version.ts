/**
 * Refuse to construct a processor that has not declared what version of the
 * logic it is.
 *
 * At CONSTRUCTION rather than at `load`, so the mistake cannot survive to the
 * point where it silently costs something. A missing version used to fall back
 * to the literal string `unknown`, which made `getVersionHash()` a CONSTANT:
 * no logic change ever invalidated stored state, and under `docs/adr/0008`,
 * where a version change is what triggers the blue-green rebuild, the rebuild
 * would simply never run and state computed by replaced logic would be served
 * indefinitely.
 *
 * Lives in the core, shared by both `EventProcessor` implementations, so that
 * the two say the same thing: the failure is one failure, and the second
 * implementation reproduced the first one's fallback on the day it was written.
 *
 * @param processor the AUTHOR's processor object, whose handler names are the
 * only name a plain object has
 * @param implementation the class refusing, so the message says where to look
 */
export function assertProcessorVersion(processor: {version?: string}, implementation: string): void {
	if (typeof processor.version === 'string' && processor.version.trim().length > 0) {
		return;
	}
	throw new Error(
		`${implementation}: the processor ${describeProcessor(processor)} has no \`version\`. ` +
			`\`version\` is REQUIRED: it is the whole of the processor's declared identity, and the indexer discards ` +
			`state computed by a previous version by comparing it. Without one, every version of your handlers hashes ` +
			`to the same value, so state computed by logic you have since replaced is reused forever, silently. ` +
			`Set a non-empty \`version\` on the processor object (ideally generated, so it changes whenever the code does).`,
	);
}

/** The handler names of a processor, which is the only name a plain processor object has. */
function describeProcessor(processor: object): string {
	const names = Object.keys(processor).filter(
		(key) => typeof (processor as Record<string, unknown>)[key] === 'function',
	);
	return names.length > 0 ? `(handlers: ${names.join(', ')})` : `(no handlers)`;
}
