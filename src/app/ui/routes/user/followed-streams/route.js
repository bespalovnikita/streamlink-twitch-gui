import { get } from "@ember/object";
import { on } from "@ember/object/evented";
import { addListener, removeListener } from "@ember/object/events";
import { join } from "@ember/runloop";
import { setInterval, clearInterval } from "timers";
import UserIndexRoute from "ui/routes/user/index/route";
import PaginationMixin from "ui/routes/-mixins/routes/infinite-scroll/pagination";
import RefreshRouteMixin from "ui/routes/-mixins/routes/refresh";


export default UserIndexRoute.extend( PaginationMixin, RefreshRouteMixin, {
	modelName: "twitch-stream-followed",
	modelMapBy: "stream",
	modelPreload: "thumbnail_url.latest",
	itemSelector: ".stream-item-component",

	_autoRefreshTimer: null,
	_autoRefreshPending: false,
	_autoRefreshTransition: null,

	_startAutoRefresh: on( "activate", function() {
		if ( this._autoRefreshTimer !== null ) { return; }

		addListener( this.router, "routeWillChange", this, "_autoRefreshRouteWillChange" );
		this._autoRefreshTimer = setInterval( () => join( this, this._autoRefresh ), 10000 );
	}),

	_stopAutoRefresh: on( "deactivate", function() {
		if ( this._autoRefreshTimer === null ) { return; }

		clearInterval( this._autoRefreshTimer );
		this._autoRefreshTimer = null;
		removeListener( this.router, "routeWillChange", this, "_autoRefreshRouteWillChange" );
	}),

	willDestroy() {
		this._stopAutoRefresh();
		this._super( ...arguments );
	},

	_autoRefreshRouteWillChange( transition ) {
		this._autoRefreshTransition = transition;
		const clearTransition = () => {
			if ( this._autoRefreshTransition === transition ) {
				this._autoRefreshTransition = null;
			}
		};
		transition.then( clearTransition, clearTransition );
	},

	async _autoRefresh() {
		if (
			this._autoRefreshTimer === null
			|| this.isDestroying || this.isDestroyed
			|| this._autoRefreshPending
			|| this._autoRefreshTransition
			|| get( this, "controller.isFetching" )
			|| get( this, "modal.isModalOpened" )
		) { return; }

		this._autoRefreshPending = true;
		try {
			await this.refresh();
		} catch ( e ) {
			// The router handles failed or aborted transitions.
		} finally {
			this._autoRefreshPending = false;
		}
	},

	/**
	 * @param {TwitchStream} twitchStream
	 * @return {Promise}
	 */
	async modelItemLoader( twitchStream ) {
		await Promise.all([
			twitchStream.user.promise,
			twitchStream.channel.promise
		]);
	},

	query() {
		const query = this._super();
		const { user_id } = this.auth.session;

		return Object.assign( query, { user_id } );
	}
});
