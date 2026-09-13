/* Sabaq Mushaf — service worker.

   Two jobs:
     1. keep the app itself available with no network,
     2. serve recitation the user saved for offline use.

   Saved audio is written to the `sabaq-audio-v1` cache by the page. Some
   recitation hosts do not send CORS headers, so those responses are stored
   opaque: the page cannot read them, but this worker can hand them straight
   to the <audio> element, which is what makes offline playback work. */

var SHELL = "sabaq-shell-v3";   /* bumped: new files in the shell, so old copies must go */
var AUDIO = "sabaq-audio-v1";
var MODEL = "sabaq-model-v1";   /* the on-device recitation model, and the runtime it needs */

var SHELL_FILES = [
  "./",
  "index.html",
  "styles.css",
  "config.js",
  "tracker.js",
  "ctc-align.js",
  "ctc-engine.js",
  "ctc-worker.js",
  "app.js",
  "manifest.webmanifest",
  "icon-192.png",
  "icon-512.png",
  "data/data-meta.js",
  "data/data-ar.js",
  "data/data-en.js",
  "data/data-tr.js",
  "data/data-wbw.js"
];

self.addEventListener("install", function (e) {
  e.waitUntil(
    caches.open(SHELL).then(function (c) {
      // one miss must not fail the whole install
      return Promise.all(SHELL_FILES.map(function (f) {
        return c.add(f).catch(function () {});
      }));
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== SHELL && k !== AUDIO && k !== MODEL) return caches.delete(k);
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

function isAudio(url) {
  return /\.mp3(\?|$)/i.test(url) || /\/quran\/audio\//.test(url);
}

/* The ONNX runtime and its wasm, wherever config.js points them.
   Matched on the FILENAME, never the whole URL: "ort" is three letters that
   turn up inside ordinary words, so a pattern loose enough to catch
   "ort.min.js" anywhere in a URL also catches every script on a site hosted
   at report., support. or effort. — which quietly routes the app's own code
   into the model cache and half-breaks it. */
function isRuntime(url) {
  var path;
  try { path = new URL(url).pathname; } catch (e) { path = String(url); }
  var file = path.split("/").pop().split("?")[0];
  return /^ort([-.][^/]*)?\.(m?js|wasm)$/i.test(file) || /\/onnxruntime[^/]*\//i.test(path);
}

/* Code changes between deploys; the Qur'an text does not. So the files that
   carry behaviour are fetched fresh when there is a network and fall back to
   the cache when there is not, and the megabytes of text stay cache-first. */
function isCode(url) {
  return /\/(index\.html|app\.js|styles\.css|tracker\.js|ctc-[a-z]+\.js|manifest\.webmanifest)(\?|$)/.test(url) ||
         /\/$/.test(url.split("?")[0]);
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;

  // The model itself is written to its own cache by the page, deliberately
  // and once. It must not also be pulled into the app shell — that is a
  // second 95 MB copy of the same file — so it is left to the network here
  // and served from MODEL by the page, not by this worker.
  if (/model\.int8\.onnx(\?|$)/.test(req.url)) {
    e.respondWith(
      caches.open(MODEL).then(function (c) {
        return c.match(req).then(function (hit) { return hit || fetch(req); });
      }).catch(function () { return fetch(req); })
    );
    return;
  }

  // the runtime: cache it the first time it loads, so the engine works
  // offline afterwards even though it comes from a CDN
  if (isRuntime(req.url)) {
    e.respondWith(
      caches.open(MODEL).then(function (c) {
        return c.match(req, { ignoreVary: true }).then(function (hit) {
          if (hit) return hit;
          return fetch(req).then(function (res) {
            if (res && (res.ok || res.type === "opaque")) c.put(req, res.clone());
            return res;
          });
        });
      }).catch(function () { return fetch(req); })
    );
    return;
  }

  // saved recitation: cache first, network as the fallback
  if (isAudio(req.url)) {
    e.respondWith(
      caches.open(AUDIO).then(function (c) {
        return c.match(req, { ignoreVary: true, ignoreSearch: false }).then(function (hit) {
          return hit || fetch(req);
        });
      }).catch(function () { return fetch(req); })
    );
    return;
  }

  // config.js is the file the owner edits to change reciters, so it is
  // network-first: a deploy takes effect on the next load, not the next
  // service-worker version. The cached copy still covers being offline.
  if (/config\.js(\?|$)/.test(req.url)) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(SHELL).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return caches.match(req); })
    );
    return;
  }

  if (req.url.indexOf(self.registration.scope) !== 0) return;

  // the code: network first, so a redeploy takes effect on the next load
  // rather than the one after it, with the cache behind it for offline use
  if (isCode(req.url)) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(SHELL).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match("index.html");
        });
      })
    );
    return;
  }

  // everything else — the text, the icons — never changes: cache first,
  // refreshed quietly in the background
  e.respondWith(
    caches.match(req).then(function (hit) {
      var net = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(SHELL).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || net;
    })
  );
});
