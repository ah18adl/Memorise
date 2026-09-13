/* ------------------------------------------------------------------
   Sabaq Mushaf — recitation sources
   ------------------------------------------------------------------
   Edit this file to add reciters or change where audio comes from.
   Nothing else needs to change.

   A SOURCE knows how to build a URL for one ayah.
   A RECITER lists the id it uses on each source it exists on.
   If a reciter has no id for the selected source, it is hidden from
   the list while that source is active.
   ------------------------------------------------------------------ */

window.SABAQ_CONFIG = {

  /* Bumped on every deploy. app.js carries the same string; if the two ever
     disagree, the browser is holding files from two different builds and the
     app says so rather than half-working. */
  version: "2026-09-14a",


  /* The on-device recitation model. `model` and `meta` are the two files the
     Colab notebook writes into web-model/ — copy that folder in beside this
     file. `ort` and `wasm` point at the ONNX runtime; pin a version you have
     tested, or vendor the files onto your own domain and point at those, which
     also makes the engine work with no network at all. */
  ctc: {
    model: "web-model/model.int8.onnx",
    meta:  "web-model/model.json",
    ort:   "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/ort.min.js",
    wasm:  "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.19.2/dist/"
  },


  /* Which source to use by default: a key from `sources` below. */
  defaultSource: "everyayah",

  /* Which reciter to use by default: an `id` from `reciters` below. */
  defaultReciter: "husary",

  sources: {
    everyayah: {
      label: "everyayah.com",
      /* rec.everyayah is the folder name on that host */
      url: function (rec, surah, ayah, pad3) {
        return "https://everyayah.com/data/" + rec.everyayah + "/" +
               pad3(surah) + pad3(ayah) + ".mp3";
      }
    },
    islamicnetwork: {
      label: "cdn.islamic.network",
      /* this host numbers ayat 1-6236 straight through the mushaf */
      url: function (rec, surah, ayah, pad3, globalAyah) {
        return "https://cdn.islamic.network/quran/audio/64/" +
               rec.islamicnetwork + "/" + globalAyah + ".mp3";
      }
    }
  },

  reciters: [
    { id: "husary",          name: "Mahmoud Khalil Al-Hussary",
      everyayah: "Husary_64kbps",                  islamicnetwork: "ar.husary" },
    { id: "husary-muallim",  name: "Al-Hussary — Muallim (teaching pace)",
      everyayah: "Husary_Muallim_128kbps" },
    { id: "husary-mujawwad", name: "Al-Hussary — Mujawwad",
      everyayah: "Husary_Mujawwad_128kbps",        islamicnetwork: "ar.husarymujawwad" },
    { id: "abdulbasit",      name: "Abdul Basit — Murattal",
      everyayah: "Abdul_Basit_Murattal_64kbps",    islamicnetwork: "ar.abdulbasitmurattal" },
    { id: "minshawi",        name: "Muhammad Siddiq Al-Minshawi",
      everyayah: "Minshawy_Murattal_128kbps",      islamicnetwork: "ar.minshawi" },
    { id: "alafasy",         name: "Mishary Rashid Al-Afasy",
      everyayah: "Alafasy_64kbps",                 islamicnetwork: "ar.alafasy" },
    { id: "shaatree",        name: "Abu Bakr Ash-Shatri",
      everyayah: "Abu_Bakr_Ash-Shaatree_128kbps",  islamicnetwork: "ar.shaatree" },
    { id: "sudais",          name: "Abdul Rahman Al-Sudais",
      everyayah: "Abdurrahmaan_As-Sudais_192kbps", islamicnetwork: "ar.abdurrahmaansudais" }
  ]
};
