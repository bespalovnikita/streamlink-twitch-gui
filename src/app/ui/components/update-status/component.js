import Component from "@ember/component";
import { inject as service } from "@ember/service";
import layout from "./template.hbs";
import "./styles.less";


export default Component.extend({
	versioncheck: service(),
	layout,
	classNames: [ "update-status-component" ],
	showCheck: true,
	_input: null,
	_inputChange: null,

	didInsertElement() {
		this._super( ...arguments );
		if ( !this.showCheck ) { return; }
		const input = this.element.ownerDocument.createElement( "input" );
		input.classList.add( "hidden" );
		input.setAttribute( "type", "file" );
		input.setAttribute( "tabindex", "-1" );
		input.setAttribute( "accept", ".json,application/json" );
		input.setAttribute( "nwsaveas", "streamlink-twitch-gui-update-diagnostics.json" );
		this._inputChange = () => {
			const destination = input.value;
			input.value = "";
			if ( destination ) { this.versioncheck.exportDiagnostics( destination ); }
		};
		input.addEventListener( "change", this._inputChange );
		this.element.appendChild( input );
		this._input = input;
	},
	willDestroyElement() {
		if ( this._input ) {
			this._input.removeEventListener( "change", this._inputChange );
			this._input = null;
			this._inputChange = null;
		}
		this._super( ...arguments );
	},

	actions: {
		check() { return this.versioncheck.checkNow(); },
		download() { return this.versioncheck.download(); },
		cancel() { this.versioncheck.cancelDownload(); },
		restart() { return this.versioncheck.requestInstall(); },
		history() { return this.versioncheck.showHistory(); },
		export() {
			if ( this._input && !this.versioncheck.diagnosticsBusy ) { this._input.click(); }
		}
	}
});
