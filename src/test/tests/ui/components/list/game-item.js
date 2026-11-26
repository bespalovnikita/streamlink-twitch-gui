import { module, test } from "qunit";
import { setupApplicationTest } from "ember-qunit";
import { click, currentURL, visit } from "@ember/test-helpers";
import { buildFakeApplication } from "test-utils";
import hbs from "htmlbars-inline-precompile";

import Route from "@ember/routing/route";
import Router from "@ember/routing/router";
import Service from "@ember/service";

import GameItemComponent from "ui/components/list/game-item/component";
import LinkToComponent from "ui/components/link/link-to/component";
import PreviewImageComponent from "ui/components/preview-image/component";


module( "ui/components/list/game-item", function( hooks ) {
	buildFakeApplication( hooks, {
		Router: Router.extend({ location: "none" }).map(function() {
			this.route( "games", function() {
				this.route( "game", { path: "/:game_id" } );
			});
		}),
		IndexRoute: class extends Route {
			model() {
				return { id: "29595", name: "Dota 2" };
			}
		},
		IndexTemplate: hbs`<ul>{{game-item content=model}}</ul>`,
		GamesGameRoute: class extends Route {
			model({ game_id: id }) {
				return { id };
			}
		},
		GameItemComponent,
		LinkToComponent,
		PreviewImageComponent
	});

	setupApplicationTest( hooks );

	hooks.beforeEach(function() {
		this.owner.register( "service:settings", Service.extend() );
	});

	test( "The cover and name link to the category", async function( assert ) {
		await visit( "/" );
		const link = this.element.querySelector( ".game-item-component > a" );
		assert.strictEqual( link.getAttribute( "href" ), "/games/29595" );
		assert.strictEqual( link.tabIndex, 0 );
		assert.strictEqual( link.querySelector( ".game-title" ).innerText, "Dota 2" );
		await click( link.querySelector( ".game-cover" ) );
		assert.strictEqual( currentURL(), "/games/29595" );
	});
});
