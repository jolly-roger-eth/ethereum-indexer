import {SymbolType} from './types';
import type {NavigationOption} from './types';

interface GenerateOptionsInput {
	totalItems: number;
	pageSize: number;
	currentPage: number;
	showStepOptions?: boolean;
	limit?: number;
}

interface GenerateUnlimitedOptionsInput {
	totalPages: number;
}

interface GenerateLimitedOptionsInput {
	totalPages: number;
	currentPage: number;
	limit: number;
}

interface AddStepOptionsInput {
	options: ReturnType<typeof generateLimitedOptions> | ReturnType<typeof generateUnlimitedOptions>;
	currentPage: number;
	totalPages: number;
}

export function generateNavigationOptions({
	totalItems,
	pageSize,
	currentPage,
	limit,
	showStepOptions = false,
}: GenerateOptionsInput): NavigationOption[] {
	const totalPages = Math.ceil(totalItems / pageSize);
	const limited = limit && totalPages > getLimitThreshold(limit);
	const options = limited
		? generateLimitedOptions({totalPages, limit, currentPage})
		: generateUnlimitedOptions({totalPages});
	return showStepOptions ? addStepOptions({options, currentPage, totalPages}) : options;
}

function generateUnlimitedOptions({totalPages}: GenerateUnlimitedOptionsInput) {
	return new Array(totalPages).fill(null).map((_, index) => ({
		type: 'number',
		value: index + 1,
	}));
}

function generateLimitedOptions({totalPages, limit, currentPage}: GenerateLimitedOptionsInput) {
	const boundarySize = limit * 2 + 2;
	const firstBoundary = 1 + boundarySize;
	const lastBoundary = totalPages - boundarySize;
	const totalShownPages = firstBoundary + 2;

	if (currentPage <= firstBoundary - limit) {
		return Array(totalShownPages)
			.fill(null)
			.map((_, index) => {
				if (index === totalShownPages - 1) {
					return {
						type: 'number',
						value: totalPages,
					};
				} else if (index === totalShownPages - 2) {
					return {
						type: 'symbol',
						symbol: SymbolType.ELLIPSIS,
						value: firstBoundary + 1,
					};
				}
				return {
					type: 'number',
					value: index + 1,
				};
			});
	} else if (currentPage >= lastBoundary + limit) {
		return Array(totalShownPages)
			.fill(null)
			.map((_, index) => {
				if (index === 0) {
					return {
						type: 'number',
						value: 1,
					};
				} else if (index === 1) {
					return {
						type: 'symbol',
						symbol: SymbolType.ELLIPSIS,
						value: lastBoundary - 1,
					};
				}
				return {
					type: 'number',
					value: lastBoundary + index - 2,
				};
			});
	} else if (currentPage >= firstBoundary - limit && currentPage <= lastBoundary + limit) {
		return Array(totalShownPages)
			.fill(null)
			.map((_, index) => {
				if (index === 0) {
					return {
						type: 'number',
						value: 1,
					};
				} else if (index === 1) {
					return {
						type: 'symbol',
						symbol: SymbolType.ELLIPSIS,
						value: currentPage - limit + (index - 2),
					};
				} else if (index === totalShownPages - 1) {
					return {
						type: 'number',
						value: totalPages,
					};
				} else if (index === totalShownPages - 2) {
					return {
						type: 'symbol',
						symbol: SymbolType.ELLIPSIS,
						value: currentPage + limit + 1,
					};
				}
				return {
					type: 'number',
					value: currentPage - limit + (index - 2),
				};
			});
	}
	return [];
}

function addStepOptions({options, currentPage, totalPages}: AddStepOptionsInput) {
	return [
		{
			type: 'symbol',
			symbol: SymbolType.PREVIOUS_PAGE,
			value: currentPage <= 1 ? 1 : currentPage - 1,
		},
		...(options || []),
		{
			type: 'symbol',
			symbol: SymbolType.NEXT_PAGE,
			value: currentPage >= totalPages ? totalPages : currentPage + 1,
		},
	];
}

function getLimitThreshold(limit: number) {
	const maximumUnlimitedPages = 3; // This means we cannot limit 3 pages or less
	const numberOfBoundaryPages = 2; // The first and last pages are always shown
	return limit * 2 + maximumUnlimitedPages + numberOfBoundaryPages;
}
