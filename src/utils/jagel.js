// src/utils/jagel.js
const axios = require('axios');

const JAGEL_BASE_URL = process.env.JAGEL_BASE_URL || 'https://api.jagel.id/v1';
const JAGEL_API_KEY = process.env.JAGEL_API_KEY || 'c6wA9HlUkN2PYEpEOYmDwiehrw7QMIVAvPETMpR2NRN4jjnYPO';

/**
 * Cek saldo user Jagel (username)
 * @returns {Promise<{balance:number, balance_active:number}|null>}
 */
async function fetchJagelSaldo(username) {
    try {
        if (!JAGEL_API_KEY) {
            console.error('[JAGEL-SALDO] JAGEL_API_KEY tidak di-set');
            return null;
        }

        const url = `${JAGEL_BASE_URL}/balance/check`;
        console.log('[JAGEL-SALDO] GET', url, 'user=', username);

        const resp = await axios.request({
            method: 'GET',
            url,
            data: {
                type: 'username',
                value: username,
                apikey: JAGEL_API_KEY,
            },
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            timeout: 15000,
            validateStatus: s => s < 600,
        });

        const data = resp.data || {};
        if (data.success === false) {
            console.error('[JAGEL-SALDO] Jagel bilang gagal:', JSON.stringify(data));
            return null;
        }

        const balance = Number(data.data?.balance ?? data.balance ?? NaN);
        const balanceActive = Number(
            data.data?.balance_active ?? data.balance_active ?? balance ?? NaN
        );

        if (!Number.isFinite(balance) && !Number.isFinite(balanceActive)) {
            console.error('[JAGEL-SALDO] format tidak dikenali:', JSON.stringify(data));
            return null;
        }

        return {
            balance: Number.isFinite(balance) ? balance : balanceActive,
            balance_active: Number.isFinite(balanceActive) ? balanceActive : balance,
        };
    } catch (e) {
        console.error('[JAGEL-SALDO] gagal:', {
            message: e.message,
            status: e.response?.status,
            data: e.response?.data,
        });
        return null;
    }
}

/**
 * Adjust saldo user Jagel.
 * amount > 0 = tambah, amount < 0 = potong
 */
async function adjustJagelSaldo(username, amount, note) {
    try {
        const url = `${JAGEL_BASE_URL}/balance/adjust`;
        console.log('[JAGEL-ADJUST] POST', url, 'user=', username, 'amount=', amount);

        const resp = await axios.post(url, {
            type: 'username',
            value: username,
            amount: amount,
            apikey: JAGEL_API_KEY,
            note: note || '',
        }, {
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
            },
            timeout: 30000,
            validateStatus: s => s < 600,
        });

        const data = resp.data || {};
        if (data.success === false) {
            throw new Error(data.message || 'Jagel tolak adjust saldo');
        }
        return data;
    } catch (e) {
        console.error('[JAGEL-ADJUST] gagal:', {
            message: e.message,
            status: e.response?.status,
            data: e.response?.data,
        });
        throw new Error(e.response?.data?.message || e.message);
    }
}

module.exports = { fetchJagelSaldo, adjustJagelSaldo };