/*
 * ab.js — a tiny, dependency-free A/B testing harness.
 *
 * Two jobs, nothing more:
 *   1. Deterministically bucket each visitor into a variant, and remember it.
 *   2. Give you an event hook so you can forward exposures / conversions
 *      to whatever analytics sink you like (dataLayer, a beacon, console…).
 *
 * No cookies, no network calls, no build step. Assignment is stable across
 * reloads (localStorage) and degrades to an in-memory id in private/blocked
 * storage. Everything is namespaced under window.AB.
 *
 * Define experiments with AB.define(), then read AB.variant('key'). Listen for
 * events with AB.on('event', cb) or the 'ab:event' CustomEvent on window.
 */
(function (global) {
	'use strict';

	var VISITOR_KEY = 'ab.visitor';
	var ASSIGN_PREFIX = 'ab.assign.';

	// --- storage: localStorage when we can, in-memory when we can't ----------
	var memory = {};
	var store = (function () {
		try {
			var k = '__ab_probe__';
			global.localStorage.setItem(k, '1');
			global.localStorage.removeItem(k);
			return {
				get: function (key) {
					return global.localStorage.getItem(key);
				},
				set: function (key, val) {
					try {
						global.localStorage.setItem(key, val);
					} catch (e) {
						memory[key] = val;
					}
				},
			};
		} catch (e) {
			return {
				get: function (key) {
					return Object.prototype.hasOwnProperty.call(memory, key)
						? memory[key]
						: null;
				},
				set: function (key, val) {
					memory[key] = val;
				},
			};
		}
	})();

	// --- a stable per-visitor id --------------------------------------------
	function makeId() {
		try {
			if (global.crypto && global.crypto.randomUUID) {
				return global.crypto.randomUUID();
			}
		} catch (e) {
			/* fall through */
		}
		return (
			'v-' +
			Date.now().toString(36) +
			'-' +
			Math.random().toString(36).slice(2, 10)
		);
	}

	function visitorId() {
		var id = store.get(VISITOR_KEY);
		if (!id) {
			id = makeId();
			store.set(VISITOR_KEY, id);
		}
		return id;
	}

	// --- deterministic bucketing (FNV-1a → [0,1)) ---------------------------
	function hashToUnit(str) {
		var h = 0x811c9dc5;
		for (var i = 0; i < str.length; i++) {
			h ^= str.charCodeAt(i);
			// 32-bit FNV prime multiply, kept in range with >>> 0
			h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
		}
		return (h >>> 0) / 0x100000000;
	}

	function pickWeighted(variants, unit) {
		var total = 0;
		var i;
		for (i = 0; i < variants.length; i++) {
			total += variants[i].weight != null ? variants[i].weight : 1;
		}
		var threshold = unit * total;
		var running = 0;
		for (i = 0; i < variants.length; i++) {
			running += variants[i].weight != null ? variants[i].weight : 1;
			if (threshold < running) return variants[i];
		}
		return variants[variants.length - 1];
	}

	// --- event hook ----------------------------------------------------------
	var listeners = [];
	function emit(event, payload) {
		var detail = { event: event, payload: payload || {}, ts: Date.now() };

		for (var i = 0; i < listeners.length; i++) {
			try {
				listeners[i](detail);
			} catch (e) {
				/* a broken listener must not break the harness */
			}
		}

		// Bridge to a GTM-style dataLayer if the host page has one.
		try {
			if (Array.isArray(global.dataLayer)) {
				global.dataLayer.push(
					Object.assign({ event: 'ab:' + event }, detail.payload)
				);
			}
		} catch (e) {
			/* no dataLayer, no problem */
		}

		// Bridge to the DOM so external scripts can subscribe without coupling.
		try {
			if (typeof global.CustomEvent === 'function' && global.dispatchEvent) {
				global.dispatchEvent(new CustomEvent('ab:event', { detail: detail }));
			}
		} catch (e) {
			/* environments without CustomEvent still get listeners[] */
		}

		if (AB.debug && global.console) {
			// eslint-disable-next-line no-console
			console.debug('[AB]', event, detail.payload);
		}
	}

	// --- public API ----------------------------------------------------------
	var experiments = {};

	var AB = {
		debug: false,

		/**
		 * Register an experiment. Idempotent — re-defining returns the existing
		 * assignment so hot reloads / double includes stay stable.
		 * @param {string} key
		 * @param {Array<{id:string, weight?:number}>} variants
		 */
		define: function (key, variants) {
			if (!key || !Array.isArray(variants) || variants.length === 0) {
				throw new Error('AB.define(key, variants[]) requires a non-empty list');
			}
			experiments[key] = variants;
			return this.variant(key);
		},

		/**
		 * Resolve (and cache) the variant id for an experiment. Returns null if
		 * the experiment was never defined.
		 * @param {string} key
		 * @returns {string|null}
		 */
		variant: function (key) {
			var variants = experiments[key];
			if (!variants) return null;

			var storeKey = ASSIGN_PREFIX + key;
			var known = store.get(storeKey);
			var ids = variants.map(function (v) {
				return v.id;
			});

			// Honour a previous assignment only if it's still a valid variant.
			if (known && ids.indexOf(known) !== -1) {
				return known;
			}

			var unit = hashToUnit(visitorId() + '::' + key);
			var chosen = pickWeighted(variants, unit).id;
			store.set(storeKey, chosen);
			emit('exposure', { experiment: key, variant: chosen });
			return chosen;
		},

		/**
		 * True when the visitor is in `variantId` for `key`. Handy for guards:
		 *   if (AB.isVariant('speed', 'fast')) { ... }
		 */
		isVariant: function (key, variantId) {
			return this.variant(key) === variantId;
		},

		/** Fire an arbitrary tracking event through the hook. */
		track: function (event, payload) {
			emit(event, payload);
			return this;
		},

		/** Subscribe to every emitted event. Returns an unsubscribe function. */
		on: function (fn) {
			if (typeof fn !== 'function') return function () {};
			listeners.push(fn);
			return function off() {
				var idx = listeners.indexOf(fn);
				if (idx !== -1) listeners.splice(idx, 1);
			};
		},

		/** The current visitor id — exposed for correlating with your backend. */
		visitor: visitorId,

		/** Snapshot of every resolved assignment, for debugging/QA overlays. */
		assignments: function () {
			var out = {};
			Object.keys(experiments).forEach(function (key) {
				out[key] = AB.variant(key);
			});
			return out;
		},
	};

	global.AB = AB;
})(typeof window !== 'undefined' ? window : this);
