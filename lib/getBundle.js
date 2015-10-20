'use strict';
var bundle;
var bundalo = require('bundalo');

module.exports = function getBundle(req, res, next) {
	console.log('getbundle');
	var i18n = res.app.kraken.get('i18n');
	var engine = res.app.kraken.get('bundle engine');
	if (bundle === undefined) {
		bundle = bundalo({'contentPath': i18n.contentPath, 'locality': req.locale || i18n.fallback, 'fallback': i18n.fallback, 'engine': engine});
	}
	console.log(JSON.stringify(bundle,0,4));
	res.bundle = bundle;
	next();
};