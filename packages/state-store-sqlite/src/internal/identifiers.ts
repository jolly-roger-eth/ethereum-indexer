import type {ColumnType, EntityDeclaration, NormalizedEntity} from '../types.js';

/**
 * Entity tables are DYNAMIC DDL (see `ddl.ts` for why), which means table and
 * column names are interpolated into SQL text: SQL cannot bind an identifier as
 * a parameter. Those names come from whatever a processor declares, so they are
 * validated once, at declaration time, rather than trusted.
 *
 * Deviation from the reference prototype, which interpolated names directly.
 * The prototype only ever saw its own hand-written declaration.
 */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The store owns the `_` prefix: version columns, and the fixed tables. */
function isReserved(name: string): boolean {
	return name.startsWith('_');
}

function assertIdentifier(name: unknown, what: string): asserts name is string {
	if (typeof name === 'string' && isReserved(name)) {
		throw new Error(
			`reserved identifier for ${what}: ${JSON.stringify(name)}. Names starting with "_" belong to the store.`,
		);
	}
	if (typeof name !== 'string' || !IDENTIFIER.test(name)) {
		throw new Error(
			`invalid identifier for ${what}: ${JSON.stringify(name)}. ` +
				`Must match ${IDENTIFIER} (identifiers cannot be bound as parameters, so they are not interpolated blindly).`,
		);
	}
}

const COLUMN_TYPES: ColumnType[] = ['text', 'integer', 'real', 'blob'];

/** Validate a declaration and put it in the shape the rest of the store uses. */
export function normalizeEntity(declaration: EntityDeclaration): NormalizedEntity {
	assertIdentifier(declaration?.name, 'entity name');
	const name = declaration.name;

	const id = typeof declaration.id === 'string' ? [declaration.id] : declaration.id;
	if (!Array.isArray(id) || id.length === 0) {
		throw new Error(`entity ${name} must declare at least one id column`);
	}
	for (const column of id) {
		assertIdentifier(column, `id column of entity ${name}`);
	}

	const fields = declaration.fields ?? {};
	for (const [field, type] of Object.entries(fields)) {
		assertIdentifier(field, `field of entity ${name}`);
		if (id.includes(field)) {
			throw new Error(`entity ${name} declares ${field} both as an id column and as a field`);
		}
		if (!COLUMN_TYPES.includes(type)) {
			throw new Error(`entity ${name} declares field ${field} with unknown type ${JSON.stringify(type)}`);
		}
	}

	return Object.freeze({name, id: Object.freeze([...id]), fields: Object.freeze({...fields})});
}

export function normalizeEntities(declarations: Iterable<EntityDeclaration>): Map<string, NormalizedEntity> {
	const entities = new Map<string, NormalizedEntity>();
	for (const declaration of declarations) {
		const entity = normalizeEntity(declaration);
		if (entities.has(entity.name)) {
			throw new Error(`entity ${entity.name} is declared more than once`);
		}
		entities.set(entity.name, entity);
	}
	return entities;
}

export function mustGet(entities: ReadonlyMap<string, NormalizedEntity>, name: string): NormalizedEntity {
	const entity = entities.get(name);
	if (!entity) {
		throw new Error(`unknown entity ${JSON.stringify(name)}: it was not declared to the store`);
	}
	return entity;
}
