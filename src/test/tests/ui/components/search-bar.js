import { module, test } from "qunit";
import { setupRenderingTest, setupTest } from "ember-qunit";
import { buildResolver } from "test-utils";
import { setupStore } from "store-utils";
import { FakeIntlService, FakeTHelper } from "intl-utils";
import { click, fillIn, focus, render, settled, triggerEvent } from "@ember/test-helpers";
import { triggerKeyDownEvent } from "event-utils";
import hbs from "htmlbars-inline-precompile";
import sinon from "sinon";

import { A } from "@ember/array";
import { observer } from "@ember/object";
import { run } from "@ember/runloop";
import Service from "@ember/service";
import Adapter from "ember-data/adapter";

import searchBarComponentInjector from "inject-loader?config!ui/components/search-bar/component";
import Search from "data/models/search/model";
import SearchBarService from "services/search-bar";
import { helper as IsEqualHelper } from "ui/components/helper/is-equal";
import { helper as TimeFromNowHelper } from "ui/components/helper/time-from-now";
import SearchController from "ui/routes/search/controller";


module( "ui/components/search-bar", function( hooks ) {
	setupTest( hooks, {
		resolver: buildResolver({
			IntlService: FakeIntlService,
			HotkeyService: Service.extend(),
			RouterService: Service.extend(),
			SearchBarService,
			Search
		})
	});

	/** @typedef {TestContext} TestContextSearchBarComponent */
	/** @this TestContextSearchBarComponent */
	hooks.beforeEach(function() {
		this.fakeTimer = sinon.useFakeTimers({
			toFake: [ "Date" ],
			global: window
		});
		this.fakeTimer.setSystemTime( 0 );

		setupStore( this.owner );

		let onModelInitResolve = new Function();
		const onModelInitPromise = new Promise( resolve => onModelInitResolve = resolve );
		const { default: FakeSearchBarComponent } = searchBarComponentInjector({
			config: {
				vars: {
					"search-history-size": 3
				}
			}
		});
		this.owner.register( "component:search-bar", FakeSearchBarComponent.extend({
			_modelInitObserver: observer( "model", () => onModelInitResolve() )
		}) );

		this.findAllStub = sinon.stub().resolves([]);
		this.createRecordStub = sinon.stub().resolves();
		this.updateRecordStub = sinon.stub().resolves();
		this.deleteRecordStub = sinon.stub().resolves();
		this.owner.register( "adapter:search", Adapter.extend({
			shouldReloadAll: () => false,
			shouldBackgroundReloadAll: () => false,
			findAll: this.findAllStub,
			createRecord: this.createRecordStub,
			updateRecord: this.updateRecordStub,
			deleteRecord: this.deleteRecordStub
		}) );

		/** @type {DS.Store} */
		this.store = this.owner.lookup( "service:store" );

		/** @return {Search|DS.Model} */
		this.push = ( id, attributes ) => this.store.push({
			data: { id, type: "search", attributes }
		});

		/** @return {Promise<SearchBarComponent>} */
		this.subject = async () => {
			const subject = this.owner.lookup( "component:search-bar" );
			await onModelInitPromise;
			return subject;
		};
	});

	hooks.afterEach(function() {
		this.fakeTimer.restore();
	});


	/** @this TestContextSearchBarComponent */
	test( "addRecord - update existing", async function( assert ) {
		const records = [
			this.push( "1", { filter: "all", query: "foo", date: new Date( 1000 ) }),
			this.push( "2", { filter: "all", query: "bar", date: new Date( 2000 ) })
		];
		this.findAllStub.resolves( records );

		const subject = await this.subject();

		assert.propEqual(
			subject.model.mapBy( "id" ),
			[ "1", "2" ],
			"Has all Search models loaded"
		);
		assert.notOk( this.updateRecordStub.called, "Hasn't called updateRecord yet" );

		this.fakeTimer.tick( 3000 );
		await subject.addRecord( "foo", "all" );
		assert.propEqual(
			this.updateRecordStub.args.flatMap( args => args[2].id ),
			[ "1" ],
			"Updates the first record"
		);
		assert.strictEqual( +records[0].date, 3000, "Updates the date of the first record" );
		assert.notOk( this.deleteRecordStub.called, "Doesn't delete any records" );
		assert.notOk( this.createRecordStub.called, "Doesn't create any records" );
	});

	/** @this TestContextSearchBarComponent */
	test( "addRecord - create new and remove old ones", async function( assert ) {
		const records = [
			this.push( "1", { filter: "all", query: "foo", date: new Date( 1000 ) }),
			this.push( "2", { filter: "all", query: "bar", date: new Date( 4000 ) }),
			this.push( "3", { filter: "all", query: "baz", date: new Date( 3000 ) }),
			this.push( "4", { filter: "all", query: "qux", date: new Date( 2000 ) })
		];
		this.findAllStub.resolves( records );

		const subject = await this.subject();

		assert.propEqual(
			subject.model.mapBy( "id" ),
			[ "1", "2", "3", "4" ],
			"Has all Search models loaded"
		);

		this.fakeTimer.tick( 5000 );
		await subject.addRecord( "foo", "channels" );
		assert.notOk( this.updateRecordStub.called, "Doesn't update any records" );
		assert.propEqual(
			this.deleteRecordStub.args.map( args => args[2].id ),
			[ "1", "4" ],
			"Deletes old records to make space for the new one"
		);
		assert.propEqual(
			this.createRecordStub.args.map( args => args[2].record.toJSON({ includeId: true }) ),
			[
				{
					id: "5",
					filter: "channels",
					query: "foo",
					date: "1970-01-01T00:00:05.000Z"
				}
			],
			"Creates a new record with correct attributes"
		);
		assert.propEqual(
			subject.model.toArray().map( record => record.id ),
			[ "2", "3", "5" ],
			"Component model gets updated accordingly"
		);
		assert.propEqual(
			this.store.peekAll( "search" ).map( record => record.id ),
			[ "2", "3", "5" ],
			"Store only has the right records loaded"
		);
	});
});


module( "ui/components/search-bar rendering", function( hooks ) {
	const { default: SearchBarComponent } = searchBarComponentInjector({
		config: { vars: { "search-history-size": 3 } }
	});

	setupRenderingTest( hooks, {
		resolver: buildResolver({
			IntlService: FakeIntlService,
			IsEqualHelper,
			SearchBarService,
			SearchController,
			THelper: FakeTHelper,
			TimeFromNowHelper
		})
	});

	hooks.beforeEach(function() {
		const history = this.history = A();
		this.transitionTo = sinon.spy();

		this.owner.register( "component:search-bar", SearchBarComponent.extend({
			addRecord() {},
			deleteAllRecords() {
				history.clear();
			}
		}) );
		this.owner.register( "service:hotkey", Service.extend({ register() {}, unregister() {} }) );
		this.owner.register( "service:router", Service.extend({
			transitionTo: this.transitionTo
		}) );
		this.owner.register( "service:store", Service.extend({
			findAll: () => Promise.resolve( history )
		}) );
	});

	test( "filter disclosure closes on Escape or leaving the search box", async function( assert ) {
		await render( hbs`
			{{search-bar}}
			<button type="button" class="outside">Outside</button>
		` );
		const button = this.element.querySelector( ".btn-dropdown" );
		const dropdown = this.element.querySelector( ".searchbar-dropdown" );
		const input = this.element.querySelector( "input[type='search']" );

		assert.strictEqual(
			input.getAttribute( "aria-label" ),
			"components.search-bar.placeholder"
		);
		assert.strictEqual( button.getAttribute( "aria-controls" ), dropdown.id );
		assert.strictEqual( button.getAttribute( "aria-expanded" ), "false" );
		await click( button );
		assert.strictEqual( button.getAttribute( "aria-expanded" ), "true" );

		const radio = dropdown.querySelector( "input:checked" );
		assert.strictEqual( radio.value, "all" );
		await focus( radio );
		await triggerKeyDownEvent( radio, "Escape" );
		assert.strictEqual( button.getAttribute( "aria-expanded" ), "false" );
		assert.strictEqual( document.activeElement, button );

		await click( button );
		const outside = this.element.querySelector( ".outside" );
		// Hidden NW.js windows do not emit focusout when changing focus programmatically.
		await triggerEvent( button, "focusout", { relatedTarget: outside } );
		assert.strictEqual( button.getAttribute( "aria-expanded" ), "false", "Closes on focusout" );

		await click( button );
		await click( outside );
		assert.strictEqual(
			button.getAttribute( "aria-expanded" ),
			"false",
			"Closes on outside click"
		);
		assert.strictEqual( document.activeElement, outside );
	});

	test( "submit and retry history entries without losing focus", async function( assert ) {
		this.history.pushObject({ query: "example", filter: "games", date: new Date() });
		await render( hbs`{{search-bar}}` );
		const button = this.element.querySelector( ".btn-dropdown" );

		await click( button );
		const retry = this.element.querySelector( ".recent li > button" );
		await click( retry );
		assert.propEqual(
			this.transitionTo.lastCall.args,
			[ "search", { queryParams: { query: "example", filter: "games" } } ]
		);
		assert.strictEqual( document.activeElement, button );

		await click( button );
		await click( ".recent .clear" );
		assert.strictEqual( this.history.length, 0 );
		assert.strictEqual( document.activeElement, button );

		await click( ".search-filters input[value='games']" );
		await fillIn( "input[type='search']", "game name" );
		await click( ".btn-search" );
		assert.propEqual(
			this.transitionTo.lastCall.args,
			[ "search", { queryParams: { query: "game name", filter: "games" } } ]
		);

		await fillIn( "input[type='search']", "https://twitch.tv/example" );
		await click( ".btn-search" );
		assert.propEqual(
			this.transitionTo.lastCall.args,
			[ "search", { queryParams: { query: "example", filter: "channels" } } ]
		);
	});

	test( "empty search recovery uses the current route query", async function( assert ) {
		const controller = this.owner.lookup( "controller:search" );
		controller.setProperties({ query: "no match & spaces", filter: "games" });
		await render( hbs`{{search-bar}}` );

		run( () => controller.send( "searchAll" ) );
		assert.propEqual(
			this.transitionTo.lastCall.args,
			[ "search", { queryParams: { query: "no match & spaces", filter: "all" } } ]
		);

		await fillIn( "input[type='search']", "other draft" );
		await click( ".btn-dropdown" );
		await click( ".search-filters input[value='games']" );
		run( () => {
			controller.set( "filter", "all" );
			controller.send( "editQuery" );
		});
		await settled();

		const field = this.element.querySelector( "input[type='search']" );
		assert.strictEqual( field.value, "no match & spaces", "Restores the displayed query" );
		assert.strictEqual( document.activeElement, field, "Focuses the editable query" );
		assert.strictEqual(
			this.element.querySelector( ".btn-dropdown" ).getAttribute( "aria-expanded" ),
			"false",
			"Closes the filters before editing"
		);
		assert.strictEqual(
			this.element.querySelector( ".search-filters input:checked" ).value,
			"all",
			"Restores the displayed filter"
		);
		assert.ok( this.transitionTo.calledOnce, "Editing does not rerun the search" );
	});
});
