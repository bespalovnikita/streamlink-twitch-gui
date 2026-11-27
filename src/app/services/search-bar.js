import Evented from "@ember/object/evented";
import Service from "@ember/service";


export default Service.extend( Evented, {
	displayQuery( queryParams, focus = false ) {
		this.trigger( "displayQuery", queryParams, focus );
	}
});
