import { computed } from "@ember/object";
import { inject as service } from "@ember/service";
import ModalDialogComponent from "../modal-dialog/component";
import layout from "./template.hbs";
import "./styles.less";


export default ModalDialogComponent.extend({
	intl: service(),
	layout,
	classNames: [ "modal-updater-history-component" ],

	entries: computed( "modalContext.historyEntries.[]", "intl.locale", function() {
		return ( this.modalContext.historyEntries || [] ).map( event => ({
			date: new Date( event.at ).toLocaleString( this.intl.locale ),
			typeKey: `updater.history.type.${event.type}`,
			statusKey: `updater.history.status.${event.status}`,
			commit: event.commit ? event.commit.slice( 0, 8 ) : "",
			code: event.code || ""
		}) );
	})
});
