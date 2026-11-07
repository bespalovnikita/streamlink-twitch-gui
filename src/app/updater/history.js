"use strict";

const fs = require( "fs" );
const fsp = fs.promises;
const path = require( "path" );
const { randomBytes } = require( "crypto" );

const HISTORY_LIMIT = 50;
const HISTORY_MAX_BYTES = 64 * 1024;
const HISTORY_TYPES = Object.freeze( [ "check", "download", "install", "startup", "rollback" ] );
const HISTORY_STATUSES = Object.freeze( [
	"started", "available", "current", "succeeded", "failed", "cancelled", "skipped", "blocked"
] );
const ERROR_CODES = new Set( [
	"ABORTED", "CHECKSUM_MISMATCH", "DOWNLOAD_FAILED", "DOWNLOAD_TRUNCATED", "HTTP_ERROR",
	"INVALID_CURRENT_BUILD", "INVALID_JSON", "INVALID_MANIFEST", "INVALID_RELEASE",
	"INVALID_SIGNATURE", "MISSING_PLATFORM_ASSET", "MISSING_SIGNATURE", "NETWORK_ERROR",
	"REQUEST_TIMEOUT", "RESPONSE_TOO_LARGE", "SETTINGS_UNSAVED", "SIGNATURE_REQUIRED",
	"UNKNOWN_ERROR",
	"UNSUPPORTED_PLATFORM", "UNTRUSTED_SIGNING_KEY", "UPDATE_ACK_TIMEOUT", "UPDATE_ARCHIVE",
	"UPDATE_BUSY", "UPDATE_DIAGNOSTICS", "UPDATE_HISTORY", "UPDATE_INTEGRITY", "UPDATE_LOCATION",
	"UPDATE_NOT_WRITABLE", "UPDATE_NO_SPACE", "UPDATE_PACKAGE", "UPDATE_PREVIOUS_FAILURE",
	"UPDATE_PROFILE", "UPDATE_PROFILE_BACKUP", "UPDATE_PROFILE_RESTORE", "UPDATE_ROLLBACK",
	"UPDATE_START", "UPDATE_UNSUPPORTED"
] );
const PLATFORMS = new Set( [ "win32", "linux", "darwin", "freebsd", "openbsd", "sunos", "aix" ] );
const ARCHITECTURES = new Set( [ "x64", "ia32", "arm64", "arm", "ppc", "ppc64", "s390", "s390x" ] );
const COMMIT = /^[a-f0-9]{40}$/;
const VERSION = /^[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}$/;
const TAG = /^v[0-9]{1,6}\.[0-9]{1,6}\.[0-9]{1,6}-master\.g[a-f0-9]{40}$/;
const queues = new Map();

function failure( code ) {
	const error = new Error( code );
	error.code = code;
	return error;
}

function timestamp( value ) {
	return Number.isSafeInteger( value ) && value >= 0 && value <= 8640000000000000;
}

function buildIdentity( value ) {
	const identity = {};
	if ( !value || typeof value !== "object" ) { return identity; }
	if ( typeof value.version === "string" && VERSION.test( value.version ) ) {
		identity.version = value.version;
	}
	if ( typeof value.commit === "string" && COMMIT.test( value.commit ) ) {
		identity.commit = value.commit;
	}
	if ( Number.isSafeInteger( value.buildNumber ) && value.buildNumber > 0 ) {
		identity.buildNumber = value.buildNumber;
	}
	if ( Number.isSafeInteger( value.commitTime ) && value.commitTime > 0
		&& value.commitTime <= 8640000000000 ) {
		identity.commitTime = value.commitTime;
	}
	return identity;
}

function normalizeEvent( value, fallbackAt ) {
	if ( !value || typeof value !== "object" || !HISTORY_TYPES.includes( value.type )
		|| !HISTORY_STATUSES.includes( value.status ) ) { return null; }
	const at = timestamp( value.at ) ? value.at : fallbackAt;
	if ( !timestamp( at ) ) { return null; }
	const event = { type: value.type, status: value.status, at };
	const identity = buildIdentity( value );
	for ( const key of [ "version", "commit", "buildNumber" ] ) {
		if ( identity[ key ] !== undefined ) { event[ key ] = identity[ key ]; }
	}
	if ( typeof value.tag === "string" && TAG.test( value.tag ) ) { event.tag = value.tag; }
	if ( value.code !== undefined && value.code !== null && value.code !== "" ) {
		event.code = ERROR_CODES.has( value.code ) ? value.code : "UNKNOWN_ERROR";
	}
	return event;
}

function normalizeHistory( values ) {
	if ( !Array.isArray( values ) ) { return []; }
	const events = [];
	for ( const value of values ) {
		const event = normalizeEvent( value );
		if ( event ) { events.push( event ); }
		if ( events.length === HISTORY_LIMIT ) { break; }
	}
	return events;
}

async function readStore( filename ) {
	let file;
	try {
		const info = await fsp.lstat( filename );
		if ( !info.isFile() || info.isSymbolicLink() || info.size > HISTORY_MAX_BYTES ) {
			return [];
		}
		file = await fsp.open( filename, fs.constants.O_RDONLY | ( fs.constants.O_NOFOLLOW || 0 ) );
		const opened = await file.stat();
		if ( !opened.isFile() || opened.size > HISTORY_MAX_BYTES ) { return []; }
		const bytes = Buffer.alloc( HISTORY_MAX_BYTES + 1 );
		let offset = 0;
		while ( offset < bytes.length ) {
			const { bytesRead } = await file.read( bytes, offset, bytes.length - offset, offset );
			if ( !bytesRead ) { break; }
			offset += bytesRead;
		}
		if ( offset > HISTORY_MAX_BYTES ) { return []; }
		const document = JSON.parse( bytes.subarray( 0, offset ).toString( "utf8" ) );
		return document && document.schema === 1 ? normalizeHistory( document.events ) : [];
	} catch ( error ) {
		if ( error.code === "ENOENT" || error.code === "ELOOP"
			|| error instanceof SyntaxError ) { return []; }
		throw failure( "UPDATE_HISTORY" );
	} finally {
		if ( file ) { await file.close().catch( () => {} ); }
	}
}

async function atomicWrite( filename, document ) {
	const suffix = [ ".", path.basename( filename ), ".", randomBytes( 8 ).toString( "hex" ),
		".tmp" ].join( "" );
	const temporary = path.join( path.dirname( filename ), suffix );
	let file;
	let created = false;
	try {
		file = await fsp.open( temporary, "wx", 0o600 );
		created = true;
		await file.writeFile( [ JSON.stringify( document, null, 2 ), "" ].join( "\n" ), "utf8" );
		await file.sync();
		await file.close();
		file = null;
		await fsp.rename( temporary, filename );
	} finally {
		if ( file ) { await file.close().catch( () => {} ); }
		if ( created ) { await fsp.rm( temporary, { force: true } ).catch( () => {} ); }
	}
}

function enqueue( filename, action ) {
	const previous = queues.get( filename ) || Promise.resolve();
	const next = previous.catch( () => {} ).then( action );
	queues.set( filename, next );
	const cleanup = () => {
		if ( queues.get( filename ) === next ) { queues.delete( filename ); }
	};
	next.then( cleanup, cleanup );
	return next;
}

async function readHistory( filename ) {
	const resolved = path.resolve( filename );
	const pending = queues.get( resolved );
	if ( pending ) { await pending.catch( () => {} ); }
	return readStore( resolved );
}

function appendHistory( filename, value ) {
	const event = normalizeEvent( value, Date.now() );
	if ( !event ) { return Promise.reject( failure( "UPDATE_HISTORY" ) ); }
	const resolved = path.resolve( filename );
	return enqueue( resolved, async () => {
		try {
			const info = await fsp.lstat( resolved ).catch( error => {
				if ( error.code !== "ENOENT" ) { throw error; }
				return null;
			} );
			if ( info && ( !info.isFile() || info.isSymbolicLink() ) ) {
				throw failure( "UPDATE_HISTORY" );
			}
			const events = [ event, ...await readStore( resolved ) ].slice( 0, HISTORY_LIMIT );
			await atomicWrite( resolved, { schema: 1, events } );
			return events;
		} catch ( error ) { throw failure( "UPDATE_HISTORY" ); }
	} );
}

function createDiagnostics( { history = [], currentBuild = {}, platform, arch,
	now = Date.now() } = {} ) {
	const exportedAt = new Date( timestamp( now ) ? now : Date.now() ).toISOString();
	const events = normalizeHistory( history );
	const checked = events.find( event => event.type === "check" );
	return {
		schema: 1,
		application: "streamlink-twitch-gui",
		exportedAt,
		platform: PLATFORMS.has( platform ) ? platform : "unknown",
		arch: ARCHITECTURES.has( arch ) ? arch : "unknown",
		currentBuild: buildIdentity( currentBuild ),
		lastCheckAt: checked ? checked.at : null,
		history: events
	};
}

async function exportDiagnostics( filename, options ) {
	const document = createDiagnostics( options );
	try { await atomicWrite( path.resolve( filename ), document ); } catch ( error ) {
		throw failure( "UPDATE_DIAGNOSTICS" );
	}
	return document;
}

module.exports = {
	HISTORY_LIMIT, HISTORY_MAX_BYTES, HISTORY_TYPES, HISTORY_STATUSES,
	readHistory, appendHistory, createDiagnostics, exportDiagnostics
};
