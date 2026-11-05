import attr from "ember-data/attr";
import Model from "ember-data/model";


export default Model.extend({
	version: attr( "string", { defaultValue: "" } ),
	checkagain: attr( "number", { defaultValue: 0 } ),
	skippedTag: attr( "string", { defaultValue: "" } ),
	showdebugmessage: attr( "number", { defaultValue: 0 } )

}).reopenClass({
	toString() { return "Versioncheck"; }
});
