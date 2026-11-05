import ModalDialogComponent from "../modal-dialog/component";
import layout from "./template.hbs";


export default ModalDialogComponent.extend( /** @class ModalNewreleaseComponent */ {
	/** @type {VersioncheckService} */
	modalContext: null,

	layout,
	classNames: [ "modal-newrelease-component" ],


	actions: {
		ignore() { return this.modalContext.ignoreRelease(); },
		later() { this.modalContext.later(); },
		confirm() { return this.modalContext.install({ confirmed: true }); },
		back() { this.modalContext.later(); }
	}
});
