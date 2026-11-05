import { module, test } from "qunit";
import { setupApplicationTest } from "ember-qunit";
import { buildFakeApplication } from "test-utils";
import { setupStore } from "store-utils";
import { settled, visit } from "@ember/test-helpers";
import sinon from "sinon";

import { set } from "@ember/object";
import { sendEvent } from "@ember/object/events";
import { run } from "@ember/runloop";
import Router from "@ember/routing/router";
import Service from "@ember/service";

import followedStreamsRouteInjector
	from "inject-loader?timers!ui/routes/user/followed-streams/route";


const { default: UserFollowedStreamsRoute } = followedStreamsRouteInjector({
	timers: {
		setInterval: ( ...args ) => window.setInterval( ...args ),
		clearInterval: ( ...args ) => window.clearInterval( ...args )
	}
});


module( "ui/routes/user/followed-streams/route", function( hooks ) {
	buildFakeApplication( hooks, {
		Router: Router.extend({
			location: "none"
		}).map(function() {
			this.route( "other" );
			this.route( "user", function() {
				this.route( "followed-streams" );
			});
		}),

		UserFollowedStreamsRoute,
		AuthService: Service.extend({
			session: {
				isLoggedIn: true,
				user_id: "123"
			}
		}),
		ModalService: Service.extend({
			isModalOpened: false
		}),
		SettingsService: Service.extend()
	});

	setupApplicationTest( hooks );

	hooks.beforeEach(function() {
		const { store } = setupStore( this.owner );
		this.clock = sinon.useFakeTimers({
			global: window,
			toFake: [ "setInterval", "clearInterval" ]
		});
		this.route = this.owner.lookup( "route:user.followed-streams" );
		this.records = [];
		this.query = sinon.stub( store, "query" ).callsFake( async () => this.records );
		sinon.stub( this.route, "calcFetchSize" ).returns( 2 );
		sinon.stub( this.route, "preload" ).returnsArg( 0 );
		sinon.stub( this.route, "modelItemLoader" ).resolves();
	});

	hooks.afterEach(function() {
		this.clock.restore();
	});


	test( "Refreshes the open list every ten seconds from page one", async function( assert ) {
		await visit( "/other" );
		this.clock.tick( 30000 );
		assert.notOk( this.query.called, "Does not query while another section is open" );

		this.records = [{ stream: { id: "old" } }];
		this.records.meta = { pagination: { cursor: "next-page" } };
		await visit( "/user/followed-streams" );
		assert.deepEqual( this.route.controller.model.mapBy( "id" ), [ "old" ] );
		assert.strictEqual( this.route.paginationCursor, "next-page" );

		this.records = [{ stream: { id: "new" } }];
		this.clock.tick( 9999 );
		assert.ok( this.query.calledOnce, "Does not refresh before ten seconds" );
		this.clock.tick( 1 );
		await settled();

		assert.strictEqual( this.query.callCount, 2, "Refreshes after ten seconds" );
		assert.deepEqual( this.query.lastCall.args, [
			"twitch-stream-followed", { first: 2, user_id: "123" }
		], "Resets the pagination cursor when refreshing" );
		assert.deepEqual( this.route.controller.model.mapBy( "id" ), [ "new" ],
			"Replaces the list, adding new streams and removing ended streams" );

		this.clock.tick( 10000 );
		await settled();
		assert.strictEqual( this.query.callCount, 3, "Continues refreshing periodically" );
	});

	test( "Stops on leaving and starts one timer on returning", async function( assert ) {
		await visit( "/user/followed-streams" );
		await visit( "/other" );
		this.clock.tick( 30000 );
		await settled();
		assert.ok( this.query.calledOnce, "Does not refresh after leaving the section" );

		await visit( "/user/followed-streams" );
		sendEvent( this.route, "activate" );
		this.clock.tick( 10000 );
		await settled();
		assert.strictEqual( this.query.callCount, 3, "Returning creates only one refresh timer" );
	});

	test( "Skips modal dialogs and pagination requests", async function( assert ) {
		await visit( "/user/followed-streams" );
		set( this.route, "modal.isModalOpened", true );
		this.clock.tick( 10000 );
		await settled();
		assert.ok( this.query.calledOnce, "Does not refresh while a modal dialog is open" );

		set( this.route, "modal.isModalOpened", false );
		set( this.route.controller, "isFetching", true );
		this.clock.tick( 10000 );
		await settled();
		assert.ok( this.query.calledOnce, "Does not refresh while fetching another page" );

		set( this.route.controller, "isFetching", false );
		this.clock.tick( 10000 );
		await settled();
		assert.strictEqual( this.query.callCount, 2, "Resumes refreshing when the list is ready" );
	});

	test( "Does not overlap slow automatic refreshes", async function( assert ) {
		await visit( "/user/followed-streams" );
		let resolve;
		const refresh = sinon.stub( this.route, "refresh" ).returns(
			new Promise( done => { resolve = done; } )
		);
		this.clock.tick( 30000 );
		assert.ok( refresh.calledOnce, "Waits for the outstanding refresh" );

		resolve();
		await settled();
		this.clock.tick( 10000 );
		await settled();
		assert.strictEqual( refresh.callCount, 2, "Refreshes again after completion" );
	});

	test( "Does not overlap a manual refresh", async function( assert ) {
		await visit( "/user/followed-streams" );
		let resolve;
		this.query.onSecondCall().returns( new Promise( done => { resolve = done; } ) );
		const transition = this.route.refresh();
		this.clock.tick( 30000 );
		assert.strictEqual( this.query.callCount, 1, "Does not start an automatic refresh" );

		// Let the router start the manual request before completing it.
		await new Promise( done => window.setTimeout( done, 0 ) );
		assert.strictEqual( this.query.callCount, 2, "Only the manual request is running" );
		resolve( [] );
		await transition;
		await settled();
		this.clock.tick( 10000 );
		await settled();
		assert.strictEqual( this.query.callCount, 3, "Resumes automatic refresh afterwards" );
	});

	test( "Continues after a failed or aborted refresh", async function( assert ) {
		await visit( "/user/followed-streams" );
		const refresh = sinon.stub( this.route, "refresh" ).rejects( new Error( "Aborted" ) );
		this.clock.tick( 10000 );
		await settled();
		this.clock.tick( 10000 );
		await settled();
		assert.strictEqual( refresh.callCount, 2, "Failure does not leave the refresh locked" );
	});

	test( "Clears the timer when destroyed", async function( assert ) {
		await visit( "/user/followed-streams" );
		const refresh = sinon.stub( this.route, "refresh" ).resolves();
		run( () => this.route.destroy() );
		this.clock.tick( 30000 );
		await settled();
		assert.notOk( refresh.called, "Does not refresh after destruction" );
	});
});
