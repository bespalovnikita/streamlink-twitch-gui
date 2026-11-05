const { createHash } = require( "node:crypto" );
const fs = require( "node:fs" );
const path = require( "node:path" );


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
		platforms[ platform ] = {
			name,
			size: stat.size,
			sha256: createHash( "sha256" ).update( fs.readFileSync( file ) ).digest( "hex" )
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

module.exports = { createManifest };

if ( require.main === module ) {
	const directory = path.resolve( "dist" );
	const identity = JSON.parse( fs.readFileSync( "work/windows-app/build-info.json", "utf8" ) );
	const manifest = createManifest({
		directory,
		identity,
		repository: process.env.GH_REPO,
		expectedCommit: process.env.GITHUB_SHA,
		expectedBuildNumber: Number( process.env.GITHUB_RUN_NUMBER )
	});
	fs.writeFileSync( path.join( directory, "update.json" ), `${JSON.stringify( manifest )}\n` );
}
