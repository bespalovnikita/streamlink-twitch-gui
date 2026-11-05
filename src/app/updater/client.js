const https = require( "node:https" );
const fs = require( "node:fs" );
const path = require( "node:path" );
const { createHash, randomUUID } = require( "node:crypto" );
const { Transform } = require( "node:stream" );
const { pipeline } = require( "node:stream/promises" );


const MAX_JSON = 4 * 1024 * 1024;
const MAX_ARCHIVE = 2 * 1024 * 1024 * 1024;
const MAX_CANDIDATES = 20;
const COMMIT = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const FILE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._+-]{0,199}$/;
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[a-z0-9.-]+)?(?:\+[a-z0-9.-]+)?$/i;
const CDN_HOSTS = new Set([
	"release-assets.githubusercontent.com",
	"objects.githubusercontent.com",
	"github-releases.githubusercontent.com"
]);


function error( code, message, cause ) {
	return Object.assign( new Error( message ), { name: "UpdateError", code, cause } );
}

function aborted() {
	return error( "ABORTED", "Update operation was cancelled" );
}

function assertNotAborted( signal ) {
	if ( signal && signal.aborted ) { throw aborted(); }
}

function validInteger( value, minimum = 1 ) {
	return Number.isSafeInteger( value ) && value >= minimum;
}

function validVersion( version ) {
	if ( typeof version !== "string" || version.length > 100 || !VERSION.test( version ) ) {
		return false;
	}
	const [ release, build ] = version.split( "+" );
	const identifiers = release.slice( release.indexOf( "-" ) + 1 ).split( "." );
	return ( build === undefined || build.split( "." ).every( Boolean ) )
		&& ( !release.includes( "-" ) || identifiers.every( value => value
			&& ( !/^\d+$/.test( value ) || value === "0" || value[0] !== "0" ) ) );
}

function validRepository( repository ) {
	return typeof repository === "string"
		&& /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*\/[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test( repository );
}

function assetPath( repository, tag, name ) {
	return `/${repository}/releases/download/${tag}/${name}`;
}

function validateUrl( input, policy ) {
	let url;
	try { url = new URL( input ); } catch ( cause ) {
		throw error( "INVALID_RELEASE", "Invalid update URL", cause );
	}
	const secure = url.protocol === "https:" && !url.username && !url.password
		&& ( !url.port || url.port === "443" ) && !url.hash;
	let allowed = false;
	if ( policy.kind === "api" ) {
		allowed = url.hostname === "api.github.com" && url.pathname === policy.pathname;
	} else if ( url.hostname === "github.com" ) {
		try { allowed = decodeURIComponent( url.pathname ) === policy.pathname; } catch ( e ) {}
	} else {
		allowed = policy.redirect && CDN_HOSTS.has( url.hostname );
	}
	if ( !secure || !allowed ) {
		throw error( "INVALID_RELEASE", "Update URL is outside the trusted GitHub location" );
	}
	return url;
}

function openResponse( input, options, redirects = 0 ) {
	assertNotAborted( options.signal );
	const url = validateUrl( input, { ...options.policy, redirect: redirects > 0 } );
	if ( redirects > 5 ) {
		throw error( "NETWORK_ERROR", "Too many update download redirects" );
	}
	return new Promise( ( resolve, reject ) => {
		let request;
		let response;
		let timer;
		const cleanup = () => {
			clearTimeout( timer );
			if ( options.signal ) { options.signal.removeEventListener( "abort", onAbort ); }
		};
		const fail = failure => {
			cleanup();
			if ( response ) { response.destroy( failure ); }
			if ( request ) { request.destroy( failure ); }
			reject( failure );
		};
		const onAbort = () => fail( aborted() );
		try {
			request = ( options.request || https.request )( url, {
				method: "GET",
				headers: {
					"User-Agent": "Streamlink-Twitch-GUI-Updater",
					Accept: options.policy.kind === "api"
						? "application/vnd.github+json" : "application/octet-stream",
					"Accept-Encoding": "identity"
				}
			}, incoming => {
				response = incoming;
				response.on( "error", () => {} );
				response.once( "close", cleanup );
				const status = response.statusCode;
				if ( [ 301, 302, 303, 307, 308 ].includes( status ) ) {
					cleanup();
					response.destroy();
					try {
						const next = new URL( response.headers.location, url ).href;
						resolve( openResponse( next, options, redirects + 1 ) );
					} catch ( cause ) { fail( cause ); }
				} else if ( status !== 200 ) {
					fail( error( "HTTP_ERROR", `GitHub returned HTTP ${status}` ) );
				} else {
					resolve( response );
				}
			});
			request.on( "error", cause => fail( cause.name === "UpdateError" ? cause
				: error( "NETWORK_ERROR", "Could not contact GitHub", cause ) ) );
			timer = setTimeout( () => fail(
				error( "REQUEST_TIMEOUT", "Update request timed out" )
			), options.timeoutMs || 30000 );
			if ( options.signal ) {
				options.signal.addEventListener( "abort", onAbort, { once: true } );
			}
			assertNotAborted( options.signal );
			request.end();
		} catch ( cause ) { fail( cause ); }
	});
}

function contentLength( response ) {
	const value = response.headers[ "content-length" ];
	if ( value === undefined ) { return null; }
	const length = Number( value );
	if ( !validInteger( length, 0 ) ) {
		throw error( "NETWORK_ERROR", "Invalid response content length" );
	}
	return length;
}

async function readJson( url, options ) {
	const response = await openResponse( url, options );
	try {
		const length = contentLength( response );
		if ( length > MAX_JSON ) {
			throw error( "RESPONSE_TOO_LARGE", "Update metadata exceeds the size limit" );
		}
		const chunks = [];
		let received = 0;
		for await ( const chunk of response ) {
			received += chunk.length;
			if ( received > MAX_JSON ) {
				throw error( "RESPONSE_TOO_LARGE", "Update metadata exceeds the size limit" );
			}
			chunks.push( chunk );
		}
		if ( length !== null && received !== length ) {
			throw error( "NETWORK_ERROR", "Update metadata response was truncated" );
		}
		if ( options.expectedSize !== undefined && received !== options.expectedSize ) {
			throw error( "INVALID_RELEASE", "Manifest size does not match its release asset" );
		}
		try { return JSON.parse( Buffer.concat( chunks ).toString( "utf8" ) ); } catch ( cause ) {
			throw error( "INVALID_JSON", "GitHub returned invalid update metadata", cause );
		}
	} catch ( cause ) {
		if ( options.signal && options.signal.aborted ) { throw aborted(); }
		if ( cause.name === "UpdateError" ) { throw cause; }
		throw error( "NETWORK_ERROR", "Could not read update metadata", cause );
	} finally { response.destroy(); }
}

function validateManifest( manifest, tag, repository, platform ) {
	const valid = manifest && manifest.schema === 1 && manifest.channel === "master"
		&& manifest.repository === repository && typeof manifest.commit === "string"
		&& COMMIT.test( manifest.commit )
		&& validInteger( manifest.buildNumber ) && validInteger( manifest.commitTime )
		&& validVersion( manifest.version )
		&& tag === `v${manifest.version}-master.g${manifest.commit}`;
	if ( !valid ) {
		throw error( "INVALID_MANIFEST", "Invalid master update manifest" );
	}
	for ( const key of [ "win64", "linux64" ] ) {
		const entry = manifest.platforms && manifest.platforms[ key ];
		if ( !entry ) {
			throw error( "MISSING_PLATFORM_ASSET", `Update does not include ${key}` );
		}
		const suffix = key === "win64" ? "-win64.zip" : "-linux64.tar.gz";
		if ( typeof entry.name !== "string" || !FILE_NAME.test( entry.name )
			|| !entry.name.startsWith( "streamlink-twitch-gui-" )
			|| !entry.name.endsWith( suffix ) || typeof entry.sha256 !== "string"
			|| !HASH.test( entry.sha256 )
			|| !validInteger( entry.size ) || entry.size > MAX_ARCHIVE ) {
			throw error( "INVALID_MANIFEST", `Invalid ${key} update asset` );
		}
	}
	return manifest.platforms[ platform ];
}

function releaseAsset( release, name, repository ) {
	const assets = release.assets.filter( asset => asset && asset.name === name );
	if ( assets.length !== 1 ) {
		throw error( "INVALID_RELEASE", `Release must contain exactly one ${name}` );
	}
	const asset = assets[0];
	validateUrl( asset.browser_download_url, {
		kind: "asset", pathname: assetPath( repository, release.tag_name, name )
	});
	return asset;
}

function compareBuilds( left, right ) {
	return left.commitTime - right.commitTime || left.buildNumber - right.buildNumber;
}

async function checkForUpdate( options ) {
	const { repository, currentBuild, platform, arch, signal } = options;
	const platformKey = arch === "x64"
		&& ( platform === "win32" ? "win64" : platform === "linux" ? "linux64" : null );
	if ( !platformKey ) {
		throw error( "UNSUPPORTED_PLATFORM", "Automatic updates require Windows or Linux x64" );
	}
	if ( !validRepository( repository ) ) {
		throw error( "INVALID_RELEASE", "Invalid GitHub update repository" );
	}
	if ( !currentBuild || typeof currentBuild.commit !== "string"
		|| !COMMIT.test( currentBuild.commit )
		|| !validInteger( currentBuild.buildNumber, 0 )
		|| !validInteger( currentBuild.commitTime, 0 ) ) {
		throw error( "INVALID_CURRENT_BUILD", "Current build identity is unavailable" );
	}
	const pathname = `/repos/${repository}/releases`;
	const releases = await readJson( `https://api.github.com${pathname}?per_page=100`, {
		...options, policy: { kind: "api", pathname }
	});
	if ( !Array.isArray( releases ) ) {
		throw error( "INVALID_RELEASE", "GitHub did not return a releases list" );
	}
	const candidates = releases.filter( release => release && !release.draft
		&& typeof release.tag_name === "string" && /^v.+-master\.g[a-f0-9]{40}$/.test(
			release.tag_name ) && Number.isFinite( Date.parse( release.published_at ) )
		&& Array.isArray( release.assets )
		&& release.assets.some( asset => asset && asset.name === "update.json" ) )
		.sort( ( a, b ) => Date.parse( b.published_at ) - Date.parse( a.published_at ) )
		.slice( 0, MAX_CANDIDATES );
	let latest = null;
	let validCandidate = false;
	const failures = [];
	for ( const release of candidates ) {
		assertNotAborted( signal );
		if ( release.tag_name.endsWith( `.g${currentBuild.commit}` ) ) {
			validCandidate = true;
			continue;
		}
		try {
			const metadata = releaseAsset( release, "update.json", repository );
			if ( !validInteger( metadata.size ) || metadata.size > MAX_JSON ) {
				throw error( "INVALID_RELEASE", "Invalid update manifest asset size" );
			}
			const manifest = await readJson( metadata.browser_download_url, {
				...options, expectedSize: metadata.size, policy: {
					kind: "asset",
					pathname: assetPath( repository, release.tag_name, "update.json" )
				}
			});
			const entry = validateManifest( manifest, release.tag_name, repository, platformKey );
			for ( const key of [ "win64", "linux64" ] ) {
				const descriptor = manifest.platforms[ key ];
				const published = releaseAsset( release, descriptor.name, repository );
				if ( published.size !== descriptor.size ) {
					throw error( "INVALID_RELEASE",
						"Release asset size does not match its manifest" );
				}
			}
			const asset = releaseAsset( release, entry.name, repository );
			validCandidate = true;
			if ( manifest.commit === currentBuild.commit
				|| compareBuilds( manifest, currentBuild ) <= 0
				|| latest && compareBuilds( manifest, latest.manifest ) <= 0 ) { continue; }
			latest = {
				manifest,
				tag: release.tag_name,
				releaseUrl: `https://github.com/${repository}/releases/tag/${release.tag_name}`,
				versionLabel: `${manifest.version} master (${manifest.commit.slice( 0, 8 )})`,
				asset: { ...entry, url: asset.browser_download_url },
				platform: platformKey
			};
		} catch ( cause ) {
			assertNotAborted( signal );
			if ( cause.code === "ABORTED" ) { throw cause; }
			failures.push( cause );
		}
	}
	if ( !validCandidate && failures.length ) { throw failures[0]; }
	return latest;
}

async function cachedArchive( filename, asset, signal ) {
	let stat;
	try { stat = await fs.promises.stat( filename ); } catch ( cause ) {
		if ( cause.code === "ENOENT" ) { return false; }
		throw cause;
	}
	if ( !stat.isFile() || stat.size !== asset.size ) { return false; }
	const hash = createHash( "sha256" );
	for await ( const chunk of fs.createReadStream( filename ) ) {
		assertNotAborted( signal );
		hash.update( chunk );
	}
	return hash.digest( "hex" ) === asset.sha256;
}

async function downloadUpdate( update, destination, options = {} ) {
	const { signal, onProgress } = options;
	assertNotAborted( signal );
	if ( !update || !update.manifest || typeof destination !== "string" || !destination ) {
		throw error( "INVALID_MANIFEST", "Missing update descriptor or destination" );
	}
	const { manifest, tag, platform, asset } = update;
	if ( ![ "win64", "linux64" ].includes( platform ) || !asset ) {
		throw error( "UNSUPPORTED_PLATFORM", "Missing update platform asset" );
	}
	const entry = validateManifest( manifest, tag, manifest.repository, platform );
	if ( !validRepository( manifest.repository ) || asset.name !== entry.name
		|| asset.sha256 !== entry.sha256 || asset.size !== entry.size ) {
		throw error( "INVALID_MANIFEST", "Download asset does not match the update manifest" );
	}
	const policy = { kind: "asset", pathname: assetPath( manifest.repository, tag, asset.name ) };
	validateUrl( asset.url, policy );
	const filename = path.resolve( destination );
	const progress = received => {
		if ( onProgress ) {
			onProgress({ received, total: asset.size, percent: received * 100 / asset.size });
		}
	};
	if ( await cachedArchive( filename, asset, signal ) ) {
		progress( asset.size );
		return filename;
	}
	await fs.promises.mkdir( path.dirname( filename ), { recursive: true } );
	const partial = `${filename}.${randomUUID()}.part`;
	let response;
	let received = 0;
	try {
		response = await openResponse( asset.url, {
			...options, timeoutMs: options.timeoutMs || 600000, policy
		});
		const length = contentLength( response );
		if ( length !== null && length !== asset.size ) {
			throw error( "DOWNLOAD_TRUNCATED", "Download size does not match the update manifest" );
		}
		const hash = createHash( "sha256" );
		const validate = new Transform({
			transform( chunk, encoding, callback ) {
				try {
					received += chunk.length;
					if ( received > asset.size ) {
						throw error( "DOWNLOAD_TRUNCATED",
							"Downloaded archive exceeds its expected size" );
					}
					hash.update( chunk );
					progress( received );
					callback( null, chunk );
				} catch ( cause ) { callback( cause ); }
			}
		});
		progress( 0 );
		await pipeline( response, validate, fs.createWriteStream( partial, { flags: "wx" } ),
			{ signal } );
		if ( received !== asset.size ) {
			throw error( "DOWNLOAD_TRUNCATED", "Downloaded archive was truncated" );
		}
		if ( hash.digest( "hex" ) !== asset.sha256 ) {
			throw error( "CHECKSUM_MISMATCH", "Downloaded archive checksum does not match" );
		}
		assertNotAborted( signal );
		await fs.promises.rename( partial, filename );
		return filename;
	} catch ( cause ) {
		if ( signal && signal.aborted ) { throw aborted(); }
		if ( cause.name === "UpdateError" ) { throw cause; }
		throw error( "DOWNLOAD_FAILED", "Could not download the update archive", cause );
	} finally {
		if ( response ) { response.destroy(); }
		await fs.promises.rm( partial, { force: true } );
	}
}


module.exports = { checkForUpdate, downloadUpdate };
