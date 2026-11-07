"use strict";
/* global BigInt */

const fs = require( "fs" ).promises;
const path = require( "path" );

const RESERVE = 64 * 1024 * 1024;
const PROFILE_ALLOWANCE = 32 * 1024 * 1024;

function failure( code ) {
	const error = new Error( code );
	error.code = code;
	return error;
}

function bytes( value ) {
	if ( !Number.isSafeInteger( value ) || value < 0 ) { throw failure( "UPDATE_INTEGRITY" ); }
	return BigInt( value );
}

function reportBytes( value ) {
	return Number( value > BigInt( Number.MAX_SAFE_INTEGER )
		? BigInt( Number.MAX_SAFE_INTEGER ) : value );
}

async function existingDirectory( location ) {
	let directory = path.resolve( location );
	while ( directory ) {
		try {
			const stat = await fs.stat( directory );
			if ( !stat.isDirectory() ) { directory = path.dirname( directory ); continue; }
			return await fs.realpath( directory );
		} catch ( error ) {
			if ( error.code !== "ENOENT" ) { throw error; }
			const parent = path.dirname( directory );
			if ( parent === directory ) { throw error; }
			directory = parent;
		}
	}
	throw failure( "UPDATE_NOT_WRITABLE" );
}

async function inspectVolume( location ) {
	const directory = await existingDirectory( location );
	const [ stat, capacity ] = await Promise.all([
		fs.stat( directory, { bigint: true } ), fs.statfs( directory, { bigint: true } )
	]);
	// Distinct UNC shares can report the same device number on Windows.
	const root = process.platform === "win32" && stat.dev.toString() === "0"
		? path.parse( directory ).root.toLowerCase() : "";
	return { device: `${stat.dev}:${root}`, availableBytes: capacity.bavail * capacity.bsize };
}

async function checkUpdateSpace( options, { getVolume = inspectVolume } = {} ) {
	const { update, installDir, profileDir, downloadPath, phase = "download" } = options;
	const platform = process.platform === "win32" ? "win64" : "linux64";
	const asset = update && update.manifest && update.manifest.platforms
		&& update.manifest.platforms[platform];
	if ( !asset || ![ "download", "prepare" ].includes( phase )
		|| ![ installDir, profileDir, downloadPath ].every( value => typeof value === "string" ) ) {
		throw failure( "UPDATE_INTEGRITY" );
	}
	const archive = bytes( asset.size );
	const unpacked = bytes( asset.unpackedSize );
	if ( !archive || !unpacked ) { throw failure( "UPDATE_INTEGRITY" ); }
	const requirements = [
		{ location: "application", path: path.dirname( installDir ), bytes: archive + unpacked },
		{ location: "profile", path: profileDir, bytes: BigInt( PROFILE_ALLOWANCE ) }
	];
	if ( phase === "download" ) {
		requirements.push({
			location: "download", path: path.dirname( downloadPath ), bytes: archive
		});
	}
	const volumes = new Map();
	for ( const requirement of requirements ) {
		let capacity;
		try { capacity = await getVolume( requirement.path ); } catch ( error ) {
			throw failure( "UPDATE_NOT_WRITABLE" );
		}
		const available = BigInt( capacity.availableBytes );
		if ( available < 0 ) { throw failure( "UPDATE_NO_SPACE" ); }
		let volume = volumes.get( capacity.device );
		if ( !volume ) {
			volume = { locations: [], required: BigInt( RESERVE ), available };
			volumes.set( capacity.device, volume );
		}
		volume.locations.push( requirement.location );
		volume.required += requirement.bytes;
		if ( available < volume.available ) { volume.available = available; }
	}
	const results = Array.from( volumes.values(), volume => ({
		locations: volume.locations,
		requiredBytes: reportBytes( volume.required ),
		availableBytes: reportBytes( volume.available )
	}));
	const report = {
		volumes: results,
		requiredBytes: results.reduce( ( sum, volume ) => sum + volume.requiredBytes, 0 ),
		availableBytes: results.reduce( ( sum, volume ) => sum + volume.availableBytes, 0 )
	};
	const insufficient = results.find( volume => volume.availableBytes < volume.requiredBytes );
	if ( insufficient ) {
		const error = failure( "UPDATE_NO_SPACE" );
		error.details = { ...insufficient, volumes: results };
		throw error;
	}
	return report;
}

module.exports = { checkUpdateSpace };
