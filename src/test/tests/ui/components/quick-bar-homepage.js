import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";
import { buildResolver } from "test-utils";
import { FakeIntlService, FakeTHelper } from "intl-utils";
import { render, click } from "@ember/test-helpers";
import hbs from "htmlbars-inline-precompile";
import sinon from "sinon";

import EmberObject from "@ember/object";
import { run } from "@ember/runloop";
import Service from "@ember/service";

import QuickBarHomepageComponent from "ui/components/quick/quick-bar-homepage/component";


module( "ui/components/quick-bar-homepage", function( hooks ) {
	setupRenderingTest( hooks, {
		resolver: buildResolver({
			QuickBarHomepageComponent,
			IntlService: FakeIntlService,
			THelper: FakeTHelper
		})
	});

	hooks.beforeEach(function() {
		this.settings = EmberObject.create({
			gui: EmberObject.create({ homepage: "/streams" }),
			save: sinon.stub().resolves()
		});
		this.owner.register( "service:settings", Service.extend({ content: this.settings }) );
		this.owner.register( "service:router", Service.extend({ currentURL: "/games/42" }) );
	});

	test( "Offers the action directly and marks the saved homepage", async function( assert ) {
		await render( hbs`{{quick-bar-homepage}}` );
		const button = this.element.querySelector( ".homepage-action" );
		assert.ok( button instanceof HTMLButtonElement, "Renders a native button" );
		assert.strictEqual( button.getAttribute( "aria-disabled" ), "false" );
		assert.strictEqual( button.textContent.trim(), "components.quick-bar-homepage.title" );

		await click( button );
		assert.strictEqual( this.settings.get( "gui.homepage" ), "/games/42" );
		assert.true( this.settings.save.calledOnce );
		assert.strictEqual( button.getAttribute( "aria-disabled" ), "true" );
		assert.strictEqual( button.textContent.trim(), "settings.main.homepage.title" );

		await click( button );
		assert.true( this.settings.save.calledOnce, "Repeated activation does not write again" );

		run( () => this.owner.lookup( "service:router" ).set( "currentURL", "/games/43" ) );
		assert.strictEqual( button.getAttribute( "aria-disabled" ), "false" );
	});

	test( "Restores the previous homepage and allows retry on failure", async function( assert ) {
		this.settings.save.onFirstCall().rejects( new Error( "Failed to save the homepage" ) );
		await render( hbs`{{quick-bar-homepage}}` );
		const button = this.element.querySelector( ".homepage-action" );

		await click( button );
		assert.strictEqual( this.settings.get( "gui.homepage" ), "/streams" );
		assert.strictEqual( button.getAttribute( "aria-disabled" ), "false" );

		await click( button );
		assert.strictEqual( this.settings.get( "gui.homepage" ), "/games/42" );
		assert.strictEqual( button.getAttribute( "aria-disabled" ), "true" );
	});
});
