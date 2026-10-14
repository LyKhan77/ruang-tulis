# Penyimpanan, cadangan, dan pemulihan

[README](../README.md) · [Penggunaan](penggunaan.md) · [Pengembangan](pengembangan.md)

## Apa yang disimpan

Ruang Tulis tidak menyimpan dokumen sebagai DOCX, berkas teks di folder proyek, atau record pada backend. Dokumen ditulis ke **IndexedDB browser**:

| Komponen | Nilai/peran |
| --- | --- |
| Nama database | `document-editor-v1` |
| Versi IndexedDB | `1` |
| Object store | `documents` |
| Kunci record | `id` (`keyPath: 'id'`) |
| Isi record | `id`, `title`, `content`, `schemaVersion`, `createdAt`, `updatedAt`, `revision` |

`content` adalah pohon JSON internal Tiptap/ProseMirror, bukan HTML mentah. Akar bertipe `doc` mempunyai node seperti paragraf, judul, daftar, gambar, dan tabel. Node teks menyimpan teks beserta mark pemformatan, misalnya tebal atau tautan; atribut node menyimpan perataan, inden, dan data relevan lain. Gambar lokal berada di atribut `src` sebagai data URL base64 sehingga gambar ikut masuk ke cadangan.

`schemaVersion` dokumen bernilai `1`; waktu pembuatan/perubahan berupa ISO UTC. `revision` bertambah setiap penyimpanan yang berhasil dan dipakai untuk mendeteksi penulisan yang bertabrakan. ID adalah identitas teknis dokumen, bukan akun atau identitas pengguna.

Validator membatasi jenis node/mark/atribut dan struktur tabel, serta menolak data tidak valid. Batas utama: kedalaman 24, 30.000 node, teks 2 MiB, gambar raster 2 MiB per gambar, dan cadangan 12 MiB per berkas dengan maksimal 100 dokumen. Anggaran validasi teks/data juga berlaku pada kumpulan dokumen dalam cadangan. Editor menolak perubahan yang membuat konten melebihi batas sekitar 12 MiB, dengan cadangan ruang metadata 8 KiB. Batas aplikasi **bukan jaminan bahwa kuota browser selalu cukup**; base64 menambah ukuran gambar, dan penyimpanan tetap dapat gagal lebih awal.

Jangan mengedit record lewat DevTools sebagai cara pemulihan rutin. Perubahan manual dapat merusak struktur, revisi, atau validitas cadangan.

## Autosave dan pemilihan dokumen

Perubahan judul/isi dijadwalkan untuk ditulis setelah jeda **700 ms**. `SaveSession` mengantrekan penulisan agar perubahan baru yang terjadi saat simpan berlangsung tetap diproses berikutnya. **Ctrl/⌘ S** meminta flush segera ketika aplikasi tidak sedang sibuk. Membuka dokumen lain, membuat dokumen, dan mengimpor cadangan menunggu flush dokumen aktif; kegagalan dapat membatalkan tindakan tersebut.

Indikator **Menyimpan…** mencakup penulisan yang menunggu dan sedang berjalan. **Tersimpan di browser** berarti sesi sudah berhasil ditulis ke IndexedDB, bukan dicadangkan di luar browser. **Gagal menyimpan** berarti perubahan masih memerlukan pemulihan.

Aplikasi mencoba flush ketika komponen ditutup dan meminta peringatan `beforeunload` jika masih ada perubahan. Browser dapat menghentikan pekerjaan asinkron saat halaman/proses berakhir. **Jangan mengandalkan penutupan tab, crash recovery browser, atau restart launcher untuk menyimpan perubahan tertunda.**

Pada startup, database kosong diberi **Dokumen contoh**. Setelah membaca daftar, aplikasi mencoba membuka pilihan dokumen yang diingat; jika tidak ada, ia memakai record pertama menurut urutan kunci IndexedDB. Itu bukan janji membuka dokumen paling baru. Aplikasi hanya dapat membaca versi yang sudah tersimpan, bukan mengembalikan perubahan yang belum sempat ditulis.

## Origin dan profil browser terpisah

Penyimpanan situs dibatasi oleh **origin**: kombinasi skema, host, dan port. Contohnya:

- `http://127.0.0.1:5173/` berbeda dari `http://localhost:5173/`.
- `http://127.0.0.1:5173/` berbeda dari `http://127.0.0.1:5174/`.
- HTTP dan HTTPS merupakan origin berbeda.
- Browser lain, profil browser lain, serta sesi privat mempunyai penyimpanan masing-masing. Penyimpanan sesi privat dapat hilang ketika sesi berakhir atau tidak tersedia sesuai kebijakan browser.

Mengganti alamat/profil dapat membuat daftar terlihat kosong meskipun data masih ada pada origin/profil semula. Buka kembali alamat dan profil asal sebelum menyimpulkan dokumen hilang. Untuk memindahkan dokumen, ekspor cadangan dari tempat asal lalu impor di tempat tujuan; tidak ada sinkronisasi otomatis.

Menghapus folder clone, memasang ulang dependensi, atau menghapus `node_modules` bukan cara menghapus IndexedDB. Sebaliknya, clone ulang tidak mengembalikan dokumen yang telah dihapus dari data situs.

### Preferensi terpisah di localStorage

- `ruang-tulis:theme`: pilihan `light`, `dark`, atau `system`, dengan label **Terang**, **Gelap**, dan **Ikuti sistem**. Default mengikuti sistem. Perubahan preferensi dapat diterima tab lain pada origin yang sama melalui event storage.
- `ruang-tulis:selected-document`: identitas dokumen yang dipilih saat pengikatan dokumen ke editor.

Kedua preferensi ini bukan penyimpanan isi dokumen. Kegagalan mengingat pilihan atau tema tidak selalu berarti IndexedDB gagal. Tema dapat berlaku hanya selama sesi jika localStorage diblokir. Menghapus hanya key tema tidak menghapus dokumen; membersihkan seluruh data situs dapat menghapus IndexedDB dan preferensi sekaligus.

## Cadangan yang terlihat oleh pengguna

| Label UI | Hasil |
| --- | --- |
| **Unduh cadangan** | Snapshot dokumen aktif, termasuk perubahan yang belum tersimpan; `ruang-tulis-dokumen.json`. |
| **Ekspor semua dokumen** | Membaca semua record tersimpan; jika sesi aktif masih kotor, menambahkan salinan **(belum tersimpan)**. Hasil satu berkas: `ruang-tulis-semua.json`. |
| **Unduh semua bagian untuk cadangan lengkap.** | Bila ekspor dibagi, gunakan setiap tombol **Bagian … · … dokumen** untuk mengunduh seluruh `ruang-tulis-bagian-N.json`. |
| **Ekspor isi ini** | Snapshot dari panel kegagalan simpan; `ruang-tulis-belum-tersimpan.json`. Tidak memerlukan penulisan IndexedDB yang berhasil. |
| **Impor cadangan** | Validasi JSON dan gambar, kemudian tambahkan seluruh dokumen dalam satu transaksi sebagai salinan baru. |

Ekspor semua tidak menunggu flush terlebih dahulu. Karena versi tersimpan dan versi lokal yang belum tersimpan dipertahankan terpisah, cadangan bisa berisi dua versi dokumen aktif. Ekspor tetap harus membaca database; jika database tidak dapat dibaca, gunakan ekspor dokumen aktif atau **Ekspor isi ini** selama snapshot masih tersedia di editor.

Format cadangan mempunyai penanda `format: 'document-editor'`, `version: 1`, dan array `documents` dengan record lengkap. Tidak ada kata sandi atau enkripsi cadangan. Simpan berkas secara aman; teks, judul, tautan, gambar, dan metadata dapat memuat informasi sensitif.

Batas satu berkas adalah **12 MiB** dan **100 dokumen**. Ekspor koleksi dibagi jika diperlukan agar setiap bagian lolos validasi. Jangan hanya menyimpan bagian pertama. Browser juga dapat meminta izin unduh atau memblokir unduhan; periksa lokasi unduhan dan keberadaan berkas.

Impor memberi ID baru, waktu pembuatan/perubahan baru, dan revisi awal 0. Isi/judul dipertahankan, tetapi dokumen lama tidak ditimpa. Seluruh isi cadangan divalidasi dan gambar didekode sebelum transaksi; bila gagal, impor tidak boleh meninggalkan sebagian dokumen. Impor berulang menghasilkan duplikat. Format/versi lain, DOCX, SVG, dan gambar jarak jauh tidak didukung.

Cadangan tidak otomatis dibuat di folder proyek, tidak dijadwalkan oleh launcher, dan tidak otomatis diimpor saat aplikasi dimulai. PDF juga bukan cadangan editable yang dapat diimpor kembali.

## Konflik dan kegagalan penyimpanan

### Konflik antar-tab

Dua tab dapat membuka versi dokumen yang sama. Saat menulis atau menghapus, store membandingkan revisi yang diharapkan dengan revisi database. Revisi berbeda memicu `ConflictError`:

```text
The document has changed. Reload it before saving or deleting.
```

Jika record sudah dihapus, `MissingDocumentError` menggunakan pesan:

```text
The document no longer exists.
```

Ini deteksi konflik, **bukan kolaborasi, penggabungan otomatis, atau penyegaran isi antar-tab**. Tab lain tidak otomatis memperbarui teks editor Anda. Kegagalan mempertahankan teks sesi di memori, tetapi memori itu hilang jika halaman ditutup atau dimuat ulang.

### Langkah pemulihan tanpa membuang isi

Ketika muncul **Gagal menyimpan** dan **Isi belum tersimpan.**:

1. **Jangan reload atau menutup tab dahulu.** Pilih **Ekspor isi ini** dan pastikan berkas `ruang-tulis-belum-tersimpan.json` benar-benar tersimpan.
2. Jika store masih dapat ditulis, pilih **Simpan sebagai salinan** untuk membuat dokumen baru berakhiran **(salinan)**. Versi lama tidak ditimpa. Kegagalan kuota atau izin juga dapat menggagalkan langkah ini.
3. Untuk gangguan sementara, **Coba lagi** mengulang flush. Kegagalan tidak dicoba ulang otomatis oleh autosave; edit berikutnya tidak menghapus status error.
4. **Coba lagi tidak memuat ulang atau menggabungkan versi lain.** Pada konflik revisi, percobaan menggunakan revisi lama sehingga dapat gagal lagi. Setelah versi lokal aman dalam cadangan/salinan, muat ulang untuk membaca versi tersimpan terbaru dan bandingkan secara manual dengan salinan Anda.
5. Jika dokumen asal telah dihapus oleh tab lain, impor cadangan atau simpan salinan baru; tidak ada tombol undo penghapusan.

Menutup pesan **Operasi gagal.** hanya menutup pesan, bukan memperbaiki penulisan. Utamakan ekspor sebelum mencoba memperbaiki browser, menghapus dokumen untuk mengosongkan kuota, atau menutup tab lain yang juga mempunyai perubahan tertunda.

### IndexedDB tidak tersedia

Jika pembukaan database gagal, aplikasi menampilkan pesan berawalan **IndexedDB tidak tersedia:** dan daftar dapat menunjukkan **Penyimpanan tidak tersedia.** Tidak ada dokumen contoh yang dibuat jika database gagal dibaca. Tombol **Coba buka penyimpanan lagi** memuat ulang halaman; ini bukan import cadangan atau pemulihan data yang terhapus.

Periksa izin/kebijakan penyimpanan browser, mode privat, ruang tersedia, dan koneksi tab lain yang mungkin memblokir pembukaan/upgrade database. Bila diminta menutup tab lain, amankan perubahan di masing-masing tab terlebih dahulu. Detail browser/validasi dapat berbahasa Inggris, termasuk pesan kuota atau izin.

Jangan menganggap penghapusan data situs sebagai solusi aman: tindakan itu menghapus dokumen yang mungkin masih bisa diselamatkan. Jika mencoba browser/profil lain untuk diagnosis, ingat bahwa penyimpanannya berbeda dan tidak memindahkan koleksi lama.

## Penghapusan dan keamanan

**Ya, hapus dokumen** menghapus record dari IndexedDB setelah konfirmasi. Untuk dokumen aktif, aplikasi menunggu penulisan yang sedang diproses, tetapi konfirmasi penghapusan mengizinkan pembuangan setelah kegagalan simpan tertentu. Pemeriksaan revisi tetap melindungi versi yang lebih baru dari tab lain. Tidak ada keranjang sampah; riwayat urungkan editor tidak mengembalikan record yang telah dihapus.

**Membersihkan data situs/browser, menghapus profil, atau kehilangan perangkat dapat menghilangkan seluruh koleksi tanpa pemulihan dari aplikasi.** Bila database menjadi kosong, contoh yang dibuat pada startup bukan pengembalian koleksi. Cadangan eksternal yang sebelumnya Anda simpan adalah jalur pemulihan. Jangan membersihkan data sebelum memastikan seluruh bagian cadangan telah diunduh.

Aplikasi tidak menerapkan enkripsi isi IndexedDB atau cadangan, tidak meminta login, dan tidak mengelola hak akses pengguna. Jangan menganggap penyimpanan browser sebagai brankas: pihak yang mempunyai akses ke profil/perangkat atau kode yang dapat berjalan pada origin terkait berpotensi mengakses data. Perlindungan perangkat/browser berada di luar jaminan aplikasi.

Tidak ada layanan unggah/sinkronisasi dokumen dalam sumber aplikasi saat ini. Ini bukan janji isolasi jaringan: instalasi npm menggunakan registry/cache, Vite melayani aplikasi dan HMR, serta browser/ekstensi mempunyai perilakunya sendiri. Listener loopback tidak menggantikan autentikasi atau enkripsi. Gunakan cadangan dari sumber tepercaya; validasi struktur dan skema tautan tidak menjamin isi atau tujuan tautan bebas risiko.
