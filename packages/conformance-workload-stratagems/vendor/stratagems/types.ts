/**
 * VENDORED. Origin: github.com/wighawag/stratagems, `common/src/types.ts` and
 * the `ContractSimpleCell` type from `common/src/grid.ts`
 * @ commit 3d5a0b3f46bcc0d8370643b8382f11f99f81df00 (2024-12-18), GPL-3.0.
 *
 * Only the types `stratagems.ts` and the processor actually reference are
 * copied; the rest of `grid.ts` is UI/geometry code no indexing path touches.
 */

export enum Color {
	None = 0,
	Blue = 1, // 5ab9bb
	Red = 2, // c5836e
	Green = 3, // 8bffcb
	Yellow = 4, // d3d66d
	Purple = 5, // a9799d
	Evil = 6, // 3d3d3d
}

export type ContractCell = {
	lastEpochUpdate: number;
	epochWhenTokenIsAdded: number;
	color: number;
	life: number;
	delta: number;
	enemyMap: number;
	distribution: number;
	stake: number;
	producingEpochs: number;
};

export type StratagemsState = {
	cells: {[position: string]: ContractCell};
	owners: {[position: string]: `0x${string}`};
	computedPoints: {[owner: string]: number};
};

export type ContractMove = {position: bigint; color: Color};

export type CellXYPosition = {
	x: number;
	y: number;
};

export type ContractSimpleCell = {
	position: bigint;
	owner: `0x${string}`;
	color: number; // 0 | 1 | 2 | 3 | 4 | 5 | 6;
	life: number;
	stake: number;
};
