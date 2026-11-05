const { test } = require( "node:test" );
const assert = require( "node:assert/strict" );
const { EventEmitter } = require( "node:events" );
const { Readable } = require( "node:stream" );
const { createHash } = require( "node:crypto" );
const fs = require( "node:fs" );
const os = require( "node:os" );
const path = require( "node:path" );
const { checkForUpdate, downloadUpdate } = require( "../../src/app/updater/client" );


const repository = "example/streamlink-twitch-gui";
const currentBuild = { commit: "a".repeat( 40 ), commitTime: 100, buildNumber: 1 };
const api = `https://api.github.com/repos/${repository}/releases?per_page=100`;
const windows = Buffer.from( "Verified Windows archive bytes" );
const linux = Buffer.from( "Verified Linux archive bytes" );
const digest = bytes => createHash( "sha256" ).update( bytes ).digest( "hex" );
const assetUrl = ( tag, name ) => `https://github.com/${repository}/releases/download/`
	+ `${encodeURIComponent( tag )}/${encodeURIComponent( name )}`;


function fixture( overrides = {} ) {
	const manifest = {
		schema: 1,
		channel: "master",
		repository,
		commit: "b".repeat( 40 ),
		commitTime: 200,
		buildNumber: 2,
		version: "2.5.3",
		platforms: {
			win64: {
				name: "streamlink-twitch-gui-v2.5.3-master.gold+3.gabc1234-win64.zip",
				sha256: digest( windows ), size: windows.length
			},
			linux64: {
				name: "streamlink-twitch-gui-v2.5.3-master.gold+3.gabc1234-linux64.tar.gz",
				sha256: digest( linux ), size: linux.length
			}
		},
		...overrides
	};
	const tag = `v${manifest.version}-master.g${manifest.commit}`;
	const body = Buffer.from( JSON.stringify( manifest ) );
	const descriptor = ( name, size ) => ({
		name, size, browser_download_url: assetUrl( tag, name )
	});
	const release = {
		tag_name: tag,
		draft: false,
		prerelease: true,
		published_at: "2026-11-05T12:00:00Z",
		assets: [ descriptor( "update.json", body.length ) ]
	};
	for ( const entry of Object.values( manifest.platforms || {} ) ) {
		release.assets.push( descriptor( entry.name, entry.size ) );
	}
	return {
		manifest, release, tag, body,
		update: {
			manifest, tag, platform: "win64",
			asset: {
				...manifest.platforms.win64, url: assetUrl( tag, manifest.platforms.win64.name )
			}
		}
	};
}

function transport( routes ) {
	const calls = [];
	const request = ( url, options, callback ) => {
		calls.push( { url: url.href, options } );
		const req = new EventEmitter();
		let destroyed = false;
		let response;
		req.destroy = cause => {
			if ( destroyed ) { return; }
			destroyed = true;
			if ( response ) { response.destroy( cause ); }
			if ( cause ) { queueMicrotask( () => req.emit( "error", cause ) ); }
		};
		req.end = () => queueMicrotask( () => {
			if ( destroyed ) { return; }
			const route = routes[ url.href ];
			if ( route && route.hang ) { return; }
			if ( route && route.error ) { req.emit( "error", route.error ); return; }
			const body = Buffer.isBuffer( route && route.body ) ? route.body
				: Buffer.from( route && route.body || "" );
			response = route && route.stream || Readable.from( route && route.chunks || [ body ] );
			response.statusCode = route ? route.status || 200 : 404;
			response.headers = {
				"content-length": String( body.length ), ...route && route.headers
			};
			callback( response );
		});
		return req;
	};
	return { request, calls };
}

function discovery( fixtures, extraRoutes = {} ) {
	const routes = { [ api ]: { body: JSON.stringify( fixtures.map( item => item.release ) ) } };
	for ( const item of fixtures ) {
		routes[ assetUrl( item.tag, "update.json" ) ] = { body: item.body };
	}
	return transport( { ...routes, ...extraRoutes } );
}

function options( request, extra = {} ) {
	return { repository, currentBuild, platform: "win32", arch: "x64", request, ...extra };
}

function destination( context ) {
	const directory = fs.mkdtempSync( path.join( os.tmpdir(), "updater-client-" ) );
	context.after( () => fs.rmSync( directory, { recursive: true, force: true } ) );
	return path.join( directory, "cache", "archive.zip" );
}

function noPartialFiles( filename ) {
	const directory = path.dirname( filename );
	if ( fs.existsSync( directory ) ) {
		const partials = fs.readdirSync( directory ).filter( name => name.endsWith( ".part" ) );
		assert.deepEqual( partials, [] );
	}
}


test( "Discovers the fork master update for both platforms without /latest", async () => {
	const item = fixture();
	const fake = discovery( [ item ] );
	const update = await checkForUpdate( options( fake.request ) );
	assert.equal( update.tag, item.tag );
	assert.equal( update.platform, "win64" );
	assert.deepEqual( update.asset, item.update.asset );
	assert.equal( update.releaseUrl, `https://github.com/${repository}/releases/tag/${item.tag}` );
	assert.ok( update.versionLabel.includes( item.manifest.commit.slice( 0, 8 ) ) );
	assert.equal( fake.calls[0].url, api );
	const other = await checkForUpdate( options( fake.request, { platform: "linux" } ) );
	assert.equal( other.platform, "linux64" );
	assert.equal( other.asset.sha256, digest( linux ) );
});

test( "Compares commit time then build number, never lexicographical commit hashes", async () => {
	const publishedLater = fixture({ commit: "f".repeat( 40 ), commitTime: 150, buildNumber: 99 });
	const sourceLater = fixture( { commit: "0".repeat( 40 ), commitTime: 300, buildNumber: 2 } );
	const rebuild = fixture( { commit: "1".repeat( 40 ), commitTime: 300, buildNumber: 3 } );
	const fake = discovery( [ publishedLater, sourceLater, rebuild ] );
	assert.equal( ( await checkForUpdate( options( fake.request ) ) ).tag, rebuild.tag );
	const older = discovery( [ publishedLater ] );
	assert.equal( await checkForUpdate( options( older.request, {
		currentBuild: { commit: "e".repeat( 40 ), commitTime: 200, buildNumber: 1 }
	} ) ), null );
});

test( "A broken historical manifest does not block a verified newer update", async () => {
	const latest = fixture( { commitTime: 300, buildNumber: 3 } );
	const older = fixture( { commit: "c".repeat( 40 ), commitTime: 200 } );
	older.release.published_at = "2026-11-04T12:00:00Z";
	const fake = discovery( [ latest, older ], {
		[ assetUrl( older.tag, "update.json" ) ]: { status: 404 }
	} );
	assert.equal( ( await checkForUpdate( options( fake.request ) ) ).tag, latest.tag );
});

test( "A broken latest manifest can fall back to a verified compatible update", async () => {
	const bad = fixture( { commitTime: 300, buildNumber: 3, channel: "stable" } );
	const older = fixture( { commit: "c".repeat( 40 ), commitTime: 200 } );
	older.release.published_at = "2026-11-04T12:00:00Z";
	const fake = discovery( [ bad, older ] );
	assert.equal( ( await checkForUpdate( options( fake.request ) ) ).tag, older.tag );
});

test( "The current build remains up to date despite a broken historical release", async () => {
	const current = fixture( currentBuild );
	const older = fixture( { commitTime: 50 } );
	const fake = discovery( [ current, older ], {
		[ assetUrl( older.tag, "update.json" ) ]: { body: "{" }
	} );
	assert.equal( await checkForUpdate( options( fake.request ) ), null );
});

test( "The same commit never updates itself, even after a rebuild", async () => {
	const item = fixture( { ...currentBuild, buildNumber: 999 } );
	const fake = discovery( [ item ] );
	assert.equal( await checkForUpdate( options( fake.request ) ), null );
	assert.equal( fake.calls.length, 1 );
});

test( "Ignores drafts, stable releases, and snapshots without update metadata", async () => {
	const draft = fixture();
	draft.release.draft = true;
	const stable = fixture();
	stable.release.tag_name = "v3.0.0";
	const old = fixture();
	old.release.assets = [];
	const fake = discovery( [ draft, stable, old ] );
	assert.equal( await checkForUpdate( options( fake.request ) ), null );
	assert.equal( fake.calls.length, 1 );
});

for ( const extra of [ { platform: "darwin" }, { platform: "constructor" }, { arch: "arm64" } ] ) {
	test( `Rejects an unsupported platform ${JSON.stringify( extra )}`, async () => {
		await assert.rejects( checkForUpdate( options( () => assert.fail(), extra ) ), {
			code: "UNSUPPORTED_PLATFORM"
		} );
	});
}

test( "Rejects missing current build identity without network access", async () => {
	await assert.rejects( checkForUpdate( options( () => assert.fail(), { currentBuild: {} } ) ), {
		code: "INVALID_CURRENT_BUILD"
	} );
});

for ( const invalid of [
	{ schema: 2 }, { channel: "stable" }, { repository: "untrusted/project" },
	{ commit: "not-a-commit" }, { buildNumber: 0 }, { commitTime: -1 },
	{ version: "2.5.3-01" }, { version: "2.5.3-.." }, { version: "02.5.3" }
] ) {
	test( `Rejects invalid manifest fields ${JSON.stringify( invalid )}`, async () => {
		const item = fixture( invalid );
		// Preserve a valid discoverable tag, so manifest validation receives the invalid commit.
		if ( invalid.commit ) {
			item.release.tag_name = `v2.5.3-master.g${"b".repeat( 40 )}`;
		}
		item.release.assets[0].browser_download_url
			= assetUrl( item.release.tag_name, "update.json" );
		const fake = discovery( [ item ], {
			[ item.release.assets[0].browser_download_url ]: { body: item.body }
		} );
		await assert.rejects( checkForUpdate( options( fake.request ) ), {
			code: "INVALID_MANIFEST"
		} );
	});
}

test( "Rejects a manifest whose tag identifies another commit", async () => {
	const item = fixture();
	item.manifest.commit = "c".repeat( 40 );
	item.body = Buffer.from( JSON.stringify( item.manifest ) );
	const fake = discovery( [ item ] );
	await assert.rejects( checkForUpdate( options( fake.request ) ), { code: "INVALID_MANIFEST" } );
});

test( "Rejects unsafe asset names, missing platforms and mismatched release sizes", async () => {
	for ( const mutate of [
		item => { item.manifest.platforms.win64.name = "../archive-win64.zip"; },
		item => { delete item.manifest.platforms.linux64; },
		item => { item.release.assets[1].size++; },
		item => { item.release.assets[2].size++; }
	] ) {
		const item = fixture();
		mutate( item );
		item.body = Buffer.from( JSON.stringify( item.manifest ) );
		item.release.assets[0].size = item.body.length;
		const fake = discovery( [ item ] );
		const codes = [ "INVALID_MANIFEST", "MISSING_PLATFORM_ASSET", "INVALID_RELEASE" ];
		await assert.rejects( checkForUpdate( options( fake.request ) ), cause =>
			codes.includes( cause.code ) );
	}
});

test( "Rejects duplicate release assets and incorrect manifest byte counts", async () => {
	const duplicate = fixture();
	duplicate.release.assets.push( { ...duplicate.release.assets[0] } );
	const duplicated = discovery( [ duplicate ] );
	await assert.rejects( checkForUpdate( options( duplicated.request ) ), {
		code: "INVALID_RELEASE"
	} );
	const wrongSize = fixture();
	wrongSize.release.assets[0].size++;
	const incorrect = discovery( [ wrongSize ] );
	await assert.rejects( checkForUpdate( options( incorrect.request ) ), {
		code: "INVALID_RELEASE"
	} );
});

test( "Rejects asset URLs outside the exact repository and tag", async () => {
	for ( const url of [
		"https://evil.example/update.json",
		"http://github.com/example/streamlink-twitch-gui/releases/download/v1/update.json",
		"https://github.com/other/project/releases/download/v1/update.json"
	] ) {
		const item = fixture();
		item.release.assets[0].browser_download_url = url;
		const fake = discovery( [ item ] );
		await assert.rejects( checkForUpdate( options( fake.request ) ), {
			code: "INVALID_RELEASE"
		} );
		assert.equal( fake.calls.length, 1 );
	}
});

test( "Rejects malformed or oversized GitHub JSON and transport errors", async () => {
	for ( const [ route, code ] of [
		[ { body: "{" }, "INVALID_JSON" ],
		[ { body: "[]", headers: { "content-length": String( 5 * 1024 * 1024 ) } },
			"RESPONSE_TOO_LARGE" ],
		[ { status: 403 }, "HTTP_ERROR" ],
		[ { error: new Error( "Offline" ) }, "NETWORK_ERROR" ]
	] ) {
		const fake = transport( { [ api ]: route } );
		await assert.rejects( checkForUpdate( options( fake.request ) ), { code } );
	}
});

test( "Times out a request before headers and supports a pre-aborted check", async () => {
	const fake = transport( { [ api ]: { hang: true } } );
	await assert.rejects( checkForUpdate( options( fake.request, { timeoutMs: 10 } ) ), {
		code: "REQUEST_TIMEOUT"
	} );
	const controller = new AbortController();
	controller.abort();
	await assert.rejects( checkForUpdate( options( () => assert.fail(), {
		signal: controller.signal
	} ) ), { code: "ABORTED" } );
});

test( "Downloads, verifies and atomically caches an archive with progress", async context => {
	const { update } = fixture();
	const filename = destination( context );
	const fake = transport( { [ update.asset.url ]: { body: windows } } );
	const progress = [];
	assert.equal( await downloadUpdate( update, filename, {
		request: fake.request, onProgress: value => progress.push( value )
	} ), filename );
	assert.deepEqual( fs.readFileSync( filename ), windows );
	assert.deepEqual( progress[0], { received: 0, total: windows.length, percent: 0 } );
	assert.equal( progress.at( -1 ).percent, 100 );
	noPartialFiles( filename );
	assert.equal( await downloadUpdate( update, filename, {
		request: () => assert.fail( "A verified cached download must not contact GitHub" )
	} ), filename );
});

test( "Replaces an existing corrupt cache only after verifying the replacement", async context => {
	const { update } = fixture();
	const filename = destination( context );
	fs.mkdirSync( path.dirname( filename ), { recursive: true } );
	fs.writeFileSync( filename, Buffer.from( "x".repeat( windows.length ) ) );
	const fake = transport( { [ update.asset.url ]: { body: windows } } );
	await downloadUpdate( update, filename, { request: fake.request } );
	assert.deepEqual( fs.readFileSync( filename ), windows );
	assert.equal( fake.calls.length, 1 );
	noPartialFiles( filename );
});

test( "Rejects redirect loops before contacting an unbounded number of URLs", async context => {
	const { update } = fixture();
	const filename = destination( context );
	const fake = transport( { [ update.asset.url ]: {
		status: 302, headers: { location: update.asset.url }
	} } );
	await assert.rejects( downloadUpdate( update, filename, { request: fake.request } ), {
		code: "NETWORK_ERROR"
	} );
	assert.equal( fake.calls.length, 6 );
	noPartialFiles( filename );
});

test( "Follows approved GitHub asset redirects and rejects untrusted redirects", async context => {
	const { update } = fixture();
	const filename = destination( context );
	const cdn = "https://release-assets.githubusercontent.com/github-production-release-asset/archive";
	const fake = transport({
		[ update.asset.url ]: { status: 302, headers: { location: cdn } },
		[ cdn ]: { body: windows }
	});
	await downloadUpdate( update, filename, { request: fake.request } );
	assert.equal( fake.calls.length, 2 );
	fs.rmSync( filename );
	for ( const url of [ "http://release-assets.githubusercontent.com/file", "https://evil.test/file" ] ) {
		const bad = transport({
			[ update.asset.url ]: { status: 302, headers: { location: url } }
		});
		await assert.rejects( downloadUpdate( update, filename, { request: bad.request } ), {
			code: "INVALID_RELEASE"
		} );
		assert.equal( bad.calls.length, 1 );
		noPartialFiles( filename );
	}
});

for ( const route of [
	{ body: Buffer.from( "x".repeat( windows.length ) ) },
	{ body: windows.subarray( 0, 4 ), headers: { "content-length": undefined } },
	{ body: windows, headers: { "content-length": "9999" } }
] ) {
	test( `Rejects corrupt or truncated archives (${route.body.length} bytes)`, async context => {
		const { update } = fixture();
		const filename = destination( context );
		const fake = transport( { [ update.asset.url ]: route } );
		const download = downloadUpdate( update, filename, { request: fake.request } );
		await assert.rejects( download, cause =>
			[ "CHECKSUM_MISMATCH", "DOWNLOAD_TRUNCATED" ].includes( cause.code ) );
		assert.equal( fs.existsSync( filename ), false );
		noPartialFiles( filename );
	});
}

test( "Cancellation during a streamed download removes the partial file", async context => {
	const { update } = fixture();
	const filename = destination( context );
	const controller = new AbortController();
	const fake = transport( { [ update.asset.url ]: {
		body: windows, chunks: [ windows.subarray( 0, 5 ), windows.subarray( 5 ) ]
	} } );
	await assert.rejects( downloadUpdate( update, filename, {
		request: fake.request, signal: controller.signal,
		onProgress( { received } ) { if ( received ) { controller.abort(); } }
	} ), { code: "ABORTED" } );
	assert.equal( fs.existsSync( filename ), false );
	noPartialFiles( filename );
});

test( "A stalled response body times out and leaves no partial download", async context => {
	const { update } = fixture();
	const filename = destination( context );
	const fake = transport( { [ update.asset.url ]: {
		body: windows, stream: new Readable( { read() {} } )
	} } );
	await assert.rejects( downloadUpdate( update, filename, {
		request: fake.request, timeoutMs: 10
	} ), { code: "REQUEST_TIMEOUT" } );
	noPartialFiles( filename );
});

test( "Metadata bodies are bounded and can time out or be cancelled", async () => {
	const slow = transport( { [ api ]: { stream: new Readable( { read() {} } ) } } );
	await assert.rejects( checkForUpdate( options( slow.request, { timeoutMs: 10 } ) ), {
		code: "REQUEST_TIMEOUT"
	} );
	const oversized = transport( { [ api ]: {
		body: Buffer.alloc( 5 * 1024 * 1024 ), headers: { "content-length": undefined }
	} } );
	await assert.rejects( checkForUpdate( options( oversized.request ) ), {
		code: "RESPONSE_TOO_LARGE"
	} );
	const controller = new AbortController();
	const hanging = transport( { [ api ]: { hang: true } } );
	const checking = checkForUpdate( options( hanging.request, { signal: controller.signal } ) );
	controller.abort();
	await assert.rejects( checking, { code: "ABORTED" } );
});
