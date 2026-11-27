import Controller from "@ember/controller";
import { computed } from "@ember/object";
import { alias, empty, equal } from "@ember/object/computed";
import { inject as service } from "@ember/service";
import "./styles.less";


export default Controller.extend({
	router: service(),
	searchBar: service( "search-bar" ),

	queryParams: [ "filter", "query" ],

	games   : alias( "model.games" ),
	channels: alias( "model.channels" ),

	notFiltered: equal( "filter", "all" ),

	emptyGames   : empty( "games" ),
	emptyChannels: empty( "channels" ),

	noResults: computed( "emptyGames", "emptyChannels", function() {
		return this.emptyGames && this.emptyChannels;
	}),

	actions: {
		editQuery() {
			this.searchBar.displayQuery({ query: this.query, filter: this.filter }, true );
		},

		searchAll() {
			const queryParams = { query: this.query, filter: "all" };
			this.searchBar.displayQuery( queryParams );
			this.router.transitionTo( "search", { queryParams } );
		}
	}
});
