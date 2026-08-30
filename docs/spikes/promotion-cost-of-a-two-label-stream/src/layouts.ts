/**
 * The two candidate layouts for a two-label stream, over ONE key/value port.
 *
 * The design record (`work/notes/ideas/stream-grafting-what-we-established.md`)
 * chose the two-label model: every stream entry carries a label, `live` or
 * `staging`; a staging reader takes `gen = staging OR (gen = live AND seq <= N)`;
 * promotion deletes the live entries above N and relabels staging to live.
 *
 * On a relational store promotion is one indexed UPDATE. In a key/value store
 * there is no bulk update, so promotion touches one entry per staging segment,
 * and the question this spike exists to answer is WHERE THE LABEL LIVES:
 *
 *   key-label    the label is part of the key, so a relabel is a RENAME
 *   value-label  the label is a field of the value, so a relabel is a REWRITE
 *
 * Both layouts are implemented here, once, against the same port, so the two
 * keepers differ only in the port they supply and not in what is being measured.
 */

/** The two labels. There are exactly two, forever: relabelling on promotion is what stops a third. */
export type Gen = 'live' | 'staging';

/** A stored segment: a batch of events plus the `lastSync` current after them. */
export type Segment = {
	lastSync: unknown;
	eventStream: unknown[];
};

/**
 * The key/value port a keeper supplies.
 *
 * `rename` is OPTIONAL and its absence is not an oversight: it is half the
 * result. The filesystem has a native rename; IndexedDB has none, so a
 * key-label relabel there degrades to read-plus-write, which is exactly what
 * the value-label layout costs anyway.
 */
export type StorePort = {
	keys(): Promise<string[]>;
	get(key: string): Promise<any>;
	set(key: string, value: any): Promise<void>;
	del(key: string): Promise<void>;
	rename?(from: string, to: string): Promise<void>;
	/** Batched forms, where the substrate has them (`idb-keyval` ships all three). */
	getMany?(keys: string[]): Promise<any[]>;
	setMany?(entries: [string, any][]): Promise<void>;
	delMany?(keys: string[]): Promise<void>;
};

/** What one promotion cost, in substrate-independent WORK rather than wall-clock. */
export type PromotionCost = {
	/** Entries whose PAYLOAD crossed the storage boundary (read back and written out). */
	payloadsRewritten: number;
	/** Entries relabelled by a metadata-only operation (a rename). */
	metadataRenames: number;
	/** Superseded live entries deleted. Identical between layouts by construction. */
	deletes: number;
	/**
	 * Bytes of segment payload the relabel had to move.
	 *
	 * Measured as the JSON length of every value passed through `set`, which is
	 * a substrate-independent accounting of the work, NOT a claim about what
	 * either store wrote to disk. IndexedDB does not expose structured-clone
	 * size (the same reason `appending-to-the-stream-costs-the-batch` counts its
	 * seal threshold in EVENTS rather than bytes), so a metric that both keepers
	 * can report is the only one that can be compared across them.
	 */
	payloadBytesMoved: number;
	/** Round trips to the store. Separated from bytes: on IndexedDB a transaction has its own floor cost. */
	storeOps: number;
};

const ZERO: PromotionCost = {
	payloadsRewritten: 0,
	metadataRenames: 0,
	deletes: 0,
	payloadBytesMoved: 0,
	storeOps: 0,
};

export type Layout = {
	readonly name: string;
	/** True when a relabel moves no payload. Only the filesystem key-label arm can say yes. */
	readonly relabelIsMetadataOnly: boolean;
	/** Append one segment to a generation at the given sequence number. */
	append(gen: Gen, seq: number, segment: Segment): Promise<void>;
	/** The keys a reader of `gen` reads, IN ORDER, for a staging generation grafted at `graftAt`. */
	readOrder(gen: Gen, graftAt: number): Promise<string[]>;
	/** Make staging live. Returns what it cost. */
	promote(graftAt: number): Promise<PromotionCost>;
};

/**
 * How wide a sequence number is rendered in a key.
 *
 * Fixed-width because the keys are also the READ ORDER: `idb-keyval`'s `keys()`
 * and a `readdir` both return lexicographic order, and `_10` sorts before `_2`.
 * This is incidental to the cost question but a layout that got it wrong would
 * be measuring a stream it replays out of order.
 */
const SEQ_WIDTH = 6;
const seqOf = (n: number) => String(n).padStart(SEQ_WIDTH, '0');

function jsonBytes(value: unknown): number {
	return JSON.stringify(value).length;
}

/**
 * Label in the KEY: `<stream>_<gen>_<seq>`.
 *
 * Staging numbers its segments from the graft point (`graftAt + 1`) rather than
 * from the live tail, which it can do precisely BECAUSE the label already
 * separates the two key spaces. So a relabel is a pure rename that keeps the
 * sequence number, and the promoted stream is CONTIGUOUS `0..K` with no hole —
 * which matters, because `appending-to-the-stream-costs-the-batch` refuses a gap
 * in the ordinals as a lost fragment.
 */
export function keyLabelLayout(port: StorePort, stream: string): Layout {
	const key = (gen: Gen, seq: number) => `${stream}_${gen}_${seqOf(seq)}`;
	const anchored = (gen: Gen) => new RegExp(`^${stream}_${gen}_(\\d{${SEQ_WIDTH}})$`);

	async function seqsOf(gen: Gen): Promise<number[]> {
		const re = anchored(gen);
		const found: number[] = [];
		for (const k of await port.keys()) {
			const m = re.exec(k);
			if (m) found.push(Number(m[1]));
		}
		return found.sort((a, b) => a - b);
	}

	return {
		name: 'key-label',
		relabelIsMetadataOnly: typeof port.rename === 'function',

		async append(gen, seq, segment) {
			await port.set(key(gen, seq), segment);
		},

		async readOrder(gen, graftAt) {
			if (gen === 'live') return (await seqsOf('live')).map((s) => key('live', s));
			const live = (await seqsOf('live')).filter((s) => s <= graftAt);
			const staging = await seqsOf('staging');
			return [...live.map((s) => key('live', s)), ...staging.map((s) => key('staging', s))];
		},

		async promote(graftAt) {
			const cost: PromotionCost = {...ZERO};

			// 1. The superseded live entries above the graft point.
			const superseded = (await seqsOf('live')).filter((s) => s > graftAt);
			if (port.delMany) {
				await port.delMany(superseded.map((s) => key('live', s)));
				cost.storeOps += superseded.length > 0 ? 1 : 0;
			} else {
				for (const s of superseded) {
					await port.del(key('live', s));
					cost.storeOps += 1;
				}
			}
			cost.deletes = superseded.length;

			// 2. The relabel. This is the arm under test.
			const staging = await seqsOf('staging');
			if (port.rename) {
				// The filesystem: metadata only, no payload crosses the boundary.
				for (const s of staging) {
					await port.rename(key('staging', s), key('live', s));
					cost.storeOps += 1;
				}
				cost.metadataRenames = staging.length;
			} else if (port.getMany && port.setMany && port.delMany && staging.length > 0) {
				// IndexedDB: no rename primitive, so the payload is read back and
				// written out under the new key. Batched into three transactions.
				const values = await port.getMany(staging.map((s) => key('staging', s)));
				await port.setMany(values.map((v, i) => [key('live', staging[i]), v] as [string, any]));
				await port.delMany(staging.map((s) => key('staging', s)));
				cost.storeOps += 3;
				cost.payloadsRewritten = staging.length;
				cost.payloadBytesMoved = values.reduce((n, v) => n + jsonBytes(v), 0);
			} else {
				for (const s of staging) {
					const v = await port.get(key('staging', s));
					await port.set(key('live', s), v);
					await port.del(key('staging', s));
					cost.storeOps += 3;
					cost.payloadsRewritten += 1;
					cost.payloadBytesMoved += jsonBytes(v);
				}
			}
			return cost;
		},
	};
}

/**
 * Label in the VALUE: key `<stream>_<seq>`, value `{gen, ...segment}`.
 *
 * With the label out of the key there is only ONE key space, so live and
 * staging entries CANNOT share a sequence number and staging must append after
 * the live TAIL rather than from the graft point. That is forced, not a choice:
 * any extra key component that separated them would be a key label.
 *
 * It has a consequence worth recording beyond the cost: promotion deletes live
 * `graftAt+1 .. liveTail` and keeps staging `liveTail+1 .. K`, so the promoted
 * stream has a HOLE in its ordinals. Under the contiguity refusal in
 * `appending-to-the-stream-costs-the-batch` that hole reads as a lost fragment,
 * so this layout also forces either a renumber (which is the rename it was
 * trying to avoid, on every entry) or a weaker gap rule.
 */
export function valueLabelLayout(port: StorePort, stream: string, options: {pointer?: boolean} = {}): Layout {
	const key = (seq: number) => `${stream}_${seqOf(seq)}`;
	const anchored = new RegExp(`^${stream}_(\\d{${SEQ_WIDTH}})$`);

	/**
	 * The optional BOUNDARY POINTER, which is value-label's best case and is
	 * measured so this comparison is not a strawman.
	 *
	 * Without it the labels are only discoverable by READING EVERY VALUE, since
	 * that is where they live: even the whole-stream case, which relabels nothing
	 * at all, has to deserialise the entire history to find that out. With it,
	 * `staging = seq > liveTail` is known in O(1) and no value is read that is not
	 * being rewritten.
	 *
	 * The pointer is not free, and the cost is the one
	 * `appending-to-the-stream-costs-the-batch` already argued when it rejected a
	 * head pointer for enumeration: it is a SECOND source of truth that can
	 * disagree with the entries, and a pointer naming a boundary whose segments
	 * are gone reads as a hole rather than as the loss it is. It also makes the
	 * label in the value REDUNDANT — the pointer already says which entries are
	 * staging — which is the finding, not a detail.
	 */
	let liveTail = options.pointer ? -1 : undefined;

	async function allSeqs(): Promise<number[]> {
		const found: number[] = [];
		for (const k of await port.keys()) {
			const m = anchored.exec(k);
			if (m) found.push(Number(m[1]));
		}
		return found.sort((a, b) => a - b);
	}

	async function labelled(): Promise<{seq: number; gen: Gen}[]> {
		const seqs = await allSeqs();
		if (liveTail !== undefined) {
			// The pointer arm: the boundary is known, so no value is read to find it.
			return seqs.map((seq) => ({seq, gen: (seq > liveTail! ? 'staging' : 'live') as Gen}));
		}
		const values = port.getMany
			? await port.getMany(seqs.map(key))
			: await Promise.all(seqs.map((s) => port.get(key(s))));
		return seqs.map((seq, i) => ({seq, gen: (values[i]?.gen ?? 'live') as Gen}));
	}

	return {
		name: options.pointer ? 'value-label+pointer' : 'value-label',
		relabelIsMetadataOnly: false,

		async append(gen, seq, segment) {
			await port.set(key(seq), {gen, ...segment});
			if (liveTail !== undefined && gen === 'live') liveTail = Math.max(liveTail, seq);
		},

		async readOrder(gen, graftAt) {
			const rows = await labelled();
			if (gen === 'live') return rows.filter((r) => r.gen === 'live').map((r) => key(r.seq));
			return rows.filter((r) => r.gen === 'staging' || r.seq <= graftAt).map((r) => key(r.seq));
		},

		async promote(graftAt) {
			const cost: PromotionCost = {...ZERO};
			const rows = await labelled();

			// 1. Superseded live entries above the graft point.
			const superseded = rows.filter((r) => r.gen === 'live' && r.seq > graftAt).map((r) => key(r.seq));
			if (port.delMany) {
				if (superseded.length > 0) await port.delMany(superseded);
				cost.storeOps += superseded.length > 0 ? 1 : 0;
			} else {
				for (const k of superseded) {
					await port.del(k);
					cost.storeOps += 1;
				}
			}
			cost.deletes = superseded.length;

			// 2. The relabel. A field of the value moved, so the value is rewritten
			//    WHOLE: neither substrate can write one field of a stored record.
			const staging = rows.filter((r) => r.gen === 'staging').map((r) => key(r.seq));
			if (port.getMany && port.setMany && staging.length > 0) {
				const values = await port.getMany(staging);
				const next = values.map((v) => ({...v, gen: 'live' as Gen}));
				await port.setMany(staging.map((k, i) => [k, next[i]] as [string, any]));
				cost.storeOps += 2;
				cost.payloadsRewritten = staging.length;
				cost.payloadBytesMoved = next.reduce((n, v) => n + jsonBytes(v), 0);
			} else {
				for (const k of staging) {
					const v = await port.get(k);
					v.gen = 'live';
					await port.set(k, v);
					cost.storeOps += 2;
					cost.payloadsRewritten += 1;
					cost.payloadBytesMoved += jsonBytes(v);
				}
			}
			if (liveTail !== undefined) liveTail = rows[rows.length - 1]?.seq ?? liveTail;
			return cost;
		},
	};
}
