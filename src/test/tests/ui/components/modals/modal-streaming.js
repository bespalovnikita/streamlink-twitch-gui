import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";
import { click, render, triggerEvent } from "@ember/test-helpers";
import hbs from "htmlbars-inline-precompile";
import { buildResolver } from "test-utils";
import { FakeIntlService, FakeTHelper } from "intl-utils";
import { setupKeyboardLayoutMap } from "keyboard-layout-map";
import { run } from "@ember/runloop";
import Service from "@ember/service";
import Component from "@ember/component";
import EmberObject, { computed } from "@ember/object";
import sinon from "sinon";

import { PlayerError, ProviderError, VersionError } from "services/streaming/errors";
import HotkeyService from "services/hotkey";
import ModalService from "services/modal";
import ModalServiceComponent from "ui/components/modal/modal-service/component";
import ModalHeaderComponent from "ui/components/modal/modal-header/component";
import ModalBodyComponent from "ui/components/modal/modal-body/component";
import ModalFooterComponent from "ui/components/modal/modal-footer/component";
import ModalStreamingComponent from "ui/components/modal/modal-streaming/component";
import { helper as BoolOrHelper } from "ui/components/helper/bool-or";
import { helper as IsEqualHelper } from "ui/components/helper/is-equal";
import { helper as HotkeyTitleHelper } from "ui/components/helper/hotkey-title";


module( "ui/components/modals/modal-streaming", function( hooks ) {
	setupRenderingTest( hooks, {
		resolver: buildResolver({
			IntlService: FakeIntlService,
			THelper: FakeTHelper,
			HotkeyService,
			ModalService,
			ModalServiceComponent,
			ModalHeaderComponent,
			ModalBodyComponent,
			ModalFooterComponent,
			ModalStreamingComponent,
			BoolOrHelper,
			IsEqualHelper,
			HotkeyTitleHelper,
			LinkToComponent: Component.extend({ tagName: "a", layout: hbs`{{yield}}` }),
			LoadingSpinnerComponent: Component.extend(),
			StatsRowComponent: Component.extend(),
			EmbeddedLinksComponent: Component.extend(),
			OpenChatComponent: Component.extend(),
			TwitchEmotesComponent: Component.extend(),
			ShareChannelComponent: Component.extend(),
			ChannelButtonComponent: Component.extend()
		})
	});
	setupKeyboardLayoutMap( hooks );

	hooks.beforeEach(function() {
		this.transitionTo = sinon.stub().resolves();
		this.closeStream = sinon.spy();
		this.launchStream = sinon.stub().resolves();
		this.openBrowser = sinon.spy();
		this.owner.register( "service:router", Service.extend({
			transitionTo: this.transitionTo
		}) );
		this.owner.register( "service:streaming", Service.extend({
			closeStream: this.closeStream,
			launchStream: this.launchStream
		}) );
		this.owner.register( "service:nwjs", Service.extend({ openBrowser: this.openBrowser }) );
		this.owner.register( "service:settings", Service.extend({
			one() {},
			on() {},
			content: {
				streaming: { providerType: "streamlink", providerName: "Streamlink" }
			}
		}) );

		this.context = EmberObject.create({
			user: { id: "1", detailedName: "Channel" },
			stream: { id: "1" },
			isPreparing: true,
			hasEnded: computed( "error", "isPreparing", "isWatching", function() {
				return !!this.error || !( this.isPreparing || this.isWatching );
			}),
			showLog: false,
			quality: "source"
		});
		this.open = async () => {
			await render( hbs`
				<button type="button" class="outside">Play</button>
				{{modal-service}}
			` );
			const hotkey = this.owner.lookup( "service:hotkey" );
			this.element.addEventListener( "keyup", e => hotkey.trigger( e ) );
			const modal = this.owner.lookup( "service:modal" );
			run( () => modal.openModal( "streaming", this.context ) );
			return this.element.querySelector( ".modal-streaming-component" );
		};
	});

	test( "A provider lookup failure shows recovery before launch", async function( assert ) {
		this.context.set( "error", new ProviderError( "Executable missing", new Error( "PATH" ) ) );
		const dialog = await this.open();
		const toggle = dialog.querySelector( ".streaming-log-toggle" );
		const primary = dialog.querySelector( ".state-action-primary" );
		assert.ok( primary.textContent.includes( "modal.streaming.action.provider-settings" ) );
		assert.strictEqual( toggle.getAttribute( "aria-expanded" ), "false" );
		assert.notOk( dialog.textContent.includes( "PATH" ), "Technical details are hidden" );
		await click( toggle );
		assert.strictEqual( toggle.getAttribute( "aria-expanded" ), "true" );
		assert.ok( dialog.textContent.includes( "PATH" ), "The nested error is available" );
		await click( primary );
		assert.ok( this.transitionTo.calledOnceWithExactly( "settings.streaming" ) );
		assert.ok( this.closeStream.calledOnceWithExactly( this.context.stream ) );
	});

	test( "A player error routes to player settings by key", async function( assert ) {
		this.context.set( "error", new PlayerError( "Executable missing" ) );
		const dialog = await this.open();
		const outside = this.element.querySelector( ".outside" );
		const enter = { key: "Enter", code: "Enter" };

		await triggerEvent( outside, "keyup", enter );
		assert.notOk( this.transitionTo.called, "Entering the dialog does not confirm it" );
		await triggerEvent( dialog, "keydown", enter );
		await triggerEvent( dialog, "keyup", enter );
		assert.ok( this.transitionTo.calledOnceWithExactly( "settings.player" ) );
		assert.notOk( this.launchStream.called, "Confirmation does not restart an invalid player" );
	});

	test( "Version errors retain official download help", async function( assert ) {
		this.context.set( "error", new VersionError( "1.0.0" ) );
		const dialog = await this.open();
		const download = Array.from( dialog.querySelectorAll( "button" ) ).find( button =>
			button.textContent.includes( "modal.streaming.action.download" )
		);
		assert.notOk( dialog.textContent.includes( "modal.streaming.action.restart" ) );
		await click( download );
		assert.ok( this.openBrowser.calledOnce );
	});

	test( "Unmatched and native Enter events never trigger Restart", async function( assert ) {
		this.context.set( "error", new Error( "The provider ended" ) );
		const dialog = await this.open();
		const primary = dialog.querySelector( ".state-action-primary" );
		const enter = { key: "Enter", code: "Enter" };

		await triggerEvent( dialog, "keyup", enter );
		await triggerEvent( primary, "keydown", enter );
		await triggerEvent( dialog, "keyup", enter );
		assert.notOk( this.launchStream.called, "Opening or native button Enter cannot restart" );

		await triggerEvent( dialog, "keydown", enter );
		await triggerEvent( dialog, "keyup", enter );
		assert.ok( this.launchStream.calledOnceWithExactly( this.context ) );
		assert.notOk( this.context.hasEnded, "Retry returns to preparation" );
	});

	test( "Quality selection takes effect only when applied", async function( assert ) {
		this.context.setProperties({ isPreparing: false, isWatching: true });
		const dialog = await this.open();
		const select = dialog.querySelector( "select" );
		const apply = dialog.querySelector( ".streaming-quality-controls button" );
		assert.strictEqual( select.value, "source" );
		assert.ok( apply.disabled );

		select.value = "high";
		await triggerEvent( select, "change" );
		assert.strictEqual( this.context.quality, "source", "Selection does not restart playback" );
		assert.notOk( apply.disabled );
		await click( apply );
		assert.strictEqual( this.context.quality, "high" );
		assert.ok( apply.disabled );
	});
});
