# Panduan penggunaan

[README](../README.md) · [Penyimpanan dan pemulihan](penyimpanan.md) · [Pengembangan](pengembangan.md)

## Memulai dan mengelola dokumen

Jalankan aplikasi mengikuti [mulai cepat](../README.md#mulai-cepat), lalu gunakan `http://127.0.0.1:5173/` dengan browser/profil yang sama setiap kali. Ketika database kosong, aplikasi membuat **Dokumen contoh**. Ini contoh awal, bukan pemulihan dokumen yang telah hilang.

- **Buat:** pilih **Dokumen baru**. Jika layar kosong ditampilkan, gunakan **Buat dokumen pertama**. Dokumen baru bernama **Dokumen tanpa judul**.
- **Buka:** pilih dokumen pada **DOKUMEN SAYA**. Pada layar kecil, tombol **Buka atau tutup daftar dokumen** menampilkan daftar. Perpindahan ke dokumen lain menunggu perubahan aktif tersimpan; jika penyimpanan gagal, perpindahan dibatalkan.
- **Ubah nama:** edit kolom di bawah **DOKUMEN · UBAH NAMA**. Judul dibatasi 200 karakter; judul kosong kembali menjadi **Dokumen tanpa judul**.
- **Cari judul:** gunakan **Cari dokumen...** di sidebar. Filter **Semua dokumen** atau **Diubah hari ini** membatasi daftar; daftar diurutkan berdasarkan waktu perubahan terbaru. Ini berbeda dari pencarian isi dokumen.
- **Hapus:** gunakan ikon tempat sampah pada dokumen, baca dialog **Hapus dokumen?**, lalu pilih **Batal** atau **Ya, hapus dokumen**. **Penghapusan tidak dapat dibatalkan dan dapat membuang perubahan yang belum tersimpan. Ekspor cadangan terlebih dahulu jika salinan masih diperlukan.**

Saat dibuka kembali, aplikasi mencoba memilih dokumen yang identitasnya diingat di browser. Jika pilihan tidak tersedia, aplikasi memakai record pertama dari database, bukan selalu dokumen yang paling baru diubah. Hanya data yang sudah tersimpan yang dapat dibuka kembali; tidak ada pemulihan otomatis untuk perubahan yang hilang sebelum tersimpan.

## Menulis dan menyimpan

Klik area **Isi dokumen**, lalu mulai mengetik. Perubahan isi dan judul memicu autosave setelah jeda sekitar **700 ms**. Indikator menunjukkan:

- **Menyimpan…**: perubahan sedang menunggu atau sedang ditulis.
- **Tersimpan di browser**: perubahan sesi sudah berhasil ditulis ke IndexedDB.
- **Gagal menyimpan**: versi editor belum aman di penyimpanan; gunakan tindakan pemulihan.

**Ctrl/⌘ S** meminta penyimpanan segera, bukan unduhan berkas. Tunggu **Tersimpan di browser** sebelum menutup tab. Peringatan browser saat ada perubahan tertunda bukan jaminan bahwa penutupan akan menyimpan data.

Riwayat **Urungkan** dan **Ulangi** berlaku pada dokumen yang sedang dibuka dan direset ketika berpindah dokumen. Penghitungan kata dan karakter tampil di bagian bawah; karakter mencakup spasi. Label **Bahasa Indonesia** bukan fitur pemeriksaan tata bahasa khusus; pemeriksaan ejaan menggunakan kemampuan browser.

## Pemformatan

Pilih teks atau tempatkan kursor pada paragraf, lalu gunakan toolbar **Format dokumen**:

| Alat | Penggunaan |
| --- | --- |
| **Gaya paragraf** | Pilih **Teks normal**, **Judul 1**, **Judul 2**, atau **Judul 3**. |
| **Tebal**, **Miring**, **Garis bawah**, **Coret** | Mengubah format teks. |
| **Daftar poin**, **Daftar bernomor** | Membuat atau membatalkan daftar. |
| **Kurangi inden**, **Tambah inden** | Mengubah tingkat item daftar; di luar daftar mengubah inden paragraf/judul. Inden paragraf maksimal delapan tingkat, masing-masing 24 px. |
| **Rata kiri**, **Rata tengah**, **Rata kanan** | Mengatur perataan paragraf dan judul. Tidak ada tombol rata penuh. |
| **Hapus format** | Menghapus mark teks, mengembalikan gaya node, dan mereset perataan/inden. |
| **Urungkan**, **Ulangi** | Membatalkan atau mengulang perubahan editor. |

Judul 1–3 muncul di **KERANGKA**. Klik judul dalam kerangka untuk memindahkan kursor ke bagian itu. Menekan Enter pada akhir judul di luar daftar membuat paragraf teks normal.

### Tautan

1. Pilih teks, lalu klik **Sisipkan atau ubah tautan**.
2. Isi kolom **Tautan** dengan alamat `http://`, `https://`, atau `mailto:`.
3. Pilih **Terapkan**, **Hapus tautan**, atau **Tutup**.

Skema lain ditolak dengan pesan **Tautan harus memakai http://, https://, atau mailto:.** Klik tautan di area editor tidak melakukan navigasi agar penyuntingan tidak meninggalkan halaman. Validasi skema bukan pemeriksaan reputasi atau keamanan situs tujuan.

### Gambar lokal

Tempatkan kursor, pilih **Sisipkan gambar lokal**, lalu pilih berkas **PNG, JPEG, GIF, atau WebP**. Batas berkas adalah **2 MiB** (pesan UI menyebut **2 MB**); SVG dan URL gambar jarak jauh tidak didukung. Gambar diperiksa sebelum dimasukkan, termasuk kemampuan browser mendekode gambar, dimensi maksimal 10.000 px per sisi, dan maksimal 40 juta piksel.

Gambar disimpan sebagai data URL base64 di dalam dokumen dan cadangan, bukan sebagai referensi ke berkas asal. Gambar besar dapat memenuhi batas dokumen atau kuota browser. Jika muncul **Gambar akan melebihi batas dokumen 12 MB. Gunakan gambar lebih kecil.**, perkecil gambar dan coba lagi. Jika dokumen tujuan berubah ketika pemilih berkas terbuka, pilih kembali gambar pada dokumen yang benar.

### Tabel

Buka **Menu tabel**, lalu pilih **Sisipkan tabel 3 × 3**. Tabel awal mempunyai baris header. Letakkan kursor di sel yang relevan untuk memakai **+ Baris**, **+ Kolom**, **Hapus baris**, **Hapus kolom**, atau **Hapus tabel**. Tombol yang tidak berlaku akan dinonaktifkan. Tidak ada antarmuka untuk menggabungkan/memisahkan sel atau menyeret ukuran kolom.

## Cari dan ganti isi

1. Klik **Cari dan ganti (Ctrl/⌘ F)** atau tekan **Ctrl/⌘ F** ketika dokumen terbuka.
2. Masukkan teks di **Cari**. Pencarian bersifat literal, tidak membedakan huruf besar/kecil, dan tidak menggunakan regex.
3. Gunakan **Hasil sebelumnya** / **Hasil berikutnya**, atau Enter / Shift+Enter pada kolom **Cari**.
4. Isi **Ganti**, lalu pilih **Ganti satu** atau **Ganti semua**. Kolom pengganti dibatasi 10.000 karakter.

Pencarian hanya mencakup dokumen aktif, bukan seluruh koleksi. Pencocokan dilakukan dalam blok teks, bukan melintasi paragraf. Pencarian dan penggantian tidak melintasi node inline nonteks, termasuk pemisah baris manual; teks yang terpisah oleh node tersebut tidak menjadi satu hasil pencarian. Format teks pengganti mengikuti karakter pertama yang cocok. Escape pada kolom **Cari** menutup panel.

## Tema tampilan

Pada pilihan **Tema tampilan** di header, pilih **Terang**, **Gelap**, atau **Ikuti sistem**. Pilihan awal mengikuti sistem. Preferensi disimpan terpisah dari dokumen dan dapat berubah mengikuti pilihan dari tab lain pada origin yang sama.

Jika tampil **Preferensi tema tidak dapat disimpan di browser ini. Pilihan tema hanya berlaku untuk sesi ini.**, tema masih dapat digunakan selama sesi tersebut. Pemberitahuan ini tidak berarti isi dokumen ikut gagal disimpan. Cetak menggunakan warna terang, terlepas dari tema layar.

## Pintasan keyboard

Gunakan **Ctrl** pada Windows/Linux dan **⌘** pada macOS. Pintasan format/riwayat bekerja ketika fokus berada di editor.

| Pintasan | Tindakan dan konteks |
| --- | --- |
| **Ctrl/⌘ S** | Meminta simpan segera; bukan dialog Save Page. Tidak menjalankan flush saat operasi aplikasi sedang sibuk. |
| **Ctrl/⌘ F** | Membuka pencarian dan memfokuskan kolom **Cari** ketika ada dokumen aktif. |
| **Ctrl/⌘ P** | Membuka dialog cetak browser ketika ada dokumen aktif. |
| **Ctrl/⌘ Z** | Urungkan. |
| **Ctrl/⌘ Shift Z** | Ulangi. |
| **Ctrl/⌘ B** | Tebal. |
| **Ctrl/⌘ I** | Miring. |
| **Ctrl/⌘ U** | Garis bawah. |
| **Ctrl/⌘ ]**, **Ctrl/⌘ [** | Tambah/kurangi inden paragraf atau judul; berbeda dari tombol toolbar yang juga menangani tingkat item daftar. |
| **Enter** pada akhir judul di luar daftar | Membuat paragraf teks normal. |
| **Enter**, **Shift+Enter** pada kolom **Cari** | Hasil berikutnya/sebelumnya. |
| **Escape** pada kolom **Cari** | Menutup panel pencarian. |
| **Escape** pada dialog hapus | Membatalkan dialog bila operasi tidak sedang sibuk. |
| **Tab / Shift+Tab** pada dialog hapus | Berpindah antar-tombol dalam dialog. |

Daftar ini mencakup pintasan aplikasi dan pintasan pemformatan yang ditampilkan toolbar; bukan daftar seluruh keymap bawaan Tiptap atau browser.

## Impor dan ekspor Microsoft Word (.docx)

Format pertukaran utama adalah **DOCX / Office Open XML**, yaitu format dokumen Word modern. Google Docs memakai format internalnya sendiri dan mendukung DOCX untuk impor/ekspor. Mengganti nama berkas cadangan menjadi `.docx` tidak menghasilkan dokumen Word yang valid.

### Mengimpor dokumen Word

1. Pilih **Impor Word (.docx)** di sidebar.
2. Pilih berkas `.docx`, maksimal **12 MiB**.
3. Tunggu konversi dan validasi selesai. Dokumen diimpor sebagai **dokumen baru**; dokumen lama tidak ditimpa.
4. Periksa isi dan pemberitahuan konversi sebelum menyunting.

Impor menunggu dokumen aktif tersimpan. Jika penyimpanan aktif gagal, amankan isi melalui cadangan atau salinan terlebih dahulu. Berkas yang rusak, terenkripsi, mengandung makro, atau tidak sesuai paket DOCX ditolak. Format `.doc` lama dan `.docm` tidak didukung.

Impor menerima paket DOCX Transitional dengan jalur utama `word/document.xml`, seperti keluaran Word/Google Docs yang umum. Varian Strict OOXML, ZIP64, paket multi-disk, objek OLE/ActiveX, dan berkas dengan struktur arsip ambigu tidak didukung. Batas arsip: 32 MiB setelah ekspansi, 8 MiB per bagian, dan 2.048 entri; batas konten/gambar editor tetap berlaku.

### Mengekspor dokumen Word

Pilih **Unduh Word (.docx)** pada header. Aplikasi menghasilkan paket DOCX asli dengan isi dokumen aktif, termasuk perubahan lokal yang belum tersimpan. Ekspor tidak membutuhkan penulisan IndexedDB yang berhasil, tetapi konversi tetap dapat gagal jika isi atau gambar tidak valid.

Berkas dapat dipakai untuk pertukaran dengan Word atau diimpor ke Google Docs. Konversi tidak menjamin pagination, font, ukuran teks, warna, header/footer, komentar, atau tracked changes identik dengan sumber. Fitur yang tidak tersedia di editor dapat disederhanakan atau hilang; periksa hasilnya. Gunakan cadangan aplikasi untuk pemulihan struktur dan metadata secara lengkap.

Gambar WebP diubah menjadi PNG saat ekspor agar dapat dibaca Word; hasil konversi masih harus memenuhi batas gambar. Animasi GIF dapat tampil sebagai gambar diam pada aplikasi pembaca. Footnote, endnote, dan komentar tidak menjadi fitur editor yang dapat disunting dan dapat dihilangkan saat impor.

## Cadangan dan impor

### Menyimpan salinan di luar browser

- **Unduh cadangan** pada header: mengunduh dokumen aktif sebagai `ruang-tulis-dokumen.json`, termasuk snapshot perubahan yang belum tersimpan.
- **Cadangkan semua dokumen** pada sidebar: membaca koleksi tersimpan. Jika dokumen aktif belum tersimpan, ekspor juga menyertakan salinan tambahan berjudul dengan akhiran **(belum tersimpan)**, bukan menimpa versi database.
- Jika koleksi muat dalam satu berkas, hasilnya `ruang-tulis-semua.json`. Jika dibagi, panel **Unduh semua bagian untuk cadangan lengkap.** menyediakan tombol **Bagian 1 · … dokumen**, dan seterusnya. **Klik dan simpan setiap bagian**; satu bagian saja bukan cadangan lengkap. Nama berkasnya `ruang-tulis-bagian-1.json`, dan seterusnya.

Per berkas cadangan dibatasi **12 MiB** dan **100 dokumen**. Berkas cadangan tidak dienkripsi dan dapat memuat data pribadi. Periksa berkas benar-benar tersimpan oleh browser, lalu simpan salinan di tempat aman.

### Mengembalikan dari cadangan

Pilih **Impor cadangan**, lalu berkas cadangan Ruang Tulis versi 1. Aplikasi memvalidasi seluruh berkas dan gambar sebelum menambahkan dokumen. Dokumen masuk sebagai **salinan baru** dengan identitas baru; dokumen lama tidak ditimpa. Dokumen pertama hasil impor dibuka. Untuk cadangan terbagi, impor setiap bagian satu per satu. Impor ulang membuat salinan tambahan, bukan pembaruan atau deduplikasi otomatis.

Berkas rusak, versi/format lain, gambar tidak valid, atau berkas terlalu besar dapat ditolak melalui **Operasi gagal.** Detail validasi tertentu masih berbahasa Inggris. Berkas DOCX harus dibuka melalui **Impor Word (.docx)**, bukan **Impor cadangan**; mengganti ekstensi berkas tidak mengubah formatnya.

## Gagal menyimpan atau konflik antar-tab

Jika tampil **Isi belum tersimpan.**, jangan langsung reload atau menutup tab. Versi Anda masih berada di editor:

1. Pilih **Ekspor isi ini** untuk mengunduh `ruang-tulis-belum-tersimpan.json`.
2. Jika IndexedDB masih dapat ditulis, **Simpan sebagai salinan** membuat dokumen baru berakhiran **(salinan)** tanpa menimpa versi lama.
3. **Coba lagi** mengulang penulisan. Ini dapat membantu kegagalan sementara, tetapi tidak menggabungkan atau memuat ulang perubahan tab lain. Konflik revisi tetap dapat gagal.

Baca [pemulihan penyimpanan](penyimpanan.md#konflik-dan-kegagalan-penyimpanan) sebelum reload, membersihkan data browser, atau mencoba tindakan yang membuang perubahan.

## Cetak dan PDF: batasan

Klik **Cetak / PDF** atau tekan **Ctrl/⌘ P**. Aplikasi memanggil dialog cetak browser; pilih **Simpan sebagai PDF** jika browser/sistem menyediakan tujuan tersebut.

Gaya cetak meminta ukuran A4, menyembunyikan toolbar/sidebar, memakai warna terang, dan mengatur margin atas/kiri/kanan 18 mm serta bawah 20 mm. Hasil akhir bergantung pada browser, font yang tersedia, skala, margin, header/footer cetak, dan printer. Tampilan editor bukan pratinjau pagination yang menjamin hasil identik. Periksa pratinjau cetak, khususnya tabel dan gambar panjang. Font Libre Baskerville/DM Sans disebut dalam CSS tetapi tidak diunduh oleh halaman; font pengganti dapat mengubah tata letak.

PDF adalah keluaran cetak, **bukan cadangan yang dapat diimpor kembali untuk menyunting dokumen**. Untuk pertukaran Word gunakan fitur DOCX; untuk pemulihan aplikasi gunakan cadangan. Tidak ada kolaborasi waktu nyata, akun, login, atau sinkronisasi cloud. Membuka dokumen yang sama pada dua tab tidak menjadikannya sesi kolaborasi.
