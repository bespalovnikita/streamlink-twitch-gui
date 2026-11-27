import { set, setProperties, computed } from "@ember/object";
import { or, readOnly } from "@ember/object/computed";
import { inject as service } from "@ember/service";
import { streaming as streamingConfig } from "config";
import ModalDialogComponent from "../modal-dialog/component";
import { qualities } from "data/models/stream/model";
import {
	LogError,
	ProviderError,
	PlayerError,
	VersionError,
	UnableToOpenError,
	NoStreamsFoundError,
	TimeoutError
} from "services/streaming/errors";
import layout from "./template.hbs";
import "./styles.less";


const {
	"download-url": downloadUrl,
	validation: {
		providers: validationProviders
	}
} = streamingConfig;


function computedError( Class ) {
	return computed( "error", function() {
		return this.error instanceof Class;
	});
}

function isNativeControl( target ) {
	return target && target.closest
		&& target.closest( "button, a[href], summary, select, input, textarea, [contenteditable]" );
}


export default ModalDialogComponent.extend( /** @class ModalStreamingComponent */ {
	/** @type {NwjsService} */
	nwjs: service(),
	/** @type {RouterService} */
	router: service(),
	/** @type {StreamingService} */
	streaming: service(),
	/** @type {SettingsService} */
	settings: service(),
	layout,

	classNames: [ "modal-streaming-component" ],

	/** @type {Stream} */
	modalContext: null,

	error: readOnly( "modalContext.error" ),
	preparing: computed( "modalContext.isPreparing", "modalContext.hasEnded", function() {
		return this.modalContext.isPreparing && !this.modalContext.hasEnded;
	}),

	isLogError: computedError( LogError ),
	isProviderError: computedError( ProviderError ),
	isPlayerError: computedError( PlayerError ),
	isVersionError: computedError( VersionError ),
	isUnableToOpenError: computedError( UnableToOpenError ),
	isNoStreamsFoundError: computedError( NoStreamsFoundError ),
	isTimeoutError: computedError( TimeoutError ),

	errorSettingsRoute: computed( "isPlayerError", "isProviderError", "isVersionError", function() {
		if ( this.isPlayerError ) { return "settings.player"; }
		if ( this.isProviderError || this.isVersionError ) { return "settings.streaming"; }
		return null;
	}),
	errorDetails: computed( "error.message", "isVersionError", function() {
		return this.isVersionError ? null : this.get( "error.message" );
	}),
	diagnosticLog: or( "error.log", "modalContext.log" ),
	hasDiagnostics: or( "diagnosticLog.length", "errorDetails" ),

	qualities,
	pendingQuality: computed( "modalContext", "modalContext.quality", {
		get() { return this.modalContext.quality; },
		set( key, value ) { return value; }
	}),
	qualityChanged: computed( "pendingQuality", "modalContext.quality", function() {
		return this.pendingQuality !== this.modalContext.quality;
	}),

	versionMin: computed( "settings.content.streaming.providerType", function() {
		const type = this.settings.content.streaming.providerType;

		return validationProviders[ type ][ "version" ];
	}),

	providerName: readOnly( "settings.content.streaming.providerName" ),

	_confirmKeyDown: null,

	keyDown( event ) {
		if ( event.repeat ) { return; }
		this._confirmKeyDown = this.modalContext.hasEnded && !isNativeControl( event.target )
			? { code: event.code, context: this.modalContext }
			: null;
	},


	hotkeysNamespace: "modalstreaming",
	hotkeys: {
		/** @this {ModalStreamingComponent} */
		close() {
			if ( this.preparing ) {
				this.send( "abort" );
			} else if ( this.modalContext.hasEnded ) {
				this.send( "shutdown" );
			} else {
				this.send( "close" );
			}
		},
		/** @this {ModalStreamingComponent} */
		confirm( event ) {
			// Enter on a play button can open this dialog before the global keyup handler runs.
			const keyDown = this._confirmKeyDown;
			this._confirmKeyDown = null;
			if (
				   !keyDown
				|| keyDown.code !== event.code
				|| keyDown.context !== this.modalContext
				|| !this.modalContext.hasEnded
				|| isNativeControl( event.target )
			) {
				return;
			}
			this.send( this.errorSettingsRoute ? "openSettings" : "restart" );
		},
		/** @this {ModalStreamingComponent} */
		shutdown() {
			if ( this.preparing ) {
				this.send( "abort" );
			} else {
				this.send( "shutdown" );
			}
		},
		log: "toggleLog"
	},


	actions: {
		/** @this {ModalStreamingComponent} */
		download() {
			const providerType = this.settings.content.streaming.providerType;
			return this.nwjs.openBrowser( downloadUrl[ providerType ] );
		},

		/** @this {ModalStreamingComponent} */
		openSettings() {
			const { errorSettingsRoute, modal, modalContext, modalName, streaming } = this;
			if ( !errorSettingsRoute ) { return; }

			return this.router.transitionTo( errorSettingsRoute ).then(
				() => {
					if ( modalContext.isDestroyed || !modalContext.hasEnded ) { return; }
					streaming.closeStream( modalContext.stream );
					modal.closeModal( modalContext, modalName );
				},
				() => {}
			);
		},

		/** @this {ModalStreamingComponent} */
		abort() {
			const { modalContext } = this;
			if ( !modalContext.isDestroyed ) {
				set( modalContext, "isAborted", true );
				modalContext.destroyRecord();
			}
			this.send( "close" );
		},

		/** @this {ModalStreamingComponent} */
		async shutdown() {
			this.streaming.closeStream( this.modalContext.stream );
			this.send( "close" );
		},

		/** @this {ModalStreamingComponent} */
		restart() {
			const { modalContext } = this;
			if ( modalContext.isDestroyed || !modalContext.hasEnded ) { return; }

			setProperties( modalContext, {
				isPreparing: true,
				error: null,
				log: null,
				showLog: false,
				warning: false
			});
			return this.streaming.launchStream( modalContext ).catch( () => {} );
		},

		/** @this {ModalStreamingComponent} */
		applyQuality() {
			if ( this.modalContext.isWatching && this.qualityChanged ) {
				set( this.modalContext, "quality", this.pendingQuality );
			}
		},

		/** @this {ModalStreamingComponent} */
		toggleLog() {
			const { modalContext } = this;
			if ( !modalContext.isDestroyed && !this.preparing && this.hasDiagnostics ) {
				modalContext.toggleProperty( "showLog" );
			}
		}
	}
});
