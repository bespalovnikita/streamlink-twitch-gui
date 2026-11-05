import { getOwner } from "@ember/application";
import { get, set, setProperties, computed } from "@ember/object";
import { join, scheduleOnce } from "@ember/runloop";
import { default as Service, inject as service } from "@ember/service";
import semverLt from "semver/functions/lt";
import { main as mainConfig, update as updateConfig } from "config";
import * as metadata from "metadata";
import { manifest, dataPath, quit } from "nwjs/App";
import Process from "nwjs/process";
import { argv, ARG_VERSIONCHECK } from "nwjs/argv";
import { isDebug, isDevelopment } from "nwjs/debug";
import { platform, arch, cachedir } from "utils/node/platform";
import { basename, dirname, join as joinPath } from "path";
import * as client from "updater/client";
import * as installer from "updater/install";


const { "display-name": displayName } = mainConfig;
const { "show-debug-message": showDebugMessage } = updateConfig;
const busyStates = [ "checking", "downloading", "preparing", "installing" ];
const errorKeys = {
	NETWORK_ERROR: "updater.error.offline",
	REQUEST_TIMEOUT: "updater.error.offline",
	HTTP_ERROR: "updater.error.offline",
	UNSUPPORTED_PLATFORM: "updater.error.unsupported",
	INVALID_CURRENT_BUILD: "updater.error.unsupported",
	UPDATE_UNSUPPORTED: "updater.error.unsupported",
	DOWNLOAD_FAILED: "updater.error.download",
	DOWNLOAD_TRUNCATED: "updater.error.download",
	CHECKSUM_MISMATCH: "updater.error.integrity",
	UPDATE_INTEGRITY: "updater.error.integrity",
	UPDATE_ARCHIVE: "updater.error.archive",
	UPDATE_PACKAGE: "updater.error.archive",
	UPDATE_LOCATION: "updater.error.location",
	UPDATE_PROFILE: "updater.error.location",
	UPDATE_NOT_WRITABLE: "updater.error.permission",
	UPDATE_BUSY: "updater.error.busy",
	UPDATE_START: "updater.error.start",
	UPDATE_ROLLBACK: "updater.error.rollback",
	SETTINGS_UNSAVED: "updater.error.settings"
};


export default Service.extend( /** @class VersioncheckService */ {
	modal: service(),
	store: service(),
	streaming: service(),
	settings: service(),
	router: service(),

	version: manifest.version,
	currentVersion: manifest.version,
	currentCommit: ( metadata.commit || "" ).slice( 0, 8 ),
	model: null,
	release: null,
	state: "idle",
	progress: 0,
	errorCode: "",
	confirmingInstall: false,
	_startupPromise: null,
	_recordPromise: null,
	_checkPromise: null,
	_downloadController: null,
	_installJob: null,
	_archivePath: null,
	_downloadGeneration: 0,
	_confirmationScheduled: false,
	_skipping: false,

	currentBuild: computed(function() {
		return {
			commit: metadata.commit,
			buildNumber: metadata.buildNumber,
			commitTime: metadata.commitTime
		};
	}),
	installDir: computed(function() { return dirname( Process.execPath ); }),
	isSupported: computed(function() {
		return !isDebug && !isDevelopment && arch === "x64"
			&& [ "win32", "linux" ].includes( platform )
			&& /^[a-f0-9]{40}$/.test( metadata.commit || "" )
			&& metadata.buildNumber > 0 && metadata.commitTime > 0;
	}).volatile(),
	isBusy: computed( "state", "_skipping", function() {
		return busyStates.includes( this.state ) || this._skipping;
	}),
	isDownloading: computed( "state", function() { return this.state === "downloading"; }),
	isReady: computed( "state", function() { return this.state === "ready"; }),
	canDownload: computed( "state", "release", "isBusy", function() {
		return !!this.release && !this.isBusy && [ "available", "error" ].includes( this.state );
	}),
	statusKey: computed( "state", function() { return `updater.status.${this.state}`; }),
	errorKey: computed( "errorCode", function() {
		return this.errorCode ? errorKeys[ this.errorCode ] || "updater.error.generic" : "";
	}),
	hasStreams: computed( "streaming.hasStreams", function() {
		return !!get( this, "streaming.hasStreams" );
	}),
	_settingsController: computed(function() {
		const owner = getOwner( this );
		return owner.hasRegistration( "controller:settings" )
			? owner.lookup( "controller:settings" ) : null;
	}),
	hasUnsavedSettings: computed(
		"_settingsController.model.isDirty", "settings.content.isSaving", function() {
			return !!get( this, "_settingsController.model.isDirty" )
				|| !!get( this, "settings.content.isSaving" );
		}
	),


	check() {
		if ( !this._startupPromise ) {
			this._startupPromise = this._startup().catch( error => this._fail( error ) );
		}
		return this._startupPromise;
	},
	async _startup() {
		const existinguser = await this._getRecord();
		this._scheduleStartupConfirmation();
		if ( installer.readRollbackStatus ) {
			const rollback = await installer.readRollbackStatus({ installDir: this.installDir });
			if ( rollback ) {
				this._fail({ code: "UPDATE_ROLLBACK" });
				this.modal.openModal( "newrelease", this );
				return;
			}
		}
		await this._showDebugMessage();
		await this._check( existinguser );
	},
	async checkNow() {
		if ( this.isBusy ) { return this._checkPromise; }
		try {
			if ( !this.model ) { await this._getRecord(); }
			return await this._performCheck( true );
		} catch ( error ) {
			this._fail( error );
			return null;
		}
	},
	async _checkForNewRelease() {
		if ( !argv[ ARG_VERSIONCHECK ] ) { return; }
		return this._performCheck( false );
	},
	_performCheck( manual ) {
		if ( this.isBusy ) { return this._checkPromise; }
		if ( !this.isSupported ) {
			setProperties( this, { state: "unsupported", errorCode: "UNSUPPORTED_PLATFORM" } );
			return Promise.resolve( null );
		}
		setProperties( this, { state: "checking", errorCode: "", confirmingInstall: false } );
		this._checkPromise = this._queryRelease( manual );
		return this._checkPromise;
	},
	async _queryRelease( manual ) {
		try {
			const update = await client.checkForUpdate({
				repository: updateConfig.repository,
				currentBuild: this.currentBuild,
				platform,
				arch
			});
			if ( this.isDestroying || this.isDestroyed ) { return null; }
			if ( !update ) {
				await this._discardPreparedUpdate();
				setProperties( this, { release: null, state: "current" } );
				return null;
			}
			if ( !manual && this.model && this.model.skippedTag === update.tag ) {
				await this._discardPreparedUpdate();
				setProperties( this, { release: null, state: "idle" } );
				return null;
			}
			const ready = this._archivePath && this.release && this.release.tag === update.tag;
			if ( !ready ) { await this._discardPreparedUpdate(); }
			setProperties( this, { release: update, state: ready ? "ready" : "available" } );
			this.modal.openModal( "newrelease", this );
			return update;
		} catch ( error ) {
			this._fail( error, this._archivePath && this.release ? "ready" : "error" );
			return null;
		} finally {
			this._checkPromise = null;
		}
	},
	async download() {
		if ( !this.release || this.isBusy || this.isReady || !this.isSupported ) { return false; }
		const update = this.release;
		const generation = ++this._downloadGeneration;
		const controller = new AbortController();
		this._downloadController = controller;
		setProperties( this, { state: "downloading", progress: 0, errorCode: "" } );
		try {
			const destination = joinPath(
				cachedir, "updates", update.manifest.commit, update.asset.name
			);
			const archivePath = await client.downloadUpdate( update, destination, {
				signal: controller.signal,
				onProgress: value => join( () => {
					if (
						generation !== this._downloadGeneration || this.state !== "downloading"
					) { return; }
					const percent = typeof value === "number" ? value : value.percent;
					const progress = Math.max( 0, Math.min( 100, Math.round( percent || 0 ) ) );
					set( this, "progress", progress );
				})
			});
			if ( generation !== this._downloadGeneration || controller.signal.aborted ) {
				return false;
			}
			await this._discardPreparedUpdate();
			if (
				generation !== this._downloadGeneration || this.isDestroying || this.isDestroyed
			) {
				return false;
			}
			this._archivePath = archivePath;
			if ( this.model && this.model.skippedTag === update.tag ) {
				set( this.model, "skippedTag", "" );
				await this.model.save();
			}
			if ( generation !== this._downloadGeneration ) { return false; }
			setProperties( this, { state: "ready", progress: 100 } );
			return true;
		} catch ( error ) {
			if ( generation !== this._downloadGeneration ) { return false; }
			if (
				controller.signal.aborted || error.code === "ABORTED" || error.name === "AbortError"
			) {
				setProperties( this, { state: "available", errorCode: "", progress: 0 } );
			} else {
				this._fail( error, this._archivePath ? "ready" : "error" );
			}
			return false;
		} finally {
			if ( this._downloadController === controller ) { this._downloadController = null; }
		}
	},
	cancelDownload() {
		if ( this.state !== "downloading" || !this._downloadController ) { return; }
		++this._downloadGeneration;
		this._downloadController.abort();
		setProperties( this, { state: "available", progress: 0, errorCode: "" } );
	},
	later() {
		set( this, "confirmingInstall", false );
		this.modal.closeModal( this, "newrelease" );
	},
	async ignoreRelease() {
		if ( !this.release || this.isBusy ) { return false; }
		set( this, "_skipping", true );
		try {
			if ( !this.model ) { await this._getRecord(); }
			set( this.model, "skippedTag", this.release.tag );
			await this.model.save();
			await this._discardPreparedUpdate();
			setProperties( this, { release: null, state: "idle", errorCode: "" } );
			this.later();
			return true;
		} catch ( error ) {
			this._fail( error );
			return false;
		} finally {
			if ( !this.isDestroying && !this.isDestroyed ) { set( this, "_skipping", false ); }
		}
	},
	requestInstall() {
		if ( !this.isReady || this.isBusy ) { return Promise.resolve( false ); }
		if ( this.hasStreams || this.hasUnsavedSettings ) {
			set( this, "confirmingInstall", true );
			this.modal.openModal( "newrelease", this );
			return Promise.resolve( false );
		}
		return this.install();
	},
	async install( { confirmed = false } = {} ) {
		if (
			!this.isReady || this.isBusy || !this._archivePath || !this.isSupported
		) { return false; }
		if ( this.hasUnsavedSettings ) {
			setProperties( this, { confirmingInstall: true, errorCode: "SETTINGS_UNSAVED" } );
			return false;
		}
		if ( this.hasStreams && !confirmed ) {
			set( this, "confirmingInstall", true );
			this.modal.openModal( "newrelease", this );
			return false;
		}
		setProperties( this, { state: "preparing", confirmingInstall: false, errorCode: "" } );
		try {
			if ( !this._installJob ) {
				const job = await installer.prepareUpdate({
					archivePath: this._archivePath,
					update: this.release,
					installDir: this.installDir,
					profileDir: dataPath,
					platform,
					arch
				});
				if ( this.isDestroying || this.isDestroyed ) {
					if ( installer.discardUpdate ) { await installer.discardUpdate( job ); }
					return false;
				}
				this._installJob = job;
			}
			set( this, "state", "installing" );
			await installer.startInstall( this._installJob, {
				parentPid: Process.pid,
				args: [
					`--user-data-dir=${dirname( dataPath )}`,
					`--profile-directory=${basename( dataPath )}`
				]
			});
			quit();
			return true;
		} catch ( error ) {
			const invalidArchive = [ "UPDATE_INTEGRITY", "UPDATE_ARCHIVE", "UPDATE_PACKAGE" ];
			if ( invalidArchive.includes( error.code ) ) {
				this._archivePath = null;
				this._fail( error );
			} else {
				this._fail( error, "ready" );
			}
			return false;
		}
	},
	async _discardPreparedUpdate() {
		if ( this._installJob && installer.discardUpdate ) {
			await installer.discardUpdate( this._installJob );
		}
		this._installJob = null;
		this._archivePath = null;
	},
	_fail( error, state = "error" ) {
		if ( this.isDestroying || this.isDestroyed ) { return; }
		setProperties( this, { state, errorCode: error && error.code || "UNKNOWN" } );
	},
	_scheduleStartupConfirmation() {
		if ( this._confirmationScheduled || !Process.env.STGUI_UPDATE_JOB ) { return; }
		this._confirmationScheduled = true;
		const settingsReady = this.settings.content ? Promise.resolve()
			: new Promise( resolve => this.settings.one( "initialized", resolve ) );
		const routeReady = this.router.currentRouteName ? Promise.resolve()
			: new Promise( resolve => this.router.one( "routeDidChange", resolve ) );
		Promise.all([ settingsReady, routeReady ])
			.then( () => scheduleOnce( "afterRender", this, () => {
				if ( this.isDestroying || this.isDestroyed ) { return; }
				this._confirmStartup().catch( error => this._fail( error ) );
			}) )
			.catch( error => this._fail( error ) );
	},
	async _confirmStartup() {
		return installer.confirmStartup({
			installDir: this.installDir,
			identity: this.currentBuild
		});
	},
	_getRecord() {
		if ( this._recordPromise ) { return this._recordPromise; }
		this._recordPromise = this._loadRecord().catch( error => {
			this._recordPromise = null;
			throw error;
		});
		return this._recordPromise;
	},
	async _loadRecord() {
		const { store, version } = this;
		let record;
		let existinguser = false;
		try {
			record = await store.findRecord( "versioncheck", 1 );
			existinguser = true;
		} catch ( error ) {
			record = store.peekRecord( "versioncheck", 1 );
			if ( record ) { store.unloadRecord( record ); }
			record = store.createRecord( "versioncheck", { id: 1, version } );
			await record.save();
		}
		set( this, "model", record );
		return existinguser;
	},
	async _showDebugMessage() {
		if ( !isDebug || isDevelopment || Date.now() < this.model.showdebugmessage ) { return; }
		await this.modal.promiseModal( "debug", {
			buildVersion: metadata.version,
			displayName
		}, null, 1000 );
		set( this.model, "showdebugmessage", Date.now() + showDebugMessage );
		await this.model.save();
	},
	async _check( existinguser ) {
		if ( !existinguser ) {
			this._openModalAndCheckForNewRelease( "firstrun" );
			return;
		}
		const { model, version } = this;
		if ( !model.version || semverLt( model.version, version ) ) {
			set( model, "version", version );
			await model.save();
			if ( !argv[ ARG_VERSIONCHECK ] ) {
				this._openModalAndCheckForNewRelease( "changelog" );
				return;
			}
		}
		await this._checkForNewRelease();
	},
	_openModalAndCheckForNewRelease( name ) {
		this.modal.promiseModal( name, this )
			.then( () => this._checkForNewRelease() )
			.catch( error => this._fail( error ) );
	},
	willDestroy() {
		++this._downloadGeneration;
		if ( this._downloadController ) { this._downloadController.abort(); }
		this._super( ...arguments );
	}
});
