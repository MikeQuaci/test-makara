'use strict';

require('dust-makara-helpers').registerWith(dust, {
    enableMetadata: true,
    autoloadTemplateContent: false
});

dust.onLoad = function(templateName, callback) {
  console.log("loading template"+ templateName);
  $.get('/templates/' + templateName + '.js', function(data) {
    var res=dust.loadSource(data);
    callback(null,res);
  });

};


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
	        dust.render("partial-usecontent", {name:"parial-brws"}, function(err, out) {
	        if(err){
                console.error('error on rendering:'+err);
            }
            console.log("render cb");
		    $('#use-contet-container').html(out);
    		}); 
		});
});
