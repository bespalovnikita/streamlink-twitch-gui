import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";
import { buildResolver } from "test-utils";
import { render } from "@ember/test-helpers";
import hbs from "htmlbars-inline-precompile";

import { set } from "@ember/object";
import Service from "@ember/service";
import Component from "@ember/component";
import { helper } from "@ember/component/helper";
import StreamPreviewImageComponent from "ui/components/stream/stream-preview-image/component";
import PreviewImageComponent from "ui/components/preview-image/component";
import { helper as BoolNotHelper } from "ui/components/helper/bool-not";
import { helper as BoolOrHelper } from "ui/components/helper/bool-or";
import { helper as FormatViewersHelper } from "ui/components/helper/format-viewers";
import { FakeIntlService, FakeTHelper } from "intl-utils";

import StreamItemComponent from "ui/components/list/stream-item/component";
import {
	ATTR_STREAMS_LANGUAGES_FADE,
	ATTR_STREAMS_LANGUAGES_FILTER
} from "data/models/settings/streams/fragment";


// TODO: finish stream-item-component tests
module( "ui/components/list/stream-item", function( hooks ) {
	setupRenderingTest( hooks, {
		resolver: buildResolver({
			StreamItemComponent: StreamItemComponent.extend({
				// remove layout for now
				layout: hbs``
			})
		})
	});

	hooks.beforeEach(function() {
		this.owner.register( "service:settings", Service.extend({
			content: {
				hasAnyStreamsLanguagesSelection: true,
				streams: {
					filter_vodcast: false,
					languages_filter: ATTR_STREAMS_LANGUAGES_FADE,
					languages: {
						toJSON: () => ({
							de: false,
							en: true,
							fr: false
						})
					}
				}
			}
		}) );
	});


	test( "fading_enabled", function( assert ) {
		const { content: settings } = this.owner.lookup( "service:settings" );
		const subject = this.owner.lookup( "component:stream-item" );

		assert.ok( subject.fading_enabled, "Enabled if not filtering and languages selected" );

		set( settings, "hasAnyStreamsLanguagesSelection", false );
		assert.notOk( subject.fading_enabled, "Disabled if no language selected" );

		set( settings, "hasAnyStreamsLanguagesSelection", true );
		set( settings, "streams.languages_filter", ATTR_STREAMS_LANGUAGES_FILTER );
		assert.notOk( subject.fading_enabled, "Disabled if filtering" );
	});


	test( "faded", function( assert ) {
		const Subject = this.owner.factoryFor( "component:stream-item" );
		const subject = Subject.create({
			fading_enabled: true,
			content: {
				language: undefined,
				channel: {
					broadcaster_language: undefined
				}
			}
		});

		assert.notOk( subject.faded, "Not faded if channel language is missing" );

		set( subject, "content.language", "de" );
		assert.ok( subject.faded, "Faded if channel language differs" );

		set( subject, "content.language", "en" );
		assert.notOk( subject.faded, "Not faded if broadcaster language is missing" );

		set( subject, "content.channel.broadcaster_language", "en" );
		assert.notOk( subject.faded, "Not faded if broadcaster language is equal" );

		set( subject, "content.language", "other" );
		assert.notOk( subject.faded, "Not faded if language differs" );

		set( subject, "content.channel.broadcaster_language", "other" );
		assert.ok( subject.faded, "Faded if broadcaster language differs" );

		set( subject, "fading_enabled", false );
		assert.notOk( subject.faded, "Not faded if fading disabled" );
	});


	test( "fadedVodcast", function( assert ) {
		const Subject = this.owner.factoryFor( "component:stream-item" );
		const subject = Subject.create({
			content: {
				isVodcast: false
			}
		});

		assert.notOk( subject.fadedVodcast, "Not faded if it's not a vodcast" );

		set( subject, "content.isVodcast", true );
		assert.notOk( subject.fadedVodcast, "Not faded if vodcast filtering is disabled" );

		set( subject, "settings.content.streams.filter_vodcast", true );
		assert.ok( subject.fadedVodcast, "Faded if vodcast filtering is enabled" );

		set( subject, "content.isVodcast", false );
		assert.notOk( subject.fadedVodcast, "Not faded if not a vodcast anymore" );
	});


	test( "isFaded element class", async function( assert ) {
		this.setProperties({
			faded: false,
			fadedVodcast: false
		});
		await render( hbs`{{stream-item faded=faded fadedVodcast=fadedVodcast}}` );
		const elem = this.element.querySelector( ".stream-item-component" );

		assert.notOk(
			elem.classList.contains( "faded" ),
			"Not faded if faded and fadedVodcast are falsy"
		);

		this.setProperties({
			faded: true,
			fadedVodcast: false
		});
		assert.ok(
			elem.classList.contains( "faded" ),
			"Faded if faded or fadedVodcast are truthy"
		);

		this.setProperties({
			faded: false,
			fadedVodcast: true
		});
		assert.ok(
			elem.classList.contains( "faded" ),
			"Faded if faded or fadedVodcast are truthy"
		);

		this.setProperties({
			faded: true,
			fadedVodcast: true
		});
		assert.ok(
			elem.classList.contains( "faded" ),
			"Faded if faded or fadedVodcast are truthy"
		);
	});

});


module( "ui/components/list/stream-item details below preview", function( hooks ) {
	setupRenderingTest( hooks, {
		resolver: buildResolver({
			StreamItemComponent,
			StreamPreviewImageComponent,
			PreviewImageComponent,
			BoolNotHelper,
			BoolOrHelper,
			FormatViewersHelper,
			HoursFromNowHelper: helper( () => "1h" ),
			IntlService: FakeIntlService,
			THelper: FakeTHelper,
			LinkToComponent: Component.extend({
				tagName: "a",
				layout: hbs`{{yield}}`
			}),
			EmbeddedLinksComponent: Component.extend({
				layout: hbs`{{text}}`
			})
		})
	});

	hooks.beforeEach(function() {
		this.owner.register( "service:settings", Service.extend({
			content: { streams: { info: "game", show_info: false } }
		}) );
		this.owner.register( "service:streaming", Service.extend({ model: [] }) );
		for ( const name of [ "chat", "nwjs", "router" ] ) {
			this.owner.register( `service:${name}`, Service.extend() );
		}
		this.set( "content", {
			id: "123",
			title: "Ranked matches <script>alert(1)</script>",
			game_name: "Dota 2",
			game_id: "29595",
			user: { detailedName: "Streamer" },
			viewer_count: 1234
		});
	});

	test( "Title and game below preview without hover details", async function( assert ) {
		await render( hbs`{{stream-item content=content showDetailsBelow=true faded=false}}` );
		const card = this.element.querySelector( ".stream-item-component" );
		const details = card.querySelector( ":scope > .stream-details" );
		assert.strictEqual(
			details.previousElementSibling.tagName,
			"SECTION",
			"Details follow the preview"
		);
		assert.strictEqual(
			details.querySelector( ".stream-title" ).textContent,
			this.content.title,
			"Title is visible as text"
		);
		assert.strictEqual(
			details.querySelector( ".stream-game a" ).textContent,
			"Dota 2",
			"Game is displayed as a link"
		);
		assert.notOk( details.querySelector( "script" ), "Title cannot inject markup" );
		assert.notOk(
			card.querySelector( ".preview" ).getAttribute( "title" ),
			"No preview tooltip"
		);
		assert.notOk(
			card.querySelector( ".preview footer, .btn-expand" ),
			"No duplicated hover panel"
		);
		assert.ok(
			card.querySelector( ":scope > footer" ).textContent.includes( "1234" ),
			"Viewer statistics remain"
		);
	});

	test( "Missing game ID and missing category are handled", async function( assert ) {
		set( this.content, "game_id", null );
		await render( hbs`{{stream-item content=content showDetailsBelow=true faded=false}}` );
		assert.strictEqual(
			this.element.querySelector( ".stream-game" ).textContent.trim(),
			"Dota 2",
			"Category without ID remains visible"
		);
		assert.notOk( this.element.querySelector( ".stream-game a" ), "No broken category link" );
		this.set( "content.game_name", "" );
		assert.notOk( this.element.querySelector( ".stream-game" ), "No empty category row" );
		this.set( "content.title", "Updated stream title" );
		assert.strictEqual(
			this.element.querySelector( ".stream-title" ).textContent,
			"Updated stream title",
			"Title updates with stream data"
		);
	});

	test( "Other stream lists retain their existing overlay", async function( assert ) {
		await render( hbs`{{stream-item content=content faded=false}}` );
		assert.notOk(
			this.element.querySelector( ".stream-details" ),
			"Below-preview details are opt-in"
		);
		assert.strictEqual(
			this.element.querySelector( ".preview" ).getAttribute( "title" ),
			this.content.title,
			"Existing tooltip remains"
		);
		assert.ok( this.element.querySelector( ".preview footer" ), "Existing overlay remains" );
		assert.ok( this.element.querySelector( ".btn-expand" ), "Existing expansion remains" );
	});
});
