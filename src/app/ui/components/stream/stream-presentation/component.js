import Component from "@ember/component";
import { computed } from "@ember/object";
import { or } from "@ember/object/computed";
import layout from "./template.hbs";
import "./styles.less";


export default Component.extend({
	layout,

	tagName: "li",
	classNames: [ "stream-presentation-component" ],

	canClose: or( "session.hasEnded", "session.isLaunching", "session.isWatching" ),

	sessionStatus: computed(
		"session.error",
		"session.hasEnded",
		"session.isLaunching",
		"session.isWatching",
		function() {
			const { error, hasEnded, isLaunching, isWatching } = this.session;
			if ( error ) { return "failed"; }
			if ( hasEnded ) { return "ended"; }
			if ( isWatching ) { return "playing"; }
			if ( isLaunching ) { return "starting"; }
			return "pending";
		}
	)
});
