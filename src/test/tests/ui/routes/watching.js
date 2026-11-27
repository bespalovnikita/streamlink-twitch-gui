import { module, test } from "qunit";
import { setupApplicationTest } from "ember-qunit";
import { buildFakeApplication } from "test-utils";
import { FakeIntlService, FakeTHelper } from "intl-utils";
import { click, currentRouteName, visit } from "@ember/test-helpers";
import sinon from "sinon";

import { A } from "@ember/array";
import Component from "@ember/component";
import EmberObject from "@ember/object";
import Router from "@ember/routing/router";
import { run } from "@ember/runloop";
import Service from "@ember/service";

import LinkToComponent from "ui/components/link/link-to/component";
import StreamPresentationComponent from "ui/components/stream/stream-presentation/component";
import WatchingController from "ui/routes/watching/controller";
import WatchingRoute from "ui/routes/watching/route";
import WatchingTemplate from "ui/routes/watching/template.hbs";


module( "ui/routes/watching", function( hooks ) {
	buildFakeApplication( hooks, {
		Router: Router.extend({ location: "none" }).map(function() {
			this.route( "watching" );
			this.route( "streams" );
			this.route( "channel", { path: "/channel/:id" } );
			this.route( "games", function() {
				this.route( "game", { path: "/:id" } );
			});
			this.route( "user", function() {
				this.route( "followedStreams" );
			});
		}),
		WatchingController,
		WatchingRoute,
		WatchingTemplate,
		LinkToComponent,
		StreamPresentationComponent,
		PreviewImageComponent: Component.extend(),
		EmbeddedLinksComponent: Component.extend(),
		OpenChatComponent: Component.extend({ tagName: "button", classNames: [ "test-chat" ] }),
		ShareChannelComponent: Component.extend({
			tagName: "button",
			classNames: [ "test-share" ]
		}),
		SettingsService: Service.extend({ gui: { focusrefresh: 0 } }),
		IntlService: FakeIntlService,
		THelper: FakeTHelper
	});

	setupApplicationTest( hooks );

	hooks.beforeEach(function() {
		this.model = A();
		this.openModal = sinon.spy();
		this.closeStream = sinon.spy();
		this.owner.register( "service:auth", Service.extend({ session: { isLoggedIn: false } }) );
		this.owner.register( "service:modal", Service.extend({ openModal: this.openModal }) );
		this.owner.register( "service:streaming", Service.extend({
			model: this.model,
			closeStream: this.closeStream
		}) );
	});

	test( "Empty view has a focusable route back to discovery", async function( assert ) {
		await visit( "/watching" );
		const action = this.element.querySelector( ".state-action-primary" );
		assert.strictEqual( action.tabIndex, 0, "Browse action is in the keyboard tab order" );
		assert.notOk( this.element.querySelector( ".state-action:not(.state-action-primary)" ) );
		await click( action );
		assert.strictEqual( currentRouteName(), "streams" );
	});

	test( "Empty view offers followed streams when signed in", async function( assert ) {
		run( () => this.owner.lookup( "service:auth" ).set( "session.isLoggedIn", true ) );
		await visit( "/watching" );
		const action = this.element.querySelector( ".state-action:not(.state-action-primary)" );
		assert.strictEqual( action.tabIndex, 0, "Followed streams action is in the tab order" );
		await click( action );
		assert.strictEqual( currentRouteName(), "user.followedStreams" );
	});

	test( "Session status drives playback controls", async function( assert ) {
		const stream = { title: "Stream title", game_id: "7", game_name: "Category" };
		const session = EmberObject.create({
			stream,
			user: { id: "12", detailedName: "Streamer" },
			started: new Date( 0 ),
			isPreparing: true,
			streamQualityPreset: { id: "high" }
		});
		this.model.pushObject( session );
		await visit( "/watching" );

		const row = this.element.querySelector( "li.stream-presentation-component" );
		const status = () => row.querySelector( "[role=status]" ).textContent.trim();
		const close = () => row.querySelector( ".watching-close" );
		assert.strictEqual( status(), "routes.watching.status.pending" );
		assert.notOk( close(), "A session being prepared cannot be stopped from this view" );
		assert.notOk( row.querySelector( ".watching-quality" ), "Shows quality after preparation" );
		assert.ok( row.querySelector( ".test-chat" ), "Chat stays available" );
		assert.ok( row.querySelector( ".test-share" ), "Sharing stays available" );

		await click( row.querySelector( ".watching-details" ) );
		assert.ok( this.openModal.calledOnceWithExactly( "streaming", session ) );

		run( () => session.setProperties({ isPreparing: false, isLaunching: true }) );
		assert.strictEqual( status(), "routes.watching.status.starting" );
		const quality = row.querySelector( ".watching-quality" );
		assert.ok( quality.textContent.includes( "qualities.high" ) );
		assert.notOk( row.querySelector( "select, .drop-down-component" ) );
		assert.strictEqual( close().textContent.trim(), "routes.watching.buttons.close" );
		await click( close() );
		assert.ok( this.closeStream.calledOnceWithExactly( stream ) );

		run( () => session.setProperties({ isLaunching: false, isWatching: true }) );
		assert.strictEqual( status(), "routes.watching.status.playing" );
		run( () => session.setProperties({ isWatching: false, hasEnded: true }) );
		assert.strictEqual( status(), "routes.watching.status.ended" );
		assert.strictEqual( close().textContent.trim(), "routes.watching.buttons.dismiss" );
		run( () => session.set( "error", new Error( "Player failed" ) ) );
		assert.strictEqual( status(), "routes.watching.status.failed" );
		await click( close() );
		assert.ok( this.closeStream.secondCall.calledWithExactly( stream ) );
	});
});
