import Controller from "@ember/controller";
import { sort } from "@ember/object/computed";
import { inject as service } from "@ember/service";
import "./styles.less";


export default Controller.extend({
	/** @type {AuthService} */
	auth: service(),
	/** @type {ModalService} */
	modal: service(),
	/** @type {StreamingService} */
	streaming: service(),

	sortedModel: sort( "model", "sortBy" ),
	sortBy: [ "started:desc" ],

	actions: {
		openDialog( session ) {
			if ( !session.isDeleted && !session.isDestroyed ) {
				this.modal.openModal( "streaming", session );
			}
		},

		closeStream( stream ) {
			this.streaming.closeStream( stream );
		}
	}
});
