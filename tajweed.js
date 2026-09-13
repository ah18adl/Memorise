/* ------------------------------------------------------------------
   Tajwīd colouring, derived from the text rather than from a tag file.

   The Uthmani script already records almost everything the rules need.
   Sukūn is written (37,147 of them), shadda is written (22,679), the
   madd sign marks every lengthening beyond the natural two counts
   (5,652), and iqlāb carries its own small mīm. So the rules are not
   guessed from spelling — they are read off marks the scribes put there
   for exactly this purpose.

   What is decided here, and how:

     ghunnah        ن or م carrying shadda
     qalqalah       ق ط ب ج د carrying sukūn
     nūn sākinah    ن with sukūn, or any letter carrying tanwīn, judged
     and tanwīn     by the next letter across the word boundary:
                      izhār    ء ه ع ح غ خ
                      idghām   ي ن م و (with ghunnah) · ل ر (without)
                      iqlāb    ب
                      ikhfāʾ   the remaining fifteen
     mīm sākinah    followed by ب → ikhfāʾ shafawī; by م → idghām shafawī
     madd           a madd letter carrying the madd sign, graded by what
                    follows it: shadda → lāzim (6), hamza in the same
                    word → wājib (4–5), hamza opening the next → jāʾiz
                    (4–5). A bare madd letter is the natural two counts.
     lām shamsiyyah ال before a sun letter carrying shadda — written,
                    not spoken

   What is deliberately NOT decided here: anything that depends on where
   the reciter chooses to stop. Qalqalah and madd ʿārid at a pause change
   with the waqf, and guessing the reader's intention would put colour on
   the page that is wrong as often as it is right.
   ------------------------------------------------------------------ */

window.SabaqTajweed = (function () {
  "use strict";

  var SHADDA = "ّ";
  var SUKUN = "ْ", SUKUN_U = "ۡ";          /* both spellings */
  var MADDAH = "ٓ";
  var IQLAB_MARK = "ۢ";      /* small high mīm — the scribe's iqlāb sign */
  var IQLAB_LOW = "ۭ";       /* the same sign written below */
  var SUP_ALEF = "ٰ";
  var TANWEEN = "ًࣰٌࣱٍࣲ";
  var HAMZA = "ءآأؤإئ";
  var FATHA = "َ", DAMMA = "ُ", KASRA = "ِ";

  var LETTERS = "ءآأؤإئابةتثج" +
                "حخدذرزسشصضطظ" +
                "عغفقكلمنهوىيٱ";

  var IZHAR = "ءآأؤإئهعحغخ";
  var IDGHAM_GH = "ينمو";
  var IDGHAM_NO = "لر";
  var IQLAB = "ب";
  var QALQALAH = "قطبجد";
  var SUN = "تثدذرزسشصضطظلن";

  var RULES = [
    { id: "ghunnah",  label: "Ghunnah",            hint: "nasal, two counts" },
    { id: "idgham",   label: "Idghām",             hint: "merged into the next letter" },
    { id: "ikhfa",    label: "Ikhfāʾ",             hint: "hidden, with nasalisation" },
    { id: "iqlab",    label: "Iqlāb",              hint: "nūn becomes mīm" },
    { id: "qalqalah", label: "Qalqalah",           hint: "echoed" },
    { id: "madd6",    label: "Madd lāzim",         hint: "six counts" },
    { id: "madd4",    label: "Madd wājib / jāʾiz", hint: "four to five counts" },
    { id: "madd2",    label: "Madd ṭabīʿī",        hint: "two counts" },
    { id: "silent",   label: "Not pronounced",     hint: "written, not spoken" }
  ];

  function isLetter(c) { return LETTERS.indexOf(c) >= 0; }
  function has(marks, set) {
    for (var i = 0; i < marks.length; i++) if (set.indexOf(marks[i]) >= 0) return true;
    return false;
  }

  /* Split a word into letter units: a letter plus every mark riding on it,
     with the slice of the original string it came from, so the rules can
     work on letters while the output stays the exact original text. */
  function units(word) {
    var out = [], i = 0;
    while (i < word.length) {
      var c = word.charAt(i);
      if (!isLetter(c)) {                       /* a stray mark with no letter */
        if (out.length) { out[out.length - 1].marks += c; out[out.length - 1].end = i + 1; }
        i++; continue;
      }
      var u = { ch: c, marks: "", start: i, end: i + 1 };
      i++;
      while (i < word.length && !isLetter(word.charAt(i))) { u.marks += word.charAt(i); u.end = ++i - 0; }
      out.push(u);
    }
    return out;
  }

  function isSukun(u) { return has(u.marks, SUKUN + SUKUN_U); }
  /* An Arabic letter is either vowelled or sākin, and the Uthmani script
     frequently leaves the sukūn off — most of all on a word-final nūn that
     is about to assimilate, where the shadda is written on the NEXT word
     instead. Requiring an explicit sukūn therefore misses most of the nūn
     sākinah rulings in the mushaf. Absence of a vowel is the real test. */
  function isSilentStop(u) { return !isVowelled(u) && !isShadda(u); }
  function isShadda(u) { return u.marks.indexOf(SHADDA) >= 0; }
  function isTanween(u) { return has(u.marks, TANWEEN); }
  function isVowelled(u) { return has(u.marks, FATHA + DAMMA + KASRA) || isTanween(u); }

  /* A madd letter is only a madd when it carries no vowel of its own and
     follows the matching short vowel. Superscript alef is always one. */
  function maddKind(prev, u) {
    if (u.ch === SUP_ALEF || u.marks.indexOf(SUP_ALEF) >= 0) return true;
    if (isVowelled(u) || isSukun(u) || isShadda(u)) return false;
    if (!prev) return false;
    if (u.ch === "ا" || u.ch === "ى") return prev.marks.indexOf(FATHA) >= 0;
    if (u.ch === "و") return prev.marks.indexOf(DAMMA) >= 0;
    if (u.ch === "ي") return prev.marks.indexOf(KASRA) >= 0;
    return false;
  }

  /* ---------- the pass ---------- */

  /* Takes the words of one ayah and returns, for each word, a list of
     { start, end, rule } spans indexing into that word's string. Cross-word
     lookahead is why the whole ayah is handled at once. */
  function scanAyah(words) {
    var all = [], w, i;
    for (w = 0; w < words.length; w++) {
      var us = units(words[w]);
      for (i = 0; i < us.length; i++) { us[i].w = w; all.push(us[i]); }
    }
    var spans = [];
    for (w = 0; w < words.length; w++) spans.push([]);
    function mark(u, rule) { spans[u.w].push({ start: u.start, end: u.end, rule: rule }); }

    for (i = 0; i < all.length; i++) {
      var u = all[i], next = all[i + 1] || null, prev = all[i - 1] || null;

      /* ghunnah: a doubled nūn or mīm is held on the nose for two counts */
      if ((u.ch === "ن" || u.ch === "م") && isShadda(u)) { mark(u, "ghunnah"); continue; }

      /* nūn sākinah and tanwīn, decided by the letter that follows.
         The small mīm written above or below is the scribe's own iqlāb
         sign, so where it appears there is nothing left to work out. */
      var iqlabSign = u.marks.indexOf(IQLAB_MARK) >= 0 || u.marks.indexOf(IQLAB_LOW) >= 0;
      var isNoonSakin = (u.ch === "ن" && (isSukun(u) || isSilentStop(u)));
      if (iqlabSign) { mark(u, "iqlab"); continue; }
      if (isNoonSakin || isTanween(u)) {
        if (next && isLetter(next.ch)) {
          var n = next.ch;
          if (IZHAR.indexOf(n) >= 0) { /* clear: nothing to show */ }
          else if (IQLAB.indexOf(n) >= 0) { mark(u, "iqlab"); }
          else if (IDGHAM_GH.indexOf(n) >= 0 || IDGHAM_NO.indexOf(n) >= 0) {
            mark(u, "idgham"); mark(next, "idgham");
          } else { mark(u, "ikhfa"); }
          continue;
        }
      }

      /* mīm sākinah */
      if (u.ch === "م" && (isSukun(u) || isSilentStop(u)) && next) {
        if (next.ch === "ب") { mark(u, "ikhfa"); continue; }
        if (next.ch === "م") { mark(u, "idgham"); mark(next, "idgham"); continue; }
      }

      /* qalqalah: an echoed stop, only where the sukūn is written */
      if (QALQALAH.indexOf(u.ch) >= 0 && isSukun(u)) { mark(u, "qalqalah"); continue; }

      /* lām of the definite article before a sun letter: written, silent */
      if (u.ch === "ل" && prev && (prev.ch === "ا" || prev.ch === "ٱ") &&
          !isVowelled(u) && next && SUN.indexOf(next.ch) >= 0 && isShadda(next)) {
        mark(u, "silent"); continue;
      }

      /* madd. The written madd sign is the authority for anything longer
         than the natural two counts; its grade comes from what follows. */
      if (maddKind(prev, u)) {
        if (u.marks.indexOf(MADDAH) >= 0) {
          var after = next;
          if (after && isShadda(after)) mark(u, "madd6");
          else if (after && HAMZA.indexOf(after.ch) >= 0) mark(u, "madd4");
          else if (after && after.w !== u.w && HAMZA.indexOf(after.ch) >= 0) mark(u, "madd4");
          else mark(u, "madd4");
        } else {
          mark(u, "madd2");
        }
        continue;
      }
    }
    return spans;
  }

  /* Wrap one word's characters in the spans found for it. Spans never
     overlap — each letter unit gets at most one rule — so a single pass
     over the string is enough. */
  function wrap(word, spans, esc) {
    if (!spans.length) return esc(word);
    spans.sort(function (a, b) { return a.start - b.start; });
    var out = "", at = 0, i;
    for (i = 0; i < spans.length; i++) {
      var s = spans[i];
      if (s.start < at) continue;
      out += esc(word.slice(at, s.start));
      out += '<b class="tj tj-' + s.rule + '">' + esc(word.slice(s.start, s.end)) + "</b>";
      at = s.end;
    }
    out += esc(word.slice(at));
    return out;
  }

  /* the public call: words in, HTML out, one string per word */
  /* Natural madd falls on more than half the words in the mushaf. Colouring
     it by default would tint the page rather than teach anything, so it is
     off unless asked for. */
  function markAyah(words, esc, opts) {
    var natural = !!(opts && opts.natural);
    var spans = scanAyah(words), out = [], i;
    for (i = 0; i < words.length; i++) {
      var list = natural ? spans[i] : spans[i].filter(function (x) { return x.rule !== "madd2"; });
      out.push(wrap(words[i], list, esc));
    }
    return out;
  }

  return { rules: RULES, markAyah: markAyah, scanAyah: scanAyah, units: units };
})();
