# Sabaq Mushaf

A mushaf built for memorisation. The full Qur'an in Uthmani script with
word-by-word English, concealment modes, live recitation tracking through the
microphone, flexible loop ranges, sabaq / sabqī / manzil progress, and
recitation audio you can save to the device for offline use.

Everything is static — HTML, CSS, one JS file and the text data. There is no
build step, no framework and no server code.

---

## Deploying

The only real requirement is **HTTPS**. The service worker (offline use) and
the microphone both refuse to run on plain HTTP. `localhost` counts as secure,
so local testing works without a certificate.

**Any static host.** Drag the folder onto Netlify, or point Vercel or
Cloudflare Pages at a repo containing it. No build command, no output
directory — publish the folder as-is.

**Which host, once the model is involved.** The app itself is about 4 MB, which
nobody minds. The model is ~95 MB, and that is what separates the free tiers:

| Host | Free bandwidth | Largest single file |
|---|---|---|
| Cloudflare Pages | unlimited | **25 MiB** |
| GitHub Pages | 100 GB/mo (soft) | 100 MB (Git's limit) |
| Netlify / Vercel | 100 GB/mo | fine |

Cloudflare Pages is the best of these — unlimited bandwidth costs nothing — and
its file cap is the only thing in the way. So the model can be split:

```bash
python3 ctc/split_model.py web-model/model.int8.onnx --max-mb 20
```

That writes `model.int8.onnx.part00`, `part01`, … beside the original and
prints the `config.js` block to paste in. The app fetches the parts in order,
skips any already saved, and joins them back into one buffer before the runtime
sees it — the split is invisible past the download. Keep the `modelSize` line
the script prints: without it there is no total to measure against, so the
panel shows megabytes instead of a percentage.

**GitHub Pages.** Push the folder to a repo and enable Pages on that branch.
If it lands in a subpath (`/sabaq/`), everything still works: all paths in the
app are relative.

**Your own server.** Copy the folder into the web root. Nginx and Apache
defaults are fine. Two things worth setting:

```nginx
# so a redeploy is picked up promptly
location = /sw.js      { add_header Cache-Control "no-cache"; }
location = /config.js  { add_header Cache-Control "no-cache"; }
```

**Locally**, to try it before deploying:

```bash
cd sabaq-mushaf && python3 -m http.server 8000
# then open http://localhost:8000
```

## Controls

**Top bar** — the list icon on the left opens all surahs; swiping right anywhere
in the mushaf does the same. The gear on the right opens Ayah tools for whatever
ayah you are on. Translation, transliteration and word-by-word live in the
display menu; the download icon opens audio and offline storage.

**Bottom dock** — concealment on the upper row; below it play, the repetition
counter, and the microphone.

**The counter** shows repetitions of the current ayah against your target.
It counts up on its own while audio plays, and you can tap it to count a
repetition while reciting from memory. **Hold it for a moment to reset to
zero.** The target itself is set in Ayah tools.

**Loops** run over any range of ayat, and *Stop after* sets how many times
round — pick 3, 5, 7 or 10 and it stops by itself when the count is met,
rather than looping indefinitely. Leave it on ∞ to loop until you stop it.

---

## Mistake tracking

`tracker.js` aligns what was recognised against the canonical text and reports
what went wrong. It is deliberately independent of how the speech was
recognised: swapping the browser's recogniser for a Whisper or CTC endpoint
means changing `startMic` in `app.js` and nothing else.

**How it works.** Recognised words are aligned against a window of the text
with a semi-global Needleman-Wunsch alignment over word-level edit distance —
the approach Tarteel describe in their published work, where text alignment
replaces acoustic alignment. Matches, substitutions, omissions and insertions
all fall out of one traceback, which a greedy "is this the next word" scan
cannot do: it has no way to tell a skipped word from a misheard one.

The alignment is semi-global on purpose. Every recognised word must be placed,
but the text may run past the end for free — text after the last word spoken
has not been skipped, it just has not been reached. Text jumped over on the way
still costs, which is what makes a skipped ayah visible as a skip. A fully
global alignment scores "matched here" and "matched the identical phrase forty
words later" the same and picks arbitrarily, and the Qur'an is full of
identical phrases.

**What it reports:** wrong or substituted word (down to which letters
differed), words missed, whole ayat skipped, repeats, hesitations, restarts,
and drifting into a similar passage elsewhere — caught with a 4-gram index over
all 77,430 words, which is what makes the mutashābihāt case detectable.

**Confidence gating.** A recogniser makes errors that look exactly like
recitation mistakes. A finding is only reported when the words *around* it
aligned cleanly: local agreement is the evidence that the disagreement in the
middle is real. Confidence is measured across the words that did line up, with
gaps excluded — counting an omission against the evidence for that omission
would make skips undetectable. Told repeatedly that you erred when you did not,
you would stop trusting it, so silence is the better failure.

**What it does not do.** Tajweed. Rulings like madd length, ghunnah and ikhfāʾ
are acoustic and durational; they cannot be recovered from a text transcript at
all. That needs frame-level acoustic output — which is what the on-device
engine below provides.

**Testing.** `build/test_tracker.mjs` in the source tree drives the engine
through clean recitation, recogniser noise, a skipped ayah, a substituted word,
a dropped word, a repeat, a restart and a drift, asserting both that real
mistakes are caught and that clean recitation and noisy recognition produce
nothing.

---

## The on-device engine

Audio → Listening offers two ways of hearing you.

**Browser speech recognition** is the default: nothing to download, but your
voice goes to the browser vendor's service, it needs a network, and it hands
back words with no timing. A lengthened madd and a clipped one are the same
word to it.

**The on-device model** is a CTC acoustic model — the one `ctc/` trains — run
through `onnxruntime-web` in a worker. Your voice never leaves the device, it
works with no network, and because CTC output is frame-by-frame it gives a
start and end time for every letter. That is what makes madd measurable at all.

### Installing a trained model

The Colab notebook writes `web-model/` into Drive, containing
`model.int8.onnx` and `model.json`. Copy that folder in beside `config.js`:

```
web-model/
  model.int8.onnx    the quantised model, about 95 MB
  model.json         vocabulary, blank id, separator id, ms per frame
```

Then pick **On-device model** in the Audio panel and press **Download the
model**. It goes into Cache Storage once and stays there; the app shell
deliberately does not include it, so someone who only wants to read never pays
the 95 MB.

Paths, and where the ONNX runtime comes from, are in `config.js` under `ctc`.
The runtime defaults to a pinned build on jsDelivr and is cached after first
use. Vendoring `ort.min.js` and its `.wasm` files onto your own domain and
pointing `ctc.ort` / `ctc.wasm` at them makes the engine work on a device that
has never been online.

### How it works

Audio is captured at 16 kHz — resampled with a windowed-sinc lowpass when the
device insists on 44.1 or 48 kHz, because plain decimation folds everything
above 8 kHz back down into the speech band as noise the model has never heard.
Every 700 ms the last few seconds go to the worker, which normalises them the
way the training feature extractor did, runs the model, takes a log-softmax and
produces two things:

- a **greedy decode**, grouped into words, fed to exactly the same tracker the
  speech path feeds. Position, skips, substitutions and drift all keep working
  unchanged — the tracker cannot tell which engine is talking to it.
- a **forced alignment** of the text that *should* be there, which the app
  supplies a window at a time. Letters the audio does not support are
  underlined in brass: a question about pronunciation, not a claim that the
  word was wrong, and deliberately only ever shown for words already recited.

### Why duration is measured between spikes

A trained CTC model is **peaky**: it spends almost every frame predicting the
blank and fires a single spike where each letter lands. Span width is therefore
close to constant — one frame for everything — and reading duration off it
reads noise. What the spikes carry exactly is *onset*, so length here is the
interval from one letter's spike to the next one's, which is the same quantity
a phonetician would measure.

On a real alignment of 108:2 that gives 540, 520, 200 ms for the opening
letters, 40 ms for the alef wasla the reciter correctly elides, and 960 ms for
the held syllable before the pause — against a median of 220 ms. That ratio is
the madd, and it is visible without the vowel marks being in the vocabulary at
all, because a consonant's onset-to-onset interval *is* its syllable's length.

Letters that are silent by rule — alef wasla after a vowel, the small waw and
yeh — are never flagged. Forced alignment has to place every target symbol
somewhere, so a silent letter always lands on a frame that does not support it.
Marking that would be reporting someone for obeying the rule.

A word is handed over once and never revised. The rule for "once" is distance
from the live edge: a word whose last frame is within 160 ms of the end of the
window may still grow another letter, so it waits. Everything behind that is
settled, and when the window outgrows seven seconds it is cut at the end of the
last word already handed over, so no audio is ever decoded twice.

Three failures in a row stop the loop rather than retrying every 700 ms — a
broken model or a missing runtime should say so, not bury itself in a log.

**Testing.** `ctc/web/test_align.mjs` drives the aligner with hand-built
emission matrices where the right answer is known exactly.
`ctc/web/test_engine.mjs` runs the engine against a fake microphone and a fake
worker, asserting that no word is emitted twice across window boundaries and
that a 12 kHz tone is rejected rather than folded into the speech band.
`ctc/web/test_worker.mjs` checks the log-softmax against a reference and that a
loud and a quiet recording of the same thing reach the model identically.

---

## Tajwīd colouring

Display menu → **Tajwīd colouring**. The rules are derived from the text, not
read from a tag file, because the Uthmani script already records what they
need: sukūn is written (37,147 of them), shadda is written (22,679), the madd
sign marks every lengthening beyond the natural two counts, and iqlāb carries
its own small mīm.

Coloured: ghunnah, idghām, ikhfāʾ, iqlāb, qalqalah, madd lāzim, madd
wājib/jāʾiz, and the silent lām of the definite article. Izhār is left plain —
"pronounce it clearly" is the absence of a rule, and colouring it would say
otherwise. Natural madd falls on more than half the words in the mushaf, so it
is computed but not shown; `markAyah(words, esc, {natural:true})` turns it on.

Two things it deliberately will not do. It does not guess at **waqf** — qalqalah
and madd ʿāriḍ change with where the reciter chooses to stop, and colour that is
wrong as often as it is right teaches nothing. And it stands down wherever a
word is concealed or marked as a mistake: the colour is set on the letters, so
without that it would show through a hidden word and defeat the mode.

`ctc/web/test_tajweed.mjs` checks it against ayāt whose rulings are not in
dispute — `مِّن رَّبِّهِمْ` for idghām, `مِنۢ بَعۡدِ` for iqlāb, `يَنقُضُونَ`
for ikhfāʾ, `أَنۡعَمۡتَ` for izhār, `ٱلضَّآلِّينَ` for madd lāzim — naming each
word rather than its position, then runs the whole mushaf: 77,430 words,
83,187 rulings. The iqlāb count lands at 604 against 609 scribal meems in the
text, which is the cross-check that matters.

---

## Choosing reciters — `config.js`

`config.js` is the only file you need to touch to change the audio. It holds
two things: **sources** (hosts that serve recitation, and how to build a URL
for one ayah) and **reciters** (the id each reciter uses on each source).

```js
reciters: [
  { id: "husary", name: "Mahmoud Khalil Al-Hussary",
    everyayah: "Husary_64kbps", islamicnetwork: "ar.husary" },
  ...
]
```

A reciter is hidden from the list while a source it has no id for is active,
so adding one is just adding a line. To add a whole new host, add an entry to
`sources` with a `url` function.

**The folder names shipped here are the conventional ones for those hosts but
have not been verified against the live sites** — I had no network access to
them while building this. If a reciter does not play, the download panel has a
source switcher; failing that, check the real folder name on the host and
correct it here. The app play-tests one ayah before any bulk download and
tells you if the combination does not respond, so a wrong name cannot quietly
fill your cache with 404s.

---

## How offline audio works

Press the download icon in the top bar and pick a reciter. Below that is every
surah, with what is saved marked on each row: **Saved**, a part count like
`43 of 129` when a download was interrupted, or an estimated size when it is
not there at all. Tick any combination, or use the shortcuts — this surah, this
juzʾ, everything not yet saved, all 114 — and press **Download selected**. The
summary line says how many ayat still have to be fetched and roughly how much
that is, before you commit to it. Files go into the browser's Cache Storage and
play from there with no network at all.

**What "saved" means is read from the cache itself**, not from a note kept
alongside it. Browsers evict storage under pressure without telling anyone, and
a remembered flag would go on claiming a surah was saved until you tried to
recite it on a train. Cache entries are matched to surahs by generating every
ayah URL the current reciter and source would use and looking each one up —
which costs a few milliseconds and works for any source added to `config.js`
later, whatever shape its URLs take.

The mechanism is worth knowing because it constrains things:

- Recitation hosts often send no CORS headers, so the browser stores those
  responses **opaque** — the page cannot read the bytes, only the service
  worker can hand them back to the audio element. That is why `sw.js` must be
  present and why HTTPS is required. Where a host *does* send CORS, the app
  stores a readable copy and plays it from a blob URL instead, which avoids
  range-request quirks entirely.
- Only `cache.put` accepts opaque responses; `cache.add` rejects them. If you
  rewrite the download code, keep `put`.
- Opaque entries are padded in the browser's quota accounting, so the space
  they occupy is larger than the file sizes. Budget generously. The panel
  shows total storage used.
- Storage is per browser and per device, and the browser may evict it under
  pressure. Calling `navigator.storage.persist()` on a user gesture would make
  eviction less likely; it is deliberately not called here because it prompts.

The app itself is also cached, so it opens and works — reading, concealment,
word-by-word, progress — with no connection whether or not you have downloaded
any audio.

---

## Known limits

- **Browser speech recognition** means Chrome, Edge and Safari; Firefox has no
  support. Recognition is sent to the browser vendor's service, so it needs a
  network even when audio is saved offline. The on-device engine has neither
  restriction — it runs anywhere with WebAssembly, Firefox included — but it is
  a 95 MB download and needs a trained model to have been deployed.
- **The on-device engine is only as good as the model behind it.** A model
  trained on two reciters and one juzʾ will follow those voices and struggle
  with yours. More voices is the single biggest lever.
- **iOS** will not autoplay audio without a user gesture, and installs the app
  to the home screen only through Safari's Share menu.
- **Progress** (repetitions and stage) is stored in `localStorage`, per
  browser. There is no account system, so it does not follow you between
  devices. If you want that, the natural next step is a small sync endpoint.

---

## Files

```
index.html     the page
styles.css     all styling, light and dark, driven by CSS custom properties
config.js      reciters, audio sources and model paths — the file to edit
app.js         the whole application
tracker.js     alignment and mistake detection, independent of the recogniser
ctc-align.js   CTC forced alignment and greedy decoding
ctc-engine.js  microphone, resampling, streaming, and the model's lifecycle
ctc-worker.js  the ONNX session — all inference, off the main thread
web-model/     a trained model, if you have deployed one (not included)
sw.js          service worker: offline shell + saved recitation
manifest.webmanifest, icon-*.png    home-screen install
data/
  data-meta.js   surah metadata, per-ayah page and juz numbers
  data-ar.js     Uthmani text (Tanzil), with detached tanwīn letters rejoined
  data-en.js     translation (Saheeh International)
  data-tr.js     transliteration
  data-wbw.js    word-by-word English, aligned 1:1 with the Arabic tokens
```

### On the text

The Arabic is Tanzil's Uthmani Hafs edition. That encoding detaches the silent
alif of a tanwīn word as its own token (`مَرَضࣰ` + `اۖ`); those are rejoined
here, which brings the word count to 77,430 and lets the word-by-word glosses
line up exactly, one per word, across all 6,236 ayāt. Seven ayāt where the
mushaf's word division genuinely differs from the corpus (`بَعۡدَ مَا`,
`لَّوۡمَا`, `مَالِيَ`, `وَمَالِيَ`, `إِلۡ يَاسِينَ`) are reconciled
explicitly rather than fudged.

Sources: [Tanzil](https://tanzil.net) for the Arabic text, the
[Quranic Universal Library](https://qul.tarteel.ai) for the word-by-word
translation, [everyayah.com](https://everyayah.com) and
[cdn.islamic.network](https://cdn.islamic.network) for recitation. Check the
licence terms of each before publishing the app publicly.
