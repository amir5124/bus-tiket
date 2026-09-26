const { query, withTransaction } = require('../config/db');
const { asyncHandler, ok, created, getPagination, buildMeta } = require('../utils/helpers');
const path = require('path');
const fs = require('fs');
const { toPublicUrl, UPLOAD_DIR } = require('../middleware/upload');

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
    // MySQL: tidak ada RETURNING, pakai insertId
    const r = await client.query(
      `INSERT INTO seat_layouts(vendor_id, name, total_seats, grid_rows, grid_cols)
       VALUES (?, ?, ?, ?, ?)`,
      [req.vendorId, name, totalSeats, grid_rows, grid_cols]
    );
    const layoutId = r.insertId;

    for (const c of cells) {
      await client.query(
        `INSERT INTO seat_layout_cells(layout_id, row_no, col_no, cell_type, seat_number)
         VALUES (?, ?, ?, ?, ?)`,
        [
          layoutId, c.row_no, c.col_no, c.cell_type,
          c.cell_type === 'seat' ? c.seat_number : null,
        ]
      );
    }

    // Ambil row setelah insert
    const { rows } = await client.query(`SELECT * FROM seat_layouts WHERE id = ? LIMIT 1`, [layoutId]);
    return rows[0];
  });

  created(res, result);
});

/** Daftar denah kursi milik vendor + template platform (vendor_id NULL) */
const listSeatLayouts = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT * FROM seat_layouts
      WHERE vendor_id = ? OR vendor_id IS NULL
      ORDER BY id DESC`,
    [req.vendorId]
  );
  ok(res, rows);
});

/** Detail denah kursi + sel-selnya */
const getSeatLayoutDetail = asyncHandler(async (req, res) => {
  const { layoutId } = req.params;
  const { rows: layoutRows } = await query(
    `SELECT * FROM seat_layouts
      WHERE id = ? AND (vendor_id = ? OR vendor_id IS NULL)`,
    [layoutId, req.vendorId]
  );
  if (!layoutRows.length) {
    return res.status(404).json({ success: false, message: 'Denah kursi tidak ditemukan' });
  }

  const { rows: cellRows } = await query(
    `SELECT row_no, col_no, cell_type, seat_number
       FROM seat_layout_cells
      WHERE layout_id = ?
      ORDER BY row_no, col_no`,
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
/* VEHICLES (ARMADA)                                                   */
/* ------------------------------------------------------------------ */

/**
 * Helper: resolve seat_layout_id.
 * Kalau ID yang dikirim merujuk ke `seat_layout_templates` → auto-copy
 * template ke `seat_layouts` + `seat_layout_cells` untuk vendor itu.
 * Kalau ID sudah merujuk ke `seat_layouts` milik vendor → pakai langsung.
 *
 * @returns {Promise<number>} finalLayoutId
 * @throws Error dengan `.status` untuk validasi
 */
async function resolveSeatLayoutId(vendorId, seatLayoutId) {
  const { rows: tplRows } = await query(
    `SELECT id, name, vehicle_type, total_seats,
            \`rows\` AS row_count, cols, grid
       FROM seat_layout_templates
      WHERE id = ? AND is_active = 1 LIMIT 1`,
    [seatLayoutId]
  );

  if (tplRows.length) {
    const tpl = tplRows[0];
    let grid = tpl.grid;
    if (typeof grid === 'string') {
      try { grid = JSON.parse(grid); } catch (e) { grid = []; }
    }

    const newLayoutId = await withTransaction(async (client) => {
      const r1 = await client.query(
        `INSERT INTO seat_layouts
           (vendor_id, name, total_seats, grid_rows, grid_cols, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [vendorId, `${tpl.name} (auto)`, tpl.total_seats, tpl.row_count || 0, tpl.cols || 0]
      );
      const layoutId = r1.insertId;

      const cells = [];
      for (const row of (grid || [])) {
        const rowNo = Number(row.row) || 1;
        const rowCells = row.cells || [];
        for (let c = 0; c < rowCells.length; c++) {
          const cell = rowCells[c];
          const colNo = c + 1;
          if (cell === 'driver') cells.push([layoutId, rowNo, colNo, 'driver', null]);
          else if (cell === 'empty' || cell == null || cell === '') cells.push([layoutId, rowNo, colNo, 'empty', null]);
          else cells.push([layoutId, rowNo, colNo, 'seat', String(cell)]);
        }
      }

      if (cells.length) {
        const placeholders = cells.map(() => '(?, ?, ?, ?, ?)').join(', ');
        await client.query(
          `INSERT INTO seat_layout_cells
             (layout_id, row_no, col_no, cell_type, seat_number)
           VALUES ${placeholders}`,
          cells.flat()
        );
      }

      return layoutId;
    });

    return { layoutId: newLayoutId, templateId: tpl.id };
  }

  const { rows: ownRows } = await query(
    `SELECT id FROM seat_layouts WHERE id = ? AND vendor_id = ? LIMIT 1`,
    [seatLayoutId, vendorId]
  );
  if (ownRows.length) return { layoutId: ownRows[0].id, templateId: null };

  const err = new Error('Denah kursi tidak ditemukan');
  err.status = 404;
  throw err;
}
/**
 * Vendor upload armada baru.
 */
const createVehicle = asyncHandler(async (req, res) => {
  const vendorId = Number(req.vendorId);

  const {
    name, class_name, vehicle_type, plate_number,
    brand, model, year, seat_arrangement, capacity,
    seat_layout_id, is_active,
  } = req.body;

  // Bersihkan file kalau validasi gagal
  const cleanupFiles = () => {
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) { } });
  };

  // Validasi
  if (!name || !class_name || !vehicle_type || !capacity || !seat_layout_id) {
    cleanupFiles();
    return res.status(400).json({
      success: false,
      message: 'name, class_name, vehicle_type, capacity, seat_layout_id wajib diisi',
    });
  }

  // Facilities dari FormData
  const rawFac = req.body['facility_ids[]'] ?? req.body.facility_ids ?? [];
  const facilityIds = Array.isArray(rawFac) ? rawFac : [rawFac];

  // Resolve layout (auto-copy template kalau perlu)
  // Resolve layout (auto-copy template kalau perlu)
  let finalLayoutId;
  let finalTemplateId = null;
  try {
    const resolved = await resolveSeatLayoutId(vendorId, Number(seat_layout_id));
    finalLayoutId = resolved.layoutId;
    finalTemplateId = resolved.templateId;
  } catch (e) {
    cleanupFiles();
    return res.status(e.status || 500).json({ success: false, message: e.message });
  }

  const result = await withTransaction(async (client) => {
    // 1. Insert vehicle
    const r = await client.query(
      `INSERT INTO vehicles
         (vendor_id, seat_layout_id, seat_layout_template_id, name, class_name, vehicle_type,
          plate_number, brand, model, year, seat_arrangement,
          capacity, is_active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        vendorId, finalLayoutId, finalTemplateId, name, class_name, vehicle_type,
        plate_number || null, brand || null, model || null,
        year ? Number(year) : null, seat_arrangement || null,
        Number(capacity), is_active === '0' || is_active === 0 ? 0 : 1,
      ]
    );
    const vehicleId = r.insertId;

    // 2. Facilities
    for (const fid of facilityIds) {
      if (!fid) continue;
      await client.query(
        `INSERT INTO vehicle_facilities (vehicle_id, facility_id) VALUES (?, ?)`,
        [vehicleId, Number(fid)]
      );
    }

    // 3. Photos
    const files = req.files || [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const url = toPublicUrl(req, file.filename, 'vehicles');
      const isCover = i === 0 ? 1 : 0;

      await client.query(
        `INSERT INTO vehicle_photos (vehicle_id, url, kind, is_cover, sort_order)
         VALUES (?, ?, 'exterior', ?, ?)`,
        [vehicleId, url, isCover, i]
      );
    }

    return { id: vehicleId };
  });

  const fullVehicle = await getVehicleFullById(result.id);
  created(res, fullVehicle);
});

/** Helper: ambil detail lengkap 1 armada */
async function getVehicleFullById(vehicleId) {
  const { rows: vehicles } = await query(
    `SELECT v.*, vd.name AS vendor_name
       FROM vehicles v
       JOIN vendors vd ON vd.id = v.vendor_id
      WHERE v.id = ? LIMIT 1`,
    [vehicleId]
  );
  if (!vehicles.length) return null;
  const vehicle = vehicles[0];

  // Photos
  const { rows: photos } = await query(
    `SELECT id, url, kind, is_cover, sort_order
       FROM vehicle_photos
      WHERE vehicle_id = ?
      ORDER BY is_cover DESC, sort_order, id`,
    [vehicleId]
  );
  vehicle.photos = photos;
  vehicle.cover_photo = photos.find(p => p.is_cover)?.url || photos[0]?.url || null;

  // Facilities
  const { rows: facilities } = await query(
    `SELECT f.id, f.code, f.name, f.icon
       FROM vehicle_facilities vf
       JOIN facilities f ON f.id = vf.facility_id
      WHERE vf.vehicle_id = ?`,
    [vehicleId]
  );
  vehicle.facilities = facilities;
  vehicle.facility_ids = facilities.map(f => f.id);

  // Seat layout
  // Seat layout
  const { rows: layout } = await query(
    `SELECT id, name, total_seats, grid_rows, grid_cols
         FROM seat_layouts WHERE id = ? LIMIT 1`,
    [vehicle.seat_layout_id]
  );
  vehicle.seat_layout = layout[0] || null;
  vehicle.seat_layout_template_id = vehicle.seat_layout_template_id || null;

  return vehicle;
}

/** Daftar armada milik vendor */
const listMyVehicles = asyncHandler(async (req, res) => {
  const { rows } = await query(
    `SELECT v.*,
            (SELECT url FROM vehicle_photos
              WHERE vehicle_id = v.id AND is_cover = 1
              LIMIT 1) AS cover_photo,
            (SELECT COUNT(*) FROM vehicle_photos WHERE vehicle_id = v.id) AS photo_count
       FROM vehicles v
      WHERE v.vendor_id = ?
      ORDER BY v.created_at DESC`,
    [req.vendorId]
  );
  ok(res, rows);
});

/** Detail 1 armada milik vendor */
const getVehicleDetail = asyncHandler(async (req, res) => {
  const { rows: check } = await query(
    `SELECT id FROM vehicles WHERE id = ? AND vendor_id = ?`,
    [req.params.id, req.vendorId]
  );
  if (!check.length) {
    return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });
  }

  const full = await getVehicleFullById(req.params.id);
  ok(res, full);
});

/** Update data armada */
const updateVehicle = asyncHandler(async (req, res) => {
  const vendorId = Number(req.vendorId);
  const vehicleId = Number(req.params.id);

  const { rows: existing } = await query(
    `SELECT id FROM vehicles WHERE id = ? AND vendor_id = ? LIMIT 1`,
    [vehicleId, vendorId]
  );
  if (!existing.length) {
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) { } });
    return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });
  }

  // Kalau seat_layout_id diubah → resolve ulang
  // Kalau seat_layout_id diubah → resolve ulang
  let finalLayoutId = null;
  let finalTemplateId = null;
  if (req.body.seat_layout_id !== undefined && req.body.seat_layout_id !== '') {
    try {
      const resolved = await resolveSeatLayoutId(vendorId, Number(req.body.seat_layout_id));
      finalLayoutId = resolved.layoutId;
      finalTemplateId = resolved.templateId;
    } catch (e) {
      if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (ex) { } });
      return res.status(e.status || 500).json({ success: false, message: e.message });
    }
  }

  const allowed = [
    'name', 'class_name', 'vehicle_type', 'plate_number',
    'brand', 'model', 'year', 'seat_arrangement', 'capacity',
    'is_active',
  ];

  const sets = [];
  const values = [];

  if (finalLayoutId !== null) {
    sets.push('seat_layout_id = ?');
    values.push(finalLayoutId);
    sets.push('seat_layout_template_id = ?');
    values.push(finalTemplateId);
  }

  for (const key of allowed) {
    if (req.body[key] !== undefined && req.body[key] !== '') {
      let v = req.body[key];
      if (['capacity', 'year'].includes(key)) v = Number(v);
      if (key === 'is_active') v = (v === '0' || v === 0 || v === 'false') ? 0 : 1;

      sets.push(`${key} = ?`);
      values.push(v);
    }
  }

  if (sets.length) {
    values.push(vehicleId);
    await query(
      `UPDATE vehicles SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ?`,
      values
    );
  }

  // Facilities (kalau dikirim, replace semua)
  const rawFac = req.body['facility_ids[]'] ?? req.body.facility_ids;
  if (rawFac !== undefined) {
    const ids = Array.isArray(rawFac) ? rawFac : [rawFac];
    await query(`DELETE FROM vehicle_facilities WHERE vehicle_id = ?`, [vehicleId]);
    for (const fid of ids) {
      if (!fid) continue;
      await query(
        `INSERT INTO vehicle_facilities (vehicle_id, facility_id) VALUES (?, ?)`,
        [vehicleId, Number(fid)]
      );
    }
  }

  // Foto baru (append)
  if (req.files && req.files.length) {
    const { rows: coverRows } = await query(
      `SELECT id FROM vehicle_photos WHERE vehicle_id = ? AND is_cover = 1 LIMIT 1`,
      [vehicleId]
    );
    const hasCover = coverRows.length > 0;

    for (let i = 0; i < req.files.length; i++) {
      const file = req.files[i];
      const url = toPublicUrl(req, file.filename, 'vehicles');
      const isCover = (!hasCover && i === 0) ? 1 : 0;

      await query(
        `INSERT INTO vehicle_photos (vehicle_id, url, kind, is_cover, sort_order)
         VALUES (?, ?, 'exterior', ?, ?)`,
        [vehicleId, url, isCover, i]
      );
    }
  }

  const fullVehicle = await getVehicleFullById(vehicleId);
  ok(res, fullVehicle);
});

/** Ganti fasilitas armada (replace all) */
const setVehicleFacilities = asyncHandler(async (req, res) => {
  const { facility_ids } = req.body;
  if (!Array.isArray(facility_ids)) {
    return res.status(400).json({ success: false, message: 'facility_ids harus array' });
  }

  const { rows: check } = await query(
    `SELECT id FROM vehicles WHERE id = ? AND vendor_id = ?`,
    [req.params.id, req.vendorId]
  );
  if (!check.length) {
    return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });
  }

  await withTransaction(async (client) => {
    await client.query(`DELETE FROM vehicle_facilities WHERE vehicle_id = ?`, [req.params.id]);

    if (facility_ids.length) {
      // ✅ FIX: placeholder manual
      const placeholders = facility_ids.map(() => '(?, ?)').join(', ');
      const values = facility_ids.flatMap(fid => [req.params.id, Number(fid)]);
      await client.query(
        `INSERT INTO vehicle_facilities(vehicle_id, facility_id) VALUES ${placeholders}`,
        values
      );
    }
  });

  const full = await getVehicleFullById(req.params.id);
  ok(res, full);
});

/** Tambah foto ke armada yang sudah ada */
const addVehiclePhotos = asyncHandler(async (req, res) => {
  const vendorId = Number(req.vendorId);
  const vehicleId = Number(req.params.id);

  const { rows: existing } = await query(
    `SELECT id FROM vehicles WHERE id = ? AND vendor_id = ? LIMIT 1`,
    [vehicleId, vendorId]
  );
  if (!existing.length) {
    if (req.files) req.files.forEach(f => { try { fs.unlinkSync(f.path); } catch (e) { } });
    return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });
  }

  if (!req.files || !req.files.length) {
    return res.status(400).json({ success: false, message: 'Tidak ada file yang di-upload' });
  }

  const { rows: coverRows } = await query(
    `SELECT id FROM vehicle_photos WHERE vehicle_id = ? AND is_cover = 1 LIMIT 1`,
    [vehicleId]
  );
  const hasCover = coverRows.length > 0;

  const { rows: maxRows } = await query(
    `SELECT COALESCE(MAX(sort_order), -1) AS max_sort
       FROM vehicle_photos WHERE vehicle_id = ?`,
    [vehicleId]
  );
  let sortStart = maxRows[0].max_sort + 1;

  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    const url = toPublicUrl(req, file.filename, 'vehicles');
    const isCover = (!hasCover && i === 0) ? 1 : 0;

    await query(
      `INSERT INTO vehicle_photos (vehicle_id, url, kind, is_cover, sort_order)
       VALUES (?, ?, 'exterior', ?, ?)`,
      [vehicleId, url, isCover, sortStart + i]
    );
  }

  const fullVehicle = await getVehicleFullById(vehicleId);
  created(res, fullVehicle);
});

/** Hapus foto armada */
const deleteVehiclePhoto = asyncHandler(async (req, res) => {
  const vendorId = Number(req.vendorId);
  const vehicleId = Number(req.params.id);
  const photoId = Number(req.params.photoId);

  const { rows } = await query(
    `SELECT vp.id, vp.url, vp.is_cover FROM vehicle_photos vp
       JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = ? AND vp.vehicle_id = ? AND v.vendor_id = ? LIMIT 1`,
    [photoId, vehicleId, vendorId]
  );
  if (!rows.length) {
    return res.status(404).json({ success: false, message: 'Foto tidak ditemukan' });
  }

  const photo = rows[0];

  try {
    const filename = photo.url.split('/').pop();
    const filePath = path.join(process.cwd(), UPLOAD_DIR, 'vehicles', filename);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {
    console.warn('[deleteVehiclePhoto] file tidak ada:', e.message);
  }

  await query(`DELETE FROM vehicle_photos WHERE id = ?`, [photoId]);

  if (photo.is_cover) {
    const { rows: first } = await query(
      `SELECT id FROM vehicle_photos WHERE vehicle_id = ? ORDER BY sort_order, id LIMIT 1`,
      [vehicleId]
    );
    if (first.length) {
      await query(`UPDATE vehicle_photos SET is_cover = 1 WHERE id = ?`, [first[0].id]);
    }
  }

  const fullVehicle = await getVehicleFullById(vehicleId);
  ok(res, fullVehicle);
});

/** Set foto sampul (cover) */
const setCoverPhoto = asyncHandler(async (req, res) => {
  const vendorId = Number(req.vendorId);
  const vehicleId = Number(req.params.id);
  const photoId = Number(req.params.photoId);

  const { rows } = await query(
    `SELECT vp.id FROM vehicle_photos vp
       JOIN vehicles v ON v.id = vp.vehicle_id
      WHERE vp.id = ? AND vp.vehicle_id = ? AND v.vendor_id = ? LIMIT 1`,
    [photoId, vehicleId, vendorId]
  );
  if (!rows.length) {
    return res.status(404).json({ success: false, message: 'Foto tidak ditemukan' });
  }

  await query(`UPDATE vehicle_photos SET is_cover = 0 WHERE vehicle_id = ?`, [vehicleId]);
  await query(`UPDATE vehicle_photos SET is_cover = 1 WHERE id = ?`, [photoId]);

  const fullVehicle = await getVehicleFullById(vehicleId);
  ok(res, fullVehicle);
});

/** Hapus armada (soft: nonaktifkan agar histori jadwal tetap valid) */
const deactivateVehicle = asyncHandler(async (req, res) => {
  const vendorId = Number(req.vendorId);

  const { rows: existing } = await query(
    `SELECT id FROM vehicles WHERE id = ? AND vendor_id = ? LIMIT 1`,
    [req.params.id, vendorId]
  );
  if (!existing.length) {
    return res.status(404).json({ success: false, message: 'Armada tidak ditemukan' });
  }

  await query(
    `UPDATE vehicles SET is_active = 0, updated_at = NOW()
      WHERE id = ? AND vendor_id = ?`,
    [req.params.id, vendorId]
  );

  const { rows: updated } = await query(`SELECT * FROM vehicles WHERE id = ? LIMIT 1`, [req.params.id]);
  ok(res, updated[0]);
});

module.exports = {
  createVehicle,
  listMyVehicles,
  getVehicleDetail,
  getVehicleFullById,
  updateVehicle,
  setVehicleFacilities,
  addVehiclePhotos,
  setCoverPhoto,
  deleteVehiclePhoto,
  deactivateVehicle,
  listFacilities,
  createSeatLayout,
  listSeatLayouts,
  getSeatLayoutDetail,
};