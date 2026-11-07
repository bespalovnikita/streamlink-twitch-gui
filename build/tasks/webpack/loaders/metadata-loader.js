module.exports = function() {
	this.cacheable( false );

	const { version, package: pkg, built, identity = {} } = this.getOptions();
	this.emitFile( "build-info.json", JSON.stringify( identity ) );

	return JSON.stringify({
		...identity,
		version,
		built,
		author: pkg.author,
		dependencies: [ "dependencies", "devDependencies" ]
			.reduce( ( obj, key ) => Object.assign( obj, pkg[ key ] ), {} )
	});
};
