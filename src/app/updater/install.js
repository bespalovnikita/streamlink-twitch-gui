"use strict";

const fs = require( "fs" );
const fsp = fs.promises;
const path = require( "path" );
const crypto = require( "crypto" );
const zlib = require( "zlib" );
const { spawn } = require( "child_process" );

const APP = "streamlink-twitch-gui";
const SHA = /^[a-f0-9]{40}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const MAX_EXPANDED = 4 * 1024 * 1024 * 1024;

function jobBase( token ) {
	return `.stgui-${token.slice( 0, 16 )}`;
}

function failure( code, cause ) {
	const error = new Error( code );
	error.code = code;
	if ( cause ) { error.cause = cause; }
	return error;
}

function inside( parent, child ) {
	const relative = path.relative( parent, child );
	return !relative || ( !relative.startsWith( `..${path.sep}` )
		&& relative !== ".." && !path.isAbsolute( relative ) );
}

async function canonical( input ) {
	const absolute = path.resolve( input );
	try { return await fsp.realpath( absolute ); } catch ( error ) {
		if ( error.code !== "ENOENT" ) { throw error; }
		const parent = path.dirname( absolute );
		if ( parent === absolute ) { throw error; }
		return path.join( await canonical( parent ), path.basename( absolute ) );
	}
}

async function rejectLinkedAncestors( input ) {
	let current = path.resolve( input );
	while ( current ) {
		if ( ( await fsp.lstat( current ) ).isSymbolicLink() ) {
			throw failure( "UPDATE_LOCATION" );
		}
		const parent = path.dirname( current );
		if ( parent === current ) { return; }
		current = parent;
	}
}

async function checkLocation( installDir, profileDir, platform ) {
	if ( typeof installDir !== "string" || typeof profileDir !== "string" ) {
		throw failure( "UPDATE_LOCATION" );
	}
	if ( platform === "win32" ) { await rejectLinkedAncestors( installDir ); }
	const install = await canonical( installDir );
	const profile = await canonical( profileDir );
	const resolved = path.resolve( installDir );
	// Windows realpath also expands harmless 8.3 aliases; reparse points were checked above.
	const matches = platform === "win32" || install === resolved;
	if ( !matches || path.dirname( install ) === install ) {
		throw failure( "UPDATE_LOCATION" );
	}
	if ( inside( install, profile ) || inside( profile, install )
		|| inside( install, path.resolve( profileDir ) ) ) {
		throw failure( "UPDATE_PROFILE" );
	}
	const protectedPaths = platform === "win32"
		? [ process.env.SystemRoot, process.env.ProgramFiles, process.env["ProgramFiles(x86)"] ]
		: [ "/bin", "/sbin", "/etc", "/usr", "/boot", "/dev", "/proc", "/sys" ];
	const protectedLocation = protectedPaths.filter( Boolean )
		.some( entry => inside( path.resolve( entry ), install ) );
	if ( protectedLocation ) {
		throw failure( "UPDATE_LOCATION" );
	}
	try {
		if ( !( await fsp.stat( install ) ).isDirectory() ) { throw new Error( "directory" ); }
		await fsp.access( install, fs.constants.W_OK );
		await fsp.access( path.dirname( install ), fs.constants.W_OK );
	} catch ( error ) { throw failure( "UPDATE_NOT_WRITABLE", error ); }
	return { install, profile };
}

function command( executable, args ) {
	return new Promise( ( resolve, reject ) => {
		const child = spawn( executable, args, { windowsHide: true, stdio: "ignore" } );
		child.once( "error", reject );
		child.once( "exit", code => code === 0 ? resolve() : reject( new Error( "helper" ) ) );
	});
}

async function hash( filename ) {
	const digest = crypto.createHash( "sha256" );
	for await ( const chunk of fs.createReadStream( filename ) ) { digest.update( chunk ); }
	return digest.digest( "hex" );
}

function archiveName( name ) {
	const unsafe = typeof name !== "string" || /[\\:]/.test( name )
		|| Array.from( name ).some( char => char.charCodeAt( 0 ) < 32 || char === "\x7f" );
	if ( unsafe ) {
		throw failure( "UPDATE_ARCHIVE" );
	}
	const parts = name.replace( /\/$/, "" ).split( "/" );
	if ( parts.shift() !== APP || parts.some( part => !part || part === "." || part === ".." ) ) {
		throw failure( "UPDATE_ARCHIVE" );
	}
	return parts.join( "/" );
}

function tarNumber( header, start, length ) {
	const value = header.subarray( start, start + length )
		.toString( "ascii" ).replace( /\0.*$/, "" );
	if ( !/^[ 0-7]*$/.test( value ) ) { throw failure( "UPDATE_ARCHIVE" ); }
	return parseInt( value.trim() || "0", 8 );
}

function tarString( header, start, length ) {
	return header.subarray( start, start + length ).toString( "utf8" ).replace( /\0.*$/, "" );
}

function paxPath( data ) {
	let offset = 0;
	let result;
	while ( offset < data.length ) {
		const space = data.indexOf( 32, offset );
		const length = Number( data.subarray( offset, space ).toString() );
		if ( space < 0 || !Number.isSafeInteger( length ) || length < 4
			|| offset + length > data.length || data[offset + length - 1] !== 10 ) {
			throw failure( "UPDATE_ARCHIVE" );
		}
		const entry = data.subarray( space + 1, offset + length - 1 ).toString( "utf8" );
		const equal = entry.indexOf( "=" );
		const key = entry.slice( 0, equal );
		if ( equal < 1 || ![ "path", "mtime", "atime", "ctime" ].includes( key ) ) {
			throw failure( "UPDATE_ARCHIVE" );
		}
		if ( key === "path" ) { result = entry.slice( equal + 1 ); }
		offset += length;
	}
	return result;
}

async function drainTar( iterator, expanded ) {
	for await ( const chunk of { [Symbol.asyncIterator]: () => iterator } ) {
		expanded += chunk.length;
		if ( expanded > MAX_EXPANDED || chunk.some( byte => byte !== 0 ) ) {
			throw failure( "UPDATE_ARCHIVE" );
		}
	}
}

// Inspect raw headers before invoking tar: links and extensions cannot change extraction paths.
async function inspectTar( filename ) {
	const source = fs.createReadStream( filename );
	const stream = source.pipe( zlib.createGunzip() );
	source.once( "error", error => stream.destroy( error ) );
	const iterator = stream[Symbol.asyncIterator]();
	let pending = Buffer.alloc( 0 );
	let expanded = 0;
	async function read( length, retain = true ) {
		const parts = [];
		while ( length ) {
			if ( !pending.length ) {
				const chunk = await iterator.next();
				if ( chunk.done ) { throw failure( "UPDATE_ARCHIVE" ); }
				pending = chunk.value;
				expanded += pending.length;
				if ( expanded > MAX_EXPANDED ) { throw failure( "UPDATE_ARCHIVE" ); }
			}
			const size = Math.min( length, pending.length );
			if ( retain ) { parts.push( pending.subarray( 0, size ) ); }
			pending = pending.subarray( size );
			length -= size;
		}
		return retain ? Buffer.concat( parts ) : null;
	}
	const seen = new Set();
	let nextName;
	try {
		for ( let count = 0; count < 100000; count++ ) {
			const header = await read( 512 );
			if ( header.every( byte => byte === 0 ) ) {
				if ( nextName || !seen.size ) { throw failure( "UPDATE_ARCHIVE" ); }
				if ( pending.some( byte => byte !== 0 ) ) { throw failure( "UPDATE_ARCHIVE" ); }
				await drainTar( iterator, expanded );
				return;
			}
			const expected = tarNumber( header, 148, 8 );
			const sum = header.reduce( ( total, byte, index ) => total
				+ ( index >= 148 && index < 156 ? 32 : byte ), 0 );
			if ( expected !== sum ) { throw failure( "UPDATE_ARCHIVE" ); }
			const size = tarNumber( header, 124, 12 );
			const type = String.fromCharCode( header[156] || 48 );
			const prefix = tarString( header, 257, 6 ) === "ustar"
				? tarString( header, 345, 155 ) : "";
			const headerName = `${prefix ? `${prefix}/` : ""}${tarString( header, 0, 100 )}`;
			const name = nextName || headerName;
			if ( type === "L" || type === "x" ) {
				if ( size > 65536 || nextName ) { throw failure( "UPDATE_ARCHIVE" ); }
				const data = await read( size );
				nextName = type === "L"
					? data.toString( "utf8" ).replace( /\0$/, "" ) : paxPath( data );
				if ( nextName ) { archiveName( nextName ); }
			} else {
				nextName = undefined;
				const relative = archiveName( name );
				if ( ![ "0", "5" ].includes( type ) || ( type === "5" && size !== 0 )
					|| ( !relative && type !== "5" ) || seen.has( relative ) ) {
					throw failure( "UPDATE_ARCHIVE" );
				}
				seen.add( relative );
				await read( size, false );
			}
			await read( ( 512 - size % 512 ) % 512, false );
		}
		throw failure( "UPDATE_ARCHIVE" );
	} finally { stream.destroy(); source.destroy(); }
}

async function checkPackage( directory, commit, platform ) {
	try {
		const metadataPath = path.join( directory, "build-info.json" );
		const packagePath = path.join( directory, "package.json" );
		const metadata = JSON.parse( await fsp.readFile( metadataPath ) );
		const manifest = JSON.parse( await fsp.readFile( packagePath ) );
		const name = APP + ( platform === "win32" ? ".exe" : "" );
		const executable = path.join( directory, name );
		for ( const filename of [ metadataPath, packagePath, executable ] ) {
			if ( !( await fsp.lstat( filename ) ).isFile() ) { throw new Error( "file" ); }
		}
		if ( metadata.commit !== commit || manifest.name !== APP ) {
			throw new Error( "identity" );
		}
		const file = await fsp.open( executable, "r" );
		const bytes = Buffer.alloc( 64 );
		try {
			await file.read( bytes, 0, bytes.length, 0 );
			if ( platform === "win32" ) {
				const pe = Buffer.alloc( 6 );
				await file.read( pe, 0, pe.length, bytes.readUInt32LE( 60 ) );
				if ( bytes.readUInt16LE( 0 ) !== 0x5a4d || pe.readUInt32LE( 0 ) !== 0x4550
					|| pe.readUInt16LE( 4 ) !== 0x8664 ) { throw new Error( "architecture" ); }
			}
		} finally { await file.close(); }
		if ( platform === "linux" && ( bytes.toString( "hex", 0, 4 ) !== "7f454c46"
			|| bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE( 18 ) !== 62 ) ) {
			throw new Error( "architecture" );
		}
		if ( platform === "linux" ) { await fsp.access( executable, fs.constants.X_OK ); }
	} catch ( error ) { throw failure( "UPDATE_PACKAGE", error ); }
}

async function prepareUpdate( options ) {
	const { archivePath, update, installDir, profileDir,
		platform = process.platform, arch = "x64", helpersDir
	} = options;
	if ( ![ "linux", "win32" ].includes( platform ) || arch !== "x64"
		|| platform !== process.platform || process.arch !== "x64" ) {
		throw failure( "UPDATE_UNSUPPORTED" );
	}
	const manifest = update && update.manifest;
	const key = platform === "win32" ? "win64" : "linux64";
	const asset = manifest && manifest.platforms && manifest.platforms[key];
	if ( !manifest || manifest.schema !== 1 || manifest.channel !== "master"
		|| !SHA.test( manifest.commit ) || !asset || !/^[a-f0-9]{64}$/.test( asset.sha256 )
		|| !Number.isSafeInteger( asset.size ) || asset.size < 1 ) {
		throw failure( "UPDATE_INTEGRITY" );
	}
	const { install } = await checkLocation( installDir, profileDir, platform );
	const token = crypto.randomBytes( 32 ).toString( "hex" );
	const parent = path.dirname( install );
	const base = jobBase( token );
	const jobDir = path.join( parent, base );
	const job = {
		schema: 1, jobDir, jobFile: path.join( jobDir, "job.json" ), installDir: install,
		stageDir: path.join( parent, `${base}-stage` ),
		backupDir: path.join( parent, `${base}-backup` ),
		helperPath: path.join( jobDir, platform === "win32" ? "install.ps1" : "install.sh" ),
		platform, arch, commit: manifest.commit, token,
		ackFile: path.join( jobDir, "healthy" ), readyFile: path.join( jobDir, "ready" ),
		statusFile: path.join( jobDir, "status.json" ),
		executable: APP + ( platform === "win32" ? ".exe" : "" ),
		archivePath: path.join( jobDir, platform === "win32" ? "update.zip" : "update.tar.gz" ),
		archiveSha256: asset.sha256, archiveSize: asset.size, timeoutMs: 60000,
		parentPid: 0, args: []
	};
	let created = false;
	let stageOwned = false;
	try {
		await fsp.mkdir( jobDir, { mode: 0o700 } );
		created = true;
		if ( fs.existsSync( job.stageDir ) || fs.existsSync( job.backupDir ) ) {
			throw failure( "UPDATE_BUSY" );
		}
		stageOwned = true;
		if ( platform !== "win32" ) { await fsp.mkdir( job.stageDir, { mode: 0o700 } ); }
		await fsp.copyFile( archivePath, job.archivePath, fs.constants.COPYFILE_EXCL );
		if ( ( await fsp.stat( job.archivePath ) ).size !== asset.size
			|| await hash( job.archivePath ) !== asset.sha256 ) {
			throw failure( "UPDATE_INTEGRITY" );
		}
		const helperDirectory = helpersDir || path.join( install, "updater" );
		const sourceHelper = path.join( helperDirectory, path.basename( job.helperPath ) );
		await fsp.copyFile( sourceHelper, job.helperPath );
		await fsp.writeFile( job.jobFile, JSON.stringify( job ), { mode: 0o600 } );
		if ( platform === "win32" ) {
			await command( "powershell.exe", [ "-NoProfile", "-NonInteractive",
				"-ExecutionPolicy", "Bypass", "-File", job.helperPath, "-JobFile", job.jobFile,
				"-Prepare" ] );
		} else {
			await inspectTar( job.archivePath );
			await command( "tar", [ "-xzf", job.archivePath, "-C", job.stageDir,
				"--strip-components=1", "--no-same-owner", "--no-same-permissions" ] );
		}
		await checkPackage( job.stageDir, job.commit, platform );
		return job;
	} catch ( error ) {
		let helperCode;
		try {
			const status = JSON.parse( await fsp.readFile( job.statusFile, "utf8" ) );
			if ( /^UPDATE_[A-Z_]+$/.test( status.code ) ) { helperCode = status.code; }
		} catch ( ignored ) {}
		if ( stageOwned ) { await fsp.rm( job.stageDir, { recursive: true, force: true } ); }
		if ( created ) { await fsp.rm( jobDir, { recursive: true, force: true } ); }
		if ( helperCode ) { throw failure( helperCode, error ); }
		if ( error.code === "EEXIST" ) { throw failure( "UPDATE_BUSY", error ); }
		if ( [ "EACCES", "EPERM", "EROFS" ].includes( error.code ) ) {
			throw failure( "UPDATE_NOT_WRITABLE", error );
		}
		throw error.code && error.code.startsWith( "UPDATE_" )
			? error : failure( "UPDATE_ARCHIVE", error );
	}
}

async function startInstall( job, { parentPid = process.pid, args = [] } = {} ) {
	if ( !job || !TOKEN.test( job.token ) || !Number.isSafeInteger( parentPid ) || parentPid < 2
		|| !Array.isArray( args )
		|| args.some( arg => typeof arg !== "string" || arg.includes( "\0" ) ) ) {
		throw failure( "UPDATE_START" );
	}
	await verifyJob( job );
	if ( fs.existsSync( job.readyFile ) ) { throw failure( "UPDATE_BUSY" ); }
	if ( await fsp.realpath( job.stageDir ) !== job.stageDir ) {
		throw failure( "UPDATE_LOCATION" );
	}
	if ( ( await fsp.stat( job.archivePath ) ).size !== job.archiveSize
		|| await hash( job.archivePath ) !== job.archiveSha256 ) {
		throw failure( "UPDATE_INTEGRITY" );
	}
	await checkPackage( job.stageDir, job.commit, job.platform );
	try { process.kill( parentPid, 0 ); } catch ( error ) {
		throw failure( "UPDATE_START", error );
	}
	const current = { ...job, parentPid, args };
	try {
		const startedFile = path.join( job.jobDir, "started" );
		await fsp.writeFile( startedFile, job.token, { flag: "wx" } );
	} catch ( error ) { throw failure( "UPDATE_BUSY", error ); }
	await fsp.writeFile( job.jobFile, JSON.stringify( current ), { mode: 0o600 } );
	const executable = job.platform === "win32" ? "powershell.exe" : "bash";
	const parameters = job.platform === "win32"
		? [ "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
			job.helperPath, "-JobFile", job.jobFile ]
		: [ job.helperPath, job.jobFile, job.installDir, job.stageDir, job.backupDir,
			job.jobDir, job.token, String( parentPid ), String( job.timeoutMs ),
			String( job.renameTimeoutMs || 30000 ), ...args ];
	let child;
	try {
		const log = await fsp.open( path.join( job.jobDir, "helper.log" ), "a", 0o600 );
		try {
			child = spawn( executable, parameters, {
				detached: true, windowsHide: true,
				stdio: [ "ignore", log.fd, log.fd ], cwd: job.jobDir
			});
		} finally { await log.close(); }
		let spawnError;
		child.once( "error", error => { spawnError = error; } );
		const timeout = Math.max( 100, Math.min( 30000, job.handshakeTimeoutMs || 10000 ) );
		for ( let attempt = 0; attempt < timeout / 100; attempt++ ) {
			if ( spawnError || child.exitCode !== null || child.signalCode !== null ) {
				throw failure( "UPDATE_START", spawnError );
			}
			if ( await helperReady( job ) ) { child.unref(); return; }
			await new Promise( resolve => setTimeout( resolve, 100 ) );
		}
		throw failure( "UPDATE_START" );
	} catch ( error ) {
		await stopHelper( child );
		await fsp.rm( path.join( job.jobDir, "started" ), { force: true } );
		await fsp.rm( job.readyFile, { force: true } );
		throw failure( "UPDATE_START", error );
	}
}

async function helperReady( job ) {
	try { return await fsp.readFile( job.readyFile, "utf8" ) === job.token; } catch ( error ) {
		if ( error.code !== "ENOENT" ) { throw error; }
		return false;
	}
}

async function stopHelper( child ) {
	if ( !child || !child.pid ) { return; }
	child.kill( "SIGTERM" );
	for ( let attempt = 0; attempt < 30; attempt++ ) {
		if ( child.exitCode !== null || child.signalCode !== null ) { return; }
		if ( attempt === 10 ) { child.kill( "SIGKILL" ); }
		await new Promise( resolve => setTimeout( resolve, 100 ) );
	}
	throw failure( "UPDATE_BUSY" );
}

async function verifyJob( job ) {
	if ( !job || !TOKEN.test( job.token ) || !SHA.test( job.commit ) ) {
		throw failure( "UPDATE_LOCATION" );
	}
	const install = await fsp.realpath( job.installDir );
	const base = jobBase( job.token );
	const directory = path.join( path.dirname( install ), base );
	const helper = path.join( directory, job.platform === "win32" ? "install.ps1" : "install.sh" );
	const archiveName = job.platform === "win32" ? "update.zip" : "update.tar.gz";
	const archive = path.join( directory, archiveName );
	if ( job.installDir !== install || job.jobDir !== directory
		|| ![ "win32", "linux" ].includes( job.platform ) || job.arch !== "x64"
		|| job.helperPath !== helper || job.archivePath !== archive
		|| job.stageDir !== `${directory}-stage` || job.backupDir !== `${directory}-backup`
		|| job.jobFile !== path.join( directory, "job.json" )
		|| job.readyFile !== path.join( directory, "ready" )
		|| job.ackFile !== path.join( directory, "healthy" )
		|| job.statusFile !== path.join( directory, "status.json" )
		|| await fsp.realpath( directory ) !== directory ) {
		throw failure( "UPDATE_LOCATION" );
	}
	const stored = JSON.parse( await fsp.readFile( job.jobFile, "utf8" ) );
	if ( stored.token !== job.token || stored.commit !== job.commit ) {
		throw failure( "UPDATE_LOCATION" );
	}
	return directory;
}

async function discardUpdate( job ) {
	try {
		const directory = await verifyJob( job );
		if ( fs.existsSync( path.join( directory, "started" ) )
			|| fs.existsSync( job.readyFile ) || fs.existsSync( job.backupDir ) ) { return false; }
		if ( fs.existsSync( job.stageDir )
			&& await fsp.realpath( job.stageDir ) !== job.stageDir ) { return false; }
		await fsp.rm( job.stageDir, { recursive: true, force: true } );
		await fsp.rm( directory, { recursive: true, force: true } );
		return true;
	} catch ( error ) { return false; }
}

async function cleanupPrevious( current ) {
	const parent = path.dirname( current.installDir );
	const entries = await fsp.readdir( parent );
	for ( const entry of entries ) {
		if ( !/^\.stgui-[a-f0-9]{16}$/.test( entry ) ) { continue; }
		const directory = path.join( parent, entry );
		if ( directory === current.jobDir ) { continue; }
		try { await cleanupPreviousJob( directory, current.installDir ); } catch ( error ) {}
	}
}

async function cleanupPreviousJob( directory, installDir ) {
	const previous = JSON.parse( await fsp.readFile( path.join( directory, "job.json" ) ) );
	if ( previous.installDir !== installDir || previous.jobDir !== directory ) { return; }
	await verifyJob( previous );
	const status = JSON.parse( await fsp.readFile( previous.statusFile, "utf8" ) );
	if ( ![ "succeeded", "rolled-back", "failed" ].includes( status.state ) ) { return; }
	for ( const target of [ previous.backupDir, previous.stageDir, directory ] ) {
		if ( !fs.existsSync( target ) ) { continue; }
		if ( await fsp.realpath( target ) !== target ) { return; }
	}
	await fsp.rm( previous.backupDir, { recursive: true, force: true } );
	await fsp.rm( previous.stageDir, { recursive: true, force: true } );
	await fsp.rm( directory, { recursive: true, force: true } );
}

async function readRollbackStatus( { installDir,
	jobFile = process.env.STGUI_UPDATE_ROLLBACK } ) {
	delete process.env.STGUI_UPDATE_ROLLBACK;
	if ( !jobFile ) { return null; }
	try {
		const job = JSON.parse( await fsp.readFile( jobFile, "utf8" ) );
		await verifyJob( job );
		if ( await fsp.realpath( installDir ) !== job.installDir
			|| path.resolve( jobFile ) !== job.jobFile ) { return null; }
		const status = JSON.parse( await fsp.readFile( job.statusFile, "utf8" ) );
		return status.state === "rolled-back" ? status : null;
	} catch ( error ) { return null; }
}

async function confirmStartup( { installDir, identity,
	jobFile = process.env.STGUI_UPDATE_JOB, token = process.env.STGUI_UPDATE_TOKEN } ) {
	if ( !jobFile || !token ) { return false; }
	try {
		const job = JSON.parse( await fsp.readFile( jobFile, "utf8" ) );
		await verifyJob( job );
		if ( job.schema !== 1 || !TOKEN.test( token ) || job.token !== token
			|| !identity || job.commit !== identity.commit
			|| await fsp.realpath( installDir ) !== job.installDir
			|| path.resolve( jobFile ) !== path.join( job.jobDir, "job.json" )
			|| inside( job.installDir, job.jobDir )
			|| job.ackFile !== path.join( job.jobDir, "healthy" ) ) { return false; }
		if ( await fsp.readFile( job.readyFile, "utf8" ) !== token ) { return false; }
		await checkPackage( job.installDir, job.commit, job.platform );
		await fsp.writeFile( job.ackFile, token, { mode: 0o600, flag: "wx" } );
		try { await cleanupPrevious( job ); } catch ( ignored ) {}
		delete process.env.STGUI_UPDATE_JOB;
		delete process.env.STGUI_UPDATE_TOKEN;
		return true;
	} catch ( error ) { return false; }
}

module.exports = { prepareUpdate, startInstall, confirmStartup, discardUpdate, readRollbackStatus };
