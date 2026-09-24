const P = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pad = n => String(n).padStart(2, '0');

function fmtDateTime(s) {
    if (!s) return '-';
    const d = new Date(String(s).replace(' ', 'T'));
    if (isNaN(d)) return String(s);
    const DN = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
    const MN = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    return `${DN[d.getDay()]}, ${d.getDate()} ${MN[d.getMonth()]} ${d.getFullYear()} • ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function invoiceEmail(booking) {
    const passengersHtml = (booking.passengers || []).map((p, i) => `
    <tr>
      <td style="padding:8px;border-bottom:1px solid #eee">${i + 1}</td>
      <td style="padding:8px;border-bottom:1px solid #eee"><b>${esc(p.full_name)}</b></td>
      <td style="padding:8px;border-bottom:1px solid #eee">Kursi ${esc(p.seat_number)}</td>
      <td style="padding:8px;border-bottom:1px solid #eee">${esc(p.ticket_code || '-')}</td>
    </tr>
  `).join('');

    const paymentsHtml = (booking.payments || []).map(p => `
    <tr>
      <td style="padding:6px 8px;color:#666">${esc(p.payment_method || '-')}</td>
      <td style="padding:6px 8px;text-align:right;color:#666">${P(p.amount)}</td>
      <td style="padding:6px 8px;text-align:right;color:#1f9d55"><b>${esc(p.status || '-')}</b></td>
    </tr>
  `).join('');

    return `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#eef1f8;font-family:Arial,sans-serif;color:#2d2f36">
<table width="100%" cellpadding="0" cellspacing="0" style="background:#eef1f8;padding:24px 0">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.05)">

  <tr><td style="background:linear-gradient(120deg,#e03f7d,#24b3ae);padding:24px;color:#fff">
    <h1 style="margin:0;font-size:22px">🚌 E-Ticket & Invoice</h1>
    <p style="margin:6px 0 0;opacity:.9;font-size:14px">Terima kasih, pembayaran Anda telah kami terima.</p>
  </td></tr>

  <tr><td style="padding:24px">
    <table width="100%">
      <tr>
        <td valign="top">
          <div style="font-size:12px;color:#8a8f9c;text-transform:uppercase">Kode Booking</div>
          <div style="font-size:22px;font-weight:700;letter-spacing:1px">${esc(booking.booking_code)}</div>
        </td>
        <td align="right" valign="top">
          <span style="display:inline-block;background:#e4f7ec;color:#1f9d55;padding:6px 12px;border-radius:6px;font-weight:700;font-size:13px">LUNAS</span>
        </td>
      </tr>
      <tr><td colspan="2" style="padding-top:12px;font-size:13px;color:#666">
        Order ID: <b>${esc(booking.order_no || '-')}</b> • Dibayar: <b>${fmtDateTime(booking.paid_at)}</b>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="padding:0 24px 16px">
    <div style="background:#f6f8fc;border-radius:10px;padding:16px">
      <div style="font-weight:700;font-size:16px;margin-bottom:6px">${esc(booking.origin_city)} → ${esc(booking.destination_city)}</div>
      <div style="color:#666;font-size:13px">${esc(booking.vendor_name || '')} • ${esc(booking.class_name || '')}</div>
      <table width="100%" style="margin-top:12px;font-size:13px">
        <tr>
          <td><span style="color:#666">Berangkat</span><br><b>${fmtDateTime(booking.departure_at)}</b></td>
          <td align="right"><span style="color:#666">Tiba</span><br><b>${fmtDateTime(booking.arrival_at)}</b></td>
        </tr>
      </table>
    </div>
  </td></tr>

  <tr><td style="padding:0 24px 16px">
    <div style="font-weight:700;font-size:15px;margin-bottom:8px">Penumpang</div>
    <table width="100%" style="font-size:13px;border-collapse:collapse">
      <thead>
        <tr style="background:#f6f8fc">
          <th align="left" style="padding:8px">#</th>
          <th align="left" style="padding:8px">Nama</th>
          <th align="left" style="padding:8px">Kursi</th>
          <th align="left" style="padding:8px">Tiket</th>
        </tr>
      </thead>
      <tbody>${passengersHtml}</tbody>
    </table>
  </td></tr>

  <tr><td style="padding:0 24px 16px">
    <div style="font-weight:700;font-size:15px;margin-bottom:8px">Pembayaran</div>
    <table width="100%" style="font-size:13px;border-collapse:collapse">
      ${paymentsHtml}
      <tr>
        <td style="padding:12px 8px;border-top:2px solid #eee"><b>Total Dibayar</b></td>
        <td></td>
        <td style="padding:12px 8px;border-top:2px solid #eee;text-align:right"><b style="color:#e5484d;font-size:16px">${P(booking.total_amount)}</b></td>
      </tr>
    </table>
  </td></tr>

  <tr><td style="padding:0 24px 24px">
    <div style="background:#fff3cd;border:1px solid #ffeeba;border-radius:8px;padding:12px;font-size:13px;color:#856404">
      📌 Tunjukkan e-ticket ini ke petugas sebelum naik. Siapkan kartu identitas (KTP/SIM/Paspor) untuk verifikasi.
    </div>
  </td></tr>

  <tr><td style="background:#f6f8fc;padding:16px 24px;font-size:12px;color:#8a8f9c;text-align:center">
    Email ini dikirim otomatis. Jangan balas. Butuh bantuan? hubungi <a href="mailto:cs@siappgo.id" style="color:#24b3ae">cs@siappgo.id</a>.
    <br>© ${new Date().getFullYear()} Bus & Travel — siappgo.id
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

module.exports = { invoiceEmail, fmtDateTime, P };