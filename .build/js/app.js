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

	$("#btnSubmit").click(function(){
    		
	        dust.render("partial", {name:"index-brws"}, function(err, out) {
	        if(err){
                console.error('error on destination rendering:'+err);
            }
		    $('#container').html(out);
    		}); 
		});
});
