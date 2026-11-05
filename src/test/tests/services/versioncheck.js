import { module, test } from "qunit";
import { setupTest } from "ember-qunit";
import { buildResolver } from "test-utils";
import sinon from "sinon";

import Controller from "@ember/controller";
import EmberObject, { set } from "@ember/object";
import Service from "@ember/service";
import { basename, dirname, join, resolve } from "path";

// eslint-disable-next-line max-len
import versioncheckServiceInjector from "inject-loader?metadata&nwjs/App&nwjs/argv&nwjs/debug&nwjs/process&utils/node/platform&updater/client&updater/install!services/versioncheck";


function deferred() {
	let resolve;
	let reject;
	const promise = new Promise( ( res, rej ) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}


module( "services/versioncheck", function( hooks ) {
	setupTest( hooks, {
		resolver: buildResolver({})
	});

	hooks.beforeEach(function() {
		const context = this;
		this.isDebug = this.isDevelopment = false;
		this.argVersioncheck = true;
		this.platform = "linux";
		this.arch = "x64";
		this.installDir = resolve( "/test-updater/application" );
		this.profileDir = resolve( "/test-updater/профиль с пробелами/Profile 1" );
		this.cacheDir = resolve( "/test-updater/cache" );
		this.archivePath = join( this.cacheDir, "update.tar.gz" );
		this.currentBuild = {
			commit: "1111111111111111111111111111111111111111",
			buildNumber: 100,
			commitTime: 1700000000
		};
		this.release = {
			tag: "v2.5.3-master.g2222222222222222222222222222222222222222",
			versionLabel: "2.5.3 (22222222)",
			releaseUrl: "https://github.com/bespalovnikita/streamlink-twitch-gui/releases/tag/test",
			platform: "linux64",
			manifest: {
				commit: "2222222222222222222222222222222222222222",
				buildNumber: 101,
				commitTime: 1700000001
			},
			asset: {
				name: "streamlink-twitch-gui-v2.5.3-linux64.tar.gz",
				url: "https://github.com/bespalovnikita/streamlink-twitch-gui/releases/download/test/app.tar.gz",
				size: 100,
				sha256: "a".repeat( 64 )
			}
		};
		this.record = EmberObject.create({
			version: "2.5.3",
			checkagain: Date.now() + 7 * 24 * 3600 * 1000,
			showdebugmessage: 0,
			skippedTag: ""
		});
		this.record.save = sinon.stub().resolves( this.record );
		this.findRecord = sinon.stub().resolves( this.record );
		this.peekRecord = sinon.stub().returns( null );
		this.unloadRecord = sinon.spy();
		this.createRecord = sinon.stub().callsFake( ( name, data ) => {
			this.record.setProperties( data );
			return this.record;
		});
		this.openModal = sinon.spy();
		this.closeModal = sinon.spy();
		this.promiseModal = sinon.stub().resolves();
		this.checkForUpdate = sinon.stub().resolves( null );
		this.downloadUpdate = sinon.stub().resolves( this.archivePath );
		this.job = { token: "test-token", jobFile: join( this.cacheDir, "job.json" ) };
		this.prepareUpdate = sinon.stub().resolves( this.job );
		this.startInstall = sinon.stub().resolves();
		this.confirmStartup = sinon.stub().resolves( false );
		this.readRollbackStatus = sinon.stub().resolves( null );
		this.quit = sinon.spy();
		this.settingsModel = EmberObject.create({ isDirty: false });
		this.process = {
			execPath: join( this.installDir, "streamlink-twitch-gui" ),
			pid: 12345,
			argv: [],
			env: {}
		};

		const { default: VersioncheckService } = versioncheckServiceInjector({
			"metadata": {
				version: "v2.5.3-master.g11111111",
				...this.currentBuild
			},
			"nwjs/App": {
				manifest: { version: "2.5.3" },
				dataPath: this.profileDir,
				filteredArgv: [],
				quit: this.quit
			},
			"nwjs/argv": {
				ARG_VERSIONCHECK: "versioncheck",
				argv: {
					get versioncheck() { return context.argVersioncheck; }
				}
			},
			"nwjs/debug": {
				get isDebug() { return context.isDebug; },
				get isDevelopment() { return context.isDevelopment; }
			},
			"nwjs/process": this.process,
			"utils/node/platform": {
				get platform() { return context.platform; },
				get arch() { return context.arch; },
				cachedir: this.cacheDir
			},
			"updater/client": {
				checkForUpdate: this.checkForUpdate,
				downloadUpdate: this.downloadUpdate
			},
			"updater/install": {
				prepareUpdate: this.prepareUpdate,
				startInstall: this.startInstall,
				confirmStartup: this.confirmStartup,
				readRollbackStatus: this.readRollbackStatus
			}
		});
		this.owner.register( "service:versioncheck", VersioncheckService );
		this.owner.register( "service:store", Service.extend({
			findRecord: this.findRecord,
			peekRecord: this.peekRecord,
			unloadRecord: this.unloadRecord,
			createRecord: this.createRecord
		}) );
		this.owner.register( "service:modal", Service.extend({
			openModal: this.openModal,
			closeModal: this.closeModal,
			promiseModal: this.promiseModal
		}) );
		this.owner.register( "service:streaming", Service.extend({ hasStreams: false }) );
		this.owner.register( "service:settings", Service.extend({ content: {} }) );
		this.owner.register( "service:router", Service.extend({ currentRouteName: "index" }) );
		this.owner.register( "controller:settings", Controller.extend({
			model: this.settingsModel
		}) );
		this.getUpdater = () => this.owner.lookup( "service:versioncheck" );
		this.readyUpdate = async () => {
			this.checkForUpdate.resolves( this.release );
			const updater = this.getUpdater();
			await updater.checkNow();
			await updater.download();
			return updater;
		};
	});


	test( "Startup checks master even during the legacy weekly cooldown", async function( assert ) {
		const updater = this.getUpdater();
		await updater.check();

		assert.ok( this.checkForUpdate.calledOnce, "Checks this launch regardless of checkagain" );
		assert.deepEqual( this.checkForUpdate.firstCall.args[0], {
			repository: "bespalovnikita/streamlink-twitch-gui",
			currentBuild: this.currentBuild,
			platform: "linux",
			arch: "x64"
		}, "Checks the fork with the current build identity" );
		assert.strictEqual( updater.state, "current", "Reports the current build" );
		assert.notOk( this.openModal.called, "No offer when no newer master build exists" );
	});

	test( "Disabled startup check still permits a manual check", async function( assert ) {
		this.argVersioncheck = false;
		const updater = this.getUpdater();
		await updater.check();
		assert.notOk( this.checkForUpdate.called, "Respects the startup option" );

		await updater.checkNow();
		assert.ok( this.checkForUpdate.calledOnce, "Manual check overrides the startup option" );
		assert.strictEqual( updater.state, "current", "Manual check gives visible feedback" );
	});

	test( "Skipped tags stay hidden at startup and are offered manually", async function( assert ) {
		this.record.set( "skippedTag", this.release.tag );
		this.checkForUpdate.resolves( this.release );
		const updater = this.getUpdater();
		await updater.check();
		assert.notOk( this.openModal.called, "Previously skipped tag has no startup offer" );

		await updater.checkNow();
		assert.strictEqual( updater.release, this.release, "Keeps the offered release" );
		assert.strictEqual( updater.state, "available", "Manual check offers a skipped tag" );
		assert.ok( this.openModal.calledWith( "newrelease", updater ), "Shows the update offer" );
	});

	test( "Skip persists the tag while Later only dismisses the offer", async function( assert ) {
		this.checkForUpdate.resolves( this.release );
		const updater = this.getUpdater();
		await updater.checkNow();
		updater.later();
		assert.ok( this.closeModal.called, "Later closes the dialog" );
		assert.strictEqual( this.record.skippedTag, "", "Later does not persist a skip" );
		assert.notOk( this.record.save.called, "Later does not write preferences" );

		await updater.ignoreRelease();
		assert.strictEqual( this.record.skippedTag, this.release.tag, "Persists this release tag" );
		assert.ok( this.record.save.calledOnce, "Saves the skip preference" );
	});

	test( "Downloading clears the previous skip for Later", async function( assert ) {
		this.record.set( "skippedTag", this.release.tag );
		this.checkForUpdate.resolves( this.release );
		const updater = this.getUpdater();
		await updater.checkNow();
		assert.strictEqual( this.record.skippedTag, this.release.tag,
			"A manual check alone preserves the skipped version" );
		assert.notOk( this.record.save.called, "Checking does not write a preference" );

		await updater.download();
		assert.strictEqual( this.record.skippedTag, "", "A verified download clears its old skip" );
		assert.ok( this.record.save.calledOnce, "Persists the explicit download choice" );
		updater.later();
		assert.ok( updater.isReady, "Later keeps the downloaded update ready" );
		assert.strictEqual( this.record.skippedTag, "", "Startup can offer this release again" );
		assert.notOk( this.prepareUpdate.called,
			"Deferring the update creates no stage directory" );
	});

	test( "Concurrent checks share one request", async function( assert ) {
		const request = deferred();
		const entered = deferred();
		this.checkForUpdate.callsFake( () => {
			entered.resolve();
			return request.promise;
		});
		const updater = this.getUpdater();
		const first = updater.checkNow();
		await entered.promise;
		const second = updater.checkNow();
		assert.strictEqual( updater.state, "checking", "Reports the running check" );
		assert.ok( updater.isBusy, "Disables overlapping work" );
		request.resolve( this.release );
		await Promise.all( [ first, second ] );
		assert.ok( this.checkForUpdate.calledOnce, "Only one API request is made" );
		assert.strictEqual( updater.state, "available", "Retains the completed result" );
	});

	test( "A check failure produces a retryable status", async function( assert ) {
		this.checkForUpdate.rejects( Object.assign( new Error( "Network unavailable" ), {
			code: "NETWORK"
		}) );
		const updater = this.getUpdater();
		await updater.checkNow();
		assert.strictEqual( updater.state, "error", "Reports the failure" );
		assert.ok( updater.errorCode, "Keeps a status code for translated feedback" );
		assert.notOk( updater.isBusy, "A failed request does not leave the controls locked" );

		this.checkForUpdate.resolves( null );
		await updater.checkNow();
		assert.strictEqual( updater.state, "current", "Can check again after a network failure" );
		assert.notOk( updater.errorCode, "Clears the previous error after success" );
	});

	test( "Development builds never download or install", async function( assert ) {
		this.isDevelopment = true;
		const updater = this.getUpdater();
		await updater.checkNow();
		await updater.download();
		await updater.install({ confirmed: true });
		assert.strictEqual( updater.state, "unsupported", "Explains the development restriction" );
		assert.notOk( this.checkForUpdate.called, "Does not check from a development build" );
		assert.notOk( this.downloadUpdate.called, "Does not write an update archive" );
		assert.notOk( this.startInstall.called, "Does not launch an installer" );
		assert.notOk( this.quit.called, "Keeps the running application open" );
	});

	test( "Windows x64 checks use the Windows release target", async function( assert ) {
		this.platform = "win32";
		const updater = this.getUpdater();
		await updater.checkNow();
		assert.ok( this.checkForUpdate.calledOnce, "Supports Windows x64" );
		assert.strictEqual( this.checkForUpdate.firstCall.args[0].platform, "win32",
			"Passes the native Windows platform to the release client" );
	});

	test( "Unsupported architectures do not attempt an update", async function( assert ) {
		this.arch = "arm64";
		const updater = this.getUpdater();
		await updater.checkNow();
		assert.strictEqual( updater.state, "unsupported", "Explains the unsupported target" );
		assert.notOk( this.checkForUpdate.called, "Does not request an incompatible archive" );
	});

	test( "A verified download waits for restart before preparation", async function( assert ) {
		const request = deferred();
		const entered = deferred();
		this.downloadUpdate.callsFake( ( update, destination, options ) => {
			options.onProgress({ received: 42, total: 100, percent: 42 });
			entered.resolve();
			return request.promise;
		});
		this.checkForUpdate.resolves( this.release );
		const updater = this.getUpdater();
		await updater.checkNow();
		const download = updater.download();
		await entered.promise;
		assert.strictEqual( updater.state, "downloading", "Shows the download state" );
		assert.strictEqual( updater.progress, 42, "Shows download progress" );
		assert.strictEqual( this.downloadUpdate.firstCall.args[0], this.release,
			"Uses checked metadata" );
		assert.ok( this.downloadUpdate.firstCall.args[2].signal, "Passes an abort signal" );

		request.resolve( this.archivePath );
		await download;
		assert.notOk( this.prepareUpdate.called, "Does not stage files before explicit restart" );
		assert.strictEqual( updater.state, "ready", "Waits for the restart button" );
		assert.ok( updater.isReady, "Makes the restart action available" );
		assert.notOk( this.startInstall.called, "Downloading does not start installation" );
		assert.notOk( this.quit.called, "Downloading does not quit the application" );
	});

	test( "Cancel aborts the download and permits a retry", async function( assert ) {
		const entered = deferred();
		this.downloadUpdate.callsFake( ( update, destination, { signal } ) => {
			entered.resolve( signal );
			return new Promise( ( resolve, reject ) => signal.addEventListener( "abort", () => {
				const error = new Error( "Cancelled" );
				error.name = "AbortError";
				reject( error );
			}) );
		});
		this.checkForUpdate.resolves( this.release );
		const updater = this.getUpdater();
		await updater.checkNow();
		const download = updater.download();
		const signal = await entered.promise;
		updater.cancelDownload();
		await download;
		assert.ok( signal.aborted, "Cancels the request" );
		assert.strictEqual( updater.state, "available", "Offers the same release again" );
		assert.notOk( updater.errorCode, "Cancellation is not displayed as a failure" );
		assert.notOk( this.prepareUpdate.called, "Does not prepare an incomplete archive" );
		assert.notOk( this.quit.called, "Cancellation leaves the application running" );
	});

	test( "A preparation failure prevents an incomplete update", async function( assert ) {
		this.prepareUpdate.rejects( Object.assign( new Error( "Invalid archive" ), {
			code: "UPDATE_ARCHIVE"
		}) );
		const updater = await this.readyUpdate();
		assert.strictEqual( updater.state, "ready", "The verified download waits for restart" );
		assert.notOk( this.prepareUpdate.called, "Downloading does not prepare the archive" );
		await updater.requestInstall();
		assert.strictEqual( updater.state, "error", "Reports the validation failure" );
		assert.notOk( updater.isReady, "Does not offer installation" );
		await updater.install({ confirmed: true });
		assert.notOk( this.startInstall.called, "Cannot use a missing prepared job" );
		assert.notOk( this.quit.called, "Leaves the current build running" );
	});

	test( "Active streams require a separate restart confirmation", async function( assert ) {
		const updater = await this.readyUpdate();
		set( this.owner.lookup( "service:streaming" ), "hasStreams", true );
		await updater.requestInstall();
		assert.ok( updater.confirmingInstall, "Shows the warning" );
		assert.notOk( this.prepareUpdate.called, "Warning does not stage files" );
		assert.notOk( this.startInstall.called, "Warning does not launch the installer" );
		await updater.install();
		assert.notOk( this.prepareUpdate.called, "Unconfirmed restart does not prepare files" );
		assert.notOk( this.startInstall.called, "Calling install cannot bypass the warning" );

		await updater.install({ confirmed: true });
		assert.ok( this.prepareUpdate.calledOnce, "Prepares files only after confirmation" );
		assert.ok( this.startInstall.calledOnce, "Explicit confirmation permits restart" );
		assert.ok( this.quit.calledOnce, "Quits only after confirmation" );
	});

	test( "Unsaved settings must be saved or discarded before restart", async function( assert ) {
		const updater = await this.readyUpdate();
		this.settingsModel.set( "isDirty", true );
		await updater.requestInstall();
		await updater.install({ confirmed: true });
		assert.strictEqual( updater.errorCode, "SETTINGS_UNSAVED", "Explains the restart block" );
		assert.notOk( this.prepareUpdate.called, "Does not stage files with unsaved settings" );
		assert.notOk( this.startInstall.called, "Generic confirmation cannot discard settings" );
		assert.notOk( this.quit.called, "Leaves unsaved changes intact" );

		this.settingsModel.set( "isDirty", false );
		await updater.requestInstall();
		assert.ok( this.prepareUpdate.calledOnce, "Prepares after settings are resolved" );
		assert.ok( this.startInstall.calledOnce, "Can restart after settings are resolved" );
	});

	test( "A pending settings save blocks restart", async function( assert ) {
		const updater = await this.readyUpdate();
		const savingSettings = EmberObject.create({ isSaving: true });
		this.owner.lookup( "service:settings" ).set( "content", savingSettings );
		assert.notOk( this.settingsModel.isDirty, "The settings buffer has already been applied" );

		await updater.requestInstall();
		await updater.install({ confirmed: true });
		assert.ok( updater.hasUnsavedSettings, "Includes settings that have not finished saving" );
		assert.ok( updater.confirmingInstall, "Shows the unresolved settings warning" );
		assert.notOk( this.prepareUpdate.called, "Does not prepare while preferences are saving" );
		assert.notOk( this.startInstall.called, "Does not start the helper before persistence" );
		assert.notOk( this.quit.called, "Keeps the application running until settings are saved" );

		savingSettings.set( "isSaving", false );
		await updater.requestInstall();
		assert.notOk( updater.hasUnsavedSettings, "Observes completion of the settings save" );
		assert.ok( this.prepareUpdate.calledOnce, "Prepares only after persistence is complete" );
		assert.ok( this.startInstall.calledOnce, "Can install after preferences are saved" );
		assert.ok( this.quit.calledOnce, "Quits after the helper is ready" );
	});

	test( "The application quits only after the helper is ready", async function( assert ) {
		const helper = deferred();
		const entered = deferred();
		this.startInstall.callsFake( () => {
			entered.resolve();
			return helper.promise;
		});
		const updater = await this.readyUpdate();
		const install = updater.requestInstall();
		await entered.promise;
		assert.ok( this.prepareUpdate.calledOnce, "Prepares files after explicit restart" );
		assert.deepEqual( this.prepareUpdate.firstCall.args[0], {
			archivePath: this.archivePath,
			update: this.release,
			installDir: this.installDir,
			profileDir: this.profileDir,
			platform: "linux",
			arch: "x64"
		}, "Keeps the profile separate from the installation" );
		assert.ok( this.startInstall.calledWith( this.job ), "Launches the prepared job" );
		assert.strictEqual( this.startInstall.firstCall.args[1].parentPid, 12345, "Parent PID" );
		assert.deepEqual( this.startInstall.firstCall.args[1].args, [
			`--user-data-dir=${dirname( this.profileDir )}`,
			`--profile-directory=${basename( this.profileDir )}`
		], "Preserves the current profile without replaying stream launch arguments" );
		assert.notOk( this.quit.called, "Waits for helper readiness" );
		helper.resolve();
		await install;
		assert.ok( this.quit.calledOnce, "Uses application quit after the helper starts" );
	});

	test( "A helper launch failure keeps the application running", async function( assert ) {
		this.startInstall.rejects( Object.assign( new Error( "Helper unavailable" ), {
			code: "HELPER_START"
		}) );
		const updater = await this.readyUpdate();
		await updater.requestInstall();
		assert.notOk( this.quit.called, "Does not quit without an installer" );
		assert.ok( updater.errorCode, "Shows a useful failure status" );
		assert.notOk( updater.isBusy, "Unlocks the controls after failure" );
	});

	test( "Saving a skipped tag blocks a concurrent restart", async function( assert ) {
		const updater = await this.readyUpdate();
		const saved = deferred();
		this.record.save.returns( saved.promise );
		const skipping = updater.ignoreRelease();
		assert.ok( updater.isBusy, "Blocks competing operations while saving the skipped tag" );
		await updater.requestInstall();
		await updater.install({ confirmed: true });
		assert.notOk( this.prepareUpdate.called, "Does not prepare a release being skipped" );
		assert.notOk( this.startInstall.called, "Does not launch an installer" );
		assert.notOk( this.quit.called, "Keeps the application running" );
		saved.resolve( this.record );
		await skipping;
		assert.strictEqual( updater.state, "idle", "Finishes skipping the release" );
		assert.notOk( updater.release, "Clears the skipped offer" );
	});

	test( "An offline manual check preserves the downloaded archive", async function( assert ) {
		const updater = await this.readyUpdate();
		this.checkForUpdate.rejects( Object.assign( new Error( "Offline" ), {
			code: "NETWORK_ERROR"
		}) );
		await updater.checkNow();
		assert.strictEqual( updater.state, "ready", "Keeps the verified download installable" );
		assert.strictEqual( updater.release, this.release, "Keeps its checked release metadata" );
		assert.ok( updater.errorCode, "Reports that the new check failed" );
		await updater.requestInstall();
		assert.ok( this.prepareUpdate.calledOnce, "Can prepare the existing archive offline" );
		assert.strictEqual( this.prepareUpdate.firstCall.args[0].archivePath, this.archivePath,
			"Uses the archive already downloaded" );
		assert.ok( this.downloadUpdate.calledOnce, "Does not require another download" );
		assert.ok( this.quit.calledOnce, "Starts the requested installation" );
	});

	test( "Startup confirmation uses the running installation and build", async function( assert ) {
		const updater = this.getUpdater();
		await updater._confirmStartup();
		assert.ok( this.confirmStartup.calledOnce, "Confirms the healthy process" );
		assert.deepEqual( this.confirmStartup.firstCall.args[0], {
			installDir: this.installDir,
			identity: this.currentBuild
		}, "Confirms exactly the build that is running" );
		assert.notOk( this.downloadUpdate.called, "Confirmation does not download another update" );
		assert.notOk( this.quit.called, "Confirmation keeps the healthy application running" );
	});

	test( "Startup reports rollback before offering another update", async function( assert ) {
		this.readRollbackStatus.resolves({ state: "rolled-back", code: "UPDATE_STARTUP" });
		const updater = this.getUpdater();
		await updater.check();
		assert.strictEqual( updater.state, "error", "Shows the rollback result" );
		assert.strictEqual( updater.errorCode, "UPDATE_ROLLBACK", "Explains the restored backup" );
		assert.ok( this.openModal.calledWith( "newrelease", updater ), "Opens rollback notice" );
		assert.notOk( this.checkForUpdate.called, "Keeps the rollback notice visible" );
		assert.notOk( this.quit.called, "Keeps the restored application running" );
	});

	test( "First run still creates a record and waits for onboarding", async function( assert ) {
		const onboarding = deferred();
		this.findRecord.rejects( new Error( "Missing record" ) );
		this.promiseModal.returns( onboarding.promise );
		const updater = this.getUpdater();
		await updater.check();
		assert.ok( this.createRecord.calledWith( "versioncheck", { id: 1, version: "2.5.3" } ),
			"Creates the onboarding record" );
		assert.ok( this.record.save.calledOnce, "Saves the new record" );
		assert.ok( this.promiseModal.calledWith( "firstrun", updater ), "Keeps onboarding" );
		assert.notOk( this.checkForUpdate.called, "Waits until onboarding is dismissed" );
		onboarding.resolve();
		await onboarding.promise;
		await Promise.resolve();
		assert.ok( this.checkForUpdate.calledOnce, "Checks after onboarding closes" );
	});

	test( "Debug onboarding waits for dismissal and saves its reminder", async function( assert ) {
		const debug = deferred();
		this.isDebug = true;
		this.promiseModal.returns( debug.promise );
		const updater = this.getUpdater();
		await updater._getRecord();
		const warning = updater._showDebugMessage();
		assert.ok( this.promiseModal.calledWith( "debug" ), "Keeps the debug build notice" );
		assert.notOk( this.record.save.called, "Does not save until dismissal" );
		debug.resolve();
		await warning;
		assert.ok( this.record.showdebugmessage > Date.now(), "Schedules the next debug reminder" );
		assert.ok( this.record.save.calledOnce, "Persists the dismissed reminder" );
	});
});
