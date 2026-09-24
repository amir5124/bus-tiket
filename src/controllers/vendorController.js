const { query, withTransaction } = require('../config/db');
const { asyncHandler, ok, created, randomCode } = require('../utils/helpers');

const registerVendor = asyncHandler(async (req,res)=>{
  const {name,legal_name,address}=req.body;
  if(!name) return res.status(400).json({success:false,message:'name wajib diisi'});
  const code=randomCode('VND');
  const result=await withTransaction(async client=>{
    const r=await client.query(
      `INSERT INTO vendors(code,name,legal_name,address,owner_user_id,status,created_at)
       VALUES(?,?,?,?,?,'pending',NOW())`,[code,name,legal_name||null,address||null,req.user.id]);
    const vendorId=r.insertId;
    await client.query(
      `INSERT INTO vendor_members(vendor_id,user_id,role,notify_channels)
       VALUES(?,?,?,'in_app,push') ON DUPLICATE KEY UPDATE role=VALUES(role)`,
      [vendorId,req.user.id,'owner']);
    const v=await client.query(`SELECT * FROM vendors WHERE id=?`,[vendorId]);
    return v.rows[0];
  });
  created(res,result);
});

const getMyVendorProfile=asyncHandler(async(req,res)=>{
  const {rows}=await query(`SELECT * FROM v_vendor_profile WHERE vendor_id=?`,[req.vendorId]);
  if(!rows.length)return res.status(404).json({success:false,message:'Vendor tidak ditemukan'});
  ok(res,rows[0]);
});

const updateVendorProfile=asyncHandler(async(req,res)=>{
  const allowed=['name','legal_name','npwp','nib','contact_phone','contact_email','address','logo_url','description'];
  const sets=[],values=[];
  for(const key of allowed){if(req.body[key]!==undefined){sets.push(`${key}=?`);values.push(req.body[key]);}}
  if(!sets.length)return res.status(400).json({success:false,message:'Tidak ada field untuk diupdate'});
  values.push(req.vendorId);
  await query(`UPDATE vendors SET ${sets.join(', ')} WHERE id=?`,values);
  const {rows}=await query(`SELECT * FROM vendors WHERE id=?`,[req.vendorId]);
  ok(res,rows[0]);
});

const addBankAccount=asyncHandler(async(req,res)=>{
  const {bank_name,account_number,account_holder,is_primary}=req.body;
  if(!bank_name||!account_number||!account_holder)return res.status(400).json({success:false,message:'bank_name, account_number, account_holder wajib diisi'});
  const result=await withTransaction(async client=>{
    if(is_primary) await client.query(`UPDATE vendor_bank_accounts SET is_primary=0 WHERE vendor_id=?`,[req.vendorId]);
    const r=await client.query(
      `INSERT INTO vendor_bank_accounts(vendor_id,bank_name,account_number,account_holder,is_primary)
       VALUES(?,?,?,?,?)`,[req.vendorId,bank_name,account_number,account_holder,is_primary?1:0]);
    const {rows}=await client.query(`SELECT * FROM vendor_bank_accounts WHERE id=?`,[r.insertId]);
    return rows[0];
  });
  created(res,result);
});

const addVendorMember=asyncHandler(async(req,res)=>{
  const {user_id,role,notify_channels}=req.body;
  if(!user_id||!role)return res.status(400).json({success:false,message:'user_id, role wajib diisi'});
  await query(
    `INSERT INTO vendor_members(vendor_id,user_id,role,notify_channels)
     VALUES(?,?,?,?) ON DUPLICATE KEY UPDATE role=VALUES(role),notify_channels=VALUES(notify_channels)`,
    [req.vendorId,user_id,role,notify_channels||'in_app,push']);
  const {rows}=await query(`SELECT * FROM vendor_members WHERE vendor_id=? AND user_id=?`,[req.vendorId,user_id]);
  created(res,rows[0]);
});
module.exports={registerVendor,getMyVendorProfile,updateVendorProfile,addBankAccount,addVendorMember};
