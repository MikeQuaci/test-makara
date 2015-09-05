(function e(t,n,r){function s(o,u){if(!n[o]){if(!t[o]){var a=typeof require=="function"&&require;if(!u&&a)return a(o,!0);if(i)return i(o,!0);var f=new Error("Cannot find module '"+o+"'");throw f.code="MODULE_NOT_FOUND",f}var l=n[o]={exports:{}};t[o][0].call(l.exports,function(e){var n=t[o][1][e];return s(n?n:e)},l,l.exports,e,t,n,r)}return n[o].exports}var i=typeof require=="function"&&require;for(var o=0;o<r.length;o++)s(r[o]);return s})({1:[function(require,module,exports){
"use strict";
var usecontent = require('dust-usecontent-helper');
var message = require('dust-message-helper');
var iferr = require('iferr');

module.exports = function(dust, debug, options, loader) {
    options = options || {};

    debug("registering");

    // Default to true, but since it imposes some complexity and lack of clarity,
    // about where things come from in the templates, allow it to be disabled.
    var autoloadTemplateContent = options.autoloadTemplateContent == null || options.autoloadTemplateContent;

    debug("will autoload template content? %j", autoloadTemplateContent);

    usecontent.withLoader(loader).registerWith(dust);

    // The message helper is the main user surface from the template side.
    message.registerWith(dust, { enableMetadata: options.enableMetadata });

    // Here's where the dirty bit of auto-wrapping templates with the content
    // load is triggered.
    if (autoloadTemplateContent) {
        wrapOnLoad(dust, loader, debug);
    }
};

function hackGibson(ctx, content, bundle) {
    var oldShiftBlocks = ctx.shiftBlocks;
    var oldPush = ctx.push;

    // Alter the context to wrap each block shifted, so content will be
    // present even in blocks rendered from other templates like layouts.
    ctx.shiftBlocks = function(locals) {
        return oldShiftBlocks.call(this, objMap(locals, function (l) {
            return wrapBlock(l, content, bundle);
        }));
    };

    // Alter the context to apply this same alteration to each context
    // pushed below this one, maintaining this hack for all future
    // context pushes.
    ctx.push = function(/* head, idx, len */) {
        var newCtx = oldPush.apply(this, arguments);
        hackGibson(newCtx, content, bundle);
        return newCtx;
    };
}

function wrapBlock(block, content, bundle) {
    // Return a block that re-pushes the content, and then passes to
    // the original block. This makes sure the content is associated
    // with the auto-loaded content bundle, not coming from the calling
    // context, which could be a different template and have the wrong
    // content loaded.
    return function (chunk, ctx) {
        ctx = ctx.push({intl: { messages: content, bundle: bundle }});
        return block(chunk, ctx);
    };
}

function objMap(obj, fn) {
    var n = {};
    Object.keys(obj).forEach(function (e) {
        n[e] = fn(obj[e]);
    });
    return n;
}

// This is where the magic lies. To get a hook on templates and wrap them with
// javascript that is aware of the template's name
function wrapOnLoad(dust, loader, debug) {
    var oldOnLoad = dust.onLoad;

    if (!oldOnLoad) {
        throw new Error("dust.onLoad must be configured to use automatic content loading");
    }

    debug("wrapping onLoad function to support content autoloading");

    dust.onLoad = function(name, options, cb) {

        var ourLoader = iferr(cb, function (srcOrTemplate) {
            debug("got template %s", srcOrTemplate);

            var tmpl = getTemplate(srcOrTemplate);
            if (!tmpl) {
                debug("Compiling template '%s'", name);
                tmpl = dust.loadSource(dust.compile(srcOrTemplate, name));
            }

            if (tmpl.loadsDefaultContent) {
                newTmpl = tmpl;
            } else {
                debug("wrapping template '%s' to look up default content", tmpl.templateName);
                var newTmpl = function (chunk, ctx) {
                    return chunk.map(function (chunk) {
                        var bundle = tmpl.templateName + '.properties';

                        loader(ctx, bundle, function (err, content) {
                            if (err) {
                                chunk.setError(err);
                            } else {
                                hackGibson(ctx, content, bundle);
                                dust.helpers.useContent(chunk, ctx, { block: tmpl }, { bundle: bundle }).end();
                            }
                        });
                    });
                };
                newTmpl.templateName = tmpl.templateName;
                newTmpl.loadsDefaultContent = true;
                newTmpl.__dustBody = true;
            }

            if (dust.config.cache) {
                // This actually replaces the template registered by
                // compiling and loading above.
                dust.cache[tmpl.templateName] = newTmpl;
            }

            cb(null, newTmpl);
        });

        debug("calling old onLoad to get template '%s'", name);
        if (oldOnLoad.length === 2) {
            return oldOnLoad.call(this, name, ourLoader);
        } else {
            return oldOnLoad.call(this, name, options, ourLoader);
        }
    };

    /**
     * Extracts a template function (body_0) from whatever is passed.
     *
     * This is an extract of the same function from the dustjs source.
     *
     *  nameOrTemplate Could be:
     *   - the name of a template to load from cache
     *   - a CommonJS-compiled template (a function with a `template` property)
     *   - a template function
     * returns a template function, if found
     */
    function getTemplate(nameOrTemplate) {
        if(!nameOrTemplate) {
            return null;
        }
        if(typeof nameOrTemplate === 'function' && nameOrTemplate.template) {
            // Sugar away CommonJS module templates
            return nameOrTemplate.template;
        }
        if(dust.isTemplateFn(nameOrTemplate)) {
            // Template functions passed directly
            return nameOrTemplate;
        }
    }
}

},{"dust-message-helper":6,"dust-usecontent-helper":7,"iferr":8}],2:[function(require,module,exports){
"use strict";
var spud = require('spud');
var iferr = require('iferr');
var VError = require('verror');
var debug = require('debuglog')('dust-makara-helpers');
var fs = require('fs');
var aproba = require('aproba');
var bcp47s = require('bcp47-stringify');

var common = require('./common');

module.exports = function(dust, options) {
    options = options || {};

    // We bind the loader for the useContent helper here to the express view
    // class's lookup method. It must be the express 5 style one, asynchronous,
    // and for internationalized lookups to work, it must be the backport and
    // extension provided by engine-munger.
    var loader = function(ctx, bundle, cb) {
        aproba('OSF', arguments);

        debug("content request for '%s'", bundle);

        if (!ctx.options || !ctx.options.view) {
            return cb(makeErr(ctx, bundle));
        }

        var locale = localeFromContext(ctx);

        var cacheKey = bundle + '#' + locale;
        if (dust.config.cache && dust.cache[cacheKey]) {
            debug("found in cache at '%s'", cacheKey);
            return cb(null, dust.cache[cacheKey]);
        }

        debug("performing lookup for template '%s' and locale %j", ctx.templateName, locale);
        ctx.options.view.lookup(bundle, { locale: locale }, iferr(cb, function (file) {
            fs.readFile(file, 'utf-8', iferr(cb, function (data) {
                try {
                    var parsed = spud.parse(data);
                    if (dust.config.cache) {
                        debug("setting cache key '%s' to %j", cacheKey, parsed);
                        dust.cache[cacheKey] = parsed;
                    }

                    cb(null, parsed);
                } catch (e) {
                    cb(e);
                }
            }));
        }));
    };

    common(dust, debug, options, options.loader || loader);


};

function makeErr(ctx, bundle) {
    var str = "no view available rendering template named '%s' and content bundle '%s'";
    debug(str, ctx.templateName, bundle);
    return new VError(str, ctx.templateName, bundle);
}

function stringLocale(locale) {
    debug("normalizing locale %j", locale);
    if (!locale) {
        return undefined;
    } else if (typeof locale === 'string') {
        return locale;
    } else if (locale.country && locale.language) {
        return locale.language + '-' + locale.country;
    } else {
        return bcp47s(locale);
    }
}

function localeFromContext(ctx) {
    // Handle all the backward compatibility names (*Locality) and the new
    // ones, too.
    return stringLocale(ctx.get('contentLocale') || ctx.get('contentLocality') ||
        ctx.get('locale') || ctx.get('locality') || {});
}

module.exports.registerWith = module.exports;

},{"./common":1,"aproba":3,"bcp47-stringify":4,"debuglog":5,"fs":15,"iferr":8,"spud":9,"verror":13}],3:[function(require,module,exports){
"use strict"

var types = {
  "*": ["any", function () { return true }],
  A: ["array", function (thingy) { return thingy instanceof Array || (typeof thingy === "object" && thingy.hasOwnProperty("callee")) }],
  S: ["string", function (thingy) { return typeof thingy === "string" }],
  N: ["number", function (thingy) { return typeof thingy === "number" }],
  F: ["function", function (thingy) { return typeof thingy === "function" }],
  O: ["object", function (thingy) { return typeof thingy === "object" && !types.A[1](thingy) && !types.E[1](thingy) }],
  B: ["boolean", function (thingy) { return typeof thingy == "boolean" }],
  E: ["error", function (thingy) { return thingy instanceof Error }]
}

var validate = module.exports = function (schema, args) {
  if (!schema) throw missingRequiredArg(0, "schema")
  if (!args) throw missingRequiredArg(1, "args")
  if (!types.S[1](schema)) throw invalidType(0, "string", schema)
  if (!types.A[1](args)) throw invalidType(1, "array", args)
  for (var ii = 0; ii < schema.length; ++ii) {
    var type = schema[ii]
    if (!types[type]) throw unknownType(ii, type)
    var typeLabel = types[type][0]
    var typeCheck = types[type][1]
    if (type === "E" && args[ii] == null) continue
    if (args[ii] == null) throw missingRequiredArg(ii)
    if (!typeCheck(args[ii])) throw invalidType(ii, typeLabel, args[ii])
    if (type === "E") return
  }
  if (schema.length < args.length) throw tooManyArgs(schema.length, args.length)
}

function missingRequiredArg(num) {
  return newException("EMISSINGARG", "Missing required argument #"+(num+1))
}

function unknownType(num, type) {
  return newException("EUNKNOWNTYPE", "Unknown type "+type+" in argument #"+(num+1))
}

function invalidType(num, type, value) {
  return newException("EINVALIDTYPE", "Argument #"+(num+1)+": Expected "+type+" but got "+typeof value)
}

function tooManyArgs(expected, got) {
  return newException("ETOOMANYARGS", "Too many arguments, expected "+expected+" and got "+got)
}

function newException(code, msg) {
  var e = new Error(msg)
  e.code = code
  Error.captureStackTrace(e, validate)
  return e
}

},{}],4:[function(require,module,exports){
module.exports = function(tag) {
  if (!tag || typeof tag != 'object') {
    return null;
  } else if (tag.privateuse && tag.privateuse.length) {
    return 'x-' + tag.privateuse.join('-');
  } else if (tag.grandfathered && tag.grandfathered.regular) {
    return tag.grandfathered.regular;
  } else if (tag.grandfathered && tag.grandfathered.irregular) {
    return tag.grandfathered.irregular;
  } else {
    if (!tag.langtag || !tag.langtag.language || !tag.langtag.language.language) return null;
    var extlang = tag.langtag.language.extlang && tag.langtag.language.extlang.length
      ? '-' + tag.langtag.language.extlang.join('-')
      : '';
    var script = tag.langtag.script ? '-' + tag.langtag.script : '';
    var region = tag.langtag.region ? '-' + tag.langtag.region : '';
    var variant = tag.langtag.variant && tag.langtag.variant.length
      ? '-' + tag.langtag.variant.join('-')
      : '';
    var extension = tag.langtag.extension && tag.langtag.extension.length
      ? '-' + tag.langtag.extension.map(flatExtensions).join('-')
      : '';
    var privateuse = tag.langtag.privateuse && tag.langtag.privateuse.length
      ? '-x-' + tag.langtag.privateuse.join('-')
      : '';
    return tag.langtag.language.language + extlang + script + region +
      variant + extension + privateuse;
  }
};

function flatExtensions(ext) {
  return ext.singleton + '-' + ext.extension.join('-');
}

},{}],5:[function(require,module,exports){
(function (process){
var util = require('util');

module.exports = (util && util.debuglog) || debuglog;

var debugs = {};
var debugEnviron = process.env.NODE_DEBUG || '';

function debuglog(set) {
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = util.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};

}).call(this,require('_process'))
},{"_process":20,"util":17}],6:[function(require,module,exports){
'use strict';

var REGIDX = new RegExp('\\$idx', 'g');
var REGKEY = new RegExp('\\$key', 'g');

module.exports = function (dust, options) {
    options = options || {};

    dust.helpers.pre = dust.helpers.message = function message(chunk, ctx, bodies, params) {

        if (params.type && params.type !== 'content') {
            return chunk.write('');
        }

        var before = params.before || '';
        var after = params.after || '';
        var mode = params.mode || '';
        var sep = params.sep || '';

        var value = ctx.get('intl.messages' + '.' + params.key) || ctx.get('messages' + '.' + params.key) || '☃' + params.key + '☃';

        if (typeof value === 'string') {

            value = (mode === 'json') ? JSON.stringify(value) : (before + value + after);

        } else if (typeof value === 'object' && value !== null) {

            // Object or Array
            if (mode === 'json') {
                value = JSON.stringify(value, substitute);
            } else if (mode === 'paired') {
                value = transform(value, asObj(value));
                value = JSON.stringify(value);
            } else {
                value = transform(value, asString(value, before, after));
                value = value.join(sep);
            }

        } else {
            // number, bool, date, etc? not likely, but maybe
            value = String(value);
        }

        if (options.enableMetadata && !params.noEdit) {
            value = '<edit data-key="' + quot(params.key) + '" data-bundle="' + quot(ctx.get('intl.bundle')) + '" data-original="' + quot(value) + '">' + value + '</edit>';
        }

        return chunk.map(function (chunk) {
            /* And thus begins the ugly, possibly expensive hack to run dynamically loaded content through Dust */
            var cacheKey = ctx.templateName + params.key + encodeURI(value).replace(/%/g, '_');
            var tmpl = dust.cache[cacheKey] || dust.loadSource(dust.compile(value, cacheKey));
            tmpl(chunk, ctx).end();
            /* Here endeth the confusion, on Setting Orange, the 56th day of Bureaucracy in the YOLD 3180 */
        });
    };

    function quot(str) {
        return dust.filter(str, undefined, ['h']);
    }
};

module.exports.registerWith = module.exports;

// Replace any $idx or $key values in the element
function substitute(key, value) {
    if (typeof value === 'string') {
        // Test for numeric value. If non-numeric, use $key, else $idx
        var regex = isNaN(parseInt(key, 10)) ? REGKEY : REGIDX;
        value = value.replace(regex, key);
    }
    return value;
}

function asString(obj, before, after) {
    var regex = Array.isArray(obj) ? REGIDX : REGKEY;

    return function stringPredicate(item) {
        var str, b, a, objItem;

        objItem = obj[item];
        // If mode parameter is missing on nested object, fail soft.
        if (typeof objItem !== 'string') {
            return '';
        }
        str = objItem.replace(regex, item);
        b = before.replace(regex, item);
        a = after.replace(regex, item);

        return b + str + a;
    };
}

function asObj(obj) {
    var regex = Array.isArray(obj) ? REGIDX : REGKEY;

    return function objectPredicate(item) {
        var id = parseInt(item, 10);
        if (typeof obj[item] === 'object') {
            var child =  transform(obj[item], asObj(obj[item]));
            return {
                '$id': isNaN(id) ? item : id,
                '$elt': child
            };
        }
        return {
            '$id': isNaN(id) ? item : id,
            '$elt': obj[item].replace(regex, item)
        };
    };

}

function transform (obj, predicate) {
    return Object.keys(obj).map(predicate);
}

},{}],7:[function(require,module,exports){
"use strict";

module.exports = function (lookup) {

    if (typeof lookup !== 'function' || lookup.length !== 3) {
        throw new TypeError("lookup function must be in the form function(context, bundle, callback) { ... }");
    }

    var registerWith = function registerWith(dust) {
        dust.helpers.useContent = useContent;
    };

    registerWith.registerWith = registerWith;

    return registerWith;

    function useContent(chunk, ctx, bodies, params) {
        if (!bodies.block) {
            return chunk;
        }

        return chunk.map(function (chunk) {
            lookup(ctx, params.bundle, function (err, content) {
                if (err) {
                    chunk.setError(err);
                } else {
                    ctx = ctx.push({ intl: { messages: content, bundle: params.bundle } });
                    bodies.block(chunk, ctx).end();
                }
            });
        });
    }
};

module.exports.withLoader = module.exports;

},{}],8:[function(require,module,exports){
// Generated by CoffeeScript 1.7.1
(function() {
  var exports, iferr, printerr, throwerr, tiferr,
    __slice = [].slice;

  iferr = function(fail, succ) {
    return function() {
      var a, err;
      err = arguments[0], a = 2 <= arguments.length ? __slice.call(arguments, 1) : [];
      if (err != null) {
        return fail(err);
      } else {
        return typeof succ === "function" ? succ.apply(null, a) : void 0;
      }
    };
  };

  tiferr = function(fail, succ) {
    return iferr(fail, function() {
      var a, err;
      a = 1 <= arguments.length ? __slice.call(arguments, 0) : [];
      try {
        return succ.apply(null, a);
      } catch (_error) {
        err = _error;
        return fail(err);
      }
    });
  };

  throwerr = iferr.bind(null, function(err) {
    throw err;
  });

  printerr = iferr(function(err) {
    return console.error(err.stack || err);
  });

  module.exports = exports = iferr;

  exports.iferr = iferr;

  exports.tiferr = tiferr;

  exports.throwerr = throwerr;

  exports.printerr = printerr;

}).call(this);

},{}],9:[function(require,module,exports){
module.exports = {
    parse: require('./parse'),
    stringify: require('./stringify')
};

},{"./parse":11,"./stringify":12}],10:[function(require,module,exports){
/*! http://mths.be/fromcodepoint v0.2.1 by @mathias */
if (!String.fromCodePoint) {
	(function() {
		var defineProperty = (function() {
			// IE 8 only supports `Object.defineProperty` on DOM elements
			try {
				var object = {};
				var $defineProperty = Object.defineProperty;
				var result = $defineProperty(object, object, object) && $defineProperty;
			} catch(error) {}
			return result;
		}());
		var stringFromCharCode = String.fromCharCode;
		var floor = Math.floor;
		var fromCodePoint = function(_) {
			var MAX_SIZE = 0x4000;
			var codeUnits = [];
			var highSurrogate;
			var lowSurrogate;
			var index = -1;
			var length = arguments.length;
			if (!length) {
				return '';
			}
			var result = '';
			while (++index < length) {
				var codePoint = Number(arguments[index]);
				if (
					!isFinite(codePoint) || // `NaN`, `+Infinity`, or `-Infinity`
					codePoint < 0 || // not a valid Unicode code point
					codePoint > 0x10FFFF || // not a valid Unicode code point
					floor(codePoint) != codePoint // not an integer
				) {
					throw RangeError('Invalid code point: ' + codePoint);
				}
				if (codePoint <= 0xFFFF) { // BMP code point
					codeUnits.push(codePoint);
				} else { // Astral code point; split in surrogate halves
					// http://mathiasbynens.be/notes/javascript-encoding#surrogate-formulae
					codePoint -= 0x10000;
					highSurrogate = (codePoint >> 10) + 0xD800;
					lowSurrogate = (codePoint % 0x400) + 0xDC00;
					codeUnits.push(highSurrogate, lowSurrogate);
				}
				if (index + 1 == length || codeUnits.length > MAX_SIZE) {
					result += stringFromCharCode.apply(null, codeUnits);
					codeUnits.length = 0;
				}
			}
			return result;
		};
		if (defineProperty) {
			defineProperty(String, 'fromCodePoint', {
				'value': fromCodePoint,
				'configurable': true,
				'writable': true
			});
		} else {
			String.fromCodePoint = fromCodePoint;
		}
	}());
}

},{}],11:[function(require,module,exports){
/***@@@ BEGIN LICENSE @@@***/
/*───────────────────────────────────────────────────────────────────────────*\
│  Copyright (C) 2013 eBay Software Foundation                                │
│                                                                             │
│hh ,'""`.                                                                    │
│  / _  _ \  Licensed under the Apache License, Version 2.0 (the "License");  │
│  |(@)(@)|  you may not use this file except in compliance with the License. │
│  )  __  (  You may obtain a copy of the License at                          │
│ /,'))((`.\                                                                  │
│(( ((  )) ))    http://www.apache.org/licenses/LICENSE-2.0                   │
│ `\ `)(' /'                                                                  │
│                                                                             │
│   Unless required by applicable law or agreed to in writing, software       │
│   distributed under the License is distributed on an "AS IS" BASIS,         │
│   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.  │
│   See the License for the specific language governing permissions and       │
│   limitations under the License.                                            │
\*───────────────────────────────────────────────────────────────────────────*/
/***@@@ END LICENSE @@@***/

'use strict';

var util = require('util'),
	codePointAt = require('string.fromcodepoint');

function getEscapedChar(match) {
	match = match.substring(2).replace(/[\{\}]/g, '');
	return String.fromCodePoint(parseInt(match, 16));
}

function parse(data) {
    var result = {};

    data.split(/\r?\n/).forEach(function (line) {
        var kvp = line.match(/^(?!\s*#)([^=]+)=(.+)$/),
            key = null,
            value = null;

        if (Array.isArray(kvp) && kvp.length > 1) {
            key = kvp[1].trim();
            value = kvp[2];
            if (key.indexOf('\\u') !== -1) {
                //ES6 format: \u{xxxxxx}
                if (key.indexOf('\\u{') !== -1) {
                    key = key.replace(/(\\u\{[A-Z0-9]{1,6}})/gi, getEscapedChar);
                } else {
                    key = key.replace(/(\\u[A-Z0-9]{4})/gi, getEscapedChar);
                }
            }

            var tail = result;
            key.split(/\./).forEach(function (prop, index, arr) {

                // Sanitize key
                prop = prop.replace(/\s/g, '');
                // Change to allow most any chars for name and map key
                var arrMap = prop.match(/^([^\[]+)\[(.*)\]$/);
                if ( Array.isArray(arrMap) && arrMap.length > 1 ) {
                    var arrKey = arrMap[1];
                    if ( arrMap[2] !== '' ) {
                        // If previous value is present for this key, use it, otherwise new object
                        arrMap[2].split(/\]\[/).forEach(function (arrProp, arrIndex, subArr) {
                            // Iterate over the property keys
                            if ( arrProp.match(/^[0-9]+$/) ) {
                                if ( arrIndex === 0 ) {
                                    tail = tail[arrKey] = (typeof tail[arrKey] !== 'undefined' && typeof tail[arrKey] === 'object') ? tail[arrKey] : [];
                                }
                                // Assign the value if it's the last key in the set
                                tail[arrProp] = ( arrIndex === subArr.length - 1 ) ? value : tail[arrProp] || [];
                            } else {
                                if ( arrIndex === 0 ) {
                                    tail = tail[arrKey] = (typeof tail[arrKey] !== 'undefined' && typeof tail[arrKey] === 'object') ? tail[arrKey] : {};
                                }
                                // Assign the value if it's the last key in the set
                                tail[arrProp] = ( arrIndex === subArr.length - 1 ) ? value : tail[arrProp] || {};
                            }
                            tail = tail[arrProp];
                        });
                    }
                } else if (index === arr.length - 1) {
                    // On the final property in the namespace
                    // Property wasn't yet defined, so just set a value
                    tail[prop] = value;
                } else {
                    // Continue through the namespace. If a property
                    // was defined in a previous iteration, use it,
                    // otherwise, create an empty object and move on.
                    tail = tail[prop] = (tail[prop] || {});
                }
            });
        }
    });

    return result;
}

module.exports = parse;

},{"string.fromcodepoint":10,"util":22}],12:[function(require,module,exports){
/***@@@ BEGIN LICENSE @@@***/
/*───────────────────────────────────────────────────────────────────────────*\
│  Copyright (C) 2013 eBay Software Foundation                                │
│                                                                             │
│hh ,'""`.                                                                    │
│  / _  _ \  Licensed under the Apache License, Version 2.0 (the "License");  │
│  |(@)(@)|  you may not use this file except in compliance with the License. │
│  )  __  (  You may obtain a copy of the License at                          │
│ /,'))((`.\                                                                  │
│(( ((  )) ))    http://www.apache.org/licenses/LICENSE-2.0                   │
│ `\ `)(' /'                                                                  │
│                                                                             │
│   Unless required by applicable law or agreed to in writing, software       │
│   distributed under the License is distributed on an "AS IS" BASIS,         │
│   WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.  │
│   See the License for the specific language governing permissions and       │
│   limitations under the License.                                            │
\*───────────────────────────────────────────────────────────────────────────*/
/***@@@ END LICENSE @@@***/

'use strict';

var os = require('os'),
	util = require('util');


function stringify(obj) {
    if (typeof obj !== 'object') {
        throw new Error("Can only stringify an object");
    }

    return Object.keys(obj).map(function (k) { 
        return el(k, obj[k]);
    }).join('');

    function el(namespace, data) {

        // TODO: Some more work in this direction to make it
        // super fast, if necessary.

        switch (typeof data) {
            case 'object':
                if (Array.isArray(data)) {
                    return data.map(function (item) {
                        return el(namespace, item);
                    }).join('');
                } else {
                    return Object.keys(data).map(function (key) {
                        var name = namespace ? namespace + '.' + key : key;
                        return el(name, data[key]);
                    }).join('');
                }
                break;

            case 'number':
                return el(namespace, Number.isFinite(data) ? String(data) : '');

            case 'boolean':
                return el(namespace, String(data));

            case 'null':
                return el(namespace, String(data));

            case 'string':
                return [namespace, '=', data, os.EOL].join('');

            default:
                throw new Error('Unserializable value: ' + data);
        }
    }
}

module.exports = stringify;

},{"os":19,"util":22}],13:[function(require,module,exports){
/*
 * verror.js: richer JavaScript errors
 */

var mod_assert = require('assert');
var mod_util = require('util');

var mod_extsprintf = require('extsprintf');

/*
 * Public interface
 */

/* So you can 'var VError = require('verror')' */
module.exports = VError;
/* For compatibility */
VError.VError = VError;
/* Other exported classes */
VError.SError = SError;
VError.WError = WError;
VError.MultiError = MultiError;

/*
 * VError([cause], fmt[, arg...]): Like JavaScript's built-in Error class, but
 * supports a "cause" argument (another error) and a printf-style message.  The
 * cause argument can be null or omitted entirely.
 *
 * Examples:
 *
 * CODE                                    MESSAGE
 * new VError('something bad happened')    "something bad happened"
 * new VError('missing file: "%s"', file)  "missing file: "/etc/passwd"
 *   with file = '/etc/passwd'
 * new VError(err, 'open failed')          "open failed: file not found"
 *   with err.message = 'file not found'
 */
function VError(options)
{
	var args, obj, causedBy, ctor, tailmsg;

	/*
	 * This is a regrettable pattern, but JavaScript's built-in Error class
	 * is defined to work this way, so we allow the constructor to be called
	 * without "new".
	 */
	if (!(this instanceof VError)) {
		args = Array.prototype.slice.call(arguments, 0);
		obj = Object.create(VError.prototype);
		VError.apply(obj, arguments);
		return (obj);
	}

	if (options instanceof Error || typeof (options) === 'object') {
		args = Array.prototype.slice.call(arguments, 1);
	} else {
		args = Array.prototype.slice.call(arguments, 0);
		options = undefined;
	}

	/*
	 * extsprintf (which we invoke here with our caller's arguments in order
	 * to construct this Error's message) is strict in its interpretation of
	 * values to be processed by the "%s" specifier.  The value passed to
	 * extsprintf must actually be a string or something convertible to a
	 * String using .toString().  Passing other values (notably "null" and
	 * "undefined") is considered a programmer error.  The assumption is
	 * that if you actually want to print the string "null" or "undefined",
	 * then that's easy to do that when you're calling extsprintf; on the
	 * other hand, if you did NOT want that (i.e., there's actually a bug
	 * where the program assumes some variable is non-null and tries to
	 * print it, which might happen when constructing a packet or file in
	 * some specific format), then it's better to stop immediately than
	 * produce bogus output.
	 *
	 * However, sometimes the bug is only in the code calling VError, and a
	 * programmer might prefer to have the error message contain "null" or
	 * "undefined" rather than have the bug in the error path crash the
	 * program (making the first bug harder to identify).  For that reason,
	 * by default VError converts "null" or "undefined" arguments to their
	 * string representations and passes those to extsprintf.  Programmers
	 * desiring the strict behavior can use the SError class or pass the
	 * "strict" option to the VError constructor.
	 */
	if (!options || !options.strict) {
		args = args.map(function (a) {
			return (a === null ? 'null' :
			    a === undefined ? 'undefined' : a);
		});
	}

	tailmsg = args.length > 0 ?
	    mod_extsprintf.sprintf.apply(null, args) : '';
	this.jse_shortmsg = tailmsg;
	this.jse_summary = tailmsg;

	if (options) {
		causedBy = options.cause;

		if (!causedBy || !(options.cause instanceof Error))
			causedBy = options;

		if (causedBy && (causedBy instanceof Error)) {
			this.jse_cause = causedBy;
			this.jse_summary += ': ' + causedBy.message;
		}
	}

	this.message = this.jse_summary;
	Error.call(this, this.jse_summary);

	if (Error.captureStackTrace) {
		ctor = options ? options.constructorOpt : undefined;
		ctor = ctor || arguments.callee;
		Error.captureStackTrace(this, ctor);
	}

	return (this);
}

mod_util.inherits(VError, Error);
VError.prototype.name = 'VError';

VError.prototype.toString = function ve_toString()
{
	var str = (this.hasOwnProperty('name') && this.name ||
		this.constructor.name || this.constructor.prototype.name);
	if (this.message)
		str += ': ' + this.message;

	return (str);
};

VError.prototype.cause = function ve_cause()
{
	return (this.jse_cause);
};


/*
 * SError is like VError, but stricter about types.  You cannot pass "null" or
 * "undefined" as string arguments to the formatter.  Since SError is only a
 * different function, not really a different class, we don't set
 * SError.prototype.name.
 */
function SError()
{
	var fmtargs, opts, key, args;

	opts = {};
	opts.constructorOpt = SError;

	if (arguments[0] instanceof Error) {
		opts.cause = arguments[0];
		fmtargs = Array.prototype.slice.call(arguments, 1);
	} else if (typeof (arguments[0]) == 'object') {
		for (key in arguments[0])
			opts[key] = arguments[0][key];
		fmtargs = Array.prototype.slice.call(arguments, 1);
	} else {
		fmtargs = Array.prototype.slice.call(arguments, 0);
	}

	opts.strict = true;
	args = [ opts ].concat(fmtargs);
	VError.apply(this, args);
}

mod_util.inherits(SError, VError);


/*
 * Represents a collection of errors for the purpose of consumers that generally
 * only deal with one error.  Callers can extract the individual errors
 * contained in this object, but may also just treat it as a normal single
 * error, in which case a summary message will be printed.
 */
function MultiError(errors)
{
	mod_assert.ok(errors.length > 0);
	this.ase_errors = errors;

	VError.call(this, errors[0], 'first of %d error%s',
	    errors.length, errors.length == 1 ? '' : 's');
}

mod_util.inherits(MultiError, VError);


/*
 * Like JavaScript's built-in Error class, but supports a "cause" argument which
 * is wrapped, not "folded in" as with VError.	Accepts a printf-style message.
 * The cause argument can be null.
 */
function WError(options)
{
	Error.call(this);

	var args, cause, ctor;
	if (typeof (options) === 'object') {
		args = Array.prototype.slice.call(arguments, 1);
	} else {
		args = Array.prototype.slice.call(arguments, 0);
		options = undefined;
	}

	if (args.length > 0) {
		this.message = mod_extsprintf.sprintf.apply(null, args);
	} else {
		this.message = '';
	}

	if (options) {
		if (options instanceof Error) {
			cause = options;
		} else {
			cause = options.cause;
			ctor = options.constructorOpt;
		}
	}

	Error.captureStackTrace(this, ctor || this.constructor);
	if (cause)
		this.cause(cause);

}

mod_util.inherits(WError, Error);
WError.prototype.name = 'WError';


WError.prototype.toString = function we_toString()
{
	var str = (this.hasOwnProperty('name') && this.name ||
		this.constructor.name || this.constructor.prototype.name);
	if (this.message)
		str += ': ' + this.message;
	if (this.we_cause && this.we_cause.message)
		str += '; caused by ' + this.we_cause.toString();

	return (str);
};

WError.prototype.cause = function we_cause(c)
{
	if (c instanceof Error)
		this.we_cause = c;

	return (this.we_cause);
};

},{"assert":16,"extsprintf":14,"util":22}],14:[function(require,module,exports){
(function (process){
/*
 * extsprintf.js: extended POSIX-style sprintf
 */

var mod_assert = require('assert');
var mod_util = require('util');

/*
 * Public interface
 */
exports.sprintf = jsSprintf;
exports.printf = jsPrintf;

/*
 * Stripped down version of s[n]printf(3c).  We make a best effort to throw an
 * exception when given a format string we don't understand, rather than
 * ignoring it, so that we won't break existing programs if/when we go implement
 * the rest of this.
 *
 * This implementation currently supports specifying
 *	- field alignment ('-' flag),
 * 	- zero-pad ('0' flag)
 *	- always show numeric sign ('+' flag),
 *	- field width
 *	- conversions for strings, decimal integers, and floats (numbers).
 *	- argument size specifiers.  These are all accepted but ignored, since
 *	  Javascript has no notion of the physical size of an argument.
 *
 * Everything else is currently unsupported, most notably precision, unsigned
 * numbers, non-decimal numbers, and characters.
 */
function jsSprintf(fmt)
{
	var regex = [
	    '([^%]*)',				/* normal text */
	    '%',				/* start of format */
	    '([\'\\-+ #0]*?)',			/* flags (optional) */
	    '([1-9]\\d*)?',			/* width (optional) */
	    '(\\.([1-9]\\d*))?',		/* precision (optional) */
	    '[lhjztL]*?',			/* length mods (ignored) */
	    '([diouxXfFeEgGaAcCsSp%jr])'	/* conversion */
	].join('');

	var re = new RegExp(regex);
	var args = Array.prototype.slice.call(arguments, 1);
	var flags, width, precision, conversion;
	var left, pad, sign, arg, match;
	var ret = '';
	var argn = 1;

	mod_assert.equal('string', typeof (fmt));

	while ((match = re.exec(fmt)) !== null) {
		ret += match[1];
		fmt = fmt.substring(match[0].length);

		flags = match[2] || '';
		width = match[3] || 0;
		precision = match[4] || '';
		conversion = match[6];
		left = false;
		sign = false;
		pad = ' ';

		if (conversion == '%') {
			ret += '%';
			continue;
		}

		if (args.length === 0)
			throw (new Error('too few args to sprintf'));

		arg = args.shift();
		argn++;

		if (flags.match(/[\' #]/))
			throw (new Error(
			    'unsupported flags: ' + flags));

		if (precision.length > 0)
			throw (new Error(
			    'non-zero precision not supported'));

		if (flags.match(/-/))
			left = true;

		if (flags.match(/0/))
			pad = '0';

		if (flags.match(/\+/))
			sign = true;

		switch (conversion) {
		case 's':
			if (arg === undefined || arg === null)
				throw (new Error('argument ' + argn +
				    ': attempted to print undefined or null ' +
				    'as a string'));
			ret += doPad(pad, width, left, arg.toString());
			break;

		case 'd':
			arg = Math.floor(arg);
			/*jsl:fallthru*/
		case 'f':
			sign = sign && arg > 0 ? '+' : '';
			ret += sign + doPad(pad, width, left,
			    arg.toString());
			break;

		case 'x':
			ret += doPad(pad, width, left, arg.toString(16));
			break;

		case 'j': /* non-standard */
			if (width === 0)
				width = 10;
			ret += mod_util.inspect(arg, false, width);
			break;

		case 'r': /* non-standard */
			ret += dumpException(arg);
			break;

		default:
			throw (new Error('unsupported conversion: ' +
			    conversion));
		}
	}

	ret += fmt;
	return (ret);
}

function jsPrintf() {
	process.stdout.write(jsSprintf.apply(this, arguments));
}

function doPad(chr, width, left, str)
{
	var ret = str;

	while (ret.length < width) {
		if (left)
			ret += chr;
		else
			ret = chr + ret;
	}

	return (ret);
}

/*
 * This function dumps long stack traces for exceptions having a cause() method.
 * See node-verror for an example.
 */
function dumpException(ex)
{
	var ret;

	if (!(ex instanceof Error))
		throw (new Error(jsSprintf('invalid type for %%r: %j', ex)));

	/* Note that V8 prepends "ex.stack" with ex.toString(). */
	ret = 'EXCEPTION: ' + ex.constructor.name + ': ' + ex.stack;

	if (ex.cause && typeof (ex.cause) === 'function') {
		var cex = ex.cause();
		if (cex) {
			ret += '\nCaused by: ' + dumpException(cex);
		}
	}

	return (ret);
}

}).call(this,require('_process'))
},{"_process":20,"assert":16,"util":22}],15:[function(require,module,exports){

},{}],16:[function(require,module,exports){
// http://wiki.commonjs.org/wiki/Unit_Testing/1.0
//
// THIS IS NOT TESTED NOR LIKELY TO WORK OUTSIDE V8!
//
// Originally from narwhal.js (http://narwhaljs.org)
// Copyright (c) 2009 Thomas Robinson <280north.com>
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the 'Software'), to
// deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or
// sell copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in
// all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN
// ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION
// WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

// when used in node, this will actually load the util module we depend on
// versus loading the builtin util module as happens otherwise
// this is a bug in node module loading as far as I am concerned
var util = require('util/');

var pSlice = Array.prototype.slice;
var hasOwn = Object.prototype.hasOwnProperty;

// 1. The assert module provides functions that throw
// AssertionError's when particular conditions are not met. The
// assert module must conform to the following interface.

var assert = module.exports = ok;

// 2. The AssertionError is defined in assert.
// new assert.AssertionError({ message: message,
//                             actual: actual,
//                             expected: expected })

assert.AssertionError = function AssertionError(options) {
  this.name = 'AssertionError';
  this.actual = options.actual;
  this.expected = options.expected;
  this.operator = options.operator;
  if (options.message) {
    this.message = options.message;
    this.generatedMessage = false;
  } else {
    this.message = getMessage(this);
    this.generatedMessage = true;
  }
  var stackStartFunction = options.stackStartFunction || fail;

  if (Error.captureStackTrace) {
    Error.captureStackTrace(this, stackStartFunction);
  }
  else {
    // non v8 browsers so we can have a stacktrace
    var err = new Error();
    if (err.stack) {
      var out = err.stack;

      // try to strip useless frames
      var fn_name = stackStartFunction.name;
      var idx = out.indexOf('\n' + fn_name);
      if (idx >= 0) {
        // once we have located the function frame
        // we need to strip out everything before it (and its line)
        var next_line = out.indexOf('\n', idx + 1);
        out = out.substring(next_line + 1);
      }

      this.stack = out;
    }
  }
};

// assert.AssertionError instanceof Error
util.inherits(assert.AssertionError, Error);

function replacer(key, value) {
  if (util.isUndefined(value)) {
    return '' + value;
  }
  if (util.isNumber(value) && !isFinite(value)) {
    return value.toString();
  }
  if (util.isFunction(value) || util.isRegExp(value)) {
    return value.toString();
  }
  return value;
}

function truncate(s, n) {
  if (util.isString(s)) {
    return s.length < n ? s : s.slice(0, n);
  } else {
    return s;
  }
}

function getMessage(self) {
  return truncate(JSON.stringify(self.actual, replacer), 128) + ' ' +
         self.operator + ' ' +
         truncate(JSON.stringify(self.expected, replacer), 128);
}

// At present only the three keys mentioned above are used and
// understood by the spec. Implementations or sub modules can pass
// other keys to the AssertionError's constructor - they will be
// ignored.

// 3. All of the following functions must throw an AssertionError
// when a corresponding condition is not met, with a message that
// may be undefined if not provided.  All assertion methods provide
// both the actual and expected values to the assertion error for
// display purposes.

function fail(actual, expected, message, operator, stackStartFunction) {
  throw new assert.AssertionError({
    message: message,
    actual: actual,
    expected: expected,
    operator: operator,
    stackStartFunction: stackStartFunction
  });
}

// EXTENSION! allows for well behaved errors defined elsewhere.
assert.fail = fail;

// 4. Pure assertion tests whether a value is truthy, as determined
// by !!guard.
// assert.ok(guard, message_opt);
// This statement is equivalent to assert.equal(true, !!guard,
// message_opt);. To test strictly for the value true, use
// assert.strictEqual(true, guard, message_opt);.

function ok(value, message) {
  if (!value) fail(value, true, message, '==', assert.ok);
}
assert.ok = ok;

// 5. The equality assertion tests shallow, coercive equality with
// ==.
// assert.equal(actual, expected, message_opt);

assert.equal = function equal(actual, expected, message) {
  if (actual != expected) fail(actual, expected, message, '==', assert.equal);
};

// 6. The non-equality assertion tests for whether two objects are not equal
// with != assert.notEqual(actual, expected, message_opt);

assert.notEqual = function notEqual(actual, expected, message) {
  if (actual == expected) {
    fail(actual, expected, message, '!=', assert.notEqual);
  }
};

// 7. The equivalence assertion tests a deep equality relation.
// assert.deepEqual(actual, expected, message_opt);

assert.deepEqual = function deepEqual(actual, expected, message) {
  if (!_deepEqual(actual, expected)) {
    fail(actual, expected, message, 'deepEqual', assert.deepEqual);
  }
};

function _deepEqual(actual, expected) {
  // 7.1. All identical values are equivalent, as determined by ===.
  if (actual === expected) {
    return true;

  } else if (util.isBuffer(actual) && util.isBuffer(expected)) {
    if (actual.length != expected.length) return false;

    for (var i = 0; i < actual.length; i++) {
      if (actual[i] !== expected[i]) return false;
    }

    return true;

  // 7.2. If the expected value is a Date object, the actual value is
  // equivalent if it is also a Date object that refers to the same time.
  } else if (util.isDate(actual) && util.isDate(expected)) {
    return actual.getTime() === expected.getTime();

  // 7.3 If the expected value is a RegExp object, the actual value is
  // equivalent if it is also a RegExp object with the same source and
  // properties (`global`, `multiline`, `lastIndex`, `ignoreCase`).
  } else if (util.isRegExp(actual) && util.isRegExp(expected)) {
    return actual.source === expected.source &&
           actual.global === expected.global &&
           actual.multiline === expected.multiline &&
           actual.lastIndex === expected.lastIndex &&
           actual.ignoreCase === expected.ignoreCase;

  // 7.4. Other pairs that do not both pass typeof value == 'object',
  // equivalence is determined by ==.
  } else if (!util.isObject(actual) && !util.isObject(expected)) {
    return actual == expected;

  // 7.5 For all other Object pairs, including Array objects, equivalence is
  // determined by having the same number of owned properties (as verified
  // with Object.prototype.hasOwnProperty.call), the same set of keys
  // (although not necessarily the same order), equivalent values for every
  // corresponding key, and an identical 'prototype' property. Note: this
  // accounts for both named and indexed properties on Arrays.
  } else {
    return objEquiv(actual, expected);
  }
}

function isArguments(object) {
  return Object.prototype.toString.call(object) == '[object Arguments]';
}

function objEquiv(a, b) {
  if (util.isNullOrUndefined(a) || util.isNullOrUndefined(b))
    return false;
  // an identical 'prototype' property.
  if (a.prototype !== b.prototype) return false;
  // if one is a primitive, the other must be same
  if (util.isPrimitive(a) || util.isPrimitive(b)) {
    return a === b;
  }
  var aIsArgs = isArguments(a),
      bIsArgs = isArguments(b);
  if ((aIsArgs && !bIsArgs) || (!aIsArgs && bIsArgs))
    return false;
  if (aIsArgs) {
    a = pSlice.call(a);
    b = pSlice.call(b);
    return _deepEqual(a, b);
  }
  var ka = objectKeys(a),
      kb = objectKeys(b),
      key, i;
  // having the same number of owned properties (keys incorporates
  // hasOwnProperty)
  if (ka.length != kb.length)
    return false;
  //the same set of keys (although not necessarily the same order),
  ka.sort();
  kb.sort();
  //~~~cheap key test
  for (i = ka.length - 1; i >= 0; i--) {
    if (ka[i] != kb[i])
      return false;
  }
  //equivalent values for every corresponding key, and
  //~~~possibly expensive deep test
  for (i = ka.length - 1; i >= 0; i--) {
    key = ka[i];
    if (!_deepEqual(a[key], b[key])) return false;
  }
  return true;
}

// 8. The non-equivalence assertion tests for any deep inequality.
// assert.notDeepEqual(actual, expected, message_opt);

assert.notDeepEqual = function notDeepEqual(actual, expected, message) {
  if (_deepEqual(actual, expected)) {
    fail(actual, expected, message, 'notDeepEqual', assert.notDeepEqual);
  }
};

// 9. The strict equality assertion tests strict equality, as determined by ===.
// assert.strictEqual(actual, expected, message_opt);

assert.strictEqual = function strictEqual(actual, expected, message) {
  if (actual !== expected) {
    fail(actual, expected, message, '===', assert.strictEqual);
  }
};

// 10. The strict non-equality assertion tests for strict inequality, as
// determined by !==.  assert.notStrictEqual(actual, expected, message_opt);

assert.notStrictEqual = function notStrictEqual(actual, expected, message) {
  if (actual === expected) {
    fail(actual, expected, message, '!==', assert.notStrictEqual);
  }
};

function expectedException(actual, expected) {
  if (!actual || !expected) {
    return false;
  }

  if (Object.prototype.toString.call(expected) == '[object RegExp]') {
    return expected.test(actual);
  } else if (actual instanceof expected) {
    return true;
  } else if (expected.call({}, actual) === true) {
    return true;
  }

  return false;
}

function _throws(shouldThrow, block, expected, message) {
  var actual;

  if (util.isString(expected)) {
    message = expected;
    expected = null;
  }

  try {
    block();
  } catch (e) {
    actual = e;
  }

  message = (expected && expected.name ? ' (' + expected.name + ').' : '.') +
            (message ? ' ' + message : '.');

  if (shouldThrow && !actual) {
    fail(actual, expected, 'Missing expected exception' + message);
  }

  if (!shouldThrow && expectedException(actual, expected)) {
    fail(actual, expected, 'Got unwanted exception' + message);
  }

  if ((shouldThrow && actual && expected &&
      !expectedException(actual, expected)) || (!shouldThrow && actual)) {
    throw actual;
  }
}

// 11. Expected to throw an error:
// assert.throws(block, Error_opt, message_opt);

assert.throws = function(block, /*optional*/error, /*optional*/message) {
  _throws.apply(this, [true].concat(pSlice.call(arguments)));
};

// EXTENSION! This is annoying to write outside this module.
assert.doesNotThrow = function(block, /*optional*/message) {
  _throws.apply(this, [false].concat(pSlice.call(arguments)));
};

assert.ifError = function(err) { if (err) {throw err;}};

var objectKeys = Object.keys || function (obj) {
  var keys = [];
  for (var key in obj) {
    if (hasOwn.call(obj, key)) keys.push(key);
  }
  return keys;
};

},{"util/":22}],17:[function(require,module,exports){
arguments[4][15][0].apply(exports,arguments)
},{"dup":15}],18:[function(require,module,exports){
if (typeof Object.create === 'function') {
  // implementation from standard node.js 'util' module
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    ctor.prototype = Object.create(superCtor.prototype, {
      constructor: {
        value: ctor,
        enumerable: false,
        writable: true,
        configurable: true
      }
    });
  };
} else {
  // old school shim for old browsers
  module.exports = function inherits(ctor, superCtor) {
    ctor.super_ = superCtor
    var TempCtor = function () {}
    TempCtor.prototype = superCtor.prototype
    ctor.prototype = new TempCtor()
    ctor.prototype.constructor = ctor
  }
}

},{}],19:[function(require,module,exports){
exports.endianness = function () { return 'LE' };

exports.hostname = function () {
    if (typeof location !== 'undefined') {
        return location.hostname
    }
    else return '';
};

exports.loadavg = function () { return [] };

exports.uptime = function () { return 0 };

exports.freemem = function () {
    return Number.MAX_VALUE;
};

exports.totalmem = function () {
    return Number.MAX_VALUE;
};

exports.cpus = function () { return [] };

exports.type = function () { return 'Browser' };

exports.release = function () {
    if (typeof navigator !== 'undefined') {
        return navigator.appVersion;
    }
    return '';
};

exports.networkInterfaces
= exports.getNetworkInterfaces
= function () { return {} };

exports.arch = function () { return 'javascript' };

exports.platform = function () { return 'browser' };

exports.tmpdir = exports.tmpDir = function () {
    return '/tmp';
};

exports.EOL = '\n';

},{}],20:[function(require,module,exports){
// shim for using process in browser

var process = module.exports = {};
var queue = [];
var draining = false;
var currentQueue;
var queueIndex = -1;

function cleanUpNextTick() {
    draining = false;
    if (currentQueue.length) {
        queue = currentQueue.concat(queue);
    } else {
        queueIndex = -1;
    }
    if (queue.length) {
        drainQueue();
    }
}

function drainQueue() {
    if (draining) {
        return;
    }
    var timeout = setTimeout(cleanUpNextTick);
    draining = true;

    var len = queue.length;
    while(len) {
        currentQueue = queue;
        queue = [];
        while (++queueIndex < len) {
            currentQueue[queueIndex].run();
        }
        queueIndex = -1;
        len = queue.length;
    }
    currentQueue = null;
    draining = false;
    clearTimeout(timeout);
}

process.nextTick = function (fun) {
    var args = new Array(arguments.length - 1);
    if (arguments.length > 1) {
        for (var i = 1; i < arguments.length; i++) {
            args[i - 1] = arguments[i];
        }
    }
    queue.push(new Item(fun, args));
    if (queue.length === 1 && !draining) {
        setTimeout(drainQueue, 0);
    }
};

// v8 likes predictible objects
function Item(fun, array) {
    this.fun = fun;
    this.array = array;
}
Item.prototype.run = function () {
    this.fun.apply(null, this.array);
};
process.title = 'browser';
process.browser = true;
process.env = {};
process.argv = [];
process.version = ''; // empty string to avoid regexp issues
process.versions = {};

function noop() {}

process.on = noop;
process.addListener = noop;
process.once = noop;
process.off = noop;
process.removeListener = noop;
process.removeAllListeners = noop;
process.emit = noop;

process.binding = function (name) {
    throw new Error('process.binding is not supported');
};

// TODO(shtylman)
process.cwd = function () { return '/' };
process.chdir = function (dir) {
    throw new Error('process.chdir is not supported');
};
process.umask = function() { return 0; };

},{}],21:[function(require,module,exports){
module.exports = function isBuffer(arg) {
  return arg && typeof arg === 'object'
    && typeof arg.copy === 'function'
    && typeof arg.fill === 'function'
    && typeof arg.readUInt8 === 'function';
}
},{}],22:[function(require,module,exports){
(function (process,global){
// Copyright Joyent, Inc. and other Node contributors.
//
// Permission is hereby granted, free of charge, to any person obtaining a
// copy of this software and associated documentation files (the
// "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish,
// distribute, sublicense, and/or sell copies of the Software, and to permit
// persons to whom the Software is furnished to do so, subject to the
// following conditions:
//
// The above copyright notice and this permission notice shall be included
// in all copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS
// OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
// MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN
// NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
// DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE
// USE OR OTHER DEALINGS IN THE SOFTWARE.

var formatRegExp = /%[sdj%]/g;
exports.format = function(f) {
  if (!isString(f)) {
    var objects = [];
    for (var i = 0; i < arguments.length; i++) {
      objects.push(inspect(arguments[i]));
    }
    return objects.join(' ');
  }

  var i = 1;
  var args = arguments;
  var len = args.length;
  var str = String(f).replace(formatRegExp, function(x) {
    if (x === '%%') return '%';
    if (i >= len) return x;
    switch (x) {
      case '%s': return String(args[i++]);
      case '%d': return Number(args[i++]);
      case '%j':
        try {
          return JSON.stringify(args[i++]);
        } catch (_) {
          return '[Circular]';
        }
      default:
        return x;
    }
  });
  for (var x = args[i]; i < len; x = args[++i]) {
    if (isNull(x) || !isObject(x)) {
      str += ' ' + x;
    } else {
      str += ' ' + inspect(x);
    }
  }
  return str;
};


// Mark that a method should not be used.
// Returns a modified function which warns once by default.
// If --no-deprecation is set, then it is a no-op.
exports.deprecate = function(fn, msg) {
  // Allow for deprecating things in the process of starting up.
  if (isUndefined(global.process)) {
    return function() {
      return exports.deprecate(fn, msg).apply(this, arguments);
    };
  }

  if (process.noDeprecation === true) {
    return fn;
  }

  var warned = false;
  function deprecated() {
    if (!warned) {
      if (process.throwDeprecation) {
        throw new Error(msg);
      } else if (process.traceDeprecation) {
        console.trace(msg);
      } else {
        console.error(msg);
      }
      warned = true;
    }
    return fn.apply(this, arguments);
  }

  return deprecated;
};


var debugs = {};
var debugEnviron;
exports.debuglog = function(set) {
  if (isUndefined(debugEnviron))
    debugEnviron = process.env.NODE_DEBUG || '';
  set = set.toUpperCase();
  if (!debugs[set]) {
    if (new RegExp('\\b' + set + '\\b', 'i').test(debugEnviron)) {
      var pid = process.pid;
      debugs[set] = function() {
        var msg = exports.format.apply(exports, arguments);
        console.error('%s %d: %s', set, pid, msg);
      };
    } else {
      debugs[set] = function() {};
    }
  }
  return debugs[set];
};


/**
 * Echos the value of a value. Trys to print the value out
 * in the best way possible given the different types.
 *
 * @param {Object} obj The object to print out.
 * @param {Object} opts Optional options object that alters the output.
 */
/* legacy: obj, showHidden, depth, colors*/
function inspect(obj, opts) {
  // default options
  var ctx = {
    seen: [],
    stylize: stylizeNoColor
  };
  // legacy...
  if (arguments.length >= 3) ctx.depth = arguments[2];
  if (arguments.length >= 4) ctx.colors = arguments[3];
  if (isBoolean(opts)) {
    // legacy...
    ctx.showHidden = opts;
  } else if (opts) {
    // got an "options" object
    exports._extend(ctx, opts);
  }
  // set default options
  if (isUndefined(ctx.showHidden)) ctx.showHidden = false;
  if (isUndefined(ctx.depth)) ctx.depth = 2;
  if (isUndefined(ctx.colors)) ctx.colors = false;
  if (isUndefined(ctx.customInspect)) ctx.customInspect = true;
  if (ctx.colors) ctx.stylize = stylizeWithColor;
  return formatValue(ctx, obj, ctx.depth);
}
exports.inspect = inspect;


// http://en.wikipedia.org/wiki/ANSI_escape_code#graphics
inspect.colors = {
  'bold' : [1, 22],
  'italic' : [3, 23],
  'underline' : [4, 24],
  'inverse' : [7, 27],
  'white' : [37, 39],
  'grey' : [90, 39],
  'black' : [30, 39],
  'blue' : [34, 39],
  'cyan' : [36, 39],
  'green' : [32, 39],
  'magenta' : [35, 39],
  'red' : [31, 39],
  'yellow' : [33, 39]
};

// Don't use 'blue' not visible on cmd.exe
inspect.styles = {
  'special': 'cyan',
  'number': 'yellow',
  'boolean': 'yellow',
  'undefined': 'grey',
  'null': 'bold',
  'string': 'green',
  'date': 'magenta',
  // "name": intentionally not styling
  'regexp': 'red'
};


function stylizeWithColor(str, styleType) {
  var style = inspect.styles[styleType];

  if (style) {
    return '\u001b[' + inspect.colors[style][0] + 'm' + str +
           '\u001b[' + inspect.colors[style][1] + 'm';
  } else {
    return str;
  }
}


function stylizeNoColor(str, styleType) {
  return str;
}


function arrayToHash(array) {
  var hash = {};

  array.forEach(function(val, idx) {
    hash[val] = true;
  });

  return hash;
}


function formatValue(ctx, value, recurseTimes) {
  // Provide a hook for user-specified inspect functions.
  // Check that value is an object with an inspect function on it
  if (ctx.customInspect &&
      value &&
      isFunction(value.inspect) &&
      // Filter out the util module, it's inspect function is special
      value.inspect !== exports.inspect &&
      // Also filter out any prototype objects using the circular check.
      !(value.constructor && value.constructor.prototype === value)) {
    var ret = value.inspect(recurseTimes, ctx);
    if (!isString(ret)) {
      ret = formatValue(ctx, ret, recurseTimes);
    }
    return ret;
  }

  // Primitive types cannot have properties
  var primitive = formatPrimitive(ctx, value);
  if (primitive) {
    return primitive;
  }

  // Look up the keys of the object.
  var keys = Object.keys(value);
  var visibleKeys = arrayToHash(keys);

  if (ctx.showHidden) {
    keys = Object.getOwnPropertyNames(value);
  }

  // IE doesn't make error fields non-enumerable
  // http://msdn.microsoft.com/en-us/library/ie/dww52sbt(v=vs.94).aspx
  if (isError(value)
      && (keys.indexOf('message') >= 0 || keys.indexOf('description') >= 0)) {
    return formatError(value);
  }

  // Some type of object without properties can be shortcutted.
  if (keys.length === 0) {
    if (isFunction(value)) {
      var name = value.name ? ': ' + value.name : '';
      return ctx.stylize('[Function' + name + ']', 'special');
    }
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    }
    if (isDate(value)) {
      return ctx.stylize(Date.prototype.toString.call(value), 'date');
    }
    if (isError(value)) {
      return formatError(value);
    }
  }

  var base = '', array = false, braces = ['{', '}'];

  // Make Array say that they are Array
  if (isArray(value)) {
    array = true;
    braces = ['[', ']'];
  }

  // Make functions say that they are functions
  if (isFunction(value)) {
    var n = value.name ? ': ' + value.name : '';
    base = ' [Function' + n + ']';
  }

  // Make RegExps say that they are RegExps
  if (isRegExp(value)) {
    base = ' ' + RegExp.prototype.toString.call(value);
  }

  // Make dates with properties first say the date
  if (isDate(value)) {
    base = ' ' + Date.prototype.toUTCString.call(value);
  }

  // Make error with message first say the error
  if (isError(value)) {
    base = ' ' + formatError(value);
  }

  if (keys.length === 0 && (!array || value.length == 0)) {
    return braces[0] + base + braces[1];
  }

  if (recurseTimes < 0) {
    if (isRegExp(value)) {
      return ctx.stylize(RegExp.prototype.toString.call(value), 'regexp');
    } else {
      return ctx.stylize('[Object]', 'special');
    }
  }

  ctx.seen.push(value);

  var output;
  if (array) {
    output = formatArray(ctx, value, recurseTimes, visibleKeys, keys);
  } else {
    output = keys.map(function(key) {
      return formatProperty(ctx, value, recurseTimes, visibleKeys, key, array);
    });
  }

  ctx.seen.pop();

  return reduceToSingleString(output, base, braces);
}


function formatPrimitive(ctx, value) {
  if (isUndefined(value))
    return ctx.stylize('undefined', 'undefined');
  if (isString(value)) {
    var simple = '\'' + JSON.stringify(value).replace(/^"|"$/g, '')
                                             .replace(/'/g, "\\'")
                                             .replace(/\\"/g, '"') + '\'';
    return ctx.stylize(simple, 'string');
  }
  if (isNumber(value))
    return ctx.stylize('' + value, 'number');
  if (isBoolean(value))
    return ctx.stylize('' + value, 'boolean');
  // For some reason typeof null is "object", so special case here.
  if (isNull(value))
    return ctx.stylize('null', 'null');
}


function formatError(value) {
  return '[' + Error.prototype.toString.call(value) + ']';
}


function formatArray(ctx, value, recurseTimes, visibleKeys, keys) {
  var output = [];
  for (var i = 0, l = value.length; i < l; ++i) {
    if (hasOwnProperty(value, String(i))) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          String(i), true));
    } else {
      output.push('');
    }
  }
  keys.forEach(function(key) {
    if (!key.match(/^\d+$/)) {
      output.push(formatProperty(ctx, value, recurseTimes, visibleKeys,
          key, true));
    }
  });
  return output;
}


function formatProperty(ctx, value, recurseTimes, visibleKeys, key, array) {
  var name, str, desc;
  desc = Object.getOwnPropertyDescriptor(value, key) || { value: value[key] };
  if (desc.get) {
    if (desc.set) {
      str = ctx.stylize('[Getter/Setter]', 'special');
    } else {
      str = ctx.stylize('[Getter]', 'special');
    }
  } else {
    if (desc.set) {
      str = ctx.stylize('[Setter]', 'special');
    }
  }
  if (!hasOwnProperty(visibleKeys, key)) {
    name = '[' + key + ']';
  }
  if (!str) {
    if (ctx.seen.indexOf(desc.value) < 0) {
      if (isNull(recurseTimes)) {
        str = formatValue(ctx, desc.value, null);
      } else {
        str = formatValue(ctx, desc.value, recurseTimes - 1);
      }
      if (str.indexOf('\n') > -1) {
        if (array) {
          str = str.split('\n').map(function(line) {
            return '  ' + line;
          }).join('\n').substr(2);
        } else {
          str = '\n' + str.split('\n').map(function(line) {
            return '   ' + line;
          }).join('\n');
        }
      }
    } else {
      str = ctx.stylize('[Circular]', 'special');
    }
  }
  if (isUndefined(name)) {
    if (array && key.match(/^\d+$/)) {
      return str;
    }
    name = JSON.stringify('' + key);
    if (name.match(/^"([a-zA-Z_][a-zA-Z_0-9]*)"$/)) {
      name = name.substr(1, name.length - 2);
      name = ctx.stylize(name, 'name');
    } else {
      name = name.replace(/'/g, "\\'")
                 .replace(/\\"/g, '"')
                 .replace(/(^"|"$)/g, "'");
      name = ctx.stylize(name, 'string');
    }
  }

  return name + ': ' + str;
}


function reduceToSingleString(output, base, braces) {
  var numLinesEst = 0;
  var length = output.reduce(function(prev, cur) {
    numLinesEst++;
    if (cur.indexOf('\n') >= 0) numLinesEst++;
    return prev + cur.replace(/\u001b\[\d\d?m/g, '').length + 1;
  }, 0);

  if (length > 60) {
    return braces[0] +
           (base === '' ? '' : base + '\n ') +
           ' ' +
           output.join(',\n  ') +
           ' ' +
           braces[1];
  }

  return braces[0] + base + ' ' + output.join(', ') + ' ' + braces[1];
}


// NOTE: These type checking functions intentionally don't use `instanceof`
// because it is fragile and can be easily faked with `Object.create()`.
function isArray(ar) {
  return Array.isArray(ar);
}
exports.isArray = isArray;

function isBoolean(arg) {
  return typeof arg === 'boolean';
}
exports.isBoolean = isBoolean;

function isNull(arg) {
  return arg === null;
}
exports.isNull = isNull;

function isNullOrUndefined(arg) {
  return arg == null;
}
exports.isNullOrUndefined = isNullOrUndefined;

function isNumber(arg) {
  return typeof arg === 'number';
}
exports.isNumber = isNumber;

function isString(arg) {
  return typeof arg === 'string';
}
exports.isString = isString;

function isSymbol(arg) {
  return typeof arg === 'symbol';
}
exports.isSymbol = isSymbol;

function isUndefined(arg) {
  return arg === void 0;
}
exports.isUndefined = isUndefined;

function isRegExp(re) {
  return isObject(re) && objectToString(re) === '[object RegExp]';
}
exports.isRegExp = isRegExp;

function isObject(arg) {
  return typeof arg === 'object' && arg !== null;
}
exports.isObject = isObject;

function isDate(d) {
  return isObject(d) && objectToString(d) === '[object Date]';
}
exports.isDate = isDate;

function isError(e) {
  return isObject(e) &&
      (objectToString(e) === '[object Error]' || e instanceof Error);
}
exports.isError = isError;

function isFunction(arg) {
  return typeof arg === 'function';
}
exports.isFunction = isFunction;

function isPrimitive(arg) {
  return arg === null ||
         typeof arg === 'boolean' ||
         typeof arg === 'number' ||
         typeof arg === 'string' ||
         typeof arg === 'symbol' ||  // ES6 symbol
         typeof arg === 'undefined';
}
exports.isPrimitive = isPrimitive;

exports.isBuffer = require('./support/isBuffer');

function objectToString(o) {
  return Object.prototype.toString.call(o);
}


function pad(n) {
  return n < 10 ? '0' + n.toString(10) : n.toString(10);
}


var months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep',
              'Oct', 'Nov', 'Dec'];

// 26 Feb 16:19:34
function timestamp() {
  var d = new Date();
  var time = [pad(d.getHours()),
              pad(d.getMinutes()),
              pad(d.getSeconds())].join(':');
  return [d.getDate(), months[d.getMonth()], time].join(' ');
}


// log is just a thin wrapper to console.log that prepends a timestamp
exports.log = function() {
  console.log('%s - %s', timestamp(), exports.format.apply(exports, arguments));
};


/**
 * Inherit the prototype methods from one constructor into another.
 *
 * The Function.prototype.inherits from lang.js rewritten as a standalone
 * function (not on Function.prototype). NOTE: If this file is to be loaded
 * during bootstrapping this function needs to be rewritten using some native
 * functions as prototype setup using normal JavaScript does not work as
 * expected during bootstrapping (see mirror.js in r114903).
 *
 * @param {function} ctor Constructor function which needs to inherit the
 *     prototype.
 * @param {function} superCtor Constructor function to inherit prototype from.
 */
exports.inherits = require('inherits');

exports._extend = function(origin, add) {
  // Don't do anything if add isn't an object
  if (!add || !isObject(add)) return origin;

  var keys = Object.keys(add);
  var i = keys.length;
  while (i--) {
    origin[keys[i]] = add[keys[i]];
  }
  return origin;
};

function hasOwnProperty(obj, prop) {
  return Object.prototype.hasOwnProperty.call(obj, prop);
}

}).call(this,require('_process'),typeof global !== "undefined" ? global : typeof self !== "undefined" ? self : typeof window !== "undefined" ? window : {})
},{"./support/isBuffer":21,"_process":20,"inherits":18}],23:[function(require,module,exports){
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

},{"dust-makara-helpers":2}]},{},[23]);
