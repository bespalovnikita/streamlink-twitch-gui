const { test } = require( "node:test" );
const assert = require( "node:assert/strict" );
const fs = require( "node:fs" );
const os = require( "node:os" );
const path = require( "node:path" );
const { createHash } = require( "node:crypto" );
const { createManifest } = require( "../scripts/create-update-manifest.cjs" );


const commit = "0123456789abcdef0123456789abcdef01234567";
const identity = {
	schema: 1,
	channel: "master",
	appName: "streamlink-twitch-gui",
	repository: "example/streamlink-twitch-gui",
	version: "2.5.3",
	commit,
	commitTime: 1704067200,
	buildNumber: 23
};

function fixture( context ) {
	const directory = fs.mkdtempSync( path.join( os.tmpdir(), "update-manifest-" ) );
	context.after( () => fs.rmSync( directory, { recursive: true, force: true } ) );
	const files = {
		win64: "streamlink-twitch-gui-v2.5.3-master.gprevious+1.gnew-win64.zip",
		linux64: "streamlink-twitch-gui-v2.5.3-master.gprevious+1.gnew-linux64.tar.gz"
	};
	for ( const [ platform, name ] of Object.entries( files ) ) {
		fs.writeFileSync( path.join( directory, name ), platform );
	}
	return {
		directory,
		files,
		create: ( overrides = {} ) => createManifest({
			directory,
			identity,
			repository: identity.repository,
			expectedCommit: commit,
			expectedBuildNumber: 23,
			...overrides
		})
	};
}

test( "Manifest identifies the checked build and hashes both exact assets", context => {
	const files = fixture( context );
	const manifest = files.create();
	assert.equal( manifest.commit, commit );
	assert.equal( manifest.buildNumber, 23 );
	assert.equal( manifest.commitTime, identity.commitTime );
	assert.equal( manifest.channel, "master" );
	for ( const platform of [ "win64", "linux64" ] ) {
		assert.deepEqual( manifest.platforms[ platform ], {
			name: files.files[ platform ],
			size: Buffer.byteLength( platform ),
			sha256: createHash( "sha256" ).update( platform ).digest( "hex" )
		});
	}
});

test( "A different commit or build number cannot be published", context => {
	const files = fixture( context );
	assert.throws( () => files.create({ expectedCommit: "a".repeat( 40 ) }) );
	assert.throws( () => files.create({ expectedBuildNumber: 24 }) );
	assert.throws( () => files.create({ identity: { ...identity, channel: "stable" } }) );
	assert.throws( () => files.create({ repository: "another/repository" }) );
});

test( "An unidentified local build cannot become an update", context => {
	const files = fixture( context );
	assert.throws( () => files.create({ identity: { ...identity, buildNumber: 0 } }) );
	assert.throws( () => files.create({ identity: { ...identity, commitTime: 0 } }) );
	assert.throws( () => files.create({ identity: { ...identity, commit: "" } }) );
});

for ( const platform of [ "win64", "linux64" ] ) {
	test( `Rejects missing, empty and ambiguous ${platform} archives`, context => {
		const files = fixture( context );
		const archive = path.join( files.directory, files.files[ platform ] );
		fs.unlinkSync( archive );
		assert.throws( () => files.create() );
		fs.writeFileSync( archive, "" );
		assert.throws( () => files.create() );
		fs.writeFileSync( archive, platform );
		const duplicate = path.join( files.directory, `extra-${files.files[ platform ]}` );
		fs.copyFileSync( archive, duplicate );
		assert.throws( () => files.create() );
	});
}
