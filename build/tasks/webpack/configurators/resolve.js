const { pApp, pTest } = require( "../paths" );
const { isTestTarget } = require( "../utils" );


/**
 * Resolver configurations for each build target
 */
module.exports = {
	common( config, grunt, target ) {
		config.resolve.alias.updater = `${pApp}/updater`;
		// set the first module resolve path
		config.resolve.modules.unshift(
			isTestTarget( target )
				? pTest
				: pApp
		);
	}
};
