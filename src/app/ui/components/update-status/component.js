import Component from "@ember/component";
import { inject as service } from "@ember/service";
import layout from "./template.hbs";
import "./styles.less";


export default Component.extend({
	versioncheck: service(),
	layout,
	classNames: [ "update-status-component" ],
	showCheck: true,

	actions: {
		check() { return this.versioncheck.checkNow(); },
		download() { return this.versioncheck.download(); },
		cancel() { this.versioncheck.cancelDownload(); },
		restart() { return this.versioncheck.requestInstall(); }
	}
});
