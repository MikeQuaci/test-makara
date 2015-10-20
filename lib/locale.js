'use strict';
var bcp47 = require('bcp47');

module.exports = function () {
    return function (req, res, next) {
        var locale = req.cookies && req.cookies.locale;
        //Set the locality for this response. The template will pick the appropriate bundle
        
        console.log('Middleware setting locale to: '+locale);
        res.locals.locale = req.locale = bcp47.parse(locale);
        
       /* req.locale=locale;
        res.locals.locale =locale;
*/
//*/
        //console.log('Changed to locale: ' +JSON.stringify(res.locals,0,4));

        
        
        next();
    };
};