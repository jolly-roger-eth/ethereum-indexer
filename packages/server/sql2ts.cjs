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
	// Emit a JSON string literal rather than interpolating into a template literal.
	// JSON string syntax is a subset of JS expression syntax, so no input file can
	// produce output that fails to parse: backticks, ${ and backslashes in the .sql
	// are escaped for us, and CRLF survives verbatim (a template literal would
	// normalise \r\n to \n and silently change the exported string).
	fs.writeFileSync(TSFilePath, `export default ${JSON.stringify(String(sqlText))};\n`);
}
