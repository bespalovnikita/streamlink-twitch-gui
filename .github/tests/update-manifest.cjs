const { test } = require( "node:test" );
const assert = require( "node:assert/strict" );
const fs = require( "node:fs" );
const os = require( "node:os" );
const path = require( "node:path" );
const { createHash, generateKeyPairSync, verify } = require( "node:crypto" );
const { gzipSync } = require( "node:zlib" );
const { createManifest, signManifest } = require( "../scripts/create-update-manifest.cjs" );


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

function fixture( context ) {
	const directory = fs.mkdtempSync( path.join( os.tmpdir(), "update-manifest-" ) );
	context.after( () => fs.rmSync( directory, { recursive: true, force: true } ) );
	const files = {
		win64: "streamlink-twitch-gui-v2.5.3-master.gprevious+1.gnew-win64.zip",
		linux64: "streamlink-twitch-gui-v2.5.3-master.gprevious+1.gnew-linux64.tar.gz"
	};
	for ( const [ platform, name ] of Object.entries( files ) ) {
		fs.writeFileSync( path.join( directory, name ), archiveContent( platform ) );
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
		const archive = fs.readFileSync( path.join( files.directory, files.files[ platform ] ) );
		const asset = manifest.platforms[ platform ];
		assert.equal( asset.name, files.files[ platform ] );
		assert.equal( asset.size, archive.length );
		assert.equal( asset.sha256, createHash( "sha256" ).update( archive ).digest( "hex" ) );
		assert.ok( Number.isSafeInteger( asset.unpackedSize ) );
		assert.ok( asset.unpackedSize >= Buffer.byteLength( platform ) );
		assert.ok( asset.unpackedSize <= 4 * 1024 * 1024 * 1024 );
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
		fs.writeFileSync( archive, archiveContent( platform ) );
		const duplicate = path.join( files.directory, `extra-${files.files[ platform ]}` );
		fs.copyFileSync( archive, duplicate );
		assert.throws( () => files.create() );
	});
}

for ( const platform of [ "win64", "linux64" ] ) {
	test( `Rejects malformed ${platform} archive metadata`, context => {
		const files = fixture( context );
		const archive = path.join( files.directory, files.files[ platform ] );
		fs.writeFileSync( archive, "This is not a release archive" );
		assert.throws( () => files.create() );
		fs.writeFileSync( archive, archiveContent( platform ).subarray( 0, 12 ) );
		assert.throws( () => files.create() );
	});
}

test( "Rejects archives with no declared expanded content", context => {
	const files = fixture( context );
	const zip = archiveContent( "win64" );
	const centralOffset = zip.readUInt32LE( zip.length - 6 );
	zip.writeUInt32LE( 0, centralOffset + 24 );
	fs.writeFileSync( path.join( files.directory, files.files.win64 ), zip );
	assert.throws( () => files.create() );
	fs.writeFileSync( path.join( files.directory, files.files.win64 ), archiveContent( "win64" ) );
	fs.writeFileSync( path.join( files.directory, files.files.linux64 ),
		gzipSync( Buffer.alloc( 0 ) ) );
	assert.throws( () => files.create() );
});

test( "Rejects ZIP expanded sizes larger than the extraction limit", context => {
	const files = fixture( context );
	const zip = archiveContent( "win64" );
	const end = zip.subarray( zip.length - 22 );
	const offset = end.readUInt32LE( 16 );
	const central = Buffer.from( zip.subarray( offset, zip.length - 22 ) );
	central.writeUInt32LE( 0xffffffff - 1, 24 );
	end.writeUInt16LE( 2, 8 );
	end.writeUInt16LE( 2, 10 );
	end.writeUInt32LE( central.length * 2, 12 );
	fs.writeFileSync( path.join( files.directory, files.files.win64 ),
		Buffer.concat( [ zip.subarray( 0, offset ), central, central, end ] ) );
	assert.throws( () => files.create() );
});

function signingFixture() {
	const { privateKey, publicKey } = generateKeyPairSync( "ed25519" );
	const keyId = "test-master";
	return {
		manifestBytes: Buffer.from( `${JSON.stringify({ schema: 1, commit: "test fixture" })}\n` ),
		privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
		publicKey,
		keyId,
		trustedKeys: { [ keyId ]: publicKey.export({ type: "spki", format: "pem" }) }
	};
}

test( "Signs the exact manifest bytes with the pinned Ed25519 key", () => {
	const options = signingFixture();
	const signature = signManifest( options );
	assert.deepEqual( Object.keys( signature ).sort(), [
		"schema", "algorithm", "keyId", "signatureBase64"
	].sort() );
	assert.equal( signature.schema, 1 );
	assert.equal( signature.algorithm, "Ed25519" );
	assert.equal( signature.keyId, options.keyId );
	const bytes = Buffer.from( signature.signatureBase64, "base64" );
	assert.equal( bytes.length, 64 );
	assert.equal( bytes.toString( "base64" ), signature.signatureBase64 );
	assert.equal( verify( null, options.manifestBytes, options.publicKey, bytes ), true );
	assert.equal( verify( null, options.manifestBytes.subarray( 0, -1 ),
		options.publicKey, bytes ), false, "The terminating newline is signed too" );
	assert.equal( verify( null, Buffer.concat( [ options.manifestBytes, Buffer.from( " " ) ] ),
		options.publicKey, bytes ), false, "Modified manifest bytes are rejected" );
	assert.equal( verify( null, options.manifestBytes,
		generateKeyPairSync( "ed25519" ).publicKey, bytes ), false );
});

test( "Rejects missing, malformed, unpinned and mismatched signing keys", () => {
	const options = signingFixture();
	for ( const privateKey of [ undefined, "", "not a private key" ] ) {
		assert.throws( () => signManifest({ ...options, privateKey }) );
	}
	assert.throws( () => signManifest({ ...options, keyId: "unknown-key" }) );
	assert.throws( () => signManifest({ ...options, keyId: "bad\nkey" }) );
	assert.throws( () => signManifest({ ...options, trustedKeys: {} }) );
	const different = generateKeyPairSync( "ed25519" ).privateKey
		.export({ type: "pkcs8", format: "pem" });
	assert.throws( () => signManifest({ ...options, privateKey: different }) );
});

test( "Rejects a non-Ed25519 key and invalid manifest bytes", () => {
	const options = signingFixture();
	const other = generateKeyPairSync( "ec", { namedCurve: "prime256v1" } );
	assert.throws( () => signManifest({
		...options,
		privateKey: other.privateKey.export({ type: "pkcs8", format: "pem" }),
		trustedKeys: {
			[ options.keyId ]: other.publicKey.export({ type: "spki", format: "pem" })
		}
	}) );
	for ( const manifestBytes of [ Buffer.alloc( 0 ), Buffer.alloc( 65537 ), null ] ) {
		assert.throws( () => signManifest({ ...options, manifestBytes }) );
	}
});
