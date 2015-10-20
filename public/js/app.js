'use strict';
/*
//dust is loaded on master template, or here with browserify
var dust = require('dustjs-linkedin');

*/

//language pack loaded with browserify 
require('../../.build/en-US/_languagepack.js');

var langPack={
        "errors/404.properties": {
            "header": "File not found",
            "description": "The URL <code>{url}</code> did not resolve to a route."
        },
        "errors/500.properties": {
            "header": "Internal server error",
            "description": "The URL <code>{url}</code> had the following error <code>{err}</code>."
        },
        "errors/503.properties": {
            "header": "Service unavailable",
            "description": "The service is unavailable. Please try back shortly."
        },
        "index.properties": {
            "greeting": "Hello, {name}!"
        },
        "layouts/master.properties": {
            "greeting": "Hello, {name}!"
        },
        "partial-usecontent.properties": {
            "greeting": "Usecontent, {name}!"
        },
        "partial.properties": {
            "greeting": "Partial, {name}!"
        }
    };


dust.onLoad = function(templateName, callback) {
  console.log("loading template"+ templateName);
  $.get('/templates/' + templateName + '.js', function(data) {
    var res=dust.loadSource(data);
    callback(null,res);
  });

};

var loader = function(ctx, bundle, callback){
    console.log('loader ctx '+JSON.stringify(ctx)+' bundle'+bundle);
    console.log(JSON.stringify(langPack[bundle],0,4));
    callback(null,langPack[bundle]);
};

require('dust-makara-helpers').registerWith(dust, {
    enableMetadata: true,
    autoloadTemplateContent: false,
    loader:loader
});


// TEST 1: Using browser script
/*
require('../components/dust-makara-helpers/browser.js').registerWith(dust, {
    enableMetadata: true,
    autoloadTemplateContent: false
});*/

//TEST 2: using enginmunger
/*
var makeViewClass = require('engine-munger');

var view = makeViewClass({
    "dust": {
        specialization: ''
    },
    "js": {
        specialization: '',
        i18n: {
            fallback: 'en-US',
            contentPath: 'locales'
        }
    }
    });
//*/
/*
var View = makeViewClass({
    properties: {
        root: 'locales',
        i18n: {
            fallback: 'en-US',
            formatPath: function (locale) {
                return path.join(locale.langtag.region, locale.langtag.language.language);
            }
        }
    }
});
*///





$(document).ready(function() {

	$("#btnSubmit1").click(function(){
    		console.log("click");
	        dust.render("partial", {name:"partial-brws"}, function(err, out) {
	        if(err){
                console.error('error on rendering:'+err);
            }
            console.log("render cb");
		    $('#container').html(out);
    		}); 
		});

	$("#btnSubmit0").click(function(){
    		console.log("click");

            //TEST 2 ctx (not working)
            //var ctx = dust.context( {name:"parial-brws"}, { view: new View(name + '.dust', { engines: { ".dust": function() {} } }) });
            //ctx.templateName = "partial-usecontent";

            var ctx = dust.context( {name:"parial-brws"} );
            ctx.templateName = "partial-usecontent"
            //ctx.intl=language;
            //ctx.view=language;
            //ctx.view=view; //TEST2
	        dust.render("partial-usecontent", ctx, function(err, out) {
	        if(err){
                console.error('error on rendering:'+err);
            }
            console.log("render cb");
		    $('#use-contet-container').html(out);
    		}); 
		});
});
