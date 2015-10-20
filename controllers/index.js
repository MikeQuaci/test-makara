'use strict';

var IndexModel = require('../models/index');

var getBundle = require('../lib/getBundle');


module.exports = function (router) {

    var model = new IndexModel();

    router.get('/', function (req, res) {
        console.log('req.locale: '+JSON.stringify(req.locale,0,4));
        console.log('res.locals: '+JSON.stringify(res.locals,0,4));
        
        res.render('index', model);
         
        
    });


    router.get('/setLanguage/:locale', function (req, res) {
        console.log('Changing locale: '+req.params.locale);
    	var backURL=req.header('Referer') || '/';
  		// do your thang
  		res.cookie('locale', req.params.locale);

  		res.redirect(backURL);
       
    });

};
