// from https://github.com/TahaSh/svelte-paginate/blob/86867e577a4eed3b67d89faaaf4e2a9f014c70d2/src/lib/paginate.ts
interface PaginateInput<T = unknown> {
	items: T[];
	pageSize: number;
	currentPage: number;
}

export function paginate<T>({items, pageSize, currentPage}: PaginateInput<T>) {
	return items.slice((currentPage - 1) * pageSize, (currentPage - 1) * pageSize + pageSize);
}
