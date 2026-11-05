import { module, test } from "qunit";
import { setupRenderingTest } from "ember-qunit";
import { buildResolver } from "test-utils";
import { FakeIntlService, FakeTHelper } from "intl-utils";
import { render, click } from "@ember/test-helpers";
import hbs from "htmlbars-inline-precompile";
import sinon from "sinon";

import { run } from "@ember/runloop";
import Service from "@ember/service";

import UpdateStatusComponent from "ui/components/update-status/component";
import ModalNewreleaseComponent from "ui/components/modal/modal-newrelease/component";
import ModalHeaderComponent from "ui/components/modal/modal-header/component";
import ModalBodyComponent from "ui/components/modal/modal-body/component";
import ModalFooterComponent from "ui/components/modal/modal-footer/component";
import FormButtonComponent from "ui/components/button/form-button/component";


module( "ui/components/update-status", function( hooks ) {
	setupRenderingTest( hooks, {
		resolver: buildResolver({
			UpdateStatusComponent,
			ModalNewreleaseComponent,
			ModalHeaderComponent,
			ModalBodyComponent,
			ModalFooterComponent,
			FormButtonComponent,
			IntlService: FakeIntlService,
			THelper: FakeTHelper,
			HotkeyService: Service.extend({
				register() {},
				unregister() {}
			}),
			ModalService: Service.extend({
				closeModal() {}
			})
		})
	});

	hooks.beforeEach(function() {
		this.checkNow = sinon.spy();
		this.download = sinon.spy();
		this.cancelDownload = sinon.spy();
		this.requestInstall = sinon.spy();
		this.install = sinon.spy();
		this.later = sinon.spy();
		this.ignoreRelease = sinon.spy();

		this.owner.register( "service:versioncheck", Service.extend({
			currentVersion: "2.5.3",
			currentCommit: "11111111",
			release: { versionLabel: "2.5.3 (22222222)" },
			state: "available",
			statusKey: "updater.status.available",
			errorKey: "",
			isBusy: false,
			isDownloading: false,
			isReady: false,
			canDownload: true,
			progress: 0,
			confirmingInstall: false,
			hasStreams: false,
			hasUnsavedSettings: false,
			checkNow: this.checkNow,
			download: this.download,
			cancelDownload: this.cancelDownload,
			requestInstall: this.requestInstall,
			install: this.install,
			later: this.later,
			ignoreRelease: this.ignoreRelease
		}) );
		this.set( "updater", this.owner.lookup( "service:versioncheck" ) );
	});


	test( "Manual check is immediate and independent of settings submit", async function( assert ) {
		await render( hbs`{{update-status}}` );

		assert.strictEqual( this.element.querySelector( ".updater-current-version" ).textContent,
			"updater.current-version{\"version\":\"2.5.3\"}", "Shows the installed version" );
		assert.ok( this.element.querySelector( ".updater-current-commit" ), "Shows the commit" );
		assert.ok( this.element.querySelector( ".updater-download" ), "Offers downloading" );
		assert.notOk( this.element.querySelector( ".updater-restart" ),
			"Restart is unavailable until the archive is ready" );

		await click( ".updater-check" );
		assert.ok( this.checkNow.calledOnce, "Checks immediately without a settings Apply action" );
		await click( ".updater-download" );
		assert.ok( this.download.calledOnce, "Download starts only through the download action" );

		run( () => this.updater.setProperties({
			state: "checking",
			statusKey: "updater.status.checking",
			isBusy: true,
			canDownload: false
		}) );
		assert.ok( this.element.querySelector( ".updater-check" ).disabled,
			"Disables manual checking while a request is running" );
		assert.strictEqual( this.element.querySelector( ".updater-state" ).textContent,
			"updater.status.checking", "Announces the running check" );
	});

	test( "Downloading supports cancellation and a separate restart", async function( assert ) {
		this.updater.setProperties({
			state: "downloading",
			statusKey: "updater.status.downloading",
			isBusy: true,
			isDownloading: true,
			canDownload: false,
			progress: 73
		});
		await render( hbs`{{update-status}}` );

		assert.strictEqual( this.element.querySelector( "progress" ).value, 73,
			"Displays download progress" );
		assert.strictEqual( this.element.querySelector( ".updater-progress" ).textContent,
			"updater.progress{\"percent\":73}", "Displays the percentage text" );
		assert.notOk( this.element.querySelector( ".updater-restart" ),
			"Downloading does not offer installation" );
		await click( ".updater-cancel" );
		assert.ok( this.cancelDownload.calledOnce, "Passes cancellation to the updater" );

		run( () => this.updater.setProperties({
			state: "ready",
			statusKey: "updater.status.ready",
			isBusy: false,
			isDownloading: false,
			isReady: true,
			progress: 100
		}) );
		assert.notOk( this.element.querySelector( "progress" ), "Hides finished progress" );
		assert.notOk( this.element.querySelector( ".updater-cancel" ), "Hides cancellation" );
		assert.ok( this.element.querySelector( ".updater-restart" ), "Offers restart and install" );
		await click( ".updater-restart" );
		assert.ok( this.requestInstall.calledOnce, "Uses the guarded restart action" );
		assert.notOk( this.install.called, "The status panel does not bypass restart warnings" );
	});

	test( "Restart warns about streams and blocks unsaved settings", async function( assert ) {
		this.updater.setProperties({
			state: "ready",
			isReady: true,
			canDownload: false,
			confirmingInstall: true,
			hasStreams: true
		});
		await render( hbs`{{modal-newrelease modalContext=updater}}` );

		const header = this.element.querySelector( ".modal-header-component" );
		assert.strictEqual( header.textContent.trim(),
			"updater.title", "Uses the updater dialog" );
		assert.strictEqual( this.element.querySelector( ".updater-stream-warning" ).textContent,
			"updater.warning.streams", "Warns about active streams" );
		assert.ok( this.element.querySelector( ".updater-back" ), "Offers returning to the app" );
		await click( ".updater-confirm" );
		assert.ok( this.install.calledOnceWithExactly({ confirmed: true }),
			"Confirms the restart explicitly" );

		run( () => this.updater.set( "hasUnsavedSettings", true ) );
		assert.strictEqual( this.element.querySelector( ".updater-settings-warning" ).textContent,
			"updater.warning.settings", "Explains that settings must be resolved first" );
		assert.notOk( this.element.querySelector( ".updater-confirm" ),
			"Does not offer to discard unsaved settings through restart confirmation" );
		assert.ok( this.element.querySelector( ".updater-back" ), "Keeps the Back action" );
		await click( ".updater-back" );
		assert.ok( this.later.calledOnce, "Returns without installing" );
		assert.ok( this.install.calledOnce, "Unsaved settings cannot start installation" );
	});
});
