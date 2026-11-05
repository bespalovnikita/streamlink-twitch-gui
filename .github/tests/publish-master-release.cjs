const { test } = require( "node:test" );
const assert = require( "node:assert/strict" );
const { spawnSync } = require( "node:child_process" );
const { createHash, generateKeyPairSync, verify } = require( "node:crypto" );
const { gzipSync } = require( "node:zlib" );
const fs = require( "node:fs" );
const os = require( "node:os" );
const path = require( "node:path" );


const script = path.resolve( __dirname, "../scripts/publish-master-release.sh" );
const prepareScript = path.resolve( __dirname, "../scripts/prepare-windows-release.sh" );
const sha = "0123456789abcdef0123456789abcdef01234567";
const otherSha = "fedcba9876543210fedcba9876543210fedcba98";
const repo = "example/streamlink-twitch-gui";
const tag = `v2.5.3-master.g${sha}`;
const releaseUrl = `https://github.com/${repo}/releases/tag/${tag}`;
const archiveName = "streamlink-twitch-gui-v2.5.3-linux64.tar.gz";
const windowsName = "streamlink-twitch-gui-v2.5.3-win64.zip";
const checksumName = "streamlink-twitch-gui-v2.5.3-checksums.txt";

function archiveContent( platform ) {
	const data = Buffer.from( platform );
	const name = Buffer.from( "streamlink-twitch-gui/example.txt" );
	if ( platform === "linux64" ) {
		const header = Buffer.alloc( 512 );
		name.copy( header );
		header.write( "0000644\0", 100 );
		header.write( "0000000\0", 108 );
		header.write( "0000000\0", 116 );
		header.write( `${data.length.toString( 8 ).padStart( 11, "0" )}\0`, 124 );
		header.write( "00000000000\0", 136 );
		header.fill( 32, 148, 156 );
		header[156] = 48;
		header.write( "ustar\0", 257 );
		header.write( "00", 263 );
		const sum = header.reduce( ( total, byte ) => total + byte, 0 );
		header.write( `${sum.toString( 8 ).padStart( 6, "0" )}\0 `, 148 );
		return gzipSync( Buffer.concat( [ header, data,
			Buffer.alloc( ( 512 - data.length % 512 ) % 512 + 1024 ) ] ) );
	}
	let crc = 0xffffffff;
	for ( const byte of data ) {
		crc ^= byte;
		for ( let bit = 0; bit < 8; bit++ ) {
			crc = crc & 1 ? ( crc >>> 1 ) ^ 0xedb88320 : crc >>> 1;
		}
	}
	crc = ( crc ^ 0xffffffff ) >>> 0;
	const local = Buffer.alloc( 30 );
	local.writeUInt32LE( 0x04034b50 );
	local.writeUInt16LE( 20, 4 );
	local.writeUInt32LE( crc, 14 );
	local.writeUInt32LE( data.length, 18 );
	local.writeUInt32LE( data.length, 22 );
	local.writeUInt16LE( name.length, 26 );
	const central = Buffer.alloc( 46 );
	central.writeUInt32LE( 0x02014b50 );
	central.writeUInt16LE( 20, 4 );
	central.writeUInt16LE( 20, 6 );
	central.writeUInt32LE( crc, 16 );
	central.writeUInt32LE( data.length, 20 );
	central.writeUInt32LE( data.length, 24 );
	central.writeUInt16LE( name.length, 28 );
	const end = Buffer.alloc( 22 );
	end.writeUInt32LE( 0x06054b50 );
	end.writeUInt16LE( 1, 8 );
	end.writeUInt16LE( 1, 10 );
	end.writeUInt32LE( central.length + name.length, 12 );
	end.writeUInt32LE( local.length + name.length + data.length, 16 );
	return Buffer.concat( [ local, name, data, central, name, end ] );
}

const fakeGh = `#!/usr/bin/env node
const fs = require( "node:fs" );
const args = process.argv.slice( 2 );
const state = JSON.parse( fs.readFileSync( process.env.FAKE_GH_STATE, "utf8" ) );
const call = { args };
const option = name => {
	const index = args.indexOf( name );
	return index < 0 ? undefined : args[ index + 1 ];
};
if ( args[ 0 ] === "release" && args[ 1 ] === "create" ) {
	call.notes = fs.readFileSync( option( "--notes-file" ), "utf8" );
}
fs.appendFileSync( process.env.FAKE_GH_CALLS, JSON.stringify( call ) + "\\n" );
const save = () => fs.writeFileSync( process.env.FAKE_GH_STATE, JSON.stringify( state ) );
if ( args[ 0 ] === "api" && option( "--jq" ) === ".sha" ) {
	if ( !state.tagExists ) { process.exit( 1 ); }
	process.stdout.write( state.commit + "\\n" );
} else if ( args[ 0 ] === "api" && option( "--method" ) === "POST" ) {
	if ( state.tagExists ) { process.exit( 9 ); }
	state.tagExists = true;
	state.commit = args.find( arg => arg.startsWith( "sha=" ) ).slice( 4 );
	save();
} else if ( args[ 0 ] === "release" && args[ 1 ] === "view" ) {
	if ( !state.exists ) { process.exit( 1 ); }
	if ( option( "--json" ) === "isDraft" ) {
		process.stdout.write( String( state.isDraft ) + "\\n" );
	} else if ( option( "--json" ) === "url" ) {
		process.stdout.write( process.env.FAKE_RELEASE_URL + "\\n" );
	} else {
		process.exit( 2 );
	}
} else if ( args[ 0 ] === "release" && args[ 1 ] === "create" ) {
	if ( state.exists || !state.tagExists ) { process.exit( 3 ); }
	state.exists = true;
	state.isDraft = args.includes( "--draft" );
	save();
} else if ( args[ 0 ] === "release" && args[ 1 ] === "upload" ) {
	if ( !state.exists || !state.isDraft ) { process.exit( 4 ); }
	if ( state.failUpload ) { process.exit( 47 ); }
	state.uploaded = args.slice( 3 ).filter( arg => arg !== "--clobber" );
	state.uploaded.forEach( file => {
		if ( !fs.statSync( file ).isFile() ) { process.exit( 5 ); }
	});
	save();
} else if ( args[ 0 ] === "release" && args[ 1 ] === "edit" ) {
	if ( !state.exists || !state.isDraft ) { process.exit( 6 ); }
	if ( !args.includes( "--draft=false" ) ) { process.exit( 7 ); }
	state.isDraft = false;
	save();
} else {
	process.exit( 8 );
}
`;


function fixture( context, initialState = {}, options = {} ) {
	const directory = fs.mkdtempSync( path.join( os.tmpdir(), "publish-master-release-" ) );
	context.after( () => fs.rmSync( directory, { recursive: true, force: true } ) );
	const bin = path.join( directory, "bin" );
	const dist = path.join( directory, "dist" );
	const temporary = path.join( directory, "tmp" );
	[ bin, dist, temporary ].forEach( folder => fs.mkdirSync( folder ) );
	const manifest = path.join( directory, "package.json" );
	fs.writeFileSync( manifest, JSON.stringify({ version: "2.5.3" }) );
	const signingKeys = generateKeyPairSync( "ed25519" );
	const signingKeyId = "test-master";
	const privateKey = signingKeys.privateKey.export({ type: "pkcs8", format: "pem" });
	const configDirectory = path.join( directory, "src/config" );
	fs.mkdirSync( configDirectory, { recursive: true } );
	fs.writeFileSync( path.join( configDirectory, "update.json" ), JSON.stringify({
		signingKeyId,
		trustedKeys: {
			[ signingKeyId ]: signingKeys.publicKey.export({ type: "spki", format: "pem" })
		}
	}) );
	const application = path.join( directory, "work/windows-app" );
	fs.mkdirSync( application, { recursive: true } );
	fs.writeFileSync( path.join( application, "build-info.json" ), JSON.stringify({
		schema: 1,
		channel: "master",
		appName: "streamlink-twitch-gui",
		repository: repo,
		version: "2.5.3",
		commit: sha,
		commitTime: 1704067200,
		buildNumber: 23
	}) );
	fs.writeFileSync( path.join( bin, "gh" ), fakeGh, { mode: 0o755 } );
	const archive = archiveContent( "linux64" );
	const digest = createHash( "sha256" ).update( archive ).digest( "hex" );
	fs.writeFileSync( path.join( dist, archiveName ), archive );
	let checksums = `${digest}  ${archiveName}\n`;
	if ( options.includeWindows !== false ) {
		const windows = archiveContent( "win64" );
		const windowsDigest = createHash( "sha256" ).update( windows ).digest( "hex" );
		fs.writeFileSync( path.join( dist, windowsName ), windows );
		checksums += `${windowsDigest}  ${windowsName}\n`;
	}
	fs.writeFileSync( path.join( dist, checksumName ), checksums );
	fs.writeFileSync( path.join( dist, "unrelated.txt" ), "Do not upload this file\n" );
	const stateFile = path.join( directory, "state.json" );
	const callsFile = path.join( directory, "calls.jsonl" );
	const summaryFile = path.join( directory, "summary.md" );
	fs.writeFileSync( stateFile, JSON.stringify({
		exists: false,
		tagExists: !!initialState.exists,
		isDraft: true,
		commit: sha,
		...initialState
	}) );
	fs.writeFileSync( callsFile, "" );

	return {
		directory,
		dist,
		summaryFile,
		privateKey,
		signingKeyId,
		publicKey: signingKeys.publicKey,
		state: () => JSON.parse( fs.readFileSync( stateFile, "utf8" ) ),
		updateState: update => fs.writeFileSync( stateFile, JSON.stringify({
			...JSON.parse( fs.readFileSync( stateFile, "utf8" ) ), ...update
		}) ),
		clearCalls: () => fs.writeFileSync( callsFile, "" ),
		calls: () => fs.readFileSync( callsFile, "utf8" ).trim().split( "\n" )
			.filter( Boolean ).map( line => JSON.parse( line ) ),
		run: ( executable = script, extraEnv = {} ) => spawnSync( "bash", [ executable ], {
			cwd: directory,
			encoding: "utf8",
			timeout: 10000,
			env: {
				PATH: [ bin, path.dirname( process.execPath ), "/usr/bin", "/bin" ]
					.join( path.delimiter ),
				TMPDIR: temporary,
				GH_REPO: repo,
				GITHUB_SHA: sha,
				GITHUB_RUN_NUMBER: "23",
				UPDATER_ED25519_PRIVATE_KEY: privateKey,
				GITHUB_STEP_SUMMARY: summaryFile,
				FAKE_GH_STATE: stateFile,
				FAKE_GH_CALLS: callsFile,
				FAKE_RELEASE_URL: releaseUrl,
				...extraEnv
			}
		})
	};
}

function mutations( calls ) {
	return calls.filter( ({ args }) => args[ 0 ] === "release"
		&& [ "create", "upload", "edit" ].includes( args[ 1 ] )
		|| args[ 0 ] === "api" && args.includes( "POST" ) );
}

function mutationAction( { args } ) {
	return args[ 0 ] === "api" ? "create-tag" : args[ 1 ];
}

function expectSuccess( result ) {
	assert.ifError( result.error );
	assert.equal( result.status, 0, result.stdout + result.stderr );
	assert.ok( result.stdout.includes( releaseUrl ), "Prints the published release URL" );
}

function expectFailure( result ) {
	assert.ifError( result.error );
	assert.notEqual( result.status, 0, "Rejects invalid or incomplete release publication" );
}

function expectPublication( files, expectedActions ) {
	const calls = files.calls();
	const changes = mutations( calls );
	assert.deepEqual( changes.map( mutationAction ), expectedActions );
	changes.filter( ({ args }) => args[ 0 ] === "release" )
		.forEach( ({ args }) => assert.equal( args[ 2 ], tag, "Uses a commit-specific tag" ) );
	const upload = changes.find( ({ args }) => args[ 1 ] === "upload" );
	assert.ok( upload.args.includes( "--clobber" ), "Retries draft assets safely" );
	assert.deepEqual( upload.args.slice( 3 ).filter( arg => arg !== "--clobber" ).sort(), [
		`dist/${archiveName}`, `dist/${windowsName}`, `dist/${checksumName}`,
		"dist/update.json", "dist/update.json.sig"
	].sort(), "Uploads both archives, shared checksums, the manifest and its signature" );
	const manifestBytes = fs.readFileSync( path.join( files.dist, "update.json" ) );
	const signature = JSON.parse( fs.readFileSync( path.join( files.dist, "update.json.sig" ) ) );
	assert.equal( signature.keyId, files.signingKeyId );
	assert.equal( signature.algorithm, "Ed25519" );
	assert.equal( verify( null, manifestBytes, files.publicKey,
		Buffer.from( signature.signatureBase64, "base64" ) ), true );
	const manifest = JSON.parse( manifestBytes );
	for ( const platform of [ "win64", "linux64" ] ) {
		assert.ok( manifest.platforms[ platform ].unpackedSize > 0 );
	}
	const tagVerification = calls.findIndex( ({ args }) => args[ 0 ] === "api" );
	assert.ok( tagVerification >= 0 && tagVerification < calls.indexOf( upload ),
		"Verifies the tag before upload" );
	assert.deepEqual( calls[ tagVerification ].args, [
		"api", `repos/${repo}/commits/${tag}`, "--jq", ".sha"
	] );
	const publish = changes.find( ({ args }) => args[ 1 ] === "edit" );
	assert.ok( publish.args.includes( "--draft=false" ) );
	assert.ok( publish.args.includes( "--prerelease" ), "Publishes as a prerelease" );
	assert.ok( publish.args.includes( "--latest=false" ), "Keeps the stable latest release" );
	assert.equal( files.state().isDraft, false );
	assert.ok( fs.readFileSync( files.summaryFile, "utf8" ).includes( releaseUrl ) );
}


test( "Creates a draft, verifies its commit, uploads assets, then publishes", context => {
	const files = fixture( context );
	expectSuccess( files.run() );
	expectPublication( files, [ "create-tag", "create", "upload", "edit" ] );
	const createTag = mutations( files.calls() )[ 0 ];
	assert.deepEqual( createTag.args, [
		"api", "--method", "POST", `repos/${repo}/git/refs`,
		"-f", `ref=refs/tags/${tag}`, "-f", `sha=${sha}`
	] );
	const create = mutations( files.calls() )[ 1 ];
	assert.ok( create.args.includes( "--draft" ), "Creates the release as a draft" );
	assert.ok( create.args.includes( "--verify-tag" ), "Uses the verified existing tag" );
	assert.ok( create.args.includes( "--prerelease" ) );
	assert.ok( create.args.includes( "--latest=false" ) );
	assert.equal( create.args[ create.args.indexOf( "--target" ) + 1 ], sha );
	assert.ok( create.notes.includes( sha ), "Release notes identify the tested commit" );
});

for ( const previous of [ "", `v2.5.3-master.g${otherSha}` ] ) {
	const scope = previous ? "since the previous release" : "to the first release";
	test( `Adds commit descriptions ${scope}`,
		context => {
			const files = fixture( context );
			fs.writeFileSync( path.join( files.directory, "bin/git" ), `#!/usr/bin/env node
const assert = require("node:assert/strict");
const args = process.argv.slice(2);
const previous = process.env.FAKE_PREVIOUS_TAG;
if (args[0] === "rev-parse") {
	assert.deepEqual(args, ["rev-parse", "--is-inside-work-tree"]);
} else if (args[0] === "describe") {
	assert.ok(args.includes("${sha}^"));
	if (!previous) { process.exit(1); }
	process.stdout.write(previous);
} else {
	assert.deepEqual(args, ["--no-pager", "log", "--first-parent", "--format=- %s (%h)",
		previous ? "--max-count=20" : "--max-count=10",
		previous ? previous + "..${sha}" : "${sha}"]);
	process.stdout.write("- Fix Unicode profile paths (abc1234)\\n");
}
`, { mode: 0o755 } );
			expectSuccess( files.run( script, { FAKE_PREVIOUS_TAG: previous } ) );
			const create = mutations( files.calls() ).find( ({ args }) => args[ 1 ] === "create" );
			assert.ok( create.notes.includes( "Изменения:" ) );
			assert.ok( create.notes.includes( "Fix Unicode profile paths (abc1234)" ) );
			expectPublication( files, [ "create-tag", "create", "upload", "edit" ] );
		} );
}

test( "Leaves an already published release and its assets unchanged", context => {
	const files = fixture( context, { exists: true, isDraft: false } );
	expectSuccess( files.run() );
	assert.deepEqual( mutations( files.calls() ), [] );
	assert.equal( files.state().isDraft, false );
	assert.ok( files.calls().some( ({ args }) => args[ 0 ] === "api" ), "Checks the existing tag" );
});

test( "Resumes an existing draft without creating another release", context => {
	const files = fixture( context, { exists: true, isDraft: true } );
	expectSuccess( files.run() );
	expectPublication( files, [ "upload", "edit" ] );
});

test( "An upload failure keeps the release as a draft and a retry can finish", context => {
	const files = fixture( context, { failUpload: true } );
	expectFailure( files.run() );
	assert.deepEqual( mutations( files.calls() ).map( mutationAction ), [
		"create-tag", "create", "upload"
	] );
	assert.equal( files.state().isDraft, true, "Does not publish incomplete assets" );
	files.updateState({ failUpload: false });
	files.clearCalls();
	expectSuccess( files.run() );
	expectPublication( files, [ "upload", "edit" ] );
});

for ( const isDraft of [ true, false ] ) {
	const state = isDraft ? "draft" : "published";
	test( `Rejects a ${state} tag pointing to another commit`, context => {
		const files = fixture( context, { exists: true, isDraft, commit: otherSha } );
		expectFailure( files.run() );
		assert.deepEqual( mutations( files.calls() ), [], "Does not overwrite the wrong release" );
		assert.equal( files.state().commit, otherSha );
	});
}

for ( const missing of [ archiveName, windowsName, checksumName ] ) {
	test( `Does not create or publish a release when ${missing} is missing`, context => {
		const files = fixture( context );
		fs.rmSync( path.join( files.dist, missing ) );
		expectFailure( files.run() );
		assert.deepEqual( files.calls(), [], "Validates assets before contacting GitHub" );
	});
}

for ( const duplicate of [ "extra-linux64.tar.gz", "extra-win64.zip", "extra-checksums.txt" ] ) {
	test( `Rejects ambiguous release assets when ${duplicate} also exists`, context => {
		const files = fixture( context );
		fs.writeFileSync( path.join( files.dist, duplicate ), "Unexpected release asset\n" );
		expectFailure( files.run() );
		assert.deepEqual( files.calls(), [], "Does not mutate GitHub for ambiguous assets" );
	});
}

for ( const corrupted of [ archiveName, windowsName ] ) {
	test( `Rejects ${corrupted} when its checksum does not match`, context => {
		const files = fixture( context );
		fs.appendFileSync( path.join( files.dist, corrupted ), "Corrupted archive\n" );
		expectFailure( files.run() );
		assert.deepEqual( files.calls(), [], "Does not publish corrupted assets" );
	});
}

test( "Rejects a checksum manifest without the Windows archive hash", context => {
	const files = fixture( context );
	const manifest = path.join( files.dist, checksumName );
	const linuxChecksum = fs.readFileSync( manifest, "utf8" ).split( "\n" )
		.find( line => line.endsWith( archiveName ) );
	fs.writeFileSync( manifest, `${linuxChecksum}\n` );
	expectFailure( files.run() );
	assert.deepEqual( files.calls(), [], "Requires checksum coverage for both platforms" );
});

for ( const key of [ "", "not a signing key" ] ) {
	test( `Does not contact GitHub when the signing key is ${key ? "invalid" : "missing"}`,
		context => {
			const files = fixture( context );
			const result = files.run( script, { UPDATER_ED25519_PRIVATE_KEY: key } );
			expectFailure( result );
			assert.deepEqual( files.calls(), [], "Signs before any GitHub request" );
			assert.equal( fs.existsSync( path.join( files.dist, "update.json.sig" ) ), false );
			assert.equal( ( result.stdout + result.stderr ).includes( files.privateKey ), false );
			assert.equal( ( result.stdout + result.stderr ).includes( "BEGIN PRIVATE KEY" ),
				false );
		} );
}

test( "Rejects a private key that does not match the app's pinned public key", context => {
	const files = fixture( context );
	const otherKey = generateKeyPairSync( "ed25519" ).privateKey
		.export({ type: "pkcs8", format: "pem" });
	const result = files.run( script, { UPDATER_ED25519_PRIVATE_KEY: otherKey } );
	expectFailure( result );
	assert.deepEqual( files.calls(), [], "Never creates a release signed by an untrusted key" );
	assert.equal( ( result.stdout + result.stderr ).includes( otherKey ), false );
	assert.equal( ( result.stdout + result.stderr ).includes( "BEGIN PRIVATE KEY" ), false );
});

function windowsFixture( context, withExecutable = true ) {
	const files = fixture( context, {}, { includeWindows: false } );
	const application = path.join( files.directory, "work/windows-app" );
	fs.mkdirSync( application, { recursive: true } );
	if ( withExecutable ) {
		const executable = path.join( application, "streamlink-twitch-gui.exe" );
		fs.writeFileSync( executable, "MZ test executable\n" );
	}
	fs.writeFileSync( path.join( application, ".portable-config" ), "Hidden runtime data\n" );
	return files;
}

function runArchiveTool( files, executable, args ) {
	const result = spawnSync( executable, args, {
		cwd: files.dist,
		encoding: "utf8",
		timeout: 10000,
		env: { PATH: "/usr/bin:/bin" }
	});
	assert.ifError( result.error );
	assert.equal( result.status, 0, result.stdout + result.stderr );
	return result.stdout;
}

test( "Packages the Windows app with hidden files and checksums for both platforms", context => {
	const files = windowsFixture( context );
	const result = files.run( prepareScript, { SOURCE_DATE_EPOCH: "1704067200" } );
	assert.ifError( result.error );
	assert.equal( result.status, 0, result.stdout + result.stderr );
	const entries = runArchiveTool( files, "unzip", [ "-Z1", windowsName ] )
		.trim().split( "\n" );
	assert.deepEqual( entries.sort(), [
		"streamlink-twitch-gui/",
		"streamlink-twitch-gui/.portable-config",
		"streamlink-twitch-gui/build-info.json",
		"streamlink-twitch-gui/streamlink-twitch-gui.exe"
	].sort(), "Uses the application directory prefix and preserves hidden files" );
	assert.equal( runArchiveTool( files, "unzip", [
		"-p", windowsName, "streamlink-twitch-gui/streamlink-twitch-gui.exe"
	] ), "MZ test executable\n" );
	assert.equal( runArchiveTool( files, "unzip", [
		"-p", windowsName, "streamlink-twitch-gui/.portable-config"
	] ), "Hidden runtime data\n" );
	const checksums = fs.readFileSync( path.join( files.dist, checksumName ), "utf8" )
		.trim().split( "\n" );
	const expected = [ archiveName, windowsName ].map( name => {
		const content = fs.readFileSync( path.join( files.dist, name ) );
		const digest = createHash( "sha256" ).update( content ).digest( "hex" );
		return `${digest}  ${name}`;
	});
	assert.deepEqual( checksums.sort(), expected.sort(), "Lists both archive SHA256 hashes" );
	const verified = runArchiveTool( files, "sha256sum", [ "--check", checksumName ] );
	assert.ok( verified.includes( `${archiveName}: OK` ) );
	assert.ok( verified.includes( `${windowsName}: OK` ) );
	assert.deepEqual( files.calls(), [], "Packaging does not contact GitHub" );
});

test( "Does not create a Windows ZIP when the application executable is missing", context => {
	const files = windowsFixture( context, false );
	const checksums = fs.readFileSync( path.join( files.dist, checksumName ), "utf8" );
	expectFailure( files.run( prepareScript, { SOURCE_DATE_EPOCH: "1704067200" } ) );
	assert.equal( fs.existsSync( path.join( files.dist, windowsName ) ), false );
	assert.equal( fs.readFileSync( path.join( files.dist, checksumName ), "utf8" ), checksums );
	assert.deepEqual( files.calls(), [], "Does not publish a missing application" );
});
