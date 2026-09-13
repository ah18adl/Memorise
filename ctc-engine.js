/* ------------------------------------------------------------------
   The local recitation engine.

   The browser's own speech recogniser was never built for this. It is
   trained on conversational Arabic, it sends your voice to a vendor's
   server, it needs a network, and it returns words with no timing — so a
   lengthened madd and a clipped one look identical to it. This engine
   replaces it with a CTC acoustic model that runs entirely on the device.

   Two things come out of every window of audio:

     * a greedy decode, turned into words, fed to the same tracker the
       speech-recognition path feeds. Position, skips, drift, substitutions
       — all of that logic stays exactly where it was.
     * a forced alignment of the text that SHOULD be there, which gives a
       start and end frame for every letter. That is the part no transcript
       can provide, and it is what makes letter-level mistakes and madd
       length measurable at all.

   Nothing here knows about the mushaf. It takes audio, it emits words and
   letter timings, and app.js decides what they mean.
   ------------------------------------------------------------------ */

window.SabaqCTC = (function () {
  "use strict";

  var C = (window.SABAQ_CONFIG && window.SABAQ_CONFIG.ctc) || {};
  /* The model may be one file or a list of parts. Parts exist because the
     best free static hosts cap a single file well below 95 MB — Cloudflare
     Pages at 25 MiB — and splitting it is far better than sending the app
     to a second host for one file. Either form works; a plain string is
     simply a list of one. */
  var MODEL_PARTS = (function () {
    var m = C.model || "web-model/model.int8.onnx";
    return (typeof m === "string") ? [m] : m.slice();
  })();
  var MODEL_URL = MODEL_PARTS[0];
  var META_URL = C.meta || "web-model/model.json";
  var ORT_URL = C.ort || "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js";
  var WASM_BASE = C.wasm || "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/";
  var CACHE = "sabaq-model-v1";

  var SR = 16000;
  var SAMPLES_PER_FRAME = 320;     /* wav2vec2 stride: 20 ms at 16 kHz */
  var HOP_MS = 700;                /* how often a window is sent for inference */
  var MAX_WIN = 7.0 * SR;          /* never run the model over more than this */
  var TAIL_FRAMES = 8;             /* 160 ms at the live edge is never committed */

  var state = "idle";
  var meta = null, idToChar = null, worker = null, ready = false;
  var ac = null, stream = null, node = null, src = null;
  var buf = null, bufLen = 0, anchor = 0;     /* anchor: samples already discarded */
  var resample = null;
  var timer = null, busy = false, reqId = 0, fails = 0;
  var emitted = 0, commitEnd = -1;
  var H = {}, expectedFn = null;
  var lastErr = "";

  /* ---------- capability ---------- */

  function supported() {
    return !!(window.WebAssembly && window.Worker && navigator.mediaDevices &&
              navigator.mediaDevices.getUserMedia &&
              (window.AudioContext || window.webkitAudioContext));
  }

  /* ---------- the model file ---------- */

  /* 95 MB is a real download, so it happens once, on purpose, and lives in
     Cache Storage afterwards. Deliberately not bundled with the app shell:
     someone who only wants to read should never pay for it. */

  function cacheOpen() {
    return (window.caches ? caches.open(CACHE) : Promise.reject(new Error("no Cache Storage")));
  }

  /* every part, in order, or null if any one of them is missing */
  function cachedParts() {
    return cacheOpen().then(function (c) {
      return Promise.all(MODEL_PARTS.map(function (u) { return c.match(u); }));
    }).then(function (rs) {
      for (var i = 0; i < rs.length; i++) if (!rs[i]) return null;
      return rs;
    }).catch(function () { return null; });
  }

  function modelPresent() {
    return cachedParts().then(function (rs) { return !!rs; });
  }

  /* what is on disk right now, whether or not it is complete — so a part-way
     download reports honestly instead of claiming nothing is saved */
  function modelBytes() {
    return cacheOpen().then(function (c) {
      return Promise.all(MODEL_PARTS.map(function (u) {
        return c.match(u).then(function (r) {
          return r ? r.clone().arrayBuffer().then(function (b) { return b.byteLength; }) : 0;
        });
      }));
    }).then(function (ns) {
      var t = 0, i;
      for (i = 0; i < ns.length; i++) t += ns[i];
      return t;
    }).catch(function () { return 0; });
  }

  /* Downloads with progress, part by part, skipping anything already
     saved — so a download interrupted at part 3 of 5 resumes there rather
     than starting the 95 MB again. Progress is reported in bytes when the
     total is not yet known, because a fake percentage is worse than none. */
  function download(onProgress) {
    state = "downloading";
    var total = +(C.modelSize || 0);          /* optional hint from config.js */
    var done = 0;

    return cacheOpen().then(function (c) {
      var chain = Promise.resolve();
      MODEL_PARTS.forEach(function (url, i) {
        chain = chain.then(function () {
          return c.match(url).then(function (hit) {
            if (hit) {
              /* already saved — counts toward the total so the bar reflects
                 a resumed download instead of appearing to start from zero */
              return hit.clone().arrayBuffer().then(function (b) {
                done += b.byteLength;
                if (onProgress) onProgress(done, total, i + 1, MODEL_PARTS.length);
              });
            }
            return fetch(url).then(function (res) {
              if (!res.ok) {
                throw new Error("model part " + (i + 1) + " of " + MODEL_PARTS.length +
                                " not found at " + url + " (" + res.status + ")");
              }
              var len = +(res.headers.get("content-length") || 0);
              /* No guessing the total from one part: every part is equal
                 except the last, so multiplying overstates it and the bar
                 stops short of 100%. Either config.js states modelSize —
                 split_model.py prints it — or progress is shown in bytes. */
              if (!res.body || !res.body.getReader || !onProgress) {
                return c.put(url, res.clone()).then(function () { done += len; });
              }
              var reader = res.body.getReader(), chunks = [], got = 0;
              return (function pump() {
                return reader.read().then(function (r) {
                  if (r.done) return;
                  chunks.push(r.value); got += r.value.length;
                  onProgress(done + got, total, i + 1, MODEL_PARTS.length);
                  return pump();
                });
              })().then(function () {
                var blob = new Blob(chunks, { type: "application/octet-stream" });
                return c.put(url, new Response(blob, {
                  headers: { "content-type": "application/octet-stream",
                             "content-length": String(got) }
                }));
              }).then(function () { done += got; });
            });
          });
        });
      });
      return chain;
    }).then(function () { state = "idle"; return true; })
      .catch(function (e) { state = "error"; lastErr = String(e.message || e); throw e; });
  }

  function clearModel() {
    if (!window.caches) return Promise.resolve();
    return caches.delete(CACHE).then(function () { ready = false; return true; });
  }

  /* ---------- bringing the worker up ---------- */

  function load(onProgress) {
    if (ready) return Promise.resolve(true);
    state = "loading";
    return download(onProgress)
      .then(function () { return fetch(META_URL); })
      .then(function (r) {
        if (!r.ok) throw new Error("model.json missing beside the model");
        return r.json();
      })
      .then(function (j) {
        meta = j;
        idToChar = [];
        for (var ch in j.vocab) if (Object.prototype.hasOwnProperty.call(j.vocab, ch)) idToChar[j.vocab[ch]] = ch;
        if (meta.blank === undefined || meta.blank === null) meta.blank = j.vocab["<pad>"] || 0;
        if (meta.separator === undefined || meta.separator === null) meta.separator = j.vocab["|"];
        if (!meta.msPerFrame) meta.msPerFrame = 20;
        return cachedParts();
      })
      /* the parts are joined back into the single buffer the runtime wants;
         they only ever existed to get past a host's per-file limit */
      .then(function (rs) {
        if (!rs) throw new Error("the model is not fully downloaded");
        return Promise.all(rs.map(function (r) { return r.arrayBuffer(); }));
      })
      .then(function (bufs) {
        if (bufs.length === 1) return bufs[0];
        var total = 0, i;
        for (i = 0; i < bufs.length; i++) total += bufs[i].byteLength;
        var out = new Uint8Array(total), at = 0;
        for (i = 0; i < bufs.length; i++) { out.set(new Uint8Array(bufs[i]), at); at += bufs[i].byteLength; }
        return out.buffer;
      })
      .then(function (bytes) {
        return new Promise(function (resolve, reject) {
          worker = new Worker("ctc-worker.js");
          worker.onmessage = function (ev) {
            var m = ev.data;
            if (m.t === "ready") { ready = true; state = "idle"; resolve(true); return; }
            if (m.t === "error" && !ready) { reject(new Error(m.msg)); return; }
            onWorkerMessage(m);
          };
          worker.onerror = function (e) { reject(new Error(e.message || "worker failed to start")); };
          worker.postMessage({
            t: "init", model: bytes, meta: { blank: meta.blank },
            ortUrl: new URL(ORT_URL, location.href).href,
            alignUrl: new URL("ctc-align.js", location.href).href,
            wasmBase: WASM_BASE
          }, [bytes]);
        });
      })
      .catch(function (e) {
        state = "error"; lastErr = String(e.message || e);
        if (worker) { worker.terminate(); worker = null; }
        throw e;
      });
  }

  /* ---------- audio in ---------- */

  /* Most devices hand back 44.1 or 48 kHz whatever is asked for. Dropping
     samples to get to 16 kHz folds everything above 8 kHz back down into
     the speech band as noise the model has never heard, so the downsample
     is a proper bandlimited one: a windowed sinc, cut at the new Nyquist. */
  function makeResampler(inRate) {
    if (inRate === SR) return function (x) { return x; };
    var ratio = inRate / SR, taps = 24, tail = new Float32Array(0);
    function sinc(x) { return x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x); }
    return function (chunk) {
      var x = new Float32Array(tail.length + chunk.length);
      x.set(tail, 0); x.set(chunk, tail.length);
      var usable = x.length - taps;                    /* keep a margin for the kernel */
      if (usable <= 0) { tail = x; return new Float32Array(0); }
      var n = Math.floor(usable / ratio);
      var out = new Float32Array(n), i, k;
      for (i = 0; i < n; i++) {
        var p = i * ratio, c = Math.round(p), acc = 0, wsum = 0;
        for (k = -taps; k <= taps; k++) {
          var j = c + k; if (j < 0 || j >= x.length) continue;
          var d = (j - p) / ratio;
          if (Math.abs(d) > taps) continue;
          var w = 0.54 + 0.46 * Math.cos(Math.PI * d / taps);   /* Hamming */
          var h = sinc(d) * w;
          acc += x[j] * h; wsum += h;
        }
        out[i] = wsum ? acc / wsum : 0;
      }
      var consumed = Math.floor(n * ratio);
      tail = x.subarray(consumed);
      tail = new Float32Array(tail);                   /* detach from x */
      return out;
    };
  }

  function push(chunk) {
    if (!chunk.length) return;
    if (bufLen + chunk.length > buf.length) {
      var grow = new Float32Array(Math.max(buf.length * 2, bufLen + chunk.length + SR));
      grow.set(buf.subarray(0, bufLen), 0);
      buf = grow;
    }
    buf.set(chunk, bufLen);
    bufLen += chunk.length;
  }

  function trim(samples) {
    if (samples <= 0) return;
    samples = Math.min(samples, bufLen);
    buf.copyWithin(0, samples, bufLen);
    bufLen -= samples;
    anchor += samples;
  }

  var WORKLET_SRC =
    'class P extends AudioWorkletProcessor{process(i){if(i[0]&&i[0][0])' +
    'this.port.postMessage(new Float32Array(i[0][0]));return true}}' +
    'registerProcessor("sabaq-cap",P)';

  function openMic() {
    var Ctx = window.AudioContext || window.webkitAudioContext;
    return navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        /* the model was trained on plain recitation; the browser's cleanup
           chain is tuned for phone calls and chews the tails off vowels,
           which is precisely the signal madd length lives in */
        echoCancellation: false, noiseSuppression: false, autoGainControl: false
      }
    }).then(function (s) {
      stream = s;
      try { ac = new Ctx({ sampleRate: SR }); } catch (e) { ac = new Ctx(); }
      resample = makeResampler(ac.sampleRate);
      src = ac.createMediaStreamSource(s);
      return upgradeToWorklet().catch(function () { useScriptProcessor(); });
    }).then(function () {
      if (ac.state === "suspended") return ac.resume();
    });
  }

  function onSamples(f32) {
    var out = resample(f32);
    if (out.length) push(out);
    if (H.onLevel) {
      var peak = 0;
      for (var i = 0; i < f32.length; i += 8) { var v = f32[i] < 0 ? -f32[i] : f32[i]; if (v > peak) peak = v; }
      H.onLevel(peak);
    }
  }

  function upgradeToWorklet() {
    if (!ac.audioWorklet) return Promise.reject(new Error("no worklet"));
    var url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: "application/javascript" }));
    return ac.audioWorklet.addModule(url).then(function () {
      URL.revokeObjectURL(url);
      node = new AudioWorkletNode(ac, "sabaq-cap");
      node.port.onmessage = function (e) { onSamples(e.data); };
      src.connect(node);
      /* a worklet with no destination is still pulled; connecting to a
         zero gain node keeps every browser scheduling it */
      var mute = ac.createGain(); mute.gain.value = 0;
      node.connect(mute); mute.connect(ac.destination);
    });
  }

  function useScriptProcessor() {
    node = ac.createScriptProcessor(4096, 1, 1);
    node.onaudioprocess = function (e) { onSamples(new Float32Array(e.inputBuffer.getChannelData(0))); };
    src.connect(node);
    var mute = ac.createGain(); mute.gain.value = 0;
    node.connect(mute); mute.connect(ac.destination);
  }

  /* ---------- the streaming loop ---------- */

  function tick() {
    if (busy || !ready || bufLen < SR * 0.6) return;
    if (bufLen > MAX_WIN) {
      /* the window has grown past what is worth running: throw away
         everything up to the end of the last word already handed over,
         so the model never re-decodes committed audio */
      var keepFrom = commitEnd >= 0 ? (commitEnd + 1) * SAMPLES_PER_FRAME : bufLen - MAX_WIN;
      trim(Math.max(keepFrom, bufLen - MAX_WIN));
      emitted = 0; commitEnd = -1;
    }
    var pcm = new Float32Array(buf.subarray(0, bufLen));
    var target = null, plan = null;
    if (expectedFn) {
      plan = expectedFn();
      if (plan && plan.ids && plan.ids.length) target = Int32Array.from(plan.ids);
    }
    busy = true;
    var id = ++reqId;
    pending[id] = plan;
    worker.postMessage({ t: "infer", id: id, pcm: pcm, target: target }, [pcm.buffer]);
  }

  var pending = {};

  function onWorkerMessage(m) {
    if (m.t === "error") {
      busy = false;
      lastErr = m.msg;
      /* one failure can be a hiccup; three in a row is a broken model or a
         broken runtime, and retrying every 700 ms only buries the reason */
      if (++fails >= 3) { clearInterval(timer); timer = null; state = "error"; }
      if (H.onError) H.onError(m.msg + (fails >= 3 ? " — stopped" : ""));
      return;
    }
    fails = 0;
    if (m.t !== "result") return;
    busy = false;
    var plan = pending[m.id]; delete pending[m.id];

    handleGreedy(m.greedy, m.frames);
    if (m.forced && plan) handleForced(m.forced, plan, m.frames);
    if (H.onStats) H.onStats({ ms: m.ms, frames: m.frames });
  }

  /* Words are emitted once and never revised. The rule for "once" is
     distance from the live edge: a word whose last frame is still within
     TAIL_FRAMES of the end of the window may yet grow another letter, so
     it waits for the next window. Everything behind that is settled. */
  function handleGreedy(g, T) {
    var sep = meta.separator, words = [], cur = null, i;
    for (i = 0; i < g.ids.length; i++) {
      var id = g.ids[i];
      if (id === sep) { if (cur) { words.push(cur); cur = null; } continue; }
      if (!cur) cur = { text: "", start: g.starts[i], end: g.ends[i], score: 0, n: 0 };
      cur.text += (idToChar[id] || "");
      cur.end = g.ends[i];
      cur.score += g.scores[i]; cur.n++;
    }
    if (cur) words.push(cur);

    var out = [], stop = T - TAIL_FRAMES;
    for (i = emitted; i < words.length; i++) {
      if (words[i].end > stop) break;
      if (!words[i].text) continue;
      out.push(words[i]);
      emitted = i + 1;
      commitEnd = words[i].end;
    }
    if (out.length && H.onWords) {
      H.onWords(out.map(function (w) { return w.text; }), out.map(function (w) {
        return { text: w.text, startMs: (anchor / SR) * 1000 + w.start * meta.msPerFrame,
                 durMs: (w.end - w.start + 1) * meta.msPerFrame, score: w.n ? w.score / w.n : 0 };
      }));
    }
  }

  /* The forced alignment is scored against the text the app says should be
     here. Spans are regrouped into the caller's own words so it never has
     to think in letter indices. */
  function handleForced(f, plan, T) {
    if (!H.onDetail || !plan.words) return;
    var A = window.CTCAlign;
    var spans = f.spans;
    /* a trained CTC model fires one frame per symbol, so length comes from
       the spacing between spikes, not from how wide a span is */
    var times = A.spanTimes(spans, T);
    var weak = {}, w = A.weakSymbols(spans, { margin: 1.8, silent: silentIds() });
    for (var i = 0; i < w.length; i++) weak[w[i].index] = w[i].reason;

    var details = [];
    for (i = 0; i < plan.words.length; i++) {
      var pw = plan.words[i], letters = [], bad = [], score = 0, n = 0, st = -1, en = -1;
      for (var k = pw.from; k <= pw.to && k < spans.length; k++) {
        var s = spans[k], tm = times[k];
        if (s.symbol === meta.separator) continue;
        letters.push({ ch: idToChar[s.symbol] || "", ms: tm.dur * meta.msPerFrame,
                       score: s.score, weak: weak[k] || null });
        if (weak[k]) bad.push(letters.length - 1);
        if (tm.onset >= 0) {
          score += s.score; n++;
          if (st < 0) st = tm.onset;
          en = tm.onset + tm.dur;
        }
      }
      if (!letters.length) continue;
      details.push({
        word: pw.index, letters: letters, weak: bad,
        score: n ? score / n : -Infinity,
        startMs: st < 0 ? null : (anchor / SR) * 1000 + st * meta.msPerFrame,
        durMs: st < 0 ? 0 : (en - st) * meta.msPerFrame
      });
    }
    H.onDetail(details, f.perFrame);
  }

  /* Letters that are written but silent by rule. Alef wasla is the one that
     matters: after a vowel it is elided, so the alignment will always place
     it on a frame that does not support it. That is the rule working, not a
     mistake, and it must never be marked as one. */
  var SILENT_CHARS = ["\u0671", "\u06E5", "\u06E6"];
  function silentIds() {
    if (!meta || !meta.vocab) return [];
    var out = [];
    for (var i = 0; i < SILENT_CHARS.length; i++) {
      var id = meta.vocab[SILENT_CHARS[i]];
      if (id !== undefined) out.push(id);
    }
    return out;
  }

  /* ---------- public surface ---------- */

  function start(handlers) {
    H = handlers || {};
    if (!supported()) return Promise.reject(new Error("this browser cannot run the local engine"));
    return load(H.onProgress).then(function () {
      buf = new Float32Array(SR * 12); bufLen = 0; anchor = 0;
      emitted = 0; commitEnd = -1; busy = false; fails = 0; pending = {};
      return openMic();
    }).then(function () {
      state = "listening";
      clearInterval(timer);
      timer = setInterval(tick, HOP_MS);
      return true;
    }).catch(function (e) {
      stop();
      state = "error"; lastErr = String(e.message || e);
      throw e;
    });
  }

  function stop() {
    clearInterval(timer); timer = null;
    if (node) { try { node.disconnect(); } catch (e) {} node = null; }
    if (src) { try { src.disconnect(); } catch (e) {} src = null; }
    if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
    if (ac) { try { ac.close(); } catch (e) {} ac = null; }
    bufLen = 0; anchor = 0; busy = false; pending = {};
    if (state === "listening") state = "idle";
  }

  /* app.js hands over a function that answers "what should be coming next":
     { ids: [symbol ids], words: [{ index, from, to }] } where from/to index
     into ids. Returning null turns the alignment half off. */
  function setExpected(fn) { expectedFn = fn; }

  /* the vocabulary, so callers can turn their own text into symbol ids */
  function encode(text) {
    if (!meta) return null;
    var ids = [], i;
    for (i = 0; i < text.length; i++) {
      var id = meta.vocab[text.charAt(i)];
      if (id !== undefined) ids.push(id);
      else if (text.charAt(i) === " " && ids.length && ids[ids.length - 1] !== meta.separator) ids.push(meta.separator);
    }
    while (ids.length && ids[ids.length - 1] === meta.separator) ids.pop();
    return ids;
  }

  return {
    supported: supported,
    loaded: function () { return ready; },
    state: function () { return state; },
    error: function () { return lastErr; },
    meta: function () { return meta; },
    modelPresent: modelPresent,
    modelBytes: modelBytes,
    download: download,
    clearModel: clearModel,
    load: load,
    start: start,
    stop: stop,
    setExpected: setExpected,
    encode: encode
  };
})();
