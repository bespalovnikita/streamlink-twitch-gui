const { spawnSync } = require( "child_process" );
const { resolve } = require( "path" );
const pkg = require( "../../../package.json" );
const update = require( "../../../src/config/update.json" );


module.exports = function buildIdentity( {
	cwd = resolve( __dirname, "../../.." ),
	env = process.env
} = {} ) {
	const result = spawnSync( "git", [ "show", "-s", "--format=%H%n%ct", "HEAD" ], {
		cwd,
		encoding: "utf8",
		timeout: 4000,
		windowsHide: true
	});
	const [ commit, timestamp ] = result.status === 0
		? result.stdout.trim().split( /\r?\n/ )
		: [];
	const identified = /^[a-f0-9]{40}$/.test( commit || "" );
	const number = env.GITHUB_RUN_NUMBER || "";

	return {
		schema: 1,
		channel: "master",
		repository: update.repository,
		appName: pkg.name,
		version: pkg.version,
		commit: identified ? commit : "",
		commitTime: identified ? Number( timestamp ) : 0,
		buildNumber: /^\d+$/.test( number ) ? Number( number ) : 0
	};
};
