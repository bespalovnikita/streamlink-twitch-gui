import Component from "@ember/component";
import { inject as service } from "@ember/service";
import layout from "./template.hbs";
import "./styles.less";


const focusableSelector = "a[href], button, input, select, textarea, summary, [tabindex]";


export default Component.extend({
	/** @type {ModalService} */
	modal: service(),

	layout,
	classNames: "modal-service-component",
	classNameBindings: [ "modal.isModalOpened:active" ],

	_activeDialog: null,
	_focusOrigin: null,
	_blockedShell: null,

	didRender() {
		this._super( ...arguments );
		const { element, _activeDialog } = this;
		const dialog = element.querySelector( ".modal-dialog-component:not(.fadeOut)" );
		if ( dialog === _activeDialog ) {
			if ( dialog && !dialog.contains( element.ownerDocument.activeElement ) ) {
				dialog.focus({ preventScroll: true });
			}
			return;
		}

		this._activeDialog = dialog;
		if ( dialog ) {
			if ( !_activeDialog ) {
				this._focusOrigin = element.ownerDocument.activeElement;
				this._blockedShell = Array.from( element.parentNode.children )
					.filter( part => part.classList.contains( "app-shell-part" ) && !part.inert );
				this._blockedShell.forEach( part => { part.inert = true; } );
			}
			dialog.focus({ preventScroll: true });
		} else {
			this._restorePage();
		}
	},

	willDestroyElement() {
		this._super( ...arguments );
		this._restorePage();
	},

	_restorePage() {
		if ( this._blockedShell ) {
			this._blockedShell.forEach( part => { part.inert = false; } );
			this._blockedShell = null;
		}
		const origin = this._focusOrigin;
		this._focusOrigin = null;
		if ( origin && origin.isConnected ) {
			origin.focus({ preventScroll: true });
		}
	},

	mouseDown( event ) {
		if ( this._activeDialog && event.target === this.element ) {
			event.preventDefault();
		}
	},

	keyDown( event ) {
		const dialog = this._activeDialog;
		if ( event.key !== "Tab" || !dialog ) { return; }

		const { activeElement, defaultView } = dialog.ownerDocument;
		const controls = Array.from( dialog.querySelectorAll( focusableSelector ) )
			.filter( control =>
				   control.tabIndex >= 0
				&& !control.matches( ":disabled" )
				&& !control.closest( "[inert]" )
				&& control.getClientRects().length > 0
				&& defaultView.getComputedStyle( control ).visibility === "visible"
			);
		const edge = event.shiftKey ? controls[0] : controls[ controls.length - 1 ];
		if ( activeElement === edge || !controls.includes( activeElement ) ) {
			event.preventDefault();
			const next = event.shiftKey ? controls[ controls.length - 1 ] : controls[0];
			( next || dialog ).focus();
		}
	}
});
