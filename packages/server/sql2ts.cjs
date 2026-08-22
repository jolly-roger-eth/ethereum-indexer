const fs = require('fs');
const path = require('path');
const args = process.argv.slice(2);
const folder = args[0];
const files = fs.readdirSync(folder);
for (const file of files) {
	const SQLFilePath = path.join(folder, file);
	const TSFilePath = `./src/schema/ts/${file}.ts`;
	const sqlText = fs.readFileSync(SQLFilePath);
	fs.mkdirSync('./src/schema/ts', {recursive: true});
	// Escape what a template literal cannot carry raw. The house template's copy
	// does not do this, and a single backtick in a SQL comment silently emits
	// TypeScript that does not parse (which is how this was found).
	const escaped = String(sqlText).replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');
	fs.writeFileSync(TSFilePath, `export default \`${escaped}\``);
}
