const { test } = require( "node:test" );
const assert = require( "node:assert/strict" );
const fs = require( "node:fs" );
const os = require( "node:os" );
const path = require( "node:path" );
const {
	HISTORY_LIMIT, HISTORY_MAX_BYTES, HISTORY_TYPES, HISTORY_STATUSES,
	readHistory, appendHistory, createDiagnostics, exportDiagnostics
} = require( "../../src/app/updater/history" );

const commit = "a".repeat( 40 );
const tag = [ "v2.5.3-master.g", commit ].join( "" );
const at = 1793880000000;

function fixture( context ) {
	const directory = fs.mkdtempSync( path.join( os.tmpdir(), "stgui-history-" ) );
	context.after( () => fs.promises.rm( directory, { recursive: true, force: true } ) );
	return { directory, filename: path.join( directory, "updater-history.json" ) };
}

function event( overrides = {} ) {
	return { type: "check", status: "available", at, commit, tag, buildNumber: 12, ...overrides };
}

test( "persists bounded newest-first history with private atomic files", async context => {
	const { directory, filename } = fixture( context );
	for ( let buildNumber = 1; buildNumber <= HISTORY_LIMIT + 8; buildNumber++ ) {
		await appendHistory( filename, event( { buildNumber } ) );
	}
	const events = await readHistory( filename );
	assert.equal( events.length, HISTORY_LIMIT );
	assert.equal( events[0].buildNumber, HISTORY_LIMIT + 8 );
	assert.equal( events[HISTORY_LIMIT - 1].buildNumber, 9 );
	assert.deepEqual( fs.readdirSync( directory ), [ "updater-history.json" ] );
	assert.ok( fs.statSync( filename ).size < HISTORY_MAX_BYTES );
	if ( process.platform !== "win32" ) {
		assert.equal( fs.statSync( filename ).mode & 0o777, 0o600 );
	}
} );

test( "serializes concurrent writes and lets reads wait for pending records", async context => {
	const { filename } = fixture( context );
	const writes = Array.from( { length: 20 }, ( value, index ) =>
		appendHistory( filename, event( { buildNumber: index + 1 } ) ) );
	const reading = readHistory( filename );
	await Promise.all( writes );
	const events = await reading;
	assert.deepEqual( events.map( value => value.buildNumber ),
		Array.from( { length: 20 }, ( value, index ) => 20 - index ) );
} );

test( "records only known event fields and safe status codes", async context => {
	const { filename } = fixture( context );
	const input = event( {
		type: "rollback", status: "failed", code: "UPDATE_PROFILE_BACKUP",
		message: "synthetic credential value", stack: "/private/example/profile",
		url: "https://example.invalid/?secret=synthetic", token: "synthetic",
		args: [ "--user-data-dir=/private/example" ], secret: "synthetic"
	} );
	await appendHistory( filename, input );
	assert.deepEqual( await readHistory( filename ), [ event( {
		type: "rollback", status: "failed", code: "UPDATE_PROFILE_BACKUP"
	} ) ] );
	const bytes = fs.readFileSync( filename, "utf8" );
	for ( const secret of [ "synthetic", "/private", "https://", "args", "token", "stack" ] ) {
		assert.equal( bytes.includes( secret ), false );
	}
} );

test( "unknown codes and invalid identities cannot become free-form diagnostics", async context => {
	const { filename } = fixture( context );
	await appendHistory( filename, event( {
		commit: "synthetic-private-value", tag: "https://example.invalid/private",
		code: "synthetic-private-value", version: "2.5.3-private-value", buildNumber: "private",
		message: "synthetic-private-value", at: Number.NaN
	} ) );
	const events = await readHistory( filename );
	assert.equal( events.length, 1 );
	assert.ok( Number.isSafeInteger( events[0].at ) );
	assert.deepEqual( Object.keys( events[0] ).sort(), [ "at", "code", "status", "type" ] );
	assert.equal( events[0].code, "UNKNOWN_ERROR" );
	assert.equal( fs.readFileSync( filename, "utf8" ).includes( "private" ), false );
} );

test( "invalid event shapes are rejected without changing valid history", async context => {
	const { filename } = fixture( context );
	await appendHistory( filename, event() );
	const invalid = [ null, {}, event( { type: "secret" } ), event( { status: "secret" } ) ];
	for ( const value of invalid ) {
		await assert.rejects( appendHistory( filename, value ), { code: "UPDATE_HISTORY" } );
	}
	assert.deepEqual( await readHistory( filename ), [ event() ] );
	assert.ok( HISTORY_TYPES.includes( "rollback" ) );
	assert.ok( HISTORY_STATUSES.includes( "blocked" ) );
} );

test( "missing, corrupt, unsupported and oversized stores recover without exposing bytes",
	async context => {
		const { filename } = fixture( context );
		assert.deepEqual( await readHistory( filename ), [] );
		for ( const value of [ "corrupt synthetic private data",
			JSON.stringify( { schema: 2, events: [ event() ] } ),
			JSON.stringify( { schema: 1, events: "private data" } ),
			" ".repeat( HISTORY_MAX_BYTES + 1 ) ] ) {
			fs.writeFileSync( filename, value );
			assert.deepEqual( await readHistory( filename ), [] );
		}
		await appendHistory( filename, event() );
		assert.deepEqual( await readHistory( filename ), [ event() ] );
	}
);

test( "revalidates stored history instead of trusting a modified JSON file", async context => {
	const { filename } = fixture( context );
	fs.writeFileSync( filename, JSON.stringify( { schema: 1, events: [
		event( { code: "NETWORK_ERROR", path: "private" } ),
		event( { type: "private" } ), event( { status: "private" } ),
		event( { at: "private" } ), event( { at: -1 } ), null
	] } ) );
	assert.deepEqual( await readHistory( filename ), [ event( { code: "NETWORK_ERROR" } ) ] );
} );

test( "refuses to read or append through a history symlink", async context => {
	const { filename, directory } = fixture( context );
	const original = path.join( directory, "settings.json" );
	fs.writeFileSync( original, JSON.stringify( {
		schema: 1, events: [ event() ], secret: "private"
	} ) );
	try { fs.symlinkSync( original, filename ); } catch ( error ) {
		if ( process.platform === "win32" && [ "EPERM", "EACCES" ].includes( error.code ) ) {
			context.skip( "Creating a file symlink requires Windows privileges" );
			return;
		}
		throw error;
	}
	const before = fs.readFileSync( original, "utf8" );
	assert.deepEqual( await readHistory( filename ), [] );
	await assert.rejects( appendHistory( filename, event() ), { code: "UPDATE_HISTORY" } );
	assert.equal( fs.readFileSync( original, "utf8" ), before );
} );

test( "a failed write cleans temporary files and allows subsequent writes", async context => {
	const { filename, directory } = fixture( context );
	fs.mkdirSync( filename );
	await assert.rejects( appendHistory( filename, event() ), { code: "UPDATE_HISTORY" } );
	assert.deepEqual( fs.readdirSync( directory ), [ "updater-history.json" ] );
	fs.rmdirSync( filename );
	await appendHistory( filename, event() );
	assert.deepEqual( await readHistory( filename ), [ event() ] );
} );

test( "diagnostics export contains only validated build, platform and event descriptors",
	async context => {
		const { directory } = fixture( context );
		const filename = path.join( directory, "diagnostics.json" );
		const history = [ event( { code: "INVALID_SIGNATURE" } ), event( {
			type: "install", status: "succeeded", code: "private"
		} ) ];
		const options = {
			history,
			currentBuild: {
				version: "2.5.3", commit, buildNumber: 12, commitTime: 1793880000,
				token: "synthetic secret", profileDir: "/private/profile", args: [ "private" ]
			},
			platform: "linux", arch: "x64", now: at, rawLog: "synthetic secret",
			profileDir: "/private/profile", error: { message: "synthetic secret" }
		};
		const expected = {
			schema: 1, application: "streamlink-twitch-gui",
			exportedAt: new Date( at ).toISOString(), platform: "linux", arch: "x64",
			currentBuild: { version: "2.5.3", commit, buildNumber: 12, commitTime: 1793880000 },
			lastCheckAt: at,
			history: [ event( { code: "INVALID_SIGNATURE" } ), event( {
				type: "install", status: "succeeded", code: "UNKNOWN_ERROR"
			} ) ]
		};
		assert.deepEqual( createDiagnostics( options ), expected );
		assert.deepEqual( await exportDiagnostics( filename, options ), expected );
		assert.deepEqual( JSON.parse( fs.readFileSync( filename, "utf8" ) ), expected );
		assert.deepEqual( fs.readdirSync( directory ), [ "diagnostics.json" ] );
		const bytes = fs.readFileSync( filename, "utf8" );
		for ( const value of [ "synthetic", "private", "token", "profileDir", "rawLog", "args" ] ) {
			assert.equal( bytes.includes( value ), false );
		}
	}
);

test( "unknown environment descriptors and malicious stored fields are omitted", () => {
	const diagnostics = createDiagnostics( {
		history: [ event( { token: "private", message: "private" } ), event( {
			type: "private"
		} ) ],
		currentBuild: {
			version: "private", commit: "private", buildNumber: -1, commitTime: "private"
		},
		platform: "/private/profile", arch: "private", now: at
	} );
	assert.equal( diagnostics.platform, "unknown" );
	assert.equal( diagnostics.arch, "unknown" );
	assert.deepEqual( diagnostics.currentBuild, {} );
	assert.deepEqual( diagnostics.history, [ event() ] );
	assert.equal( JSON.stringify( diagnostics ).includes( "private" ), false );
} );

test( "export failure reports a fixed safe code and preserves the selected destination",
	async context => {
		const { directory } = fixture( context );
		const filename = path.join( directory, "destination" );
		fs.mkdirSync( filename );
		await assert.rejects( exportDiagnostics( filename, { now: at } ),
			{ code: "UPDATE_DIAGNOSTICS", message: "UPDATE_DIAGNOSTICS" } );
		assert.ok( fs.statSync( filename ).isDirectory() );
		assert.deepEqual( fs.readdirSync( directory ), [ "destination" ] );
	}
);
