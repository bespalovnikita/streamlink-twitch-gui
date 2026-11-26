import { get, set, computed } from "@ember/object";
import { inject as service } from "@ember/service";
import FormButtonComponent from "ui/components/button/form-button/component";
import layout from "./template.hbs";
import "./styles.less";


export default FormButtonComponent.extend({
	router: service(),
	settings: service(),

	layout,
	classNames: [ "homepage-action" ],
	classNameBindings: "isHomepage:active",
	attributeBindings: [ "ariaDisabled:aria-disabled" ],

	icon: "fa-home",
	iconanim: true,

	ariaDisabled: computed( "isHomepage", function() {
		return String( this.isHomepage );
	}),

	isHomepage: computed( "router.currentURL", "settings.content.gui.homepage", function() {
		const url = get( this, "router.currentURL" );
		return !!url && url === get( this, "settings.content.gui.homepage" );
	}),


	action() {
		const settings = get( this, "settings.content" );
		const url = get( this, "router.currentURL" );
		if ( this.isHomepage || !settings || !url ) { return; }

		const previous = get( settings, "gui.homepage" );
		set( settings, "gui.homepage", url );
		return settings.save().catch( error => {
			if ( get( settings, "gui.homepage" ) === url ) {
				set( settings, "gui.homepage", previous );
			}
			throw error;
		});
	}
});
