# Bus & Travel Backend — Node.js + Express + MySQL2 + LinkQu

Versi ini sudah dipindahkan dari PostgreSQL `pg` ke MySQL menggunakan `mysql2/promise`.
Endpoint payment LinkQu testing/development juga ditambahkan.

## Instalasi

```bash
npm install
cp .env.example .env
# isi DB_HOST, DB_USER, DB_PASSWORD, DB_NAME
mysql -u root -p bus_travel < src/config/payment_schema.sql
npm run migrate
npm run dev
```

> `schema.sql` pada paket sumber adalah placeholder, bukan schema database lengkap. Karena itu tabel bisnis seperti `vendors`, `vehicles`, `bookings`, dll tetap harus dibuat dari schema MySQL Anda. File `payment_schema.sql` hanya menambahkan tabel `bus_payments`.

## Payment LinkQu Testing

Config default mengikuti contoh testing yang diberikan:
- base URL: `https://gateway-dev.linkqu.id/linkqu-partner`
- client-id: `testing`
- client-secret: `123`
- username: `LI307GXIN`
- pin: `2K2NPCBBNNTovgB`
- server key: `LinkQu@2020`

Simpan config di `.env`, jangan commit secret ke Git.

### Create payment
`POST /api/payments/create`

```json
{
  "booking_id": 1,
  "amount": 150000,
  "customer_name": "Budi",
  "customer_phone": "081234567890",
  "customer_email": "budi@example.com",
  "method": "QRIS"
}
```

Untuk VA:
```json
{
  "booking_id": 1,
  "amount": 150000,
  "customer_name": "Budi",
  "customer_phone": "081234567890",
  "customer_email": "budi@example.com",
  "method": "VA",
  "bank_code": "002"
}
```

### Callback
`POST /api/payments/callback`

### Polling status
`GET /api/payments/status/:reff`

Callback dan polling sama-sama mengubah `bus_payments` menjadi `SETTLED` dan mencoba mengubah `bookings.status` menjadi `paid`.

## Catatan konversi PostgreSQL → MySQL

`src/config/db.js` menyediakan compatibility layer untuk placeholder `$1`, `$2`, dst sehingga sebagian besar controller lama tidak perlu ditulis ulang seluruhnya. `ILIKE` diubah menjadi `LIKE`, cast tanggal PostgreSQL yang dipakai pencarian diadaptasi, dan `RETURNING *` untuk mutation umum diemulasikan.

Untuk produksi, sebaiknya query tetap dibersihkan menjadi native MySQL satu per satu, terutama view/function yang sebelumnya berasal dari PostgreSQL.
