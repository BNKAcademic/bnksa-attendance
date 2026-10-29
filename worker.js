/* ========================================================================
   BNKSA Attendance System - Backend v2 (Cloudflare Worker)
   ใช้ D1 (ไม่ต้องผูกบัตรเครดิต ต่างจาก R2) + KV
   [เฟส 1] แกนหลัก: โหลดข้อมูล/เช็คชื่อ/บันทึก/log
   [เฟส 2] เพิ่มแล้ว: สำรองข้อมูลอัตโนมัติตามตารางเวลา (scheduled handler),
     สำรอง/กู้คืนแบบแมนวล, หน้าสถานะข้อมูลระบบ (get_storage_info)
   [หมายเหตุ] เคยลองทำ get_external_holidays (ดึงวันหยุดราชการไทยจากอินเทอร์เน็ต)
     ทั้งเรียกตรงและพร็อกซีผ่าน Apps Script เดิม แต่เจอปัญหาความไม่เสถียรซ้ำ
     หลายรอบ (ถูกบล็อก/สิทธิ์ Apps Script) จึงตัดฟีเจอร์นี้ออกไปแล้ว เปลี่ยนไป
     ใช้ตารางวันหยุดอ้างอิงที่ฝังไว้ในโค้ดฝั่งเว็บ (THAI_HOLIDAYS_REFERENCE ใน
     app.js) แทน - ไม่พึ่งพา Apps Script เดิมอีกต่อไปในส่วนนี้แล้ว
   [v1.71.5] ความปลอดภัย: เข้าสู่ระบบผู้ดูแลตรวจที่ Worker (ไม่ตรวจในหน้าเว็บอีก) + บัตรผ่าน (token) อายุ 12 ชั่วโมง
     - ข้อมูลหลักที่ส่งให้หน้าเว็บทั่วไป "ไม่มีบัญชีผู้ใช้งาน" แล้ว (ผู้ดูแลที่เข้าสู่ระบบเห็นรายชื่อ แต่ไม่มีรหัสผ่าน)
     - บันทึกตั้งค่า/ครู/วิชา/นักเรียน, ล้างข้อมูล, กู้คืน, สำรอง, ดู Log = ต้องเข้าสู่ระบบผู้ดูแล
     - ครูเช็คชื่อ/บันทึกโฮมรูม/ส่งรูป ยังไม่ต้องเข้าสู่ระบบเหมือนเดิม
   [v1.72] เชื่อม AcademicHub ขั้น 1: ดึงรายชื่อครูจาก AcademicHub มาผูกกับครูในเว็บเช็คชื่อ (hub_teachers)
   [v1.72.1] ขั้น 2: วันหยุดเรียนจากปฏิทิน AcademicHub (hubHolidays ในข้อมูลหลัก · hub_holidays_sync)
   [v1.73] ขั้น 3: AcademicHub ขอข้อมูลห้อง/ครูที่ปรึกษา/สมุดโฮมรูมรายเดือน/รูปโฮมรูม (__mode "link") · ประหยัดการอ่าน KV
   ======================================================================== */

// ===== [v1.71] ที่เก็บรูปกิจกรรมโฮมรูม (Google Drive ของโรงเรียน ผ่าน Apps Script "HomeroomPhotoRelay") =====
const DRIVE_RELAY_URL = "https://script.google.com/macros/s/AKfycbzlwK5VgNNA53zaNyKeiZ950DrX-soKYMOyTn_zebU_Ga8_h1y_z-CxJ1pl8Eqp7UOlSg/exec"; // [ต้องตั้งค่า] วางลิงก์ Web App ของ Apps Script (ลงท้ายด้วย /exec)
const RELAY_TOKEN = "bnksa-hr-2569"; // ต้องตรงกับ TOKEN ใน Apps Script และ HOMEROOM_DRIVE_TOKEN ใน app.js

async function forwardToDrive(body) {
  if (!DRIVE_RELAY_URL) return { status: "error", message: "ยังไม่ได้ตั้งค่า DRIVE_RELAY_URL ใน Worker" };
  const res = await fetch(DRIVE_RELAY_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ ...body, token: RELAY_TOKEN }),
    redirect: "follow",
  });
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { status: "error", message: "Apps Script ตอบกลับไม่ถูกต้อง" }; }
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "https://bnkacademic.github.io", // [แก้ไข] จำกัดให้เรียกได้เฉพาะโดเมนเว็บจริงเท่านั้น (เดิมเปิดกว้างไว้ตอนทดสอบ)
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS },
  });
}

function emptyMainData() {
  return {
    settings: {
      term: "1", year: "2569",
      roomCounts: { m1: 4, m2: 4, m3: 4, m4: 3, m5: 3, m6: 3 },
      advisors: {}, staffs: {}, thresholds: { late: 4, absent: 4, incompletePeriods: 4, incompleteDays: 3, leaveOverride: 4 },
      storageLimitChars: 8000000, holidays: [], termLocks: {}, termCount: 2,
      academicYears: [{ year: "2569", status: "active" }],
      users: [{ id: "super_admin_root", username: "BNKAdmin", password: "042499078", name: "ผู้ดูแลระบบหลัก", role: "super_admin", createdAt: new Date().toISOString() }],
    },
    teachers: [], subjects: [], students: [], followUps: [],
  };
}

// ===== KV: ไฟล์หลัก (settings/ครู/วิชา/นักเรียน) - เขียนไม่บ่อย จึงเหมาะกับ KV =====
const MAIN_KEY = "main_db";
async function readMainData(env) {
  const raw = await env.MAIN_KV.get(MAIN_KEY);
  if (!raw) return emptyMainData();
  try { return JSON.parse(raw); } catch (e) { return emptyMainData(); }
}
// [v1.74.4] อ่านอย่างเดียว (ห้ามแก้ค่าที่ได้): จำผลแปลง JSON ไว้ — ข้อมูลหลักไม่เปลี่ยน = ไม่ต้องแปลงซ้ำ (ประหยัดเวลา CPU ซึ่งแผนฟรีจำกัด 10 มิลลิวินาที/คำขอ)
let MAIN_MEM = { raw: null, data: null };
async function readMainRO(env, raw) {
  if (raw === undefined) raw = await env.MAIN_KV.get(MAIN_KEY);
  if (!raw) return emptyMainData();
  if (raw === MAIN_MEM.raw) return MAIN_MEM.data;
  let d; try { d = JSON.parse(raw); } catch (e) { return emptyMainData(); }
  MAIN_MEM = { raw, data: d };
  return d;
}
async function writeMainData(env, data, ctx) {
  // [v1.74.3] หน้าเว็บรู้ว่าข้อมูลหลักเปลี่ยน · [v1.74.4] เขียน KV กับ D1 พร้อมกัน (ไม่ต่อคิวกัน)
  const str = JSON.stringify(data);
  // [v1.74.6] ตอบกลับทันทีหลังเขียน KV เสร็จ — ตัวบอกการเปลี่ยนแปลง (D1) เขียนตามหลัง ไม่ให้การบันทึกต้องรอคิว D1
  if (ctx && ctx.waitUntil) { await putMainKV(env, str); ctx.waitUntil(bumpSync(env, ["main"])); }
  else await Promise.all([putMainKV(env, str), bumpSync(env, ["main"])]);
}
// [v1.74.6] ดัชนีให้ตารางเช็คชื่อ ค้นตามภาคเรียน/ปี/ห้อง ได้ทันที (เดิมต้องไล่อ่านทั้งตาราง ทำให้ D1 ต่อคิวยาว) — สร้างเองครั้งแรก ไม่ต้องรัน SQL
let ATT_IDX = false;
async function ensureAttIndexes(env) {
  if (ATT_IDX) return; ATT_IDX = true;
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_attendance_room ON attendance (term, year, room_id)").run(); } catch (e) { ATT_IDX = false; }
}
// [v1.74.5] KV เขียนคีย์เดียวกันได้ไม่เกิน 1 ครั้ง/วินาที — ถ้าชน (429) รอ 1.1 วินาทีแล้วเขียนใหม่ในฝั่ง Worker เลย (เดิมล้มทั้งคำขอ แล้วหน้าเว็บส่งข้อมูลทั้งชุดซ้ำ)
async function putMainKV(env, str) {
  for (let i = 0; ; i++) {
    try { return await env.MAIN_KV.put(MAIN_KEY, str); }
    catch (e) { if (i >= 2 || !/429|too many/i.test(String(e && e.message || e))) throw e; await new Promise(r => setTimeout(r, 1100)); }
  }
}
// ===== [v1.74.3] ประหยัดโควต้า: เวลาแก้ไขล่าสุดของ "ข้อมูลหลัก" และ "ข้อมูลเช็คชื่อรายห้อง" ในตารางเล็ก sync_meta
// หน้าเว็บถาม 1 คำขอ (?action=sync_meta) ได้ครบทุกอย่าง แล้วค่อยโหลดเฉพาะส่วนที่เปลี่ยน · ตารางสร้างให้เองครั้งแรก (ไม่ต้องรัน SQL)
// คีย์: main · all (ล้างทั้งเทอม/นำเข้า = ทุกห้องเปลี่ยน) · room|<term>|<year>|<roomId>
let SYNC_TABLE_OK = false;
async function ensureSyncTable(env) {
  if (SYNC_TABLE_OK) return;
  await env.DB.prepare("CREATE TABLE IF NOT EXISTS sync_meta (k TEXT PRIMARY KEY, v INTEGER)").run();
  SYNC_TABLE_OK = true;
}
async function bumpSync(env, keys) {
  try {
    await ensureSyncTable(env);
    const now = Date.now();
    const uniq = [...new Set(keys.filter(Boolean))];
    if (!uniq.length) return;
    await env.DB.batch(uniq.map(k => env.DB.prepare("INSERT INTO sync_meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v").bind(k, now)));
  } catch (e) { /* ไม่ให้การบันทึกหลักล้มเพราะตารางนี้ */ }
}
const roomSyncKey = (term, year, roomId) => `room|${term}|${year}|${roomId}`;

function isMainDataShapeValid(data) {
  if (!data || !data.settings || Object.keys(data.settings).length === 0) return false;
  if (!Array.isArray(data.teachers) || !Array.isArray(data.subjects) || !Array.isArray(data.students)) return false;
  return true;
}

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 9);
}

// ===== [v1.71.5] เข้าสู่ระบบผู้ดูแล + บัตรผ่าน (ลายเซ็น HMAC — ไม่ต้องเก็บ session ใน KV) =====
const TOKEN_HOURS = 12;
const enc = new TextEncoder();
function hex(buf) { return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, "0")).join(""); }
async function sha256Hex(text) { return hex(await crypto.subtle.digest("SHA-256", enc.encode(String(text)))); }
function isHashStr(v) { return /^[0-9a-f]{64}$/.test(String(v || "")); }
// กุญแจลับสร้างเองครั้งแรกแล้วเก็บใน KV (เขียน KV ครั้งเดียว) — หรือตั้ง Secret ชื่อ AUTH_SECRET ใน Worker แทนก็ได้
let AUTH_MEM = ""; // [v1.74.4] จำรหัสลับไว้ในหน่วยความจำ — ไม่อ่าน KV ทุกคำขอ
async function authSecret(env) {
  if (env.AUTH_SECRET) return env.AUTH_SECRET;
  if (AUTH_MEM) return AUTH_MEM;
  let s = await env.MAIN_KV.get("auth_secret");
  if (s) { AUTH_MEM = s; return s; }
  if (!s) { s = hex(crypto.getRandomValues(new Uint8Array(32))); await env.MAIN_KV.put("auth_secret", s); }
  AUTH_MEM = s;
  return s;
}
async function hmac(env, msg) {
  const key = await crypto.subtle.importKey("raw", enc.encode(await authSecret(env)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return hex(await crypto.subtle.sign("HMAC", key, enc.encode(msg)));
}
async function makeToken(env, user) {
  const body = [user.id, user.role, Date.now() + TOKEN_HOURS * 3600 * 1000].join("|");
  return btoa(unescape(encodeURIComponent(body))) + "." + (await hmac(env, body));
}
// คืนผู้ใช้ (จากข้อมูลหลักล่าสุด) ถ้าบัตรผ่านถูกต้อง ไม่หมดอายุ และบัญชียังอยู่ — ไม่งั้น null
async function verifyToken(env, token, mainData) {
  try {
    const t = String(token || ""); const i = t.lastIndexOf(".");
    if (i < 1) return null;
    const body = decodeURIComponent(escape(atob(t.slice(0, i))));
    if ((await hmac(env, body)) !== t.slice(i + 1)) return null;
    const [uid, role, exp] = body.split("|");
    if (!(Number(exp) > Date.now())) return null;
    const md = mainData || await readMainRO(env);
    const u = ((md.settings && md.settings.users) || []).find(x => x.id === uid);
    if (!u || u.role !== role) return null;
    return u;
  } catch (e) { return null; }
}
function publicUser(u) { return { id: u.id, username: u.username, name: u.name, role: u.role, createdAt: u.createdAt || "" }; }
// ข้อมูลหลักที่ส่งออกไปหน้าเว็บ: ไม่มีรหัสผ่านเสมอ · ไม่ได้เข้าสู่ระบบ = ไม่มีรายชื่อบัญชีผู้ใช้งานเลย
function mainForClient(mainData, adminUser) {
  const settings = { ...(mainData.settings || {}) };
  settings.users = adminUser ? (settings.users || []).map(publicUser) : [];
  return { ...mainData, settings };
}
function hasMainData(raw) { return !!raw; }
// บันทึกแบบเต็ม: บัญชีผู้ใช้งานรับจาก Super Admin เท่านั้น · รหัสผ่านที่ไม่ได้ส่งมา = คงของเดิม · รหัสผ่านที่ยังไม่เป็น hash = เข้ารหัสให้
async function mergeUsers(incoming, current, actor) {
  const cur = (current && current.settings && current.settings.users) || [];
  if (!actor || actor.role !== "super_admin" || !Array.isArray(incoming)) return cur;
  const byId = {}; cur.forEach(u => { byId[u.id] = u; });
  const out = [];
  for (const u of incoming) {
    if (!u || !u.id || !u.username) continue;
    const old = byId[u.id];
    if (old && old.role === "super_admin" && old.id !== actor.id) { out.push(old); continue; } // แก้ Super Admin คนอื่นไม่ได้
    let password = u.password ? (isHashStr(u.password) ? u.password : await sha256Hex(u.password)) : (old ? old.password : "");
    if (!password) continue; // บัญชีใหม่ที่ไม่มีรหัสผ่าน
    out.push({ id: u.id, username: String(u.username), name: String(u.name || ""), role: old ? old.role : (u.role === "super_admin" ? "admin" : (u.role || "admin")), createdAt: u.createdAt || (old && old.createdAt) || new Date().toISOString(), password });
  }
  cur.forEach(u => { if (u.role === "super_admin" && !out.some(x => x.id === u.id)) out.push(u); }); // ลบ Super Admin ไม่ได้
  return out;
}
// ===== [v1.72] เชื่อมกับ BNKAcademicHub (Worker ↔ Worker ผ่าน Service Binding ชื่อ HUB + Secret LINK_KEY ตรงกันทั้ง 2 Worker) =====
async function callHub(env, action, payload) {
  if (!env.HUB || typeof env.HUB.fetch !== "function") throw new Error("ยังไม่ได้เชื่อม Worker — เพิ่ม Service binding ชื่อ HUB (เลือก Worker ของ AcademicHub) ที่ Worker เช็คชื่อก่อน");
  if (!env.LINK_KEY) throw new Error("ยังไม่ได้ตั้งรหัสเชื่อมระบบ — เพิ่ม Secret ชื่อ LINK_KEY ที่ Worker เช็คชื่อ (ค่าเดียวกับที่ Worker ของ AcademicHub)");
  const res = await env.HUB.fetch(new Request("https://academichub.internal/api", { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, payload: { ...(payload || {}), linkKey: env.LINK_KEY } }) }));
  let j = null; try { j = await res.json(); } catch (e) { /* ข้าม */ }
  if (!j) throw new Error("AcademicHub ตอบกลับไม่ถูกต้อง (HTTP " + res.status + ")");
  if (!j.ok) throw new Error("AcademicHub: " + (j.error || "ไม่สำเร็จ"));
  return j.data;
}
// [v1.72.1] ขั้น 2: วันหยุดเรียนจากปฏิทิน AcademicHub — ขยายเป็นรายวันแล้วเก็บใน KV (เขียนเฉพาะเมื่อเปลี่ยน) · ดึงใหม่ทุกประมาณ 6 ชั่วโมง
const HUB_HOL_KEY = "hub_holidays";
// [v1.73] จำไว้ในหน่วยความจำของ Worker 5 นาที — ไม่อ่าน KV ทุกครั้งที่หน้าเว็บตรวจข้อมูล (1.72.1 อ่าน KV เพิ่ม 2 ครั้งต่อคำขอ)
let HOL_MEM = { readAt: 0, items: [], periods: [], syncedAt: 0 }, HOL_SYNCING = false;
const HOL_MEM_MS = 5 * 60 * 1000, HOL_STALE_MS = 6 * 3600 * 1000;
function ymd(d) { return d.toISOString().slice(0, 10); }
function expandHubHolidays(list) {
  const out = {}; const y0 = new Date().getUTCFullYear();
  const addRange = (start, end, label) => {
    const s = new Date(start + "T00:00:00Z"), e = new Date(end + "T00:00:00Z");
    if (isNaN(s) || isNaN(e) || e < s) return;
    for (let d = new Date(s), n = 0; d <= e && n < 62; d.setUTCDate(d.getUTCDate() + 1), n++) {
      const k = ymd(d); if (!out[k]) out[k] = { date: k, label: String(label || "หยุดเรียน").slice(0, 120), type: "holiday", duration: "full", source: "hub" };
    }
  };
  for (const h of list || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date || "")) continue;
    const end = /^\d{4}-\d{2}-\d{2}$/.test(h.endDate || "") ? h.endDate : h.date;
    if (!h.repeatYearly) { addRange(h.date, end, h.title); continue; }
    const baseY = Number(h.date.slice(0, 4)), span = Number(end.slice(0, 4)) - baseY;
    for (let y = Math.max(baseY, y0 - 1); y <= y0 + 1; y++) {
      const s = y + h.date.slice(4), e = (y + span) + end.slice(4);
      if (ymd(new Date(s + "T00:00:00Z")) !== s) continue; // 29 ก.พ. ปีที่ไม่มี
      addRange(s, e, h.title);
    }
  }
  return Object.values(out).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 1000);
}
async function readHubHolidays(env) {
  if (Date.now() - HOL_MEM.readAt < HOL_MEM_MS) return HOL_MEM.items;
  try { const raw = await env.MAIN_KV.get(HUB_HOL_KEY); const v = raw ? JSON.parse(raw) : {}; HOL_MEM = { readAt: Date.now(), items: v.items || [], periods: v.periods || [], syncedAt: Date.parse(v.at || "") || 0 }; }
  catch (e) { HOL_MEM = { readAt: Date.now(), items: HOL_MEM.items || [], periods: HOL_MEM.periods || [], syncedAt: HOL_MEM.syncedAt || 0 }; }
  return HOL_MEM.items;
}
function hubHolidaysStale() { return !HOL_SYNCING && Date.now() - (HOL_MEM.syncedAt || 0) > HOL_STALE_MS; }
async function syncHubHolidays(env) {
  const d = await callHub(env, "linkHolidays", {});
  const items = expandHubHolidays(d.holidays || []);
  const periods = expandHubPeriods(d.periods || []); // [v1.74] หยุดเรียนบางคาบ / จัดกิจกรรม / วันหยุดบางระดับชั้น
  const raw = await env.MAIN_KV.get(HUB_HOL_KEY); let cur = null; try { const o = raw ? JSON.parse(raw) : null; cur = o ? { items: o.items || [], periods: o.periods || [] } : null; } catch (e) { cur = null; }
  const changed = JSON.stringify(cur || { items: [], periods: [] }) !== JSON.stringify({ items, periods });
  const at = new Date().toISOString();
  await env.MAIN_KV.put(HUB_HOL_KEY, JSON.stringify({ items, periods, at })); // เขียนทุกครั้งที่ดึง (เวลาที่ดึงล่าสุด) — ไม่เกินประมาณวันละ 4 ครั้ง + ตอน AcademicHub บันทึกกิจกรรม
  HOL_MEM = { readAt: Date.now(), items, periods, syncedAt: Date.parse(at) };
  if (changed) await bumpSync(env, ["main"]); // [v1.74.3] หน้าเว็บโหลดวันหยุด/กิจกรรมใหม่
  return { items, periods, changed };
}
// [v1.74] ขยายกิจกรรมรายคาบเป็นรายวัน: { date, mode: 'noclass'|'activity', title, grades, rooms, periods: ['A','B','1'…] | 'all' }
function expandHubPeriods(list) {
  const out = []; const y0 = new Date().getUTCFullYear();
  const push = (start, h) => {
    const s0 = Date.parse(start + "T00:00:00Z"); if (isNaN(s0)) return;
    const n = h.days ? h.days.length : Math.min(62, Math.round((Date.parse(h.endDate + "T00:00:00Z") - Date.parse(h.date + "T00:00:00Z")) / 86400e3) + 1);
    for (let i = 0; i < n && i < 62; i++) {
      const ps = h.days ? (Array.isArray(h.days[i]) ? h.days[i].map(String) : []) : "all";
      if (ps !== "all" && !ps.length) continue;
      out.push({ date: ymd(new Date(s0 + i * 86400e3)), mode: h.mode === "activity" ? "activity" : "noclass", holiday: h.mode === "holiday", title: String(h.title || "").slice(0, 120),
        grades: (h.grades || []).map(String), rooms: (h.rooms || []).map(String), periods: ps, id: String(h.id || "") });
    }
  };
  for (const h of list || []) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(h.date || "")) continue;
    if (!h.repeatYearly) { push(h.date, h); continue; }
    const baseY = Number(h.date.slice(0, 4));
    for (let y = Math.max(baseY, y0 - 1); y <= y0 + 1; y++) { const s = y + h.date.slice(4); if (ymd(new Date(s + "T00:00:00Z")) === s) push(s, h); }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date)).slice(0, 2000);
}
async function readHubPeriods(env) { await readHubHolidays(env); return HOL_MEM.periods || []; }
// รายการกิจกรรม/หยุดเรียนของห้อง วัน คาบ (คาบเป็นป้าย A B 1–8) — หยุดเรียนมาก่อนกิจกรรม
function periodEntryFor(list, roomId, date, label) {
  const g = (/^m(\d)_/.exec(roomId) || [])[1] || "";
  const hit = (list || []).filter(e => e.date === date && (e.periods === "all" || e.periods.includes(String(label))) && ((!e.grades.length && !e.rooms.length) || e.grades.includes(g) || e.rooms.includes(roomId)));
  return hit.find(e => e.mode === "noclass") || hit[0] || null;
}
const hubLinked = (env) => !!(env.HUB && env.LINK_KEY);
// ===== [v1.73] ขั้น 3: AcademicHub เรียกข้อมูลห้อง/สมุดโฮมรูม (Service Binding ชื่อ ATT ฝั่ง AcademicHub + LINK_KEY เดียวกัน) =====
function sameKey(a, b) { a = String(a || ""); b = String(b || ""); if (!a || a.length !== b.length) return false; let d = 0; for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i); return d === 0; }
function roomName(roomId) { const m = /m(\d+)_(\d+)/.exec(String(roomId || "")); return m ? `ม.${m[1]}/${m[2]}` : String(roomId || "-"); }
function roomList(settings) { const out = []; const rc = settings.roomCounts || {}; for (let i = 1; i <= 6; i++) for (let j = 1; j <= (Number(rc["m" + i]) || 0); j++) out.push(`m${i}_${j}`); return out; }
function nearestPersonnel(reg, roomId, term, year) {
  if (!reg) return null;
  const keys = Object.keys(reg).filter(k => reg[k] && typeof reg[k] === "object" && !Array.isArray(reg[k]) && reg[k][roomId]);
  if (!keys.length) return null;
  keys.sort((a, b) => { const [at, ay] = a.split("_"), [bt, by] = b.split("_"); const d = Math.abs(+ay - +year) - Math.abs(+by - +year); return d || (Math.abs(+at - +term) - Math.abs(+bt - +term)); });
  return reg[keys[0]][roomId];
}
function roomAdvisors(st, roomId, term, year) {
  const k = `${term}_${year}`, a = st.advisors || {};
  const v = (a[k] && a[k][roomId]) || (Array.isArray(a[roomId]) ? a[roomId] : null) || nearestPersonnel(a, roomId, term, year) || [];
  return (Array.isArray(v) ? v : [v]).map(x => String(x || "").trim()).filter(Boolean);
}
function roomStaff(st, roomId, term, year) {
  const k = `${term}_${year}`, s2 = st.staffs || {};
  return (s2[k] && s2[k][roomId]) || (typeof s2[roomId] === "string" ? s2[roomId] : "") || nearestPersonnel(s2, roomId, term, year) || "";
}
function linkRooms(main, hubId, tp) {
  const st = main.settings || {}, term = String(tp && tp.term || st.term || "1"), year = String(tp && tp.year || st.year || ""); // [v1.74.2] ภาคเรียนจาก AcademicHub
  const byName = {}; (main.teachers || []).forEach(t => { byName[t.name] = t; });
  const rooms = roomList(st).map(r => ({ roomId: r, roomName: roomName(r), advisors: roomAdvisors(st, r, term, year).map(n => ({ name: n, hubId: (byName[n] && byName[n].hubId) || "" })) }));
  return { term, year, rooms: hubId ? rooms.filter(r => r.advisors.some(a => a.hubId === hubId)) : rooms };
}
const P_LABEL = p => (Number(p) === -2 ? "A" : (Number(p) === 0 ? "B" : String(p)));
function dowOf(ymd) { const d = new Date(ymd + "T00:00:00Z").getUTCDay(); return d === 0 ? 7 : d; }
// สมุดโฮมรูมของห้อง 1 เดือน — คิดแบบเดียวกับ "สรุปโฮมรูม" ในเว็บเช็คชื่อ (วันตามตาราง / วันหยุด / สอนวิชาอื่นแทน / จัด / ไม่ได้จัด / ยังไม่บันทึก)
async function linkHomeroomMonth(env, main, roomId, month) {
  if (!/^\d{4}-\d{2}$/.test(month)) throw new Error("เดือนไม่ถูกต้อง");
  const st = main.settings || {};
  const { results: lr } = await env.DB.prepare("SELECT data, term, year FROM homeroom_logs WHERE room_id = ? AND date LIKE ? ORDER BY date").bind(roomId, month + "-%").all();
  const logs = lr.map(r => { try { return JSON.parse(r.data); } catch (e) { return null; } }).filter(Boolean);
  let term = String(st.term || "1"), year = String(st.year || "");
  if (lr.length) { term = String(lr[0].term); year = String(lr[0].year); }
  const subs = (main.subjects || []).filter(x => x.roomId === roomId && String(x.term ?? st.term) === term && String(x.year ?? st.year) === year);
  let hr = subs.find(x => x.systemType === "homeroom");
  if (!hr && !lr.length) { // เดือนนี้ไม่มีบันทึก — ลองหาคาบโฮมรูมของเทอมอื่นในปีเดียวกัน
    hr = (main.subjects || []).find(x => x.roomId === roomId && x.systemType === "homeroom");
    if (hr) { term = String(hr.term ?? st.term); year = String(hr.year ?? st.year); }
  }
  if (!hr) throw new Error("ห้อง " + roomName(roomId) + " ยังไม่มีคาบโฮมรูมในเว็บเช็คชื่อ");
  const roomSubs = (main.subjects || []).filter(x => x.roomId === roomId && String(x.term ?? st.term) === term && String(x.year ?? st.year) === year);
  const others = roomSubs.filter(o => !o.systemType && o.id !== hr.id);
  const hubHol = await readHubHolidays(env);
  const holOf = d => (st.holidays || []).find(h => h.date === d) || hubHol.find(h => h.date === d) || null;
  const { results: ar } = await env.DB.prepare("SELECT date, data FROM attendance WHERE subject_id = ? AND date LIKE ?").bind(hr.id, month + "-%").all();
  const countOf = {};
  ar.forEach(r => { let rec; try { rec = JSON.parse(r.data); } catch (e) { return; } const c = countOf[r.date] || (countOf[r.date] = { present: 0, late: 0, leave: 0, absent: 0 });
    Object.values(rec.records || {}).forEach(v => { if (v === "มา" || v === "ร่วมกิจกรรม") c.present++; else if (v === "สาย") c.late++; else if (v === "ลาป่วย" || v === "ลากิจ") c.leave++; else c.absent++; }); });
  const [y, m] = month.split("-").map(Number); const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const rows = [];
  for (let d = 1; d <= last; d++) {
    const ds = `${month}-${String(d).padStart(2, "0")}`; const hol = holOf(ds);
    const real = dowOf(ds); if (real >= 6 && !(hol && hol.type === "makeup")) continue;
    const eff = hol && hol.type === "makeup" && hol.useDayOfWeek ? parseInt(hol.useDayOfWeek) : real;
    const raw = (hr.schedules || []).find(sc => parseInt(sc.day) === eff); if (!raw) continue;
    const row = { date: ds, dow: real, kind: "", text: "", log: null, counts: countOf[ds] || null };
    const overridden = others.find(o => (o.schedules || []).some(sc => parseInt(sc.day) === eff && parseInt(sc.period) === parseInt(raw.period)));
    const pe = periodEntryFor(HOL_MEM.periods || [], roomId, ds, P_LABEL(raw.period)); // [v1.74]
    if (hol && (!hol.type || hol.type === "holiday")) { row.kind = "holiday"; row.text = "วันหยุด: " + (hol.label || ""); }
    else if (pe && pe.mode === "noclass") { row.kind = "holiday"; row.text = (pe.holiday ? "วันหยุด: " : "หยุดเรียน: ") + pe.title; }
    else if (overridden) { row.kind = "override"; row.text = `คาบ ${P_LABEL(raw.period)} มีการสอน ${overridden.name || "วิชาอื่น"} แทนโฮมรูม`; }
    else {
      const lg = logs.find(l => l.date === ds);
      if (lg) { row.kind = lg.held ? "held" : "not"; row.log = { held: !!lg.held, activity: lg.activity || "", note: lg.note || "", reason: lg.reason || "", recordedBy: lg.recordedBy || "", recordedAt: lg.recordedAt || "", editCount: lg.editCount || 0, photos: (lg.photos || []).map(p => ({ id: p.id })) }; }
      else if (pe) { row.kind = "override"; row.text = `คาบ ${P_LABEL(raw.period)} มีกิจกรรม: ${pe.title}`; } // [v1.74] กิจกรรมของโรงเรียน (บันทึกโฮมรูมได้ถ้าต้องการ)
      else { row.kind = "none"; row.text = "ยังไม่ได้บันทึก"; }
    }
    rows.push(row);
  }
  const adv = roomAdvisors(st, roomId, term, year);
  return { roomId, roomName: roomName(roomId), month, term, year, school: st.title || "", rows, advisors: adv, staff: roomStaff(st, roomId, term, year) };
}
// ===== [v1.73.1] ขั้น 4: รายการ "ยังไม่ได้เช็คชื่อ / ยังไม่บันทึกโฮมรูม" ของครูที่ผูกกับ AcademicHub (ให้กระดิ่งของ AcademicHub) =====
// ย้อนหลัง 7 วัน · วันนี้นับเฉพาะคาบที่หมดเวลาแล้ว · ข้ามวันหยุด/ครึ่งวัน · ข้ามวันที่ทั้งโรงเรียนไม่มีการเช็คชื่อเลย (ปิดภาคเรียน/วันหยุดที่ไม่ได้ลง)
const PERIOD_END = { "-2": "08:00", "0": "08:30", "1": "09:20", "2": "10:10", "3": "11:10", "4": "12:00", "5": "13:50", "6": "14:40", "7": "15:30", "8": "16:20" };
const PENDING_DAYS = 7;
let PENDING_IDX = false;
async function ensurePendingIndexes(env) {
  if (PENDING_IDX) return; PENDING_IDX = true;
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_attendance_date ON attendance (date)").run(); } catch (e) { /* ข้าม */ }
  try { await env.DB.prepare("CREATE INDEX IF NOT EXISTS idx_homeroom_logs_date ON homeroom_logs (date)").run(); } catch (e) { /* ข้าม */ }
}
function thaiNow() { const d = new Date(Date.now() + 7 * 3600e3); return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) }; }
async function linkPending(env, main, tp) {
  await ensurePendingIndexes(env);
  const st = main.settings || {}, term = String(tp && tp.term || st.term || "1"), year = String(tp && tp.year || st.year || ""); // [v1.74.2] ภาคเรียนจาก AcademicHub
  const now = thaiNow();
  const dates = []; for (let i = PENDING_DAYS - 1; i >= 0; i--) dates.push(ymd(new Date(Date.parse(now.date + "T00:00:00Z") - i * 86400e3)));
  const hubHol = await readHubHolidays(env), hubPer = HOL_MEM.periods || [];
  const holOf = d => (st.holidays || []).find(h => h.date === d) || hubHol.find(h => h.date === d) || null;
  const hubOfName = {}; (main.teachers || []).forEach(t => { if (t.hubId) hubOfName[String(t.name || "").trim()] = t.hubId; });
  const out = {}; const box = id => out[id] || (out[id] = { att: [], hr: [], rooms: [] });
  const advOf = {}; roomList(st).forEach(r => { advOf[r] = roomAdvisors(st, r, term, year).map(n => hubOfName[n]).filter(Boolean); advOf[r].forEach(h => { const b = box(h); if (!b.rooms.includes(r)) b.rooms.push(r); }); });
  const subs = (main.subjects || []).filter(x => String(x.term ?? st.term) === term && String(x.year ?? st.year) === year && x.roomId);
  if (!subs.length) return { term, year, at: new Date().toISOString(), teachers: out };
  const from = dates[0], to = dates[dates.length - 1];
  const { results: ar } = await env.DB.prepare("SELECT subject_id, date, period FROM attendance WHERE date BETWEEN ? AND ?").bind(from, to).all();
  const done = new Set(ar.map(r => r.subject_id + "|" + r.date + "|" + String(r.period)));
  const activeDay = new Set(ar.map(r => r.date));
  const hrOn = st.recordHomeroom !== false;
  let logged = new Set();
  if (hrOn) { const { results: lr } = await env.DB.prepare("SELECT room_id, date FROM homeroom_logs WHERE date BETWEEN ? AND ?").bind(from, to).all(); logged = new Set(lr.map(r => r.room_id + "|" + r.date)); }
  const regular = subs.filter(x => !x.systemType);
  for (const ds of dates) {
    if (!activeDay.has(ds)) continue;
    const hol = holOf(ds); const real = dowOf(ds);
    if (hol && (!hol.type || hol.type === "holiday") && (!hol.duration || hol.duration === "full")) continue;
    if (real >= 6 && !(hol && hol.type === "makeup")) continue;
    const eff = hol && hol.type === "makeup" && hol.useDayOfWeek ? parseInt(hol.useDayOfWeek) : real;
    const half = hol && (!hol.type || hol.type === "holiday") ? hol.duration : "";
    for (const sub of subs) {
      for (const sc of (sub.schedules || [])) {
        if (parseInt(sc.day) !== eff) continue;
        const p = parseInt(sc.period);
        if (half === "morning" && p <= 4) continue;
        if (half === "afternoon" && p >= 5) continue;
        if (ds === now.date && now.hm < (PERIOD_END[String(p)] || "23:59")) continue;
        if (periodEntryFor(hubPer, sub.roomId, ds, P_LABEL(p))) continue; // [v1.74] คาบหยุดเรียน/กิจกรรม (ไม่บังคับเช็ค)
        if (sub.systemType && regular.some(o => o.roomId === sub.roomId && (o.schedules || []).some(x => parseInt(x.day) === eff && parseInt(x.period) === p))) continue; // คาบระบบที่มีวิชาอื่นสอนแทน
        const ids = sub.systemType ? (advOf[sub.roomId] || []) : [sub.teacher, sub.teacher2].map(n => hubOfName[String(n || "").trim()]).filter(Boolean);
        if (!ids.length) continue;
        if (sub.systemType === "homeroom" && hrOn) {
          if (logged.has(sub.roomId + "|" + ds)) continue;
          ids.forEach(h => box(h).hr.push({ date: ds, roomId: sub.roomId, room: roomName(sub.roomId) }));
          continue;
        }
        if (done.has(sub.id + "|" + ds + "|" + String(p))) continue;
        const kind = sub.systemType === "morning" ? "morning" : (sub.systemType === "zone" ? "zone" : (sub.systemType === "homeroom" ? "homeroom" : "class"));
        [...new Set(ids)].forEach(h => box(h).att.push({ date: ds, period: P_LABEL(p), p, room: roomName(sub.roomId), roomId: sub.roomId, subject: String(sub.name || "").slice(0, 60), kind }));
      }
    }
  }
  Object.values(out).forEach(b => { b.att.sort((a, c) => a.date.localeCompare(c.date) || a.p - c.p); b.hr = b.hr.filter((x, i, arr) => arr.findIndex(y => y.date === x.date && y.roomId === x.roomId) === i); });
  return { term, year, at: new Date().toISOString(), teachers: out };
}
// ===== [v1.74.1] ตารางสอนรายสัปดาห์ของครู (AcademicHub ปุ่ม "ตารางสอน") + ตารางเรียนห้องที่เป็นครูที่ปรึกษา =====
// วิชาปกติ = ครูผู้สอน/ผู้สอนร่วม · คาบระบบ (โฮมรูม/เข้าแถว/เขตพื้นที่) = ครูที่ปรึกษา · คาบระบบที่มีวิชาปกติลงทับ = ตัดออก (เหมือน effSched ในหน้าเว็บ)
function linkTimetable(main, hubId, tp) {
  const st = main.settings || {}, term = String(tp && tp.term || st.term || "1"), year = String(tp && tp.year || st.year || ""); // [v1.74.2] ภาคเรียนจาก AcademicHub
  const nameOf = {}; (main.teachers || []).forEach(t => { nameOf[String(t.name || "").trim()] = t.hubId || ""; });
  const me = (main.teachers || []).find(t => t.hubId === hubId) || null;
  const subs = (main.subjects || []).filter(x => String(x.term ?? st.term) === term && String(x.year ?? st.year) === year && x.roomId);
  const eff = (s) => {
    const list = s.schedules || [];
    if (!s.systemType) return list;
    const others = subs.filter(o => o.roomId === s.roomId && !o.systemType && o.id !== s.id);
    return list.filter(sc => !others.some(o => (o.schedules || []).some(os => parseInt(os.day) === parseInt(sc.day) && parseInt(os.period) === parseInt(sc.period))));
  };
  const KIND = { homeroom: "โฮมรูม", morning: "เข้าแถว", zone: "เขตพื้นที่" };
  const slotOf = (s, sc) => ({ day: parseInt(sc.day), period: parseInt(sc.period), code: String(s.code || ""), subject: String(KIND[s.systemType] || s.name || ""), roomId: s.roomId, room: roomName(s.roomId), system: s.systemType || "",
    teachers: (s.systemType ? roomAdvisors(st, s.roomId, term, year) : [s.teacher, s.teacher2]).map(n => String(n || "").trim()).filter(Boolean) });
  const mine = [];
  if (me) subs.forEach(s => {
    const ids = s.systemType ? roomAdvisors(st, s.roomId, term, year).map(n => nameOf[n]) : [s.teacher, s.teacher2].map(n => nameOf[String(n || "").trim()]);
    if (!ids.includes(hubId)) return;
    eff(s).forEach(sc => mine.push(slotOf(s, sc)));
  });
  const advRooms = me ? roomList(st).filter(r => roomAdvisors(st, r, term, year).some(n => nameOf[n] === hubId)) : [];
  const rooms = advRooms.map(r => ({ roomId: r, roomName: roomName(r), slots: subs.filter(s => s.roomId === r).flatMap(s => eff(s).map(sc => slotOf(s, sc))) }));
  return { term, year, linked: !!me, teacherName: me ? me.name : "", slots: mine, rooms };
}
async function handleLink(env, payload) {
  if (!env.LINK_KEY || !sameKey(payload.linkKey, env.LINK_KEY)) return jsonResponse({ status: "error", message: "รหัสเชื่อมระบบ (LINK_KEY) ไม่ตรงกัน" }, 403);
  const main = await readMainRO(env); // [v1.74.4] อ่านอย่างเดียว
  try {
    // [v1.74.2] AcademicHub ส่งภาคเรียน/ปีการศึกษาปัจจุบันของตัวเองมา (term/year) — ใช้แทนภาคเรียนที่ตั้งในเว็บเช็คชื่อ
    const tp = /^[123]$/.test(String(payload.term || "")) && /^\d{4}$/.test(String(payload.year || "")) ? { term: String(payload.term), year: String(payload.year) } : null;
    if (payload.op === "rooms") return jsonResponse({ status: "success", ...linkRooms(main, String(payload.hubId || ""), tp) });
    if (payload.op === "sync") { const r = await syncHubHolidays(env); return jsonResponse({ status: "success", holidays: r.items.length, periods: r.periods.length }); } // [v1.74] AcademicHub บันทึกกิจกรรมแล้วสั่งดึงใหม่ทันที
    if (payload.op === "timetable") return jsonResponse({ status: "success", ...linkTimetable(main, String(payload.hubId || ""), tp) });
    if (payload.op === "pending") return jsonResponse({ status: "success", ...(await linkPending(env, main, tp)) });
    if (payload.op === "month") return jsonResponse({ status: "success", model: await linkHomeroomMonth(env, main, String(payload.roomId || ""), String(payload.month || "")) });
    if (payload.op === "photo") {
      const id = String(payload.id || ""), roomId = String(payload.roomId || "");
      if (!/^[A-Za-z0-9_-]{10,}$/.test(id)) return jsonResponse({ status: "error", message: "รหัสรูปไม่ถูกต้อง" }, 400);
      const hit = await env.DB.prepare("SELECT 1 AS ok FROM homeroom_logs WHERE room_id = ? AND data LIKE ? LIMIT 1").bind(roomId, '%"' + id + '"%').first();
      if (!hit) return jsonResponse({ status: "error", message: "ไม่พบรูปนี้ในบันทึกโฮมรูมของห้อง" }, 404);
      if (!DRIVE_RELAY_URL) return jsonResponse({ status: "error", message: "ยังไม่ได้ตั้งค่า DRIVE_RELAY_URL" }, 500);
      const res = await fetch(DRIVE_RELAY_URL, { method: "POST", headers: { "Content-Type": "text/plain;charset=utf-8" }, body: JSON.stringify({ action: "get", id, token: RELAY_TOKEN }), redirect: "follow" });
      return new Response(res.body, { status: 200, headers: { "Content-Type": "application/json; charset=utf-8" } }); // ส่งต่อทั้งก้อน ไม่แกะ (ประหยัด CPU)
    }
    return jsonResponse({ status: "error", message: "ไม่รู้จักคำสั่งเชื่อมระบบ" }, 400);
  } catch (e) { return jsonResponse({ status: "error", message: String(e.message || e) }); }
}
// ===== [v1.74] ล้างข้อมูลรายวิชา/รายวัน: ลบบันทึกกิจกรรมของคาบโฮมรูม/เขตพื้นที่ และย้ายรูปลงถังขยะของ Drive (กู้คืนได้ 30 วัน) =====
// ทั้งวิชา (คาบโฮมรูม/เขตพื้นที่) = ย้ายทั้งโฟลเดอร์ห้องของภาคเรียนนั้น (1 คำขอ) · รายวัน/รูปสอนแทน = ย้ายทีละรูป (ไม่เกิน 40 รูปต่อครั้ง)
function photoFolderPath(kind, term, year, roomId) { return `${kind === "zone" ? "เขตพื้นที่" : "โฮมรูม"}/ปีการศึกษา ${year}/ภาคเรียน ${term}/ห้อง ${roomName(roomId).replace(/\//g, "-")}`; }
async function resetPhotosOf(env, subjectId, roomId, term, year, date) {
  const out = { photosTrashed: 0, photosFailed: 0, logsDeleted: 0 };
  try {
    const main = await readMainData(env);
    const sub = (main.subjects || []).find(x => x.id === subjectId);
    if (!sub) return out;
    roomId = roomId || sub.roomId; term = term || String(sub.term ?? (main.settings || {}).term); year = year || String(sub.year ?? (main.settings || {}).year);
    const ids = [];
    // รูปสอนแทนในข้อมูลเช็คชื่อ
    const q = date ? env.DB.prepare("SELECT data FROM attendance WHERE subject_id = ? AND date = ?").bind(subjectId, date)
      : env.DB.prepare("SELECT data FROM attendance WHERE subject_id = ? AND term = ? AND year = ? AND room_id = ?").bind(subjectId, term, year, roomId);
    (await q.all()).results.forEach(r => { try { const a = JSON.parse(r.data); if (a && a.subPhoto && a.subPhoto.id) ids.push(a.subPhoto.id); } catch (e) { /* ข้าม */ } });
    const kind = sub.systemType === "homeroom" ? "homeroom" : (sub.systemType === "zone" ? "zone" : "");
    let folderTrash = null;
    if (kind) {
      const store = kind === "zone" ? `${roomId}#zone` : roomId;
      const lq = date ? env.DB.prepare("SELECT data FROM homeroom_logs WHERE room_id = ? AND date = ?").bind(store, date)
        : env.DB.prepare("SELECT data FROM homeroom_logs WHERE room_id = ? AND term = ? AND year = ?").bind(store, term, year);
      const logs = (await lq.all()).results;
      if (date) logs.forEach(r => { try { (JSON.parse(r.data).photos || []).forEach(p => p && p.id && ids.push(p.id)); } catch (e) { /* ข้าม */ } });
      else if (logs.length) folderTrash = photoFolderPath(kind, term, year, roomId);
      const del = date ? await env.DB.prepare("DELETE FROM homeroom_logs WHERE room_id = ? AND date = ?").bind(store, date).run()
        : await env.DB.prepare("DELETE FROM homeroom_logs WHERE room_id = ? AND term = ? AND year = ?").bind(store, term, year).run();
      out.logsDeleted = (del && del.meta && del.meta.changes) || 0;
    }
    if (folderTrash) { const r = await forwardToDrive({ action: "trashPath", path: folderTrash }).catch(() => null); if (r && r.status === "success") out.photosTrashed++; else out.photosFailed++; }
    const uniq = [...new Set(ids)];
    for (const id of uniq.slice(0, 40)) { const r = await forwardToDrive({ action: "trash", id }).catch(() => null); if (r && r.status === "success") out.photosTrashed++; else out.photosFailed++; }
    out.photosFailed += Math.max(0, uniq.length - 40);
  } catch (e) { out.photosFailed++; }
  return out;
}
const ADMIN_GET = ["hub_teachers", "hub_holidays_sync", "get_logs", "get_storage_info", "list_archives", "list_snapshots", "get_archive", "get_subject_dates"];
const ADMIN_POST = ["bulk_import", "save_manual_archive", "restore_snapshot", "restore_snapshot_attendance", "force_clean_main_file", "ensure_room_files",
  "reset_subject_attendance", "reset_subject_date", "reset_all_attendance", "relay_folder_trash", "subject_save"];
const needLogin = () => jsonResponse({ status: "error", code: "auth", message: "ต้องเข้าสู่ระบบผู้ดูแลก่อน (หรือหมดเวลาเข้าสู่ระบบแล้ว กรุณาเข้าสู่ระบบใหม่)" }, 401);

export default {
  async fetch(request, env, ctx) {
    const reqT0 = Date.now(); // [v1.74.6] วัดเวลาแยกขั้น
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const action = url.searchParams.get("action");

    try {
      if (request.method === "GET") {
        const getToken = url.searchParams.get("token") || "";
        if (ADMIN_GET.includes(action) && !(await verifyToken(env, getToken))) return needLogin();
        // ===== [v1.72] รายชื่อบุคลากรจาก AcademicHub (ผู้ดูแลเท่านั้น) =====
        if (action === "hub_teachers") {
          try { const d = await callHub(env, "linkTeachers", {}); return jsonResponse({ status: "success", teachers: d.teachers || [], at: d.at || "" }); }
          catch (e) { return jsonResponse({ status: "error", message: String(e.message || e) }); }
        }

        if (action === "hub_holidays_sync") {
          try { const r = await syncHubHolidays(env); return jsonResponse({ status: "success", holidays: r.items, periods: r.periods, changed: r.changed }); }
          catch (e) { return jsonResponse({ status: "error", message: String(e.message || e) }); }
        }

        // ===== ดึงข้อมูลเช็คชื่อของ "เทอม/ปี/ห้อง" หนึ่ง ๆ จากตาราง D1 =====
        if (action === "get_attendance") {
          const term = url.searchParams.get("term"), year = url.searchParams.get("year"), room = url.searchParams.get("room");
          if (!term || !year || !room) return jsonResponse({ status: "error", message: "missing term/year/room parameter" }, 400);
          await ensureAttIndexes(env);
          const { results } = await env.DB.prepare(
            "SELECT data, updated_at FROM attendance WHERE term = ? AND year = ? AND room_id = ?"
          ).bind(term, year, room).all();
          const attendanceData = results.map(r => JSON.parse(r.data));
          const lastModified = results.reduce((max, r) => Math.max(max, r.updated_at), 0);
          let syncV = 0; try { await ensureSyncTable(env); const sv = await env.DB.prepare("SELECT v FROM sync_meta WHERE k = ?").bind(roomSyncKey(term, year, room)).first(); syncV = (sv && sv.v) || 0; } catch (e) { /* ข้าม */ } // [v1.74.3]
          return jsonResponse({ status: "success", term, year, room, attendanceData, lastModified, syncV });
        }

        // ===== เช็คเวลาที่ข้อมูลห้องนี้ถูกแก้ไขล่าสุด แบบเบาๆ (แค่ query MAX(updated_at) ไม่ดึงข้อมูลเต็ม) =====
        // ===== [v1.71] บันทึกกิจกรรมโฮมรูมของห้องหนึ่งในเทอม/ปี =====
        if (action === "get_homeroom_logs") {
          const term = url.searchParams.get("term"), year = url.searchParams.get("year"), room = url.searchParams.get("room");
          const { results } = await env.DB.prepare(
            "SELECT data FROM homeroom_logs WHERE term = ? AND year = ? AND room_id = ? ORDER BY date"
          ).bind(term, year, room).all();
          return jsonResponse({ status: "success", logs: results.map(r => JSON.parse(r.data)) });
        }

        // ===== [v1.74.3] ตรวจการเปลี่ยนแปลงทั้งหมดในคำขอเดียว (ข้อมูลหลัก + ทุกห้อง) =====
        if (action === "sync_meta") {
          await ensureSyncTable(env);
          const { results } = await env.DB.prepare("SELECT k, v FROM sync_meta").all();
          const out = { status: "success", syncMeta: true, main: 0, all: 0, rooms: {} };
          results.forEach(r => { if (r.k === "main") out.main = r.v; else if (r.k === "all") out.all = r.v; else if (r.k.startsWith("room|")) out.rooms[r.k.slice(5)] = r.v; });
          return jsonResponse(out);
        }
        if (action === "get_attendance_meta") {
          const term = url.searchParams.get("term"), year = url.searchParams.get("year"), room = url.searchParams.get("room");
          if (!term || !year || !room) return jsonResponse({ status: "error", message: "missing term/year/room parameter" }, 400);
          const row = await env.DB.prepare(
            "SELECT MAX(updated_at) as maxUpdated FROM attendance WHERE term = ? AND year = ? AND room_id = ?"
          ).bind(term, year, room).first();
          return jsonResponse({ status: "success", term, year, room, lastModified: (row && row.maxUpdated) || 0 });
        }

        // ===== [ใหม่] ดึงรายชื่อ "วันที่" ที่วิชานี้มีข้อมูลเช็คชื่ออยู่ (พร้อมจำนวนรายการ) - ใช้ช่วยแอดมินเลือกวันที่จะล้างข้อมูลได้ถูกจุด ไม่ต้องเดา =====
        if (action === "get_subject_dates") {
          const subjectId = url.searchParams.get("subjectId");
          if (!subjectId) return jsonResponse({ status: "error", message: "missing subjectId parameter" }, 400);
          const { results } = await env.DB.prepare(
            "SELECT date, COUNT(*) as cnt FROM attendance WHERE subject_id = ? GROUP BY date ORDER BY date DESC"
          ).bind(subjectId).all();
          return jsonResponse({ status: "success", dates: results });
        }

        // ===== ดึงประวัติ log (500 รายการล่าสุด) =====
        if (action === "get_logs") {
          const { results } = await env.DB.prepare(
            "SELECT * FROM logs ORDER BY timestamp DESC LIMIT 500"
          ).all();
          results.reverse(); // เรียงเก่า -> ใหม่ ให้ตรงกับที่หน้าเว็บคาดหวัง
          return jsonResponse({ status: "success", logs: results });
        }

        // ===== [เฟส 2] รายงานขนาดข้อมูลที่ใช้ไป - ไฟล์หลัก (KV) + แยกรายห้องจาก D1 =====
        // [แก้ไข] เดิมใช้ SUM(LENGTH(data)) ซึ่งต้องอ่านเนื้อหาทุกแถวมาวัดขนาดจริง กิน CPU time เกินโควต้าฟรีของ
        // Workers เมื่อมีข้อมูลสะสมเยอะ (ค้าง/ล้มเหลวเงียบๆ) เปลี่ยนเป็นนับจำนวนแถวอย่างเดียว (เร็วมาก ใช้ index ได้)
        // แล้วประมาณขนาดคร่าวๆ แทนการวัดจริงทุกแถว เพียงพอสำหรับดูภาพรวมแล้ว
        if (action === "get_storage_info") {
          const AVG_RECORD_BYTES = 350; // ค่าประมาณคร่าวๆ ต่อ 1 รายการเช็คชื่อ (พอเป็นภาพรวม ไม่ต้องแม่นยำเป๊ะ)
          const mainRaw = await env.MAIN_KV.get(MAIN_KEY);
          const mainFile = mainRaw ? { name: "main_db (KV)", sizeBytes: new TextEncoder().encode(mainRaw).length } : null;

          const { results: roomRows } = await env.DB.prepare(
            `SELECT term, year, room_id, COUNT(*) as cnt FROM attendance GROUP BY term, year, room_id`
          ).all();
          const attendanceFiles = roomRows.map(r => ({ term: r.term, year: r.year, room: r.room_id, name: `ห้อง ${r.room_id} (D1 - ${r.cnt} รายการ, ขนาดโดยประมาณ)`, sizeBytes: r.cnt * AVG_RECORD_BYTES }));

          const logsRow = await env.DB.prepare(`SELECT COUNT(*) as cnt FROM logs`).first();
          const logsFile = logsRow && logsRow.cnt > 0 ? { name: "logs (D1)", sizeBytes: logsRow.cnt * 150 } : null;

          return jsonResponse({ status: "success", mainFile, logsFile, mainFileHasLeftoverAttendance: false, attendanceFiles });
        }

        // ===== [เฟส 2] รายชื่อไฟล์เก็บถาวร (จากนโยบาย retention เดิม) - ระบบใหม่ไม่จำเป็นต้องมีนโยบายนี้แล้ว
        // เพราะ D1 มีความจุมาก (5GB) รองรับข้อมูลได้นานโดยไม่ต้องย้ายออก จึงตอบรายการว่างเปล่าเสมอ กันหน้าเว็บพัง =====
        if (action === "list_archives") {
          return jsonResponse({ status: "success", archives: [] });
        }

        // ===== [เฟส 2] รายชื่อ snapshot สำรองข้อมูลทั้งหมด =====
        if (action === "list_snapshots") {
          const { results } = await env.DB.prepare(
            "SELECT id, type, label, created_at, LENGTH(data) as sizeBytes FROM snapshots ORDER BY created_at DESC LIMIT 200"
          ).all();
          const snapshots = results.map(r => ({
            name: r.label || `${r.type}_${new Date(r.created_at).toISOString()}`,
            id: r.id, type: r.type,
            dateCreated: new Date(r.created_at).toISOString(),
            sizeBytes: r.sizeBytes, corrupted: false,
            isAttendance: r.type === "attendance_room",
          }));
          return jsonResponse({ status: "success", snapshots });
        }

        // ===== [เฟส 2] เนื้อหา snapshot ตัวหนึ่ง (ใช้ id แทนชื่อไฟล์แบบเดิม) =====
        if (action === "get_archive") {
          const id = url.searchParams.get("file") || url.searchParams.get("id");
          if (!id) return jsonResponse({ status: "error", message: "missing id" }, 400);
          const row = await env.DB.prepare("SELECT data FROM snapshots WHERE id = ?").bind(id).first();
          if (!row) return jsonResponse({ status: "error", message: "snapshot not found" }, 404);
          return new Response(row.data, { headers: { "Content-Type": "application/json; charset=utf-8", ...CORS_HEADERS } });
        }

        // ===== [ตัดออก] get_external_holidays เคยพร็อกซีผ่าน Apps Script เดิม แต่ตัดสินใจเปลี่ยนกลับไปใช้ตารางอ้างอิงฝังในโค้ดฝั่งเว็บแทน
        // (นิ่งกว่า ไม่ต้องพึ่งบริการภายนอกที่ไม่เสถียร และไม่ต้องพึ่ง Apps Script เดิมตลอดไป) =====

        // ===== ค่าเริ่มต้น (ไม่มี action): ส่งฐานข้อมูลหลักเท่านั้น =====
        const mainData = await readMainRO(env); // [v1.74.4]
        const viewer = getToken ? await verifyToken(env, getToken, mainData) : null;
        const responseData = { ...mainForClient(mainData, viewer), attendanceData: [], logs: [] };
        // [v1.72.1] วันหยุดเรียนจาก AcademicHub (หมดอายุ 6 ชั่วโมง → ดึงใหม่เบื้องหลัง ไม่ทำให้หน้าเว็บช้า)
        try { await ensureSyncTable(env); const { results: sm } = await env.DB.prepare("SELECT k, v FROM sync_meta WHERE k IN ('main', 'all')").all(); responseData.syncMain = 0; responseData.syncAll = 0; sm.forEach(r => { if (r.k === "main") responseData.syncMain = r.v; else responseData.syncAll = r.v; }); } catch (e) { /* ข้าม */ } // [v1.74.3]
        responseData.hubHolidays = await readHubHolidays(env); responseData.hubPeriods = HOL_MEM.periods || []; // [v1.74] กิจกรรม/หยุดเรียนรายคาบ
        if (hubLinked(env) && ctx && ctx.waitUntil && hubHolidaysStale()) { HOL_SYNCING = true; ctx.waitUntil(syncHubHolidays(env).catch(() => { HOL_MEM.syncedAt = Date.now() - HOL_STALE_MS + 30 * 60 * 1000; /* ติดต่อไม่ได้ — ลองใหม่ใน 30 นาที */ }).finally(() => { HOL_SYNCING = false; })); }
        if (getToken && !viewer) responseData.authExpired = true; // [v1.71.5] บัตรผ่านหมดอายุ — หน้าเว็บให้เข้าสู่ระบบใหม่
        return jsonResponse(responseData);
      }

      if (request.method === "POST") {
        const payload = await request.json();
        const postToken = payload && payload.__token; if (payload) delete payload.__token;

        // ===== [v1.73] AcademicHub เรียกผ่าน Service Binding (ตรวจ LINK_KEY) =====
        if (payload.__mode === "link") return handleLink(env, payload);

        // ===== [v1.71.5] เข้าสู่ระบบผู้ดูแล (ตรวจรหัสผ่านที่ Worker) =====
        if (payload.__mode === "login") {
          const mainData = await readMainData(env);
          const uname = String(payload.username || "").trim().toLowerCase(), ph = String(payload.passHash || "");
          const users = (mainData.settings && mainData.settings.users) || [];
          const u = users.find(x => String(x.username || "").toLowerCase() === uname);
          let ok = false, upgrade = false;
          if (u && ph) {
            if (isHashStr(u.password)) ok = u.password === ph;
            else if (u.password && (await sha256Hex(u.password)) === ph) { ok = true; upgrade = true; } // บัญชีเก่าที่ยังเก็บรหัสผ่านตรงๆ → เปลี่ยนเป็น hash
          }
          if (!ok) return jsonResponse({ status: "error", code: "badlogin", message: "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง" });
          if (upgrade) { u.password = ph; await writeMainData(env, mainData, ctx); }
          return jsonResponse({ status: "success", token: await makeToken(env, u), user: publicUser(u), users: users.map(publicUser), hours: TOKEN_HOURS });
        }

        // ===== [v1.71.5] งานของผู้ดูแลเท่านั้น =====
        let actor = null, gateMain = null, gateRaw = null;
        const isFullSave = !payload.__mode;
        if (ADMIN_POST.includes(payload.__mode) || isFullSave) {
          const raw = await env.MAIN_KV.get(MAIN_KEY); gateRaw = raw;
          gateMain = raw ? await readMainRO(env, raw) : null; // [v1.74.4] อ่าน/แปลงครั้งเดียว ใช้ต่อในการบันทึกเต็ม
          actor = await verifyToken(env, postToken, gateMain || undefined);
          // ติดตั้งครั้งแรก (ยังไม่มีข้อมูลหลักเลย) = บันทึก/นำเข้าได้โดยไม่ต้องเข้าสู่ระบบ
          if (!actor && !((isFullSave || payload.__mode === "bulk_import") && !hasMainData(raw))) return needLogin();
        }

        // ===== [v1.74.5] บันทึกวิชาแบบส่งเฉพาะวิชาที่แก้ (เพิ่ม/แก้/ล็อก/ลบ) — ไม่ต้องรับส่งข้อมูลหลักทั้งชุดไปกลับ =====
        if (payload.__mode === "subject_save") {
          const data = gateRaw ? JSON.parse(gateRaw) : emptyMainData(); // สำเนาแยก (ห้ามแก้ gateMain ซึ่งเป็นค่าที่จำไว้)
          if (!Array.isArray(data.subjects)) data.subjects = [];
          const up = (Array.isArray(payload.upsert) ? payload.upsert : []).filter(x => x && typeof x === "object" && x.id && x.roomId);
          const rm = new Set((Array.isArray(payload.remove) ? payload.remove : []).map(String));
          if (payload.mustExist) for (const x of up) if (!data.subjects.some(o => o.id === x.id)) return jsonResponse({ status: "error", code: "gone", message: "ไม่พบวิชานี้แล้ว (อาจถูกลบไปโดยผู้ใช้อื่น) กรุณาลองใหม่" });
          if (rm.size) data.subjects = data.subjects.filter(o => !rm.has(String(o.id)) || o.locked || o.systemType); // วิชาที่ล็อก/คาบระบบ ไม่ลบ
          for (const x of up) { const i = data.subjects.findIndex(o => o.id === x.id); if (i >= 0) data.subjects[i] = x; else data.subjects.push(x); }
          delete data.attendanceData; delete data.logs;
          const tw = Date.now();
          await writeMainData(env, data, ctx);
          return jsonResponse({ status: "success", subjects: data.subjects, timing: { read: tw - reqT0, write: Date.now() - tw } });
        }

        // ===== [ย้ายข้อมูลครั้งเดียว] รับข้อมูลชุดใหญ่จากระบบเดิมมาใส่ครั้งเดียว - ใช้เครื่องมือย้ายข้อมูลเท่านั้น =====
        if (payload.__mode === "bulk_import" && payload.mainData) {
          await writeMainData(env, payload.mainData, ctx);

          if (Array.isArray(payload.attendanceRecords)) {
            const now = Date.now();
            // เขียนทีละก้อน (batch) กัน request เดียวใหญ่เกินไป
            const BATCH = 50;
            for (let i = 0; i < payload.attendanceRecords.length; i += BATCH) {
              const chunk = payload.attendanceRecords.slice(i, i + BATCH);
              const stmts = chunk.map(item => env.DB.prepare(
                `INSERT INTO attendance (id, term, year, room_id, subject_id, date, period, data, updated_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(subject_id, date, period) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
              ).bind(genId(), item.term, item.year, item.roomId, item.record.subjectId, item.record.date, String(item.record.period), JSON.stringify(item.record), now));
              await env.DB.batch(stmts);
            }
          }

          if (Array.isArray(payload.logsRecords) && payload.logsRecords.length > 0) {
            const BATCH = 50;
            for (let i = 0; i < payload.logsRecords.length; i += BATCH) {
              const chunk = payload.logsRecords.slice(i, i + BATCH);
              const stmts = chunk.map(r => env.DB.prepare(
                `INSERT INTO logs (id, timestamp, username, name, action, details, category) VALUES (?, ?, ?, ?, ?, ?, ?)
                 ON CONFLICT(id) DO UPDATE SET timestamp = excluded.timestamp, username = excluded.username, name = excluded.name, action = excluded.action, details = excluded.details, category = excluded.category`
              ).bind(r.id || genId(), r.timestamp, r.username || "", r.name || "", r.action || "", r.details || "", r.category || "data"));
              await env.DB.batch(stmts);
            }
          }

          await bumpSync(env, ["all"]); // [v1.74.3]
          return jsonResponse({ status: "success", imported: { attendance: (payload.attendanceRecords || []).length, logs: (payload.logsRecords || []).length } });
        }

        // ===== [เฟส 2] เก็บถาวรข้อมูลเช็คชื่อแบบแมนวล (จากปุ่ม "เก็บถาวร" ในหน้าเว็บ) =====
        if (payload.__mode === "save_manual_archive" && payload.records) {
          const id = genId();
          await env.DB.prepare(
            "INSERT INTO snapshots (id, type, label, created_at, data) VALUES (?, ?, ?, ?, ?)"
          ).bind(id, "manual_archive", payload.filenamePrefix || "attendance_archive_manual", Date.now(), JSON.stringify(payload.records)).run();
          return jsonResponse({ status: "success" });
        }

        // ===== [เฟส 2] กู้คืนฐานข้อมูลหลักจาก snapshot ที่เลือก =====
        if (payload.__mode === "restore_snapshot" && payload.file) {
          const row = await env.DB.prepare("SELECT data FROM snapshots WHERE id = ?").bind(payload.file).first();
          if (!row) return jsonResponse({ status: "error", message: "ไม่พบ snapshot นี้" });
          let restoredData;
          try { restoredData = JSON.parse(row.data); } catch (e) { return jsonResponse({ status: "error", message: "ไฟล์ snapshot นี้เปิดอ่านไม่ได้ (เสียหาย)" }); }
          if (!isMainDataShapeValid(restoredData)) return jsonResponse({ status: "error", message: "ไฟล์ snapshot นี้มีข้อมูลไม่ครบ ปฏิเสธการกู้คืนเพื่อความปลอดภัย" });
          // สำรองสถานะปัจจุบันไว้ก่อนกู้คืนทับ (เผื่อกู้คืนผิดตัว ย้อนกลับได้)
          const currentMain = await readMainData(env);
          await env.DB.prepare("INSERT INTO snapshots (id, type, label, created_at, data) VALUES (?, ?, ?, ?, ?)")
            .bind(genId(), "main", "ก่อนกู้คืน_" + new Date().toISOString(), Date.now(), JSON.stringify(currentMain)).run();
          await writeMainData(env, restoredData, ctx);
          return jsonResponse({ status: "success", message: "กู้คืนข้อมูลเรียบร้อยแล้ว" });
        }

        // ===== [เฟส 2] กู้คืนข้อมูลเช็คชื่อของห้องหนึ่งจาก snapshot =====
        if (payload.__mode === "restore_snapshot_attendance" && payload.file && payload.term && payload.year && payload.roomId) {
          const row = await env.DB.prepare("SELECT data FROM snapshots WHERE id = ?").bind(payload.file).first();
          if (!row) return jsonResponse({ status: "error", message: "ไม่พบ snapshot นี้" });
          let restoredList;
          try { restoredList = JSON.parse(row.data); if (!Array.isArray(restoredList)) throw new Error("shape"); }
          catch (e) { return jsonResponse({ status: "error", message: "ไฟล์ snapshot นี้เปิดอ่านไม่ได้หรือรูปแบบไม่ถูกต้อง" }); }
          await env.DB.prepare("DELETE FROM attendance WHERE term = ? AND year = ? AND room_id = ?").bind(payload.term, payload.year, payload.roomId).run();
          await bumpSync(env, [roomSyncKey(payload.term, payload.year, payload.roomId)]); // [v1.74.3]
          const now = Date.now();
          const BATCH = 50;
          for (let i = 0; i < restoredList.length; i += BATCH) {
            const chunk = restoredList.slice(i, i + BATCH);
            const stmts = chunk.map(rec => env.DB.prepare(
              `INSERT INTO attendance (id, term, year, room_id, subject_id, date, period, data, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
            ).bind(genId(), payload.term, payload.year, payload.roomId, rec.subjectId, rec.date, String(rec.period), JSON.stringify(rec), now));
            await env.DB.batch(stmts);
          }
          return jsonResponse({ status: "success", message: "กู้คืนข้อมูลเช็คชื่อห้องนี้เรียบร้อยแล้ว" });
        }

        // ===== [เฟส 2] เผื่อความเข้ากันได้กับหน้าเว็บเดิม - D1 ไม่มีปัญหาไฟล์หลักปนข้อมูลเช็คชื่อ/ต้องสร้างไฟล์ล่วงหน้าแบบระบบเดิม จึงแค่ตอบสำเร็จเฉยๆ ไม่ต้องทำอะไรจริง =====
        if (payload.__mode === "force_clean_main_file") {
          return jsonResponse({ status: "success", cleaned: true });
        }
        if (payload.__mode === "ensure_room_files") {
          return jsonResponse({ status: "success", createdRooms: [] });
        }

        // ===== เช็คชื่อ: upsert 1 แถวในตาราง attendance (subject_id+date+period เป็นคีย์ไม่ซ้ำ) =====
        if (payload.__mode === "upsert_attendance" && payload.record && payload.term && payload.year && payload.roomId) {
          const rec = payload.record;
          const now = Date.now();
          await env.DB.prepare(
            `INSERT INTO attendance (id, term, year, room_id, subject_id, date, period, data, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(subject_id, date, period) DO UPDATE SET
               data = excluded.data, updated_at = excluded.updated_at, term = excluded.term, year = excluded.year, room_id = excluded.room_id`
          ).bind(genId(), payload.term, payload.year, payload.roomId, rec.subjectId, rec.date, String(rec.period), JSON.stringify(rec), now).run();
          const bk = bumpSync(env, [roomSyncKey(payload.term, payload.year, payload.roomId)]); // [v1.74.3] · [v1.74.6] ไม่ต้องรอ
          if (ctx && ctx.waitUntil) ctx.waitUntil(bk); else await bk;
          return jsonResponse({ status: "success" });
        }

        // ===== ล้างข้อมูลเช็คชื่อของวิชาหนึ่งในห้องหนึ่ง =====
        if (payload.__mode === "reset_subject_attendance" && payload.subjectId && payload.term && payload.year && payload.roomId) {
          // [v1.74] ลบบันทึกกิจกรรม (โฮมรูม/เขตพื้นที่) + ย้ายรูป (รวมรูปสอนแทน) ลงถังขยะของ Drive ด้วย
          const ph = await resetPhotosOf(env, payload.subjectId, String(payload.roomId), String(payload.term), String(payload.year), null);
          await env.DB.prepare(
            "DELETE FROM attendance WHERE subject_id = ? AND term = ? AND year = ? AND room_id = ?"
          ).bind(payload.subjectId, payload.term, payload.year, payload.roomId).run();
          await bumpSync(env, [roomSyncKey(payload.term, payload.year, payload.roomId)]); // [v1.74.3]
          return jsonResponse({ status: "success", ...ph });
        }

        // ===== [ใหม่] ล้างข้อมูลเช็คชื่อของวิชาหนึ่ง เฉพาะ "วันที่" ที่ระบุเท่านั้น (ไม่กระทบวันอื่น) =====
        if (payload.__mode === "reset_subject_date" && payload.subjectId && payload.date) {
          const ph = await resetPhotosOf(env, payload.subjectId, "", "", "", String(payload.date)); // [v1.74]
          const { results: rr } = await env.DB.prepare("SELECT DISTINCT term, year, room_id FROM attendance WHERE subject_id = ? AND date = ?").bind(payload.subjectId, payload.date).all();
          await bumpSync(env, rr.map(r => roomSyncKey(r.term, r.year, r.room_id))); // [v1.74.3]
          const result = await env.DB.prepare(
            "DELETE FROM attendance WHERE subject_id = ? AND date = ?"
          ).bind(payload.subjectId, payload.date).run();
          return jsonResponse({ status: "success", deleted: result.meta ? result.meta.changes : undefined, ...ph });
        }

        // ===== ล้างข้อมูลเช็คชื่อทุกห้องของเทอม/ปีนี้ =====
        if (payload.__mode === "reset_all_attendance" && payload.term && payload.year) {
          await env.DB.prepare("DELETE FROM attendance WHERE term = ? AND year = ?").bind(payload.term, payload.year).run();
          await bumpSync(env, ["all"]); // [v1.74.3]
          try { await env.DB.prepare("DELETE FROM homeroom_logs WHERE term = ? AND year = ?").bind(String(payload.term), String(payload.year)).run(); } catch (e) { /* [v1.71.4] ลบบันทึกโฮมรูม/เขตพื้นที่ของเทอมนี้ด้วย */ }
          const mainData = await readMainData(env);
          mainData.followUps = (mainData.followUps || []).filter(f => f.term !== payload.term || f.year !== payload.year);
          await writeMainData(env, mainData, ctx);
          return jsonResponse({ status: "success" });
        }

        // ===== [v1.71] บันทึกกิจกรรมโฮมรูม: 1 ห้อง 1 วัน = 1 แถว (ส่งซ้ำ = แทนที่ของเดิม) =====
        if (payload.__mode === "upsert_homeroom_log" && payload.record && payload.term && payload.year && payload.roomId) {
          const rec = payload.record;
          if (!rec.date) return jsonResponse({ status: "error", message: "ไม่มีวันที่" }, 400);
          await env.DB.prepare(
            `INSERT INTO homeroom_logs (room_id, date, term, year, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(room_id, date) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at, term = excluded.term, year = excluded.year`
          ).bind(payload.roomId, rec.date, String(payload.term), String(payload.year), JSON.stringify(rec), Date.now()).run();
          return jsonResponse({ status: "success" });
        }

        // ===== [v1.71] Relay รูปโฮมรูม: ส่งต่อไปยัง Apps Script ของโรงเรียน (อัปโหลด / ดึงรูป / ย้ายลงถังขยะ) =====
        if (payload.__mode === "relay_photo" && payload.base64) {
          const r = await forwardToDrive({ action: "upload", fileName: payload.fileName, mime: payload.mime, base64: payload.base64, folderPath: payload.folderPath });
          return jsonResponse(r, r.status === "success" ? 200 : 502);
        }
        if (payload.__mode === "relay_photo_get" && payload.id) {
          const r = await forwardToDrive({ action: "get", id: payload.id });
          return jsonResponse(r, r.status === "success" ? 200 : 502);
        }
        if (payload.__mode === "relay_folder_trash" && payload.path) {
          const r = await forwardToDrive({ action: "trashPath", path: payload.path });
          return jsonResponse(r, r.status === "success" ? 200 : 502);
        }
        if (payload.__mode === "relay_photo_trash" && payload.id) {
          const r = await forwardToDrive({ action: "trash", id: payload.id });
          return jsonResponse(r, r.status === "success" ? 200 : 502);
        }

        // ===== การติดตามนักเรียน (followUps) - เก็บในไฟล์หลัก (KV) เหมือนเดิม =====
        if (payload.__mode === "upsert_followup" && payload.record) {
          const mainData = await readMainData(env);
          mainData.followUps = mainData.followUps || [];
          const frec = payload.record;
          const already = mainData.followUps.some(f => f.studentId === frec.studentId && f.month === frec.month);
          if (!already) mainData.followUps.push(frec);
          await writeMainData(env, mainData, ctx);
          return jsonResponse({ status: "success" });
        }

        // ===== เพิ่ม log ทีละรายการ + เก็บแค่ 500 รายการล่าสุด =====
        if (payload.__mode === "append_log" && payload.record) {
          const r = payload.record;
          await env.DB.prepare(
            "INSERT INTO logs (id, timestamp, username, name, action, details, category) VALUES (?, ?, ?, ?, ?, ?, ?)"
          ).bind(r.id || genId(), r.timestamp, r.username || "", r.name || "", r.action || "", r.details || "", r.category || "data").run();
          // ตัดให้เหลือ 500 รายการล่าสุด (ลบที่เก่ากว่านั้นทิ้ง) — [v1.74.4] ทำประมาณ 1 ใน 20 ครั้ง (เกิน 500 ได้ชั่วคราวเล็กน้อย) ประหยัดเวลาและการอ่าน D1
          if (Math.random() < 0.05) await env.DB.prepare(
            `DELETE FROM logs WHERE id NOT IN (SELECT id FROM logs ORDER BY timestamp DESC LIMIT 500)`
          ).run();
          return jsonResponse({ status: "success" });
        }

        if (payload.__mode === "upsert_attendance" || payload.__mode === "reset_subject_attendance") {
          return jsonResponse({ status: "error", message: "ขาดข้อมูล term/year/roomId กรุณาอัพเดตหน้าเว็บเป็นเวอร์ชันล่าสุด" }, 400);
        }

        if (payload.__mode) return jsonResponse({ status: "error", message: "ไม่รู้จักคำสั่งนี้ (" + String(payload.__mode).slice(0, 40) + ")" }, 400); // [v1.71.5] กันคำสั่งแปลกปลอมตกมาบันทึกทับข้อมูลหลัก

        // ===== ค่าเริ่มต้น (ไม่มี __mode): บันทึกการตั้งค่า/ครู/วิชา/นักเรียน =====
        if (!isMainDataShapeValid(payload)) {
          return jsonResponse({ status: "error", message: "ปฏิเสธการบันทึก: ข้อมูลที่ส่งมาไม่ครบ (settings/teachers/subjects/students) ระบบไม่เขียนทับฐานข้อมูลเพื่อความปลอดภัย" }, 400);
        }
        const currentMain = gateMain || await readMainRO(env); // [v1.74.4] ใช้ที่อ่านไว้ตอนตรวจสิทธิ์ (อ่านอย่างเดียว)
        const data = payload;
        data.followUps = data.followUps || currentMain.followUps || [];
        // [v1.71.5] บัญชีผู้ใช้งาน: รับจาก Super Admin เท่านั้น และไม่ทำรหัสผ่านเดิมหาย
        if (actor) data.settings.users = await mergeUsers(data.settings.users, currentMain, actor);
        else if (Array.isArray(data.settings.users)) { // ติดตั้งครั้งแรก
          for (const u of data.settings.users) if (u && u.password && !isHashStr(u.password)) u.password = await sha256Hex(u.password);
        }
        delete data.attendanceData; delete data.logs; // ไม่เก็บในไฟล์หลักเลย (แยกไปตาราง D1 แล้ว)
        await writeMainData(env, data, ctx);
        return jsonResponse({ status: "success" });
      }

      return jsonResponse({ status: "error", message: "unsupported method" }, 405);
    } catch (err) {
      return jsonResponse({ status: "error", message: err.toString() }, 500);
    }
  },

  // ===== [เฟส 2] สำรองข้อมูลอัตโนมัติตามตารางเวลา (Cron Trigger - ตั้งค่าใน wrangler.toml) =====
  async scheduled(event, env, ctx) {
    await ensureAttIndexes(env);
    if (hubLinked(env)) { try { await syncHubHolidays(env); } catch (e) { /* AcademicHub ติดต่อไม่ได้ — ใช้ชุดเดิม */ } } // [v1.72.1]
    const now = Date.now();
    const stamp = new Date(now).toISOString();

    // สำรองไฟล์หลัก (settings/ครู/วิชา/นักเรียน)
    const mainData = await readMainData(env);
    await env.DB.prepare("INSERT INTO snapshots (id, type, label, created_at, data) VALUES (?, ?, ?, ?, ?)")
      .bind(genId(), "main", "snapshot_main_" + stamp, now, JSON.stringify(mainData)).run();

    // สำรองข้อมูลเช็คชื่อ แยกทีละห้อง/เทอม/ปี (จะได้กู้คืนเฉพาะห้องได้ถ้าจำเป็น)
    const { results: roomRows } = await env.DB.prepare(
      "SELECT DISTINCT term, year, room_id FROM attendance"
    ).all();
    for (const r of roomRows) {
      const { results: records } = await env.DB.prepare(
        "SELECT data FROM attendance WHERE term = ? AND year = ? AND room_id = ?"
      ).bind(r.term, r.year, r.room_id).all();
      const list = records.map(row => JSON.parse(row.data));
      await env.DB.prepare("INSERT INTO snapshots (id, type, label, created_at, data) VALUES (?, ?, ?, ?, ?)")
        .bind(genId(), "attendance_room", `snapshot_attendance_${r.term}_${r.year}_${r.room_id}_${stamp}`, now, JSON.stringify(list)).run();
    }

    // [v1.71] สำรองบันทึกกิจกรรมโฮมรูม (ทั้งหมดในชุดเดียว - ข้อมูลเล็ก ไม่รวมรูป ซึ่งอยู่ใน Google Drive)
    try {
      const { results: hrRows } = await env.DB.prepare("SELECT data FROM homeroom_logs").all();
      await env.DB.prepare("INSERT INTO snapshots (id, type, label, created_at, data) VALUES (?, ?, ?, ?, ?)")
        .bind(genId(), "homeroom", "snapshot_homeroom_" + stamp, now, JSON.stringify(hrRows.map(r => JSON.parse(r.data)))).run();
    } catch (e) { /* ยังไม่ได้สร้างตาราง homeroom_logs - ข้ามไป */ }

    // เก็บ snapshot ไว้แค่ 30 ชุดล่าสุดต่อประเภท (กันตารางโตไม่มีที่สิ้นสุด) - ลบที่เก่ากว่านั้นทิ้ง
    for (const t of ["main", "attendance_room", "homeroom"]) {
      await env.DB.prepare(
        `DELETE FROM snapshots WHERE type = ? AND id NOT IN (SELECT id FROM snapshots WHERE type = ? ORDER BY created_at DESC LIMIT 30)`
      ).bind(t, t).run();
    }
  },
};
