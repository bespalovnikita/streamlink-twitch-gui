const { test } = require( "node:test" );
const assert = require( "node:assert/strict" );
const fs = require( "node:fs" );
const os = require( "node:os" );
const path = require( "node:path" );
const { createHash } = require( "node:crypto" );
const { execFileSync } = require( "node:child_process" );
const backups = require( "../../src/app/updater/profile-backup.js" );


const keys = [ "app", "settings", "auth", "window", "versioncheck", "channelsettings", "search" ];
const sourceCommit = "a".repeat( 40 );
const targetCommit = "b".repeat( 40 );
const token = "c".repeat( 64 );
const isWindows = process.platform === "win32";
const values = { app: "{\"legacy\":\"raw\"}", settings: " raw settings кириллица ",
	auth: "{\"access_token\":\"fixture-only\"}", window: null, versioncheck: "",
	channelsettings: "{invalid-json-is-still-raw", search: "fixture search" };

class Storage {
	constructor( initial = values ) {
		const present = Object.entries( initial ).filter( ( [ , value ] ) => value !== null );
		this.values = new Map( present );
		this.writes = [];
	}
	getItem( key ) { return this.values.has( key ) ? this.values.get( key ) : null; }
	setItem( key, value ) { this.writes.push( key ); this.values.set( key, value ); }
	removeItem( key ) { this.writes.push( key ); this.values.delete( key ); }
	managed() { return Object.fromEntries( keys.map( key => [ key, this.getItem( key ) ] ) ); }
}

function fixture( context ) {
	const temporary = fs.mkdtempSync( path.join( os.tmpdir(), "stgui-profile-" ) );
	const root = fs.realpathSync.native( temporary );
	const profileDir = path.join( root, "profile Приложение" );
	const installDir = path.join( root, "app" );
	fs.mkdirSync( profileDir );
	fs.mkdirSync( installDir );
	context.after( () => fs.promises.rm( root, {
		recursive: true, force: true, maxRetries: 20, retryDelay: 100
	} ) );
	return { root, profileDir, installDir, storage: new Storage(),
		identity: { commit: sourceCommit }, targetCommit, token };
}

async function pending( context ) {
	const current = fixture( context );
	const snapshot = await backups.createProfileBackup( current );
	const jobDir = path.join( current.root, `.stgui-${token.slice( 0, 16 )}` );
	fs.mkdirSync( jobDir );
	const jobFile = path.join( jobDir, "job.json" );
	const job = { schema: 1, commit: targetCommit, sourceCommit, token,
		profileDir: current.profileDir, installDir: current.installDir, jobDir, jobFile,
		profileBackupFile: snapshot.path, profileBackupSha256: snapshot.sha256 };
	fs.writeFileSync( jobFile, JSON.stringify( job ) );
	const env = { STGUI_UPDATE_RESTORE_JOB: jobFile, STGUI_UPDATE_RESTORE_TOKEN: token,
		STGUI_UPDATE_ROLLBACK: jobFile };
	return { ...current, snapshot, job, env };
}

function writeJob( current ) {
	fs.writeFileSync( current.job.jobFile, JSON.stringify( current.job ) );
}

function mutateSnapshot( current, change ) {
	const data = JSON.parse( fs.readFileSync( current.snapshot.path, "utf8" ) );
	change( data );
	const bytes = Buffer.from( JSON.stringify( data ) );
	fs.writeFileSync( current.snapshot.path, bytes );
	current.job.profileBackupSha256 = createHash( "sha256" ).update( bytes ).digest( "hex" );
}

function markPending( current ) {
	const marker = path.join( current.profileDir, "updater-backups", "pending-restore" );
	fs.writeFileSync( marker, `${current.job.jobFile}\0${token}`, { mode: 0o600 } );
	return marker;
}

function powershell( script, filename ) {
	const executable = path.join( process.env.SystemRoot,
		"System32", "WindowsPowerShell", "v1.0", "powershell.exe" );
	return execFileSync( executable, [ "-NoProfile", "-NonInteractive", "-EncodedCommand",
		Buffer.from( script, "utf16le" ).toString( "base64" ) ], {
			windowsHide: true, encoding: "utf8",
			env: { ...process.env, STGUI_PROFILE_TEST_PATH: filename }
		} );
}

test( "backs up only the seven raw managed values with an exact integrity hash", async context => {
	const current = fixture( context );
	current.storage.setItem( "unrelated", "must not be copied" );
	fs.mkdirSync( path.join( current.profileDir, "LevelDB" ) );
	fs.writeFileSync( path.join( current.profileDir, "LevelDB", "LOCK" ), "untouched cache" );
	const snapshot = await backups.createProfileBackup( current );
	const bytes = fs.readFileSync( snapshot.path );
	const data = JSON.parse( bytes );
	assert.equal( snapshot.sourceCommit, sourceCommit );
	assert.equal( snapshot.bytes, bytes.length );
	assert.equal( snapshot.sha256, createHash( "sha256" ).update( bytes ).digest( "hex" ) );
	assert.equal( data.schema, 1 );
	assert.equal( data.profileDir, current.profileDir );
	assert.equal( data.targetCommit, targetCommit );
	assert.deepEqual( data.values, values );
	assert.deepEqual( fs.readdirSync( path.dirname( snapshot.path ) ),
		[ path.basename( snapshot.path ) ] );
	assert.equal( fs.readFileSync( path.join( current.profileDir, "LevelDB", "LOCK" ), "utf8" ),
		"untouched cache" );
} );

test( "writes snapshots into a private directory and private file", {
	timeout: 60000
}, async context => {
	const current = fixture( context );
	if ( isWindows ) {
		powershell( `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:STGUI_PROFILE_TEST_PATH
$everyone = New-Object Security.Principal.SecurityIdentifier('S-1-1-0')
$rule = New-Object Security.AccessControl.FileSystemAccessRule($everyone, 'FullControl',
 'ContainerInherit, ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $env:STGUI_PROFILE_TEST_PATH -AclObject $acl
`, current.profileDir );
	}
	const snapshot = await backups.createProfileBackup( current );
	for ( const filename of [ path.dirname( snapshot.path ), snapshot.path ] ) {
		if ( isWindows ) {
			powershell( `
$ErrorActionPreference = 'Stop'
$acl = Get-Acl -LiteralPath $env:STGUI_PROFILE_TEST_PATH
$user = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
if (-not $acl.AreAccessRulesProtected) { throw 'The DACL inherits broad profile permissions' }
$rules = @($acl.GetAccessRules($true, $true, [Security.Principal.SecurityIdentifier]))
if ($rules.Count -ne 2) { throw 'Unexpected DACL rule count' }
foreach ($rule in $rules) {
 if ($rule.IdentityReference.Value -ne $user -and
  $rule.IdentityReference.Value -ne 'S-1-5-18') { throw 'Unexpected snapshot principal' }
 if ($rule.IsInherited -or $rule.AccessControlType -ne 'Allow' -or
  $rule.FileSystemRights -ne 'FullControl') { throw 'Unexpected snapshot permissions' }
}
`, filename );
		} else {
			assert.equal( fs.statSync( filename ).mode & 0o777,
				filename === snapshot.path ? 0o600 : 0o700 );
		}
	}
} );

test( "restores raw values before migrations and consumes restore environment", async c => {
	const current = await pending( c );
	current.storage = new Storage( { settings: "future schema", auth: "future auth",
		window: "future window", unrelated: "leave this alone" } );
	assert.equal( backups.applyPendingRestore( current ), true );
	assert.deepEqual( current.storage.managed(), values );
	assert.equal( current.storage.getItem( "unrelated" ), "leave this alone" );
	assert.equal( current.env.STGUI_UPDATE_RESTORE_JOB, undefined );
	assert.equal( current.env.STGUI_UPDATE_RESTORE_TOKEN, undefined );
	assert.equal( current.env.STGUI_UPDATE_ROLLBACK, current.job.jobFile );
	const writes = current.storage.writes.length;
	assert.equal( backups.applyPendingRestore( current ), false );
	assert.equal( current.storage.writes.length, writes );
} );

const invalid = {
	checksum: current => { current.job.profileBackupSha256 = "0".repeat( 64 ); },
	identity: current => { current.identity = { commit: "d".repeat( 40 ) }; },
	source: current => { current.job.sourceCommit = "d".repeat( 40 ); },
	target: current => { current.job.commit = "d".repeat( 40 ); },
	profile: current => { current.job.profileDir = current.root; },
	nonce: current => { current.env.STGUI_UPDATE_RESTORE_TOKEN = "d".repeat( 64 ); },
	values: current => { mutateSnapshot( current, data => { data.values.search = 5; } ); },
	unknown: current => { mutateSnapshot( current, data => { data.values.extra = "forged"; } ); },
	metadata: current => {
		mutateSnapshot( current, data => { data.sourceCommit = targetCommit; } );
	},
	hardlink: current => {
		fs.linkSync( current.snapshot.path, path.join( current.root, "link" ) );
	}
};
for ( const [ name, change ] of Object.entries( invalid ) ) {
	test( `rejects ${name} mismatch without any storage writes`, async context => {
		const current = await pending( context );
		change( current );
		writeJob( current );
		assert.throws( () => backups.applyPendingRestore( current ),
			{ code: "UPDATE_PROFILE_BACKUP" } );
		assert.deepEqual( current.storage.writes, [] );
		assert.deepEqual( current.storage.managed(), values );
		assert.equal( typeof current.env.STGUI_UPDATE_RESTORE_JOB, "string" );
	} );
}

test( "corrupt snapshot errors hide auth values and original causes", async context => {
	const current = await pending( context );
	fs.writeFileSync( current.snapshot.path, "{\"auth\":\"dummy-secret\"" );
	current.job.profileBackupSha256 = createHash( "sha256" )
		.update( fs.readFileSync( current.snapshot.path ) ).digest( "hex" );
	writeJob( current );
	assert.throws( () => backups.applyPendingRestore( current ), error => {
		assert.equal( error.code, "UPDATE_PROFILE_BACKUP" );
		assert.equal( error.message, "UPDATE_PROFILE_BACKUP" );
		assert.equal( error.cause, undefined );
		assert.equal( String( error.stack ).includes( "dummy-secret" ), false );
		assert.equal( JSON.stringify( error ).includes( "dummy-secret" ), false );
		return true;
	} );
	assert.deepEqual( current.storage.writes, [] );
} );

test( "rolls storage back to its previous values if an individual write fails", async context => {
	const current = await pending( context );
	current.storage = new Storage( { settings: "future", auth: "future", unrelated: "retained" } );
	const previous = current.storage.managed();
	const setItem = current.storage.setItem.bind( current.storage );
	let failed = false;
	current.storage.setItem = ( key, value ) => {
		if ( key === "auth" && !failed ) { failed = true; throw new Error( "fixture failure" ); }
		setItem( key, value );
	};
	assert.throws( () => backups.applyPendingRestore( current ),
			{ code: "UPDATE_PROFILE_BACKUP" } );
	assert.deepEqual( current.storage.managed(), previous );
	assert.equal( current.storage.getItem( "unrelated" ), "retained" );
	assert.equal( current.env.STGUI_UPDATE_RESTORE_TOKEN, token );
} );

test( "retains three valid snapshots while preserving unknown, foreign and linked files", {
	timeout: 60000
}, async context => {
	const current = fixture( context );
	const snapshots = [];
	for ( let index = 1; index <= 5; index++ ) {
		snapshots.push( await backups.createProfileBackup( {
			...current, token: String( index ).repeat( 64 )
		} ) );
	}
	const root = path.dirname( snapshots[4].path );
	fs.writeFileSync( path.join( root, "notes.txt" ), "unknown" );
	const foreign = JSON.parse( fs.readFileSync( snapshots[4].path, "utf8" ) );
	foreign.profileDir = current.root;
	foreign.token = "9".repeat( 64 );
	const timestamp = Date.parse( foreign.createdAt );
	const foreignFile = path.join( root, `profile-v1-${timestamp}-${"9".repeat( 16 )}.json` );
	fs.writeFileSync( foreignFile, JSON.stringify( foreign ) );
	const linked = path.join( root, `profile-v1-${timestamp}-${"8".repeat( 16 )}.json` );
	fs.symlinkSync( current.installDir, linked, isWindows ? "junction" : "dir" );
	const last = await backups.createProfileBackup( { ...current, token: "6".repeat( 64 ) } );
	for ( const [ index, snapshot ] of snapshots.entries() ) {
		assert.equal( fs.existsSync( snapshot.path ), index >= 3 );
	}
	assert.equal( fs.existsSync( last.path ), true );
	assert.equal( fs.readFileSync( path.join( root, "notes.txt" ), "utf8" ), "unknown" );
	assert.equal( fs.existsSync( foreignFile ), true );
	assert.equal( fs.lstatSync( linked ).isSymbolicLink(), true );
} );

test( "refuses linked backup directories and leaves their target untouched", async context => {
	const current = fixture( context );
	const foreign = path.join( current.root, "foreign" );
	fs.mkdirSync( foreign );
	fs.writeFileSync( path.join( foreign, "keep" ), "untouched" );
	fs.symlinkSync( foreign, path.join( current.profileDir, "updater-backups" ),
		isWindows ? "junction" : "dir" );
	await assert.rejects( backups.createProfileBackup( current ),
		{ code: "UPDATE_PROFILE_BACKUP" } );
	assert.deepEqual( fs.readdirSync( foreign ), [ "keep" ] );
} );

test( "a colliding snapshot name never removes the existing backup", async context => {
	const current = fixture( context );
	const timestamp = Date.now();
	context.mock.method( Date, "now", () => timestamp );
	const snapshot = await backups.createProfileBackup( current );
	await assert.rejects( backups.createProfileBackup( current ),
		{ code: "UPDATE_PROFILE_BACKUP" } );
	assert.equal( createHash( "sha256" ).update( fs.readFileSync( snapshot.path ) ).digest( "hex" ),
		snapshot.sha256 );
} );

test( "ignores absent restore requests and rejects an incomplete request", () => {
	assert.equal( backups.applyPendingRestore( { env: {} } ), false );
	assert.throws( () => backups.applyPendingRestore( {
		env: { STGUI_UPDATE_RESTORE_TOKEN: token }
	} ), { code: "UPDATE_PROFILE_BACKUP" } );
} );

test( "manual restarts stay blocked until the corrupt snapshot is repaired", async c => {
	const current = await pending( c );
	const marker = markPending( current );
	const original = fs.readFileSync( current.snapshot.path );
	current.env = {};
	fs.writeFileSync( current.snapshot.path, "dummy-secret corrupt snapshot" );
	for ( let attempt = 0; attempt < 2; attempt++ ) {
		assert.throws( () => backups.applyPendingRestore( current ), {
			code: "UPDATE_PROFILE_BACKUP", message: "UPDATE_PROFILE_BACKUP"
		} );
		assert.equal( fs.existsSync( marker ), true );
		assert.deepEqual( current.storage.writes, [] );
	}
	fs.writeFileSync( current.snapshot.path, original );
	assert.equal( backups.applyPendingRestore( current ), true );
	assert.equal( fs.existsSync( marker ), false );
	assert.equal( current.env.STGUI_UPDATE_ROLLBACK, current.job.jobFile );
	assert.deepEqual( current.storage.managed(), values );
} );

test( "a denied snapshot preserves the restore request for later restarts", async context => {
	const current = await pending( context );
	const marker = markPending( current );
	current.env = {};
	const readFile = fs.readFileSync;
	context.mock.method( fs, "readFileSync", ( filename, ...args ) => {
		if ( filename === current.snapshot.path ) {
			const error = new Error( "dummy-secret denied" );
			error.code = "EACCES";
			throw error;
		}
		return readFile( filename, ...args );
	} );
	assert.throws( () => backups.applyPendingRestore( current ), {
		code: "UPDATE_PROFILE_BACKUP", message: "UPDATE_PROFILE_BACKUP"
	} );
	assert.equal( fs.existsSync( marker ), true );
	assert.deepEqual( current.storage.writes, [] );
	context.mock.restoreAll();
	assert.equal( backups.applyPendingRestore( current ), true );
	assert.equal( fs.existsSync( marker ), false );
} );

test( "a quota failure keeps the marker and previous storage until the next successful retry", {
	timeout: 60000
}, async context => {
	const current = await pending( context );
	const marker = markPending( current );
	current.env = {};
	current.storage = new Storage( { auth: "future auth", settings: "future schema" } );
	const original = current.storage.managed();
	const setItem = current.storage.setItem.bind( current.storage );
	let failed = false;
	current.storage.setItem = ( key, value ) => {
		if ( key === "settings" && !failed ) { failed = true; throw new Error( "QuotaExceeded" ); }
		setItem( key, value );
	};
	assert.throws( () => backups.applyPendingRestore( current ),
		{ code: "UPDATE_PROFILE_BACKUP" } );
	assert.deepEqual( current.storage.managed(), original );
	assert.equal( fs.existsSync( marker ), true );
	assert.equal( backups.applyPendingRestore( current ), true );
	assert.deepEqual( current.storage.managed(), values );
	assert.equal( fs.existsSync( marker ), false );
} );

test( "a conflicting environment cannot override the persistent restore request", async context => {
	const current = await pending( context );
	const marker = markPending( current );
	current.env.STGUI_UPDATE_RESTORE_TOKEN = "d".repeat( 64 );
	assert.throws( () => backups.applyPendingRestore( current ),
		{ code: "UPDATE_PROFILE_BACKUP" } );
	assert.deepEqual( current.storage.writes, [] );
	assert.equal( fs.existsSync( marker ), true );
} );
