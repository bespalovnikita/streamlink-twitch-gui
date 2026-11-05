const { test } = require( "node:test" );
const assert = require( "node:assert/strict" );
const { spawnSync } = require( "node:child_process" );
const { createHash } = require( "node:crypto" );
const fs = require( "node:fs" );
const os = require( "node:os" );
const path = require( "node:path" );


const script = path.resolve( __dirname, "../scripts/publish-master-release.sh" );
const sha = "0123456789abcdef0123456789abcdef01234567";
const otherSha = "fedcba9876543210fedcba9876543210fedcba98";
const repo = "example/streamlink-twitch-gui";
const tag = `v2.5.3-master.g${sha}`;
const releaseUrl = `https://github.com/${repo}/releases/tag/${tag}`;
const archiveName = "streamlink-twitch-gui-v2.5.3-linux64.tar.gz";
const checksumName = "streamlink-twitch-gui-v2.5.3-checksums.txt";

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


function fixture( context, initialState = {} ) {
	const directory = fs.mkdtempSync( path.join( os.tmpdir(), "publish-master-release-" ) );
	context.after( () => fs.rmSync( directory, { recursive: true, force: true } ) );
	const bin = path.join( directory, "bin" );
	const dist = path.join( directory, "dist" );
	const temporary = path.join( directory, "tmp" );
	[ bin, dist, temporary ].forEach( folder => fs.mkdirSync( folder ) );
	const manifest = path.join( directory, "package.json" );
	fs.writeFileSync( manifest, JSON.stringify({ version: "2.5.3" }) );
	fs.writeFileSync( path.join( bin, "gh" ), fakeGh, { mode: 0o755 } );
	const archive = Buffer.from( "Fake Linux archive for release publishing tests\n" );
	const digest = createHash( "sha256" ).update( archive ).digest( "hex" );
	fs.writeFileSync( path.join( dist, archiveName ), archive );
	fs.writeFileSync( path.join( dist, checksumName ), `${digest}  ${archiveName}\n` );
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
		dist,
		summaryFile,
		state: () => JSON.parse( fs.readFileSync( stateFile, "utf8" ) ),
		updateState: update => fs.writeFileSync( stateFile, JSON.stringify({
			...JSON.parse( fs.readFileSync( stateFile, "utf8" ) ), ...update
		}) ),
		clearCalls: () => fs.writeFileSync( callsFile, "" ),
		calls: () => fs.readFileSync( callsFile, "utf8" ).trim().split( "\n" )
			.filter( Boolean ).map( line => JSON.parse( line ) ),
		run: () => spawnSync( "bash", [ script ], {
			cwd: directory,
			encoding: "utf8",
			timeout: 10000,
			env: {
				PATH: [ bin, path.dirname( process.execPath ), "/usr/bin", "/bin" ]
					.join( path.delimiter ),
				TMPDIR: temporary,
				GH_REPO: repo,
				GITHUB_SHA: sha,
				GITHUB_STEP_SUMMARY: summaryFile,
				FAKE_GH_STATE: stateFile,
				FAKE_GH_CALLS: callsFile,
				FAKE_RELEASE_URL: releaseUrl
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
		`dist/${archiveName}`, `dist/${checksumName}`
	].sort(), "Uploads only the archive and checksums" );
	const verify = calls.findIndex( ({ args }) => args[ 0 ] === "api" );
	assert.ok( verify >= 0 && verify < calls.indexOf( upload ), "Verifies the tag before upload" );
	assert.deepEqual( calls[ verify ].args, [
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

for ( const missing of [ archiveName, checksumName ] ) {
	test( `Does not create or publish a release when ${missing} is missing`, context => {
		const files = fixture( context );
		fs.rmSync( path.join( files.dist, missing ) );
		expectFailure( files.run() );
		assert.deepEqual( files.calls(), [], "Validates assets before contacting GitHub" );
	});
}

for ( const duplicate of [ "extra.tar.gz", "extra-checksums.txt" ] ) {
	test( `Rejects ambiguous release assets when ${duplicate} also exists`, context => {
		const files = fixture( context );
		fs.writeFileSync( path.join( files.dist, duplicate ), "Unexpected release asset\n" );
		expectFailure( files.run() );
		assert.deepEqual( files.calls(), [], "Does not mutate GitHub for ambiguous assets" );
	});
}

test( "Rejects an archive that does not match its checksum", context => {
	const files = fixture( context );
	fs.appendFileSync( path.join( files.dist, archiveName ), "Corrupted archive\n" );
	expectFailure( files.run() );
	assert.deepEqual( files.calls(), [], "Does not publish corrupted assets" );
});
