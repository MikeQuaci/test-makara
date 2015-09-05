"use strict";
var fs = require('fs');
var browserify = require('browserify');
var spundle = require('spundle');
var through = require('through2');
var path = require('path');
var glob = require('glob');
var async = require('async');
var mkdirp = require('mkdirp');
var iferr = require('iferr');

module.exports = function build(appRoot, cb) {
    var localeRoot = path.resolve(appRoot, 'locales');

    glob(path.resolve(localeRoot, '*/*/'), function (err, paths) {
        if (err) {
            return cb(err);
        }

        var locales = paths.map(function (p) {
            var m = /(.*)\/(.*)/.exec(path.relative(localeRoot, p));

            return m[2] + '-' + m[1];
        });

        async.each(locales, streamLocale, cb);
    });

    function streamLocale(locale, cb) {
        var b = browserify();
        var output = through();
        var m = /(.*)-(.*)/.exec(locale); // Use a real BCP47 parser.
        var outputRoot = path.resolve(appRoot, path.join('.build', locale));
        mkdirp(outputRoot, iferr(cb, function (out) {
            spundle(path.resolve(appRoot, 'locales'), m[2], m[1], iferr(cb, function (out) {
                b.require(streamOf('module.exports=' + JSON.stringify(out)), { expose: '_languagepack' })
                    .bundle()
                    .pipe(fs.createWriteStream(path.resolve(outputRoot, '_languagepack.js')))
                    .on('finish', cb)
                    .on('error', cb);
            }));
        }));
    }

};

function streamOf(str) {
    var o = through();
    process.nextTick(function () {
        o.end(str);
    });
    return o;
}
