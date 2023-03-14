export enum SymbolType {
	PREVIOUS_PAGE = 'PREVIOUS_PAGE',
	NEXT_PAGE = 'NEXT_PAGE',
	ELLIPSIS = 'ELLIPSIS',
}

export interface NavigationOption {
	type: string;
	value: number;
	symbol?: SymbolType;
}
