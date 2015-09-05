'use strict';


module.exports = function browserify(grunt) {
	// Load task
	grunt.loadNpmTasks('grunt-browserify');

	// Options
	return {
		build: {
			files: {
				'.build/js/app-bundle.js': ['public/js/app.js']
			},
			options: {
				
			}
		}
	};
};