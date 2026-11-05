const { test } = require( "node:test" );
const assert = require( "node:assert/strict" );
const { spawn, execFileSync } = require( "node:child_process" );
const { createHash } = require( "node:crypto" );
const { once } = require( "node:events" );
const fs = require( "node:fs" );
const os = require( "node:os" );
const path = require( "node:path" );
const zlib = require( "node:zlib" );
const updater = require( "../../src/app/updater/install.js" );


const helpersDir = path.resolve( __dirname, "../../src/app/updater/helpers" );
const modulePath = path.resolve( __dirname, "../../src/app/updater/install.js" );
const supported = [ "linux", "win32" ].includes( process.platform );
const isWindows = process.platform === "win32";
const app = "streamlink-twitch-gui";
const executable = app + ( isWindows ? ".exe" : "" );
const commit = "0123456789abcdef0123456789abcdef01234567";
const oldCommit = "fedcba9876543210fedcba9876543210fedcba98";
const platformKey = isWindows ? "win64" : "linux64";
const binaryCache = new Map();
const pause = delay => new Promise( resolve => setTimeout( resolve, delay ) );
const json = value => Buffer.from( JSON.stringify( value ) );

const crcTable = Array.from( { length: 256 }, ( _, index ) => {
	let value = index;
	for ( let bit = 0; bit < 8; bit++ ) {
		value = value & 1 ? 0xedb88320 ^ ( value >>> 1 ) : value >>> 1;
	}
	return value >>> 0;
} );

function crc32( data ) {
	let value = 0xffffffff;
	for ( const byte of data ) { value = crcTable[( value ^ byte ) & 255] ^ ( value >>> 8 ); }
	return ( value ^ 0xffffffff ) >>> 0;
}

function tarRecord( entry ) {
	const data = entry.data || Buffer.alloc( 0 );
	const header = Buffer.alloc( 512 );
	header.write( entry.name );
	const octal = ( value, offset, length ) => {
		header.write( value.toString( 8 ).padStart( length - 1, "0" ), offset );
	};
	octal( 0o755, 100, 8 );
	octal( 0, 108, 8 );
	octal( 0, 116, 8 );
	octal( data.length, 124, 12 );
	octal( 0, 136, 12 );
	header.fill( 32, 148, 156 );
	header.write( entry.type || "0", 156 );
	if ( entry.link ) { header.write( entry.link, 157 ); }
	header.write( "ustar\0", 257 );
	header.write( "00", 263 );
	const checksum = header.reduce( ( total, byte ) => total + byte, 0 );
	header.write( `${checksum.toString( 8 ).padStart( 6, "0" )}\0 `, 148 );
	return Buffer.concat( [ header, data, Buffer.alloc( ( 512 - data.length % 512 ) % 512 ) ] );
}

function zipArchive( entries ) {
	const output = [];
	const central = [];
	let offset = 0;
	for ( const entry of entries ) {
		const name = Buffer.from( entry.name );
		const data = entry.data || Buffer.alloc( 0 );
		const compressed = entry.deflate || zlib.deflateRawSync( data, { level: 1 } );
		const crc = entry.crc === undefined ? crc32( data ) : entry.crc;
		const local = Buffer.alloc( 30 );
		local.writeUInt32LE( 0x04034b50 );
		local.writeUInt16LE( 20, 4 );
		local.writeUInt16LE( 0x800, 6 );
		local.writeUInt16LE( 8, 8 );
		local.writeUInt32LE( crc, 14 );
		local.writeUInt32LE( compressed.length, 18 );
		local.writeUInt32LE( data.length, 22 );
		local.writeUInt16LE( name.length, 26 );
		const directory = Buffer.alloc( 46 );
		directory.writeUInt32LE( 0x02014b50 );
		directory.writeUInt16LE( 0x0314, 4 );
		local.copy( directory, 6, 4, 30 );
		directory.writeUInt32LE( ( ( entry.mode || 0o100755 ) << 16 ) >>> 0, 38 );
		directory.writeUInt32LE( offset, 42 );
		output.push( local, name, compressed );
		central.push( directory, name );
		offset += local.length + name.length + compressed.length;
	}
	const end = Buffer.alloc( 22 );
	end.writeUInt32LE( 0x06054b50 );
	end.writeUInt16LE( entries.length, 8 );
	end.writeUInt16LE( entries.length, 10 );
	end.writeUInt32LE( central.reduce( ( length, item ) => length + item.length, 0 ), 12 );
	end.writeUInt32LE( offset, 16 );
	return Buffer.concat( [ ...output, ...central, end ] );
}

function binaryEntry( real ) {
	if ( binaryCache.has( real ) ) { return binaryCache.get( real ); }
	const data = real ? fs.readFileSync( process.execPath ) : Buffer.alloc( 512 );
	if ( !real && isWindows ) {
		data.writeUInt16LE( 0x5a4d );
		data.writeUInt32LE( 64, 60 );
		data.writeUInt32LE( 0x4550, 64 );
		data.writeUInt16LE( 0x8664, 68 );
	} else if ( !real ) {
		data.write( "\x7fELF" );
		data[4] = 2;
		data[5] = 1;
		data.writeUInt16LE( 62, 18 );
	}
	const entry = { name: `${app}/${executable}`, data };
	if ( isWindows ) {
		entry.deflate = zlib.deflateRawSync( data, { level: 1 } );
		entry.crc = crc32( data );
	} else {
		entry.gzip = zlib.gzipSync( tarRecord( entry ), { level: 1 } );
	}
	binaryCache.set( real, entry );
	return entry;
}

function packageEntries( options ) {
	const entries = [
		{ name: `${app}/package.json`, data: json( { name: options.name || app } ) },
		{ name: `${app}/build-info.json`, data: json( { commit: options.commit || commit } ) },
		{ name: `${app}/new-file.txt`, data: Buffer.from( "new application" ) }
	];
	if ( !options.missingBinary ) { entries.push( binaryEntry( Boolean( options.real ) ) ); }
	return entries.concat( options.entries || [] );
}

async function fixture( context, options = {} ) {
	const root = fs.mkdtempSync( path.join( os.tmpdir(), "stgui-installer-" ) );
	const installDir = path.join( root, "portable Приложение" );
	const profileDir = path.join( root, "profile" );
	fs.mkdirSync( installDir );
	fs.mkdirSync( profileDir );
	fs.writeFileSync( path.join( installDir, "old-file.txt" ), "old application" );
	fs.writeFileSync( path.join( installDir, "package.json" ), json( { name: app } ) );
	fs.writeFileSync( path.join( installDir, "build-info.json" ), json( { commit: oldCommit } ) );
	fs.writeFileSync( path.join( profileDir, "settings.json" ), "fixture settings" );
	fs.writeFileSync( path.join( profileDir, "auth.json" ), "fixture auth, no real credentials" );
	if ( options.real ) {
		fs.copyFileSync( process.execPath, path.join( installDir, executable ) );
		fs.chmodSync( path.join( installDir, executable ), 0o755 );
	}
	const entries = packageEntries( options );
	const archive = isWindows ? zipArchive( entries ) : Buffer.concat( [
		...entries.map( entry => entry.gzip || zlib.gzipSync( tarRecord( entry ) ) ),
		zlib.gzipSync( Buffer.alloc( 1024 ) )
	] );
	const archivePath = path.join( root, isWindows ? "update.zip" : "update.tar.gz" );
	fs.writeFileSync( archivePath, archive );
	const update = { manifest: {
		schema: 1, channel: "master", repository: "example/streamlink-twitch-gui",
		commit, buildNumber: 2, commitTime: "2026-11-05T12:00:00Z", version: "2.5.3",
		platforms: { [platformKey]: {
			name: path.basename( archivePath ), size: archive.length,
			sha256: createHash( "sha256" ).update( archive ).digest( "hex" )
		} }
	} };
	context.after( () => fs.promises.rm( root, {
		recursive: true, force: true, maxRetries: 30, retryDelay: 100
	} ) );
	return { root, installDir, profileDir, archivePath, update, helpersDir };
}

function assertPreserved( current ) {
	assert.equal( fs.readFileSync( path.join( current.profileDir, "settings.json" ), "utf8" ),
		"fixture settings" );
	assert.equal( fs.readFileSync( path.join( current.profileDir, "auth.json" ), "utf8" ),
		"fixture auth, no real credentials" );
	assert.deepEqual( fs.readdirSync( current.profileDir ).sort(),
		[ "auth.json", "settings.json" ] );
}

async function waitFor( predicate, message, timeout = 15000 ) {
	const deadline = Date.now() + timeout;
	while ( Date.now() < deadline ) {
		const result = await predicate();
		if ( result ) { return result; }
		await pause( 50 );
	}
	assert.fail( message );
}

function ownChild( context, child ) {
	context.after( () => {
		if ( child.pid && child.exitCode === null && child.signalCode === null ) { child.kill(); }
	} );
}

function diagnoseTransaction( context, job, error ) {
	const logs = [ "helper.log", "powershell.log", "helper-phase.txt", "status.json" ]
		.map( filename => path.join( job.jobDir, filename ) );
	if ( error.bootstrapErrorFile ) { logs.push( error.bootstrapErrorFile ); }
	for ( const log of logs ) {
		if ( fs.existsSync( log ) ) { context.diagnostic( fs.readFileSync( log, "utf8" ) ); }
	}
	let cause = error;
	for ( let depth = 0; cause && depth < 4; depth++ ) {
		context.diagnostic( `${cause.code || "Error"}: ${cause.message}` );
		cause = cause.cause;
	}
}

async function startInstallOwner( context, current, job, args ) {
	const script = path.join( current.root, "install-owner.cjs" );
	const configFile = path.join( current.root, "install-owner.json" );
	const readyFile = path.join( current.root, "owner-ready" );
	const releaseFile = path.join( current.root, "owner-release" );
	const errorFile = path.join( current.root, "startup-error.txt" );
	fs.writeFileSync( configFile, json( {
		job, args, readyFile, releaseFile, errorFile, modulePath
	} ), { mode: 0o600 } );
	fs.writeFileSync( script, `
const fs = require("node:fs");
const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const updater = require(config.modulePath);
updater.startInstall(config.job, {parentPid: process.pid, args: config.args}).then(() => {
	fs.writeFileSync(config.readyFile, "ready", {mode: 0o600});
	const timer = setInterval(() => {
		if (fs.existsSync(config.releaseFile)) {
			clearInterval(timer);
			process.exit(0);
		}
	}, 50);
}).catch(error => {
	const messages = [];
	for (let depth = 0; error && depth < 4; depth++, error = error.cause) {
		messages.push(String(error.code || "Error") + ": " + String(error.message));
	}
	const text = messages.join("\\n").split(config.job.token).join("[redacted]");
	fs.writeFileSync(config.errorFile, text, {mode: 0o600});
	process.exit(17);
});
` );
	const parent = spawn( process.execPath, [ script, configFile ], {
		stdio: "ignore", windowsHide: true
	} );
	ownChild( context, parent );
	let spawnError;
	parent.once( "error", error => { spawnError = error; } );
	try {
		await waitFor( () => {
			if ( fs.existsSync( readyFile ) ) { return true; }
			if ( spawnError ) { throw spawnError; }
			if ( parent.exitCode !== null || parent.signalCode !== null ) {
				throw new Error( "The installer owner exited before READY" );
			}
			return false;
		}, "The installer owner must reach READY" );
	} catch ( error ) {
		error.bootstrapErrorFile = errorFile;
		throw error;
	}
	return { parent, releaseFile };
}

async function transaction( context, mode ) {
	const current = await fixture( context, { real: true } );
	const eventFile = path.join( current.root, "launch.json" );
	const appScript = path.join( current.root, "fake-app.cjs" );
	const literalArgs = [ "space argument", "quote\"value\\", "кириллица", "$`'literal",
		`--user-data-dir=${current.profileDir}`, "--profile-directory=Профиль test\\" ];
	fs.writeFileSync( appScript, `
const fs = require("node:fs");
const path = require("node:path");
const updater = require(${JSON.stringify( modulePath )});
const [mode, profile, eventFile] = process.argv.slice(2);
const installDir = path.dirname(process.execPath);
const identity = JSON.parse(fs.readFileSync(path.join(installDir, "build-info.json")));
if (!process.env.STGUI_UPDATE_JOB) {
	updater.readRollbackStatus({installDir}).then(rollback => {
		fs.writeFileSync(eventFile, JSON.stringify({old: true, identity, rollback}));
	});
} else if (mode === "crash") {
	process.exit(17);
} else if (mode === "wrong-token") {
	const job = JSON.parse(fs.readFileSync(process.env.STGUI_UPDATE_JOB));
	fs.writeFileSync(job.ackFile, "f".repeat(64));
	setInterval(() => {}, 1000);
} else if (mode === "timeout") {
	setInterval(() => {}, 1000);
} else {
	updater.confirmStartup({installDir, identity}).then(ack => {
		fs.writeFileSync(eventFile, JSON.stringify({ack, identity, args: process.argv.slice(5)}));
		setTimeout(() => process.exit(0), 200);
	});
}
` );
	const job = await updater.prepareUpdate( current );
	job.timeoutMs = mode === "success" ? 6000 : 1000;
	const inheritedPath = process.env.PATH;
	if ( mode === "rename-failure" ) {
		job.renameTimeoutMs = 300;
		const bin = path.join( current.root, "fake-bin" );
		fs.mkdirSync( bin );
		fs.writeFileSync( path.join( bin, "mv" ), `#!/usr/bin/env bash
for destination; do :; done
case "$destination" in *-backup) printf 'failed\\n' >> "$0.calls"; exit 1;; esac
exec /usr/bin/mv "$@"
`, { mode: 0o755 } );
		process.env.PATH = `${bin}${path.delimiter}${inheritedPath}`;
	}
	let parent;
	let releaseParent;
	try {
		const args = [ appScript, mode, current.profileDir, eventFile, ...literalArgs ];
		if ( mode === "success" ) {
			const owner = await startInstallOwner( context, current, job, args );
			parent = owner.parent;
			releaseParent = () => fs.writeFileSync( owner.releaseFile, "release" );
		} else {
			parent = spawn( process.execPath, [ "-e", "setInterval(() => {}, 1000)" ], {
				stdio: "ignore", windowsHide: true
			} );
			ownChild( context, parent );
			await updater.startInstall( job, { parentPid: parent.pid, args } );
			releaseParent = () => parent.kill();
		}
	} catch ( error ) {
		diagnoseTransaction( context, job, error );
		throw error;
	} finally { process.env.PATH = inheritedPath; }
	assert.equal( fs.readFileSync( job.readyFile, "utf8" ), job.token );
	assert.equal( fs.readFileSync( path.join( current.installDir, "old-file.txt" ), "utf8" ),
		"old application", "The app stays unchanged while its parent is alive" );
	assert.equal( fs.existsSync( eventFile ), false, "The live parent must not be relaunched" );
	const exited = once( parent, "exit" );
	releaseParent();
	const [ exitCode, signal ] = await exited;
	if ( mode === "success" ) {
		assert.equal( exitCode, 0, "The process that started the helper must exit normally" );
		assert.equal( signal, null );
	}
	const status = await waitFor( () => {
		try { return JSON.parse( fs.readFileSync( job.statusFile, "utf8" ) ); } catch ( error ) {
			if ( error.code !== "ENOENT" && !( error instanceof SyntaxError ) ) { throw error; }
		}
	}, "The helper must finish the transaction" );
	const event = await waitFor( () => fs.existsSync( eventFile )
		&& JSON.parse( fs.readFileSync( eventFile, "utf8" ) ), "The application must launch" );
	assertPreserved( current );
	return { current, job, status, event, literalArgs };
}

test( "prepares a Windows GUI launcher before replacing application files", {
	skip: !isWindows, timeout: 15000
}, async context => {
	const current = await fixture( context );
	const job = await updater.prepareUpdate( current );
	const binary = fs.readFileSync( job.launcherPath );
	assert.equal( binary.readUInt16LE( 0 ), 0x5a4d );
	const pe = binary.readUInt32LE( 60 );
	assert.equal( binary.readUInt32LE( pe ), 0x4550 );
	assert.equal( binary.readUInt16LE( pe + 24 + 68 ), 2, "The launcher is a GUI executable" );
	assert.equal( fs.existsSync( path.join( current.installDir, "old-file.txt" ) ), true );
	assert.equal( await updater.discardUpdate( job ), true );
	assertPreserved( current );
} );

test( "swaps the complete app after exit and accepts only a healthy new startup", {
	skip: !supported, timeout: 45000
}, async context => {
	const { current, job, status, event, literalArgs } = await transaction( context, "success" );
	assert.equal( status.state, "succeeded" );
	await waitFor( () => !fs.existsSync( job.archivePath ), "The copied archive must be removed" );
	assert.equal( event.ack, true );
	assert.equal( event.identity.commit, commit );
	assert.deepEqual( event.args, literalArgs );
	assert.equal( fs.existsSync( path.join( current.installDir, "old-file.txt" ) ), false );
	assert.equal( fs.readFileSync( path.join( current.installDir, "new-file.txt" ), "utf8" ),
		"new application" );
	assert.equal( fs.readFileSync( path.join( job.backupDir, "old-file.txt" ), "utf8" ),
		"old application", "The backup remains available after ACK" );
	await pause( 300 );
} );

for ( const mode of [ "crash", "timeout", "wrong-token" ] ) {
	test( `restores and relaunches the old app after ${mode}`, {
		skip: !supported, timeout: 45000
	}, async context => {
		const { current, status, event } = await transaction( context, mode );
		assert.equal( status.state, "rolled-back" );
		assert.equal( event.old, true );
		assert.equal( event.rollback.state, "rolled-back" );
		assert.equal( event.identity.commit, oldCommit );
		assert.equal( fs.existsSync( path.join( current.installDir, "new-file.txt" ) ), false );
		assert.equal( fs.existsSync( path.join( current.installDir, "old-file.txt" ) ), true );
	} );
}

test( "relaunches the unchanged old app if its first directory move keeps failing", {
	skip: process.platform !== "linux", timeout: 45000
}, async context => {
	const { current, job, status, event } = await transaction( context, "rename-failure" );
	assert.equal( status.state, "rolled-back" );
	assert.equal( event.old, true );
	assert.equal( event.rollback.state, "rolled-back" );
	assert.equal( event.identity.commit, oldCommit );
	assert.equal( fs.existsSync( job.backupDir ), false );
	assert.equal( fs.existsSync( path.join( current.installDir, "new-file.txt" ) ), false );
	assert.equal( fs.existsSync( path.join( job.stageDir, "new-file.txt" ) ), true );
	assert.ok( fs.readFileSync( path.join( current.root, "fake-bin/mv.calls" ), "utf8" ) );
} );

test( "rejects a checksum mismatch before creating a staged application", {
	skip: !supported
}, async context => {
	const current = await fixture( context );
	current.update.manifest.platforms[platformKey].sha256 = "0".repeat( 64 );
	await assert.rejects( updater.prepareUpdate( current ), { code: "UPDATE_INTEGRITY" } );
	const expected = [ path.basename( current.archivePath ),
		path.basename( current.installDir ), "profile" ];
	assert.deepEqual( fs.readdirSync( current.root ).sort(), expected.sort() );
	assertPreserved( current );
} );

test( "refuses a profile inside the replaceable application directory", {
	skip: !supported
}, async context => {
	const current = await fixture( context );
	await assert.rejects( updater.prepareUpdate( {
		...current, profileDir: path.join( current.installDir, "profile" )
	} ), { code: "UPDATE_PROFILE" } );
	assertPreserved( current );
} );

test( "accepts Windows path case differences while rejecting directory junctions", {
	skip: !isWindows
}, async context => {
	const current = await fixture( context );
	const job = await updater.prepareUpdate( {
		...current, installDir: current.installDir.toUpperCase()
	} );
	assert.equal( await updater.discardUpdate( job ), true );
	const junction = path.join( current.root, "junction" );
	fs.symlinkSync( current.installDir, junction, "junction" );
	await assert.rejects( updater.prepareUpdate( { ...current, installDir: junction } ), {
		code: "UPDATE_LOCATION"
	} );
	assertPreserved( current );
} );

test( "accepts real Windows short path aliases without weakening junction checks", {
	skip: !isWindows
}, async context => {
	const current = await fixture( context );
	const source = `
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
using System.Text;
public static class ShortPathFixture {
 [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
 public static extern uint GetShortPathName(string path, StringBuilder output, uint length);
}
'@
$output = New-Object Text.StringBuilder 32768
$length = [ShortPathFixture]::GetShortPathName($env:STGUI_SHORT_PATH, $output, 32768)
if ($length -eq 0) { exit 1 }
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
[Console]::Write($output.ToString())
`;
	const canonical = await fs.promises.realpath( current.installDir );
	const alias = execFileSync( "powershell.exe", [ "-NoProfile", "-NonInteractive",
		"-Command", source ], {
			env: { ...process.env, STGUI_SHORT_PATH: canonical },
			encoding: "utf8", windowsHide: true
		} );
	if ( path.resolve( alias ).toLowerCase() === canonical.toLowerCase() ) {
		context.skip( "The fixture volume does not provide 8.3 path aliases" );
		return;
	}
	const job = await updater.prepareUpdate( { ...current, installDir: alias } );
	assert.equal( job.installDir, canonical );
	assert.equal( await updater.discardUpdate( job ), true );
	assertPreserved( current );
} );

const unsafeEntries = [
	{ name: `${app}/../escaped.txt`, data: Buffer.from( "escape" ) },
	{ name: `${app}/link`, type: "2", link: "../profile", mode: 0o120777 },
	{ name: `${app}/hardlink`, type: "1", link: `${app}/package.json`, mode: 0o060777 }
];
for ( const entry of unsafeEntries ) {
	test( `rejects an unsafe archive entry ${entry.name}`, { skip: !supported }, async context => {
		const current = await fixture( context, { entries: [ entry ] } );
		await assert.rejects( updater.prepareUpdate( current ), { code: "UPDATE_ARCHIVE" } );
		assert.equal( fs.existsSync( path.join( current.root, "escaped.txt" ) ), false );
		assertPreserved( current );
	} );
}

for ( const options of [ { commit: oldCommit }, { name: "other-app" }, { missingBinary: true } ] ) {
	test( `rejects an unexpected package ${JSON.stringify( options )}`, {
		skip: !supported
	}, async context => {
		const current = await fixture( context, options );
		await assert.rejects( updater.prepareUpdate( current ), { code: "UPDATE_PACKAGE" } );
		assertPreserved( current );
	} );
}

test( "discards a prepared job without changing the installation or profile", {
	skip: !supported
}, async context => {
	const current = await fixture( context );
	const job = await updater.prepareUpdate( current );
	assert.equal( await updater.discardUpdate( job ), true );
	assert.equal( fs.existsSync( job.stageDir ), false );
	assert.equal( fs.existsSync( job.jobDir ), false );
	assert.equal( fs.existsSync( path.join( current.installDir, "old-file.txt" ) ), true );
	assertPreserved( current );
} );

test( "keeps updater paths short when the installation directory name is long", {
	skip: !supported
}, async context => {
	const current = await fixture( context );
	const longName = `${app}-2.5.3-master.g${commit}-windows-or-linux-portable-build`;
	const installDir = path.join( current.root, longName );
	fs.renameSync( current.installDir, installDir );
	const job = await updater.prepareUpdate( { ...current, installDir } );
	assert.match( path.basename( job.jobDir ), /^\.stgui-[a-f0-9]{16}$/ );
	assert.equal( path.basename( job.stageDir ).length, 29 );
	const parent = await fs.promises.realpath( current.root );
	assert.ok( path.relative( parent, job.helperPath ).length < 40 );
	assert.equal( job.token.length, 64 );
	assert.equal( await updater.discardUpdate( job ), true );
	assert.equal( fs.existsSync( path.join( installDir, "old-file.txt" ) ), true );
	assertPreserved( current );
} );

test( "rejects forged cleanup paths and never deletes an existing backup", {
	skip: !supported
}, async context => {
	const current = await fixture( context );
	const job = await updater.prepareUpdate( current );
	assert.equal( await updater.discardUpdate( { ...job, stageDir: current.profileDir } ), false );
	fs.mkdirSync( job.backupDir );
	fs.writeFileSync( path.join( job.backupDir, "keep" ), "backup" );
	assert.equal( await updater.discardUpdate( job ), false );
	assert.equal( fs.readFileSync( path.join( job.backupDir, "keep" ), "utf8" ), "backup" );
	assertPreserved( current );
	fs.rmSync( job.backupDir, { recursive: true } );
	assert.equal( await updater.discardUpdate( job ), true );
} );

for ( const mode of [ "timeout", "exit" ] ) {
	test( `stops a helper after handshake ${mode} and keeps the current app running`, {
		skip: !supported, timeout: 15000
	}, async context => {
		const current = await fixture( context );
		const job = await updater.prepareUpdate( current );
		job.handshakeTimeoutMs = isWindows ? 3000 : 500;
		const pidFile = path.join( job.jobDir, "helper.pid" );
		const helper = isWindows
			? `param([string]$JobFile)
$job = [IO.File]::ReadAllText($JobFile) | ConvertFrom-Json
[IO.File]::WriteAllText((Join-Path $job.jobDir 'helper.pid'), [string]$PID)
${mode === "exit" ? "exit 17" : "Start-Sleep -Seconds 20"}
`
			: `#!/usr/bin/env bash
printf '%s' "$$" > "$5/helper.pid"
${mode === "exit" ? "exit 17" : "exec sleep 20"}
`;
		fs.writeFileSync( job.helperPath, helper );
		await assert.rejects( updater.startInstall( job ), { code: "UPDATE_START" } );
		assert.equal( fs.existsSync( path.join( current.installDir, "old-file.txt" ) ), true );
		assert.equal( fs.existsSync( job.readyFile ), false );
		assert.equal( fs.existsSync( path.join( job.jobDir, "started" ) ), false );
		assert.equal( fs.existsSync( pidFile ), true,
			"The helper must actually execute its script" );
		if ( fs.existsSync( pidFile ) ) {
			const helperPid = Number( fs.readFileSync( pidFile, "utf8" ) );
			await waitFor( () => {
				try { process.kill( helperPid, 0 ); return false; } catch ( error ) {
					if ( error.code !== "ESRCH" ) { throw error; }
					return true;
				}
			}, "The helper must exit before startInstall rejects" );
		}
		assert.equal( await updater.discardUpdate( job ), true );
		assertPreserved( current );
	} );
}

test( "healthy startup removes only completed older jobs and preserves the current backup", {
	skip: !supported, timeout: 30000
}, async context => {
	const current = await fixture( context );
	const previous = await updater.prepareUpdate( current );
	const rolledBack = await updater.prepareUpdate( current );
	const failed = await updater.prepareUpdate( current );
	const unfinished = await updater.prepareUpdate( current );
	const forged = await updater.prepareUpdate( current );
	const otherDir = path.join( current.root, "other installation" );
	fs.mkdirSync( otherDir );
	const other = await updater.prepareUpdate( { ...current, installDir: otherDir } );
	fs.mkdirSync( other.backupDir );
	fs.writeFileSync( path.join( other.backupDir, "keep" ), "other installation backup" );
	fs.writeFileSync( other.statusFile, json( { state: "succeeded", code: "" } ) );
	const completed = [ previous, rolledBack, failed ];
	for ( const old of [ ...completed, unfinished, forged ] ) {
		fs.mkdirSync( old.backupDir );
		fs.writeFileSync( path.join( old.backupDir, "keep" ), "old backup" );
		const states = [ "succeeded", "rolled-back", "failed" ];
		fs.writeFileSync( old.statusFile, json( {
			state: old === unfinished ? "installing"
				: states[completed.indexOf( old )] || "succeeded",
			code: ""
		} ) );
	}
	fs.writeFileSync( forged.jobFile, json( { ...forged, stageDir: current.profileDir } ) );
	const job = await updater.prepareUpdate( current );
	fs.writeFileSync( job.readyFile, job.token );
	fs.renameSync( current.installDir, job.backupDir );
	fs.renameSync( job.stageDir, current.installDir );
	assert.equal( await updater.confirmStartup( {
		installDir: current.installDir, identity: { commit }, jobFile: job.jobFile, token: job.token
	} ), true );
	for ( const old of completed ) {
		assert.equal( fs.existsSync( old.jobDir ), false );
		assert.equal( fs.existsSync( old.stageDir ), false );
		assert.equal( fs.existsSync( old.backupDir ), false );
	}
	for ( const retained of [ unfinished, forged ] ) {
		assert.equal( fs.existsSync( retained.jobDir ), true );
		assert.equal( fs.existsSync( path.join( retained.backupDir, "keep" ) ), true );
	}
	assert.equal( fs.existsSync( path.join( job.backupDir, "old-file.txt" ) ), true );
	assert.equal( fs.existsSync( other.jobDir ), true );
	assert.equal( fs.readFileSync( path.join( other.backupDir, "keep" ), "utf8" ),
		"other installation backup" );
	assertPreserved( current );
} );
