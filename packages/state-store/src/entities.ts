import type {EntityId, FieldType, EntityDeclaration, NormalizedEntity} from './types.js';

/**
 * Validation of a declaration, once, for every backend.
 *
 * The rule is set by the STRICTEST backend and applied uniformly, which is the
 * only arrangement under which "this declaration is valid" is a fact about the
 * declaration rather than about the deployment. A SQL store interpolates entity
 * and field names into DDL, because SQL cannot bind an identifier as a
 * parameter, so it needs names it can trust; an object-store backend would
 * happily take anything. If each backend validated to its own taste, a
 * declaration would be accepted in a browser and fatal on a server, which is
 * exactly the failure `work/notes/findings/sqlite-in-the-browser.md` recorded
 * (an entity field named `index` passes this check and then fails at migration
 * because `INDEX` is a SQL keyword; the remaining half of that hole is
 * `entity-identifier-sql-keyword`).
 */
const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

/** The store owns the `_` prefix: version columns, and its own fixed tables. */
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

const FIELD_TYPES: FieldType[] = ['text', 'integer', 'real', 'blob'];

/** Validate a declaration and put it in the shape the rest of a store uses. */
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
		if (!FIELD_TYPES.includes(type)) {
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

/**
 * The business key of one entity, in DECLARED column order, as strings.
 *
 * Stringifying is the one normalisation the model makes: `{id: 1}` and
 * `{id: '1'}` are the same entity, because a key that means one thing to a
 * handler and another to the store is a bug that only shows up as a duplicate
 * row much later.
 */
export function idValues(entity: NormalizedEntity, id: EntityId): string[] {
	return entity.id.map((column) => {
		const value = id?.[column];
		if (value === undefined || value === null) {
			throw new Error(`entity ${entity.name} requires an id column ${column}, got ${JSON.stringify(value)}`);
		}
		return String(value);
	});
}

/**
 * A stable string for one entity instance, usable as a Map key.
 *
 * Built from the DECLARED id columns rather than from whatever keys the caller's
 * object happens to carry, so `{account, token}` and `{token, account}` are one
 * key, and an extra property on the caller's object cannot fork it into two.
 */
export function entityKey(entity: NormalizedEntity, id: EntityId): string {
	return [entity.name, ...idValues(entity, id)].join('\u0000');
}
