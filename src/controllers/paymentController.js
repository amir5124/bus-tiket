const axios = require('axios');
const crypto = require('crypto');
const moment = require('moment-timezone');
const { query } = require('../config/db');

const config = {
  clientId: process.env.LINKQU_CLIENT_ID || 'testing',
  clientSecret: process.env.LINKQU_CLIENT_SECRET || '123',
  username: process.env.LINKQU_USERNAME || 'LI307GXIN',
  pin: process.env.LINKQU_PIN || '2K2NPCBBNNTovgB',
  serverKey: process.env.LINKQU_SERVER_KEY || 'LinkQu@2020',
  baseUrl: process.env.LINKQU_BASE_URL || 'https://gateway-dev.linkqu.id/linkqu-partner'
};

function generateSignature(path,method,data){
  const rawValue=Object.values(data).join('')+config.clientId;
  const cleaned=rawValue.replace(/[^0-9a-zA-Z]/g,'').toLowerCase();
  return crypto.createHmac('sha256',config.serverKey).update(path+method+cleaned).digest('hex');
}
function normalizePhone(phone){
  let p=String(phone||'').replace(/[^0-9]/g,'');
  if(p.startsWith('0'))p='+62'+p.slice(1);
  else if(p.startsWith('8'))p='+62'+p;
  else if(p.startsWith('62'))p='+'+p;
  else if(!p.startsWith('+'))p='+62'+p;
  return p.length<10?'+628123456789':p;
}

const createPayment=async(req,res)=>{
  try{
    const {booking_id,amount,customer_name,customer_phone,customer_email,method='QRIS',bank_code,admin_fee_applied}=req.body;
    const finalAmount=Math.round(Number(amount));
    if(!booking_id||!Number.isFinite(finalAmount)||finalAmount<1000)
      return res.status(400).json({status:'Error',message:'booking_id dan amount minimal Rp1.000 wajib diisi'});
    const {rows:booking}=await query(`SELECT * FROM bookings WHERE id=? LIMIT 1`,[booking_id]);
    if(!booking.length)return res.status(404).json({status:'Error',message:'Booking tidak ditemukan'});

    const finalCustomerName=(customer_name||booking[0].contact_name||'Customer').substring(0,30).trim();
    const finalCustomerEmail=(customer_email||booking[0].contact_email||'guest@mail.com').trim();
    const phone=normalizePhone(customer_phone||booking[0].contact_phone);
    const partner_reff=`PAY-BUS-${Date.now()}`;
    const expired=moment.tz('Asia/Jakarta').add(2,'hours').format('YYYYMMDDHHmmss');
    const callback=process.env.LINKQU_CALLBACK_URL || `${process.env.BASE_URL}/api/payments/callback`;
    const endpoint=method==='VA'?'/transaction/create/va':'/transaction/create/qris';
    const common={amount:finalAmount,expired,partner_reff,customer_id:phone,customer_name:finalCustomerName,customer_email:finalCustomerEmail};
    const payload={...common,username:config.username,pin:config.pin,url_callback:callback};
    if(method==='VA')payload.bank_code=bank_code;
    payload.signature=generateSignature(endpoint,'POST',method==='VA'?{...common,bank_code}:common);

    const resp=await axios.post(`${config.baseUrl}${endpoint}`,payload,{
      headers:{'client-id':config.clientId,'client-secret':config.clientSecret}
    });
    const data=resp.data;
    const va=data.virtual_account||data.va_number||data.data?.va_number||null;
    const qr=data.imageqris||data.qr_url||data.data?.qr_url||null;
    if(!va&&!qr)throw new Error('LinkQu tidak mengembalikan VA/QRIS: '+JSON.stringify(data));

    // Payment table milik backend ini; tidak mengubah tabel payment vendor.
    await query(`INSERT INTO bus_payments
      (booking_id,payment_reff,payment_method,va_number,qris_url,admin_fee,amount,payment_status,expired_date,created_at)
      VALUES(?,?,?,?,?,?,?,'PENDING',?,NOW())`,
      [booking_id,partner_reff,method==='VA'?`VA-${bank_code||''}`:'QRIS',va,qr,Number(admin_fee_applied||0),finalAmount,
       moment(expired,'YYYYMMDDHHmmss').format('YYYY-MM-DD HH:mm:ss')]);

    res.json({status:'Success',partner_reff,payment_info:{method,bank_code,va_number:va,qris_url:qr,amount:finalAmount,expired_at:moment(expired,'YYYYMMDDHHmmss').format('YYYY-MM-DD HH:mm:ss')}});
  }catch(err){
    console.error('[PAYMENT CREATE]',err.response?.data||err.message);
    res.status(500).json({status:'Error',message:'Gagal membuat kode pembayaran.',debug:err.response?.data||err.message});
  }
};

const markPaid=async(partner_reff)=>{
  const {rows}=await query(`SELECT booking_id FROM bus_payments WHERE payment_reff=? LIMIT 1`,[partner_reff]);
  if(!rows.length)return null;
  const bookingId=rows[0].booking_id;
  await query(`UPDATE bus_payments SET payment_status='SETTLED',payment_date=NOW() WHERE payment_reff=?`,[partner_reff]);
  await query(`UPDATE bookings SET status='paid' WHERE id=? AND status NOT IN ('paid','completed','cancelled','refunded')`,[bookingId]);
  return bookingId;
};

const handleCallback=async(req,res)=>{
  try{
    const {partner_reff,status}=req.body;
    if(['SUCCESS','SETTLED'].includes(String(status||'').toUpperCase()))await markPaid(partner_reff);
    res.json({message:'OK'});
  }catch(err){console.error('[PAYMENT CALLBACK]',err.message);res.status(500).json({status:'ERROR'});}
};

const checkStatus=async(req,res)=>{
  const {reff}=req.params;
  try{
    const {rows}=await query(`SELECT payment_status,booking_id FROM bus_payments WHERE payment_reff=?`,[reff]);
    if(rows.length&&['SUCCESS','SETTLED','PAID'].includes(String(rows[0].payment_status).toUpperCase()))
      return res.json({status:'SUCCESS',payment_status:'SUCCESS'});
    const resp=await axios.get(`${config.baseUrl}/transaction/check-status`,{
      params:{partner_reff:reff,username:config.username,pin:config.pin},
      headers:{'client-id':config.clientId,'client-secret':config.clientSecret},validateStatus:s=>s<500
    });
    const d=resp.data;
    const success=(String(d.status||'').toUpperCase()==='SUCCESS'||String(d.status||'').toUpperCase()==='SETTLED'||d.response_code==='00'||String(d.response_desc||'').toUpperCase().includes('SUCCESS'));
    if(success){await markPaid(reff);return res.json({status:'SUCCESS',payment_status:'SUCCESS',data:d});}
    res.json({status:'PENDING',message:'Menunggu pembayaran'});
  }catch(err){console.error('[PAYMENT STATUS]',err.message);res.json({status:'PENDING',error:err.message});}
};

module.exports={createPayment,handleCallback,checkStatus};
