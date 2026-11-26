import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";
import { buildResolver } from "test-utils";
import { click, render, settled, triggerEvent } from "@ember/test-helpers";
import hbs from "htmlbars-inline-precompile";

import { set } from "@ember/object";
import Service from "@ember/service";
import Component from "@ember/component";
import { helper } from "@ember/component/helper";
import StreamPreviewImageComponent from "ui/components/stream/stream-preview-image/component";
import PreviewImageComponent from "ui/components/preview-image/component";
import { helper as BoolAndHelper } from "ui/components/helper/bool-and";
import { helper as BoolNotHelper } from "ui/components/helper/bool-not";
import { helper as BoolOrHelper } from "ui/components/helper/bool-or";
import { helper as FormatViewersHelper } from "ui/components/helper/format-viewers";
import { FakeIntlService, FakeTHelper } from "intl-utils";

import StreamItemComponent from "ui/components/list/stream-item/component";
import {
	ATTR_STREAMS_CLICK_CHAT,
	ATTR_STREAMS_INFO_GAME,
	ATTR_STREAMS_INFO_TITLE,
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
			BoolAndHelper,
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
			content: { streams: { info: ATTR_STREAMS_INFO_TITLE, show_info: false } }
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
			user: { detailedName: "Streamer", login: "streamer" },
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
			card.querySelector( ".preview-info, .btn-expand" ),
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

	test( "Discovery shows stream details before interacting", async function( assert ) {
		await render( hbs`{{stream-item content=content faded=false}}` );
		assert.strictEqual(
			this.element.querySelector( ".stream-details .stream-title" ).textContent,
			this.content.title,
			"The title is below the preview"
		);
		assert.strictEqual(
			this.element.querySelector( ".stream-details .stream-game a" ).textContent,
			"Dota 2",
			"The category is a link below the preview"
		);
		assert.notOk( this.element.querySelector( ".preview-info" ), "No duplicate overlay" );

		const detailsButton = this.element.querySelector( "button.btn-expand" );
		assert.strictEqual( detailsButton.getAttribute( "aria-expanded" ), "false" );
		await click( detailsButton );
		assert.strictEqual( detailsButton.getAttribute( "aria-expanded" ), "true" );
		const panelId = detailsButton.getAttribute( "aria-controls" );
		const detailsPanel = document.getElementById( panelId );
		assert.strictEqual( detailsPanel.textContent.trim(), this.content.title );
		await triggerEvent( detailsButton, "keydown", { key: "Escape" } );
		assert.strictEqual( detailsButton.getAttribute( "aria-expanded" ), "false" );
		assert.strictEqual( document.activeElement, detailsButton, "Focus returns to the toggle" );
	});

	test( "Pinned info shows the selected field on the preview", async function( assert ) {
		const { content: settings } = this.owner.lookup( "service:settings" );
		set( settings, "streams.show_info", true );
		await render( hbs`{{stream-item content=content faded=false}}` );
		const previewInfo = () => this.element.querySelector( ".preview-info" ).textContent.trim();

		assert.strictEqual( previewInfo(), this.content.title, "The selected title is pinned" );
		assert.notOk( this.element.querySelector( ".stream-title" ), "No duplicate title" );
		assert.ok( this.element.querySelector( ".stream-game a" ), "Category still links below" );

		set( settings, "streams.info", ATTR_STREAMS_INFO_GAME );
		await settled();
		assert.strictEqual( previewInfo(), "Dota 2", "The category is pinned when selected" );
		assert.ok( this.element.querySelector( ".preview-info a" ), "Pinned category still links" );
		assert.notOk( this.element.querySelector( ".stream-game" ), "No duplicate category" );
		assert.ok( this.element.querySelector( ".stream-title" ), "Title remains below" );
	});

	test( "The play button preserves preview shortcuts", async function( assert ) {
		const { content: settings } = this.owner.lookup( "service:settings" );
		set( settings, "streams.click_modify", ATTR_STREAMS_CLICK_CHAT );
		set( settings, "streams.click_middle", ATTR_STREAMS_CLICK_CHAT );
		this.owner.lookup( "service:streaming" ).startStream = stream => assert.step( stream.id );
		this.owner.lookup( "service:chat" ).openChat = login => assert.step( login );
		await render( hbs`{{stream-item content=content faded=false}}` );

		const play = this.element.querySelector( "button.stream-preview-play" );
		assert.strictEqual( play.tabIndex, 0, "The play button can receive focus" );
		assert.ok( play.getAttribute( "aria-label" ).includes( "Streamer" ) );
		await click( play );
		await triggerEvent( play, "click", { button: 0, ctrlKey: true } );
		await triggerEvent( play, "mouseup", { button: 1 } );
		assert.verifySteps([ "123", "streamer", "streamer" ]);
	});
});
