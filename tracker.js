/* ------------------------------------------------------------------
   Sabaq Mushaf — recitation alignment and mistake detection.

   This module is deliberately independent of how the speech was
   recognised. Feed it normalised Arabic words as they arrive and it
   tells you where in the mushaf the reciter is and what went wrong.
   Swap the browser's speech recognition for a Whisper or CTC endpoint
   later and nothing in here changes.

   The approach follows the published Tarteel work: align the recognised
   TEXT against the canonical text with edit distance, rather than trying
   to align audio acoustically. Text alignment is cheap, tolerant of
   recogniser errors, and debuggable.

   Two ideas do most of the work:

   1. Alignment, not lookahead matching. A greedy "is this the next word"
      scan cannot tell a skipped word from a misheard one. A proper
      Needleman-Wunsch alignment over a window of expected words against
      a window of heard words yields the whole picture at once —
      matches, substitutions, omissions and insertions fall out of the
      traceback.

   2. Confidence gating. A speech recogniser makes mistakes that look
      exactly like recitation mistakes. So a mistake is only reported
      when the words AROUND it aligned well: local agreement is the
      evidence that the disagreement in the middle is real. Told a
      hundred times that you erred when you did not, you would stop
      trusting it — silence is the better failure.
   ------------------------------------------------------------------ */

window.SabaqTracker = (function () {
  "use strict";

  /* ---------- text normalisation ---------- */

  var MARKS = /[ؐ-ًؚ-ٰٟۖ-ۭ࣓-ࣿـ​-‏]/g;

  function normalise(w) {
    return String(w)
      .replace(MARKS, "")
      .replace(/[آأإٱٲٳ]/g, "ا")  /* alif forms */
      .replace(/[ىی]/g, "ي")                          /* alif maqsura -> ya */
      .replace(/ة/g, "ه")                                  /* ta marbuta -> ha */
      .replace(/ؤ/g, "و")
      .replace(/ئ/g, "ي")
      .replace(/[^ء-ي]/g, "");
  }

  /* ---------- edit distance, and the letter-level script ---------- */

  function lev(a, b) {
    if (a === b) return 0;
    var m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    var prev = [], i, j;
    for (j = 0; j <= n; j++) prev[j] = j;
    for (i = 1; i <= m; i++) {
      var cur = [i];
      for (j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1,
                          prev[j - 1] + (a.charAt(i - 1) === b.charAt(j - 1) ? 0 : 1));
      }
      prev = cur;
    }
    return prev[n];
  }

  /* similarity in [0,1] */
  function sim(a, b) {
    if (!a && !b) return 1;
    if (!a || !b) return 0;
    var L = Math.max(a.length, b.length);
    return 1 - lev(a, b) / L;
  }

  /* Which letters of `expected` differ from `heard`. Returns an array of
     indices into expected, so the UI can underline exactly the letters
     that went wrong rather than the whole word. */
  function letterDiff(expected, heard) {
    var m = expected.length, n = heard.length;
    var d = [], i, j;
    for (i = 0; i <= m; i++) { d[i] = [i]; }
    for (j = 0; j <= n; j++) { d[0][j] = j; }
    for (i = 1; i <= m; i++) {
      for (j = 1; j <= n; j++) {
        d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1,
                           d[i - 1][j - 1] + (expected.charAt(i - 1) === heard.charAt(j - 1) ? 0 : 1));
      }
    }
    var bad = [];
    i = m; j = n;
    while (i > 0 || j > 0) {
      if (i > 0 && j > 0 && expected.charAt(i - 1) === heard.charAt(j - 1) && d[i][j] === d[i - 1][j - 1]) {
        i--; j--;
      } else if (i > 0 && j > 0 && d[i][j] === d[i - 1][j - 1] + 1) {
        bad.push(i - 1); i--; j--;                 /* substituted letter */
      } else if (i > 0 && d[i][j] === d[i - 1][j] + 1) {
        bad.push(i - 1); i--;                      /* letter dropped */
      } else {
        j--;                                       /* letter added */
      }
    }
    return bad.reverse();
  }

  /* ---------- Needleman-Wunsch over words ---------- */

  var MATCH_MIN = 0.86;   /* at or above this, the word is considered said */
  var NEAR_MIN  = 0.45;   /* between the two, a substitution rather than noise */
  var GAP       = -0.55;  /* cost of skipping a word on either side */

  /* Aligns heard[] against expect[] and returns the traceback as a list
     of {e, h} index pairs, where -1 means "nothing on that side".

     The alignment is semi-global: every heard word must be placed, but the
     expected side may run past the end for free. That asymmetry matters.
     Text after the last word spoken has not been skipped, it simply has
     not been reached — whereas text jumped over on the way still costs,
     which is what lets a skipped ayah be seen as a skip. A fully global
     alignment scores "matched here" and "matched the identical word forty
     words later" the same, and picks between them arbitrarily. */
  function align(expect, heard) {
    var m = expect.length, n = heard.length;
    var S = [], P = [], i, j;
    for (i = 0; i <= m; i++) { S[i] = []; P[i] = []; S[i][0] = i * GAP; P[i][0] = "up"; }
    for (j = 0; j <= n; j++) { S[0][j] = j * GAP; P[0][j] = "left"; }
    P[0][0] = "done";
    for (i = 1; i <= m; i++) {
      for (j = 1; j <= n; j++) {
        var s = sim(expect[i - 1], heard[j - 1]);
        /* a near miss still beats a gap, so substitutions align rather
           than turning into an omission plus an insertion */
        var score = s >= NEAR_MIN ? (s * 2 - 0.7) : -0.9;
        var diag = S[i - 1][j - 1] + score;
        var up = S[i - 1][j] + GAP;
        var left = S[i][j - 1] + GAP;
        var best = Math.max(diag, up, left);
        S[i][j] = best;
        P[i][j] = best === diag ? "diag" : (best === up ? "up" : "left");
      }
    }
    /* end anywhere down the expected side: the best cell of the last column */
    var endI = 0, bestEnd = -Infinity;
    for (i = 0; i <= m; i++) {
      if (S[i][n] > bestEnd) { bestEnd = S[i][n]; endI = i; }
    }
    var path = [];
    i = endI; j = n;
    while (i > 0 || j > 0) {
      var p = P[i][j];
      if (p === "diag") { path.push({ e: i - 1, h: j - 1 }); i--; j--; }
      else if (p === "up") { path.push({ e: i - 1, h: -1 }); i--; }
      else { path.push({ e: -1, h: j - 1 }); j--; }
    }
    return path.reverse();
  }

  /* ---------- the tracker ---------- */

  function create(opts) {
    var seq = opts.words || [];        /* [{a: ayah, n: normalised}] */
    var ayahStart = opts.ayahStart || [];
    var ayahEnd = opts.ayahEnd || [];
    var onEvent = opts.onEvent || function () {};
    var index = opts.index || null;    /* optional n-gram index for drift */
    var surah = opts.surah || 0;

    var AHEAD = 22;    /* how far forward to consider */
    var BACK = 6;      /* how far back, for restarts */
    var HEARD_KEEP = 14;

    var st = {
      pos: 0,          /* next expected word */
      heard: [],       /* recent normalised heard words */
      consumed: 0,     /* how many of heard[] have been aligned already */
      lastAt: 0,       /* when we last matched anything */
      misses: 0,       /* consecutive unmatched heard words */
      events: []
    };

    var recent = {};
    function emit(ev) {
      ev.at = Date.now();
      /* the same finding repeated within a few seconds is one finding */
      if (ev.type !== "match") {
        var k = ev.type + ":" + (ev.word !== undefined ? ev.word : "") +
                ":" + (ev.ayah || "") + ":" + (ev.heard || "");
        if (recent[k] && ev.at - recent[k] < 6000) return;
        recent[k] = ev.at;
      }
      st.events.push(ev);
      onEvent(ev);
    }

    function reset(at) {
      st.pos = at || 0;
      st.heard = [];
      st.consumed = 0;
      st.misses = 0;
      st.lastAt = Date.now();
    }

    /* Local agreement around an index in the alignment path: the share of
       neighbouring pairs that matched cleanly. This is the evidence that
       a disagreement is a real recitation mistake rather than the
       recogniser mangling a word. */
    function confidenceAt(path, k) {
      var lo = Math.max(0, k - 3), hi = Math.min(path.length - 1, k + 3);
      var good = 0, total = 0;
      for (var i = lo; i <= hi; i++) {
        if (i === k) continue;
        var p = path[i];
        total++;
        if (p.e >= 0 && p.h >= 0) good++;
      }
      return total ? good / total : 0;
    }

    function feed(words) {
      if (!words || !words.length) return;
      var i;
      for (i = 0; i < words.length; i++) {
        var w = normalise(words[i]);
        if (w) st.heard.push(w);
      }
      if (st.heard.length > HEARD_KEEP) {
        var drop = st.heard.length - HEARD_KEEP;
        st.heard = st.heard.slice(drop);
        st.consumed = Math.max(0, st.consumed - drop);
      }
      run();
    }

    function run() {
      var fresh = st.heard.slice(st.consumed);
      if (!fresh.length) return;
      st.consumed = st.heard.length;

      /* Where is the reciter? Usually straight ahead, but going back to
         the top of the ayah is ordinary practice while memorising, so a
         few starting points are scored and the best one wins. The window
         never simply extends backwards: that would let a phrase re-match
         an identical earlier one at no cost, and the Qur'an is full of
         identical phrases. */
      var pick = bestWindow(fresh);
      if (!pick || pick.clean < 1) { noMatch(fresh); return; }

      var restarted = pick.from !== st.pos;
      if (restarted) {
        if (pick.clean < 2) { noMatch(fresh); return; }
        emit({ type: "restart", ayah: seq[pick.from].a, to: pick.from });
      }

      var startPos = pick.from;
      var from = pick.from;
      var expect = pick.expect;
      var path = pick.path;
      var i;

      /* Everything after the last heard word is simply text not reached
         yet, not text skipped. Cutting the tail here is what stops the
         whole remaining window being reported as an omission. */
      var lastH = -1;
      for (i = path.length - 1; i >= 0; i--) { if (path[i].h >= 0) { lastH = i; break; } }
      if (lastH < 0) { noMatch(fresh); return; }
      path = path.slice(0, lastH + 1);

      /* One confidence for the batch: how much of it lined up cleanly.
         A mistake is only credible when the recitation around it agreed
         with the text. */
      var clean = 0, pairs = 0;
      for (i = 0; i < path.length; i++) {
        var q = path[i];
        if (q.e >= 0 && q.h >= 0) {
          pairs++;
          if (sim(expect[q.e], fresh[q.h]) >= MATCH_MIN) clean++;
        }
      }
      /* Confidence is agreement across the words that DID line up. Gaps
         are excluded on purpose: an omission is the finding, so counting
         it against the evidence would make skips undetectable. */
      var conf = pairs ? clean / pairs : 0;
      var trust = clean >= 2 && conf >= 0.6;

      var pending = [];      /* expected words passed over, awaiting a later match */
      var lastE = -1;        /* last expected index actually recited */
      var anyMatch = false;

      for (i = 0; i < path.length; i++) {
        var p = path[i];

        if (p.e >= 0 && p.h >= 0) {
          var eIdx = from + p.e;
          var s2 = sim(expect[p.e], fresh[p.h]);

          if (s2 >= MATCH_MIN) {
            if (pending.length && trust && !restarted) flushOmissions(pending, conf);
            pending = [];
            emit({ type: "match", word: eIdx, ayah: seq[eIdx].a });
            lastE = eIdx; anyMatch = true;
            st.misses = 0; st.lastAt = Date.now();

          } else if (s2 >= NEAR_MIN) {
            if (pending.length && trust && !restarted) flushOmissions(pending, conf);
            pending = [];
            if (trust && !restarted) {
              emit({
                type: "substitution",
                word: eIdx, ayah: seq[eIdx].a,
                expected: expect[p.e], heard: fresh[p.h],
                letters: letterDiff(expect[p.e], fresh[p.h]),
                similarity: s2, confidence: conf
              });
            }
            lastE = eIdx; anyMatch = true;
            st.lastAt = Date.now();

          } else {
            /* aligned but nothing alike — treat the text side as passed
               over and the speech side as noise */
            if (from + p.e >= startPos) pending.push(from + p.e);
          }

        } else if (p.e >= 0) {
          /* Words before where we already were are not skipped: the
             reciter said them a moment ago. */
          if (from + p.e >= startPos) pending.push(from + p.e);

        } else if (p.h >= 0) {
          var hw = fresh[p.h];
          var nextE = nextExpected(path, i);
          if (lastE >= 0 && sim(seq[lastE].n, hw) >= MATCH_MIN) {
            emit({ type: "repeat", word: lastE, ayah: seq[lastE].a, heard: hw });
          } else if (nextE >= 0 && sim(expect[nextE], hw) >= MATCH_MIN) {
            emit({ type: "repeat", word: from + nextE, ayah: seq[from + nextE].a, heard: hw });
          } else if (trust && !restarted && hw.length > 2) {
            emit({ type: "insertion", after: lastE, heard: hw,
                   ayah: lastE >= 0 ? seq[lastE].a : (seq[startPos] && seq[startPos].a) });
          }
        }
      }

      if (anyMatch) {
        st.pos = lastE + 1;
        st.misses = 0;
      } else {
        noMatch(fresh);
      }
    }

    /* Score the plausible starting points and return the best alignment. */
    function bestWindow(fresh) {
      var here = Math.min(st.pos, seq.length - 1);
      var a = seq[here] ? seq[here].a : 1;
      var cands = [st.pos];
      if (ayahStart[a] !== undefined && ayahStart[a] < st.pos) cands.push(ayahStart[a]);
      if (a > 1 && ayahStart[a - 1] !== undefined && ayahStart[a - 1] < st.pos) cands.push(ayahStart[a - 1]);

      var best = null;
      for (var c = 0; c < cands.length; c++) {
        var f = cands[c];
        if (f < 0 || f >= seq.length) continue;
        var to = Math.min(seq.length, f + AHEAD);
        var exp = [];
        for (var i = f; i < to; i++) exp.push(seq[i].n);
        var pth = align(exp, fresh);
        var clean = 0;
        for (var k = 0; k < pth.length; k++) {
          var q = pth[k];
          if (q.e >= 0 && q.h >= 0 && sim(exp[q.e], fresh[q.h]) >= MATCH_MIN) clean++;
        }
        /* carrying on is the assumption; a restart must beat it clearly */
        var score = clean - (f === st.pos ? 0 : 1.5);
        if (!best || score > best.score) best = { from: f, expect: exp, path: pth, clean: clean, score: score };
      }
      return best;
    }

    function nextExpected(path, i) {
      for (var k = i + 1; k < path.length; k++) if (path[k].e >= 0) return path[k].e;
      return -1;
    }

    /* Drifting into a similar passage elsewhere — the mutashabihat trap.
       Reported only when a run of heard words matches some other place in
       the mushaf, well away from where the reciter should be. */
    function drift(fresh) {
      if (!index || !index.lookup || fresh.length < 4) return null;
      var key = fresh.slice(-4).map(idxKey).join(" ");
      var hits = index.lookup(key);
      if (!hits || !hits.length) return null;
      for (var i = 0; i < hits.length; i++) {
        var h = hits[i];
        if (h.surah !== surah || Math.abs(h.word - st.pos) > 40) {
          return { type: "drift", to: h, ayah: seq[Math.min(st.pos, seq.length - 1)].a,
                   heard: fresh.slice(-4).join(" ") };
        }
      }
      return null;
    }

    function noMatch(fresh) {
      st.misses += fresh.length;
      if (st.misses >= 4) {
        var d = drift(fresh);
        if (d) { emit(d); st.misses = 0; return; }
      }
      if (st.misses >= 8) { emit({ type: "lost", heard: fresh.join(" ") }); st.misses = 0; }
    }

    /* A run of expected words the reciter passed over. Whole ayat are
       named as such; a few words inside an ayah are an omission. */
    function flushOmissions(list, conf) {
      if (!list.length) return;
      var first = list[0], last = list[list.length - 1];
      var aFirst = seq[first].a, aLast = seq[last].a;
      var whole = [];
      for (var a = aFirst; a <= aLast; a++) {
        if (ayahStart[a] >= first && ayahEnd[a] <= last) whole.push(a);
      }
      if (whole.length) {
        emit({ type: "skipped_ayah", ayat: whole, from: first, to: last,
               ayah: whole[0], confidence: conf });
        var rest = list.filter(function (x) { return whole.indexOf(seq[x].a) < 0; });
        if (rest.length >= 2) {
          emit({ type: "omission", words: rest, ayah: seq[rest[0]].a, confidence: conf,
                 expected: rest.map(function (x) { return seq[x].n; }).join(" ") });
        }
      } else {
        emit({ type: "omission", words: list.slice(), ayah: aFirst, confidence: conf,
               expected: list.map(function (x) { return seq[x].n; }).join(" ") });
      }
    }

    function idle() {
      /* called on a timer: a long silence mid-ayah is a hesitation */
      if (!st.lastAt) return;
      var gap = Date.now() - st.lastAt;
      if (gap > 3500 && st.pos > 0 && st.pos < seq.length) {
        st.lastAt = Date.now();
        emit({ type: "hesitation", word: st.pos, ayah: seq[st.pos].a, ms: gap });
      }
    }

    return {
      reset: reset,
      feed: feed,
      idle: idle,
      state: st,
      get position() { return st.pos; },
      set position(v) { st.pos = v; st.heard = []; st.consumed = 0; st.misses = 0; }
    };
  }

  /* ---------- an n-gram index, for spotting drift ---------- */

  /* Index keys ignore hamza seats entirely: recognisers spell them
     inconsistently and they never distinguish one passage from another. */
  function idxKey(n) { return n.replace(/ء/g, ""); }

  function buildIndex(byS, normFn) {
    var map = Object.create(null);
    var flat = [];
    for (var s = 1; s <= 114; s++) {
      var arr = byS[String(s)];
      if (!arr) continue;
      for (var i = 0; i < arr.length; i++) {
        var ws = arr[i].split(/\s+/);
        for (var j = 0; j < ws.length; j++) {
          var n = (normFn || normalise)(ws[j]);
          if (n) flat.push({ s: s, a: i + 1, n: n });
        }
      }
    }
    for (var k = 0; k + 3 < flat.length; k++) {
      if (flat[k].s !== flat[k + 3].s) continue;
      var key = idxKey(flat[k].n) + " " + idxKey(flat[k + 1].n) + " " + idxKey(flat[k + 2].n) + " " + idxKey(flat[k + 3].n);
      (map[key] || (map[key] = [])).push(k);
    }
    return {
      size: flat.length,
      lookup: function (key) {
        var hits = map[key];
        if (!hits) return null;
        return hits.map(function (k) { return { surah: flat[k].s, ayah: flat[k].a, word: k }; });
      }
    };
  }

  return {
    create: create,
    normalise: normalise,
    sim: sim,
    lev: lev,
    letterDiff: letterDiff,
    idxKey: idxKey,
    align: align,
    buildIndex: buildIndex
  };
})();
