import { module, test } from "qunit";
import { EventEmitter } from "events";
import { Readable } from "stream";
import { Buffer } from "buffer";
import { createHash, generateKeyPairSync, sign } from "crypto";
import { promises as fs } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { downloadUpdate as downloadClient } from "updater/client";


const signingKey = generateKeyPairSync( "ed25519" );
const trustedKeys = {
	"qunit-key": signingKey.publicKey.export({ type: "spki", format: "pem" })
};

function downloadUpdate( update, destination, options ) {
	return downloadClient( update, destination, { trustedKeys, ...options } );
}


function descriptor( bytes ) {
	const commit = "b".repeat( 40 );
	const tag = `v2.5.3-master.g${commit}`;
	const asset = {
		name: "streamlink-twitch-gui-test-win64.zip",
		size: bytes.length,
		unpackedSize: 100,
		sha256: createHash( "sha256" ).update( bytes ).digest( "hex" )
	};
	const update = {
		tag,
		platform: "win64",
		manifest: {
			schema: 1,
			channel: "master",
			repository: "example/streamlink-twitch-gui",
			commit,
			commitTime: 200,
			buildNumber: 2,
			version: "2.5.3",
			platforms: {
				win64: asset,
				linux64: { ...asset, name: "streamlink-twitch-gui-test-linux64.tar.gz" }
			}
		},
		asset: {
			...asset,
			url: `https://github.com/example/streamlink-twitch-gui/releases/download/${tag}/${asset.name}`
		}
	};
	update.manifestBytes = Buffer.from( JSON.stringify( update.manifest ) );
	update.manifestSignature = {
		schema: 1,
		algorithm: "Ed25519",
		keyId: "qunit-key",
		signatureBase64: sign( null, update.manifestBytes, signingKey.privateKey )
			.toString( "base64" )
	};
	return update;
}

function fakeRequest( bytes ) {
	return ( url, options, callback ) => {
		const request = new EventEmitter();
		let response;
		let destroyed = false;
		request.destroy = cause => {
			if ( destroyed ) { return; }
			destroyed = true;
			if ( response ) { response.destroy( cause ); }
			if ( cause ) { Promise.resolve().then( () => request.emit( "error", cause ) ); }
		};
		request.end = () => Promise.resolve().then( () => {
			if ( destroyed ) { return; }
			response = Readable.from([ bytes.subarray( 0, 4 ), bytes.subarray( 4 ) ]);
			response.statusCode = 200;
			response.headers = { "content-length": String( bytes.length ) };
			callback( response );
		});
		return request;
	};
}


module( "updater/client browser AbortSignal integration", function( hooks ) {
	hooks.beforeEach( async function() {
		this.directory = await fs.mkdtemp( join( tmpdir(), "updater-qunit-" ) );
		this.filename = join( this.directory, "update.zip" );
		this.bytes = Buffer.from( "Browser AbortSignal through the real Node stream pipeline" );
		this.update = descriptor( this.bytes );
	});

	hooks.afterEach( async function() {
		await fs.rm( this.directory, { recursive: true, force: true } );
	});

	test( "Verifies a Node download using a browser AbortSignal", async function( assert ) {
		const controller = new window.AbortController();
		const progress = [];
		const filename = await downloadUpdate( this.update, this.filename, {
			request: fakeRequest( this.bytes ),
			signal: controller.signal,
			onProgress: value => progress.push( value )
		});
		assert.strictEqual( filename, this.filename, "Returns the completed archive path" );
		assert.strictEqual( ( await fs.readFile( filename ) ).toString(), this.bytes.toString(),
			"Writes the bytes verified by the actual Node crypto and stream pipeline" );
		assert.strictEqual( progress[progress.length - 1].percent, 100, "Reports completion" );
		assert.deepEqual( await fs.readdir( this.directory ), [ "update.zip" ],
			"Atomically removes the temporary partial filename" );
	});

	test( "Cancels a Node stream using a real browser AbortController", async function( assert ) {
		const controller = new window.AbortController();
		let failure;
		try {
			await downloadUpdate( this.update, this.filename, {
				request: fakeRequest( this.bytes ),
				signal: controller.signal,
				onProgress: ( { received } ) => { if ( received ) { controller.abort(); } }
			});
		} catch ( error ) { failure = error; }
		assert.strictEqual( failure && failure.code, "ABORTED", "Recognizes browser cancellation" );
		assert.deepEqual( await fs.readdir( this.directory ), [],
			"Cancellation leaves neither an archive nor a partial download" );
	});
});
