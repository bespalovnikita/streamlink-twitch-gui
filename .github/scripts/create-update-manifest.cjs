const { createHash, createPrivateKey, createPublicKey, sign } = require( "node:crypto" );
const fs = require( "node:fs" );
const path = require( "node:path" );
const { gunzipSync } = require( "node:zlib" );

const MAX_UNPACKED = 4 * 1024 * 1024 * 1024;


function zipSize( bytes ) {
	let end = -1;
	for ( let offset = bytes.length - 22;
		offset >= Math.max( 0, bytes.length - 65557 ); offset-- ) {
		if ( bytes.readUInt32LE( offset ) === 0x06054b50
			&& offset + 22 + bytes.readUInt16LE( offset + 20 ) === bytes.length ) {
			end = offset;
			break;
		}
	}
	if ( end < 0 || bytes.readUInt16LE( end + 4 ) || bytes.readUInt16LE( end + 6 ) ) {
		throw new Error( "Unsupported update ZIP directory" );
	}
	const count = bytes.readUInt16LE( end + 10 );
	const length = bytes.readUInt32LE( end + 12 );
	let offset = bytes.readUInt32LE( end + 16 );
	if ( !count || count === 0xffff || count !== bytes.readUInt16LE( end + 8 )
		|| offset + length !== end ) {
		throw new Error( "Unsupported update ZIP size" );
	}
	let total = 0;
	for ( let index = 0; index < count; index++ ) {
		if ( offset + 46 > end || bytes.readUInt32LE( offset ) !== 0x02014b50 ) {
			throw new Error( "Invalid update ZIP directory" );
		}
		const size = bytes.readUInt32LE( offset + 24 );
		if ( size === 0xffffffff || bytes.readUInt16LE( offset + 34 ) ) {
			throw new Error( "Unsupported update ZIP entry" );
		}
		total += size;
		offset += 46 + bytes.readUInt16LE( offset + 28 )
			+ bytes.readUInt16LE( offset + 30 ) + bytes.readUInt16LE( offset + 32 );
		if ( offset > end || total > MAX_UNPACKED ) {
			throw new Error( "Update ZIP exceeds the unpacked size limit" );
		}
	}
	if ( offset !== end || !total ) { throw new Error( "Invalid update ZIP size" ); }
	return total;
}

function unpackedSize( bytes, platform ) {
	if ( platform === "win64" ) { return zipSize( bytes ); }
	// Include tar headers and padding as a conservative staging-space estimate.
	const size = gunzipSync( bytes, { maxOutputLength: MAX_UNPACKED } ).length;
	if ( !size ) { throw new Error( "The update archive is empty" ); }
	return size;
}


function createManifest( {
	directory, identity, repository, expectedCommit, expectedBuildNumber
} ) {
	if (
		!identity || identity.schema !== 1 || identity.channel !== "master"
		|| identity.appName !== "streamlink-twitch-gui" || identity.repository !== repository
		|| !/^[a-f0-9]{40}$/.test( identity.commit ) || identity.commit !== expectedCommit
		|| !Number.isSafeInteger( identity.commitTime ) || identity.commitTime <= 0
		|| !Number.isSafeInteger( identity.buildNumber ) || identity.buildNumber <= 0
		|| identity.buildNumber !== expectedBuildNumber
		|| !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/.test( identity.version )
	) {
		throw new Error( "Update identity does not match the checked CI build" );
	}

	const platforms = {};
	const files = fs.readdirSync( directory );
	for ( const [ platform, suffix ] of [ [ "win64", "-win64.zip" ],
		[ "linux64", "-linux64.tar.gz" ] ] ) {
		const matching = files.filter( name => name.endsWith( suffix ) );
		if ( matching.length !== 1 ) {
			throw new Error( `Expected one ${platform} archive` );
		}
		const name = matching[0];
		if ( !/^streamlink-twitch-gui-[A-Za-z0-9.+_-]+$/.test( name ) ) {
			throw new Error( "Unexpected update archive name" );
		}
		const file = path.join( directory, name );
		const stat = fs.lstatSync( file );
		if ( !stat.isFile() || stat.size === 0 ) {
			throw new Error( "Update archive is not a regular nonempty file" );
		}
		const bytes = fs.readFileSync( file );
		platforms[ platform ] = {
			name,
			size: stat.size,
			unpackedSize: unpackedSize( bytes, platform ),
			sha256: createHash( "sha256" ).update( bytes ).digest( "hex" )
		};
	}

	return {
		schema: 1,
		channel: "master",
		repository,
		commit: identity.commit,
		commitTime: identity.commitTime,
		buildNumber: identity.buildNumber,
		version: identity.version,
		platforms
	};
}

function signManifest( { manifestBytes, privateKey, keyId, trustedKeys } ) {
	if ( !Buffer.isBuffer( manifestBytes ) || !manifestBytes.length
		|| manifestBytes.length > 64 * 1024 || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test( keyId || "" )
		|| !trustedKeys || !Object.prototype.hasOwnProperty.call( trustedKeys, keyId )
		|| typeof privateKey !== "string" || !privateKey.trim() ) {
		throw new Error( "Update signing key is missing or not trusted" );
	}
	try {
		const secret = createPrivateKey( privateKey );
		const trusted = createPublicKey( trustedKeys[ keyId ] );
		if ( secret.asymmetricKeyType !== "ed25519" || trusted.asymmetricKeyType !== "ed25519"
			|| !createPublicKey( secret ).export({ type: "spki", format: "der" })
				.equals( trusted.export({ type: "spki", format: "der" }) ) ) {
			throw new Error();
		}
		return {
			schema: 1, algorithm: "Ed25519", keyId,
			signatureBase64: sign( null, manifestBytes, secret ).toString( "base64" )
		};
	} catch ( error ) {
		// Crypto parser errors can include key material; expose only a fixed message.
		throw new Error( "Update signing key does not match the trusted Ed25519 key" );
	}
}

module.exports = { createManifest, signManifest };

if ( require.main === module ) {
	const directory = path.resolve( "dist" );
	const config = JSON.parse( fs.readFileSync( "src/config/update.json", "utf8" ) );
	const identity = JSON.parse( fs.readFileSync( "work/windows-app/build-info.json", "utf8" ) );
	const manifest = createManifest({
		directory,
		identity,
		repository: process.env.GH_REPO,
		expectedCommit: process.env.GITHUB_SHA,
		expectedBuildNumber: Number( process.env.GITHUB_RUN_NUMBER )
	});
	const manifestBytes = Buffer.from( `${JSON.stringify( manifest )}\n` );
	const signature = signManifest({
		manifestBytes, privateKey: process.env.UPDATER_ED25519_PRIVATE_KEY,
		keyId: config.signingKeyId, trustedKeys: config.trustedKeys
	});
	fs.writeFileSync( path.join( directory, "update.json" ), manifestBytes );
	fs.writeFileSync(
		path.join( directory, "update.json.sig" ), `${JSON.stringify( signature )}\n`
	);
}
