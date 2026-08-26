#!/usr/bin/env node
/**
 * Publish an empty `0.0.0` stub for every workspace package that is not on npm
 * yet, so that a TRUSTED PUBLISHER can be registered for it.
 *
 * ## Why this exists
 *
 * npm stores a trusted-publisher configuration ON the package, so the package
 * must already exist before OIDC can be authorised for it (npm has no
 * equivalent of PyPI's "pending publisher"). That leaves exactly one publish
 * per package that cannot come from CI, and this script makes that publish an
 * empty placeholder rather than a real release.
 *
 * The point is what it buys: with the names reserved, the trusted publishers can
 * be registered BEFORE the first real release, so every artifact anybody ever
 * installs was built and signed by CI, with provenance, from a commit that can
 * be checked. The alternative -- hand-publishing the first real version from a
 * laptop -- leaves the single most interesting release of the project as the one
 * release with no provenance.
 *
 * It is not a one-off: any NEW package added to this workspace hits the same
 * bootstrap, and re-running this reserves just that one.
 *
 * ## Usage
 *
 *   node scripts/reserve-npm-names.mjs              # plan only, touches nothing
 *   node scripts/reserve-npm-names.mjs --publish    # actually publish the stubs
 *   node scripts/reserve-npm-names.mjs --publish --otp 123456
 *
 * Private packages are skipped (they never publish), and so is anything already
 * on the registry, so the plan is empty once the bootstrap is done.
 *
 * ## The 2FA snag
 *
 * If the npm account is on "authorization and writes", every publish prompts for
 * an OTP, and a single `--otp` code expires long before a run of this size ends.
 * The practical answer is a GRANULAR access token scoped to the `@etherfold` org
 * with a short expiry, exported as NPM_TOKEN for the run and revoked after. That
 * token cannot be reused for `npm trust` (which rejects 2FA-bypassing granular
 * tokens), so the registration step stays interactive either way.
 */

import {execFileSync} from 'node:child_process';
import {existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// The workspace roots that can hold a PUBLISHED package. `examples/*` is in the
// pnpm workspace too and is deliberately absent: every example is private, and
// reserving a name for something that never publishes is noise on the registry.
const ROOTS = ['packages', 'platforms'];
const REGISTRY = 'https://registry.npmjs.org';
const STUB_VERSION = '0.0.0';

const args = process.argv.slice(2);
const doPublish = args.includes('--publish');
const otpIndex = args.indexOf('--otp');
const otp = otpIndex === -1 ? undefined : args[otpIndex + 1];

/** Every public workspace package, as {name, license, repository} from its own manifest. */
function workspacePackages() {
	const found = [];
	for (const root of ROOTS) {
		if (!existsSync(root)) continue;
		for (const dir of readdirSync(root)) {
			const manifest = join(root, dir, 'package.json');
			if (!existsSync(manifest)) continue;
			const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
			if (pkg.private) continue;
			found.push({name: pkg.name, license: pkg.license, repository: pkg.repository, dir: join(root, dir)});
		}
	}
	return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Is the name on the registry at all?
 *
 * A 404 is the answer we act on, so anything ELSE that is not a 200 (a network
 * blip, a 5xx, a rate limit) must abort rather than be read as "missing":
 * mistaking a hiccup for an unpublished name would publish a stub over a real
 * package's name in the best case and fail confusingly in the worst.
 */
async function existsOnRegistry(name) {
	const response = await fetch(`${REGISTRY}/${name.replace('/', '%2f')}`, {method: 'HEAD'});
	if (response.status === 200) return true;
	if (response.status === 404) return false;
	throw new Error(`unexpected ${response.status} from the registry for ${name}; refusing to guess`);
}

/** A stub is a name, a version, and enough metadata that the npm page is not a mystery. */
function writeStub(pkg) {
	const dir = mkdtempSync(join(tmpdir(), 'etherfold-reserve-'));
	writeFileSync(
		join(dir, 'package.json'),
		JSON.stringify(
			{
				name: pkg.name,
				version: STUB_VERSION,
				description: `Name reservation for ${pkg.name}. The first real release follows, published from CI.`,
				license: pkg.license,
				repository: pkg.repository,
				publishConfig: {access: 'public'},
			},
			null,
			'\t',
		) + '\n',
	);
	writeFileSync(
		join(dir, 'README.md'),
		`# ${pkg.name}\n\n` +
			`This \`${STUB_VERSION}\` is a placeholder: it holds the name so that a trusted publisher ` +
			`can be registered for it, so that the first real release can be published from CI with provenance.\n\n` +
			`Source: https://github.com/wighawag/etherfold/tree/main/${pkg.dir}\n`,
	);
	return dir;
}

const packages = workspacePackages();
const missing = [];
for (const pkg of packages) {
	if (await existsOnRegistry(pkg.name)) continue;
	missing.push(pkg);
}

console.log(`${packages.length} public workspace packages, ${missing.length} not on npm:\n`);
for (const pkg of missing) {
	console.log(`  ${pkg.name}`);
}
if (missing.length === 0) {
	console.log('  (nothing to reserve)');
	process.exit(0);
}

if (!doPublish) {
	console.log(`\nPlan only. Re-run with --publish to publish ${missing.length} stubs at ${STUB_VERSION}.`);
	process.exit(0);
}

console.log('');
const failed = [];
for (const pkg of missing) {
	const dir = writeStub(pkg);
	const flags = ['publish', '--access', 'public', ...(otp ? ['--otp', otp] : [])];
	try {
		execFileSync('npm', flags, {cwd: dir, stdio: 'inherit'});
		console.log(`reserved ${pkg.name}`);
	} catch {
		// Keep going: one name failing (a bad OTP, a rate limit) should not
		// abandon the rest, and re-running skips whatever already landed.
		console.error(`FAILED  ${pkg.name}`);
		failed.push(pkg.name);
	}
}

if (failed.length > 0) {
	console.error(`\n${failed.length} failed: ${failed.join(', ')}. Re-run to retry just those.`);
	process.exit(1);
}
console.log(`\nReserved ${missing.length} names. Next: register the trusted publishers, then merge the Version PR.`);
