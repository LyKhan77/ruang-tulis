# Panduan pengembangan

[README](../README.md) · [Penggunaan](penggunaan.md) · [Penyimpanan dan pemulihan](penyimpanan.md)

## Arsitektur

Ruang Tulis adalah aplikasi klien React dan TypeScript. Tiptap di atas ProseMirror menyediakan editor dokumen; Vite menyajikan aplikasi saat pengembangan dan menghasilkan aset statis. Tidak ada backend aplikasi, API akun, autentikasi, layanan sinkronisasi, atau server kolaborasi. Server Vite bukan layanan penyimpanan dokumen: data dokumen berada di browser.

| File | Tanggung jawab |
| --- | --- |
| `index.html`, `src/main.tsx` | Halaman masuk, inisialisasi tema, dan pemasangan React. |
| `src/App.tsx` | Antarmuka, daftar dokumen, perintah editor, pencarian, cadangan, dan alur pemulihan penyimpanan. |
| `src/editor.ts` | Ekstensi Tiptap, pemformatan, dan perilaku pencarian/penggantian. |
| `src/data.ts` | Model dokumen, validasi konten/cadangan, dan penyimpanan IndexedDB. |
| `src/save-session.ts` | Sesi penyimpanan per identitas dokumen, antrean perubahan, status simpan, dan pemeriksaan revisi. |
| `src/image-preflight.ts` | Pemeriksaan berkas gambar sebelum penyisipan. |
| `src/docx.ts` | Konversi DOCX ke skema editor, ekspor Office Open XML, nama berkas, dan pemberitahuan keterbatasan. |
| `src/docx-archive.ts` | Pemeriksaan ZIP/XML dan relasi paket sebelum konversi berkas Word. |
| `src/mammoth-browser.d.ts` | Deklarasi tipe untuk entrypoint Mammoth khusus browser. |
| `src/theme.ts` | Preferensi tema, tema sistem, dan sinkronisasi preferensi antar-tab. |
| `src/styles.css` | Tata letak, tema, editor, dan gaya cetak. |
| `src/*.test.ts`, `src/*.test.tsx` | Pengujian editor, data, sesi simpan, gambar, antarmuka, tema, dan DOCX. |
| `src/raster-fixtures.ts`, `src/theme-test-environment.ts` | Fixture gambar dan lingkungan pengujian tema. |
| `scripts/start-local.mjs` | Launcher lokal: pemeriksaan lingkungan, instalasi dependensi, lock, dan proses Vite. |
| `scripts/start-local.test.mjs` | Pengujian launcher dengan Node test runner. |
| `start.cmd`, `start.command`, `start.sh` | Wrapper Windows, macOS, dan shell POSIX. |
| `vite.config.ts`, `tsconfig.json` | Konfigurasi Vite/Vitest dan TypeScript. |
| `package.json`, `package-lock.json` | Skrip dan versi dependensi yang dikunci. |

Dependensi utama: React 19, Tiptap 3.31.4 beserta StarterKit, Image, Table, dan TextAlign. Konversi DOCX memakai `docx` untuk menghasilkan Office Open XML, Mammoth untuk impor semantik, dan `fflate` untuk pemeriksaan arsip berbatas. Peralatan pengembangan: TypeScript 5.8, Vite 6, plugin React, Vitest, jsdom, dan fake-indexeddb. Tidak diperlukan instalasi Vite global atau database server.

Mammoth sendiri tidak menyanitasi dokumen. Jalur impor harus memeriksa paket dan batas arsip sebelum konversi, menonaktifkan akses berkas eksternal/style map tertanam, menyaring HTML ke skema editor, serta memvalidasi konten dan mendekode gambar sebelum penyimpanan. Jangan mengganti jalur tersebut dengan pemasangan HTML hasil konversi langsung ke DOM.

Pertahankan pemisahan DOCX dan cadangan aplikasi. Pengujian DOCX harus memeriksa struktur ZIP/XML serta konversi isi sesungguhnya, bukan hanya ekstensi atau mock converter. Konversi semantik tidak menjamin kecocokan seluruh fitur/tata letak Word; perilaku yang belum diuji di aplikasi Office nyata harus disebutkan secara jujur.

## Lingkungan dan skrip

Gunakan Node.js **22.12.0 atau lebih baru**, npm, dan browser modern dengan IndexedDB serta `Promise.withResolvers`. Target keluaran TypeScript tetap ES2022; tipe `ES2024.Promise` tersedia untuk resolver pada jalur konversi berbasis event. Jalankan perintah berikut dari akar repositori hasil clone:

```sh
npm start
```

Launcher memasang dependensi bila diperlukan. Untuk instalasi eksplisit, pengembangan langsung, pengujian, dan build:

```sh
npm ci --include=dev --include=optional
npm run dev
npm run test:launcher
npm test
npm run build
```

- `npm run dev`: menjalankan Vite langsung. Tidak menjalankan mekanisme instalasi/cache/lock launcher dan tidak menambahkan pembukaan browser otomatis.
- `npm run test:launcher`: hanya pengujian Node untuk launcher.
- `npm test`: pengujian launcher, lalu `vitest run` untuk sumber aplikasi.
- `npm run build`: `tsc -b && vite build`; keluaran Vite berada di `dist/`.
- Vitest memakai jsdom, mencari `src/**/*.test.{ts,tsx}`, dan mengaktifkan `restoreMocks`.
- Tidak ada skrip `lint`, `format`, atau `preview` dalam `package.json`.

Untuk memeriksa hasil build secara lokal setelah build berhasil:

```sh
npx --no-install vite preview
```

Konfigurasi preview juga menggunakan `127.0.0.1:5173` dengan port ketat. Hentikan server lain pada port tersebut dahulu. Preview bukan backend atau rancangan deployment produksi.

## Cara kerja launcher

`npm start` menjalankan `node scripts/start-local.mjs`. Launcher menentukan direktori proyek dari lokasi skripnya, bukan dari direktori kerja pemanggil. Wrapper shell berpindah ke direktorinya sendiri dan meneruskan argumen. Wrapper Windows memakai opsi default dan tidak meneruskan argumen; gunakan npm atau Node untuk flag.

```sh
npm start -- --no-open
npm start -- --help
node scripts/start-local.mjs --no-open
node scripts/start-local.mjs --help
```

`--help` tetap memeriksa versi Node, tetapi tidak mencari npm, memasang dependensi, memeriksa port, atau mengambil lock. Hanya `--help` dan `--no-open` yang diterima. Argumen lain menghasilkan `Unknown argument: …`; host dan port tidak dapat diubah melalui launcher.

Urutan normal:

1. Periksa versi Node, argumen, dan ketersediaan port loopback.
2. Cari `npm-cli.js` lokal dari instalasi Node/npm; tidak menjalankan wrapper `.cmd` melalui shell.
3. Ambil lock `.start-local.lock/`, lalu periksa port kembali.
4. Baca `package.json` dan `package-lock.json`, lalu hitung fingerprint.
5. Bila instalasi belum cocok atau runtime cache rusak, jalankan `npm ci --include=dev --include=optional`.
6. Validasi runtime Vite, Rollup, dan esbuild, termasuk dependensi native/opsional, sebelum menulis marker `node_modules/.start-local-fingerprint`.
7. Jalankan Vite lokal dengan `--host 127.0.0.1 --port 5173 --strictPort`, serta `--open` kecuali `--no-open` dipilih.

Fingerprint mencakup isi lockfile, deklarasi dependensi dan konfigurasi instalasi relevan, hook instalasi akar, platform, arsitektur, dan versi mayor Node. Perubahan skrip yang tidak terkait instalasi tidak dengan sendirinya membatalkan cache. Cache yang tampak cocok tetap diperiksa runtime-nya; kegagalan pemeriksaan memicu instalasi ulang. Bila deklarasi dependensi berubah saat instalasi berlangsung, launcher menolak mengesahkan instalasi itu.

Instalasi memerlukan akses registry npm atau cache npm yang memadai. `npm ci` membangun ulang dependensi lokal dan dapat menjalankan lifecycle script paket. Launcher ini bukan sandbox dan tidak menjamin aplikasi terisolasi dari jaringan.

### Port, penghentian, dan lock

Alamat launcher tetap `http://127.0.0.1:5173/`. Jika port dipakai, launcher berhenti dengan pesan `The loopback port 5173 is already in use.`; ia tidak membunuh proses lain dan tidak memilih port baru. Konfigurasi Vite juga menetapkan host tersebut dan `strictPort: true`. Binding loopback membatasi listener server, bukan memberikan autentikasi, enkripsi, atau larangan seluruh koneksi keluar.

Hentikan launcher dengan **Ctrl+C** di terminal asal. Launcher menangani SIGINT/SIGTERM, menghentikan proses anak miliknya, dan melepaskan lock setelah proses itu selesai. Pada sistem non-Windows, pengelolaan ini juga melacak kelompok proses anak.

Lock merekam kepemilikan proses dan fase peluncuran agar dua launcher tidak melakukan instalasi bersamaan. Lock basi hanya dipulihkan otomatis bila catatan valid dan proses pemilik/anak tidak aktif. Lock ambigu, rusak, dari host lain, atau tertinggal dalam fase `spawning` ditolak untuk dipulihkan secara otomatis.

**Jangan menghapus lock yang masih aktif.** Jika pesan `Cannot safely recover launcher lock …` muncul, periksa proses launcher, instalasi npm, dan server editor terlebih dahulu. Hapus direktori lock secara manual hanya setelah memastikan tidak ada proses tersebut yang berjalan. Jangan menjadikan penghapusan lock atau penghentian proses sembarang sebagai langkah pertama.

### Diagnosis awal

- `Node.js … is unsupported.`: pasang Node LTS yang memenuhi minimum, lalu buka ulang terminal.
- npm tidak ditemukan: gunakan instalasi Node yang menyertakan npm; tidak perlu paket global.
- Berkas deklarasi dependensi tidak terbaca: pulihkan `package.json`/`package-lock.json` dari repositori.
- Runtime Vite/Rollup/esbuild gagal: periksa konfigurasi npm, paket native/opsional, izin berkas, dan hasil instalasi; jangan menandai cache sebagai valid secara manual.
- `npm ci` selesai tetapi CLI/binary Vite hilang: periksa konfigurasi npm, termasuk `bin-links`.
- Port terpakai: hentikan aplikasi pemilik port melalui mekanismenya sendiri, lalu coba lagi.

## Status audit dependency DOCX

Saat dukungan DOCX ditambahkan dengan Mammoth 1.13.0, `npm audit` melaporkan **tiga entri moderate** pada rantai `mammoth → argparse → sprintf-js`. Penyebabnya adalah [GHSA-hp3w-g68c-fv3c](https://github.com/advisories/GHSA-hp3w-g68c-fv3c): format precision yang tidak dibatasi dapat menyebabkan denial of service. Advisory mencakup `sprintf-js <=1.1.3` dan belum mencantumkan versi patch.

`argparse` dipakai oleh CLI `bin/mammoth`; aplikasi ini mengimpor `mammoth/mammoth.browser.js`, bukan CLI tersebut. Bundle browser yang dipakai tidak menyertakan `argparse` atau `sprintf-js`. Ini menjelaskan cakupan temuan, **bukan klaim bahwa audit sudah bersih atau seluruh risiko keamanan telah hilang**. Dependency CLI tetap terpasang melalui paket Mammoth.

Jalankan kembali `npm audit` saat memperbarui dependency dan pantau patch upstream. Jangan memakai `npm audit fix --force`, downgrade besar, atau menonaktifkan audit hanya untuk menghilangkan laporan. Perubahan dependency perlu ditinjau dan diuji ulang.

## Alur kontribusi yang aman

1. Buat branch terpisah dan tinjau sumber yang akan diubah. Ekspor cadangan sebelum memakai dokumen penting dalam pengembangan.
2. Gunakan dokumen contoh tanpa data pribadi. Jangan commit isi IndexedDB, cadangan pengguna, kunci, token, atau path pribadi.
3. Pertahankan invariant: perpindahan dokumen harus menunggu penyimpanan, konflik revisi tidak boleh menimpa data diam-diam, dan import tidak boleh melewati validasi.
4. Untuk perubahan skema, validasi cadangan, gambar, atau pemulihan, tambahkan pengujian yang mencakup data rusak, kegagalan penyimpanan, dan perubahan antar-tab. Browser nyata tetap diperlukan untuk memeriksa cetak, unduhan, kuota penyimpanan, dan perilaku native.
5. Perbarui lockfile bersama perubahan dependensi. Tinjau paket baru dan lifecycle script-nya. Jangan melonggarkan loopback atau validasi konten hanya untuk mempermudah debug.
6. Setelah seluruh perubahan siap, jalankan `npm test` dan `npm run build`, lalu periksa alur utama secara manual. Perintah di atas mendokumentasikan verifikasi; bukan klaim bahwa pengujian telah dijalankan saat penulisan panduan ini.
7. Tinjau diff agar tidak menyertakan hasil build, `node_modules`, lock launcher, atau data sensitif. Perbarui dokumentasi jika label/perilaku berubah.

Pertahankan [lisensi MIT](../LICENSE) dan atribusi **Copyright (c) 2026 LyKhan77**. Tidak ada jaminan enkripsi penyimpanan atau cadangan; lihat [panduan penyimpanan](penyimpanan.md) sebelum menangani dokumen sensitif.
