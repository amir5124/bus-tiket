const { query, withTransaction } = require('../config/db');
const { asyncHandler, ok, created, getPagination, buildMeta } = require('../utils/helpers');
const { toPublicUrl } = require('../middleware/upload');

/* ------------------------------------------------------------------ */
/* SEAT LAYOUT (denah kursi)                                           */
/* ------------------------------------------------------------------ */

/**
 * Buat denah kursi custom untuk vendor.
 * body: { name, grid_rows, grid_cols, cells: [{row_no,col_no,cell_type,seat_number}] }
 */
const createSeatLayout = asyncHandler(async (req, res) => {
  const { name, grid_rows, grid_cols, cells } = req.body;
  if (!name || !grid_rows || !grid_cols || !Array.isArray(cells) || !cells.length) {
    return res.status(400).json({ success: false, message: 'name, grid_rows, grid_cols, cells wajib diisi' });
  }
  const totalSeats = cells.filter((c) => c.cell_type === 'seat').length;

  const result = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO seat_layouts(vendor_id, name, total_seats, grid_rows, grid_cols)
       VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [req.vendorId, name, totalSeats, grid_rows, grid_cols]
    );
    const layout = rows[0];

    for (const c of cells) {
      await client.query(
        `INSERT INTO seat_layout_cells(layout_id, row_no, col_no, cell_type, seat_number)
         VALUES ($1,$2,$3,$4,$5)`,
        [layout.id, c.row_no, c.col_no, c.cell_type, c.cell_type === 'seat' ? c.seat_number : null]
      );
    }
    return layout;
  });

  created(res, result);
});

/** Daftar denah kursi milik vendor + template platform (vendor_id NULL) */
const listSeatLayouts = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM seat_layouts WHERE vendor_id = $1 OR vendor_id IS NULL ORDER BY id DESC`,
    [req.vendorId]
  );
  ok(res, rows);
});

/** Detail denah kursi + sel-selnya */
const getSeatLayoutDetail = asyncHandler(async (req, res) => {
  const { layoutId } = req.params;
  const { rows: layoutRows } = await query(
    `SELECT * FROM seat_layouts WHERE id = $1 AND (vendor_id = $2 OR vendor_id IS NULL)`,
    [layoutId, req.vendorId]
  );
  if (!layoutRows.length) return res.status(404).json({ success: false, message: 'Denah kursi tidak ditemukan' });

  const { rows: cellRows } = await query(
    `SELECT row_no, col_no, cell_type, seat_number FROM seat_layout_cells
     WHERE layout_id = $1 ORDER BY row_no, col_no`,
    [layoutId]
  );
  ok(res, { ...layoutRows[0], cells: cellRows });
});

/* ------------------------------------------------------------------ */
/* FACILITIES (master, read-only untuk vendor)                         */
/* ------------------------------------------------------------------ */

const listFacilities = asyncHandler(async (req, res) => {
  const { rows } = await query(`SELECT * FROM facilities ORDER BY name`);
  ok(res, rows);
});

/* ------------------------------------------------------------------ */
/* VEHICLES (ARMADA) - inti fitur "upload armada bus detail lengkap"   */
/* ------------------------------------------------------------------ */

/**
 * Vendor upload armada baru, lengkap dengan:
 * - data unit (nama, kelas, tipe, plat, merk, model, tahun, kapasitas)
 * - denah kursi (seat_layout_id, wajib sudah dibuat / pakai template)
 * - fasilitas (array facility_id)
 * body (multipart/form-data):
 *   fields: name, class_name, vehicle_type, plate_number, brand, model, year,
 *           seat_arrangement, capacity, seat_layout_id, facility_ids (JSON array atau CSV)
 *   files: photos[] (exterior/interior, multiple)
 */
const createVehicle = asyncHandler(async (req, res) => {
  const {
    name, class_name, vehicle_type, plate_number, brand, model, year,
    seat_arrangement, capacity, seat_layout_id, facility_ids,
  } = req.body;

  if (!name || !class_name || !vehicle_type || !capacity || !seat_layout_id) {
    return res.status(400).json({
      success: false,
      message: 'name, class_name, vehicle_type, capacity, seat_layout_id wajib diisi',
    });
  }

  // Validasi denah kursi milik vendor ini / template platform
  const { rows: layoutCheck } = await query(
    `SELECT id, total_seats FROM seat_layouts WHERE id = $1 AND (vendor_id = $2 OR vendor_id IS NULL)`,
    [seat_layout_id, req.vendorId]
  );
  if (!layoutCheck.length) {
    return res.status(400).json({ success: false, message: 'seat_layout_id tidak valid untuk vendor ini' });
  }

  let facilityIdList = [];
  if (facility_ids) {
    try {
      facilityIdList = typeof facility_ids === 'string'
        ? (facility_ids.trim().startsWith('[') ? JSON.parse(facility_ids) : facility_ids.split(',').map((s) => s.trim()))
        : facility_ids;
      facilityIdList = facilityIdList.filter(Boolean).map(Number);
    } catch {
      return res.status(400).json({ success: false, message: 'Format facility_ids tidak valid' });
    }
  }

  const files = req.files || [];

  const vehicle = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO vehicles(
         vendor_id, seat_layout_id, name, class_name, vehicle_type, plate_number,
         brand, model, year, seat_arrangement, capacity
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        req.vendorId, seat_layout_id, name, class_name, vehicle_type,
        plate_number || null, brand || null, model || null, year || null,
        seat_arrangement || null, capacity,
      ]
    );
    const v = rows[0];

    if (facilityIdList.length) {
      const values = facilityIdList.map((_, idx) => `($1, $${idx + 2})`).join(',');
      await client.query(
        `INSERT INTO vehicle_facilities(vehicle_id, facility_id) VALUES ${values}`,
        [v.id, ...facilityIdList]
      );
    }

    if (files.length) {
      for (let idx = 0; idx < files.length; idx++) {
        const f = files[idx];
        const kind = (req.body.photo_kinds && req.body.photo_kinds[idx]) || 'exterior';
        await client.query(
          `INSERT INTO vehicle_photos(vehicle_id, url, kind, is_cover, sort_order)
           VALUES ($1,$2,$3,$4,$5)`,
          [v.id, toPublicUrl(req, f.filename), kind, idx === 0, idx]
        );
      }
    }

    return v;
  });

  const full = await getVehicleFullById(vehicle.id);
  created(res, full);
});

/** Helper: ambil detail lengkap 1 armada (dipakai create & detail endpoint) */
async function getVehicleFullById(id) {
  const { rows: vRows } = await query(
    `SELECT v.*, sl.name AS seat_layout_name, sl.total_seats, sl.grid_rows, sl.grid_cols
     FROM vehicles v JOIN seat_layouts sl ON sl.id = v.seat_layout_id
     WHERE v.id = $1`,
    [id]
  );
  if (!vRows.length) return null;
  const vehicle = vRows[0];

  const { rows: facilities } = await query(
    `SELECT f.id, f.code, f.name, f.icon FROM vehicle_facilities vf
     JOIN facilities f ON f.id = vf.facility_id WHERE vf.vehicle_id = $1`,
    [id]
  );
  const { rows: photos } = await query(
    `SELECT id, url, kind, is_cover, sort_order FROM vehicle_photos
     WHERE vehicle_id = $1 ORDER BY sort_order`,
    [id]
  );
  const { rows: cells } = await query(
    `SELECT row_no, col_no, cell_type, seat_number FROM seat_layout_cells
     WHERE layout_id = $1 ORDER BY row_no, col_no`,
    [vehicle.seat_layout_id]
  );

  return { ...vehicle, facilities, photos, seat_map: cells };
}

/** Daftar armada milik vendor (dengan filter & pagination) */
const listMyVehicles = asyncHandler(async (req, res) => {
  const { page, limit, offset } = getPagination(req);
  const { vehicle_type, is_active, q } = req.query;

  const conds = ['v.vendor_id = $1'];
  const params = [req.vendorId];
  let i = 2;

  if (vehicle_type) { conds.push(`v.vehicle_type = $${i++}`); params.push(vehicle_type); }
  if (is_active !== undefined) { conds.push(`v.is_active = $${i++}`); params.push(is_active === 'true'); }
  if (q) { conds.push(`(v.name LIKE $${i} OR v.class_name LIKE $${i} OR v.plate_number LIKE $${i})`); params.push(`%${q}%`); i++; }

  const where = conds.join(' AND ');

  const { rows } = await query(
    `SELECT v.*, sl.name AS seat_layout_name,
            (SELECT url FROM vehicle_photos WHERE vehicle_id = v.id AND is_cover LIMIT 1) AS cover_photo
     FROM vehicles v JOIN seat_layouts sl ON sl.id = v.seat_layout_id
     WHERE ${where} ORDER BY v.created_at DESC LIMIT $${i} OFFSET $${i + 1}`,
    [...params, limit, offset]
  );
  const { rows: countRows } = await query(
    `SELECT COUNT(*) FROM vehicles v WHERE ${where}`, params
  );

  ok(res, rows, buildMeta(page, limit, countRows[0].count));
});

/** Detail 1 armada milik vendor (lengkap: fasilitas, foto, denah kursi) */
const getVehicleDetail = asyncHandler(async (req, res) => {
  const { rows: check } = await query(`SELECT id FROM vehicles WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId]);
  if (!check.length) return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });

  const full = await getVehicleFullById(req.params.id);
  ok(res, full);
});

/** Update data armada */
const updateVehicle = asyncHandler(async (req, res) => {
  const allowed = ['name', 'class_name', 'vehicle_type', 'plate_number', 'brand', 'model', 'year', 'seat_arrangement', 'capacity', 'is_active'];
  const sets = [];
  const values = [];
  let i = 1;
  for (const key of allowed) {
    if (req.body[key] !== undefined) {
      sets.push(`${key} = $${i++}`);
      values.push(req.body[key]);
    }
  }
  if (!sets.length) return res.status(400).json({ success: false, message: 'Tidak ada field untuk diupdate' });

  values.push(req.params.id, req.vendorId);
  const { rows } = await query(
    `UPDATE vehicles SET ${sets.join(', ')} WHERE id = $${i} AND vendor_id = $${i + 1} RETURNING *`,
    values
  );
  if (!rows.length) return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });
  ok(res, rows[0]);
});

/** Ganti fasilitas armada (replace all) */
const setVehicleFacilities = asyncHandler(async (req, res) => {
  const { facility_ids } = req.body;
  if (!Array.isArray(facility_ids)) return res.status(400).json({ success: false, message: 'facility_ids harus array' });

  const { rows: check } = await query(`SELECT id FROM vehicles WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId]);
  if (!check.length) return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM vehicle_facilities WHERE vehicle_id = $1`, [req.params.id]);
    if (facility_ids.length) {
      const values = facility_ids.map((_, idx) => `($1, $${idx + 2})`).join(',');
      await client.query(
        `INSERT INTO vehicle_facilities(vehicle_id, facility_id) VALUES ${values}`,
        [req.params.id, ...facility_ids]
      );
    }
  });
  const full = await getVehicleFullById(req.params.id);
  ok(res, full);
});

/** Tambah foto ke armada yang sudah ada */
const addVehiclePhotos = asyncHandler(async (req, res) => {
  const { rows: check } = await query(`SELECT id FROM vehicles WHERE id = $1 AND vendor_id = $2`, [req.params.id, req.vendorId]);
  if (!check.length) return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });

  const files = req.files || [];
  if (!files.length) return res.status(400).json({ success: false, message: 'Tidak ada file diupload' });

  const { rows: existingCount } = await query(`SELECT COUNT(*) FROM vehicle_photos WHERE vehicle_id = $1`, [req.params.id]);
  const hasCover = Number(existingCount[0].count) > 0;

  const inserted = await withTransaction(async (client) => {
    const out = [];
    for (let idx = 0; idx < files.length; idx++) {
      const f = files[idx];
      const kind = (req.body.photo_kinds && req.body.photo_kinds[idx]) || 'exterior';
      const { rows } = await client.query(
        `INSERT INTO vehicle_photos(vehicle_id, url, kind, is_cover, sort_order)
         VALUES ($1,$2,$3,$4,
           COALESCE((SELECT MAX(sort_order)+1 FROM vehicle_photos WHERE vehicle_id = $1), 0))
         RETURNING *`,
        [req.params.id, toPublicUrl(req, f.filename), kind, !hasCover && idx === 0]
      );
      out.push(rows[0]);
    }
    return out;
  });
  created(res, inserted);
});

/** Hapus foto armada */
const deleteVehiclePhoto = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `DELETE FROM vehicle_photos vp USING vehicles v
     WHERE vp.id = $1 AND vp.vehicle_id = v.id AND v.vendor_id = $2
     RETURNING vp.id`,
    [req.params.photoId, req.vendorId]
  );
  if (!rows.length) return res.status(404).json({ success: false, message: 'Foto tidak ditemukan' });
  ok(res, { deleted: true });
});

/** Set foto sampul (cover) */
const setCoverPhoto = asyncHandler(async (req, res) => {
  await withTransaction(async (client) => {
    const { rows: check } = await client.query(
      `SELECT vp.id FROM vehicle_photos vp JOIN vehicles v ON v.id = vp.vehicle_id
       WHERE vp.id = $1 AND v.vendor_id = $2 AND vp.vehicle_id = $3`,
      [req.params.photoId, req.vendorId, req.params.id]
    );
    if (!check.length) throw Object.assign(new Error('Foto tidak ditemukan'), { status: 404 });

    await client.query(`UPDATE vehicle_photos SET is_cover = FALSE WHERE vehicle_id = $1`, [req.params.id]);
    await client.query(`UPDATE vehicle_photos SET is_cover = TRUE WHERE id = $1`, [req.params.photoId]);
  });
  const full = await getVehicleFullById(req.params.id);
  ok(res, full);
});

/** Hapus armada (soft: nonaktifkan agar histori jadwal tetap valid) */
const deactivateVehicle = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `UPDATE vehicles SET is_active = FALSE WHERE id = $1 AND vendor_id = $2 RETURNING *`,
    [req.params.id, req.vendorId]
  );
  if (!rows.length) return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });
  ok(res, rows[0]);
});

module.exports = {
  createSeatLayout, listSeatLayouts, getSeatLayoutDetail,
  listFacilities,
  createVehicle, listMyVehicles, getVehicleDetail, updateVehicle,
  setVehicleFacilities, addVehiclePhotos, deleteVehiclePhoto, setCoverPhoto,
  deactivateVehicle, getVehicleFullById,
};
