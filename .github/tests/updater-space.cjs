/* global BigInt */
const { test } = require( "node:test" );
const assert = require( "node:assert/strict" );
const fs = require( "node:fs/promises" );
const os = require( "node:os" );
const path = require( "node:path" );
const { checkUpdateSpace } = require( "../../src/app/updater/space.js" );

const reserve = 64 * 1024 * 1024;
const profile = 32 * 1024 * 1024;
const platform = process.platform === "win32" ? "win64" : "linux64";

function options() {
	return {
		update: { manifest: { platforms: { [platform]: { size: 100, unpackedSize: 500 } } } },
		installDir: path.resolve( "/fixture/application/app" ),
		profileDir: path.resolve( "/fixture/profile" ),
		downloadPath: path.resolve( "/fixture/cache/update.zip" )
	};
}

test( "sums download, archive copies and staging with one reserve per volume", async () => {
	const report = await checkUpdateSpace( options(), {
		getVolume: async () => ({ device: "shared", availableBytes: 1024 * 1024 * 1024 })
	} );
	assert.equal( report.volumes.length, 1 );
	assert.equal( report.requiredBytes, reserve + profile + 700 );
	assert.deepEqual( report.volumes[0].locations, [ "application", "profile", "download" ] );
} );

test( "fails when one volume lacks room despite spare space elsewhere", async () => {
	const current = options();
	await assert.rejects( checkUpdateSpace( current, {
		getVolume: async location => location === current.profileDir
			? { device: "profile", availableBytes: reserve + profile - 1 }
			: { device: "install-cache", availableBytes: 10 * 1024 * 1024 * 1024 }
	} ), error => {
		assert.equal( error.code, "UPDATE_NO_SPACE" );
		assert.deepEqual( error.details.locations, [ "profile" ] );
		assert.equal( error.details.requiredBytes - error.details.availableBytes, 1 );
		assert.equal( JSON.stringify( error.details ).includes( current.profileDir ), false );
		return true;
	} );
} );

test( "prepare counts additional copies and a reserve per volume", async () => {
	const current = { ...options(), phase: "prepare" };
	const report = await checkUpdateSpace( current, {
		getVolume: async location => ({ device: location, availableBytes: BigInt( 2 ** 40 ) })
	} );
	assert.equal( report.volumes.length, 2 );
	assert.equal( report.requiredBytes, 2 * reserve + profile + 600 );
	assert.equal( report.volumes.some( volume => volume.locations.includes( "download" ) ), false );
} );

test( "refuses missing or unsafe unpacked lengths before inspecting disk capacity", async () => {
	for ( const unpackedSize of [ undefined, 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1 ] ) {
		const current = options();
		current.update.manifest.platforms[platform].unpackedSize = unpackedSize;
		await assert.rejects( checkUpdateSpace( current, {
			getVolume: () => assert.fail( "Invalid metadata must not reach disk inspection" )
		} ), { code: "UPDATE_INTEGRITY" } );
	}
} );

test( "checks real capacity before creating cache or profile directories", async context => {
	const root = await fs.mkdtemp( path.join( os.tmpdir(), "stgui-space-" ) );
	context.after( () => fs.rm( root, { recursive: true, force: true } ) );
	const current = { ...options(),
		installDir: path.join( root, "app" ), profileDir: path.join( root, "profile" ),
		downloadPath: path.join( root, "cache", "nested", "archive.zip" )
	};
	const report = await checkUpdateSpace( current );
	assert.equal( report.volumes.length, 1 );
	assert.ok( report.availableBytes > report.requiredBytes );
	assert.equal( ( await fs.readdir( root ) ).length, 0, "Preflight does not create directories" );
} );
