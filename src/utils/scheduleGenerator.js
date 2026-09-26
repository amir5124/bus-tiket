const { query } = require('../config/db');

function computeArrival(departureAt, durationMin) {
    const dur = Math.max(30, Math.min(Number(durationMin) || 180, 1440));
    const depDate = new Date(String(departureAt).replace(' ', 'T'));
    const arrDate = new Date(depDate.getTime() + dur * 60000);
    return arrDate.toISOString().slice(0, 19).replace('T', ' ');
}

async function resolveSeatList(vehicleId, seatConfig) {
    let seatList = [];
    if (seatConfig && seatConfig.type === 'custom' && Array.isArray(seatConfig.seats)) {
        seatList = seatConfig.seats.map(String).filter(Boolean);
    } else if (seatConfig && seatConfig.type === 'template' && seatConfig.template_id) {
        const { rows } = await query(
            `SELECT grid FROM seat_layout_templates WHERE id = ? AND is_active = 1 LIMIT 1`,
            [seatConfig.template_id]
        );
        if (rows.length) {
            let grid = rows[0].grid;
            if (typeof grid === 'string') { try { grid = JSON.parse(grid); } catch (e) { grid = []; } }
            for (const row of (grid || [])) {
                for (const cell of (row.cells || [])) {
                    if (cell == null || cell === '' || cell === 'driver' || cell === 'empty') continue;
                    seatList.push(String(cell));
                }
            }
        }
    } else {
        const { rows } = await query(
            `SELECT c.seat_number FROM vehicles v
               JOIN seat_layout_cells c
                 ON c.layout_id = v.seat_layout_id AND c.cell_type = 'seat'
              WHERE v.id = ?
              ORDER BY c.row_no, c.col_no`,
            [vehicleId]
        );
        seatList = rows.map(r => r.seat_number);
    }
    return seatList;
}

async function generateAll() {
    console.log('[SCHED-GEN] mulai generate...');

    // Ambil semua template aktif yang belum kadaluarsa
    const { rows: templates } = await query(
        `SELECT * FROM schedule_templates
          WHERE is_active = 1
            AND (active_until IS NULL OR active_until >= CURDATE())`
    );

    let totalGenerated = 0;
    const pad = n => String(n).padStart(2, '0');

    for (const tpl of templates) {
        const allowedDays = new Set(
            String(tpl.days_of_week || '1,2,3,4,5,6,7').split(',').map(s => Number(s.trim()))
        );
        const today = new Date(); today.setHours(0, 0, 0, 0);
        const activeFrom = new Date(tpl.active_from + 'T00:00:00');
        const activeUntil = tpl.active_until ? new Date(tpl.active_until + 'T23:59:59') : null;
        const days = Math.min(Math.max(Number(tpl.generate_days_ahead) || 30, 7), 90);

        let seatConfig = tpl.seat_config;
        if (typeof seatConfig === 'string') {
            try { seatConfig = JSON.parse(seatConfig); } catch (e) { seatConfig = null; }
        }
        const seatList = await resolveSeatList(tpl.vehicle_id, seatConfig);
        if (!seatList.length) {
            console.warn(`[SCHED-GEN] template ${tpl.id} tidak punya kursi, skip`);
            continue;
        }

        for (let i = 0; i < days; i++) {
            const d = new Date(today);
            d.setDate(d.getDate() + i);
            if (d < activeFrom) continue;
            if (activeUntil && d > activeUntil) break;

            const dow = d.getDay() === 0 ? 7 : d.getDay();
            if (!allowedDays.has(dow)) continue;

            const dateStr = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
            const [hh, mm] = String(tpl.departure_time).split(':');
            const depAt = `${dateStr} ${pad(hh)}:${pad(mm)}:00`;

            const { rows: exist } = await query(
                `SELECT id FROM schedules
                  WHERE vendor_id = ? AND route_id = ? AND vehicle_id = ?
                    AND departure_at = ? LIMIT 1`,
                [tpl.vendor_id, tpl.route_id, tpl.vehicle_id, depAt]
            );
            if (exist.length) continue;

            const arrAt = computeArrival(depAt, tpl.duration_minutes);
            const code = `SCH-${tpl.vendor_id}-${Date.now()}-${i}-${tpl.id}`;

            try {
                const r = await query(
                    `INSERT INTO schedules
                       (schedule_code, vendor_id, route_id, vehicle_id, direction,
                        pickup_stop_id, dropoff_stop_id,
                        departure_at, arrival_at, duration_minutes,
                        price, original_price, discount_percent,
                        insurance_available, insurance_product_id,
                        is_popular, status, created_by, template_id, created_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, NOW())`,
                    [
                        code, tpl.vendor_id, tpl.route_id, tpl.vehicle_id, tpl.direction || 'pergi',
                        tpl.pickup_stop_id, tpl.dropoff_stop_id,
                        depAt, arrAt, Number(tpl.duration_minutes) || 180,
                        tpl.price, tpl.original_price, tpl.discount_percent,
                        tpl.insurance_available, tpl.insurance_product_id,
                        tpl.is_popular,
                        tpl.created_by, tpl.id,
                    ]
                );
                const newId = r.insertId;

                if (seatList.length) {
                    const placeholders = seatList.map(() => '(?, ?)').join(', ');
                    const flat = seatList.flatMap(sn => [newId, sn]);
                    await query(
                        `INSERT INTO schedule_seats (schedule_id, seat_number) VALUES ${placeholders}`,
                        flat
                    );
                }
                await query(
                    `UPDATE schedules s
                        SET s.seats_total = (SELECT COUNT(*) FROM schedule_seats WHERE schedule_id = s.id),
                            s.seats_available = (SELECT COUNT(*) FROM schedule_seats WHERE schedule_id = s.id AND status = 'available')
                      WHERE s.id = ?`,
                    [newId]
                );
                totalGenerated++;
            } catch (e) {
                console.error(`[SCHED-GEN] template ${tpl.id}, ${depAt}:`, e.message);
            }
        }
    }

    console.log(`[SCHED-GEN] ✅ ${totalGenerated} jadwal digenerate`);
    return totalGenerated;
}

function startGenerateJob(ms = 6 * 60 * 60 * 1000) {
    console.log(`[SCHED-GEN] Auto-generate job aktif (setiap ${ms / 1000 / 60} menit)`);
    const t = setInterval(() => generateAll().catch(e => console.error('[SCHED-GEN]', e.message)), ms);
    t.unref();
    // Jalankan sekali saat boot setelah 5 detik
    setTimeout(() => generateAll().catch(e => console.error('[SCHED-GEN]', e.message)), 5000);
    return t;
}

module.exports = { generateAll, startGenerateJob };