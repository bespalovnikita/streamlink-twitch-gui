"use strict";

const fs = require( "fs" );
const path = require( "path" );
const crypto = require( "crypto" );
const { spawn } = require( "child_process" );


const KEYS = [ "app", "settings", "auth", "window", "versioncheck", "channelsettings", "search" ];
const SHA = /^[a-f0-9]{40}$/;
const HASH = /^[a-f0-9]{64}$/;
const NAME = /^profile-v1-(\d{13})-([a-f0-9]{16})\.json$/;
const MAX_BYTES = 16 * 1024 * 1024;
const ACL_SCRIPT = `
$ErrorActionPreference = 'Stop'
$target = $env:STGUI_BACKUP_ACL_PATH
$item = Get-Item -LiteralPath $target -Force
if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 1 }
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User
$system = New-Object Security.Principal.SecurityIdentifier('S-1-5-18')
$inherit = [Security.AccessControl.InheritanceFlags]::None
if ($item.PSIsContainer) {
	$acl = New-Object Security.AccessControl.DirectorySecurity
	$inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit, ObjectInherit'
} else {
	$acl = New-Object Security.AccessControl.FileSecurity
}
$acl.SetOwner($user)
$acl.SetAccessRuleProtection($true, $false)
foreach ($sid in @($user, $system)) {
	$rule = New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl',
		$inherit, [Security.AccessControl.PropagationFlags]::None, 'Allow')
	$acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $target -AclObject $acl
`;

function failure() {
	const error = new Error( "UPDATE_PROFILE_BACKUP" );
	error.code = "UPDATE_PROFILE_BACKUP";
	return error;
}

function samePath( first, second ) {
	return typeof first === "string" && typeof second === "string"
		&& ( process.platform === "win32"
			? first.toLowerCase() === second.toLowerCase() : first === second );
}

function regular( filename, directory = false ) {
	const stat = fs.lstatSync( filename );
	if ( stat.isSymbolicLink() || ( directory ? !stat.isDirectory() : !stat.isFile() )
		|| ( !directory && stat.nlink !== 1 ) ) { throw failure(); }
	return stat;
}

function directory( filename ) {
	if ( typeof filename !== "string" || !path.isAbsolute( filename ) ) { throw failure(); }
	let ancestor = path.resolve( filename );
	while ( ancestor ) {
		if ( fs.lstatSync( ancestor ).isSymbolicLink() ) { throw failure(); }
		const parent = path.dirname( ancestor );
		if ( parent === ancestor ) { break; }
		ancestor = parent;
	}
	const canonical = fs.realpathSync.native( filename );
	regular( canonical, true );
	return canonical;
}

function validateValues( values ) {
	if ( !values || typeof values !== "object" || Array.isArray( values )
		|| Object.keys( values ).length !== KEYS.length
		|| KEYS.some( key => !Object.prototype.hasOwnProperty.call( values, key )
			|| ( values[key] !== null && typeof values[key] !== "string" ) ) ) { throw failure(); }
	return values;
}

function readValues( storage ) {
	if ( !storage || typeof storage.getItem !== "function" ) { throw failure(); }
	const values = {};
	for ( const key of KEYS ) { values[key] = storage.getItem( key ); }
	return validateValues( values );
}

function privateWindows( filename ) {
	const executable = path.join( process.env.SystemRoot,
		"System32", "WindowsPowerShell", "v1.0", "powershell.exe" );
	return new Promise( ( resolve, reject ) => {
		const child = spawn( executable, [ "-NoProfile", "-NonInteractive", "-EncodedCommand",
			Buffer.from( ACL_SCRIPT, "utf16le" ).toString( "base64" ) ], {
				windowsHide: true, stdio: "ignore",
				env: { ...process.env, STGUI_BACKUP_ACL_PATH: filename }
			});
		const timer = setTimeout( () => {
			try { child.kill(); } catch ( ignored ) {}
			reject( failure() );
		}, 15000 );
		child.once( "error", () => { clearTimeout( timer ); reject( failure() ); } );
		child.once( "exit", code => {
			clearTimeout( timer );
			if ( code === 0 ) { resolve(); } else { reject( failure() ); }
		});
	});
}

async function makePrivate( filename, isDirectory ) {
	regular( filename, isDirectory );
	if ( process.platform === "win32" ) {
		await privateWindows( filename );
	} else {
		fs.chmodSync( filename, isDirectory ? 0o700 : 0o600 );
	}
	regular( filename, isDirectory );
}

function readSnapshot( filename, profileDir ) {
	const match = NAME.exec( path.basename( filename ) );
	if ( !match || !samePath( fs.realpathSync.native( filename ), filename ) ) { throw failure(); }
	const stat = regular( filename );
	if ( stat.size > MAX_BYTES ) { throw failure(); }
	const bytes = fs.readFileSync( filename );
	const data = JSON.parse( bytes.toString( "utf8" ) );
	if ( data.schema !== 1 || !SHA.test( data.sourceCommit ) || !SHA.test( data.targetCommit )
		|| !HASH.test( data.token ) || data.token.slice( 0, 16 ) !== match[2]
		|| !samePath( data.profileDir, profileDir )
		|| typeof data.createdAt !== "string"
		|| new Date( Number( match[1] ) ).toISOString() !== data.createdAt ) { throw failure(); }
	validateValues( data.values );
	return { data, bytes, stat, filename };
}

function prune( root, profileDir, current ) {
	const snapshots = [];
	for ( const entry of fs.readdirSync( root ) ) {
		try {
			snapshots.push( readSnapshot( path.join( root, entry ), profileDir ) );
		} catch ( ignored ) {}
	}
	const previous = snapshots.filter( item => item.filename !== current )
		.sort( ( first, second ) => second.data.createdAt.localeCompare( first.data.createdAt )
			|| second.filename.localeCompare( first.filename ) );
	for ( const item of previous.slice( 2 ) ) {
		const stat = regular( item.filename );
		if ( stat.ino === item.stat.ino && stat.dev === item.stat.dev ) {
			fs.unlinkSync( item.filename );
		}
	}
}

async function createProfileBackup( options ) {
	let file;
	let descriptor;
	let created = false;
	try {
		const { profileDir, storage, identity, targetCommit, token } = options || {};
		if ( !identity || !SHA.test( identity.commit ) || !SHA.test( targetCommit )
			|| !HASH.test( token ) ) { throw failure(); }
		const canonical = directory( profileDir );
		const values = readValues( storage );
		const timestamp = Date.now();
		if ( !/^\d{13}$/.test( String( timestamp ) ) ) { throw failure(); }
		const createdAt = new Date( timestamp ).toISOString();
		const data = { schema: 1, sourceCommit: identity.commit, targetCommit,
			profileDir: canonical, token, createdAt, values };
		const bytes = Buffer.from( JSON.stringify( data ) );
		if ( bytes.length > MAX_BYTES ) { throw failure(); }
		const root = path.join( canonical, "updater-backups" );
		if ( !fs.existsSync( root ) ) { fs.mkdirSync( root, { mode: 0o700 } ); }
		await makePrivate( root, true );
		if ( !samePath( fs.realpathSync.native( root ), root ) ) { throw failure(); }
		file = path.join( root, `profile-v1-${timestamp}-${token.slice( 0, 16 )}.json` );
		const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
			| ( fs.constants.O_NOFOLLOW || 0 );
		descriptor = fs.openSync( file, flags, 0o600 );
		created = true;
		await makePrivate( file, false );
		const opened = fs.fstatSync( descriptor );
		const current = regular( file );
		if ( opened.ino !== current.ino || opened.dev !== current.dev ) { throw failure(); }
		fs.writeFileSync( descriptor, bytes );
		fs.fsyncSync( descriptor );
		fs.closeSync( descriptor );
		descriptor = undefined;
		prune( root, canonical, file );
		return { path: file, sha256: crypto.createHash( "sha256" ).update( bytes ).digest( "hex" ),
			sourceCommit: identity.commit, createdAt, bytes: bytes.length };
	} catch ( ignored ) {
		if ( descriptor !== undefined ) { try { fs.closeSync( descriptor ); } catch ( ignored ) {} }
		if ( created ) { try { fs.unlinkSync( file ); } catch ( ignored ) {} }
		throw failure();
	}
}

function pendingSnapshot( options, env ) {
	const installDir = directory( options.installDir );
	const profileDir = directory( options.profileDir );
	const token = env.STGUI_UPDATE_RESTORE_TOKEN;
	if ( !HASH.test( token ) || !options.identity || !SHA.test( options.identity.commit ) ) {
		throw failure();
	}
	const jobDir = path.join( path.dirname( installDir ), `.stgui-${token.slice( 0, 16 )}` );
	const jobFile = path.join( jobDir, "job.json" );
	if ( !samePath( path.resolve( env.STGUI_UPDATE_RESTORE_JOB ), jobFile )
		|| !samePath( fs.realpathSync.native( jobDir ), jobDir ) ) { throw failure(); }
	regular( jobDir, true );
	const jobStat = regular( jobFile );
	if ( jobStat.size > 1024 * 1024 ) { throw failure(); }
	const job = JSON.parse( fs.readFileSync( jobFile, "utf8" ) );
	if ( job.schema !== 1 || job.token !== token || !SHA.test( job.commit )
		|| job.sourceCommit !== options.identity.commit
		|| !samePath( job.installDir, installDir ) || !samePath( job.profileDir, profileDir )
		|| !samePath( job.jobDir, jobDir ) || !samePath( job.jobFile, jobFile )
		|| !HASH.test( job.profileBackupSha256 ) || typeof job.profileBackupFile !== "string" ) {
		throw failure();
	}
	const root = path.join( profileDir, "updater-backups" );
	regular( root, true );
	const filename = path.join( root, path.basename( job.profileBackupFile ) );
	if ( !samePath( job.profileBackupFile, filename )
		|| !samePath( fs.realpathSync.native( root ), root ) ) { throw failure(); }
	const snapshot = readSnapshot( filename, profileDir );
	if ( snapshot.data.token !== token || snapshot.data.sourceCommit !== job.sourceCommit
		|| snapshot.data.targetCommit !== job.commit
		|| crypto.createHash( "sha256" ).update( snapshot.bytes ).digest( "hex" )
			!== job.profileBackupSha256 ) { throw failure(); }
	return snapshot.data.values;
}

function replaceValues( storage, values ) {
	for ( const key of KEYS ) { storage.removeItem( key ); }
	for ( const key of KEYS ) {
		if ( values[key] !== null ) { storage.setItem( key, values[key] ); }
	}
}

function readMarker( profileDir ) {
	if ( typeof profileDir !== "string" ) { return null; }
	const raw = path.join( profileDir, "updater-backups", "pending-restore" );
	try { fs.lstatSync( raw ); } catch ( error ) {
		if ( error.code === "ENOENT" ) { return null; }
		throw failure();
	}
	const root = path.join( directory( profileDir ), "updater-backups" );
	regular( root, true );
	const filename = path.join( root, "pending-restore" );
	if ( !samePath( fs.realpathSync.native( root ), root )
		|| !samePath( fs.realpathSync.native( filename ), filename )
		|| regular( filename ).size > 65536 ) { throw failure(); }
	const bytes = fs.readFileSync( filename );
	const parts = bytes.toString( "utf8" ).split( "\0" );
	if ( parts.length !== 2 || !path.isAbsolute( parts[0] ) || !HASH.test( parts[1] ) ) {
		throw failure();
	}
	return { filename, bytes, jobFile: parts[0], token: parts[1] };
}

function removeMarker( marker ) {
	if ( !marker ) { return; }
	regular( marker.filename );
	if ( !fs.readFileSync( marker.filename ).equals( marker.bytes ) ) { throw failure(); }
	fs.unlinkSync( marker.filename );
}

function applyPendingRestore( options = {} ) {
	try {
		const env = options.env || process.env;
		const marker = readMarker( options.profileDir );
		const requested = env.STGUI_UPDATE_RESTORE_JOB || env.STGUI_UPDATE_RESTORE_TOKEN;
		if ( !requested && !marker ) { return false; }
		const request = requested ? env : {
			STGUI_UPDATE_RESTORE_JOB: marker.jobFile, STGUI_UPDATE_RESTORE_TOKEN: marker.token
		};
		if ( typeof request.STGUI_UPDATE_RESTORE_JOB !== "string"
			|| !request.STGUI_UPDATE_RESTORE_JOB
			|| typeof request.STGUI_UPDATE_RESTORE_TOKEN !== "string"
			|| !options.storage || typeof options.storage.setItem !== "function"
			|| typeof options.storage.removeItem !== "function" ) { throw failure(); }
		const requestedFile = path.resolve( request.STGUI_UPDATE_RESTORE_JOB );
		if ( marker && ( !samePath( marker.jobFile, requestedFile )
			|| marker.token !== request.STGUI_UPDATE_RESTORE_TOKEN ) ) { throw failure(); }
		const values = pendingSnapshot( options, request );
		const previous = readValues( options.storage );
		try {
			replaceValues( options.storage, values );
			removeMarker( marker );
		} catch ( ignored ) {
			try { replaceValues( options.storage, previous ); } catch ( ignored ) {}
			throw failure();
		}
		if ( marker && !env.STGUI_UPDATE_ROLLBACK ) {
			env.STGUI_UPDATE_ROLLBACK = requestedFile;
		}
		delete env.STGUI_UPDATE_RESTORE_JOB;
		delete env.STGUI_UPDATE_RESTORE_TOKEN;
		return true;
	} catch ( ignored ) { throw failure(); }
}

module.exports = { createProfileBackup, applyPendingRestore };
