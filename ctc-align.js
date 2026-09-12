/* ------------------------------------------------------------------
   CTC forced alignment, for the browser.

   The app always knows what SHOULD be recited. That changes the problem
   entirely. Open-vocabulary transcription — guess the words from nothing —
   is the hard version, and it is the version a general recogniser solves
   badly for Qur'anic Arabic. Here the text is given, so the question is
   only: does this audio match this letter sequence, where does each letter
   fall, and how well?

   That is forced alignment, and it buys three things transcription cannot:

     * exact start and end times per letter, so madd length is measurable
       in milliseconds and tajweed becomes checkable at all
     * a per-letter confidence, so a mistake is a letter the audio does not
       support rather than a word some decoder happened to emit
     * a much smaller model, because the search is constrained

   Input is the frame-by-frame log-probability matrix from a CTC acoustic
   model (wav2vec2 or Conformer-CTC exported to ONNX). Nothing here depends
   on which model produced it.
   ------------------------------------------------------------------ */

var CTCAlignRoot = (typeof window !== "undefined") ? window
                 : (typeof self !== "undefined") ? self : this;

CTCAlignRoot.CTCAlign = (function () {
  "use strict";

  var NEG = -1e30;

  /* ---------- greedy decode, for "did they say something else entirely" ---------- */

  function greedy(logits, T, V, blank) {
    blank = blank || 0;
    var out = [], prev = -1, t, v;
    for (t = 0; t < T; t++) {
      var best = 0, bestv = logits[t * V];
      for (v = 1; v < V; v++) {
        var x = logits[t * V + v];
        if (x > bestv) { bestv = x; best = v; }
      }
      if (best !== prev && best !== blank) out.push(best);
      prev = best;
    }
    return out;
  }

  /* Greedy decode that also reports WHERE each emitted symbol fell. The
     plain decode above throws the timing away, which is fine for "what was
     said" but useless for streaming: to know which words are safely behind
     the live edge of the audio, the frame each word ended on is exactly the
     thing needed. A run of the same id collapses to one symbol, spanning the
     whole run. */

  function greedyTimed(logits, T, V, blank) {
    blank = blank || 0;
    var ids = [], starts = [], ends = [], scores = [];
    var prev = -1, t, v, run = 0, acc = 0;
    for (t = 0; t < T; t++) {
      var best = 0, bestv = logits[t * V];
      for (v = 1; v < V; v++) {
        var x = logits[t * V + v];
        if (x > bestv) { bestv = x; best = v; }
      }
      if (best === prev && best !== blank && ids.length) {
        ends[ids.length - 1] = t; run++; acc += bestv;
        scores[ids.length - 1] = acc / run;
      } else if (best !== prev && best !== blank) {
        ids.push(best); starts.push(t); ends.push(t);
        run = 1; acc = bestv; scores.push(bestv);
      }
      prev = best;
    }
    return { ids: ids, starts: starts, ends: ends, scores: scores };
  }

  /* ---------- forced alignment ----------

     The standard CTC trick: the target is expanded with a blank between
     every symbol and at both ends, giving 2L+1 states. Viterbi then runs
     over that lattice in log space. A state may stay, step forward one,
     or — only when moving between two DIFFERENT non-blank symbols — skip
     the blank between them. Backtracking gives the frame span of every
     target symbol.
  */

  function forced(logits, T, V, target, blank) {
    blank = (blank === undefined) ? 0 : blank;
    var L = target.length;
    if (!L || !T) return null;

    /* expanded state sequence: blank, s0, blank, s1, ... blank */
    var S = 2 * L + 1;
    var ext = new Int32Array(S);
    for (var i = 0; i < L; i++) { ext[2 * i] = blank; ext[2 * i + 1] = target[i]; }
    ext[S - 1] = blank;

    var dp = new Float64Array(S).fill(NEG);
    var back = new Uint8Array(T * S);       /* 0 stay, 1 step, 2 skip */

    dp[0] = logits[0 * V + ext[0]];
    if (S > 1) dp[1] = logits[0 * V + ext[1]];

    var cur = new Float64Array(S);
    for (var t = 1; t < T; t++) {
      cur.fill(NEG);
      for (var s = 0; s < S; s++) {
        var bestScore = dp[s], bestFrom = 0;
        if (s > 0 && dp[s - 1] > bestScore) { bestScore = dp[s - 1]; bestFrom = 1; }
        /* the skip is legal only across a blank, between two different symbols */
        if (s > 1 && ext[s] !== blank && ext[s] !== ext[s - 2] && dp[s - 2] > bestScore) {
          bestScore = dp[s - 2]; bestFrom = 2;
        }
        if (bestScore <= NEG) continue;
        cur[s] = bestScore + logits[t * V + ext[s]];
        back[t * S + s] = bestFrom;
      }
      var tmp = dp; dp = cur; cur = tmp;
    }

    /* the path must finish on the last symbol or the trailing blank */
    var endS = (S > 1 && dp[S - 2] > dp[S - 1]) ? S - 2 : S - 1;
    if (dp[endS] <= NEG) return null;
    var total = dp[endS];

    /* walk back, recording which frames belonged to which state */
    var path = new Int32Array(T);
    var s2 = endS;
    for (var t2 = T - 1; t2 >= 0; t2--) {
      path[t2] = s2;
      if (t2 === 0) break;
      s2 -= back[t2 * S + s2];
    }

    /* collapse states into target symbols */
    var spans = [];
    for (i = 0; i < L; i++) spans.push({ index: i, symbol: target[i], start: -1, end: -1, frames: 0, score: 0 });
    for (t = 0; t < T; t++) {
      var st = path[t];
      if (st % 2 === 1) {                       /* an actual symbol, not a blank */
        var k = (st - 1) / 2;
        var sp = spans[k];
        if (sp.start < 0) sp.start = t;
        sp.end = t;
        sp.frames++;
        sp.score += logits[t * V + target[k]];
      }
    }
    for (i = 0; i < L; i++) {
      var q = spans[i];
      q.score = q.frames ? q.score / q.frames : NEG;   /* mean log-prob per frame */
    }
    return { spans: spans, total: total, perFrame: total / T, path: path };
  }

  /* ---------- from symbol spans to something the app can use ----------

     A trained CTC model is PEAKY. It spends almost every frame on the blank
     and fires a single spike where each symbol lands, so the number of frames
     a symbol "occupies" is very nearly always one, whatever its real length.
     Reading duration off the span is therefore reading noise.

     What the spikes do carry, exactly, is onset. So duration here is the
     interval from one symbol's spike to the next one's — the same quantity a
     phonetician would measure, and the reason a held madd and a clipped one
     come out different. The last symbol runs to the end of the audio. */

  function spanTimes(spans, T) {
    var out = [], i, k;
    if (T === undefined) {
      T = 0;
      for (i = 0; i < spans.length; i++) if (spans[i].end + 1 > T) T = spans[i].end + 1;
    }
    for (i = 0; i < spans.length; i++) {
      out.push({ index: i, symbol: spans[i].symbol, onset: spans[i].start,
                 spike: spans[i].frames, dur: 0, score: spans[i].score });
    }
    for (i = 0; i < out.length; i++) {
      if (out[i].onset < 0) continue;
      var next = T;
      for (k = i + 1; k < out.length; k++) if (out[k].onset >= 0) { next = out[k].onset; break; }
      out[i].dur = Math.max(out[i].spike, next - out[i].onset);
    }
    return out;
  }



  /* Groups symbol spans into words, using the separator id, and converts
     frame indices to milliseconds. `msPerFrame` for wav2vec2 at 16 kHz is
     20 ms; pass whatever the model's stride actually is. */
  function words(spans, sepId, msPerFrame, T) {
    var times = spanTimes(spans, T);
    var out = [], cur = null, i;
    for (i = 0; i < spans.length; i++) {
      var s = spans[i], tm = times[i];
      if (s.symbol === sepId) { if (cur) { out.push(cur); cur = null; } continue; }
      if (!cur) cur = { symbols: [], start: s.start, end: s.start, score: 0, frames: 0 };
      cur.symbols.push(s);
      if (tm.onset >= 0) {
        if (cur.start < 0 || tm.onset < cur.start) cur.start = tm.onset;
        cur.end = Math.max(cur.end, tm.onset + tm.dur);
      }
      cur.frames += s.frames;
      cur.score += s.score * s.frames;
    }
    if (cur) out.push(cur);
    for (i = 0; i < out.length; i++) {
      var w = out[i];
      w.score = w.frames ? w.score / w.frames : NEG;
      w.startMs = w.start * msPerFrame;
      w.endMs = w.end * msPerFrame;
      w.durMs = w.endMs - w.startMs;
    }
    return out;
  }

  /* A letter the audio does not support: either it was given almost no
     time, or the model's confidence in it is far below the rest of the
     recitation. Judging each letter against the median of the others
     keeps a quiet or distant microphone from flagging everything. */
  function weakSymbols(spans, opts) {
    opts = opts || {};
    var minFrames = opts.minFrames || 1;
    var margin = opts.margin === undefined ? 1.6 : margin_(opts.margin);
    /* Some letters are written and not voiced — alef wasla after a vowel is
       the common one. Forced alignment must place every target symbol
       somewhere, so a silent letter always lands on a frame that does not
       support it. Flagging that would be reporting the reciter for obeying
       the rule. */
    var silent = {};
    if (opts.silent) for (var q = 0; q < opts.silent.length; q++) silent[opts.silent[q]] = 1;
    var scores = [];
    for (var i = 0; i < spans.length; i++) if (spans[i].frames) scores.push(spans[i].score);
    if (!scores.length) return [];
    scores.sort(function (a, b) { return a - b; });
    var med = scores[Math.floor(scores.length / 2)];
    var weak = [];
    for (i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (silent[s.symbol]) continue;
      if (s.frames < minFrames) { weak.push({ index: i, reason: "absent", score: s.score }); continue; }
      if (s.score < med - margin) weak.push({ index: i, reason: "unclear", score: s.score });
    }
    return weak;
  }
  function margin_(m) { return m; }

  /* Madd is a length ruling, so it is a duration question and nothing else.
     Given the frames a lengthening symbol occupied and the tempo of the
     surrounding recitation, this reports how many counts it was held for.
     It measures; it does not rule. */
  function maddCounts(spans, lengthIds, msPerFrame, T) {
    var times = spanTimes(spans, T);
    var base = [], i;
    for (i = 0; i < times.length; i++) {
      if (times[i].dur && lengthIds.indexOf(times[i].symbol) < 0) base.push(times[i].dur);
    }
    if (!base.length) return [];
    base.sort(function (a, b) { return a - b; });
    var unit = base[Math.floor(base.length / 2)];      /* one count ~ a median symbol */
    var out = [];
    for (i = 0; i < times.length; i++) {
      if (lengthIds.indexOf(times[i].symbol) >= 0 && times[i].dur) {
        out.push({
          index: i,
          symbol: times[i].symbol,
          ms: times[i].dur * msPerFrame,
          counts: times[i].dur / unit
        });
      }
    }
    return out;
  }

  return {
    greedy: greedy,
    greedyTimed: greedyTimed,
    spanTimes: spanTimes,
    forced: forced,
    words: words,
    weakSymbols: weakSymbols,
    maddCounts: maddCounts
  };
})();
