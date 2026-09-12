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

Press the download icon in the top bar, pick a reciter, then **Download this
surah** or **Download this juzʾ**. Files go into the browser's Cache Storage
and play from there with no network at all.

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

- **Recite-to-reveal** uses the Web Speech API, which means Chrome, Edge and
  Safari. Firefox has no support and the microphone button is disabled there.
  Recognition is sent to the browser vendor's service, so it needs a network
  even when audio is saved offline.
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
config.js      reciters and audio sources — the file to edit
app.js         the whole application
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
