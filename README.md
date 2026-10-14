# Ruang Tulis

Ruang Tulis adalah editor dokumen lokal berbahasa Indonesia, dibangun dengan React, TypeScript, dan Tiptap. Aplikasi menyediakan ruang menulis dengan daftar dokumen, pemformatan, cadangan dokumen, serta tema terang dan gelap. Dokumen disimpan di browser melalui IndexedDB, bukan di cloud atau sebagai berkas DOCX.

## Fitur yang tersedia

- Membuat, membuka, mengganti nama, mencari judul, memfilter dokumen yang diubah hari ini, dan menghapus dokumen dengan konfirmasi.
- Autosave setelah jeda pengetikan, status penyimpanan, serta deteksi konflik revisi antar-tab tanpa menimpa versi lain secara diam-diam.
- Teks normal dan Judul 1–3, tebal, miring, garis bawah, coret, daftar poin/bernomor, inden, perataan kiri/tengah/kanan, tautan, dan hapus format.
- Gambar lokal PNG, JPEG, GIF, dan WebP; tabel 3 × 3 dengan operasi baris/kolom; kerangka judul dan hitungan kata/karakter.
- Cari dan ganti teks literal pada dokumen aktif, tanpa membedakan huruf besar/kecil.
- Unduh cadangan dokumen aktif, ekspor semua dokumen, serta impor cadangan sebagai salinan baru.
- Tema **Terang**, **Gelap**, dan **Ikuti sistem**.
- **Cetak / PDF** melalui dialog cetak browser, bukan generator PDF khusus.

Belum tersedia: impor/ekspor **DOCX**, kolaborasi waktu nyata, akun, autentikasi, atau sinkronisasi cloud. Beberapa kesalahan validasi/penyimpanan masih ditampilkan dalam bahasa Inggris.

## Persyaratan

- Node.js **22.12.0 atau lebih baru** dan npm; gunakan Node LTS yang memenuhi minimum tersebut.
- Git untuk clone repositori.
- Browser modern dengan IndexedDB. `localStorage` digunakan terpisah untuk preferensi tema dan pilihan dokumen.
- Port `127.0.0.1:5173` yang tidak sedang digunakan.
- Akses ke registry npm atau cache npm yang memadai saat dependensi perlu dipasang. Tidak diperlukan Vite global atau backend/database server.

## Mulai cepat

```sh
git clone https://github.com/LyKhan77/ruang-tulis.git
cd ruang-tulis
npm start
```

Launcher memeriksa lingkungan, memasang dependensi lokal dengan `npm ci --include=dev --include=optional` bila diperlukan, lalu menjalankan Vite dan membuka browser di **http://127.0.0.1:5173/**. Tunggu proses instalasi dan startup selesai. Hentikan server dengan **Ctrl+C** di terminal asal.

### Alternatif wrapper

Semua perintah berikut dijalankan dari akar repositori hasil clone dan memakai launcher yang sama:

| Sistem | Cara menjalankan |
| --- | --- |
| Windows | Klik dua kali `start.cmd`, atau jalankan `.\start.cmd` dari PowerShell / `start.cmd` dari Command Prompt. |
| macOS | Klik dua kali `start.command` untuk membukanya lewat Terminal, atau jalankan `./start.command`. |
| Linux/shell POSIX | Jalankan `./start.sh`. |
| Semua sistem dengan Node | Jalankan `node scripts/start-local.mjs`. |

Wrapper Windows memakai opsi default; ia tidak meneruskan argumen. Wrapper macOS/POSIX meneruskan argumen, misalnya `./start.sh --no-open`. Jika izin executable tidak tersedia setelah penyalinan berkas, gunakan `sh ./start.sh` atau `sh ./start.command`.

Peluncuran shell macOS telah diverifikasi. Wrapper Windows disediakan dan konstruksi perintahnya diuji secara unit; peluncuran pada Windows nyata serta klik dua kali melalui Finder belum diverifikasi.

### Flag launcher

```sh
npm start -- --no-open
npm start -- --help
node scripts/start-local.mjs --no-open
node scripts/start-local.mjs --help
```

- `--no-open`: menjalankan server yang sama tanpa membuka browser; buka alamat di atas secara manual.
- `--help`: menampilkan bantuan tanpa mencari npm atau memasang dependensi; versi Node tetap diperiksa.
- Host dan port launcher tetap. Tidak ada flag pengubah host/port. Bila port terpakai, hentikan aplikasi pemilik port terlebih dahulu; launcher tidak membunuh proses lain atau beralih port.

## Penting: penyimpanan lokal bukan cadangan

**Menghapus data situs/browser dapat menghapus seluruh dokumen.** Dokumen terikat ke origin dan profil browser: `127.0.0.1` berbeda dari `localhost`, dan port berbeda memakai penyimpanan berbeda. Aplikasi tidak menyinkronkan dokumen ke browser, profil, atau perangkat lain.

Tunggu **Tersimpan di browser** sebelum menutup tab. Perubahan yang belum berhasil disimpan tidak dijamin pulih setelah reload atau browser ditutup. Gunakan **Unduh cadangan** atau **Ekspor semua dokumen** secara berkala dan simpan berkas di tempat aman. Berkas cadangan tidak dienkripsi oleh aplikasi dan dapat memuat data pribadi serta gambar.

Binding server ke loopback bukan jaminan enkripsi, autentikasi, atau isolasi jaringan. Lihat panduan penyimpanan untuk konflik, kegagalan IndexedDB, dan pemulihan.

## Panduan

- [Penggunaan](docs/penggunaan.md): alur dokumen, pemformatan, pintasan, cadangan, serta cetak/PDF.
- [Penyimpanan dan pemulihan](docs/penyimpanan.md): model data, autosave, origin browser, konflik, dan risiko kehilangan data.
- [Pengembangan](docs/pengembangan.md): arsitektur, skrip, launcher, pengujian, build, dan kontribusi aman.

## Pengembangan, pengujian, dan build

Dari akar repositori:

```sh
npm ci --include=dev --include=optional
npm run dev
npm run test:launcher
npm test
npm run build
```

`npm run dev` menjalankan Vite langsung tanpa instalasi/cache/lock launcher. `npm run test:launcher` hanya menguji launcher; `npm test` menjalankan pengujian launcher dan Vitest. Build menjalankan pemeriksaan TypeScript lalu menghasilkan aset statis di `dist/`. Hentikan server pengembangan sebelum menjalankan server lain pada port yang sama. Rincian ada di [panduan pengembangan](docs/pengembangan.md).

## Lisensi

[MIT](LICENSE). Copyright (c) 2026 LyKhan77.
