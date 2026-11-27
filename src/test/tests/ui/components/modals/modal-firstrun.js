import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";
import { click, render } from "@ember/test-helpers";
import hbs from "htmlbars-inline-precompile";
import { buildResolver } from "test-utils";
import { FakeIntlService, FakeTHelper } from "intl-utils";
import { run } from "@ember/runloop";
import Service from "@ember/service";
import sinon from "sinon";
import ModalService from "services/modal";
import ModalServiceComponent from "ui/components/modal/modal-service/component";
import ModalHeaderComponent from "ui/components/modal/modal-header/component";
import ModalBodyComponent from "ui/components/modal/modal-body/component";
import ModalFooterComponent from "ui/components/modal/modal-footer/component";
import ModalFirstrunComponent from "ui/components/modal/modal-firstrun/component";


module( "ui/components/modals/modal-firstrun", function( hooks ) {
	setupRenderingTest( hooks, {
		resolver: buildResolver({
			IntlService: FakeIntlService,
			THelper: FakeTHelper,
			HotkeyService: Service.extend({ register() {}, unregister() {} }),
			ModalService,
			ModalServiceComponent,
			ModalHeaderComponent,
			ModalBodyComponent,
			ModalFooterComponent,
			ModalFirstrunComponent
		})
	});
	hooks.beforeEach(function() {
		this.transitionTo = sinon.spy();
		this.owner.register( "service:router", Service.extend({
			transitionTo: this.transitionTo
		}) );
	});

	for ( const [ action, route ] of [
		[ "streamlink", "settings.streaming" ],
		[ "player", "settings.player" ],
		[ "start", null ]
	] ) {
		test( `Closes first-run setup after ${action}`, async function( assert ) {
			await render( hbs`{{modal-service}}` );
			const modal = this.owner.lookup( "service:modal" );
			const context = {};
			const closed = run( () => modal.promiseModal( "firstrun", context ) );
			const buttons = this.element.querySelectorAll( ".modal-firstrun-component button" );
			const button = Array.from( buttons ).find( item =>
				item.textContent.trim() === `modal.firstrun.action.${action}`
			);
			await click( button );

			assert.notOk( modal.hasModal( "firstrun", context ) );
			assert.propEqual( this.transitionTo.args, route ? [ [ route ] ] : [] );
			await closed;
		});
	}
});
