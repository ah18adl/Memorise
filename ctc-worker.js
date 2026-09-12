/* ------------------------------------------------------------------
   Inference worker.

   Everything expensive happens here so the page stays responsive: a
   6-second window through a 95 MB model is tens of milliseconds of solid
   arithmetic, and on the main thread that is a visible stutter in the
   scrolling mushaf every time it runs.

   The worker owns the ONNX session and nothing else. It is handed raw
   16 kHz mono samples and, optionally, the letter sequence that SHOULD be
   heard; it returns a greedy decode with frame timings and — when a target
   was given — the forced alignment of that target against the same audio.
   ------------------------------------------------------------------ */

/* eslint-env worker */
var ort = null, sess = null, META = null, inputName = "input_values";

function post(m, transfer) { self.postMessage(m, transfer || []); }
function fail(id, msg) { post({ t: "error", id: id, msg: String(msg && msg.message || msg) }); }

self.onmessage = function (ev) {
  var m = ev.data;
  if (m.t === "init") return init(m);
  if (m.t === "infer") return infer(m);
};

function init(m) {
  try {
    importScripts(m.alignUrl);
    importScripts(m.ortUrl);
    ort = self.ort;
    if (m.wasmBase) ort.env.wasm.wasmPaths = m.wasmBase;
    /* One thread. Multi-threaded wasm needs cross-origin isolation headers
       that a plain static host does not send, and falling back noisily at
       runtime is worse than being predictably single-threaded. */
    ort.env.wasm.numThreads = 1;
    ort.env.wasm.simd = true;
    ort.env.logLevel = "error";
  } catch (e) { return fail(null, "could not load the runtime: " + e); }

  META = m.meta;
  ort.InferenceSession.create(m.model, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all"
  }).then(function (s) {
    sess = s;
    if (s.inputNames && s.inputNames.length) inputName = s.inputNames[0];
    post({ t: "ready", inputName: inputName, outputNames: s.outputNames });
  }).catch(function (e) { fail(null, e); });
}

/* CTC scores are only meaningful as log-probabilities: a raw logit says
   nothing about how much better one symbol is than the rest, and the
   aligner's confidences are differences of exactly that. Done in place. */
function logSoftmax(a, T, V) {
  for (var t = 0; t < T; t++) {
    var o = t * V, mx = -Infinity, v;
    for (v = 0; v < V; v++) if (a[o + v] > mx) mx = a[o + v];
    var sum = 0;
    for (v = 0; v < V; v++) sum += Math.exp(a[o + v] - mx);
    var lse = mx + Math.log(sum);
    for (v = 0; v < V; v++) a[o + v] = a[o + v] - lse;
  }
  return a;
}

/* The feature extractor used in training had do_normalize=True, and the
   ONNX export wrapped the model alone — so this step did not come with it.
   Zero-mean, unit-variance per window, exactly as Wav2Vec2FeatureExtractor
   does it. Skipping it does not fail loudly; it just makes every output
   quietly wrong, which is worse. */
function normalise(x) {
  var n = x.length, i, mean = 0, v = 0;
  for (i = 0; i < n; i++) mean += x[i];
  mean /= n || 1;
  for (i = 0; i < n; i++) { var d = x[i] - mean; v += d * d; }
  v /= n || 1;
  var inv = 1 / Math.sqrt(v + 1e-7);
  for (i = 0; i < n; i++) x[i] = (x[i] - mean) * inv;
  return x;
}

function infer(m) {
  if (!sess) return fail(m.id, "not ready");
  var pcm = normalise(m.pcm);
  var t0 = (self.performance || Date).now();
  var feeds = {};
  feeds[inputName] = new ort.Tensor("float32", pcm, [1, pcm.length]);
  sess.run(feeds).then(function (out) {
    var key = sess.outputNames[0];
    var tensor = out[key];
    var dims = tensor.dims;                 /* [1, T, V] */
    var T = dims[1], V = dims[2];
    var logits = Float64Array.from(tensor.data);
    logSoftmax(logits, T, V);

    var A = self.CTCAlign;
    var g = A.greedyTimed(logits, T, V, META.blank);

    var forced = null;
    if (m.target && m.target.length) {
      var f = A.forced(logits, T, V, Array.prototype.slice.call(m.target), META.blank);
      if (f) {
        forced = {
          perFrame: f.perFrame,
          spans: f.spans.map(function (s) {
            return { index: s.index, symbol: s.symbol, start: s.start, end: s.end,
                     frames: s.frames, score: s.score };
          })
        };
      }
    }
    post({
      t: "result", id: m.id, frames: T, vocabSize: V,
      greedy: { ids: g.ids, starts: g.starts, ends: g.ends, scores: g.scores },
      forced: forced,
      ms: (self.performance || Date).now() - t0
    });
  }).catch(function (e) { fail(m.id, e); });
}
