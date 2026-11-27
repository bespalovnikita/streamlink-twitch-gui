import { inject as service } from "@ember/service";
import ModalDialogComponent from "../modal-dialog/component";
import layout from "./template.hbs";
import "./styles.less";


export default ModalDialogComponent.extend( /** @class ModalFirstrunComponent */ {
	/** @type {RouterService} */
	router: service(),

	layout,
	classNames: [ "modal-firstrun-component" ],


	actions: {
		/** @this {ModalFirstrunComponent} */
		settings( routeName ) {
			this.router.transitionTo( routeName );
			this.send( "close" );
		}
	}
});
