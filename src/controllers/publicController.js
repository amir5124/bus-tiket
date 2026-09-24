const { query } = require('../config/db');
const { asyncHandler, ok, getPagination, buildMeta } = require('../utils/helpers');

/** Daftar kota (untuk dropdown asal/tujuan) */
const listCities = asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM cities ORDER BY is_popular DESC, sort_order, name`);
  ok(res, rows);
});

/** Daftar fasilitas master (untuk filter pencarian) */
const listFacilities = asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM facilities ORDER BY name`);
  ok(res, rows);
});

/**
 * Pencarian jadwal (halaman hasil pencarian tiket).
 * query: origin_city_id, destination_city_id, depart_date (YYYY-MM-DD),
 *        seats, vehicle_type, sort=price_asc|price_desc|earliest
 */
const searchSchedules = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPagination(req);
  const {
    origin_city_id, destination_city_id, depart_date, seats,
    vehicle_type, sort = 'earliest',
  } = req.query;

  if (!origin_city_id || !destination_city_id || !depart_date) {
    return res.status(400).json({
      success: false,
      message: 'origin_city_id, destination_city_id, depart_date wajib diisi',
    });
  }

  const conds = [
    `s.origin_city = (SELECT name FROM cities WHERE id = $1)`,
    `s.destination_city = (SELECT name FROM cities WHERE id = $2)`,
    `DATE(s.departure_at) = $3`,
  ];
  const params = [origin_city_id, destination_city_id, depart_date];
  let i = 4;

  if (seats) { conds.push(`s.seats_available >= $${i++}`); params.push(Number(seats)); }
  if (vehicle_type) { conds.push(`s.vehicle_type = $${i++}`); params.push(vehicle_type); }

  const where = conds.join(' AND ');
  const orderBy = {
    price_asc: 's.price ASC',
    price_desc: 's.price DESC',
    earliest: 's.departure_at ASC',
  }[sort] || 's.departure_at ASC';

  // Log pencarian untuk analitik admin (best-effort, tidak menggagalkan request)
  query(
    `INSERT INTO search_logs(user_id, origin_city_id, destination_city_id, depart_date, seats)
     VALUES ($1,$2,$3,$4,$5)`,
    [req.user?.id || null, origin_city_id, destination_city_id, depart_date, seats || null]
  ).catch((e) => console.error('[search_logs] gagal mencatat:', e.message));

  const { rows } = await query(
    `SELECT * FROM v_schedule_search s WHERE ${where} ORDER BY ${orderBy} LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM v_schedule_search s WHERE ${where}`, params
  );

  ok(res, rows, buildMeta(page, limit, countRows[0].count));
});

/** Detail 1 jadwal: armada lengkap, fasilitas, denah kursi, kursi terisi, T&C */
const getScheduleDetail = asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM v_schedule_search WHERE schedule_id = $1`, [req.params.id]);
  if (!rows.length) return res.status(404).json({ success: false, message: 'Jadwal tidak ditemukan' });
  const schedule = rows[0];

  const { rows: scheduleFull } = await query(
    `SELECT s.*, veh.id AS vehicle_id FROM schedules s JOIN vehicles veh ON veh.id = s.vehicle_id WHERE s.id = $1`,
    [req.params.id]
  );
  const vehicleId = scheduleFull[0].vehicle_id;

  const { rows: facilities } = await query(
    `SELECT f.id, f.code, f.name, f.icon FROM vehicle_facilities vf
     JOIN facilities f ON f.id = vf.facility_id WHERE vf.vehicle_id = $1`,
    [vehicleId]
  );
  const { rows: photos } = await query(
    `SELECT url, kind, is_cover FROM vehicle_photos WHERE vehicle_id = $1 ORDER BY sort_order`,
    [vehicleId]
  );
  const { rows: seats } = await query(
    `SELECT seat_number, status FROM schedule_seats WHERE schedule_id = $1 ORDER BY seat_number`,
    [req.params.id]
  );
  const { rows: seatMap } = await query(
    `SELECT slc.row_no, slc.col_no, slc.cell_type, slc.seat_number
     FROM schedules s JOIN vehicles v ON v.id = s.vehicle_id
     JOIN seat_layout_cells slc ON slc.layout_id = v.seat_layout_id
     WHERE s.id = $1 ORDER BY slc.row_no, slc.col_no`,
    [req.params.id]
  );
  const { rows: terms } = await query(
    `SELECT section, items, sort_order FROM schedule_terms WHERE schedule_id = $1 ORDER BY sort_order`,
    [req.params.id]
  );
  let insurance = null;
  if (schedule.insurance_available) {
    const { rows: ins } = await query(
      `SELECT ip.* FROM schedules s JOIN insurance_products ip ON ip.id = s.insurance_product_id WHERE s.id = $1`,
      [req.params.id]
    );
    insurance = ins[0] || null;
  }

  ok(res, { ...schedule, facilities, photos, seats, seat_map: seatMap, terms, insurance });
});

/** Profil publik vendor (untuk halaman "tentang vendor") */
const getVendorPublicProfile = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT vendor_id, code, vendor_name, rating_avg FROM v_vendor_profile WHERE vendor_id = $1 AND status = 'active'`,
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ success: false, message: 'Vendor tidak ditemukan' });

  const { rows: vehicles } = await query(
    `SELECT v.id, v.name, v.class_name, v.vehicle_type,
            (SELECT url FROM vehicle_photos WHERE vehicle_id = v.id AND is_cover LIMIT 1) AS cover_photo
     FROM vehicles v WHERE v.vendor_id = $1 AND v.is_active ORDER BY v.name`,
    [req.params.id]
  );

  ok(res, { ...rows[0], vehicles });
});

module.exports = {
  listCities, listFacilities, searchSchedules, getScheduleDetail, getVendorPublicProfile,
};
