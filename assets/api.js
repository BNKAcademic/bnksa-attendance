/**
 * BNKAcademicHub - api.js
 * ตัวช่วยเรียก backend (Cloudflare Worker), จัดการ session, ธีมมืด/สว่าง, และส่วนหน้าเว็บที่ใช้ร่วมกัน (topbar/footer/modal)
 *
 * สำคัญ: แก้ API_URL ด้านล่างเป็น URL ของ Worker (เช่น https://bnk-academic-hub-api.<ชื่อบัญชี>.workers.dev)
 * หลัง deploy — ดูขั้นตอนเต็มใน README.md (ตั้งแต่ V9 backend ย้ายจาก Google Apps Script มาเป็น
 * Cloudflare Worker + D1/KV แล้ว — ไฟล์ apps-script/ เดิมเก็บไว้เป็นข้อมูลอ้างอิงเท่านั้น ไม่ได้ใช้งานแล้ว)
 */
var API_URL = 'https://bnk-academic-hub-api.bnkschool.workers.dev';

// เลขเวอร์ชันของเว็บ — เป็นค่าคงที่ในโค้ดเท่านั้น ไม่ใช่ "ค่าตั้งค่า" ที่แก้ผ่านหน้าเว็บได้อีกต่อไปตั้งแต่ V9.1
// (ผู้ดูแลระบบ/นักพัฒนาเป็นคนแก้เลขนี้เองในไฟล์โค้ดทุกครั้งที่ปล่อยเวอร์ชันใหม่ — แสดงผลที่แถวล่างสุดของหน้าตั้งค่าเท่านั้น)
// ⚠️ สำคัญ (ตั้งแต่ V11.8): ทุกครั้งที่แก้เลขนี้ ต้องไปแก้ "?v=..." ต่อท้าย assets/style.css และ assets/api.js ใน <link>/<script>
// ของทุกไฟล์ .html (index/dashboard/settings/summary/view) ให้ตรงกันด้วย — เป็นตัวกันแคชเก่า (cache-busting) เพราะเบราว์เซอร์/
// CDN ของโฮสติ้งบางเจ้ามักแคชไฟล์ .css/.js ชื่อเดิมไว้นาน ทำให้อัปโหลดไฟล์ใหม่ทับแล้วแต่ผู้ใช้ยังเห็นหน้าเว็บเวอร์ชันเก่าอยู่
// (แม้จะลบแคชเบราว์เซอร์ตัวเองแล้วก็ตาม ถ้า CDN กลางทางยังแคชอยู่) เปลี่ยนเลขท้าย query string ทุกเวอร์ชันบังคับให้โหลดใหม่เสมอ
// ตั้งแต่เวอร์ชัน 1.21.081026 เปลี่ยนรูปแบบเลขเวอร์ชันจาก "V<major>.<minor>" เป็น "1.<ลำดับรัน>.<DDMMYY วันที่ปล่อยเวอร์ชัน>"
// ตามที่ผู้ใช้ระบุ — เลขตรงกลางเป็นเลขรันต่อเนื่องทุกครั้งที่ปล่อยเวอร์ชันใหม่ (ไม่สนใจว่าเปลี่ยน D1/Worker หรือแก้แค่หน้าเว็บ)
// วันที่ท้ายคือวันที่ปล่อยเวอร์ชันนั้นจริง (ไม่ใช่วันที่เริ่มพัฒนา) ถ้าเลขรันไล่ไปถึง 99 แล้วจะล้นเป็น 100 ผู้ใช้ขอให้มาอนุมัติเองก่อนเปลี่ยนเป็น major ถัดไป (2.00)
// 1.79: รุ่น Worker ขั้นต่ำที่หน้าเว็บรุ่นนี้ต้องการ (เปลี่ยนเฉพาะรุ่นที่แก้ไฟล์ Worker) — หน้าภาพรวมระบบเตือนเมื่อ Worker เก่ากว่า
var WORKER_MIN_VERSION = '1.98.2';
var APP_VERSION = '1.98.2.021126';

var SESSION_TOKEN_KEY = 'bnkah_token';
var SESSION_USER_KEY = 'bnkah_user';
var SESSION_LOGIN_AT_KEY = 'bnkah_login_at';
var THEME_KEY = 'bnkah_theme';
// 1.69: ออกจากระบบเมื่อ "ไม่มีการใช้งาน" ครบ 60 นาที (เดิม = ครบ 1 ชั่วโมงหลังล็อกอินเสมอ) · เตือนล่วงหน้า 2 นาที
var SESSION_TIMEOUT_MS = 60 * 60 * 1000;
var SESSION_IDLE_WARN_MS = 2 * 60 * 1000;
var SESSION_ACTIVE_KEY = 'bnkah_last_active'; // เด้งออกอัตโนมัติเมื่ออยู่ในระบบครบ 1 ชั่วโมง (ฝั่งหน้าเว็บ แยกจากอายุ token ฝั่ง backend)

/**
 * เรียก action ไปยัง backend (Cloudflare Worker) เสมอใช้ Content-Type: text/plain เพื่อเลี่ยง CORS preflight
 * หากได้ผลลัพธ์ที่ไม่ใช่ JSON กลับมา (เช่น เครือข่ายสะดุดชั่วคราว) จะลองซ้ำให้อัตโนมัติ 1 ครั้งก่อนแจ้ง error —
 * เผื่อไว้เฉยๆ ตั้งแต่ย้ายมาเป็น Cloudflare Worker แล้วโอกาสเกิดน้อยกว่าระบบเดิมมาก (Worker ไม่มี fallback
 * ที่ตอบข้อความธรรมดากลับมาแบบ Apps Script เดิมที่เคยเป็นต้นเหตุปัญหานี้)
 */
async function apiCall(action, payload) {
  if (!API_URL || API_URL.indexOf('PASTE_YOUR') === 0) {
    throw new Error('ยังไม่ได้ตั้งค่า API_URL ใน assets/api.js กรุณาใส่ Web App URL ก่อนใช้งาน');
  }
  var body = JSON.stringify({ action: action, token: getToken(), payload: payload || {} });
  var attempt = async function () {
    var res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: body
    });
    var text = await res.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      var badJsonErr = new Error('เชื่อมต่อกับ Backend ไม่สำเร็จ (เซิร์ฟเวอร์ตอบกลับข้อมูลไม่ถูกต้อง) — หากเพิ่ง Deploy เวอร์ชันใหม่ของ Apps Script ให้รอสัก 1-2 นาทีแล้วลองใหม่');
      badJsonErr.__notJson = true;
      throw badJsonErr;
    }
  };
  var json;
  try {
    json = await attempt();
  } catch (e) {
    if (e.__notJson) {
      await new Promise(function (r) { setTimeout(r, 1500); });
      json = await attempt(); // ลองซ้ำอีกครั้งเดียว ถ้ายัง error ก็ปล่อยให้ throw ออกไปตามปกติ
    } else {
      throw e;
    }
  }
  if (!json.ok) {
    // code (ตั้งแต่ V11.7): ติด err.code ไว้กับ Error ที่ throw ออกไปด้วยถ้า backend ส่งมา (เช่น 'SESSION_REPLACED')
    // เพื่อให้จุดที่เรียกใช้ตรวจจับ error เฉพาะเจาะจงได้ด้วยรหัส ไม่ต้องเทียบข้อความภาษาไทย (ดู startSessionWatch ด้านล่าง)
    var errMsg = json.error || 'เกิดข้อผิดพลาดไม่ทราบสาเหตุ';
    // ตั้งแต่ 1.41.111026: "ไม่รู้จักคำสั่ง: xxx" = หน้าเว็บใหม่แต่ Worker บนเซิร์ฟเวอร์ยังเป็นโค้ดเก่า (ยังไม่ได้ deploy) — บอกวิธีแก้ให้ชัด
    var unk = /^ไม่รู้จักคำสั่ง:\s*(\S+)/.exec(errMsg);
    if (unk) errMsg = 'เซิร์ฟเวอร์ (Worker) ยังเป็นโค้ดเก่า ไม่มีคำสั่ง "' + unk[1] + '" — ต้องอัปเดตไฟล์ Worker เป็นชุดเดียวกับหน้าเว็บ (เวอร์ชัน ' + APP_VERSION + ') แล้ว Deploy Worker ใหม่ (ดู README ขั้นตอนอัปเดต) ก่อนใช้ฟีเจอร์นี้';
    var err = new Error(errMsg);
    err.code = json.code || null;
    throw err;
  }
  return json.data;
}

// ---------- Session ----------
function getToken() { try { return localStorage.getItem(SESSION_TOKEN_KEY); } catch (e) { return null; } }
function getSession() {
  try { var raw = localStorage.getItem(SESSION_USER_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function setSession(token, user) {
  try {
    localStorage.setItem(SESSION_TOKEN_KEY, token);
    localStorage.setItem(SESSION_USER_KEY, JSON.stringify(user));
    localStorage.setItem(SESSION_LOGIN_AT_KEY, String(Date.now()));
    localStorage.setItem(SESSION_ACTIVE_KEY, String(Date.now()));
  } catch (e) { /* localStorage อาจถูกปิด */ }
}
// อัปเดตข้อมูลผู้ใช้ที่แคชไว้ใน localStorage ให้สดขึ้น โดย "ไม่แตะ" เวลา login (SESSION_LOGIN_AT_KEY) และ token เดิม
// (ตั้งแต่ 1.25.081026) — ต่างจาก setSession() ด้านบนตรงที่ setSession() รีเซ็ตตัวจับเวลาหมดอายุ 1 ชั่วโมงใหม่ทุกครั้ง ซึ่งไม่ใช่
// สิ่งที่ต้องการตอนแค่รีเฟรชข้อมูลโปรไฟล์ (เช่น ตำแหน่ง/กลุ่มสาระการเรียนรู้ที่เจ้าหน้าที่ฝ่ายวิชาการเพิ่งตั้งให้) กลางเซสชัน
function updateCachedSessionUser(user) {
  try { localStorage.setItem(SESSION_USER_KEY, JSON.stringify(user)); } catch (e) { /* localStorage อาจถูกปิด */ }
}
// เรียก checkSession ครั้งเดียวเพื่อดึงข้อมูลผู้ใช้ปัจจุบันสดๆ จากเซิร์ฟเวอร์มาอัปเดตแคช แล้วคืนค่า session ที่อัปเดตแล้วกลับไป
// (ตั้งแต่ 1.25.081026) ใช้ที่หน้า memo.html เพื่อให้แน่ใจว่าตำแหน่ง/กลุ่มสาระการเรียนรู้ที่แสดงเป็นค่าล่าสุดเสมอ ไม่ใช่ค่าเก่า
// ที่ค้างมาตั้งแต่ตอน login ครั้งก่อน (ถ้าเรียกไม่สำเร็จ เช่น เน็ตสะดุด ก็ปล่อยผ่านคืนค่า session เดิมที่มีอยู่ไปเฉยๆ)
async function refreshSessionUser() {
  try {
    var data = await apiCall('checkSession', {});
    if (data && data.user) { updateCachedSessionUser(data.user); return data.user; }
  } catch (e) { /* ปล่อยผ่าน ใช้ค่าที่แคชไว้เดิม */ }
  return getSession();
}
function clearSession() {
  try {
    localStorage.removeItem(SESSION_TOKEN_KEY);
    localStorage.removeItem(SESSION_USER_KEY);
    localStorage.removeItem(SESSION_LOGIN_AT_KEY);
    localStorage.removeItem(SESSION_ACTIVE_KEY);
    localStorage.removeItem(THEME_KEY); // 1.41.111026: Dark Mode เป็นของบัญชี — ออกจากระบบแล้วไม่ทิ้งโหมดของคนนี้ไว้ให้คนถัดไปบนเครื่องเดียวกัน
  } catch (e) {}
}
// ออกจากระบบแล้วรีเฟรชหน้าเว็บ 1 ครั้งเสมอ (นำทางไปหน้าล็อกอินแบบโหลดใหม่จริง ไม่ใช้แคชหน้าเดิม)
function logout() {
  clearSession();
  location.href = 'index.html?_=' + Date.now();
}

// ---------- เซสชันหมดเวลาอัตโนมัติเมื่ออยู่ในระบบครบ 1 ชั่วโมง ----------
var _sessionTimeoutHandle = null;
// เวลาใช้งานล่าสุดเก็บใน localStorage (ใช้ร่วมกันทุกแท็บ) — ขยับเมาส์/คลิก/พิมพ์/เลื่อน/แตะ = ใช้งาน (บันทึกไม่ถี่กว่า 10 วินาทีครั้ง)
// ระหว่างป็อปอัปความคืบหน้า (อัปโหลด/บันทึก) ทำงานอยู่ นับเป็นการใช้งาน · ตรวจทุก 15 วินาที + ตอนกลับมาที่แท็บ
var _idleTimer = null, _idleLastWrite = 0, _progressBusy = 0, _idleWarnShown = false;
function idleTimeoutMs() { return Number(window.__BNKAH_IDLE_MS) || SESSION_TIMEOUT_MS; }
function idleWarnMs() { return Number(window.__BNKAH_IDLE_WARN_MS) || SESSION_IDLE_WARN_MS; }
function lastActiveAt() {
  try { return parseInt(localStorage.getItem(SESSION_ACTIVE_KEY) || localStorage.getItem(SESSION_LOGIN_AT_KEY) || '0', 10) || 0; } catch (e) { return 0; }
}
function markActive(force) {
  var now = Date.now();
  if (!force && now - _idleLastWrite < Math.min(10000, idleWarnMs() / 5)) return;
  _idleLastWrite = now;
  try { localStorage.setItem(SESSION_ACTIVE_KEY, String(now)); } catch (e) { /* ไม่เป็นไร */ }
  if (_idleWarnShown) hideIdleWarning();
}
function isIdleFor(ms) { return Date.now() - lastActiveAt() >= ms; }
// 1.80: เข้าสู่ระบบอัตโนมัติ — ไม่ออกจากระบบเมื่อนิ่ง 60 นาที (token ฝั่ง Worker หมดอายุเองเมื่อไม่ได้ใช้งานเกิน 7 วัน)
function isKeepLogin() { var s = getSession(); return !!(s && s.keepLogin); }
function checkIdle() {
  if (!getToken()) return;
  if (isKeepLogin()) { if (_idleWarnShown) hideIdleWarning(); return; }
  if (_progressBusy > 0) { markActive(true); return; }
  var idle = Date.now() - lastActiveAt();
  if (idle >= idleTimeoutMs()) { hideIdleWarning(); forceSessionExpire(); return; }
  if (idle >= idleTimeoutMs() - idleWarnMs()) showIdleWarning(); else if (_idleWarnShown) hideIdleWarning();
}
function scheduleSessionTimeout() {
  try {
    if (_idleTimer) return;
    if (!lastActiveAt()) markActive(true);
    if (isIdleFor(idleTimeoutMs()) && !isKeepLogin()) { forceSessionExpire(); return; } // กลับมาหลังพักเครื่อง/ปิดจอนานเกินกำหนด
    ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'wheel'].forEach(function (ev) {
      window.addEventListener(ev, function () { if (!_idleWarnShown || ev !== 'mousemove') markActive(false); }, { passive: true, capture: true });
    });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) checkIdle(); });
    _idleTimer = setInterval(checkIdle, Math.min(15000, Math.max(1000, Math.floor(idleWarnMs() / 4))));
  } catch (e) { /* localStorage อาจถูกปิด: ไม่ตั้งเวลาหมดอายุอัตโนมัติ */ }
}
// ป็อปอัปเตือนก่อนหมดเวลา (นับถอยหลัง) — กด "ใช้งานต่อ" หรือใช้งานใดๆ (ยกเว้นแค่ขยับเมาส์ผ่าน) = นับใหม่
var _idleCountdown = null;
function showIdleWarning() {
  ensureSharedModals();
  var m = document.getElementById('sharedIdleModal');
  if (!m) return;
  var tick = function () {
    var left = Math.max(0, idleTimeoutMs() - (Date.now() - lastActiveAt()));
    var sec = Math.ceil(left / 1000);
    var el = document.getElementById('sharedIdleLeft');
    if (el) el.textContent = Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0');
    if (left <= 0) checkIdle();
  };
  tick();
  if (!_idleWarnShown) { _idleWarnShown = true; showModalEl(m); _idleCountdown = setInterval(tick, 1000); }
}
function hideIdleWarning() {
  _idleWarnShown = false;
  if (_idleCountdown) { clearInterval(_idleCountdown); _idleCountdown = null; }
  var m = document.getElementById('sharedIdleModal');
  if (m && !m.hidden) hideModalEl(m);
}
function forceSessionExpire() {
  stopSessionWatch();
  if (_idleTimer) { clearInterval(_idleTimer); _idleTimer = null; }
  clearSession();
  ensureSharedModals();
  var modal = document.getElementById('sharedExpireModal');
  if (!modal) { location.href = 'index.html?_=' + Date.now(); return; }
  showModalEl(modal);
}

// ---------- ป้องกันล็อกอินซ้อนกัน (ตั้งแต่ V11.7) ----------
// ตรวจเป็นระยะว่าบัญชีนี้ถูกเข้าสู่ระบบใหม่จากที่อื่น (เครื่อง/เบราว์เซอร์อื่น) มาแทนที่ session ปัจจุบันหรือยัง โดยเรียก
// action 'checkSession' เบาๆ ทุก 10 วินาที — ถ้า backend ตอบกลับด้วย code 'SESSION_REPLACED' (ดู requireAuth ใน
// worker/src/lib/util.js) แสดงว่ามีคนล็อกอินบัญชีนี้จากที่อื่นไปแล้ว จึงเด้งออกพร้อมป็อปอัปแจ้งเตือนทันที
// error อื่นๆ ระหว่างตรวจ (เช่น เครือข่ายสะดุดชั่วคราว) ปล่อยผ่านเฉยๆ รอตรวจรอบถัดไป ไม่ถือเป็นการเด้งออก
// 1.69: ทุก 30 วินาที (เดิม 10) และเฉพาะตอนที่มีการใช้งานภายใน 2 นาทีที่ผ่านมา — ลดคำขอไป Worker · ใช้งานต่อหลังนิ่ง = ตรวจทันที
// คำตอบมี token ใหม่ (ต่ออายุอัตโนมัติ) -> เก็บแทนของเดิม
var SESSION_WATCH_INTERVAL_MS = 30 * 1000;
var SESSION_WATCH_ACTIVE_MS = 2 * 60 * 1000;
var _sessionWatchHandle = null;
function startSessionWatch() {
  if (_sessionWatchHandle) return; // กันเรียกซ้ำ (เช่น mountChrome ถูกเรียกมากกว่า 1 ครั้งในหน้าเดียว)
  // 1.56: ไม่ตรวจตอนแท็บถูกซ่อน (สลับไปแท็บอื่น/พับจอ) — ลดจำนวนคำขอไปยัง Worker (โควตาฟรี 100,000 ครั้ง/วัน)
  // แล้วตรวจทันทีเมื่อกลับมาที่แท็บ จึงยังเด้งออกได้ทันเวลาเหมือนเดิม
  var check = async function (force) {
    if (!getToken() || document.hidden) return;
    if (force !== true && isIdleFor(Number(window.__BNKAH_WATCH_ACTIVE_MS) || SESSION_WATCH_ACTIVE_MS)) return;
    try {
      var r = await apiCall('checkSession', {});
      if (r && r.token && getToken()) { try { localStorage.setItem(SESSION_TOKEN_KEY, r.token); } catch (e) { /* ไม่เป็นไร */ } }
      applyTopBadges(r); // 1.75: ตัวเลขแดงบนกระดิ่ง
      syncSessionFlags(r && r.user); // 1.94: สิทธิ์ผู้รับผิดชอบ/แอดมินระบบที่เปลี่ยนระหว่างใช้งาน
    } catch (err) {
      if (err && err.code === 'SESSION_REPLACED') {
        stopSessionWatch();
        showSessionReplacedModal();
      }
    }
  };
  _sessionWatchHandle = setInterval(check, Number(window.__BNKAH_WATCH_MS) || SESSION_WATCH_INTERVAL_MS);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && _sessionWatchHandle) check(true); });
  // กลับมาใช้งานหลังนิ่งเกิน 2 นาที = ตรวจทันที (ไม่ต้องรอรอบถัดไป)
  var wasIdle = false;
  setInterval(function () { if (isIdleFor(SESSION_WATCH_ACTIVE_MS)) wasIdle = true; }, 15000);
  ['mousedown', 'keydown', 'touchstart'].forEach(function (ev) { window.addEventListener(ev, function () { if (wasIdle && _sessionWatchHandle) { wasIdle = false; check(true); } }, { passive: true, capture: true }); });
}
// 1.94: อัปเดตค่าในเครื่องเมื่อสิทธิ์เปลี่ยน (เพิ่งถูกตั้งเป็นผู้รับผิดชอบกำหนดการ → เมนู "สรุปการส่งงาน" ขึ้นทันที)
function syncSessionFlags(u) {
  if (!u) return;
  var s = getSession(); if (!s || s.id !== u.id) return;
  var before = (s.respCount > 0) + '|' + !!s.isSysAdmin;
  s.respCount = u.respCount || 0; s.isSysAdmin = !!u.isSysAdmin;
  updateCachedSessionUser(s);
  void before; // เมนูข้างอัปเดตเมื่อเปิดหน้าถัดไป
}
function stopSessionWatch() {
  if (_sessionWatchHandle) { clearInterval(_sessionWatchHandle); _sessionWatchHandle = null; }
}
function showSessionReplacedModal() {
  clearSession();
  if (_sessionTimeoutHandle) { clearTimeout(_sessionTimeoutHandle); _sessionTimeoutHandle = null; } // ไม่ต้องรอเด้งซ้ำจากตัวจับเวลาหมดอายุอีก
  ensureSharedModals();
  var modal = document.getElementById('sharedSessionReplacedModal');
  if (!modal) { location.href = 'index.html?_=' + Date.now(); return; }
  showModalEl(modal);
}

function homePageFor(session) {
  if (!session) return 'index.html';
  if (session.role === 'teacher') return 'dashboard.html';
  if (session.role === 'executive') return 'executive.html'; // ผู้บริหาร (ตั้งแต่ 1.32.101026): หน้าแรก = ปฏิทิน + สรุปภาพรวมการส่งงาน (อ่านอย่างเดียว)
  if (session.role === 'admin' && session.hasHub) return 'dashboard.html';
  if (session.devHome) return session.devHome; // เฉพาะเครื่องทดสอบ (Worker ตั้ง DEV_SA_HOME)
  return 'overview.html'; // Super Admin (ไม่มีหน้าฮับ) — 1.79: หน้าภาพรวมระบบ (เดิม summary.html)
}

function requireLogin() {
  var s = getSession();
  if (!s || !getToken()) { location.href = 'index.html'; return null; }
  return s;
}
function requireHubAccess() {
  var s = requireLogin();
  if (!s) return null;
  if (s.role === 'teacher' || (s.role === 'admin' && s.hasHub)) return s;
  location.href = homePageFor(s);
  return null;
}
// หน้าที่ผู้บริหารเข้าดูได้ด้วย (อ่านอย่างเดียว): สรุปการส่งงาน, ประกาศและปฏิทิน (ตั้งแต่ 1.32.101026)
function requireViewerAccess() {
  var s = requireLogin();
  if (!s) return null;
  if (s.role !== 'admin' && s.role !== 'executive') { location.href = homePageFor(s); return null; }
  return s;
}
// 1.87.2: หัวหน้ากลุ่มบริหารงาน (บัญชีครูที่มีหน้าที่พิเศษ "หัวหน้ากลุ่มบริหารงาน" ในทำเนียบ) — เห็นสรุปการส่งงาน + ตรวจงานของกลุ่มตัวเอง
function isDeptHeadSession(s) { return !!s && s.role === 'teacher' && Array.isArray(s.headRoles) && s.headRoles.indexOf('dept') !== -1; }
// 1.94: ผู้รับผิดชอบกำหนดการ (respCount > 0) — เข้าหน้าสรุปการส่งงานได้ เห็นเฉพาะแท็บสรุปแยกแต่ละงาน + งานที่รับผิดชอบ
function isRespOnlySession(s) { return !!s && s.role === 'teacher' && !isDeptHeadSession(s) && (s.respCount || 0) > 0; }
function requireSummaryAccess() {
  var s = requireLogin();
  if (!s) return null;
  if (s.role !== 'admin' && s.role !== 'executive' && !isDeptHeadSession(s) && !isRespOnlySession(s)) { location.href = homePageFor(s); return null; }
  return s;
}
function requireAdminAccess() {
  var s = requireLogin();
  if (!s) return null;
  if (s.role !== 'admin') { location.href = homePageFor(s); return null; }
  return s;
}

// ตั้งแต่ 1.26.081026: ป้ายชื่อเจ้าหน้าที่แสดงฝ่ายที่สังกัดต่อท้ายคำว่า "เจ้าหน้าที่" (session.department มาจาก sanitizeUser
// ฝั่ง Worker) แทนชื่อ "เจ้าหน้าที่ฝ่ายวิชาการ" เดิมที่ hardcode ไว้ตัวเดียวสำหรับทุกบัญชี — ถ้ายังไม่ได้ตั้งฝ่ายไว้ (บัญชีเก่า/
// ยังไม่ได้กำหนด) จะแสดงแค่ "เจ้าหน้าที่" เฉยๆ
function roleLabel(session) {
  if (!session) return '';
  if (session.role === 'teacher') return 'ครู';
  if (session.role === 'executive') return session.position || 'ผู้บริหาร';
  // 1.41.111026: เจ้าหน้าที่ = สมาชิกกลุ่มบริหารงานที่ได้สิทธิ์แอดมิน — ป้ายแสดงชื่อกลุ่มเต็ม เช่น "เจ้าหน้าที่กลุ่มบริหารงานวิชาการ"
  if (session.role === 'admin') return session.hasHub ? (session.isSysAdmin ? 'แอดมินระบบ' : 'เจ้าหน้าที่' + groupLabel(session.department)) : 'Super Admin';
  return '';
}

// ข้อมูลบัญชีในเมนูมุมขวาบน (1.46.121026 — ผู้ใช้ขอแยกเป็นบรรทัดละเรื่อง): ประเภทบัญชี / กลุ่มบริหารงาน / กลุ่มสาระการเรียนรู้
// คืน array ของ { label, value } — แสดงเฉพาะเรื่องที่เกี่ยวกับบัญชีนั้น (ผู้บริหาร/Super Admin ไม่มีกลุ่มบริหารงาน/กลุ่มสาระ)
function accountInfoLines(session) {
  if (!session) return [];
  var lines = [];
  var isExec = session.role === 'executive';
  var isSuper = session.role === 'admin' && !session.hasHub;
  var type = session.role === 'teacher' ? 'ครู' : isExec ? 'ผู้บริหาร' : (isSuper ? 'Super Admin' : (session.isSysAdmin ? 'แอดมินระบบ' : 'เจ้าหน้าที่'));
  lines.push({ label: 'ประเภทบัญชี', value: type + (isExec && session.position ? ' (' + session.position + ')' : '') });
  if (!isExec && !isSuper) {
    lines.push({ label: 'กลุ่มบริหารงาน', value: session.department ? groupLabel(session.department) : 'ไม่ระบุ' });
    lines.push({ label: 'กลุ่มสาระฯ', value: session.subjectGroup || 'ไม่ระบุ' });
  }
  return lines;
}

// ---------- Theme (dark/light) ----------
function getTheme() {
  try { return localStorage.getItem(THEME_KEY) || 'light'; } catch (e) { return 'light'; }
}
function applyTheme(theme) {
  // 1.66: 3 ธีม — 'light' กระดาษขาว (เริ่มต้น) · 'sepia' ถนอมตา · 'dark' กลางคืน
  document.documentElement.setAttribute('data-theme', theme === 'dark' || theme === 'sepia' ? theme : 'light');
}
function setTheme(theme) {
  try { localStorage.setItem(THEME_KEY, theme); } catch (e) {}
  applyTheme(theme);
}
// Dark Mode ผูกกับบัญชี (ตั้งแต่ 1.41.111026): ตอน login Worker ส่งค่าที่บัญชีนี้เคยเลือกไว้มา (user.theme: 'dark' | 'light' | '' = ยังไม่เคยเลือก)
// หน้าเว็บตั้งค่าตามนั้นทันที (ไม่ให้โหมดของคนก่อนหน้าบนเครื่องเดียวกันค้างมา) — ยังไม่เคยเลือก = โหมดสว่าง
function applyAccountTheme(user) {
  var t = user && (user.theme === 'dark' || user.theme === 'sepia') ? user.theme : 'light';
  setTheme(t);
}
// เมื่อผู้ใช้กดสลับ Dark Mode เอง: ตั้งค่าบนหน้าเว็บทันที + บันทึกลงบัญชี (ส่งแบบไม่รอผล พลาดก็ไม่กระทบการใช้งาน) และอัปเดตค่าที่แคชใน session
function saveThemeToAccount(theme) {
  if (!getToken()) return;
  var s = getSession();
  if (s) { s.theme = theme; updateCachedSessionUser(s); }
  try { apiCall('setMyTheme', { theme: theme }).catch(function () {}); } catch (e) {}
}
function toggleTheme() {
  var next = getTheme() === 'dark' ? 'light' : 'dark';
  setTheme(next);
  saveThemeToAccount(next);
  Array.prototype.forEach.call(document.querySelectorAll('[data-theme-pick]'), function (b) { b.classList.toggle('on', b.getAttribute('data-theme-pick') === next); });
}

// ---------- Site settings (ชื่อเว็บ/โลโก้/ไอคอน) ----------
// เก็บทั้งค่า (cache) และ promise ที่กำลังโหลดอยู่ (in-flight) — กันไม่ให้สองหน้าที่เรียก applyBranding()/loadGeneralSettings() พร้อมกันตอนโหลดหน้า ยิง apiCall ซ้ำซ้อนกันโดยไม่จำเป็น
var _settingsCache = null;
var _settingsPromise = null;
function resetSettingsCache() { _settingsCache = null; _settingsPromise = null; }
async function getSiteSettings() {
  if (_settingsCache) return _settingsCache;
  if (!_settingsPromise) {
    _settingsPromise = apiCall('publicGetSettings', {}).catch(function () {
      return {
        __fallback: true, // โหลดค่าตั้งค่าไม่สำเร็จ — ห้ามเอาไปทับค่าแบรนด์ที่จำไว้ (ดู applyBranding)
        siteName: 'BNKAcademicHub', iconDataUrl: '', logoDataUrl: '', summerEnabled: true, currentAcademicYear: '', currentSemester: '',
        schoolName: '', schoolDistrict: '', schoolProvince: '',
        memoHeadName: '', memoHeadPosition: '', memoDeputyName: '', memoDeputyPosition: '', memoDirectorName: '', memoDirectorPosition: ''
      };
    });
  }
  _settingsCache = await _settingsPromise;
  try { applyUploadMaxLabels(); } catch (e) { /* หน้าที่ยังไม่มี DOM */ } // 1.86
  return _settingsCache;
}

// 1.53.121026: จำค่าแบรนด์ล่าสุด (ชื่อเว็บ/โลโก้/โลโก้แบบยาว/แสดงชื่อในแถบด้านบน) ไว้ในเครื่อง แล้ววาดแถบด้านบนจากค่าที่จำไว้ทันทีตอนเปิดหน้า
// (ไม่ต้องรอโหลดค่าตั้งค่า — โลโก้/ชื่อเว็บไม่กระพริบเปลี่ยนเวลาเปลี่ยนหน้า) แล้วค่อยอัปเดตตามค่าจริงเมื่อโหลดเสร็จ
var BRAND_CACHE_KEY = 'bnkah_brand';
function cachedBrand() { try { return JSON.parse(localStorage.getItem(BRAND_CACHE_KEY) || 'null'); } catch (e) { return null; } }
function cacheBrand(s) {
  try { localStorage.setItem(BRAND_CACHE_KEY, JSON.stringify({ siteName: s.siteName || '', logoDataUrl: s.logoDataUrl || '', logoWideDataUrl: s.logoWideDataUrl || '', loginHeroDataUrl: s.loginHeroDataUrl || '', topbarShowName: s.topbarShowName !== false, navOrder: Array.isArray(s.navOrder) ? s.navOrder : [], themeMode: s.themeMode || 'system', themeColor: s.themeColor || '', departmentColors: s.departmentColors || {} })); } catch (e) { /* เต็ม/ไม่มี localStorage — ไม่เป็นไร */ }
}
// วาดส่วนแบรนด์ (ไม่ต้องรอ) จาก object ค่าตั้งค่า
function renderBrand(s) {
  if (!s) return;
  renderLoginHero(s);
  document.querySelectorAll('.js-site-name').forEach(function (el) { el.textContent = s.siteName || 'BNKAcademicHub'; });
  document.querySelectorAll('.js-brand-logo').forEach(function (el) {
    // โลโก้แบบยาว (settings.logoWideDataUrl, 1.52) แสดงแทนโลโก้เล็ก เฉพาะแถบด้านบนสุด (ปุ่ม .js-home-btn)
    // ชื่อเว็บในแถบด้านบน แสดง/ซ่อนตามสวิตช์ settings.topbarShowName (1.53 — อัปโลโก้แบบยาวแล้วระบบปิดให้อัตโนมัติ)
    var homeBtn = el.closest && el.closest('.js-home-btn');
    if (homeBtn) {
      homeBtn.classList.toggle('has-wide-logo', !!s.logoWideDataUrl);
      homeBtn.classList.toggle('hide-site-name', s.topbarShowName === false);
      homeBtn.setAttribute('aria-label', (s.siteName || 'BNKAcademicHub') + ' — หน้าแรก');
      if (s.logoWideDataUrl) {
        var cur = el.querySelector('img.brand-logo-wide');
        if (!cur || cur.getAttribute('src') !== s.logoWideDataUrl) el.innerHTML = '<img src="' + s.logoWideDataUrl + '" class="brand-logo-wide" alt="' + escapeHtml(s.siteName || 'BNKAcademicHub') + '" />';
        return;
      }
    }
    if (s.logoDataUrl) {
      var cur2 = el.querySelector('img.brand-logo');
      if (!cur2 || cur2.getAttribute('src') !== s.logoDataUrl) el.innerHTML = '<img src="' + s.logoDataUrl + '" class="brand-logo" alt="โลโก้" />';
    } else {
      el.innerHTML = '<span class="logo-dot"></span>';
    }
  });
}
// ---------- ธีมสี (ตั้งแต่ 1.56) ----------
// settings.themeMode: 'system' = สีเดียวทั้งระบบ (themeColor) · 'department' = แยกสีตามกลุ่มบริหารงาน (departmentColors[ชื่อกลุ่ม])
// บัญชีที่ไม่สังกัดกลุ่ม/กลุ่มยังไม่ตั้งสี = themeColor · หน้าเข้าสู่ระบบ = themeLoginColor (ว่าง = themeColor)
// จากสีเดียว คำนวณชุดสี --primary / --primary-dark / --primary-light / --primary-rgb / --grad-1..3 ทั้งโหมดสว่างและโหมดมืด
// แล้วจำ CSS ไว้ใน localStorage — สคริปต์ใน <head> ทุกหน้าใส่สีจากที่จำไว้ทันที (ไม่เห็นสีเก่าแวบตอนเปลี่ยนหน้า)
var THEME_DEFAULT_COLOR = '#0b6fcc';
var THEME_CSS_KEY = 'bnkah_theme_css';
var THEME_CSS_LOGIN_KEY = 'bnkah_theme_css_login';
var THEME_PRESETS = [
  { name: 'ฟ้า', c: '#0b6fcc' }, { name: 'น้ำเงิน', c: '#2563eb' }, { name: 'คราม (สีเดิม)', c: '#4f46e5' }, { name: 'ม่วง', c: '#7c3aed' },
  { name: 'ชมพู', c: '#db2777' }, { name: 'แดง', c: '#dc2626' }, { name: 'ส้ม', c: '#b45309' }, { name: 'เขียว', c: '#15803d' }, { name: 'เขียวอมฟ้า', c: '#0f766e' }
];
function themeHexOk(h) { return /^#[0-9a-f]{6}$/i.test(String(h || '')); }
function themeRgb(h) { h = String(h).replace('#', ''); return [0, 2, 4].map(function (i) { return parseInt(h.substr(i, 2), 16); }); }
function themeMix(rgb, to, t) { return rgb.map(function (v, i) { return Math.round(v + (to[i] - v) * t); }); }
function themeHex(rgb) { return '#' + rgb.map(function (v) { return ('0' + Math.max(0, Math.min(255, v)).toString(16)).slice(-2); }).join(''); }
// ความต่างของสีกับตัวหนังสือสีขาว (WCAG) — ต่ำกว่า 4.5 ตัวหนังสือบนปุ่มเริ่มอ่านยาก
function themeContrastWithWhite(h) {
  var c = themeRgb(h).map(function (v) { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 1.05 / (0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2] + 0.05);
}
function themePalette(hex) {
  var b = themeRgb(themeHexOk(hex) ? hex : THEME_DEFAULT_COLOR), W = [255, 255, 255], K = [0, 0, 0];
  return {
    light: { p: themeHex(b), d: themeHex(themeMix(b, K, 0.2)), l: themeHex(themeMix(b, W, 0.9)) },
    dark: { p: themeHex(themeMix(b, W, 0.1)), d: themeHex(themeMix(b, W, 0.42)), l: 'rgba(' + b.join(', ') + ', 0.22)' },
    rgb: b.join(' '), g1: themeHex(themeMix(b, K, 0.14)), g2: themeHex(b), g3: themeHex(themeMix(b, W, 0.22))
  };
}
function themeCss(hex) {
  var t = themePalette(hex);
  return ':root{--primary:' + t.light.p + ';--primary-dark:' + t.light.d + ';--primary-light:' + t.light.l + ';--primary-rgb:' + t.rgb +
    ';--grad-1:' + t.g1 + ';--grad-2:' + t.g2 + ';--grad-3:' + t.g3 + '}' +
    ':root[data-theme="dark"]{--primary:' + t.dark.p + ';--primary-dark:' + t.dark.d + ';--primary-light:' + t.dark.l + '}';
}
// สีของบัญชีที่ล็อกอินอยู่ (หรือของหน้าเข้าสู่ระบบ)
function resolveThemeColor(s, forLogin) {
  s = s || {};
  var base = themeHexOk(s.themeColor) ? s.themeColor : THEME_DEFAULT_COLOR;
  if (s.themeMode !== 'department') return base;
  if (forLogin) return themeHexOk(s.themeLoginColor) ? s.themeLoginColor : base;
  var u = getSession();
  var dc = u && u.department && s.departmentColors && s.departmentColors[u.department];
  return themeHexOk(dc) ? dc : base;
}
function setThemeCss(css) {
  var st = document.getElementById('bnkahThemeVars');
  if (!st) { st = document.createElement('style'); st.id = 'bnkahThemeVars'; document.head.appendChild(st); }
  if (st.textContent !== css) st.textContent = css;
}
function applyThemeColor(s) {
  var forLogin = document.body && document.body.classList.contains('login-page');
  var css = themeCss(resolveThemeColor(s, forLogin));
  setThemeCss(css);
  try { localStorage.setItem(forLogin ? THEME_CSS_LOGIN_KEY : THEME_CSS_KEY, css); } catch (e) { /* ไม่เป็นไร */ }
}
// ป้ายกลุ่มบริหารงานตามสีของกลุ่ม (1.58: แสดงสีของกลุ่มเสมอ ไม่ขึ้นกับรูปแบบธีมของระบบ) — ใส่ใน tag ที่ต้องการ: '<span class="x"' + deptColorAttr(dept) + '>'
// ตั้งตัวแปร --dp* ให้ CSS (.dept-colored) สลับ --primary/--primary-dark/--primary-light ภายในป้ายนั้นทั้งโหมดสว่าง/มืด
function deptThemeColor(dept, s) {
  s = s || _settingsCache || cachedBrand() || {};
  if (!dept || !s.departmentColors) return '';
  var c = s.departmentColors[dept] || s.departmentColors[String(dept).replace(/^กลุ่มบริหารงาน/, '')];
  return themeHexOk(c) ? c : '';
}
function deptColorAttr(dept, s) {
  var c = deptThemeColor(dept, s);
  if (!c) return '';
  var t = themePalette(c);
  return ' data-dept-color="' + c + '" style="--dp:' + t.light.p + ';--dp-d:' + t.light.d + ';--dp-l:' + t.light.l + ';--dpk:' + t.dark.p + ';--dpk-d:' + t.dark.d + ';--dpk-l:' + t.dark.l + '"';
}
// 1.55.131026: รูปหน้าเข้าสู่ระบบ (settings.loginHeroDataUrl) แสดงแทนโลโก้ + ชื่อเว็บ + คำบรรยายที่หัวการ์ด (.login-hero ใน index.html)
// index.html มีสคริปต์สั้นๆ ใส่รูปจากค่าที่จำไว้ (bnkah_brand) ทันทีหลังหัวการ์ดถูกสร้าง — ไม่เห็นหัวสีม่วงแวบก่อนรูปขึ้น
function renderLoginHero(s) {
  var hero = document.querySelector('.login-hero');
  if (!hero) return;
  var url = s.loginHeroDataUrl || '';
  hero.classList.toggle('has-image', !!url);
  var im = hero.querySelector('img.login-hero-img');
  if (url) {
    if (!im) { im = document.createElement('img'); im.className = 'login-hero-img'; hero.appendChild(im); }
    if (im.getAttribute('src') !== url) im.setAttribute('src', url);
    im.alt = s.siteName || 'BNKAcademicHub';
  } else if (im) { im.remove(); }
}
async function applyBranding() {
  var s = await getSiteSettings();
  if (!s.__fallback) { cacheBrand(s); renderBrand(s); applyThemeColor(s); reorderSideNav(s.navOrder); }
  if (s.siteName && document.title) {
    document.title = document.title.replace(/BNKAcademicHub/, s.siteName);
  }
  if (s.iconDataUrl) {
    var link = document.querySelector('link[rel="icon"]');
    if (!link) { link = document.createElement('link'); link.rel = 'icon'; document.head.appendChild(link); }
    link.href = s.iconDataUrl;
  }
  document.querySelectorAll('.js-brand-logo-lg').forEach(function (el) {
    if (s.logoDataUrl) el.outerHTML = '<img src="' + s.logoDataUrl + '" class="brand-logo-lg" alt="โลโก้" />';
  });
  applySummerVisibility(s);
  return s;
}

// ซ่อนตัวเลือก "ภาคฤดูร้อน" ออกจากทุก <select> ในหน้า ถ้า Super Admin ปิดใช้งานไว้ (บางโรงเรียนไม่มีภาคเรียนนี้) — ตั้งแต่ V9.6
// ทำงานได้ทั้งสองทาง (ปิด → เอาออก, เปิดกลับมา → ใส่คืน) โดยจำ select ที่เคยมีตัวเลือกนี้ไว้ด้วย data-had-summer เพื่อใส่คืนถูกตำแหน่ง (ภาคฤดูร้อนเป็นตัวเลือกสุดท้ายเสมอในทุก select ของระบบ)
// หมายเหตุ: ถ้า select นั้นกำลังเลือกค่า "summer" อยู่พอดี (เช่นกำลังกรองข้อมูลเก่าที่เคยเป็นภาคฤดูร้อน) จะไม่ตัดตัวเลือกออก เพื่อไม่ให้ค่าที่เลือกอยู่หายไปเฉยๆ —
// ข้อมูลเก่าที่เคยบันทึกเป็นภาคฤดูร้อนไว้ก่อนปิดตัวเลือกนี้ ยังแสดงผลได้ตามปกติเสมอ เพราะป้ายกำกับ "ภาคฤดูร้อน" ที่แสดงในตาราง/การ์ดต่างๆ คำนวณจากค่าที่บันทึกไว้ ไม่ได้อิงจาก <option> นี้
function applySummerVisibility(s) {
  var enabled = !s || s.summerEnabled !== false;
  document.querySelectorAll('select').forEach(function (sel) {
    var opt = sel.querySelector('option[value="summer"]');
    if (enabled) {
      if (!opt && sel.getAttribute('data-had-summer') === '1') {
        var newOpt = document.createElement('option');
        newOpt.value = 'summer';
        newOpt.textContent = 'ภาคฤดูร้อน';
        sel.appendChild(newOpt);
      }
    } else if (opt) {
      sel.setAttribute('data-had-summer', '1');
      if (sel.value !== 'summer') opt.remove();
    }
  });
}

// ---------- Helpers ----------
function fileToBase64(file) {
  return new Promise(function (resolve, reject) {
    var reader = new FileReader();
    reader.onload = function () { resolve(String(reader.result).split(',')[1]); };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
/**
 * ส่งไฟล์งาน 1 ไฟล์ขึ้น Drive — แบ่งเป็น 3 ขั้นตอนแทนที่จะเป็น apiCall เดียวจบแบบ action อื่นๆ:
 *   1) apiCall('teacherUploadPrepare', ...) — ให้ Worker ตรวจสิทธิ์/ประเภทงาน แล้วขอ "ตั๋วอัปโหลด" จาก Drive relay
 *   2) ยิงไฟล์ (base64) ตรงไปที่ relay เอง ไม่ผ่าน Worker เลย
 *   3) apiCall('teacherUploadFinalize', ...) — แจ้ง Worker บันทึกผลไฟล์ลงฐานข้อมูล
 * เหตุผลที่ไม่ใช่คำสั่งเดียวจบเหมือนระบบเดิม: ไฟล์งานอาจใหญ่ถึง 25MB ซึ่งเกินเวลาประมวลผล (CPU time) ต่อ
 * คำขอของ Cloudflare Workers แผนฟรี (~10ms) ถ้าให้ Worker เป็นตัวกลางรับ-ส่งไฟล์เองจะเสี่ยงอัปโหลดไม่สำเร็จ
 * สำหรับไฟล์ขนาดใหญ่ — ขั้นตอนที่ใช้เวลานาน (อ่าน/ยิงไฟล์จริง) จึงข้าม Worker ไปเลย
 */
// ---------- 1.86: ส่งไฟล์ตรงเข้า Google Drive (ส่งงาน / คำสั่ง / เกียรติบัตร) — relay เป็นวิธีสำรอง ----------
// *Prepare ที่ส่ง direct + origin ไป จะได้ prep.session (ช่องอัปโหลดแบบ resumable ของ Google) + prep.uploadToken (ticket ของ relay)
// ส่งตรงสำเร็จ → ยืนยันกับ relay ด้วย ticket (relay ตรวจโฟลเดอร์ + ตั้งแชร์) · ส่งตรงไม่ได้ (โหมดอัตโนมัติ) → ส่งผ่าน relay ด้วย ticket เดิม
var RELAY_MAX_UPLOAD = 25 * 1024 * 1024, DIRECT_MAX_UPLOAD = 100 * 1024 * 1024;
function directUploadParams() { return { direct: 1, origin: location.origin }; }
// เพดานขนาดไฟล์ = ค่าที่ผู้ดูแลระบบเลือก (1.86.1: fileMaxMB 10/25/50/100 — ค่าเริ่มต้น 25) · ผ่าน relay เท่านั้น = ไม่เกิน 25MB
function maxUploadBytes() {
  var s = _settingsCache && !_settingsCache.__fallback ? _settingsCache : {};
  var mb = [10, 25, 50, 100].indexOf(Number(s.fileMaxMB)) !== -1 ? Number(s.fileMaxMB) : 25;
  var lim = Math.min(mb * 1024 * 1024, DIRECT_MAX_UPLOAD);
  return s.fileUploadMode === 'relay' ? Math.min(lim, RELAY_MAX_UPLOAD) : lim;
}
function maxUploadLabel() { return Math.round(maxUploadBytes() / 1048576) + 'MB'; }
function applyUploadMaxLabels() { document.querySelectorAll('[data-upmax]').forEach(function (el) { el.textContent = maxUploadLabel(); }); }
function _upSleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function _xhrPutFile(url, body, contentRange, onProg) {
  return new Promise(function (resolve, reject) {
    var x = new XMLHttpRequest();
    x.open('PUT', url);
    if (contentRange) x.setRequestHeader('Content-Range', contentRange);
    if (onProg && body) x.upload.onprogress = function (ev) { if (ev.lengthComputable) onProg(ev.loaded); };
    x.onload = function () {
      if (x.status === 200 || x.status === 201) { try { resolve({ done: JSON.parse(x.responseText) }); } catch (e) { reject(new Error('Google ตอบกลับไม่ถูกต้อง')); } }
      else if (x.status === 308) { var rg = x.getResponseHeader('Range'); resolve({ got: rg ? Number(rg.split('-')[1]) + 1 : 0 }); }
      else reject(Object.assign(new Error('Google ตอบกลับ HTTP ' + x.status), { http: x.status }));
    };
    x.onerror = function () { reject(Object.assign(new Error('เชื่อมต่อ Google ไม่สำเร็จ (เครือข่ายหรือ CORS)'), { net: true })); };
    x.send(body);
  });
}
// PUT ไฟล์ไปที่ช่องอัปโหลด — เน็ตสะดุดกลางทาง = ถามว่า Google รับไปแล้วเท่าไรแล้วส่งต่อจากจุดนั้น (สูงสุด 3 ครั้ง)
async function _putDirect(url, file, onFrac) {
  var size = file.size, got = 0, tries = 0;
  for (;;) {
    try {
      var r = await _xhrPutFile(url, got ? file.slice(got) : file, got ? 'bytes ' + got + '-' + (size - 1) + '/' + size : '', function (l) { if (onFrac) onFrac(Math.min(1, (got + l) / Math.max(1, size))); });
      if (r.done) return r.done;
      got = r.got;
    } catch (e) {
      if (++tries > 3 || (e.http && e.http >= 400 && e.http < 500 && e.http !== 408 && e.http !== 429)) throw e;
      if (tries === 1 && !got && e.net) throw e; // ส่งตรงไม่ได้ตั้งแต่ต้น (เครือข่าย/ไฟร์วอลล์) — ไม่ต้องรอ ให้ใช้วิธีสำรองเลย
      await _upSleep(1000 * tries);
      try { var q = await _xhrPutFile(url, null, 'bytes */' + size); if (q.done) return q.done; got = q.got; } catch (e2) { got = 0; }
    }
  }
}
async function _relayPost(prep, payload) {
  var text;
  try {
    var res = await fetch(prep.relayUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
    text = await res.text();
  } catch (e) { throw new Error('ติดต่อระบบเก็บไฟล์ไม่สำเร็จ (เครือข่ายขัดข้อง) กรุณาลองใหม่อีกครั้ง'); }
  var j;
  try { j = JSON.parse(text); } catch (e) { throw new Error('ระบบเก็บไฟล์ตอบกลับข้อมูลไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง'); }
  if (!j.ok) throw new Error(j.error || 'อัปโหลดไฟล์ไม่สำเร็จ');
  return j.data;
}
// opts: filename, mimeType, onProgress(0..1 — เฉพาะส่งตรง), onRelay() (สลับไปส่งผ่าน relay) · คืน {fileId, url, directUrl, via, fallbackReason}
async function sendPreparedFile(prep, file, opts) {
  opts = opts || {};
  var name = opts.filename || prep.uploadFileName || file.name, mime = opts.mimeType || file.type || 'application/octet-stream', reason = '';
  if (prep.session) {
    var stage = 'put';
    try {
      setUploadVia('direct');
      var done = await _putDirect(prep.session, file, opts.onProgress);
      stage = 'confirm';
      for (var a = 0; ; a++) {
        try { var conf = await _relayPost(prep, { uploadToken: prep.uploadToken, directFileId: done.id }); conf.via = 'direct'; return conf; }
        catch (e) { if (a >= 2) throw e; await _upSleep(1500 * (a + 1)); }
      }
    } catch (e) {
      setUploadVia('');
      if (stage === 'confirm') throw new Error('ส่งไฟล์เข้า Google Drive แล้ว แต่ยืนยันไฟล์ไม่สำเร็จ (' + e.message + ') กรุณาส่งใหม่');
      reason = (e && e.message) || 'ส่งตรงไม่สำเร็จ';
      if (prep.uploadMode === 'direct') throw new Error('ส่งตรงเข้า Google Drive ไม่สำเร็จ: ' + reason + ' (ตั้งค่าไว้เป็น "ส่งตรงเท่านั้น")');
      if (file.size > RELAY_MAX_UPLOAD) throw new Error('ส่งตรงเข้า Google Drive ไม่สำเร็จ (' + reason + ') — ไฟล์ใหญ่เกิน 25MB จึงส่งด้วยวิธีสำรองไม่ได้ กรุณาลองใหม่');
      if (opts.onRelay) opts.onRelay();
    }
  } else if (prep.sessionError) reason = 'ขอช่องส่งตรงไม่สำเร็จ: ' + prep.sessionError;
  if (file.size > RELAY_MAX_UPLOAD) throw new Error('ไฟล์มีขนาดใหญ่เกิน 25MB');
  var r = await _relayPost(prep, { uploadToken: prep.uploadToken, base64: await fileToBase64(file), filename: name, mimeType: mime });
  r.via = 'relay'; r.fallbackReason = reason;
  return r;
}
// ใช้กับ withProgress: ส่งตรง = แถบเดินตาม % จริง · ผ่าน relay = แถบไหลตามเวลาที่ประมาณ (แบบเดิม)
async function sendPreparedFileProgress(prep, file, p, from, to, label, opts) {
  var relayCreep = function () { p.creep(from, to, estimateUploadMs(file.size), label); };
  if (prep.session) p.setProgress(from, label); else relayCreep();
  return sendPreparedFile(prep, file, Object.assign({ onProgress: function (fr) { p.setProgress(from + (to - from) * fr); }, onRelay: relayCreep }, opts || {}));
}
async function submitWorkFile(file, meta) {
  var prep = await apiCall('teacherUploadPrepare', {
    fileName: file.name,
    mimeType: file.type,
    fileSize: file.size,
    academicYear: meta.academicYear,
    semester: meta.semester,
    categoryId: meta.categoryId,
    title: meta.title,
    description: meta.description,
    customFieldValues: meta.customFieldValues,
    replacesId: meta.replacesId || '', // 1.85: อัปโหลดทับไฟล์ที่เจ้าหน้าที่ให้แก้ไข
    eventId: meta.eventId || '', // 1.88: รอบที่ส่ง (งานแบบหลายรอบ)
    roomId: meta.roomId || '', // 1.90: งานตามห้อง (สมุดโฮมรูม)
    direct: 1, origin: location.origin // 1.86: ขอช่องส่งตรงเข้า Google Drive
  });
  // ชื่อไฟล์จริงที่จะใช้อัปโหลด (ตั้งแต่ V11.7): Worker คำนวณให้แล้วจากประเภทงาน/ภาคเรียน/ปีการศึกษา (ดู uploadFileName ที่
  // teacherUploadPrepare คืนมา) แทนชื่อไฟล์เดิมจากเครื่องผู้ใช้ — เผื่อกรณี Worker เวอร์ชันเก่ายังไม่ส่งค่านี้มา จึงย้อนกลับไปใช้
  // ชื่อไฟล์เดิมได้เสมอ (fallback)
  var uploadFileName = prep.uploadFileName || file.name;
  if (meta.onStage) meta.onStage('upload');
  // 1.86: ส่งตรงเข้า Google Drive (prep.session) — ไม่ได้ค่อยส่งผ่าน relay (วิธีสำรอง) · ผลรูปแบบเดียวกัน
  var result = await sendPreparedFile(prep, file, { filename: uploadFileName, mimeType: file.type, onProgress: meta.onProgress,
    onRelay: function () { if (meta.onStage) meta.onStage('upload'); } });
  if (meta.onStage) meta.onStage('finalize');
  return apiCall('teacherUploadFinalize', {
    submissionId: prep.submissionId,
    fileId: result.fileId,
    fileUrl: result.url,
    directUrl: result.directUrl,
    fileName: uploadFileName,
    mimeType: file.type,
    via: result.via, fallbackReason: result.fallbackReason || ''
  });
}
/**
 * อ่านไฟล์รูปภาพแล้วย่อขนาดอัตโนมัติ (ไม่เกิน maxSize px ด้านที่ยาวที่สุด) ก่อนแปลงเป็น base64
 * ใช้กับไอคอน/โลโก้เว็บ เพื่อไม่ให้ไฟล์ใหญ่เกินไปโดยไม่ต้องให้ผู้ใช้ไปย่อเอง — คงความโปร่งใสไว้ด้วยการ export เป็น PNG เสมอ
 */
function resizeImageToBase64(file, maxSize) {
  return new Promise(function (resolve, reject) {
    if (!file.type || file.type.indexOf('image/') !== 0) {
      reject(new Error('กรุณาเลือกไฟล์รูปภาพเท่านั้น'));
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        var scale = Math.min(1, maxSize / Math.max(w, h));
        var outW = Math.max(1, Math.round(w * scale));
        var outH = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        var ctx = canvas.getContext('2d');
        ctx.clearRect(0, 0, outW, outH);
        ctx.drawImage(img, 0, 0, outW, outH);
        var dataUrl = canvas.toDataURL('image/png');
        resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/png', width: outW, height: outH });
      };
      img.onerror = function () { reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพนี้ได้ ลองไฟล์อื่น')); };
      img.src = String(reader.result);
    };
    reader.onerror = function () { reject(new Error('ไม่สามารถอ่านไฟล์นี้ได้')); };
    reader.readAsDataURL(file);
  });
}
/**
 * อ่านไฟล์รูปโปรไฟล์ ย่อขนาด (ไม่เกิน 480px ด้านที่ยาวที่สุด) แล้วบีบอัดเป็น JPEG คุณภาพ 0.85 ก่อนอัปโหลด
 * เพื่อให้ไฟล์เล็กพอเหมาะกับการแสดงในหน้าเว็บเสมอ (ทั้งหน้าโปรไฟล์และหน้าผลงานสาธารณะ) โดยผู้ใช้ไม่ต้องไปย่อไฟล์เอง
 */
function resizeImageForAvatar(file) {
  return new Promise(function (resolve, reject) {
    if (!file.type || file.type.indexOf('image/') !== 0) {
      reject(new Error('กรุณาเลือกไฟล์รูปภาพเท่านั้น'));
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      var img = new Image();
      img.onload = function () {
        var w = img.naturalWidth || img.width;
        var h = img.naturalHeight || img.height;
        var maxSize = 480;
        var scale = Math.min(1, maxSize / Math.max(w, h));
        var outW = Math.max(1, Math.round(w * scale));
        var outH = Math.max(1, Math.round(h * scale));
        var canvas = document.createElement('canvas');
        canvas.width = outW;
        canvas.height = outH;
        var ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff'; // กันพื้นหลังโปร่งใส (เช่น ไฟล์ PNG) กลายเป็นสีดำตอนแปลงเป็น JPEG
        ctx.fillRect(0, 0, outW, outH);
        ctx.drawImage(img, 0, 0, outW, outH);
        var dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        resolve({ base64: dataUrl.split(',')[1], mimeType: 'image/jpeg', dataUrl: dataUrl, width: outW, height: outH });
      };
      img.onerror = function () { reject(new Error('ไม่สามารถอ่านไฟล์รูปภาพนี้ได้ ลองไฟล์อื่น')); };
      img.src = String(reader.result);
    };
    reader.onerror = function () { reject(new Error('ไม่สามารถอ่านไฟล์นี้ได้')); };
    reader.readAsDataURL(file);
  });
}
/**
 * อัปโหลดรูปโปรไฟล์ (ที่ย่อ/บีบอัดไว้แล้วจาก resizeImageForAvatar) ขึ้น Google Drive ผ่าน Drive relay
 * ด้วยขั้นตอนเดียวกับการส่งไฟล์งาน (prepare -> ยิงตรงไป relay -> finalize) ดู submitWorkFile ด้านบนประกอบ
 */
// targetUserId (ตั้งแต่ 1.33.101026): ถ้าระบุ = Super Admin อัปรูปให้บัญชีอื่น (adminAvatarUpload*) ไม่ระบุ = รูปของตัวเอง
async function uploadResizedAvatar(resized, targetUserId) {
  var approxBytes = Math.ceil(resized.base64.length * 3 / 4);
  var prep = await apiCall(targetUserId ? 'adminAvatarUploadPrepare' : 'profileAvatarUploadPrepare', targetUserId ? { userId: targetUserId, fileName: 'avatar.jpg', fileSize: approxBytes } : { fileName: 'avatar.jpg', fileSize: approxBytes });
  var relayText;
  try {
    var relayRes = await fetch(prep.relayUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ uploadToken: prep.uploadToken, base64: resized.base64, filename: 'avatar.jpg', mimeType: resized.mimeType })
    });
    relayText = await relayRes.text();
  } catch (e) {
    throw new Error('ติดต่อระบบเก็บไฟล์ไม่สำเร็จ (เครือข่ายขัดข้อง) กรุณาลองใหม่อีกครั้ง');
  }
  var relayJson;
  try {
    relayJson = JSON.parse(relayText);
  } catch (e) {
    throw new Error('ระบบเก็บไฟล์ตอบกลับข้อมูลไม่ถูกต้อง กรุณาลองใหม่อีกครั้ง');
  }
  if (!relayJson.ok) throw new Error(relayJson.error || 'อัปโหลดรูปโปรไฟล์ไม่สำเร็จ');
  var result = relayJson.data;
  var finalizePayload = {
    fileId: result.fileId, fileUrl: result.url, directUrl: result.directUrl,
    fileName: 'avatar.jpg', mimeType: resized.mimeType
  };
  if (targetUserId) finalizePayload.userId = targetUserId;
  return apiCall(targetUserId ? 'adminAvatarUploadFinalize' : 'profileAvatarUploadFinalize', finalizePayload);
}

// ไอคอนคนทั่วไป (SVG เส้น currentColor) — ใช้เป็นรูปโปรไฟล์เริ่มต้นเมื่อบัญชียังไม่ได้อัปโหลดรูปเอง
var PERSON_ICON_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 12c2.76 0 5-2.24 5-5s-2.24-5-5-5-5 2.24-5 5 2.24 5 5 5zm0 2c-3.33 0-10 1.68-10 5v3h20v-3c0-3.32-6.67-5-10-5z"/></svg>';
// คืน HTML สำหรับวงกลมรูปโปรไฟล์: รูปที่อัปโหลดไว้ (ถ้ามี) หรือไอคอนคนเริ่มต้น
function avatarInnerHtml(avatarUrl) {
  if (avatarUrl) return '<img src="' + escapeHtml(avatarUrl) + '" alt="" />';
  return PERSON_ICON_SVG;
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
// จุดสีเล็กๆ แสดงหน้าชื่อประเภทงาน (ตั้งแต่ V9.7) — ใช้ร่วมกันทุกหน้าที่แสดงชื่อประเภทงาน (Hub ครู/สรุปรวม/ตั้งค่าระบบ)
function categoryDotHtml(color) {
  return '<span class="category-dot" style="background:' + escapeHtml(color || '#3457d5') + ';"></span>';
}
// สร้าง map { categoryId: color } จากรายการประเภทงาน — ใช้เมื่อรายการที่จะแสดง (ผลงาน/กำหนดการ) มีแค่ categoryId/categoryName
// (ไม่ได้เก็บสีติดไปด้วยตอนบันทึก) ให้ดึงสีปัจจุบันของประเภทงานนั้นมาแสดงแทนเสมอ — สีจะอัปเดตทันทีทุกจุดถ้า Super Admin เปลี่ยนสีทีหลัง
// 1.65: สีของประเภทงาน = สีของกลุ่มบริหารงานที่ผูกไว้ (ตั้งค่าที่ "กลุ่มบริหารงาน") — ไม่มีช่องเลือกสีตอนสร้าง/แก้ไขประเภทงานแล้ว
// ประเภทงานที่ยังไม่ผูกกลุ่ม/กลุ่มยังไม่ตั้งสี = สีที่เคยเก็บไว้ (ค่าเริ่มต้น #3457d5)
// 1.71: รูปแบบการ์ดผลงานเหลือ 3 แบบ — แปลงค่าเดิม: book/bookInline → 'bookInline' (ไฟล์ใหญ่) · frame → 'frame' (ไฟล์ปานกลาง)
// · ''/research/pin/compact/อื่นๆ → '' (ไฟล์เล็ก)
function normalizeTemplate(t) {
  t = String(t || '');
  if (t === 'book' || t === 'bookInline') return 'bookInline';
  if (t === 'frame') return 'frame';
  return '';
}
function categoryColor(c) {
  c = c || {};
  return (c.department && deptThemeColor(c.department)) || c.color || '#3457d5';
}
// 1.66: กลุ่มของประกาศ — ป้าย/สี (ว่าง = ประกาศจากโรงเรียน ใช้สีธีมหลัก)
function annGroupInfo(dept) {
  return { label: dept ? groupLabel(dept) : 'โรงเรียน', color: dept ? (deptThemeColor(dept) || '') : '' };
}
function buildCategoryColorMap(categories) {
  var map = {};
  (categories || []).forEach(function (c) { map[c.id] = categoryColor(c); _catDeptMap[c.id] = c.department || ''; });
  return map;
}
// ฝ่ายของประเภทงาน (ตั้งแต่ 1.41.111026) — buildCategoryColorMap เก็บ { categoryId: ชื่อฝ่าย } ไว้ด้วยทุกครั้งที่หน้าโหลดรายการประเภทงาน
// categoryDeptBadgeHtml(id) คืนป้าย "ฝ่ายวิชาการ" (ไม่ผูกฝ่าย/ไม่รู้จัก id = ไม่แสดงอะไร) ใช้ต่อท้ายชื่อประเภทงานทุกจุด
var _catDeptMap = {};
function categoryDeptBadgeHtml(categoryId) {
  var d = _catDeptMap[categoryId];
  return d ? ' <span class="cat-dept-badge"' + deptColorAttr(d) + '>' + escapeHtml(groupLabel(d)) + '</span>' : ''; // 1.61: สีของกลุ่ม
}
function categoryDeptSuffix(categoryId) {
  var d = _catDeptMap[categoryId];
  return d ? ' · ' + groupLabel(d) : '';
}
// ชื่อ "กลุ่มบริหารงาน" (ตั้งแต่ 1.41.111026) — ระบบเก็บเฉพาะส่วนท้ายของชื่อ (เช่น 'วิชาการ') แล้วต่อคำนำหน้าตอนแสดงผลเสมอ
// (ข้อมูลที่เคยตั้งเป็น "ฝ่ายวิชาการ" เดิมจึงขึ้นเป็น "กลุ่มบริหารงานวิชาการ" ทันที) ถ้าชื่อมีคำนำหน้าอยู่แล้วไม่ต่อซ้ำ
var GROUP_PREFIX = 'กลุ่มบริหารงาน';
function groupLabel(name) {
  var n = String(name || '').trim();
  if (!n) return '';
  return n.indexOf(GROUP_PREFIX) === 0 ? n : GROUP_PREFIX + n;
}
function normalizeGroupName(v) {
  var n = String(v || '').replace(/\s+/g, ' ').trim();
  if (n.indexOf(GROUP_PREFIX) === 0) n = n.slice(GROUP_PREFIX.length).trim();
  return n.slice(0, 60);
}

// ---------- ชุดไอคอน Font Awesome — ตั้งแต่รอบปรับสไตล์เว็บทั้งระบบให้เหมือน bnksa-attendance (Tailwind + Font Awesome)
// เดิมใช้ SVG เส้นวาดเอง (ICON_PATHS) มาตั้งแต่ V-ถัดไปหลัง V10.1 เปลี่ยนมาใช้ไอคอน Font Awesome (โหลดจาก CDN ใน <head>
// ทุกหน้าแล้ว) แทน เพื่อให้ตรงกับชุดไลบรารีของเว็บต้นแบบ — คง API เดิม icon(name, size) ไว้ทุกจุดเรียกใช้เดิมไม่ต้องแก้
var ICON_FA = {
  home: 'fa-house', memo: 'fa-file-lines', summary: 'fa-chart-column', settings: 'fa-gear', calendar: 'fa-calendar-days',
  announce: 'fa-bullhorn', folder: 'fa-folder-open', tag: 'fa-tag', users: 'fa-users', trash: 'fa-trash',
  edit: 'fa-pen', plus: 'fa-plus', link: 'fa-link', checklist: 'fa-list-check', upload: 'fa-cloud-arrow-up',
  image: 'fa-image', key: 'fa-key', logout: 'fa-right-from-bracket', history: 'fa-clock-rotate-left',
  sun: 'fa-sun', palette: 'fa-palette', layout: 'fa-table-cells-large', pin: 'fa-thumbtack', clock: 'fa-clock',
  file: 'fa-file-lines', directory: 'fa-address-book', orders: 'fa-file-signature', certs: 'fa-award', gallery: 'fa-images', schoolcal: 'fa-calendar-week', supervision: 'fa-chalkboard-user'
};
function icon(name, size) {
  var s = size || 16;
  var fa = ICON_FA[name] || 'fa-circle';
  return '<i class="fas ' + fa + ' ui-icon" style="font-size:' + s + 'px" aria-hidden="true"></i>';
}
// 1.58: วันที่วันนี้ ('YYYY-MM-DD' ตามเวลาเครื่อง) + แสดงวันที่แบบไทยข้างช่อง <input type="date"> (ช่องวันที่ของเบราว์เซอร์แสดง ค.ศ.)
function todayYmd() { var d = new Date(); return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2); }
function syncDateThai(inputId, outId) {
  var i = document.getElementById(inputId), o = document.getElementById(outId);
  if (!i || !o) return;
  o.textContent = i.value ? '(' + formatDateThai(i.value) + ')' : '(ไม่ระบุ)';
}
// 1.57: ป้ายภาคเรียน + ป้ายปีการศึกษา แยกกันชัดเจน — ภาคเรียนที่ 1 = ป้ายทึบสีหลัก · ภาคเรียนที่ 2 = ป้ายขอบสีหลัก · ภาคฤดูร้อน = ป้ายสีส้ม · ปีการศึกษา = ป้ายกลาง
// opts.short: "ปี 2569" แทน "ปีการศึกษา 2569" (ใช้ในคอลัมน์แคบ)
function termTagsHtml(semester, academicYear, opts) {
  opts = opts || {};
  var sem = String(semester || '');
  var cls = sem === 'summer' ? 'ts' : sem === '2' ? 't2' : 't1';
  var label = sem === 'summer' ? 'ภาคฤดูร้อน' : 'ภาคเรียนที่ ' + sem;
  return '<span class="term-tag ' + cls + '">' + escapeHtml(label) + '</span>' +
    (academicYear ? '<span class="year-tag">' + (opts.short ? 'ปี ' : 'ปีการศึกษา ') + escapeHtml(String(academicYear)) + '</span>' : '');
}
// 1.63: โหลดข้อมูลทีละปีการศึกษา + จำผลไว้ (เปลี่ยนกลับมาปีเดิมไม่ต้องโหลดซ้ำ) — fetchYear(year) คืน Promise ('' = ทุกปี)
// ---------- 1.79: แถบตัวกรองมาตรฐานของคลังคำสั่ง/คลังเกียรติบัตร/คลังรูปภาพ/หน้าสาธารณะ ----------
// โครง: .flt > input.flt-q + button.flt-toggle + .flt-panel (select ทั้งหมด + .flt-clear) · ตามด้วย .flt-chips และ .flt-meta (.flt-count + hint)
// จอใหญ่ = แถวเดียว · มือถือ = ช่องค้นหา + ปุ่ม "ตัวกรอง" (ตัวเลข = กรองอยู่กี่อย่าง) กดแล้วแผงเลื่อนขึ้นจากด้านล่าง
// opts.defaults(): { selectId: ค่าเริ่มต้น } (คำนวณใหม่ทุกครั้ง เช่น ปีการศึกษาปัจจุบัน) · opts.unit: 'รายการ'
function filterBarHtml(o) {
  // o: { id, search: {id, placeholder}, fields: [{id, label, html}], countId, hintId }
  return '<div class="flt" id="' + o.id + '">' +
    '<input type="search" class="flt-q" id="' + o.search.id + '" placeholder="' + escapeHtml(o.search.placeholder) + '" aria-label="ค้นหา" />' +
    '<button type="button" class="flt-toggle" aria-haspopup="dialog"><i class="fa-solid fa-sliders" aria-hidden="true"></i> ตัวกรอง <span class="flt-n" hidden></span></button>' +
    '<div class="flt-backdrop"></div>' +
    '<div class="flt-panel" role="group" aria-label="ตัวกรอง">' +
      '<div class="flt-head"><span><i class="fa-solid fa-sliders" aria-hidden="true"></i> ตัวกรอง</span><button type="button" class="modal-close-x flt-x" aria-label="ปิด">✕</button></div>' +
      o.fields.map(function (f) { return '<label class="flt-f"><span>' + escapeHtml(f.label) + '</span>' + f.html + '</label>'; }).join('') +
      '<div class="flt-acts"><button type="button" class="btn btn-close flt-clear" hidden><i class="fa-solid fa-xmark" aria-hidden="true"></i> ล้างตัวกรอง</button><button type="button" class="btn btn-success flt-done">แสดงผล</button></div>' +
    '</div></div>' +
    '<div class="flt-chips" id="' + o.id + 'Chips"></div>' +
    '<div class="flt-meta"><span class="flt-count" id="' + (o.countId || o.id + 'Count') + '"></span>' + (o.hintId ? '<span class="year-scope-hint" id="' + o.hintId + '" hidden></span>' : '') + '</div>';
}
function initFilterBar(el, opts) {
  if (typeof el === 'string') el = document.getElementById(el);
  opts = opts || {};
  var panel = el.querySelector('.flt-panel'), chips = document.getElementById(el.id + 'Chips');
  var last = { n: 0 };
  function defs() { return (opts.defaults && opts.defaults()) || {}; }
  function selects() { return Array.from(panel.querySelectorAll('select')); }
  function active() { var d = defs(); return selects().filter(function (s) { return (d[s.id] !== undefined ? String(d[s.id]) : '') !== s.value; }); }
  function setVal(s, v) { if (s.value === v) return; s.value = v; s.dispatchEvent(new Event('change', { bubbles: true })); }
  function open(on) {
    el.classList.toggle('open', !!on);
    document.documentElement.classList.toggle('flt-lock', !!on);
  }
  el.querySelector('.flt-toggle').addEventListener('click', function () { open(!el.classList.contains('open')); });
  el.querySelector('.flt-x').addEventListener('click', function () { open(false); });
  el.querySelector('.flt-done').addEventListener('click', function () { open(false); });
  el.querySelector('.flt-backdrop').addEventListener('click', function () { open(false); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && el.classList.contains('open')) open(false); });
  el.querySelector('.flt-clear').addEventListener('click', function () {
    var d = defs();
    selects().forEach(function (s) { setVal(s, d[s.id] !== undefined ? String(d[s.id]) : ''); });
    var q = el.querySelector('.flt-q'); if (q.value) { q.value = ''; q.dispatchEvent(new Event('input', { bubbles: true })); }
  });
  if (chips) chips.addEventListener('click', function (e) {
    var b = e.target.closest('[data-flt-reset]'); if (!b) return;
    var s = document.getElementById(b.getAttribute('data-flt-reset')); var d = defs();
    if (s) setVal(s, d[s.id] !== undefined ? String(d[s.id]) : '');
  });
  function sync() {
    var act = active(), n = act.length;
    var badge = el.querySelector('.flt-n'); badge.hidden = !n; badge.textContent = n;
    el.querySelector('.flt-clear').hidden = !n && !el.querySelector('.flt-q').value;
    if (chips) chips.innerHTML = act.map(function (s) {
      var t = s.selectedOptions[0] ? s.selectedOptions[0].textContent : s.value;
      return '<button type="button" data-flt-reset="' + s.id + '">' + escapeHtml(t) + ' <i class="fa-solid fa-xmark" aria-hidden="true"></i></button>';
    }).join('');
  }
  el.addEventListener('change', sync);
  el.addEventListener('input', sync);
  return {
    // n = จำนวนที่พบ · extra = ข้อความต่อท้าย (เช่น "· 12 ใบ") — ขอบเขตปี/ภาคเรียนเติมให้เอง
    update: function (n, extra) {
      last.n = n; sync();
      var c = document.getElementById(el.id + 'Count') || el.parentNode.querySelector('.flt-count');
      var scope = selects().filter(function (s) { return /Year$|Sem$/.test(s.id) && s.value; }).map(function (s) { return s.selectedOptions[0] ? s.selectedOptions[0].textContent : ''; }).filter(Boolean);
      if (c) c.innerHTML = n == null ? '' : 'พบ <b>' + Number(n).toLocaleString('th-TH') + '</b> ' + escapeHtml(opts.unit || 'รายการ') + (extra ? ' ' + escapeHtml(extra) : '') + (scope.length ? ' · ' + escapeHtml(scope.join(' · ')) : '');
      el.querySelector('.flt-done').textContent = n == null ? 'แสดงผล' : 'แสดง ' + n + ' ' + (opts.unit || 'รายการ');
    },
    sync: sync,
    close: function () { open(false); }
  };
}
// ตัวเลือก "ทุกกลุ่ม" แบบ 2 หมวด: กลุ่มบริหารงาน (ค่า 'd:<ชื่อ>') + กลุ่มสาระการเรียนรู้ (ค่า = ชื่อกลุ่มสาระ · '__none' = ไม่มีกลุ่มสาระ)
function groupFilterOptions(departments, subjects, withNone) {
  return '<option value="">ทุกกลุ่ม</option>' +
    ((departments || []).length ? '<optgroup label="กลุ่มบริหารงาน">' + departments.map(function (d) { return '<option value="d:' + escapeHtml(d) + '">' + escapeHtml(groupLabel(d)) + '</option>'; }).join('') + '</optgroup>' : '') +
    ((subjects || []).length || withNone ? '<optgroup label="กลุ่มสาระการเรียนรู้">' + (subjects || []).map(function (g) { return '<option value="' + escapeHtml(g) + '">กลุ่มสาระฯ ' + escapeHtml(g) + '</option>'; }).join('') + (withNone ? '<option value="__none">ไม่มีกลุ่มสาระฯ</option>' : '') + '</optgroup>' : '');
}
function groupFilterMatch(v, department, subject) {
  if (!v) return true;
  if (v.indexOf('d:') === 0) return department === v.slice(2);
  if (v === '__none') return !subject;
  return subject === v;
}
function makeYearCache(fetchYear) {
  var cache = {};
  return {
    get: function (year, force) { var k = String(year || ''); if (force || !cache[k]) { cache[k] = Promise.resolve().then(function () { return fetchYear(k); }); cache[k].catch(function () { delete cache[k]; }); } return cache[k]; },
    clear: function () { cache = {}; },
    has: function (year) { return !!cache[String(year || '')]; }
  };
}
// 1.63: แสดงรายการทีละ LIST_PAGE แถว + ปุ่ม "แสดงเพิ่ม" (ใช้ data-more ให้หน้าเรียกเพิ่มจำนวนเอง)
var LIST_PAGE = 50;
// 1.70: บอก "แสดง N จาก M รายการ" + ปุ่ม "แสดงเพิ่ม" และ "แสดงทั้งหมด" (data-more-all — หน้าที่เรียกใช้ตั้งจำนวนที่แสดง = ทั้งหมด)
function listMoreHtml(shown, total) {
  if (shown >= total) return '';
  var left = total - shown;
  return '<div class="list-more"><div class="list-count">แสดง ' + shown + ' จาก ' + total + ' รายการ</div>' +
    '<button type="button" class="btn btn-secondary btn-sm" data-more="1"><i class="fa-solid fa-chevron-down"></i> แสดงเพิ่ม ' + Math.min(LIST_PAGE, left) + ' รายการ</button>' +
    '<button type="button" class="btn btn-ghost btn-sm" data-more="all" data-more-all="1"><i class="fa-solid fa-angles-down"></i> แสดงทั้งหมด (' + total + ')</button></div>';
}
// ข้อความแจ้งระหว่างโหลดปีการศึกษาอื่น/ทุกปี
function yearLoadingHtml(year) {
  return '<div class="loading">' + (year ? 'กำลังโหลดข้อมูลปีการศึกษา ' + escapeHtml(year) + '...' : 'กำลังโหลดข้อมูลทุกปีการศึกษา — อาจใช้เวลาสักครู่...') + '</div>';
}
// 1.60: เลขที่เกียรติบัตรภายใน — ตรงกับ formatCertNo ใน worker/src/handlers/certs.js ({ปีการศึกษา} {เลขที่} {ภาคเรียน})
// 1.67: {ปี พ.ศ.} = ปีพุทธศักราชของวันที่ในเกียรติบัตร (beYear) — ไม่ส่งมา = ใช้ year
function formatCertNo(format, digits, year, num, semester, beYear) {
  var d = Math.max(1, Math.min(8, Number(digits) || 4));
  var n = String(num); while (n.length < d) n = '0' + n;
  var f = String(format || 'บนค. {ปีการศึกษา}/{เลขที่}');
  if (f.indexOf('{เลขที่}') === -1) f += ' {เลขที่}';
  return f.replace(/\{ปีการศึกษา\}/g, year).replace(/\{ปี พ\.ศ\.\}/g, beYear || year).replace(/\{เลขที่\}/g, n).replace(/\{ภาคเรียน\}/g, semester === 'summer' ? 'ฤดูร้อน' : String(semester || '')).replace(/\s+/g, ' ').trim();
}
// 1.57: จำนวนวันที่เหลือถึงวันสุดท้ายของกำหนดส่ง (นับตามวันที่ ไม่สนเวลา) — คืน { days, text, cls } หรือ null
// ---------- 1.81: กิจกรรมในปฏิทิน (หน้าแรกครู/เจ้าหน้าที่ + หน้าผู้บริหาร) ----------
// กิจกรรม = แถบชื่อในช่องวัน (สีตามกลุ่มเจ้าของ) · กำหนดส่งงาน = จุดสีเหมือนเดิม · "ทำซ้ำทุกปี" ฉายซ้ำวัน-เดือนเดิมในปีถัดๆ ไป
var SUBJECT_GROUP_COLORS = { 'ภาษาไทย': '#dc2626', 'คณิตศาสตร์': '#2563eb', 'วิทยาศาสตร์และเทคโนโลยี': '#0891b2', 'สังคมศึกษา ศาสนา และวัฒนธรรม': '#ca8a04', 'สุขศึกษาและพลศึกษา': '#ea580c', 'ศิลปะ': '#db2777', 'การงานอาชีพ': '#65a30d', 'ภาษาต่างประเทศ': '#c026d3' };
function isActivityEv(e) { return !!e && e.kind === 'activity'; }
function activityColor(e) {
  if (e.color && /^#[0-9a-fA-F]{6}$/.test(e.color)) return isReddish(e.color) ? '#b45309' : e.color; // 1.96.3: สีแดงสงวนไว้ให้วันหยุด
  return autoActColor(e); // 1.96.4: ไม่เลือกสี = จัดสีอัตโนมัติ ไม่ผูกกลุ่มงาน ไม่ซ้ำกับกิจกรรมใกล้กัน
}
function activityOwnerLabel(e) { return e.ownerType === 'subject' ? 'กลุ่มสาระการเรียนรู้' + e.ownerGroup : groupLabel(e.ownerGroup); }
function activityOwnerBadgeHtml(e) {
  if (!e.ownerGroup) return '';
  return e.ownerType === 'subject' ? '<span class="evl-gb sub">กลุ่มสาระฯ ' + escapeHtml(e.ownerGroup) + '</span>' : '<span class="evl-gb">' + escapeHtml(groupLabel(e.ownerGroup)) + '</span>';
}
function activityTimeText(e) { return e.timeStart ? e.timeStart + (e.timeEnd ? '–' + e.timeEnd : '') + ' น.' : ''; }
function eventRangeText(e) { return e.endDate && e.endDate !== e.date ? formatDateThai(e.date) + ' – ' + formatDateThai(e.endDate) : formatDateThai(e.date); }
// เพิ่มกิจกรรม "ทำซ้ำทุกปี" ของปีถัดไปที่ทับช่วง fromYmd–toYmd (id = <id>@<ปี ค.ศ.>) — ไม่ฉายย้อนไปก่อนปีที่เพิ่ม
function expandRepeatEvents(events, fromYmd, toYmd) {
  var out = (events || []).slice(), y0 = +String(fromYmd).slice(0, 4), y1 = +String(toYmd).slice(0, 4);
  (events || []).forEach(function (e) {
    if (!isActivityEv(e) || !e.repeatYearly || !e.date) return;
    var by = +e.date.slice(0, 4), end = e.endDate || e.date, span = +end.slice(0, 4) - by;
    for (var y = Math.max(y0 - 1, by + 1); y <= y1; y++) {
      var d = y + e.date.slice(4), ed = (y + span) + end.slice(4);
      if (ed < fromYmd || d > toYmd) continue;
      out.push(Object.assign({}, e, { id: e.id + '@' + y, origId: e.id, date: d, endDate: ed, projected: true }));
    }
  });
  return out;
}
// แถบกิจกรรมในช่องวัน (สูงสุด 2 แถบ + "+N")
// 1.96.2: ปฏิทินแบบ C (หน้าแรก / ผู้บริหาร / ปฏิทินโรงเรียน) — กิจกรรม = ช่องวันระบายสีของกิจกรรม เลขวันวงกลมสีเข้ม ชื่ออยู่วันแรก
// วันหยุด (กิจกรรมแบบ "วันหยุด") = ช่องเทา เลขวันตัวแดง ริบบิ้นแดง "หยุด" ที่มุม (ไม่ใช้สีที่เลือกไว้)
// คืน { cls, style, num, label } ให้หน้าแต่ละหน้าเอาไปประกอบช่องเอง · opts.startOf(e) = วันเริ่มที่แสดง (ค่าเริ่มต้น e.date)
// 1.96.4: สีกิจกรรมอัตโนมัติ — หน้าเว็บส่งรายการกิจกรรมทั้งหมดมาที่ setActPool() ครั้งเดียว แล้วจัดสีเรียงตามวันที่
// ให้แต่ละกิจกรรม (ที่ไม่ได้เลือกสี) ได้สีที่ไม่ซ้ำกับกิจกรรมอื่นในช่วง ±30 วัน (เริ่มจากสีตาม id ให้คงที่) · ทำซ้ำทุกปี = สีเดียวกันทุกปี
var ACT_AUTO_COLORS = ['#0891b2', '#ea580c', '#ca8a04', '#16a34a', '#0d9488', '#0284c7', '#4f46e5', '#9333ea', '#db2777', '#64748b'];
var _actAuto = {}, _actPool = [];
function _actKey(e) { return String(e.id || '').split('@')[0]; }
function _actHash(s) { var h = 0; for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h); }
function setActPool(evs) {
  _actPool = (evs || []).filter(function (e) { return isActivityEv(e) && e.attMode !== 'holiday'; }).slice().sort(function (a, b) { return String(a.date).localeCompare(String(b.date)) || _actKey(a).localeCompare(_actKey(b)); });
  _actAuto = {};
  var placed = []; // { t: เวลา(ms), c: สี }
  var tOf = function (d) { return Date.parse(String(d) + 'T00:00:00Z') || 0; };
  _actPool.forEach(function (e) {
    var t = tOf(e.date), te = tOf(e.endDate || e.date);
    if (e.color && /^#[0-9a-fA-F]{6}$/.test(e.color)) { placed.push({ t: t, te: te, c: isReddish(e.color) ? '#b45309' : e.color.toLowerCase() }); return; }
    var k = _actKey(e);
    if (_actAuto[k]) { placed.push({ t: t, te: te, c: _actAuto[k] }); return; }
    var near = {}; placed.forEach(function (p) { if (p.te >= t - 30 * 864e5 && p.t <= te + 30 * 864e5) near[p.c] = (near[p.c] || 0) + 1; });
    var start = _actHash(k) % ACT_AUTO_COLORS.length, pick = null, best = null;
    for (var i = 0; i < ACT_AUTO_COLORS.length; i++) { var c = ACT_AUTO_COLORS[(start + i) % ACT_AUTO_COLORS.length]; if (!near[c]) { pick = c; break; } if (best === null || near[c] < near[best]) best = c; }
    _actAuto[k] = pick || best; placed.push({ t: t, te: te, c: _actAuto[k] });
  });
}
function autoActColor(e) {
  var k = _actKey(e);
  return _actAuto[k] || ACT_AUTO_COLORS[_actHash(k) % ACT_AUTO_COLORS.length];
}
function isReddish(hex) {
  var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(hex || '')); if (!m) return false;
  var r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255, mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
  if (!d || mx < 0.35) return false;
  var s = d / (1 - Math.abs(mx + mn - 1)), h = mx === r ? ((g - b) / d + 6) % 6 * 60 : mx === g ? ((b - r) / d + 2) * 60 : ((r - g) / d + 4) * 60;
  return s > 0.45 && (h < 14 || h > 340);
}
function isHolidayEv(e) { return isActivityEv(e) && e.attMode === 'holiday'; }
function calCellC(d, ds, acts, opts) {
  opts = opts || {};
  var startOf = opts.startOf || function (e) { return e.date; };
  var dow = new Date(ds + 'T00:00:00').getDay(), isFirst = function (e) { return startOf(e) === ds || dow === 0 || d === 1; };
  var hol = acts.filter(isHolidayEv), oth = acts.filter(function (e) { return !isHolidayEv(e); });
  var lab = function (list, color) {
    if (!list.length) return '';
    var f = list.filter(isFirst)[0], more = list.length - (f ? 1 : 0);
    if (!f) return more > 0 && list.length > 1 ? '<div class="cal-c-lab" style="color:' + color(list[0]) + '">+' + more + '</div>' : '';
    return '<div class="cal-c-lab" style="color:' + color(f) + '">' + escapeHtml(f.title) + (list.length > 1 ? ' +' + (list.length - 1) : '') + '</div>';
  };
  if (hol.length || opts.holiday) {
    return { cls: ' cal-hol', style: '', num: '<div class="day-num">' + d + '</div>', label: '<span class="cal-hol-rib" aria-hidden="true">หยุด</span>' + lab(hol.concat(oth), function (e) { return isHolidayEv(e) ? '#dc2626' : activityColor(e); }) };
  }
  if (oth.length) {
    var c = activityColor(oth[0]);
    return { cls: ' cal-act-c', style: '--ac:' + c, num: '<div class="day-num" style="background:' + c + ';color:#fff">' + d + '</div>', label: lab(oth, activityColor) };
  }
  return { cls: '', style: '', num: '<div class="day-num">' + d + '</div>', label: '' };
}
var CAL_C_LEGEND = '<span><i class="cal-c-sw" aria-hidden="true"></i>ช่องระบายสี = กิจกรรม</span><span><i class="cal-hol-sw" aria-hidden="true"></i>วันหยุด</span>';
function activityBarsHtml(acts) {
  if (!acts.length) return '';
  return '<div class="cal-acts">' + acts.slice(0, 2).map(function (e) {
    return '<span class="cal-act" style="background:' + activityColor(e) + '" title="' + escapeHtml(e.title) + '">' + escapeHtml(e.title) + '</span>';
  }).join('') + (acts.length > 2 ? '<span class="cal-act-more">+' + (acts.length - 2) + '</span>' : '') + '</div>';
}
// 1.92: ป้ายการเช็คชื่อของกิจกรรม (วันหยุด / หยุดเรียนบางคาบ / จัดกิจกรรม) + นักเรียนที่เกี่ยวข้อง
var ATT_MODE_LABEL = { holiday: 'วันหยุด', noclass: 'หยุดเรียนบางคาบ', activity: 'กิจกรรมแทนคาบเรียน' };
function attScopeText(plan) {
  if (!plan) return '';
  var g = (plan.grades || []).map(function (x) { return 'ม.' + x; }), r = (plan.rooms || []).map(function (x) { var m = /^m(\d)_(\d+)$/.exec(x); return m ? 'ม.' + m[1] + '/' + m[2] : x; });
  var all = g.concat(r);
  return all.length ? (all.length > 6 ? all.slice(0, 6).join(', ') + ' และอีก ' + (all.length - 6) : all.join(', ')) : '';
}
function attTagHtml(e) {
  var mode = e.attMode || (e.noClass ? 'holiday' : '');
  if (!mode) return '';
  var sc = attScopeText(e.attPlan);
  var ic = mode === 'activity' ? 'fa-person-running' : 'fa-school-circle-xmark';
  return '<span class="noclass-tag' + (mode === 'activity' ? ' act' : '') + '"><i class="fa-solid ' + ic + '" aria-hidden="true"></i> ' + ATT_MODE_LABEL[mode] + (sc ? ' · ' + escapeHtml(sc) : '') + '</span>';
}
// รายละเอียดกิจกรรมในป็อปอัปวันที่
function activityDayHtml(e) {
  var c = activityColor(e), tt = activityTimeText(e);
  return '<div class="day-ev day-ev-act">' +
    '<span class="day-ev-bar" style="background:' + c + '"></span>' +
    '<div class="day-ev-main">' +
      '<div class="day-ev-title"><i class="fa-solid fa-flag" style="color:' + c + '" aria-hidden="true"></i> ' + escapeHtml(e.title) + ' <span class="evl-tp ac">กิจกรรม</span>' + (attTagHtml(e) ? ' ' + attTagHtml(e) : '') + '</div>' +
      '<div class="day-ev-meta"><i class="fas fa-calendar-days" aria-hidden="true"></i> ' + escapeHtml(eventRangeText(e)) + (e.repeatYearly ? ' · <i class="fa-solid fa-rotate" aria-hidden="true"></i> ทุกปี' : '') + '</div>' +
      (tt ? '<div class="day-ev-meta"><i class="fa-solid fa-clock" aria-hidden="true"></i> ' + escapeHtml(tt) + '</div>' : '') +
      (e.location ? '<div class="day-ev-meta"><i class="fa-solid fa-location-dot" aria-hidden="true"></i> ' + escapeHtml(e.location) + '</div>' : '') +
      (e.ownerGroup ? '<div class="day-ev-meta"><i class="fa-solid ' + (e.ownerType === 'subject' ? 'fa-book' : 'fa-sitemap') + '" aria-hidden="true"></i> ' + escapeHtml(activityOwnerLabel(e)) + '</div>' : '') +
      (e.message ? '<div class="sub-item-desc">' + escapeHtml(e.message) + '</div>' : '') +
    '</div></div>';
}
// "กิจกรรมที่จะถึง" ใต้ปฏิทิน — กิจกรรมที่ยังไม่จบ ภายใน 60 วัน (รวมที่ทำซ้ำทุกปี)
function activityUpcomingHtml(acts, emptyText) {
  var today = todayYmd(), lim = new Date(Date.now() + 60 * 86400000);
  var limStr = lim.getFullYear() + '-' + ('0' + (lim.getMonth() + 1)).slice(-2) + '-' + ('0' + lim.getDate()).slice(-2);
  var list = acts.filter(function (e) { return (e.endDate || e.date) >= today && e.date <= limStr; })
    .sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : 0; });
  var head = '<div class="cal-upcoming-heading act"><i class="fa-solid fa-flag ui-icon" aria-hidden="true"></i> กิจกรรมที่จะถึง</div>';
  if (!list.length) return head + '<div class="empty-state">' + escapeHtml(emptyText || 'ไม่มีกิจกรรมในช่วงนี้') + '</div>';
  return head + '<div class="cal-upcoming-grid">' + list.map(function (e) {
    var tt = activityTimeText(e), dl = daysLeftInfo(e.date);
    var meta = [];
    if (tt) meta.push('<i class="fa-solid fa-clock" aria-hidden="true"></i> ' + escapeHtml(tt));
    if (e.location) meta.push('<i class="fa-solid fa-location-dot" aria-hidden="true"></i> ' + escapeHtml(e.location));
    return '<div class="event-list-item cal-act-row" data-act-date="' + escapeHtml(e.date) + '">' +
      '<div class="event-date-chip act">' + escapeHtml(eventRangeText(e)) + (dl && dl.days > 0 ? '<span class="days-left">(อีก ' + dl.days + ' วัน)</span>' : (e.date <= today ? '<span class="days-left">(วันนี้)</span>' : '')) + '</div>' +
      '<div style="flex:1 1 220px; min-width:0;"><div class="sub-item-title"><i class="fa-solid fa-flag" style="color:' + activityColor(e) + '; margin-right:4px;" aria-hidden="true"></i>' + escapeHtml(e.title) + ' ' + activityOwnerBadgeHtml(e) + '</div>' +
      (meta.length ? '<div class="sub-item-meta evl-meta">' + meta.join(' · ') + '</div>' : '') +
      (e.message ? '<div class="sub-item-desc">' + escapeHtml(e.message) + '</div>' : '') + '</div></div>';
  }).join('') + '</div>';
}
// ปุ่มกรองชนิด ทั้งหมด / กำหนดส่ง / กิจกรรม
function calKindChipsHtml(kind) {
  var b = function (k, label, ic) { return '<button type="button" data-cal-kind="' + k + '" class="' + (kind === k ? 'on' : '') + '" aria-pressed="' + (kind === k) + '">' + (ic ? '<i class="fa-solid ' + ic + '" aria-hidden="true"></i> ' : '') + label + '</button>'; };
  return b('', 'ทั้งหมด', '') + b('deadline', 'กำหนดส่ง', 'fa-file-arrow-up') + b('activity', 'กิจกรรม', 'fa-flag');
}
function daysLeftInfo(endDateStr, now) {
  if (!endDateStr) return null;
  var m = String(endDateStr).match(/^(\d{4})-(\d{2})-(\d{2})/);
  var end = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
  if (isNaN(end)) { var d0 = new Date(endDateStr); if (isNaN(d0.getTime())) return null; end = Date.UTC(d0.getFullYear(), d0.getMonth(), d0.getDate()); }
  now = now || new Date();
  var days = Math.round((end - Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())) / 86400000);
  if (days > 0) return { days: days, text: 'เหลือ ' + days + ' วัน', cls: days <= 3 ? 'urgent' : days <= 7 ? 'soon' : '' };
  if (days === 0) return { days: 0, text: 'วันนี้วันสุดท้าย', cls: 'urgent' };
  return { days: days, text: 'เลยกำหนด ' + (-days) + ' วัน', cls: 'late' };
}
function formatDateThai(isoOrDateStr) {
  if (!isoOrDateStr) return '';
  var d = new Date(isoOrDateStr);
  if (isNaN(d.getTime())) return String(isoOrDateStr);
  var months = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
  return d.getDate() + ' ' + months[d.getMonth()] + ' ' + (d.getFullYear() + 543);
}
// ---------- 1.88: กำหนดส่งหลายรอบ + ลิงก์แนบ (ใช้ร่วมกันหลายหน้า) ----------
var TH_MONTHS_SHORT = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'];
var TH_MONTHS_FULL = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
function monthLabelTh(ymd) { var m = /^(\d{4})-(\d{2})/.exec(String(ymd || '')); return m ? TH_MONTHS_SHORT[Number(m[2]) - 1] + ' ' + (Number(m[1]) + 543) : ''; }
// เหมือน buildRounds ฝั่ง Worker (handlers/calendar.js) — ใช้แสดงตัวอย่างรอบในป็อปอัป · r = { mode, fromMonth, toMonth, dueDay, dates }
function previewRounds(r, startDate) {
  var out = [];
  if (!r || r.mode === 'once') return out;
  if (r.mode === 'monthly') {
    var a = /^(\d{4})-(\d{2})$/.exec(r.fromMonth || ''), b = /^(\d{4})-(\d{2})$/.exec(r.toMonth || '');
    if (!a || !b) return out;
    var y = Number(a[1]), m = Number(a[2]), ey = Number(b[1]), em = Number(b[2]), day = r.dueDay === 'last' ? 0 : Number(r.dueDay);
    while (y * 12 + m <= ey * 12 + em && out.length < 25) {
      var ld = new Date(Date.UTC(y, m, 0)).getUTCDate(), mm = String(m).padStart(2, '0');
      var end = y + '-' + mm + '-' + String(day ? Math.min(day, ld) : ld).padStart(2, '0');
      out.push({ date: y + '-' + mm + '-01', endDate: end, label: monthLabelTh(end) });
      m++; if (m > 12) { m = 1; y++; }
    }
  } else {
    var ds = (r.dates || []).filter(function (d) { return /^\d{4}-\d{2}-\d{2}$/.test(d); }).filter(function (d, i, arr) { return arr.indexOf(d) === i; }).sort();
    var prev = startDate && ds.length && startDate <= ds[0] ? startDate : ds[0];
    ds.forEach(function (d, i) {
      out.push({ date: prev, endDate: d, label: 'ครั้งที่ ' + (i + 1) });
      var n = new Date(Date.parse(d + 'T00:00:00Z') + 86400000); prev = n.toISOString().slice(0, 10);
    });
  }
  return out;
}
function linkHost(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
// ปุ่มลิงก์แนบของกำหนดการ (withHost = แสดงชื่อเว็บต่อท้าย)
function eventLinksHtml(links, withHost) {
  if (!links || !links.length) return '';
  return '<div class="ev-lbtns">' + links.map(function (l) {
    if (l.sample) return '<a class="ev-lbtn smp" href="' + escapeHtml(l.url) + '" target="_blank" rel="noopener noreferrer" title="' + escapeHtml(l.name || '') + '"><i class="fa-solid fa-file-arrow-down" aria-hidden="true"></i> ' + escapeHtml(l.label) + '</a>'; // 1.97: ฟอร์ม/ไฟล์ตัวอย่าง
    var h = linkHost(l.url);
    return '<a class="ev-lbtn" href="' + escapeHtml(l.url) + '" target="_blank" rel="noopener noreferrer"><i class="fa-solid fa-arrow-up-right-from-square" aria-hidden="true"></i> ' + escapeHtml(l.label || 'เปิดลิงก์') + (withHost && h ? ' <small>' + escapeHtml(h) + '</small>' : '') + '</a>';
  }).join('') + '</div>';
}
// ---------- 1.87: สร้างไฟล์ Excel (.xlsx) ในเบราว์เซอร์ — ไม่ใช้ไลบรารีภายนอก (zip แบบไม่บีบอัด + XML ของ Office Open XML) ----------
// header = ['คอลัมน์', ...] · rows = [[ค่า, ...], ...] (ข้อความ/ตัวเลข) · widths = ความกว้างคอลัมน์ (จำนวนตัวอักษร) · title = แถวหัวเรื่องบนสุด (ไม่บังคับ)
var _crcTable = null;
function _crc32(bytes) {
  if (!_crcTable) { _crcTable = []; for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; _crcTable[n] = c >>> 0; } }
  var crc = 0xFFFFFFFF; for (var i = 0; i < bytes.length; i++) crc = _crcTable[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}
function _zipStore(files) { // files = [{name, data: Uint8Array}]
  var enc = new TextEncoder(), parts = [], central = [], offset = 0;
  function u16(v) { return [v & 255, (v >>> 8) & 255]; }
  function u32(v) { return [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255]; }
  files.forEach(function (f) {
    var name = enc.encode(f.name), crc = _crc32(f.data), size = f.data.length;
    var local = [].concat(u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size), u16(name.length), u16(0));
    parts.push(new Uint8Array(local), name, f.data);
    central.push([].concat(u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(0x21), u32(crc), u32(size), u32(size), u16(name.length), u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset)), name);
    offset += local.length + name.length + size;
  });
  var cdSize = 0, cd = [];
  for (var i = 0; i < central.length; i += 2) { cd.push(new Uint8Array(central[i]), central[i + 1]); cdSize += central[i].length + central[i + 1].length; }
  var end = new Uint8Array([].concat(u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length), u32(cdSize), u32(offset), u16(0)));
  return new Blob(parts.concat(cd, [end]), { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}
function _xmlEsc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, ''); }
function _colName(i) { var s = ''; i++; while (i > 0) { var m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; }
function buildXlsx(sheetName, header, rows, widths, title) {
  var enc = new TextEncoder(), r = 0, xml = [];
  function cell(ci, v, style) { var ref = _colName(ci) + r; if (typeof v === 'number' && isFinite(v)) return '<c r="' + ref + '"' + (style ? ' s="' + style + '"' : '') + '><v>' + v + '</v></c>'; return '<c r="' + ref + '" t="inlineStr"' + (style ? ' s="' + style + '"' : '') + '><is><t xml:space="preserve">' + _xmlEsc(v) + '</t></is></c>'; }
  function row(vals, style) { r++; xml.push('<row r="' + r + '">' + vals.map(function (v, ci) { return cell(ci, v, style); }).join('') + '</row>'); }
  if (title) { row([title], 2); }
  row(header, 1); var headRow = r;
  rows.forEach(function (v) { row(v, 0); });
  var cols = (widths || []).map(function (w, i) { return '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>'; }).join('');
  var sheet = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<sheetViews><sheetView workbookViewId="0"><pane ySplit="' + headRow + '" topLeftCell="A' + (headRow + 1) + '" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>' +
    (cols ? '<cols>' + cols + '</cols>' : '') + '<sheetData>' + xml.join('') + '</sheetData>' +
    '<autoFilter ref="A' + headRow + ':' + _colName(header.length - 1) + Math.max(headRow, r) + '"/></worksheet>';
  var styles = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
    '<fonts count="3"><font><sz val="11"/><name val="TH Sarabun New"/></font><font><b/><sz val="11"/><name val="TH Sarabun New"/></font><font><b/><sz val="14"/><name val="TH Sarabun New"/></font></fonts>' +
    '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/><bgColor indexed="64"/></patternFill></fill></fills>' +
    '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
    '<cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>';
  var files = [
    ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>'],
    ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
    ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="' + _xmlEsc(String(sheetName || 'Sheet1').replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31)) + '" sheetId="1" r:id="rId1"/></sheets>' + '<definedNames><definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">\'' + _xmlEsc(String(sheetName || 'Sheet1').replace(/[\\\/?*\[\]:]/g, ' ').slice(0, 31)) + '\'!$A$' + headRow + ':$' + _colName(header.length - 1) + '$' + Math.max(headRow, r) + '</definedName></definedNames></workbook>'],
    ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>'],
    ['xl/worksheets/sheet1.xml', sheet],
    ['xl/styles.xml', styles]
  ];
  return _zipStore(files.map(function (f) { return { name: f[0], data: enc.encode(f[1]) }; }));
}
function downloadBlob(blob, filename) {
  var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = filename;
  document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function loadScriptOnce(src) {
  window._loadedScripts = window._loadedScripts || {};
  if (!window._loadedScripts[src]) window._loadedScripts[src] = new Promise(function (res, rej) { var s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = function () { delete window._loadedScripts[src]; rej(new Error('โหลดตัวสร้างไฟล์ไม่สำเร็จ')); }; document.head.appendChild(s); });
  return window._loadedScripts[src];
}
// ขนาดไฟล์อ่านง่าย (ตั้งแต่ 1.41.111026) — ใช้ในแท็บ "ข้อมูลระบบ"
function formatBytes(n) {
  if (n === null || n === undefined || isNaN(Number(n))) return '-';
  var units = ['B', 'KB', 'MB', 'GB', 'TB'], i = 0, v = Number(n);
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 ? String(Math.round(v)) : v.toFixed(v >= 100 ? 0 : (v >= 10 ? 1 : 2))) + ' ' + units[i];
}
function formatDateTimeThai(isoStr) {
  if (!isoStr) return '';
  var d = new Date(isoStr);
  if (isNaN(d.getTime())) return String(isoStr);
  var hh = String(d.getHours()).padStart(2, '0');
  var mm = String(d.getMinutes()).padStart(2, '0');
  return formatDateThai(isoStr) + ' ' + hh + ':' + mm + ' น.';
}

// ตารางวันเริ่มภาคเรียน (ตั้งแต่ 1.41.111026) — Super Admin กำหนดเองในตั้งค่า → ทั่วไป เก็บเป็น 'MM-DD' ซ้ำทุกปี (ค่าเริ่มต้นตรงกับ Worker)
//   term1Start = เริ่มภาคเรียนที่ 1 (16 พ.ค.) · term2Start = เริ่มภาคเรียนที่ 2 (15 ต.ค.) · summerStart = เริ่มภาคฤดูร้อน (1 เม.ย. — ใช้เฉพาะเมื่อเปิดภาคฤดูร้อนไว้)
var DEFAULT_TERM_SCHEDULE = { term1Start: '05-16', term2Start: '10-15', summerStart: '04-01' };
function termScheduleOf(settings) {
  var ts = (settings && settings.termSchedule && typeof settings.termSchedule === 'object') ? settings.termSchedule : {};
  return {
    term1Start: ts.term1Start || DEFAULT_TERM_SCHEDULE.term1Start,
    term2Start: ts.term2Start || DEFAULT_TERM_SCHEDULE.term2Start,
    summerStart: ts.summerStart !== undefined ? ts.summerStart : DEFAULT_TERM_SCHEDULE.summerStart
  };
}
// คำนวณ "ปีการศึกษา/ภาคเรียนปัจจุบัน" จากวันที่จริง "ตามตารางวันเริ่มภาคเรียน" (โหมดอัตโนมัติ) — ไม่สนใจค่าที่ตั้งเอง (โหมด manual)
// ใช้ตรงๆ เมื่อต้องการ "ค่าตามเวลาจริง" ล้วนๆ (เช่น ปุ่มรีเฟรชตัวกรองภาคเรียน/ปีในหน้าแสดงผลงานสาธารณะ) · settings (ไม่ส่ง = ค่าเริ่มต้น) · now (ไม่ส่ง = ตอนนี้)
// เทียบด้วยสตริง 'MM-DD' ของวันนี้กับวันเริ่มแต่ละภาคเรียนตามลำดับในปีปฏิทิน:
//   ตั้งแต่ term2Start เป็นต้นไป = ภาคเรียนที่ 2 ของปีการศึกษา = ปี พ.ศ. ปัจจุบัน · term1Start ถึงก่อน term2Start = ภาคเรียนที่ 1 ของปี พ.ศ. ปัจจุบัน
//   ก่อน term1Start = ยังเป็นปีการศึกษาก่อนหน้า (ปี พ.ศ. − 1): ถ้าเปิดภาคฤดูร้อนและถึง summerStart แล้ว = ภาคฤดูร้อน ไม่งั้น = ภาคเรียนที่ 2 ของปีก่อน
function trueCurrentAcademicTerm(settings, now) {
  now = now || new Date();
  var sch = termScheduleOf(settings);
  var summerOn = !settings || settings.summerEnabled !== false;
  var pad = function (n) { return String(n).padStart(2, '0'); };
  var md = pad(now.getMonth() + 1) + '-' + pad(now.getDate());
  var beYear = now.getFullYear() + 543;
  if (md >= sch.term2Start) return { year: String(beYear), semester: '2' };
  if (md >= sch.term1Start) return { year: String(beYear), semester: '1' };
  if (summerOn && sch.summerStart && md >= sch.summerStart) return { year: String(beYear - 1), semester: 'summer' };
  return { year: String(beYear - 1), semester: '2' };
}
// "ปีการศึกษา/ภาคเรียนปัจจุบัน" ที่ใช้จริงทั่วระบบ (ค่าเริ่มต้นของตัวกรอง/ปฏิทิน/เช็คลิสต์/ป้ายภาคเรียนในหน้าฮับ) — ตั้งแต่ 1.41.111026 มี 2 โหมดตาม settings.termMode:
//   'manual' = ใช้ปี+ภาคเรียนที่ Super Admin กรอกไว้ (currentAcademicYear/currentSemester) · 'auto' = คำนวณจากวันที่ตามตารางวันเริ่มภาคเรียน
async function currentAcademicTerm() {
  var s = await getSiteSettings();
  var mode = s && (s.termMode === 'manual' || s.termMode === 'auto') ? s.termMode : ((s && s.currentAcademicYear && s.currentSemester) ? 'manual' : 'auto');
  if (mode === 'manual' && s.currentAcademicYear && s.currentSemester) {
    return { year: String(s.currentAcademicYear), semester: String(s.currentSemester) };
  }
  return trueCurrentAcademicTerm(s);
}
// ข้อความป้ายบอก "ตอนนี้คือปีการศึกษา/ภาคเรียนอะไร" จาก currentAcademicTerm() — ใช้แสดงในปฏิทินหน้าฮับครู (ตั้งแต่ V9.8)
// ตัดคำนำหน้า "ตอนนี้: " ออกตามที่ผู้ใช้ขอ (ตั้งแต่ V9.9) เหลือแค่ตัวข้อความภาคเรียน/ปีการศึกษาล้วนๆ — เป็น async ตั้งแต่ V12.0 (ดู currentAcademicTerm() ด้านบน)
// ---------- เปิด/ปิด "จัดทำบันทึกข้อความ" (ตั้งแต่ 1.48.121026) ----------
// องค์ประกอบใดที่ติด class "memo-feature" (ปุ่มในหน้าแรก แท็บข้อมูลกลุ่มบริหารงาน การ์ดข้อมูลพิมพ์บันทึกข้อความ) + เมนู memo.html
// จะถูกซ่อนเมื่อ settings.memoEnabled === false — เรียกซ้ำได้ทุกครั้งที่ค่าตั้งค่าเปลี่ยน
function isMemoEnabled(st) { return !(st && st.memoEnabled === false); }
// 1.53.121026: แก้เมนูกระพริบ — จำสถานะไว้ใน localStorage (bnkah_memo_off) แล้วสคริปต์ใน <head> ของทุกหน้าใส่ class "memo-off"
// ที่ <html> ก่อนหน้าเว็บแสดงผล (CSS ซ่อนให้ตั้งแต่แรก ไม่ต้องรอโหลดค่าตั้งค่า) — ค่าตั้งค่าจริงที่โหลดมาภายหลังอัปเดต class/ค่าที่จำไว้ให้ตรงเสมอ
function memoOffCached() { try { return localStorage.getItem('bnkah_memo_off') === '1'; } catch (e) { return false; } }
function applyMemoFeatureVisibility(st) {
  var off = !isMemoEnabled(st);
  try { if (off) localStorage.setItem('bnkah_memo_off', '1'); else localStorage.removeItem('bnkah_memo_off'); } catch (e) { /* ไม่มี localStorage — ใช้ class อย่างเดียว */ }
  document.documentElement.classList.toggle('memo-off', off);
  document.querySelectorAll('.memo-feature, .sidenav a[href="memo.html"]').forEach(function (el) { el.classList.toggle('memo-feature-off', off); });
}

// 1.98.1: เปิด/ปิดระบบนิเทศการสอน (settings.supEnabled) — จำไว้ใน localStorage ให้เมนูไม่กระพริบ
try { if (localStorage.getItem('bnkah_sup_off') === '1') document.documentElement.classList.add('sup-off'); } catch (e) { /* ข้าม */ }
function applySupVisibility(st) {
  var off = !!(st && st.supEnabled === false);
  try { if (off) localStorage.setItem('bnkah_sup_off', '1'); else localStorage.removeItem('bnkah_sup_off'); } catch (e) { /* ข้าม */ }
  document.documentElement.classList.toggle('sup-off', off);
}
// 1.98.2: การ์ด "การนิเทศที่จะถึง" (หน้าแรกครู / ผู้บริหาร) — จากรายการนิเทศในปฏิทินส่วนตัว (e.supervision = 'teacher' | 'sup')
function renderSupUpcoming(elId, events) {
  var el = document.getElementById(elId); if (!el) return;
  var today = todayYmd(), MS = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'], DW = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
  var list = (events || []).filter(function (e) { return e.supervision && e.date >= today; }).sort(function (a, b) { return a.date.localeCompare(b.date); }).slice(0, 6);
  el.hidden = !list.length; if (!list.length) return;
  el.innerHTML = '<div class="section-title" style="justify-content:space-between"><span><i class="fa-solid fa-chalkboard-user ui-icon" aria-hidden="true"></i> การนิเทศที่จะถึง</span><a class="btn btn-ghost btn-sm" href="supervision.html">ดูทั้งหมด</a></div>' + list.map(function (e) {
    var p = e.date.split('-'), d = new Date(+p[0], +p[1] - 1, +p[2]), left = Math.round((d - new Date(today.replace(/-/g, '/'))) / 864e5), sup = e.supervision === 'sup';
    return '<a class="sup-up-item" href="supervision.html' + (sup ? '#duty' : '#mine') + '"><span class="d">' + DW[d.getDay()] + '<b>' + (+p[2]) + '</b>' + MS[+p[1] - 1] + '</span><span class="t"><b>' + (sup ? 'ไปนิเทศ' : 'รับการนิเทศ') + '</b> ' + escapeHtml(e.title.replace(/^(ไปนิเทศ|รับการนิเทศ)\s*/, '')) + '<small>' + escapeHtml(e.message || '') + ' · ' + (left === 0 ? 'วันนี้' : left === 1 ? 'พรุ่งนี้' : 'อีก ' + left + ' วัน') + '</small></span>' + (sup ? '<span class="btn btn-sm btn-secondary">ทำแบบประเมิน</span>' : '') + '</a>';
  }).join('');
}
// 1.98.1: เกณฑ์ระดับคุณภาพของโรงเรียน (5 ดีมาก · 4 ดี · 3 พอใช้ · 2 ควรปรับปรุง · 1 ไม่ผ่าน) — ค่าเฉลี่ยปัดตามช่วง .50
var SUP_LEVELS = ['', 'ไม่ผ่าน', 'ควรปรับปรุง', 'พอใช้', 'ดี', 'ดีมาก'];
function supLevelOf(avg) { if (avg == null || !isFinite(avg)) return ''; return SUP_LEVELS[avg >= 4.5 ? 5 : avg >= 3.5 ? 4 : avg >= 2.5 ? 3 : avg >= 1.5 ? 2 : 1]; }

async function currentTermLabel() {
  var t = await currentAcademicTerm();
  var semText = t.semester === 'summer' ? 'ภาคฤดูร้อน' : ('ภาคเรียนที่ ' + t.semester);
  return semText + ' ปีการศึกษา ' + t.year;
}
function showToast(msg, isError) {
  var el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'toast show' + (isError ? ' toast-error' : '');
  clearTimeout(el.__timer);
  el.__timer = setTimeout(function () { el.className = 'toast'; }, 3500);
}

function showModalEl(el) {
  el.hidden = false;
  requestAnimationFrame(function () { el.classList.add('show'); });
}
function hideModalEl(el) {
  el.classList.remove('show');
  setTimeout(function () { el.hidden = true; }, 180);
}

// ---------- Shared modals (custom, no browser confirm/alert) ----------
function ensureSharedModals() {
  if (document.getElementById('sharedConfirmModal')) return;
  var wrap = document.createElement('div');
  wrap.innerHTML =
    '<div class="modal-backdrop" id="sharedConfirmModal" hidden>' +
      '<div class="modal-box">' +
        '<button type="button" class="modal-close-x" id="sharedConfirmCloseX" aria-label="ปิด">✕</button>' +
        '<h3 id="sharedConfirmTitle">ยืนยันการทำรายการ</h3>' +
        '<p id="sharedConfirmMsg" style="color:var(--text-muted); font-size:0.9rem;"></p>' +
        '<div class="modal-actions">' +
          '<button class="btn btn-danger" id="sharedConfirmYes">ยืนยัน</button>' +
          '<button class="btn btn-ghost btn-close" id="sharedConfirmNo">ยกเลิก</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="modal-backdrop" id="sharedPwModal" hidden>' +
      '<div class="modal-box">' +
        '<button type="button" class="modal-close-x" id="sharedPwCloseX" aria-label="ปิด">✕</button>' +
        '<h3>เปลี่ยนรหัสผ่าน</h3>' +
        '<div id="sharedPwError" class="error-box" hidden></div>' +
        '<form id="sharedPwForm" style="text-align:left;">' +
          '<div class="field"><label for="sharedOldPw">รหัสผ่านเดิม</label><input id="sharedOldPw" type="password" required autocomplete="current-password" /></div>' +
          '<div class="field"><label for="sharedNewPw">รหัสผ่านใหม่</label><input id="sharedNewPw" type="password" required minlength="4" autocomplete="new-password" /></div>' +
          '<div class="field"><label for="sharedNewPwConfirm">ยืนยันรหัสผ่านใหม่</label><input id="sharedNewPwConfirm" type="password" required minlength="4" autocomplete="new-password" /></div>' +
          '<div class="modal-actions">' +
            '<button type="submit" class="btn btn-primary">บันทึก</button>' +
            '<button type="button" class="btn btn-ghost btn-close" id="sharedPwClose">ยกเลิก</button>' +
          '</div>' +
        '</form>' +
      '</div>' +
    '</div>' +
    '<div class="modal-backdrop" id="sharedAvatarModal" hidden>' +
      '<div class="modal-box">' +
        '<button type="button" class="modal-close-x" id="sharedAvatarCloseX" aria-label="ปิด">✕</button>' +
        '<h3>รูปโปรไฟล์</h3>' +
        '<div id="sharedAvatarError" class="error-box" hidden></div>' +
        '<div class="avatar-preview-wrap"><span class="profile-avatar avatar-preview-lg" id="sharedAvatarPreview"></span></div>' +
        '<p class="hint" style="text-align:center; margin-top:-6px;">ระบบจะย่อขนาดและบีบอัดรูปให้อัตโนมัติก่อนอัปโหลด</p>' +
        '<input type="file" id="sharedAvatarFileInput" accept="image/*" hidden />' +
        '<div class="modal-actions" style="flex-wrap:wrap;">' +
          '<button type="button" class="btn btn-secondary" id="sharedAvatarPickBtn">เลือกรูปภาพ</button>' +
          '<button type="button" class="btn btn-primary" id="sharedAvatarSaveBtn" hidden>บันทึก</button>' +
          '<button type="button" class="btn btn-danger" id="sharedAvatarRemoveBtn" hidden>ลบรูปโปรไฟล์</button>' +
          '<button type="button" class="btn btn-ghost btn-close" id="sharedAvatarClose">ปิด</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="modal-backdrop" id="sharedExpireModal" hidden>' +
      '<div class="modal-box">' +
        '<button type="button" class="modal-close-x" id="sharedExpireCloseX" aria-label="ปิด">✕</button>' +
        '<h3>หมดเวลาการใช้งาน</h3>' +
        '<!-- 1.69: ไม่มีการใช้งานครบ 60 นาที -->' +
        '<p style="color:var(--text-muted); font-size:0.9rem;">ไม่มีการใช้งานต่อเนื่องครบ 60 นาที เพื่อความปลอดภัยระบบได้นำคุณออกจากระบบแล้ว กรุณาเข้าสู่ระบบอีกครั้ง</p>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-primary" id="sharedExpireOk">เข้าสู่ระบบอีกครั้ง</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="modal-backdrop" id="sharedIdleModal" hidden>' +
      '<div class="modal-box">' +
        '<div class="idle-ic"><i class="fa-solid fa-hourglass-half" aria-hidden="true"></i></div>' +
        '<h3>ยังใช้งานอยู่ไหม?</h3>' +
        '<p style="color:var(--text-muted); font-size:0.9rem;">ไม่มีการใช้งานมาระยะหนึ่งแล้ว ระบบจะออกจากระบบให้อัตโนมัติใน</p>' +
        '<div class="idle-left" id="sharedIdleLeft">2:00</div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-primary" id="sharedIdleStay"><i class="fa-solid fa-check" aria-hidden="true"></i> ใช้งานต่อ</button>' +
          '<button type="button" class="btn btn-ghost btn-close" id="sharedIdleLogout">ออกจากระบบ</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="modal-backdrop" id="sharedSessionReplacedModal" hidden>' +
      '<div class="modal-box">' +
        '<button type="button" class="modal-close-x" id="sharedSessionReplacedCloseX" aria-label="ปิด">✕</button>' +
        '<h3>เข้าสู่ระบบจากที่อื่น</h3>' +
        '<p style="color:var(--text-muted); font-size:0.9rem;">บัญชีนี้เพิ่งถูกเข้าสู่ระบบจากอุปกรณ์หรือเบราว์เซอร์อื่น เพื่อความปลอดภัยระบบอนุญาตให้ใช้งานได้ทีละ 1 ที่เท่านั้น จึงนำคุณออกจากระบบที่นี่โดยอัตโนมัติ</p>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-primary" id="sharedSessionReplacedOk">เข้าสู่ระบบอีกครั้ง</button>' +
        '</div>' +
      '</div>' +
    '</div>' +
    '<div class="modal-backdrop" id="sharedProgressModal" hidden>' +
      '<div class="modal-box">' +
        '<button type="button" class="modal-close-x" id="sharedProgressCloseX" aria-label="ปิด" hidden>✕</button>' +
        '<h3 id="sharedProgressTitle">กำลังดำเนินการ</h3>' +
        '<div id="sharedProgressBarWrap">' +
          '<div class="progress-anim" id="sharedProgressAnim"><span class="progress-ring" aria-hidden="true"></span><i class="fa-solid fa-gear" id="sharedProgressIcon" aria-hidden="true"></i><span class="progress-bolt" id="sharedProgressBolt" title="ส่งตรงเข้า Google Drive" aria-label="ส่งตรงเข้า Google Drive" hidden><i class="fa-solid fa-bolt" aria-hidden="true"></i></span></div>' +
          '<div class="progress-track"><div class="progress-bar-fill" id="sharedProgressBar"></div></div>' +
          '<div class="progress-label" id="sharedProgressLabel" aria-live="polite"></div>' +
          '<div class="progress-meta"><span id="sharedProgressPct"></span><span id="sharedProgressTime"></span></div>' +
          '<div class="progress-note" id="sharedProgressNote" hidden><i class="fa-solid fa-triangle-exclamation"></i> กรุณาอย่าปิดหรือรีเฟรชหน้านี้จนกว่าจะเสร็จ</div>' +
        '</div>' +
        '<div class="progress-result" id="sharedProgressResult" hidden></div>' +
        '<div class="modal-actions">' +
          '<button type="button" class="btn btn-primary" id="sharedProgressOk" hidden>ตกลง</button>' +
          '<button type="button" class="btn btn-success" id="sharedProgressRetry" hidden><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> <span id="sharedProgressRetryTxt">ส่งใหม่</span></button>' +
        '</div>' +
      '</div>' +
    '</div>';
  document.body.appendChild(wrap);
  var goToLoginFromExpire = function () { location.href = 'index.html?_=' + Date.now(); };
  document.getElementById('sharedExpireOk').addEventListener('click', goToLoginFromExpire);
  // X ของป็อปอัปหมดเวลาการใช้งานทำหน้าที่เดียวกับปุ่ม "เข้าสู่ระบบอีกครั้ง" เสมอ (ไม่ให้ปิดค้างไว้แล้วนั่งดูหน้าที่ session หมดอายุแล้วเฉยๆ)
  document.getElementById('sharedExpireCloseX').addEventListener('click', goToLoginFromExpire);
  // 1.69: ป็อปอัปเตือนก่อนหมดเวลา
  document.getElementById('sharedIdleStay').addEventListener('click', function () { markActive(true); hideIdleWarning(); });
  document.getElementById('sharedIdleLogout').addEventListener('click', function () { logout(); });

  // ป็อปอัป "เข้าสู่ระบบจากที่อื่น" (ตั้งแต่ V11.7) — ปุ่ม "เข้าสู่ระบบอีกครั้ง" และ X ทำหน้าที่เดียวกันเสมอ เหมือนป็อปอัปหมดเวลาการใช้งานด้านบน
  document.getElementById('sharedSessionReplacedOk').addEventListener('click', goToLoginFromExpire);
  document.getElementById('sharedSessionReplacedCloseX').addEventListener('click', goToLoginFromExpire);

  document.getElementById('sharedPwClose').addEventListener('click', function () { hideModalEl(document.getElementById('sharedPwModal')); });
  document.getElementById('sharedPwCloseX').addEventListener('click', function () { hideModalEl(document.getElementById('sharedPwModal')); });
  document.getElementById('sharedPwForm').addEventListener('submit', async function (e) {
    e.preventDefault();
    var errBox = document.getElementById('sharedPwError');
    errBox.hidden = true;
    var newPw = document.getElementById('sharedNewPw').value;
    var newPwConfirm = document.getElementById('sharedNewPwConfirm').value;
    if (newPw !== newPwConfirm) {
      errBox.textContent = 'รหัสผ่านใหม่ทั้งสองช่องไม่ตรงกัน กรุณาตรวจสอบอีกครั้ง';
      errBox.hidden = false;
      return;
    }
    var ok = await askConfirm('ยืนยันเปลี่ยนรหัสผ่านของบัญชีนี้?', 'ยืนยันการเปลี่ยนรหัสผ่าน');
    if (!ok) return;
    var oldPw = document.getElementById('sharedOldPw').value;
    var r = await withProgress('กำลังเปลี่ยนรหัสผ่าน', function () {
      return apiCall('changePassword', { oldPassword: oldPw, newPassword: newPw });
    }, { successLabel: 'เปลี่ยนรหัสผ่านเรียบร้อยแล้ว' });
    if (r.ok) {
      hideModalEl(document.getElementById('sharedPwModal'));
      document.getElementById('sharedPwForm').reset();
    } else {
      errBox.textContent = r.error.message;
      errBox.hidden = false;
    }
  });

  // ---------- ป็อปอัปรูปโปรไฟล์ ----------
  var _pendingAvatar = null; // ผลลัพธ์จาก resizeImageForAvatar ระหว่างที่ยังไม่กดบันทึก
  var avatarModal = document.getElementById('sharedAvatarModal');
  var avatarErrBox = document.getElementById('sharedAvatarError');
  var avatarPreview = document.getElementById('sharedAvatarPreview');
  var avatarSaveBtn = document.getElementById('sharedAvatarSaveBtn');
  var avatarRemoveBtn = document.getElementById('sharedAvatarRemoveBtn');
  var avatarFileInput = document.getElementById('sharedAvatarFileInput');

  function closeAvatarModal() { hideModalEl(avatarModal); }
  document.getElementById('sharedAvatarClose').addEventListener('click', closeAvatarModal);
  document.getElementById('sharedAvatarCloseX').addEventListener('click', closeAvatarModal);
  document.getElementById('sharedAvatarPickBtn').addEventListener('click', function () { avatarFileInput.click(); });

  avatarFileInput.addEventListener('change', async function () {
    var file = avatarFileInput.files && avatarFileInput.files[0];
    avatarFileInput.value = '';
    if (!file) return;
    avatarErrBox.hidden = true;
    try {
      var resized = await resizeImageForAvatar(file);
      _pendingAvatar = resized;
      avatarPreview.innerHTML = '<img src="' + resized.dataUrl + '" alt="" />';
      avatarSaveBtn.hidden = false;
    } catch (err) {
      avatarErrBox.textContent = err.message;
      avatarErrBox.hidden = false;
    }
  });

  avatarSaveBtn.addEventListener('click', async function () {
    if (!_pendingAvatar) return;
    avatarErrBox.hidden = true;
    var r = await withProgress('กำลังอัปโหลดรูปโปรไฟล์', function () {
      return uploadResizedAvatar(_pendingAvatar);
    }, { successLabel: 'อัปเดตรูปโปรไฟล์แล้ว', upload: true });
    if (r.ok) {
      _pendingAvatar = null;
      avatarSaveBtn.hidden = true;
      var s = getSession();
      if (s) { s.avatarUrl = r.data.avatarUrl; setSession(getToken(), s); }
      var topbarEl = document.getElementById('topbarAvatar');
      if (topbarEl) topbarEl.innerHTML = avatarInnerHtml(r.data.avatarUrl);
      avatarRemoveBtn.hidden = false;
      hideModalEl(avatarModal);
    } else {
      avatarErrBox.textContent = r.error.message;
      avatarErrBox.hidden = false;
    }
  });

  avatarRemoveBtn.addEventListener('click', async function () {
    var ok = await askConfirm('ลบรูปโปรไฟล์นี้? ระบบจะกลับไปใช้ไอคอนเริ่มต้นแทน', 'ยืนยันการลบรูปโปรไฟล์');
    if (!ok) return;
    avatarErrBox.hidden = true;
    var r = await withProgress('กำลังลบรูปโปรไฟล์', function () {
      return apiCall('profileRemoveAvatar', {});
    }, { successLabel: 'ลบรูปโปรไฟล์แล้ว' });
    if (r.ok) {
      var s2 = getSession();
      if (s2) { s2.avatarUrl = ''; setSession(getToken(), s2); }
      var topbarEl2 = document.getElementById('topbarAvatar');
      if (topbarEl2) topbarEl2.innerHTML = avatarInnerHtml('');
      avatarPreview.innerHTML = avatarInnerHtml('');
      avatarRemoveBtn.hidden = true;
      _pendingAvatar = null;
      avatarSaveBtn.hidden = true;
    } else {
      avatarErrBox.textContent = r.error.message;
      avatarErrBox.hidden = false;
    }
  });
}

function openChangePasswordModal() {
  ensureSharedModals();
  showModalEl(document.getElementById('sharedPwModal'));
}

function openAvatarModal() {
  ensureSharedModals();
  var session = getSession();
  document.getElementById('sharedAvatarError').hidden = true;
  document.getElementById('sharedAvatarPreview').innerHTML = avatarInnerHtml(session && session.avatarUrl);
  document.getElementById('sharedAvatarSaveBtn').hidden = true;
  document.getElementById('sharedAvatarRemoveBtn').hidden = !(session && session.avatarUrl);
  showModalEl(document.getElementById('sharedAvatarModal'));
}

// 1.83: ข้อความในป็อปอัปยืนยันแสดงตัวหนา (<b>/<strong>) และขึ้นบรรทัดใหม่ (<br>) ได้ — นอกนั้นแสดงเป็นตัวอักษรล้วนเสมอ
// (escape ทั้งข้อความก่อน แล้วคืนเฉพาะแท็กที่อนุญาต · ค่าที่ผู้เรียก escapeHtml มาแล้วไม่ถูก escape ซ้ำ)
function confirmMsgHtml(msg) {
  return escapeHtml(String(msg == null ? '' : msg))
    .replace(/&lt;(\/?)(b|strong)&gt;/g, '<$1$2>')
    .replace(/&lt;br\s*\/?&gt;/g, '<br>')
    .replace(/&amp;(amp|lt|gt|quot|#39|#039|nbsp);/g, '&$1;');
}
function askConfirm(msg, title) {
  ensureSharedModals();
  return new Promise(function (resolve) {
    document.getElementById('sharedConfirmTitle').textContent = title || 'ยืนยันการทำรายการ';
    document.getElementById('sharedConfirmMsg').innerHTML = confirmMsgHtml(msg);
    var modal = document.getElementById('sharedConfirmModal');
    showModalEl(modal);
    var yesBtn = document.getElementById('sharedConfirmYes');
    var noBtn = document.getElementById('sharedConfirmNo');
    var closeXBtn = document.getElementById('sharedConfirmCloseX');
    function cleanup(val) {
      hideModalEl(modal);
      yesBtn.removeEventListener('click', onYes);
      noBtn.removeEventListener('click', onNo);
      closeXBtn.removeEventListener('click', onNo);
      resolve(val);
    }
    function onYes() { cleanup(true); }
    function onNo() { cleanup(false); }
    yesBtn.addEventListener('click', onYes);
    noBtn.addEventListener('click', onNo);
    closeXBtn.addEventListener('click', onNo);
  });
}

// ---------- ป็อปอัป "กำลังดำเนินการ" (Progress bar) ----------
// เปิดหลังกดยืนยัน (askConfirm) แสดงระหว่างรอ backend ตอบกลับ แล้วให้ผู้ใช้กด "ตกลง" อีกครั้งเมื่อเสร็จ/error
// 1.50.121026: แอนิเมชันระหว่างรอ (ไอคอนเคลื่อนไหว + วงหมุน + ตัวจับเวลา + แถบคืบหน้าแบบประมาณการ) ให้เห็นว่าระบบยังทำงานอยู่
// และกันปิด/รีเฟรชหน้าระหว่างอัปโหลด (beforeunload) — การอัปโหลดไป Apps Script วัดความคืบหน้าจริงเป็นไบต์ไม่ได้
// (ถ้าฟัง xhr.upload.onprogress เบราว์เซอร์จะส่ง CORS preflight ซึ่ง Apps Script ไม่รองรับ) จึงใช้การประมาณจากขนาดไฟล์แทน (creepProgress)
var _progressRun = { timer: null, creep: null, started: 0, upload: false };
function _progressBeforeUnload(e) { e.preventDefault(); e.returnValue = ''; return ''; }
function _stopProgressTimers() {
  if (_progressRun.timer) clearInterval(_progressRun.timer);
  if (_progressRun.creep) clearInterval(_progressRun.creep);
  _progressRun.timer = null; _progressRun.creep = null;
  window.removeEventListener('beforeunload', _progressBeforeUnload);
}
function _fmtElapsed(ms) { var sec = Math.floor(ms / 1000); return Math.floor(sec / 60) + ':' + ('0' + (sec % 60)).slice(-2); }
function _showProgressModal(title, opts) {
  opts = opts || {};
  ensureSharedModals();
  _stopProgressTimers();
  _progressRun.started = Date.now();
  _progressRun.upload = !!opts.upload;
  document.getElementById('sharedProgressIcon').className = 'fa-solid ' + (opts.upload ? 'fa-cloud-arrow-up is-upload' : 'fa-gear is-spin');
  document.getElementById('sharedProgressNote').hidden = !opts.upload;
  document.getElementById('sharedProgressBolt').hidden = true; // 1.86
  document.getElementById('sharedProgressPct').textContent = '';
  document.getElementById('sharedProgressTime').textContent = '';
  _progressRun.timer = setInterval(function () {
    var el = document.getElementById('sharedProgressTime');
    if (el) el.textContent = 'ผ่านไป ' + _fmtElapsed(Date.now() - _progressRun.started);
  }, 1000);
  if (opts.upload) window.addEventListener('beforeunload', _progressBeforeUnload);
  document.getElementById('sharedProgressTitle').textContent = title || 'กำลังดำเนินการ';
  document.getElementById('sharedProgressBarWrap').hidden = false;
  document.getElementById('sharedProgressResult').hidden = true;
  document.getElementById('sharedProgressOk').hidden = true;
  document.getElementById('sharedProgressRetry').hidden = true;
  // X ซ่อนไว้ระหว่างกำลังทำงานอยู่โดยตั้งใจ (เช่นเดียวกับปุ่ม "ตกลง") เพื่อให้ผู้ใช้เห็นผลลัพธ์แน่นอนก่อนปิดป็อปอัปได้เสมอ
  document.getElementById('sharedProgressCloseX').hidden = true;
  setProgressIndeterminate('กำลังดำเนินการ...');
  showModalEl(document.getElementById('sharedProgressModal'));
}
function _setBar(percent) {
  var bar = document.getElementById('sharedProgressBar');
  if (!bar) return;
  bar.classList.remove('indeterminate');
  var v = Math.max(0, Math.min(100, percent));
  bar.style.width = v + '%';
  var pct = document.getElementById('sharedProgressPct');
  if (pct) pct.textContent = Math.round(v) + '%';
  return v;
}
// 1.86: ไอคอนสายฟ้าเล็กที่มุมไอคอนอัปโหลด = กำลังส่งตรงเข้า Google Drive ('' = ซ่อน — ส่งผ่าน relay ไม่แสดงอะไร)
function setUploadVia(via) { var b = document.getElementById('sharedProgressBolt'); if (b) b.hidden = via !== 'direct'; }
function setProgress(percent, label) {
  if (_progressRun.creep) { clearInterval(_progressRun.creep); _progressRun.creep = null; }
  _setBar(percent);
  if (label !== undefined) document.getElementById('sharedProgressLabel').textContent = label;
}
// แถบคืบหน้าแบบประมาณการ: ค่อยๆ ไหลจาก from ไปหา to (ไม่ถึง to จนกว่าจะเรียก setProgress ครั้งถัดไป) ตามเวลาที่คาดไว้ estMs
function creepProgress(from, to, estMs, label) {
  setProgress(from, label);
  var t0 = Date.now(), tau = Math.max(800, (estMs || 4000) / 2.2);
  _progressRun.creep = setInterval(function () {
    var k = 1 - Math.exp(-(Date.now() - t0) / tau);
    _setBar(from + (to - from) * 0.97 * k);
  }, 200);
}
// เวลาที่คาดว่าจะใช้ส่งไฟล์ขนาด bytes ไป Drive relay (base64 + อัปโหลด + Apps Script บันทึกไฟล์)
function estimateUploadMs(bytes) { return 2500 + (Number(bytes) || 0) * 1.37 / 900; }
function setProgressIndeterminate(label) {
  if (_progressRun.creep) { clearInterval(_progressRun.creep); _progressRun.creep = null; }
  var pct = document.getElementById('sharedProgressPct');
  if (pct) pct.textContent = '';
  var bar = document.getElementById('sharedProgressBar');
  if (!bar) return;
  bar.classList.add('indeterminate');
  if (label !== undefined) document.getElementById('sharedProgressLabel').textContent = label;
}
function _finishProgress(message, isError, retryLabel) {
  _stopProgressTimers();
  return new Promise(function (resolve) {
    document.getElementById('sharedProgressBarWrap').hidden = true;
    var resultBox = document.getElementById('sharedProgressResult');
    resultBox.hidden = false;
    resultBox.className = 'progress-result ' + (isError ? 'is-error' : 'is-success');
    resultBox.textContent = message;
    var okBtn = document.getElementById('sharedProgressOk');
    var closeXBtn = document.getElementById('sharedProgressCloseX');
    var retryBtn = document.getElementById('sharedProgressRetry');
    okBtn.hidden = false;
    closeXBtn.hidden = false;
    // 1.85: อัปโหลดไม่สำเร็จ = ปุ่ม "ส่งใหม่" (ส่งเฉพาะไฟล์ที่ยังไม่สำเร็จ — งานแต่ละหน้าข้ามไฟล์ที่ส่งแล้วเอง)
    retryBtn.hidden = !(isError && retryLabel);
    okBtn.textContent = isError && retryLabel ? 'ปิด' : 'ตกลง';
    if (retryLabel) document.getElementById('sharedProgressRetryTxt').textContent = retryLabel;
    function off() {
      okBtn.removeEventListener('click', onOk);
      closeXBtn.removeEventListener('click', onOk);
      retryBtn.removeEventListener('click', onRetry);
    }
    function onOk() {
      off();
      hideModalEl(document.getElementById('sharedProgressModal'));
      resolve('ok');
    }
    function onRetry() { off(); retryBtn.hidden = true; resolve('retry'); }
    okBtn.addEventListener('click', onOk);
    closeXBtn.addEventListener('click', onOk);
    retryBtn.addEventListener('click', onRetry);
  });
}
/**
 * เรียกใช้งานหลัง askConfirm() แล้ว — เปิดป็อปอัป Progress bar ระหว่างรอ workFn() ทำงาน (มักคือ apiCall)
 * workFn จะได้รับ { setProgress(percent, label), setLabel(label) } ไว้ใช้รายงานความคืบหน้าจริง (เช่น อัปโหลดหลายไฟล์)
 * เสร็จแล้วจะโชว์ผลลัพธ์ค้างไว้จนกว่าผู้ใช้จะกด "ตกลง" — คืนค่า { ok, data } หรือ { ok:false, error }
 */
// 1.85: opts.retry (ค่าเริ่มต้น = opts.upload) — ไม่สำเร็จแล้วมีปุ่ม "ส่งใหม่" เรียก workFn ซ้ำ · err.retryLabel กำหนดข้อความปุ่ม · err.noRetry = ไม่มีปุ่ม (เช่น ไฟล์ผิดชนิด)
async function withProgress(title, workFn, opts) {
  opts = opts || {};
  var canRetry = opts.retry !== undefined ? !!opts.retry : !!opts.upload;
  _progressBusy++; // 1.69: ระหว่างอัปโหลด/บันทึก ไม่นับเป็นเวลานิ่ง
  try {
    for (;;) {
      _showProgressModal(title, { upload: !!opts.upload });
      try {
        var data = await workFn({
          setProgress: setProgress,
          creep: creepProgress,
          setLabel: function (label) { document.getElementById('sharedProgressLabel').textContent = label; }
        });
        await _finishProgress(opts.successLabel || 'ดำเนินการสำเร็จ', false);
        return { ok: true, data: data };
      } catch (err) {
        var lbl = canRetry && !(err && err.noRetry) ? ((err && err.retryLabel) || 'ส่งใหม่') : '';
        var act = await _finishProgress((err && err.message) || 'เกิดข้อผิดพลาดไม่ทราบสาเหตุ', true, lbl);
        if (act !== 'retry') return { ok: false, error: err };
      }
    }
  } finally {
    _progressBusy = Math.max(0, _progressBusy - 1);
    markActive(true);
  }
}

// ---------- Shared chrome: topbar + profile dropdown + footer ----------
// ---------- ลำดับเมนูข้าง (ตั้งแต่ 1.59 — Super Admin จัดลำดับได้ที่ ตั้งค่าระบบ → ทั่วไป) ----------
// slot = ตำแหน่งในเมนู (หน้าแรกของครู/เจ้าหน้าที่ กับของผู้บริหารเป็น slot เดียวกัน 'home') · who = บัญชีที่มองเห็น (ใช้แสดงป้ายในหน้าตั้งค่า)
var NAV_SLOTS = [
  { slot: 'home', label: 'หน้าแรก', icon: 'home', who: ['teacher', 'staff', 'exec', 'super'] },
  { slot: 'memo', label: 'จัดทำบันทึกข้อความ', icon: 'memo', who: ['teacher', 'staff'] },
  { slot: 'summary', label: 'สรุปการส่งงาน', icon: 'summary', who: ['staff', 'exec', 'super'] },
  { slot: 'announce', label: 'ประกาศและปฏิทิน', icon: 'announce', who: ['staff', 'exec', 'super'] },
  { slot: 'schoolcal', label: 'ปฏิทินโรงเรียน', icon: 'schoolcal', who: ['all'] }, // 1.93
  { slot: 'supervision', label: 'นิเทศการสอน', icon: 'supervision', who: ['all'] }, // 1.98
  { slot: 'directory', label: 'ทำเนียบบุคลากร', icon: 'directory', who: ['all'] },
  { slot: 'orders', label: 'คลังคำสั่ง', icon: 'orders', who: ['all'] },
  { slot: 'certs', label: 'คลังเกียรติบัตร', icon: 'certs', who: ['all'] },
  { slot: 'gallery', label: 'คลังรูปภาพ', icon: 'gallery', who: ['all'] }, // 1.76
  { slot: 'settings', label: 'ตั้งค่าระบบ', icon: 'settings', who: ['all'] }
];
var NAV_DEFAULT_ORDER = NAV_SLOTS.map(function (x) { return x.slot; });
// ลำดับที่ใช้จริง: ค่าที่บันทึกไว้ (เฉพาะ slot ที่รู้จัก) + slot ที่ขาด (เช่นเมนูใหม่ในรุ่นถัดไป) แทรกตามตำแหน่งเริ่มต้น
function normalizeNavOrder(order) {
  var out = [];
  (Array.isArray(order) ? order : []).forEach(function (k) { if (NAV_DEFAULT_ORDER.indexOf(k) !== -1 && out.indexOf(k) === -1) out.push(k); });
  NAV_DEFAULT_ORDER.forEach(function (k, i) {
    if (out.indexOf(k) !== -1) return;
    var prev = NAV_DEFAULT_ORDER.slice(0, i).reverse().filter(function (x) { return out.indexOf(x) !== -1; })[0];
    out.splice(prev ? out.indexOf(prev) + 1 : 0, 0, k);
  });
  return out;
}
function currentNavOrder() {
  var s = _settingsCache && !_settingsCache.__fallback ? _settingsCache : cachedBrand();
  return normalizeNavOrder(s && s.navOrder);
}
function navSlotOf(key) { return key === 'dashboard' || key === 'executive' || key === 'overview' ? 'home' : key; }
// เรียงเมนูในแถบข้างที่วาดไปแล้วใหม่ (ค่าตั้งค่าโหลดเสร็จทีหลัง/เพิ่งบันทึกลำดับใหม่)
function reorderSideNav(order) {
  var list = document.querySelector('#app-sidenav .sidenav-list');
  if (!list) return;
  normalizeNavOrder(order).forEach(function (slot) {
    var a = list.querySelector('a[data-nav-slot="' + slot + '"]');
    if (a) list.appendChild(a);
  });
}
function navLinksFor(session) {
  var links = [];
  var isExec = !!session && session.role === 'executive';
  var isAdmin = !!session && session.role === 'admin';
  // ตั้งแต่ 1.29.091026: "จัดทำบันทึกข้อความ" เป็นแท็บในเมนูบนสุด (ไปหน้า memo.html ในแท็บเบราว์เซอร์เดิม ไม่เปิดหน้าใหม่) ของทุกบัญชีที่มี
  // หน้าฮับ (ครู และเจ้าหน้าที่ role='admin' + hasHub) — ครูเดิมไม่มีเมนูบนสุดเลย จึงเพิ่ม "หน้าแรก" ให้ด้วยเพื่อให้แถบแท็บสมบูรณ์
  if (session && (session.role === 'teacher' || (isAdmin && session.hasHub))) {
    links.push({ href: 'dashboard.html', label: 'หน้าแรก', key: 'dashboard', icon: 'home' });
    links.push({ href: 'memo.html', label: 'จัดทำบันทึกข้อความ', key: 'memo', icon: 'memo' });
  }
  if (isDeptHeadSession(session) || isRespOnlySession(session)) links.push({ href: 'summary.html', label: 'สรุปการส่งงาน', key: 'summary', icon: 'summary' }); // 1.87.2 · 1.94: + ผู้รับผิดชอบกำหนดการ
  // ผู้บริหาร (ตั้งแต่ 1.32.101026): หน้าแรกของตัวเอง = ปฏิทิน + สรุปภาพรวม (executive.html) — ไม่มีหน้าฮับ ไม่ส่งงาน
  if (isExec) links.push({ href: 'executive.html', label: 'หน้าแรก', key: 'executive', icon: 'home' });
  // 1.79: Super Admin มีหน้าแรกของตัวเอง = ภาพรวมระบบ (overview.html)
  if (isAdmin && !session.hasHub) links.push({ href: 'overview.html', label: 'หน้าแรก', key: 'overview', icon: 'home' });
  if (isAdmin || isExec) {
    links.push({ href: 'summary.html', label: 'สรุปการส่งงาน', key: 'summary', icon: 'summary' });
    // "ประกาศและปฏิทิน" (ตั้งแต่ 1.32.101026): ย้ายแท็บ "ปฏิทิน" และ "ประกาศ" ออกจากหน้าตั้งค่ามารวมกันเป็นแท็บบนสุดนี้ — เจ้าหน้าที่/Super Admin จัดการได้
    // ผู้บริหารดูได้อย่างเดียว (ครูไม่มีแท็บนี้เพราะเห็นปฏิทินและประกาศในหน้าแรกอยู่แล้ว)
    links.push({ href: 'announce.html', label: 'ประกาศและปฏิทิน', key: 'announce', icon: 'announce' });
  }
  // "ทำเนียบบุคลากรโรงเรียน" (ตั้งแต่ 1.32.101026): ทุกบทบาทที่ล็อกอินเห็นแท็บนี้ — mountChrome ซ่อนให้เองถ้า Super Admin ตั้งไว้ว่า "ปิด" (settings.directoryMode)
  // 1.93: "ปฏิทินโรงเรียน" — ทุกบัญชีที่ล็อกอินเห็น (กำหนดส่งงาน + กิจกรรมทั้งโรงเรียน รายเดือน)
  if (session) links.push({ href: 'schoolcalendar.html', label: 'ปฏิทินโรงเรียน', key: 'schoolcal', icon: 'schoolcal' });
  if (session) links.push({ href: 'supervision.html', label: 'นิเทศการสอน', key: 'supervision', icon: 'supervision' }); // 1.98
  if (session) links.push({ href: 'directory.html', label: 'ทำเนียบบุคลากร', key: 'directory', icon: 'directory' });
  // "คลังคำสั่ง" (ตั้งแต่ 1.41.111026 ชื่อเดิม "ไฟล์คำสั่ง"; เปลี่ยนชื่อใน 1.43.111026): ทุกบทบาทที่ล็อกอินดู/พรีวิว/เพิ่มคำสั่งได้ — แก้ไข/ลบได้เฉพาะเจ้าของ
  if (session) links.push({ href: 'orders.html', label: 'คลังคำสั่ง', key: 'orders', icon: 'orders' });
  // "คลังเกียรติบัตร" (ตั้งแต่ 1.59): ทุกบัญชีที่ล็อกอินเห็น
  if (session) links.push({ href: 'certs.html', label: 'คลังเกียรติบัตร', key: 'certs', icon: 'certs' });
  // "คลังรูปภาพ" (ตั้งแต่ 1.76): ทุกบัญชีที่ล็อกอินเห็น — ครูทุกคนเพิ่มอัลบั้มได้
  if (session) links.push({ href: 'gallery.html', label: 'คลังรูปภาพ', key: 'gallery', icon: 'gallery' });
  // 1.45.111026: ทุกบัญชีมีเมนู "ตั้งค่าระบบ" (ครู/ผู้บริหารเห็นเฉพาะแท็บ Signature Credit)
  if (session) {
    // หมายเหตุ: เมนู "จัดการ Layout" (V11.1) ถูกยกเลิกตั้งแต่ V11.5 — ทั้งรูปแบบการ์ด (V11.3) และลำดับการแสดงผล (V11.5)
    // ย้ายไปรวมอยู่ในหน้า "ตั้งค่าระบบ" (ตั้งแต่ 1.32.101026 อยู่ในแท็บ "ข้อมูลหลัก") (Super Admin เท่านั้น)
    links.push({ href: 'settings.html', label: 'ตั้งค่าระบบ', key: 'settings', icon: 'settings' });
  }
  var order = currentNavOrder(); // 1.59: เรียงตามลำดับที่ Super Admin ตั้ง
  links.forEach(function (l) { l.slot = navSlotOf(l.key); });
  links.sort(function (a, b) { return order.indexOf(a.slot) - order.indexOf(b.slot); });
  return links;
}


// ---------- แถบเมนูด้านซ้าย (ตั้งแต่ 1.41.111026 — สไตล์ Google Keep สำหรับทุกบัญชี/ทุกหน้าที่มี topbar) ----------
// - ปุ่ม 3 ขีดหน้าโลโก้ (#navToggle): คอม/แท็บเล็ต = สลับ "เปิดค้างไว้ (ปักหมุด)" ↔ "ย่อเหลือแต่ไอคอน" จำค่าไว้ใน localStorage (bnkah_nav_pinned)
//   มือถือ (< 768px) = เปิด/ปิดเป็นลิ้นชักทับหน้าจอ มีฉากดำจางๆ ด้านหลัง
// - ตอนย่ออยู่ ถ้าเอาเมาส์ชี้ที่แถบจะกางเต็มออกมาทับเนื้อหาชั่วคราว (ไม่ดันเนื้อหา) พอเอาเมาส์ออกก็ย่อกลับ
// - ค่าเริ่มต้นเมื่อยังไม่เคยเลือก: จอกว้าง ≥ 1280px เปิดค้าง, จอเล็กกว่านั้นย่อ
var NAV_PIN_KEY = 'bnkah_nav_pinned';
function _navIsMobile() { return window.matchMedia('(max-width: 767px)').matches; }
function _navGetPinned() {
  try { var v = localStorage.getItem(NAV_PIN_KEY); if (v === '1') return true; if (v === '0') return false; } catch (e) { /* ใช้ค่าเริ่มต้น */ }
  return true; // 1.96: ใช้ครั้งแรก = ขยาย (แบบ Google Keep) · กดปุ่ม 3 ขีดเพื่อย่อ แล้วระบบจำไว้ (1.68 เคยเริ่มแบบย่อ)
}
function mountSideNav(links, activePage) {
  var old = document.getElementById('app-sidenav');
  if (old) old.remove();
  var oldBd = document.getElementById('app-sidenav-backdrop');
  if (oldBd) oldBd.remove();
  var aside = document.createElement('aside');
  aside.id = 'app-sidenav';
  aside.className = 'sidenav no-print';
  aside.setAttribute('aria-label', 'เมนูหลัก');
  aside.innerHTML = '<nav class="sidenav-list">' + links.map(function (l) {
    return '<a href="' + l.href + '" data-nav-slot="' + escapeHtml(l.slot || navSlotOf(l.key)) + '" class="sidenav-item' + (l.key === activePage ? ' active' : '') + '" title="' + escapeHtml(l.label) + '"' + (l.key === activePage ? ' aria-current="page"' : '') + '>' +
      '<span class="sidenav-icon">' + icon(l.icon, 19) + '</span><span class="sidenav-label">' + escapeHtml(l.label) + '</span></a>';
  }).join('') + '</nav>';
  var backdrop = document.createElement('div');
  backdrop.id = 'app-sidenav-backdrop';
  backdrop.className = 'sidenav-backdrop no-print';
  document.body.appendChild(aside);
  document.body.appendChild(backdrop);
  document.body.classList.add('has-sidenav');

  var toggle = document.getElementById('navToggle');
  var pinned = _navGetPinned();
  var hovering = false;
  var mobileOpen = false;
  function render() {
    var mobile = _navIsMobile();
    var open = mobile ? mobileOpen : (pinned || hovering);
    document.body.classList.toggle('nav-pinned', !mobile && pinned);
    document.body.classList.toggle('nav-mobile-open', mobile && mobileOpen);
    aside.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', (mobile ? mobileOpen : pinned) ? 'true' : 'false');
  }
  function syncTopbarHeight() {
    var tb = document.querySelector('.topbar');
    if (tb) document.documentElement.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
  }
  toggle.addEventListener('click', function () {
    if (_navIsMobile()) { mobileOpen = !mobileOpen; if (mobileOpen && typeof announceMenuOpen === 'function') announceMenuOpen('nav'); }
    else { pinned = !pinned; hovering = false; try { localStorage.setItem(NAV_PIN_KEY, pinned ? '1' : '0'); } catch (e) { /* ไม่เป็นไร */ } }
    render();
  });
  backdrop.addEventListener('click', function () { mobileOpen = false; render(); });
  document.addEventListener('bnkah:menu-open', function (e) { if (e.detail !== 'nav' && mobileOpen) { mobileOpen = false; render(); } }); // 1.79.2: เปิดเมนูอื่น = ปิดเมนูข้าง (มือถือ)
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && mobileOpen) { mobileOpen = false; render(); } });
  aside.addEventListener('mouseenter', function () { if (!_navIsMobile() && window.matchMedia('(hover: hover)').matches) { hovering = true; render(); } });
  aside.addEventListener('mouseleave', function () { hovering = false; render(); });
  aside.addEventListener('focusin', function () { if (!_navIsMobile()) { hovering = true; render(); } });
  aside.addEventListener('focusout', function () { hovering = false; render(); });
  window.addEventListener('resize', function () { if (!_navIsMobile()) mobileOpen = false; syncTopbarHeight(); render(); });
  syncTopbarHeight();
  if (window.ResizeObserver) { var tbEl = document.querySelector('.topbar'); if (tbEl) new ResizeObserver(syncTopbarHeight).observe(tbEl); }
  // 1.68: เปิดหน้าใหม่ = จัดสถานะย่อ/ขยายทันทีโดยไม่มีอนิเมชั่น (สคริปต์บนหัวหน้าใส่ .nav-noanim ไว้) — อนิเมชั่นเหลือเฉพาะตอนกดปุ่มเอง
  document.documentElement.classList.add('nav-noanim');
  render();
  requestAnimationFrame(function () { requestAnimationFrame(function () { document.documentElement.classList.remove('nav-noanim'); }); });
}

function mountChrome(activePage) {
  var session = getSession();
  var topbarRoot = document.getElementById('app-topbar');
  if (topbarRoot && session) {
    var links = navLinksFor(session);
    // ตั้งแต่ 1.41.111026: เมนูทั้งหมดย้ายจากแถบบนสุดมาเป็นแถบเมนูด้านซ้าย (สไตล์ Google Keep) — ปุ่ม 3 ขีดหน้าโลโก้ = ปักหมุดเปิดค้าง/ย่อ,
    // ตอนย่อให้ชี้เมาส์เพื่อกางเต็มชั่วคราว, มือถือเป็นลิ้นชักเลื่อนออกมา (ดู mountSideNav ด้านล่าง)
    topbarRoot.innerHTML =
      '<div class="topbar">' +
        '<div class="topbar-left">' +
          '<button class="nav-toggle" id="navToggle" type="button" aria-label="เปิด/ปิดเมนู" aria-expanded="false" aria-controls="app-sidenav"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>' +
          '<button class="brand js-home-btn" type="button"><span class="js-brand-logo"><span class="logo-dot"></span></span> <span class="js-site-name">BNKAcademicHub</span></button>' +
        '</div>' +
        '<div class="topbar-right">' +
          '<button class="refresh-btn" id="refreshDataBtn" type="button" title="รีเฟรชข้อมูล" aria-label="รีเฟรชข้อมูล">' +
            '<svg class="refresh-icon" viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><polyline points="21 3 21 9 15 9"/></svg>' +
          '</button>' +
          // 1.75: แจ้งปัญหา (หูฟัง) + แจ้งเตือน (กระดิ่ง) — อยู่ระหว่างรีเฟรชกับเมนูบัญชี
          // 1.76: ปุ่มคู่มือการใช้งาน (แทนหูฟัง — แจ้งปัญหาย้ายไปเมนูบัญชี)
          '<button class="refresh-btn tb-icon-btn" id="manualOpenBtn" type="button" title="คู่มือการใช้งาน" aria-label="คู่มือการใช้งาน"><i class="fa-solid fa-book-open" aria-hidden="true"></i></button>' +
          '<button class="refresh-btn tb-icon-btn" id="notifBtn" type="button" title="แจ้งเตือน" aria-label="แจ้งเตือน" aria-expanded="false"><i class="fa-solid fa-bell" aria-hidden="true"></i><span class="tb-badge" id="notifBadge" hidden>0</span></button>' +
          '<div class="profile-menu">' +
            '<button class="profile-trigger" id="profileTrigger" aria-expanded="false" type="button">' +
              '<span class="profile-avatar" id="topbarAvatar">' + avatarInnerHtml(session.avatarUrl) + '</span>' +
              '<span class="profile-name">' + escapeHtml(session.name) + '</span>' +
              '<span class="chevron">▾</span>' +
            '</button>' +
            '<div class="profile-dropdown" id="profileDropdown">' +
              '<div class="dd-header"><div class="dd-name">' + escapeHtml(session.name) + '</div>' + accountInfoLines(session).map(function (l) { return '<div class="dd-role"><span class="dd-k">' + escapeHtml(l.label) + '</span><span class="dd-v">' + escapeHtml(l.value) + '</span></div>'; }).join('') + '</div>' +
              // 1.80: ติดตั้งแอป (PWA) — แสดงเฉพาะเครื่องที่ติดตั้งได้และยังไม่ได้ติดตั้ง (ดู updateInstallItem)
              '<button class="dd-item dd-install" id="ddInstall" type="button" hidden><span class="dd-icon"><i class="fa-solid fa-mobile-screen-button" aria-hidden="true"></i></span> ติดตั้งแอปลงเครื่องนี้</button>' +
              '<div class="dd-divider" id="ddInstallDiv" hidden></div>' +
              // 1.66: เลือกธีม 3 แบบ (ภาพตัวอย่างย่อ) แทนสวิตช์ Dark Mode เดิม
              '<div class="dd-theme-title">ธีม</div><div class="dd-themes" id="themePicker" role="radiogroup" aria-label="ธีม">' +
                [['light', 'กระดาษขาว'], ['sepia', 'ถนอมตา'], ['dark', 'กลางคืน']].map(function (t) {
                  return '<button type="button" role="radio" class="dd-theme t-' + t[0] + '" data-theme-pick="' + t[0] + '"><span class="mini"><i class="p"></i><i></i><i></i></span>' + t[1] + '</button>';
                }).join('') + '</div>' +
              '<div class="dd-divider"></div>' +
              '<button class="dd-item" id="ddChangeAvatar" type="button"><span class="dd-icon">' + icon('image', 16) + '</span> เปลี่ยนรูปโปรไฟล์</button>' +
              '<button class="dd-item" id="ddChangePw" type="button"><span class="dd-icon">' + icon('key', 16) + '</span> เปลี่ยนรหัสผ่าน</button>' +
              '<button class="dd-item" id="ddReport" type="button"><span class="dd-icon"><i class="fa-solid fa-headset" aria-hidden="true"></i></span> แจ้งปัญหา</button>' +
              '<div class="dd-divider"></div>' +
              '<button class="dd-item danger" id="ddLogout" type="button"><span class="dd-icon">' + icon('logout', 16) + '</span> ออกจากระบบ</button>' +
            '</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    document.querySelector('.js-home-btn').addEventListener('click', function () { location.href = homePageFor(session); });
    renderBrand(cachedBrand()); // 1.53: วาดแบรนด์จากค่าที่จำไว้ทันที (applyBranding อัปเดตตามค่าจริงอีกครั้ง)
    mountSideNav(links, activePage);
    // ซ่อนเมนู "ทำเนียบบุคลากร" ถ้า Super Admin ปิดทำเนียบไว้ (settings.directoryMode = 'off') — ตั้งแต่ 1.32.101026
    getSiteSettings().then(function (st) {
      if (st && st.directoryMode === 'off') {
        var dl = document.querySelector('.sidenav a[href="directory.html"]');
        if (dl && activePage !== 'directory') dl.remove();
      }
      // 1.48.121026: Super Admin ปิด "จัดทำบันทึกข้อความ" -> ซ่อนเมนู/ปุ่ม/แท็บที่เกี่ยวข้อง และพาออกจากหน้า memo.html
      applyMemoFeatureVisibility(st);
      applySupVisibility(st); // 1.98.1: ปิดระบบนิเทศ = ซ่อนเมนู
      if (st && st.memoEnabled === false && activePage === 'memo') location.replace(homePageFor(session));
    });

    var trigger = document.getElementById('profileTrigger');
    var dropdown = document.getElementById('profileDropdown');
    trigger.addEventListener('click', function (e) {
      e.stopPropagation();
      var isOpen = dropdown.classList.toggle('open');
      trigger.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      if (isOpen) announceMenuOpen('profile');
    });
    onOtherMenuOpen('profile', function () { dropdown.classList.remove('open'); trigger.setAttribute('aria-expanded', 'false'); });
    document.addEventListener('click', function (e) {
      if (!dropdown.contains(e.target) && e.target !== trigger) {
        dropdown.classList.remove('open');
        trigger.setAttribute('aria-expanded', 'false');
      }
    });
    var themePicker = document.getElementById('themePicker');
    var syncThemePicker = function () {
      var cur = getTheme();
      Array.prototype.forEach.call(themePicker.querySelectorAll('[data-theme-pick]'), function (b) { var on = b.getAttribute('data-theme-pick') === cur; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    };
    syncThemePicker();
    themePicker.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-theme-pick]'); if (!b) return;
      var t = b.getAttribute('data-theme-pick');
      setTheme(t); saveThemeToAccount(t); syncThemePicker();
    });

    document.getElementById('ddChangeAvatar').addEventListener('click', function () {
      dropdown.classList.remove('open');
      openAvatarModal();
    });
    document.getElementById('ddChangePw').addEventListener('click', function () {
      dropdown.classList.remove('open');
      openChangePasswordModal();
    });
    document.getElementById('ddLogout').addEventListener('click', async function () {
      dropdown.classList.remove('open');
      var ok = await askConfirm('ต้องการออกจากระบบใช่หรือไม่?', 'ยืนยันการออกจากระบบ');
      if (ok) logout();
    });

    // ---------- ปุ่มรีเฟรชข้อมูล (แต่ละหน้าจะกำหนด window.__refreshPageData เองว่ารีเฟรชอะไรบ้าง) ----------
    var refreshBtn = document.getElementById('refreshDataBtn');
    refreshBtn.addEventListener('click', async function () {
      if (refreshBtn.classList.contains('spinning')) return; // กันกดซ้ำระหว่างกำลังโหลดอยู่
      refreshBtn.classList.add('spinning');
      refreshBtn.disabled = true;
      try {
        if (window.__refreshPageData) {
          await window.__refreshPageData();
        } else {
          location.reload();
          return;
        }
        showToast('รีเฟรชข้อมูลแล้ว');
      } catch (err) {
        showToast('รีเฟรชข้อมูลไม่สำเร็จ: ' + err.message, true);
      } finally {
        refreshBtn.classList.remove('spinning');
        refreshBtn.disabled = false;
      }
    });

    initNotifBell(); // 1.75
    initTimetable(); // 1.92.1
    document.getElementById('manualOpenBtn').addEventListener('click', function () { openManual(); });
    document.getElementById('ddReport').addEventListener('click', function () { dropdown.classList.remove('open'); openReportModal(); });
    document.getElementById('ddInstall').addEventListener('click', function () { dropdown.classList.remove('open'); startInstallApp(); });
    updateInstallItem();
    if (/^#report:/.test(location.hash)) { var rid = location.hash.slice(8); setTimeout(function () { openReportModal({ tab: 'mine', focus: rid }); }, 300); }
    setTimeout(function () { refreshTopBadges(); }, 400);

    scheduleSessionTimeout();
    startSessionWatch(); // ตรวจป้องกันล็อกอินซ้อนกันเป็นระยะ (ตั้งแต่ V11.7) — เริ่มพร้อมกับทุกหน้าที่มี topbar (ต้องล็อกอินอยู่แล้วเสมอ)
  }
  mountFooter();
  applyBranding();
}

// Footer มาตรฐานทุกหน้า (ตั้งแต่ 1.29.091026 ตามที่ผู้ใช้กำหนดไว้): ชื่อโรงเรียน, ลิขสิทธิ์ (ปีอัตโนมัติ เป็น พ.ศ.), ลิขสิทธิ์ผลงานเป็นของเจ้าของ
// ผลงาน, ผู้พัฒนา, ระบุว่าใช้ AI ช่วยพัฒนา + เวอร์ชัน, ลิงก์นโยบายความเป็นส่วนตัว/แจ้งปัญหา (mailto) — หน้า privacy.html ใช้ฟังก์ชันนี้ร่วมกัน
var SUPPORT_EMAIL = 'Tear.Jeerasak@gmail.com'; // อีเมลผู้ดูแลระบบ (แจ้งปัญหา/ติดต่อเรื่องข้อมูลส่วนบุคคล)
function mountFooter(opts) {
  var root = document.getElementById('app-footer');
  if (!root) return;
  var yearBE = new Date().getFullYear() + 543;
  // 1.75: กดเลขเวอร์ชัน = เมนู "โหลดหน้าใหม่" / "ล้างแคชแล้วโหลดใหม่"
  var verHtml = '<span class="ver-wrap"><button type="button" class="ver-btn" id="verBtn" aria-haspopup="true" aria-expanded="false" title="โหลดหน้าใหม่ / ล้างแคช">v' + escapeHtml(APP_VERSION) + ' <i class="fa-solid fa-caret-up" aria-hidden="true"></i></button>' +
    '<span class="ver-menu" id="verMenu" hidden><button type="button" data-ver="check"><i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i> ตรวจหาอัปเดต</button><button type="button" data-ver="reload"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> โหลดหน้าใหม่</button>' +
    '<button type="button" data-ver="hard"><i class="fa-solid fa-broom" aria-hidden="true"></i> ล้างแคชแล้วโหลดใหม่</button></span></span>';
  var reportLink = '<a href="mailto:' + SUPPORT_EMAIL + '?subject=' + encodeURIComponent('แจ้งปัญหาการใช้งาน BNKAcademicHub') + '">';
  if (opts && opts.compact) {
    // 1.80: หน้าล็อกอินใช้ footer แบบย่อ 2 บรรทัด — กด "เกี่ยวกับระบบ" เพื่อดูบรรทัดที่เหลือ (หน้าล็อกอินไม่ยาวขึ้น)
    root.innerHTML =
      '<div class="site-footer">' +
        '<div>© ' + yearBE + ' โรงเรียนบุ่งคล้านคร · ' + verHtml + '</div>' +
        '<div class="footer-links"><a href="privacy.html">นโยบายความเป็นส่วนตัว</a> · ' + reportLink + 'แจ้งปัญหา</a> · ' +
          '<button type="button" class="footer-about-btn" id="footerAboutBtn" aria-expanded="false" aria-controls="footerMore">เกี่ยวกับระบบ <i class="fa-solid fa-caret-down" aria-hidden="true"></i></button></div>' +
        '<div class="footer-more" id="footerMore" hidden><div>ผลงานในระบบเป็นลิขสิทธิ์ของเจ้าของผลงาน</div><div>Developed by Jeerasak Chomphuwattana</div><div>Built with AI assistance</div></div>' +
      '</div>';
    var ab = document.getElementById('footerAboutBtn'), more = document.getElementById('footerMore');
    ab.addEventListener('click', function () {
      more.hidden = !more.hidden; ab.setAttribute('aria-expanded', String(!more.hidden));
      ab.querySelector('i').className = 'fa-solid ' + (more.hidden ? 'fa-caret-down' : 'fa-caret-up');
      if (!more.hidden) more.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });
  } else {
    root.innerHTML =
      '<div class="site-footer">' +
        '<div class="footer-school">โรงเรียนบุ่งคล้านคร</div>' +
        '<div>© ' + yearBE + ' โรงเรียนบุ่งคล้านคร สงวนลิขสิทธิ์</div>' +
        '<div>ผลงานในระบบเป็นลิขสิทธิ์ของเจ้าของผลงาน</div>' +
        '<div>Developed by Jeerasak Chomphuwattana</div>' +
        '<div>Built with AI assistance · ' + verHtml + '</div>' +
        // 1.75: หน้าที่ล็อกอินแล้วแจ้งปัญหาผ่านเมนูบัญชี — ลิงก์อีเมลเหลือเฉพาะหน้าที่ไม่มีแถบบน (หน้าสาธารณะ/หน้าล็อกอิน)
        '<div class="footer-links"><a href="privacy.html">นโยบายความเป็นส่วนตัว</a>' +
          (document.getElementById('ddReport') ? '' : ' · ' + reportLink + 'แจ้งปัญหาการใช้งาน</a>') + '</div>' +
      '</div>';
  }
  var vb = document.getElementById('verBtn'), vm = document.getElementById('verMenu');
  vb.addEventListener('click', function (e) { e.stopPropagation(); vm.hidden = !vm.hidden; vb.setAttribute('aria-expanded', String(!vm.hidden)); if (!vm.hidden) announceMenuOpen('version'); });
  onOtherMenuOpen('version', function () { vm.hidden = true; vb.setAttribute('aria-expanded', 'false'); });
  document.addEventListener('click', function (e) { if (!vm.hidden && !e.target.closest('.ver-wrap')) { vm.hidden = true; vb.setAttribute('aria-expanded', 'false'); } });
  vm.addEventListener('click', function (e) {
    var b = e.target.closest('[data-ver]'); if (!b) return;
    vm.hidden = true;
    if (b.getAttribute('data-ver') === 'check') checkForUpdate(true);
    else if (b.getAttribute('data-ver') === 'reload') location.reload();
    else hardReloadPage();
  });
  startUpdateWatch();
}
// ===== 1.97.5: แจ้งเวอร์ชันใหม่ (แบบ C — การ์ดมุมขวาล่าง ไม่แสดงรายละเอียด) =====
// อ่านเลขรุ่นจากไฟล์ version.json บน GitHub โดยตรง (ไม่ผ่าน Worker = ไม่ใช้โควต้า) · ตอนเปิดหน้า + ทุก 30 นาทีที่เปิดหน้าค้าง + กลับมาที่แท็บ
// "ภายหลัง" = ซ่อนรุ่นนั้น 2 ชั่วโมง · "อัปเดตเลย" = ล้างแคชแล้วโหลดใหม่
var _updLastCheck = 0, _updShownFor = '';
function verParts(v) { return String(v || '').split('.').slice(0, 3).map(function (x) { return parseInt(x, 10) || 0; }); }
function isNewerVersion(remote, local) {
  if (!remote || remote === local) return false;
  var a = verParts(remote), b = verParts(local);
  for (var i = 0; i < 3; i++) { if (a[i] !== b[i]) return a[i] > b[i]; }
  return true; // เลขรุ่นเท่ากันแต่วันที่ต่าง = แพ็กใหม่
}
async function checkForUpdate(manual) {
  _updLastCheck = Date.now();
  var remote = '';
  try {
    var r = await fetch(new URL('version.json', location.href).href + '?t=' + Date.now(), { cache: 'no-store' });
    if (r.ok) remote = String(((await r.json()) || {}).v || '');
  } catch (e) { remote = ''; }
  if (!remote) { if (manual) showToast('ตรวจหาอัปเดตไม่ได้ (เชื่อมต่อไม่ได้) — ลองใหม่อีกครั้ง'); return; }
  if (isNewerVersion(remote, APP_VERSION)) {
    if (!manual) { try { var sn = JSON.parse(localStorage.getItem('bnkah_upd_snooze') || 'null'); if (sn && sn.v === remote && Date.now() - sn.at < 2 * 3600e3) return; } catch (e) { /* ข้าม */ } }
    showUpdateCard(remote);
  } else if (manual) showToast('ใช้เวอร์ชันล่าสุดแล้ว (v' + APP_VERSION + ')');
}
function showUpdateCard(v) {
  if (_updShownFor === v && document.getElementById('updCard')) return;
  _updShownFor = v;
  var old = document.getElementById('updCard'); if (old) old.remove();
  var c = document.createElement('div'); c.id = 'updCard'; c.className = 'upd-card'; c.setAttribute('role', 'status');
  c.innerHTML = '<button type="button" class="upd-x" aria-label="ปิด" data-upd="later">✕</button><div class="upd-h"><i class="fa-solid fa-circle-arrow-up" aria-hidden="true"></i> มีเวอร์ชันใหม่ ' + escapeHtml(v) + '</div>' +
    '<div class="upd-t">โหลดหน้าใหม่เพื่อใช้งานเวอร์ชันล่าสุด</div><div class="upd-a"><button type="button" class="btn btn-secondary btn-sm" data-upd="later">ภายหลัง</button><button type="button" class="btn btn-success btn-sm" data-upd="go"><i class="fa-solid fa-rotate-right" aria-hidden="true"></i> อัปเดตเลย</button></div>';
  c.addEventListener('click', function (e) {
    var b = e.target.closest('[data-upd]'); if (!b) return;
    if (b.getAttribute('data-upd') === 'go') { hardReloadPage(); return; }
    try { localStorage.setItem('bnkah_upd_snooze', JSON.stringify({ v: v, at: Date.now() })); } catch (e2) { /* ข้าม */ }
    c.remove();
  });
  document.body.appendChild(c);
}
function startUpdateWatch() {
  if (window.__updWatch) return; window.__updWatch = true;
  setTimeout(function () { checkForUpdate(false); }, 4000);
  setInterval(function () { if (!document.hidden) checkForUpdate(false); }, 30 * 60e3);
  document.addEventListener('visibilitychange', function () { if (!document.hidden && Date.now() - _updLastCheck > 10 * 60e3) checkForUpdate(false); });
}
// ล้างแคชแล้วโหลดใหม่: ลบ Cache Storage/Service Worker (ถ้ามี) + ข้อมูลชั่วคราวของหน้า (sessionStorage) แล้วดึงไฟล์หน้าเว็บ (HTML/JS/CSS)
// ใหม่จากเซิร์ฟเวอร์ทับแคชของเบราว์เซอร์ก่อนโหลดหน้าใหม่ — ไม่ออกจากระบบ ไม่ลบธีม/การตั้งค่าที่จำไว้
async function hardReloadPage() {
  showToast('กำลังล้างแคชและโหลดใหม่...');
  try { if (window.caches && caches.keys) { var ks = await caches.keys(); await Promise.all(ks.map(function (k) { return caches.delete(k); })); } } catch (e) { /* ข้าม */ }
  try { if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) { var regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(function (r) { return r.unregister(); })); } } catch (e) { /* ข้าม */ }
  try { sessionStorage.clear(); } catch (e) { /* ข้าม */ }
  try { resetSettingsCache(); localStorage.removeItem('bnkah_brand'); } catch (e) { /* ข้าม */ }
  var urls = [location.href.split('#')[0]];
  document.querySelectorAll('script[src], link[rel="stylesheet"][href]').forEach(function (el) {
    var u = el.src || el.href;
    if (u && u.indexOf(location.origin) === 0) urls.push(u);
  });
  await Promise.all(urls.map(function (u) { return fetch(u, { cache: 'reload', credentials: 'same-origin' }).catch(function () {}); }));
  location.reload();
}

// ---------- พรีวิวไฟล์แบบป็อปอัปเต็มหน้าจอ (ตั้งแต่ 1.43.111026) ----------
// ใช้กับคลังคำสั่ง (orders.html) และผลงานในหน้าแรกของครู (dashboard.html) — แสดงไฟล์ผ่านหน้า preview ของ Google Drive ใน iframe
// ปิดได้ 3 ทาง: กดพื้นที่ว่างรอบไฟล์ · ปุ่ม ✕ · ปุ่ม Esc — ปุ่ม "เปิดไฟล์" (แท็บใหม่) ยังมีแยกต่างหากเหมือนเดิม
// drivePreviewUrl: แปลงลิงก์ไฟล์ Google Drive (…/file/d/<id>/view…) เป็นลิงก์ preview ที่ฝังใน iframe ได้ — ลิงก์แบบอื่นคืนค่าเดิม
function drivePreviewUrl(url) {
  var id = driveFileId(url);
  return id ? 'https://drive.google.com/file/d/' + id + '/preview' : String(url || '');
}
// ลิงก์ดาวน์โหลดไฟล์ Google Drive โดยตรง (1.47.121026 — ปุ่ม "ดาวน์โหลด" ในป็อปอัปพรีวิว) — ลิงก์แบบอื่นคืนค่าว่าง
// 1.51.121026: แก้บั๊ก — ไฟล์ Word/Excel/PowerPoint ที่ Drive คืนลิงก์เป็น docs.google.com/document|spreadsheets|presentation/d/<id>/edit
// (ไม่ใช่ /file/d/) เดิมหา id ไม่เจอ ได้ลิงก์ว่าง กดแล้ววนกลับหน้าเดิม (dashboard.html) — ไม่ใช่เรื่องสิทธิ์ของ Google Drive
function driveDownloadUrl(url) {
  var id = driveFileId(url);
  return id ? 'https://drive.google.com/uc?export=download&id=' + id : '';
}
// ---------- ปุ่มลิงก์เว็บไซต์โรงเรียน (1.52.121026: ใช้ร่วมกันระหว่างหน้าแรกและตัวอย่างในหน้าตั้งค่า) ----------
// รูปแนวนอน (แนะนำ 320×120, 8:3) = เต็มปุ่ม 160×60 เหมือนเดิม · รูปเกือบจัตุรัส (กว้าง/สูง < 1.6) = ไอคอนตัดขอบมนอัตโนมัติ + ชื่อปุ่มข้างๆ
function extLinkButtonHtml(l, opts) {
  opts = opts || {};
  var href = opts.preview ? '#' : escapeHtml(l.url || '#');
  var attrs = opts.preview ? ' tabindex="-1" aria-hidden="true"' : ' target="_blank" rel="noopener noreferrer"';
  if (l.imageDataUrl) {
    return '<a class="ext-link-btn ext-link-btn-image" href="' + href + '"' + attrs + ' title="' + escapeHtml(l.name || '') + '">' +
      '<img src="' + l.imageDataUrl + '" alt="' + escapeHtml(l.name || '') + '" /><span class="ext-link-label">' + escapeHtml(l.name || '') + '</span></a>';
  }
  return '<a class="ext-link-btn" href="' + href + '"' + attrs + ' style="background:' + escapeHtml(l.color || '#3457d5') + ';"><span>' + escapeHtml(l.name || 'ชื่อปุ่ม') + '</span></a>';
}
function enhanceExtLinkImages(root) {
  (root || document).querySelectorAll('.ext-link-btn-image img').forEach(function (img) {
    function apply() {
      if (!img.naturalWidth || !img.naturalHeight) return;
      img.parentNode.classList.toggle('is-square', img.naturalWidth / img.naturalHeight < 1.6);
    }
    if (img.complete) apply(); else img.addEventListener('load', apply, { once: true });
  });
}

// ---------- ชนิดไฟล์สำหรับพรีวิว (1.50.121026) ----------
// 'pdf' / 'video' = ตัวแสดงตัวอย่างของ Google Drive (iframe) · 'image' = แสดงรูปตรงจาก Drive (<img>) เพราะตัวพรีวิวของ Drive
// มักขึ้น "แสดงตัวอย่างไม่ได้" กับรูป (โดยเฉพาะไฟล์ที่ส่งมาโดยไม่มี mimeType) · 'office' = Word/Excel/PowerPoint ไม่พรีวิว
// (Google แปลงแล้วรูปแบบเพี้ยน) ให้ดาวน์โหลดไปเปิดในคอมพิวเตอร์แทน · 'other' = แสดงตัวอย่างไม่ได้ ให้ดาวน์โหลด
function fileKindOf(name, mime) {
  var n = String(name || '').toLowerCase(), m = String(mime || '').toLowerCase();
  if (/pdf/.test(m) || /\.pdf$/.test(n)) return 'pdf';
  if (/\.(docx?|dotx?|xlsx?|xlsm|xltx?|csv|pptx?|ppsx?|potx?|odt|ods|odp|rtf)$/.test(n) || /msword|wordprocessingml|ms-excel|spreadsheetml|ms-powerpoint|presentationml|opendocument|rtf/.test(m)) return 'office';
  if (/^image\//.test(m) || /\.(jpe?g|png|gif|webp|bmp|svg|heic|heif|tiff?)$/.test(n)) return 'image';
  if (/^video\//.test(m) || /\.(mp4|mov|m4v|webm|avi|mkv)$/.test(n)) return 'video';
  if (/^audio\//.test(m) || /\.(mp3|wav|m4a|ogg)$/.test(n)) return 'video';
  return m || n ? 'other' : 'pdf';
}
// 1.85.3: ไอคอนชนิดไฟล์ (แบบ 2 พื้นสีอ่อน + ไอคอนไฟล์สีประจำชนิด) ใช้ร่วมทุกหน้า
var FILE_TYPE_ICONS = {
  word: ['fa-file-word', '#2563eb', 'Word'], excel: ['fa-file-excel', '#16a34a', 'Excel'],
  ppt: ['fa-file-powerpoint', '#ea580c', 'PowerPoint'], pdf: ['fa-file-pdf', '#dc2626', 'PDF'],
  image: ['fa-image', '#7c3aed', 'รูปภาพ'], video: ['fa-file-video', '#db2777', 'วิดีโอ'],
  audio: ['fa-file-audio', '#0891b2', 'เสียง'], zip: ['fa-file-zipper', '#a16207', 'ไฟล์บีบอัด'],
  other: ['fa-file-lines', '#64748b', 'ไฟล์']
};
function fileTypeKey(name, mime) {
  var n = String(name || '').toLowerCase(), m = String(mime || '').toLowerCase();
  if (/pdf/.test(m) || /\.pdf$/.test(n)) return 'pdf';
  if (/^image\//.test(m) || /\.(jpe?g|png|gif|webp|bmp|svg|heic|heif|tiff?)$/.test(n)) return 'image';
  if (/presentation|powerpoint/.test(m) || /\.(pptx?|ppsx?|potx?|odp)$/.test(n)) return 'ppt';
  if (/spreadsheet|excel/.test(m) || /\.(xlsx?|xlsm|xltx?|csv|ods)$/.test(n)) return 'excel';
  if (/wordprocessing|msword|opendocument\.text|rtf/.test(m) || /\.(docx?|dotx?|odt|rtf)$/.test(n)) return 'word';
  if (/^video\//.test(m) || /\.(mp4|mov|m4v|webm|avi|mkv)$/.test(n)) return 'video';
  if (/^audio\//.test(m) || /\.(mp3|wav|m4a|ogg)$/.test(n)) return 'audio';
  if (/zip|compressed|rar/.test(m) || /\.(zip|rar|7z)$/.test(n)) return 'zip';
  return m || n ? 'other' : 'pdf';
}
function fileTypeIconHtml(name, mime, size) {
  var k = fileTypeKey(name, mime), t = FILE_TYPE_ICONS[k];
  return '<span class="fic fic-' + k + (size ? ' fic-' + size : '') + '" style="--c:' + t[1] + '" title="' + t[2] + '" aria-hidden="true"><i class="fa-solid ' + t[0] + '"></i></span>';
}
function driveFileId(url) {
  var u = String(url || '');
  var m = /\/(?:file|document|spreadsheets|presentation|drawings|forms)\/(?:u\/\d+\/)?d\/([A-Za-z0-9_-]{10,})/.exec(u) ||
    /googleusercontent\.com\/d\/([A-Za-z0-9_-]{10,})/.exec(u) || /[?&]id=([A-Za-z0-9_-]{10,})/.exec(u) ||
    /drive\.google\.com\/.*\/d\/([A-Za-z0-9_-]{10,})/.exec(u);
  return m ? m[1] : '';
}
// ชื่อชนิดไฟล์สำหรับข้อความในป็อปอัปดาวน์โหลด
function officeKindLabel(name) {
  var n = String(name || '').toLowerCase();
  if (/\.(xlsx?|xlsm|xltx?|csv|ods)$/.test(n)) return 'Excel';
  if (/\.(pptx?|ppsx?|potx?|odp)$/.test(n)) return 'PowerPoint';
  return 'Word';
}

// nav (ตั้งแต่ 1.49.121026, ไม่บังคับ): { index, total, go(i) } — พรีวิวไล่ทีละไฟล์ มีปุ่มก่อนหน้า/ถัดไป + ลูกศรซ้าย/ขวาบนคีย์บอร์ด
// kind (ตั้งแต่ 1.50.121026, ไม่บังคับ): ผลจาก fileKindOf() — ไม่ส่ง = พรีวิวผ่าน Google Drive (iframe) เหมือนเดิม
function openFilePreview(previewUrl, title, openUrl, downloadUrl, nav, kind) {
  if (downloadUrl === undefined) downloadUrl = driveDownloadUrl(openUrl || previewUrl);
  var old = document.getElementById('filePreviewOverlay');
  var reuse = !!old && !!nav; // เปลี่ยนไฟล์ในโหมดไล่ทีละไฟล์ — ไม่ต้องเล่นแอนิเมชันเปิดใหม่
  if (old) { if (old.__dispose) old.__dispose(); old.remove(); }
  var ov = document.createElement('div');
  ov.id = 'filePreviewOverlay';
  ov.className = 'file-preview-overlay';
  ov.setAttribute('role', 'dialog');
  ov.setAttribute('aria-modal', 'true');
  ov.setAttribute('aria-label', 'พรีวิวไฟล์' + (title ? ' ' + title : ''));
  ov.innerHTML =
    '<div class="file-preview-frame">' +
      '<div class="file-preview-bar">' +
        (nav ? '<div class="file-preview-nav"><button type="button" class="icon-btn file-preview-prev" aria-label="ไฟล์ก่อนหน้า"' + (nav.index <= 0 ? ' disabled' : '') + '><i class="fa-solid fa-chevron-left"></i></button>' +
          '<span class="file-preview-count">' + (nav.index + 1) + '/' + nav.total + '</span>' +
          '<button type="button" class="icon-btn file-preview-next" aria-label="ไฟล์ถัดไป"' + (nav.index >= nav.total - 1 ? ' disabled' : '') + '><i class="fa-solid fa-chevron-right"></i></button></div>' : '') +
        '<div class="file-preview-title">' + escapeHtml(title || 'พรีวิวไฟล์') + '</div>' +
        (openUrl ? '<a class="btn btn-secondary btn-sm" href="' + escapeHtml(openUrl) + '" target="_blank" rel="noopener"><i class="fa-solid fa-up-right-from-square"></i><span class="fp-lbl"> เปิดไฟล์</span></a>' : '') +
        (downloadUrl ? '<a class="btn btn-primary btn-sm file-preview-dl" href="' + escapeHtml(downloadUrl) + '" target="_blank" rel="noopener" download><i class="fa-solid fa-download"></i><span class="fp-lbl"> ดาวน์โหลด</span></a>' : '') +
        '<button type="button" class="file-preview-close" aria-label="ปิดพรีวิว">✕</button>' +
      '</div>' +
      _filePreviewBodyHtml(previewUrl, title, openUrl, downloadUrl, kind) +
    '</div>';
  function close() {
    document.removeEventListener('keydown', onKey);
    ov.classList.remove('show');
    document.body.classList.remove('file-preview-open');
    setTimeout(function () { ov.remove(); }, 160);
  }
  function step(d) { var i = nav.index + d; if (i >= 0 && i < nav.total) nav.go(i); }
  function onKey(e) {
    if (e.key === 'Escape') close();
    else if (nav && e.key === 'ArrowLeft') step(-1);
    else if (nav && e.key === 'ArrowRight') step(1);
  }
  ov.__dispose = function () { document.removeEventListener('keydown', onKey); };
  ov.addEventListener('click', function (e) { if (e.target === ov || (e.target.classList && e.target.classList.contains('file-preview-imgwrap'))) close(); }); // กดพื้นที่ว่างรอบไฟล์ = ปิด
  // รูปภาพ: ลิงก์ตรงของ Drive ไม่ได้ -> ลองภาพย่อของ Drive -> ไม่ได้อีกแสดงข้อความ + ปุ่มดาวน์โหลด
  var img = ov.querySelector('.file-preview-img');
  if (img) {
    img.addEventListener('error', function () {
      var alt = img.getAttribute('data-fallback');
      if (alt) { img.removeAttribute('data-fallback'); img.src = alt; return; }
      // 1.72: ลิงก์รูปตรง + ภาพย่อไม่ได้ทั้งคู่ -> ใช้ตัวพรีวิวของ Google Drive (iframe) เป็นทางสุดท้าย
      var wrap = img.parentNode, fid = driveFileId(openUrl || previewUrl);
      wrap.outerHTML = fid ? '<iframe class="file-preview-iframe" src="https://drive.google.com/file/d/' + fid + '/preview" title="' + escapeHtml(title || 'พรีวิวไฟล์') + '" loading="eager"></iframe>'
        : _filePreviewDlPanel(fileTypeIconHtml('x.jpg', 'image/jpeg', 'lg'), 'แสดงรูปตัวอย่างไม่ได้', 'รูปนี้อาจเป็นชนิดที่เบราว์เซอร์แสดงไม่ได้ (เช่น HEIC) หรือยังไม่ได้แชร์แบบ "ทุกคนที่มีลิงก์" — ดาวน์โหลดไปเปิดในเครื่องได้เลย', downloadUrl, openUrl);
    });
    img.addEventListener('load', function () { img.classList.add('loaded'); });
  }
  ov.querySelector('.file-preview-close').addEventListener('click', close);
  if (nav) {
    ov.querySelector('.file-preview-prev').addEventListener('click', function () { step(-1); });
    ov.querySelector('.file-preview-next').addEventListener('click', function () { step(1); });
  }
  document.addEventListener('keydown', onKey);
  document.body.appendChild(ov);
  document.body.classList.add('file-preview-open');
  if (reuse) ov.classList.add('show', 'no-anim'); else requestAnimationFrame(function () { ov.classList.add('show'); });
  return close;
}

function _filePreviewDlPanel(icon, heading, text, downloadUrl, openUrl) {
  return '<div class="file-preview-dlpanel">' + (icon.charAt(0) === '<' ? icon : '<i class="fa-solid ' + icon + '" aria-hidden="true"></i>') +
    '<div class="fp-dl-h">' + escapeHtml(heading) + '</div><p>' + escapeHtml(text) + '</p>' +
    (downloadUrl ? '<a class="btn btn-primary file-preview-dl-big" href="' + escapeHtml(downloadUrl) + '" target="_blank" rel="noopener" download><i class="fa-solid fa-download"></i> ดาวน์โหลดไฟล์</a>' : '') +
    (!downloadUrl && openUrl ? '<a class="btn btn-secondary" href="' + escapeHtml(openUrl) + '" target="_blank" rel="noopener">เปิดไฟล์</a>' : '') +
    '</div>';
}
function _filePreviewBodyHtml(previewUrl, title, openUrl, downloadUrl, kind) {
  var id = driveFileId(openUrl || previewUrl);
  if (kind === 'image' && id) {
    return '<div class="file-preview-imgwrap"><img class="file-preview-img" src="https://lh3.googleusercontent.com/d/' + id + '=w2000" data-fallback="https://drive.google.com/thumbnail?id=' + id + '&sz=w2000" alt="' + escapeHtml(title || 'รูปภาพ') + '" referrerpolicy="no-referrer" /></div>';
  }
  // 1.72: Word/Excel/PowerPoint และไฟล์ชนิดอื่น พรีวิวผ่านตัวแสดงตัวอย่างของ Google Drive ทุกหน้า (เดิม 1.50 ให้ดาวน์โหลดอย่างเดียว)
  //       แสดงข้อความให้ดาวน์โหลดเฉพาะกรณีหา id ไฟล์ Drive ไม่เจอ
  if ((kind === 'office' || kind === 'other') && id) kind = 'pdf';
  if (kind === 'office') {
    var lbl = officeKindLabel(title);
    var ic = fileTypeIconHtml(lbl === 'Excel' ? 'x.xlsx' : lbl === 'PowerPoint' ? 'x.pptx' : 'x.docx', '', 'lg'); // 1.85.3
    return _filePreviewDlPanel(ic, 'ไฟล์ ' + lbl + ' — ดาวน์โหลดไปเปิดในคอมพิวเตอร์', 'ไฟล์ ' + lbl + ' แสดงตัวอย่างบนเว็บแล้วรูปแบบเอกสารจะเพี้ยน จึงให้ดาวน์โหลดไปเปิดด้วยโปรแกรม ' + lbl + ' ในเครื่องแทน', downloadUrl, openUrl);
  }
  if (kind === 'other') {
    return _filePreviewDlPanel(fileTypeIconHtml(title, '', 'lg'), 'ไฟล์ชนิดนี้แสดงตัวอย่างไม่ได้', 'ดาวน์โหลดไปเปิดด้วยโปรแกรมในเครื่องได้เลย', downloadUrl, openUrl);
  }
  return '<iframe class="file-preview-iframe" src="' + escapeHtml(previewUrl) + '" title="' + escapeHtml(title || 'พรีวิวไฟล์') + '" allow="autoplay" loading="eager"></iframe>';
}

// ---------- ป็อปอัปทั้งเว็บ: กดพื้นที่ว่างรอบป็อปอัป = ป็อปอัปเด้งกระพริบเตือน (ไม่ปิด) — ตั้งแต่ 1.46.121026 ----------
// ใช้กับทุก .modal-backdrop ทุกหน้า รวมถึงป็อปอัปที่สร้างทีหลัง (ผูก event ที่ document ครั้งเดียว) — ยกเว้นพรีวิวไฟล์ (openFilePreview)
// และกล่องเปิดหนังสือใน view.html ซึ่งกดพื้นที่ว่างแล้วปิดตามเดิม (ไม่ใช่ .modal-backdrop)
// ต้องกดลงและปล่อยบนพื้นที่ว่างทั้งคู่ — กันกรณีลากคลุมข้อความในช่องกรอกแล้วปล่อยเมาส์นอกป็อปอัป
(function () {
  var downOnBackdrop = null;
  document.addEventListener('mousedown', function (e) {
    downOnBackdrop = (e.target && e.target.classList && e.target.classList.contains('modal-backdrop')) ? e.target : null;
  }, true);
  document.addEventListener('click', function (e) {
    var bd = e.target;
    if (!bd || !bd.classList || !bd.classList.contains('modal-backdrop') || bd !== downOnBackdrop) return;
    var box = bd.querySelector('.modal-box');
    if (!box) return;
    box.classList.remove('modal-bump');
    void box.offsetWidth; // รีสตาร์ทแอนิเมชันเมื่อกดซ้ำเร็วๆ
    box.classList.add('modal-bump');
    setTimeout(function () { box.classList.remove('modal-bump'); }, 520);
  });
})();

// เรียกทันทีตอนโหลดสคริปต์เพื่อกันธีมกะพริบ (เผื่อกรณี inline script หัวไฟล์ไม่ทำงาน)
// ยกเว้นหน้าล็อกอิน (index.html) ที่บังคับใช้ธีมสว่างเท่านั้นเสมอ ไม่ว่าจะเคยตั้งค่าธีมมืดไว้จากหน้าอื่นในเครื่องเดียวกันหรือไม่ก็ตาม
function _isLoginPage() {
  var p = location.pathname;
  return /\/index\.html$/.test(p) || /\/$/.test(p) || p === '';
}
// หน้าแสดงผลงานสาธารณะ (view.html) ก็บังคับใช้ธีมสว่างเท่านั้นเสมอเช่นกัน (ตั้งแต่ V9.9) — เป็นหน้าที่คนภายนอกเปิดดูได้โดยไม่ล็อกอิน
// ไม่ควรพึ่งค่า localStorage ของเบราว์เซอร์คนดู (ซึ่งอาจไม่ใช่เจ้าของบัญชีเลยด้วยซ้ำ) มากำหนดหน้าตาของหน้านี้
function _isForcedLightPage() {
  return _isLoginPage() || /\/(view|certificate|photos)\.html$/.test(location.pathname); // 1.75: หน้าค้นหาเกียรติบัตร · 1.76: หน้าคลังรูปภาพสาธารณะ
}
applyTheme(_isForcedLightPage() ? 'light' : getTheme());

// ---------- 1.68: ตัวเลือกกลุ่มเป้าหมาย (สำหรับ) ของกำหนดการ/ประกาศ ----------
// ค่าที่เก็บ: 'all' | 'g:กลุ่ม|กลุ่ม' | 'u:id|id' (ค่าเดิม = userId คนเดียว) — Worker ตรวจ/กรองด้วยรูปแบบเดียวกัน (lib/util.js)
// 1.88: 's:กลุ่มสาระ|…' = กลุ่มสาระการเรียนรู้ (ทั้งกลุ่ม) · 'sh:กลุ่มสาระ|…' = เฉพาะหัวหน้ากลุ่มสาระ (คิดจากกลุ่มสาระ/หน้าที่ในบัญชีครู ณ ตอนที่เปิดดู)
var AUD_SUBJECTS = Object.keys(SUBJECT_GROUP_COLORS);
function subjectShort(s) { return s === 'สังคมศึกษา ศาสนา และวัฒนธรรม' ? 'สังคมศึกษาฯ' : s; }
function isSubjectHeadUser(u) { return !!u && !!u.subjectGroup && (u.headRoles || []).indexOf('subject') !== -1; }
function parseAudienceStr(a) {
  var s = String(a || 'all');
  if (s === 'all') return { type: 'all', ids: [] };
  if (s.indexOf('g:') === 0) return { type: 'groups', ids: s.slice(2).split('|').filter(Boolean) };
  if (s.indexOf('u:') === 0) return { type: 'people', ids: s.slice(2).split('|').filter(Boolean) };
  if (s.indexOf('sh:') === 0) return { type: 'subjectHeads', ids: s.slice(3).split('|').filter(Boolean) };
  if (s.indexOf('s:') === 0) return { type: 'subjects', ids: s.slice(2).split('|').filter(Boolean) };
  return { type: 'people', ids: [s] };
}
function audienceLabel(a, users) {
  var p = parseAudienceStr(a);
  if (p.type === 'all') return 'ทั้งหมด';
  if (p.type === 'groups') return p.ids.map(function (d) { return groupLabel(d); }).join(', ');
  if (p.type === 'subjects' || p.type === 'subjectHeads') {
    var allS = AUD_SUBJECTS.every(function (x) { return p.ids.indexOf(x) !== -1; });
    var head = p.type === 'subjectHeads' ? 'หัวหน้ากลุ่มสาระ' : 'กลุ่มสาระ';
    return allS ? (p.type === 'subjectHeads' ? 'หัวหน้ากลุ่มสาระทุกกลุ่ม' : 'ทุกกลุ่มสาระ') : head + ' ' + p.ids.map(subjectShort).join(', ');
  }
  var names = p.ids.map(function (id) { var u = (users || []).filter(function (x) { return x.id === id; })[0]; return u ? u.name : ''; }).filter(Boolean);
  if (!names.length) return 'รายบุคคล ' + p.ids.length + ' คน';
  return names.length > 3 ? names.slice(0, 3).join(', ') + ' และอีก ' + (names.length - 3) + ' คน' : names.join(', ');
}
// สร้างตัวเลือกใน el (div ว่าง) — opts: { departments: [...], users: [{id,name,department,subjectGroup,headRoles}] } · คืน { get(), set(a), check() }
function createAudiencePicker(el, opts) {
  opts = opts || {};
  var state = { type: 'all', groups: {}, people: {}, subjects: {} };
  var q = '';
  el.classList.add('aud-pick');
  el.innerHTML =
    '<div class="aud-seg" role="radiogroup" aria-label="สำหรับ">' +
      '<button type="button" role="radio" data-aud="all"><i class="fa-solid fa-users" aria-hidden="true"></i> ทั้งหมด</button>' +
      '<button type="button" role="radio" data-aud="groups"><i class="fa-solid fa-sitemap" aria-hidden="true"></i> กลุ่มบริหารงาน</button>' +
      '<button type="button" role="radio" data-aud="subjects"><i class="fa-solid fa-book" aria-hidden="true"></i> กลุ่มสาระฯ (ทั้งกลุ่ม)</button>' +
      '<button type="button" role="radio" data-aud="subjectHeads"><i class="fa-solid fa-user-tie" aria-hidden="true"></i> กลุ่มสาระฯ (เฉพาะหัวหน้า)</button>' +
      '<button type="button" role="radio" data-aud="people"><i class="fa-solid fa-user-check" aria-hidden="true"></i> รายบุคคล</button>' +
    '</div>' +
    '<div class="aud-groups" hidden></div>' +
    '<div class="aud-subjects" hidden></div>' +
    '<div class="aud-people" hidden><div class="aud-sel"></div><input type="search" class="aud-q" placeholder="ค้นหาชื่อ…" aria-label="ค้นหาชื่อ" /><div class="aud-list"></div></div>';
  var seg = el.querySelector('.aud-seg'), gBox = el.querySelector('.aud-groups'), sBox = el.querySelector('.aud-subjects'), pBox = el.querySelector('.aud-people');
  function users() { return (typeof opts.users === 'function' ? opts.users() : opts.users) || []; }
  function depts() { return (typeof opts.departments === 'function' ? opts.departments() : opts.departments) || []; }
  function isSubj() { return state.type === 'subjects' || state.type === 'subjectHeads'; }
  function render() {
    Array.prototype.forEach.call(seg.querySelectorAll('[data-aud]'), function (b) { var on = b.getAttribute('data-aud') === state.type; b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); });
    gBox.hidden = state.type !== 'groups'; pBox.hidden = state.type !== 'people'; sBox.hidden = !isSubj();
    if (state.type === 'groups') {
      gBox.innerHTML = depts().map(function (d) {
        var c = deptThemeColor(d), on = !!state.groups[d];
        return '<label class="aud-g' + (on ? ' on' : '') + '"' + (c ? ' style="--g:' + c + '"' : '') + '><input type="checkbox" data-g="' + escapeHtml(d) + '"' + (on ? ' checked' : '') + ' /><span>' + escapeHtml(groupLabel(d)) + '</span></label>';
      }).join('') || '<div class="hint">ยังไม่มีกลุ่มบริหารงาน</div>';
    }
    if (isSubj()) {
      var heads = state.type === 'subjectHeads', us = users();
      var allOn = AUD_SUBJECTS.every(function (x) { return state.subjects[x]; });
      sBox.innerHTML = '<label class="aud-g aud-s-all' + (allOn ? ' on' : '') + '"><input type="checkbox" data-s-all' + (allOn ? ' checked' : '') + ' /><span>ทุกกลุ่มสาระ</span></label>' +
        AUD_SUBJECTS.map(function (sg) {
          var n = us.filter(function (u) { return u.subjectGroup === sg && (!heads || isSubjectHeadUser(u)); }).length, on = !!state.subjects[sg];
          return '<label class="aud-g' + (on ? ' on' : '') + '" style="--g:' + SUBJECT_GROUP_COLORS[sg] + '"><input type="checkbox" data-s="' + escapeHtml(sg) + '"' + (on ? ' checked' : '') + ' /><span>' + escapeHtml(subjectShort(sg)) + ' <small class="aud-n">(' + n + ')</small></span></label>';
        }).join('') +
        '<div class="hint aud-s-hint">' + (heads ? 'เฉพาะครูที่ตั้งเป็นหัวหน้ากลุ่มสาระในทำเนียบ' : 'ครูทุกคนในกลุ่มสาระที่เลือก') + ' · รายชื่อเปลี่ยนตามข้อมูลในบัญชีครู (ย้ายกลุ่ม/เปลี่ยนหัวหน้า = เปลี่ยนตาม)</div>';
    }
    if (state.type === 'people') {
      var us2 = users(), sel = us2.filter(function (u) { return state.people[u.id]; });
      pBox.querySelector('.aud-sel').innerHTML = sel.length ? sel.map(function (u) { return '<span class="aud-chip">' + escapeHtml(u.name) + '<button type="button" data-unp="' + escapeHtml(u.id) + '" aria-label="เอาออก">✕</button></span>'; }).join('') + '<span class="aud-count">เลือก ' + sel.length + ' คน</span>' : '<span class="hint">ยังไม่ได้เลือก — ติ๊กชื่อด้านล่าง</span>';
      var nq = q.replace(/\s+/g, '').toLowerCase();
      var list = us2.filter(function (u) { return !nq || String(u.name).replace(/\s+/g, '').toLowerCase().indexOf(nq) !== -1 || String(u.department || '').indexOf(q.trim()) !== -1 || String(u.subjectGroup || '').indexOf(q.trim()) !== -1; });
      pBox.querySelector('.aud-list').innerHTML = list.map(function (u) {
        return '<label class="aud-p"><input type="checkbox" data-p="' + escapeHtml(u.id) + '"' + (state.people[u.id] ? ' checked' : '') + ' /><span>' + escapeHtml(u.name) + '</span>' + (u.department ? '<small>' + escapeHtml(groupLabel(u.department)) + '</small>' : '') + '</label>';
      }).join('') || '<div class="hint" style="padding:8px">ไม่พบชื่อ</div>';
    }
  }
  seg.addEventListener('click', function (e) { var b = e.target.closest('[data-aud]'); if (!b) return; state.type = b.getAttribute('data-aud'); render(); });
  gBox.addEventListener('change', function (e) { var c = e.target.closest('[data-g]'); if (!c) return; if (c.checked) state.groups[c.getAttribute('data-g')] = true; else delete state.groups[c.getAttribute('data-g')]; render(); });
  sBox.addEventListener('change', function (e) {
    var a = e.target.closest('[data-s-all]');
    if (a) { state.subjects = {}; if (a.checked) AUD_SUBJECTS.forEach(function (x) { state.subjects[x] = true; }); render(); return; }
    var c = e.target.closest('[data-s]'); if (!c) return;
    if (c.checked) state.subjects[c.getAttribute('data-s')] = true; else delete state.subjects[c.getAttribute('data-s')]; render();
  });
  pBox.addEventListener('change', function (e) { var c = e.target.closest('[data-p]'); if (!c) return; if (c.checked) state.people[c.getAttribute('data-p')] = true; else delete state.people[c.getAttribute('data-p')]; render(); });
  pBox.addEventListener('click', function (e) { var b = e.target.closest('[data-unp]'); if (!b) return; delete state.people[b.getAttribute('data-unp')]; render(); });
  pBox.querySelector('.aud-q').addEventListener('input', function () { q = this.value; render(); });
  var api = {
    get: function () {
      if (state.type === 'groups') return 'g:' + Object.keys(state.groups).join('|');
      if (state.type === 'people') return 'u:' + Object.keys(state.people).join('|');
      if (isSubj()) return (state.type === 'subjectHeads' ? 'sh:' : 's:') + AUD_SUBJECTS.filter(function (x) { return state.subjects[x]; }).join('|');
      return 'all';
    },
    set: function (a) {
      var p = parseAudienceStr(a); state = { type: p.type, groups: {}, people: {}, subjects: {} }; q = ''; pBox.querySelector('.aud-q').value = '';
      p.ids.forEach(function (id) { if (p.type === 'groups') state.groups[id] = true; else if (p.type === 'people') state.people[id] = true; else state.subjects[id] = true; });
      render();
    },
    // คืนข้อความผิดพลาด หรือ '' ถ้าใช้ได้
    check: function () {
      if (state.type === 'groups' && !Object.keys(state.groups).length) return 'กรุณาเลือกกลุ่มบริหารงานอย่างน้อย 1 กลุ่ม';
      if (state.type === 'people' && !Object.keys(state.people).length) return 'กรุณาเลือกบุคคลอย่างน้อย 1 คน';
      if (isSubj() && !Object.keys(state.subjects).length) return 'กรุณาเลือกกลุ่มสาระการเรียนรู้อย่างน้อย 1 กลุ่ม';
      return '';
    },
    refresh: render
  };
  render();
  return api;
}

// ======================================================================
// 1.75: กระดิ่งแจ้งเตือน + แจ้งปัญหา
// ======================================================================
var NOTIF_KIND = {
  cert_reserved: ['fa-hashtag', '#ea580c'], cert_uploaded: ['fa-award', '#d97706'], order: ['fa-file-signature', '#2563eb'], album: ['fa-images', '#0d9488'], album_deleted: ['fa-trash-can', '#dc2626'],
  report_new: ['fa-inbox', '#ef4444'], report_reply: ['fa-reply', '#7c3aed'], report_status: ['fa-headset', '#7c3aed'],
  report_done: ['fa-circle-check', '#16a34a'], report_forward: ['fa-share', '#0891b2'],
  // 1.80: ตรวจผลงาน + เตือนกำหนดส่ง
  review_ok: ['fa-circle-check', '#16a34a'], review_fix: ['fa-pen-to-square', '#ca8a04'], review_resubmit: ['fa-file-arrow-up', '#0369a1'], resp_assigned: ['fa-user-check', '#7c3aed'], // 1.94: ได้รับมอบหมายเป็นผู้รับผิดชอบ
  due_soon: ['fa-clock', '#d97706'], due_today: ['fa-calendar-day', '#ea580c'], due_late: ['fa-hourglass-end', '#dc2626'],
  activity_new: ['fa-flag', '#16a34a'], activity_soon: ['fa-flag', '#0d9488'], // 1.81: กิจกรรม
  att_missing: ['fa-clipboard-check', '#7c3aed'], hr_missing: ['fa-book-open', '#0891b2'], // 1.91: เว็บเช็คชื่อ
  sup_date: ['fa-chalkboard-user', '#7c3aed'], sup_duty: ['fa-clipboard-check', '#7c3aed'] // 1.98: นิเทศการสอน
};
var _notifCovers = {}; // 1.85.2: รูปปกอัลบั้มในกระดิ่ง
function applyTopBadges(r) {
  if (!r) return;
  if (r.welcome) openWelcome(); // 1.79: ป็อปอัปต้อนรับครั้งแรกของบัญชี
  var b = document.getElementById('notifBadge');
  if (b && typeof r.notifUnread === 'number') {
    b.textContent = r.notifUnread > 99 ? '99+' : String(r.notifUnread);
    b.hidden = !r.notifUnread;
    var btn = document.getElementById('notifBtn');
    if (btn) btn.classList.toggle('has-new', r.notifUnread > 0);
  }
  if (typeof r.reportOpen === 'number') { window.__reportOpenCount = r.reportOpen; if (window.__onReportOpenCount) window.__onReportOpenCount(r.reportOpen); }
}
async function refreshTopBadges() {
  if (!getToken() || !document.getElementById('notifBtn')) return;
  try { applyTopBadges(await apiCall('checkSession', {})); } catch (e) { /* รอบถัดไป */ }
}
function notifTimeText(iso) {
  var t = Date.parse(iso); if (!t) return '';
  var diff = (Date.now() - t) / 1000;
  if (diff < 60) return 'เมื่อสักครู่';
  if (diff < 3600) return Math.floor(diff / 60) + ' นาทีที่แล้ว';
  var d = new Date(t), now = new Date();
  if (d.toDateString() === now.toDateString()) return Math.floor(diff / 3600) + ' ชั่วโมงที่แล้ว';
  var y = new Date(now); y.setDate(now.getDate() - 1);
  var hm = ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2);
  if (d.toDateString() === y.toDateString()) return 'เมื่อวาน ' + hm;
  return formatDateThai(iso);
}
function notifGroupOf(iso) {
  var t = new Date(Date.parse(iso)), now = new Date();
  if (t.toDateString() === now.toDateString()) return 'วันนี้';
  return (now - t) < 7 * 86400000 ? 'สัปดาห์นี้' : 'ก่อนหน้านี้';
}
// 1.79.2: เมนูในแถบบน/ท้ายหน้าเปิดได้ทีละอัน — เปิดอันหนึ่ง อันอื่นปิดเอง (ทุกเมนูใช้ stopPropagation จึงต้องแจ้งกันเอง)
function announceMenuOpen(name) { document.dispatchEvent(new CustomEvent('bnkah:menu-open', { detail: name })); }
function onOtherMenuOpen(name, closeFn) { document.addEventListener('bnkah:menu-open', function (e) { if (e.detail !== name) closeFn(); }); }
function initNotifBell() {
  var btn = document.getElementById('notifBtn');
  if (!btn) return;
  var panel = document.createElement('div');
  panel.className = 'notif-panel'; panel.id = 'notifPanel'; panel.hidden = true;
  panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-label', 'แจ้งเตือน');
  document.body.appendChild(panel);
  var state = { items: [], due: [], soon: [], att: [], more: false, limit: 30, filter: 'all', loading: false };
  function itemHtml(n) {
    var k = NOTIF_KIND[n.kind] || ['fa-bell', '#64748b'];
    var tm = n.note ? n.note : n.activityDate ? formatDateThai(n.dueDate) : n.dueDate ? 'กำหนดส่ง ' + formatDateThai(n.dueDate) : notifTimeText(n.createdAt);
    // 1.85.2: อัลบั้ม = รูปปกแทนไอคอน + ชื่ออัลบั้มตัวหนา · ยังไม่อ่าน = ปุ่ม ✓ "อ่านแล้ว" ท้ายรายการ (ไม่ต้องเปิดหน้านั้น)
    var ic = '<span class="notif-ic" style="background:' + k[1] + '"><i class="fa-solid ' + k[0] + '" aria-hidden="true"></i></span>';
    if (n.kind === 'album' && n.album) {
      var src = n.album.managed ? (_notifCovers[n.album.id] || '') : (n.album.coverFileId ? 'https://drive.google.com/thumbnail?id=' + encodeURIComponent(n.album.coverFileId) + '&sz=w160' : '');
      ic = '<span class="notif-th" data-nth="' + escapeHtml(n.album.id) + '">' + (src ? '<img src="' + src + '" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()" />' : '') + '<i class="fa-solid fa-images" aria-hidden="true"></i></span>';
    }
    return '<button type="button" class="notif-item' + (n.unread ? ' unread' : '') + (n.pinned ? ' pinned' : '') + (n.kind === 'album' ? ' alb' : '') + '" data-nid="' + escapeHtml(n.id) + '">' + ic +
      '<span class="notif-tx"><span class="notif-t">' + escapeHtml(n.title) + '</span>' + (n.body ? '<span class="notif-b">' + escapeHtml(n.body) + '</span>' : '') +
      '<span class="notif-tm">' + escapeHtml(tm) + (n.dept ? ' · ' + escapeHtml(groupLabel(n.dept)) : '') + '</span></span>' +
      (n.unread && !n.pinned ? '<span class="notif-rd" role="button" tabindex="0" data-nread="' + escapeHtml(n.id) + '" title="ทำเครื่องหมายว่าอ่านแล้ว" aria-label="อ่านแล้ว"><i class="fa-solid fa-check" aria-hidden="true"></i></span>' : (n.unread ? '<span class="notif-dot" aria-label="ยังไม่อ่าน"></span>' : '')) + '</button>';
  }
  function render() {
    var list = state.items.filter(function (n) { return state.filter === 'all' || n.unread; });
    var unreadRead = state.items.filter(function (n) { return n.unread; }).length;
    var unread = unreadRead; // 1.81: งานที่ต้องส่ง/กิจกรรมใกล้ถึงปักไว้แยก ไม่นับเป็น "ยังไม่อ่าน"
    var html = '<div class="notif-head"><i class="fa-solid fa-bell" aria-hidden="true"></i><b>แจ้งเตือน</b>' +
      (unreadRead ? '<button type="button" class="notif-readall" data-nact="readall">อ่านทั้งหมดแล้ว</button>' : '') + '</div>' +
      '<div class="notif-filter"><button type="button" data-nf="all" class="' + (state.filter === 'all' ? 'on' : '') + '">ทั้งหมด</button>' +
      '<button type="button" data-nf="unread" class="' + (state.filter === 'unread' ? 'on' : '') + '">ยังไม่อ่าน (' + unread + ')</button></div><div class="notif-list">';
    if (state.loading && !state.items.length) html += '<div class="notif-empty"><span class="loading">กำลังโหลด</span></div>';
    else if (!list.length && !state.due.length && !state.soon.length && !state.att.length) html += '<div class="notif-empty"><i class="fa-solid fa-bell-slash" aria-hidden="true"></i>' + (state.filter === 'unread' ? 'อ่านครบทุกรายการแล้ว' : 'ยังไม่มีแจ้งเตือนใหม่<br>เกียรติบัตร คำสั่ง และเรื่องที่แจ้ง จะแสดงที่นี่') + '</div>';
    else {
      // 1.80: "งานที่ต้องส่ง" ปักไว้บนสุดเสมอ (ทั้ง 2 ตัวกรอง) — หายเมื่อส่งงานแล้ว
      if (state.att.length) html += '<div class="notif-group">เว็บเช็คชื่อ</div>' + state.att.map(itemHtml).join(''); // 1.91
      if (state.soon.length) html += '<div class="notif-group">กิจกรรมใกล้ถึง</div>' + state.soon.map(itemHtml).join(''); // 1.81
      if (state.due.length) html += '<div class="notif-group">งานที่ต้องส่ง</div>' + state.due.map(itemHtml).join('');
      var g = '';
      list.forEach(function (n) {
        var grp = notifGroupOf(n.createdAt);
        if (grp !== g) { g = grp; html += '<div class="notif-group">' + grp + '</div>'; }
        html += itemHtml(n);
      });
      if (state.more && state.filter === 'all') html += '<button type="button" class="notif-more" data-nact="more">ดูเพิ่ม</button>';
    }
    html += '</div><div class="notif-foot">แจ้งเตือนเก็บไว้ 30 วัน แล้วลบอัตโนมัติ</div>';
    panel.innerHTML = html;
    loadNotifCovers();
  }
  // 1.85.2: รูปปกอัลบั้มที่ระบบเก็บไว้ (โหลดครั้งเดียวต่ออัลบั้ม)
  function loadNotifCovers() {
    var need = state.items.filter(function (n) { return n.kind === 'album' && n.album && n.album.managed && !(n.album.id in _notifCovers); }).map(function (n) { return n.album.id; }).slice(0, 30);
    if (!need.length) return;
    need.forEach(function (id) { _notifCovers[id] = ''; });
    apiCall('albumCovers', { ids: need }).then(function (r) {
      var cv = (r && r.covers) || {};
      Object.keys(cv).forEach(function (id) {
        _notifCovers[id] = cv[id];
        var th = panel.querySelector('[data-nth="' + id + '"]');
        if (th && !th.querySelector('img')) th.insertAdjacentHTML('afterbegin', '<img src="' + cv[id] + '" alt="" />');
      });
    }).catch(function () { /* ข้าม */ });
  }
  async function load() {
    state.loading = true; render();
    try { var r = await apiCall('notifList', { limit: state.limit }); state.items = r.items || []; state.due = r.due || []; state.soon = r.soon || []; state.att = r.att || []; state.more = !!r.more; applyTopBadges({ notifUnread: 0 }); } // 1.81: เปิดกระดิ่ง = เลขหาย (งานที่ต้องส่งเตือนใหม่พรุ่งนี้)
    catch (e) { panel.querySelector('.notif-list').innerHTML = '<div class="notif-empty">' + escapeHtml(e.message) + '</div>'; state.loading = false; return; }
    state.loading = false; render();
  }
  function place() {
    var r = btn.getBoundingClientRect();
    if (window.innerWidth <= 640) { panel.style.left = '0px'; panel.style.right = '0px'; panel.style.top = (r.bottom + 8) + 'px'; panel.classList.add('mobile'); return; }
    panel.classList.remove('mobile');
    panel.style.top = (r.bottom + 10) + 'px';
    panel.style.right = Math.max(8, window.innerWidth - r.right - 60) + 'px';
    panel.style.left = 'auto';
  }
  function open() {
    announceMenuOpen('notif');
    place(); panel.hidden = false; btn.setAttribute('aria-expanded', 'true');
    applyTopBadges({ notifUnread: 0 }); // เปิดกล่อง = ตัวเลขแดงหาย (จุดยังไม่อ่านยังอยู่)
    apiCall('notifSeen', {}).catch(function () {});
    load();
  }
  function close() { panel.hidden = true; btn.setAttribute('aria-expanded', 'false'); }
  onOtherMenuOpen('notif', function () { if (!panel.hidden) close(); });
  btn.addEventListener('click', function (e) { e.stopPropagation(); if (panel.hidden) open(); else close(); });
  // 1.76: กดตัวกรอง/ปุ่มในกล่องแล้วกล่องวาดใหม่ (ปุ่มที่กดหลุดจากหน้า) — ใช้เส้นทางของเหตุการณ์ตอนกด ไม่ใช่ตำแหน่งปัจจุบันของปุ่ม
  document.addEventListener('click', function (e) {
    if (panel.hidden) return;
    var path = e.composedPath ? e.composedPath() : [];
    if (path.indexOf(panel) !== -1 || btn.contains(e.target)) return;
    close();
  });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !panel.hidden) close(); });
  window.addEventListener('resize', function () { if (!panel.hidden) place(); });
  panel.addEventListener('click', async function (e) {
    var f = e.target.closest('[data-nf]');
    if (f) { state.filter = f.getAttribute('data-nf'); render(); return; }
    var a = e.target.closest('[data-nact]');
    if (a && a.getAttribute('data-nact') === 'readall') {
      state.items.forEach(function (n) { n.unread = false; }); render();
      apiCall('notifRead', { all: true }).catch(function () {});
      return;
    }
    if (a && a.getAttribute('data-nact') === 'more') { state.limit += 30; load(); return; }
    var rd = e.target.closest('[data-nread]');
    if (rd) { // 1.85.2: อ่านแล้ว โดยไม่เปิดหน้านั้น
      e.preventDefault();
      var nr = state.items.filter(function (x) { return x.id === rd.getAttribute('data-nread'); })[0];
      if (nr) { nr.unread = false; render(); apiCall('notifRead', { id: nr.id }).catch(function () {}); }
      return;
    }
    var it = e.target.closest('[data-nid]');
    if (!it) return;
    var n = state.items.concat(state.due, state.soon, state.att).filter(function (x) { return x.id === it.getAttribute('data-nid'); })[0];
    if (!n) return;
    if (n.unread && !n.pinned) { n.unread = false; render(); try { await apiCall('notifRead', { id: n.id }); } catch (err) { /* ข้าม */ } }
    close();
    var link = n.link || '';
    if (/^https:\/\//i.test(link)) { window.open(link, '_blank', 'noopener'); return; } // 1.91: เว็บเช็คชื่อ (เว็บอื่น) เปิดแท็บใหม่
    if (/^#report:/.test(link)) { openReportModal({ tab: 'mine', focus: link.slice(8) }); return; }
    var here = location.pathname.split('/').pop() || 'index.html';
    if (link.split('#')[0] === here) { location.hash = link.split('#')[1] || ''; if (window.__onHashTab) window.__onHashTab(); return; }
    if (link) location.href = link;
  });
}

// ======================================================================
// 1.80: PWA — ติดตั้งแอปลงมือถือ/คอม (ไม่มีแจ้งเตือนในโทรศัพท์)
// Android/คอม (Chrome, Edge): เก็บเหตุการณ์ beforeinstallprompt ไว้ แล้วเรียกหน้าต่างติดตั้งของระบบเมื่อกดเมนู
// iPhone/iPad: เว็บสั่งติดตั้งเองไม่ได้ (Apple ไม่อนุญาต) → ป็อปอัปบอกวิธี 3 ขั้น · เปิดจากแอปที่ติดตั้งแล้ว = ซ่อนเมนู
// ======================================================================
var _deferredInstall = null;
function isStandaloneApp() { try { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; } catch (e) { return false; } }
function isIosDevice() { var ua = navigator.userAgent || ''; return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1); }
function canOfferInstall() { return !isStandaloneApp() && (!!_deferredInstall || isIosDevice()); }
function updateInstallItem() {
  var b = document.getElementById('ddInstall'), d = document.getElementById('ddInstallDiv');
  if (!b) return;
  var on = canOfferInstall(); b.hidden = !on; if (d) d.hidden = !on;
}
window.addEventListener('beforeinstallprompt', function (e) { e.preventDefault(); _deferredInstall = e; updateInstallItem(); });
window.addEventListener('appinstalled', function () { _deferredInstall = null; updateInstallItem(); try { showToast('ติดตั้งแอปเรียบร้อยแล้ว'); } catch (e) { /* ข้าม */ } });
async function startInstallApp() {
  if (_deferredInstall) {
    var ev = _deferredInstall; _deferredInstall = null;
    try { ev.prompt(); await ev.userChoice; } catch (e) { /* ข้าม — ถ้ากดยกเลิก เบราว์เซอร์จะส่ง beforeinstallprompt มาใหม่ภายหลังเอง */ }
    updateInstallItem();
    return;
  }
  if (isIosDevice()) openIosInstallHelp();
}
function openIosInstallHelp() {
  var m = document.getElementById('iosInstallModal');
  if (!m) {
    m = document.createElement('div');
    m.className = 'modal-backdrop'; m.id = 'iosInstallModal'; m.hidden = true;
    m.innerHTML = '<div class="modal-box ios-install-box" role="dialog" aria-modal="true" aria-labelledby="iosInstallTitle">' +
      '<button type="button" class="modal-close-x" data-ios-close aria-label="ปิด">✕</button>' +
      '<div class="ios-install-head"><img src="icons/apple-touch-icon.png" alt="" /><div><h3 id="iosInstallTitle">ติดตั้ง BNK Hub บน iPhone / iPad</h3><p class="hint">ใช้เวลาไม่ถึงนาที ทำครั้งเดียว</p></div></div>' +
      '<ol class="ios-install-steps">' +
        '<li>แตะปุ่ม <span class="ios-ic"><i class="fa-solid fa-arrow-up-from-bracket" aria-hidden="true"></i></span> <b>แชร์</b> ที่แถบของ Safari</li>' +
        '<li>เลื่อนลงแล้วแตะ <b>"เพิ่มไปยังหน้าจอโฮม"</b> <span class="ios-ic"><i class="fa-solid fa-square-plus" aria-hidden="true"></i></span></li>' +
        '<li>แตะ <b>"เพิ่ม"</b> มุมขวาบน</li>' +
      '</ol>' +
      '<p class="ios-install-note">ต้องเปิดเว็บนี้ด้วย Safari · เข้าแอปครั้งแรกต้องเข้าสู่ระบบอีกครั้ง (ติ๊ก "เข้าสู่ระบบอัตโนมัติ" ไว้ จะไม่ต้องเข้าบ่อย)</p>' +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost btn-close" data-ios-close>ปิด</button></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) { if (e.target.closest('[data-ios-close]')) hideModalEl(m); });
  }
  showModalEl(m);
}
if ('serviceWorker' in navigator && (location.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
  window.addEventListener('load', function () { navigator.serviceWorker.register('sw.js').catch(function () { /* ไม่เป็นไร — ใช้งานเว็บได้ตามปกติ */ }); });
}

// 1.80: แถบแท็บที่เลื่อนได้ (มือถือ) — ขอบจางบอกว่ายังมีแท็บซ่อนอยู่ทางซ้าย/ขวา · กดแท็บแล้วเลื่อนให้เห็นทั้งแท็บ
function syncTabScrollHints(el) {
  var max = el.scrollWidth - el.clientWidth;
  el.classList.toggle('more-r', max > 2 && el.scrollLeft < max - 2);
  el.classList.toggle('more-l', max > 2 && el.scrollLeft > 2);
}
function initTabScrollHints() {
  document.querySelectorAll('.tabs').forEach(function (el) {
    if (el.__hint) { syncTabScrollHints(el); return; }
    el.__hint = true;
    el.addEventListener('scroll', function () { syncTabScrollHints(el); }, { passive: true });
    el.addEventListener('click', function (e) { var b = e.target.closest('.tab-btn'); if (b && b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' }); });
    syncTabScrollHints(el);
  });
}
window.addEventListener('resize', function () { document.querySelectorAll('.tabs').forEach(syncTabScrollHints); });
document.addEventListener('DOMContentLoaded', function () { initTabScrollHints(); setTimeout(initTabScrollHints, 800); setTimeout(initTabScrollHints, 2500); });

// ---------- แจ้งปัญหา (ป็อปอัป) ----------
var REPORT_STATUS = { open: ['รอรับเรื่อง', 'st-open'], progress: ['กำลังดำเนินการ', 'st-progress'], done: ['เสร็จแล้ว', 'st-done'] };
function reportStatusChip(st) { var s = REPORT_STATUS[st] || [st, '']; return '<span class="rp-status ' + s[1] + '">' + escapeHtml(s[0]) + '</span>'; }
function reportTargetChip(r) {
  if (r.target === 'system') return '<span class="rp-chip rp-sys"><i class="fa-solid fa-laptop-code" aria-hidden="true"></i> การใช้งานระบบ</span>';
  return '<span class="rp-chip"' + deptColorAttr(r.department) + '><i class="fa-solid fa-user-group" aria-hidden="true"></i> ' + escapeHtml(groupLabel(r.department)) + '</span>';
}
function reportThreadHtml(msgs) {
  return (msgs || []).map(function (m) {
    if (m.side === 'system') return '<div class="rp-msg rp-msg-sys"><i class="fa-solid fa-share" aria-hidden="true"></i> ' + escapeHtml(m.body) + ' · ' + escapeHtml(notifTimeText(m.createdAt)) + '</div>';
    return '<div class="rp-msg ' + (m.side === 'staff' ? 'rp-staff' : 'rp-reporter') + '"><div class="rp-who">' + escapeHtml(m.mine ? 'คุณ' : m.authorName) + ' · ' + escapeHtml(formatDateTimeThai(m.createdAt)) + '</div><div class="rp-body">' + escapeHtml(m.body).replace(/\n/g, '<br>') + '</div></div>';
  }).join('');
}
function reportFilesHtml(files) {
  if (!files || !files.length) return '';
  return '<div class="rp-files">' + files.map(function (f, i) {
    return '<button type="button" class="rp-file" data-rp-img="' + i + '" title="ดูภาพ"><img src="https://lh3.googleusercontent.com/d/' + encodeURIComponent(f.fileId) + '=w240" alt="ภาพแนบ ' + (i + 1) + '" referrerpolicy="no-referrer" loading="lazy" /></button>';
  }).join('') + '</div>';
}
function openReportImages(files, i) {
  var list = files.map(function (f, k) { return { url: 'https://drive.google.com/file/d/' + f.fileId + '/preview', title: 'ภาพแนบ ' + (k + 1) }; });
  (function show(j) { openFilePreview(list[j].url, list[j].title, '', '', list.length > 1 ? { index: j, total: list.length, go: show } : null, 'image'); })(i);
}
function reportClientInfo() {
  var ua = navigator.userAgent || '', b = 'เบราว์เซอร์อื่น', o = 'อื่นๆ', m;
  if ((m = /Edg\/(\d+)/.exec(ua))) b = 'Edge ' + m[1];
  else if ((m = /Chrome\/(\d+)/.exec(ua)) && !/OPR\//.test(ua)) b = 'Chrome ' + m[1];
  else if ((m = /Firefox\/(\d+)/.exec(ua))) b = 'Firefox ' + m[1];
  else if ((m = /Version\/(\d+).*Safari/.exec(ua))) b = 'Safari ' + m[1];
  if (/Windows NT 10/.test(ua)) o = 'Windows 10/11'; else if (/Windows/.test(ua)) o = 'Windows';
  else if (/Android (\d+)/.test(ua)) o = 'Android ' + /Android (\d+)/.exec(ua)[1];
  else if (/iPhone|iPad/.test(ua)) o = 'iOS'; else if (/Mac OS X/.test(ua)) o = 'macOS'; else if (/Linux/.test(ua)) o = 'Linux';
  var page = (document.querySelector('.page-header h1') || {}).textContent || document.title || location.pathname;
  return { page: String(page).trim().slice(0, 100), ua: b + ' · ' + o + ' · จอ ' + screen.width + '×' + screen.height };
}
var _reportModal = null;
// ---------- 1.79: ป็อปอัปต้อนรับ (ครั้งแรกของบัญชี — จำในฐานข้อมูล users.welcomed_at) ----------
var _welcomeOpen = false;
var WELCOME_ITEMS = {
  t: [['fa-paper-plane', '#0b6fcc', 'ส่งผลงาน', 'กดปุ่ม "ส่งงาน" ในหน้าแรก ตามรายการกำหนดส่ง'], ['fa-bell', '#f59e0b', 'กระดิ่งแจ้งเตือน', 'เกียรติบัตรที่มีชื่อคุณ คำสั่งและอัลบั้มใหม่'], ['fa-book-open', '#7c3aed', 'คู่มือการใช้งาน', 'ปุ่มรูปหนังสือ มุมขวาบน มีภาพประกอบทุกขั้นตอน'], ['fa-headset', '#ef4444', 'แจ้งปัญหา', 'กดชื่อของคุณมุมขวาบน แล้วเลือก "แจ้งปัญหา"']],
  s: [['fa-bullhorn', '#0b6fcc', 'ประกาศและปฏิทิน', 'เพิ่มประกาศและกำหนดส่งงาน แสดงในหน้าแรกของครู'], ['fa-inbox', '#ef4444', 'เรื่องที่แจ้ง', 'เรื่องที่ครูแจ้งถึงกลุ่มคุณ อยู่ในหน้าประกาศและปฏิทิน'], ['fa-bell', '#f59e0b', 'กระดิ่งแจ้งเตือน', 'เรื่องที่แจ้งใหม่ เกียรติบัตร คำสั่งและอัลบั้มใหม่'], ['fa-book-open', '#7c3aed', 'คู่มือการใช้งาน', 'ปุ่มรูปหนังสือ มุมขวาบน มีภาพประกอบทุกขั้นตอน']],
  e: [['fa-chart-pie', '#0b6fcc', 'หน้าแรกผู้บริหาร', 'ปฏิทินและภาพรวมการส่งงานของบุคลากร'], ['fa-chart-column', '#16a34a', 'สรุปการส่งงาน', 'ดูว่าใครส่งงานอะไรแล้วบ้าง แยกตามงาน'], ['fa-bell', '#f59e0b', 'กระดิ่งแจ้งเตือน', 'คำสั่งและอัลบั้มรูปภาพใหม่'], ['fa-book-open', '#7c3aed', 'คู่มือการใช้งาน', 'ปุ่มรูปหนังสือ มุมขวาบน มีภาพประกอบทุกขั้นตอน']]
};
function openWelcome() {
  if (_welcomeOpen || document.getElementById('welcomeModal')) return;
  var s = getSession(); if (!s) return;
  var role = s.role === 'executive' ? 'e' : (s.role === 'admin' && s.hasHub ? 's' : 't');
  if (s.role === 'admin' && !s.hasHub) return;
  _welcomeOpen = true;
  var site = (cachedBrand() && cachedBrand().siteName) || 'BNKAcademicHub';
  var el = document.createElement('div');
  el.className = 'modal-backdrop'; el.id = 'welcomeModal'; el.hidden = true;
  el.innerHTML = '<div class="modal-box wl-box" role="dialog" aria-modal="true" aria-labelledby="welcomeTitle">' +
    '<button type="button" class="modal-close-x" id="welcomeX" aria-label="ปิด">✕</button>' +
    '<div class="wl-hd"><h3 id="welcomeTitle">ยินดีต้อนรับ, ' + escapeHtml(s.name || '') + '</h3><p>' + escapeHtml(site) + ' — รู้ 4 อย่างนี้ก็ใช้งานได้เลย</p></div>' +
    '<div class="wl-bd">' + WELCOME_ITEMS[role].map(function (x) {
      return '<div class="wl-it"><span class="wl-ic" style="background:' + x[1] + '"><i class="fa-solid ' + x[0] + '" aria-hidden="true"></i></span><span><b>' + escapeHtml(x[2]) + '</b><small>' + escapeHtml(x[3]) + '</small></span></div>';
    }).join('') + '</div>' +
    '<div class="wl-ft"><small>แสดงครั้งเดียว · เปิดดูอีกได้ในคู่มือ</small><span class="wl-btns"><button type="button" class="btn btn-secondary" id="welcomeManual"><i class="fa-solid fa-book-open" aria-hidden="true"></i> เปิดคู่มือ</button><button type="button" class="btn btn-success" id="welcomeGo">เริ่มใช้งาน</button></span></div></div>';
  document.body.appendChild(el);
  function done(thenManual) {
    hideModalEl(el);
    setTimeout(function () { el.remove(); _welcomeOpen = false; }, 250);
    apiCall('welcomeSeen', {}).catch(function () { /* ครั้งหน้าแสดงอีก */ });
    if (thenManual) openManual('start');
  }
  el.querySelector('#welcomeX').addEventListener('click', function () { done(false); });
  el.querySelector('#welcomeGo').addEventListener('click', function () { done(false); });
  el.querySelector('#welcomeManual').addEventListener('click', function () { done(true); });
  showModalEl(el);
}

// ---------- 1.85: ประกาศแบบป็อปอัป — เปิดหน้าแรกแล้วเด้งทีละประกาศ (หลังป็อปอัปต้อนรับ) ----------
// 'until' = ขึ้นทุกครั้งที่เข้าระบบจนกว่าจะติ๊ก "ไม่ต้องแสดงประกาศนี้อีก" (เข้าระบบครั้งเดียวกันในแท็บเดิมไม่ขึ้นซ้ำ — sessionStorage) · 'once' = ครั้งเดียวต่อคน
var _annPopRunning = false;
// 1.85.1: จำแยกตามการเข้าระบบแต่ละครั้งของแต่ละคน (uid + sv ใน token — เข้าระบบใหม่ sv เปลี่ยน) — ออกแล้วเข้าใหม่ / คนอื่นเข้าต่อในแท็บเดิม = แสดงอีก
function _annPopLoginKey() {
  try { var t = getToken() || '', b = t.split('.')[0].replace(/-/g, '+').replace(/_/g, '/'); var o = JSON.parse(decodeURIComponent(escape(atob(b + '==='.slice((b.length + 3) % 4))))); return (o.uid || '') + '.' + (o.sv || 0); } catch (e) { return ''; }
}
function _annPopShownKey(id) { return 'bnkah_annpop_' + _annPopLoginKey() + '_' + id; }
async function showAnnouncementPopups() {
  if (_annPopRunning) return;
  _annPopRunning = true;
  try {
    var r = await apiCall('hubAnnouncementPopups', {});
    var list = (r.items || []).filter(function (a) { try { return !sessionStorage.getItem(_annPopShownKey(a.id)); } catch (e) { return true; } });
    if (!list.length) return;
    // รอป็อปอัปต้อนรับ (ครั้งแรกของบัญชี) ปิดก่อน
    await new Promise(function (res) { var t0 = Date.now(); (function wait() { if (!_welcomeOpen && !document.getElementById('welcomeModal') && Date.now() - t0 > 900) res(); else setTimeout(wait, 300); })(); });
    for (var i = 0; i < list.length; i++) await _showAnnPopup(list[i], i, list.length);
  } catch (e) { /* ไม่มีป็อปอัป / Worker รุ่นเก่า — ข้าม */ }
  finally { _annPopRunning = false; }
}
function _showAnnPopup(a, i, n) {
  return new Promise(function (resolve) {
    var from = a.department ? groupLabel(a.department) : 'โรงเรียน';
    var el = document.createElement('div');
    el.className = 'modal-backdrop'; el.id = 'annPopupModal'; el.hidden = true;
    el.innerHTML = '<div class="modal-box annp-box" role="dialog" aria-modal="true" aria-labelledby="annpTitle">' +
      '<button type="button" class="modal-close-x" data-annp="close" aria-label="ปิด">✕</button>' +
      '<div class="annp-hd"><small><i class="fa-solid fa-bullhorn" aria-hidden="true"></i> ประกาศจาก' + escapeHtml(from) + ' · ' + escapeHtml(formatDateThai(a.createdAt)) + (n > 1 ? '<span class="annp-n">' + (i + 1) + ' / ' + n + '</span>' : '') + '</small><h3 id="annpTitle">' + escapeHtml(a.title) + '</h3></div>' +
      '<div class="annp-bd">' + (a.message ? escapeHtml(a.message) : '') + (a.image ? '<img src="' + a.image + '" alt="" />' : '') + '</div>' +
      '<div class="annp-ft">' + (a.popup === 'until' ? '<label class="annp-ck"><input type="checkbox" id="annpNever" /> ไม่ต้องแสดงประกาศนี้อีก</label>' : '<span></span>') +
      '<button type="button" class="btn btn-success" data-annp="ok">รับทราบ' + (i < n - 1 ? ' <i class="fa-solid fa-arrow-right" aria-hidden="true"></i>' : '') + '</button></div></div>';
    document.body.appendChild(el);
    function done() {
      var never = !!(el.querySelector('#annpNever') && el.querySelector('#annpNever').checked);
      try { sessionStorage.setItem(_annPopShownKey(a.id), '1'); } catch (e) { /* ข้าม */ }
      apiCall('hubAnnouncementPopupAck', { id: a.id, dismiss: never }).catch(function () { /* ข้าม */ });
      hideModalEl(el);
      setTimeout(function () { el.remove(); resolve(); }, 260);
    }
    el.addEventListener('click', function (e) { if (e.target.closest('[data-annp]')) done(); });
    showModalEl(el);
  });
}

// ---------- คู่มือการใช้งาน (1.76) — โหลด assets/manual.js เมื่อกดปุ่มครั้งแรก ----------
var _manualLoading = null;
function openManual(topicId) {
  if (typeof manualOpen === 'function') { manualOpen(topicId); return; }
  if (!_manualLoading) {
    _manualLoading = new Promise(function (resolve, reject) {
      var sc = document.createElement('script');
      sc.src = 'assets/manual.js?v=' + APP_VERSION;
      sc.onload = resolve;
      sc.onerror = function () { _manualLoading = null; reject(new Error('โหลดคู่มือไม่สำเร็จ — ตรวจสอบอินเทอร์เน็ตแล้วลองใหม่')); };
      document.head.appendChild(sc);
    });
  }
  _manualLoading.then(function () { manualOpen(topicId); }).catch(function (e) { showToast(e.message, true); });
}
function openReportModal(opts) {
  opts = opts || {};
  if (!_reportModal) {
    var el = document.createElement('div');
    el.className = 'modal-backdrop'; el.id = 'reportModal'; el.hidden = true;
    el.innerHTML = '<div class="modal-box modal-box-wide rp-box" role="dialog" aria-modal="true" aria-labelledby="reportModalTitle">' +
      '<button type="button" class="modal-close-x" id="reportModalX" aria-label="ปิด">✕</button>' +
      '<h3 id="reportModalTitle"><i class="fa-solid fa-headset" aria-hidden="true"></i> แจ้งปัญหา</h3>' +
      '<div class="rp-tabs" role="tablist"><button type="button" role="tab" data-rptab="new" class="on">แจ้งเรื่องใหม่</button><button type="button" role="tab" data-rptab="mine">เรื่องที่ฉันแจ้ง</button></div>' +
      '<div class="rp-body" id="reportModalBody"></div>' +
      '<div class="modal-actions" id="reportModalActions"></div></div>';
    document.body.appendChild(el);
    _reportModal = { el: el, tab: 'new', step: 1, target: null, files: [], meta: null, mine: null, open: '' };
    el.querySelector('#reportModalX').addEventListener('click', closeReportModal);
    el.querySelector('.rp-tabs').addEventListener('click', function (e) { var b = e.target.closest('[data-rptab]'); if (b) { _reportModal.tab = b.getAttribute('data-rptab'); renderReportModal(); } });
    el.addEventListener('click', onReportModalClick);
    el.addEventListener('change', onReportModalChange);
  }
  var st = _reportModal;
  st.tab = opts.tab || 'new';
  if (st.tab === 'new' && (st.step !== 2 || !opts.keep)) { st.step = 1; st.target = null; st.files = []; st.subject = ''; st.body = ''; }
  if (opts.focus) st.open = opts.focus;
  if (st.tab === 'mine') st.mine = null;
  showModalEl(st.el);
  renderReportModal();
}
function closeReportModal() { if (_reportModal) hideModalEl(_reportModal.el); }
async function renderReportModal() {
  var st = _reportModal, body = st.el.querySelector('#reportModalBody'), act = st.el.querySelector('#reportModalActions');
  st.el.querySelectorAll('[data-rptab]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-rptab') === st.tab); });
  if (st.tab === 'new') {
    if (!st.meta) {
      body.innerHTML = '<div class="loading">กำลังโหลด</div>'; act.innerHTML = '';
      try { st.meta = await apiCall('reportMeta', {}); } catch (e) { body.innerHTML = '<div class="error-box">' + escapeHtml(e.message) + '</div>'; return; }
    }
    if (st.step === 1) {
      var m = st.meta, h = '<div class="rp-q">ปัญหาเกี่ยวกับอะไร</div>';
      if (m.canSystem) h += '<button type="button" class="rp-sys-card" data-rp-target="system"><span class="rp-ic"><i class="fa-solid fa-laptop-code" aria-hidden="true"></i></span><span><b>การใช้งานระบบ (เว็บมีปัญหา)</b><small>อัปโหลดไม่ได้ · หน้าค้าง/ขึ้นข้อผิดพลาด · ปุ่มกดไม่ทำงาน → ส่งถึงผู้ดูแลระบบ</small></span><i class="fa-solid fa-chevron-right rp-go" aria-hidden="true"></i></button>' +
        '<div class="rp-sep">หรือ เรื่องของกลุ่มบริหารงาน → ส่งถึงเจ้าหน้าที่กลุ่มนั้น</div>';
      h += '<div class="rp-groups">' + m.departments.map(function (d) {
        return '<button type="button" class="rp-group" data-rp-target="dept" data-rp-dept="' + escapeHtml(d.name) + '"' + deptColorAttr(d.name) + '><span class="rp-ic"><i class="fa-solid fa-user-group" aria-hidden="true"></i></span><span><b>' + escapeHtml(d.label) + '</b>' + (d.hint ? '<small>' + escapeHtml(d.hint) + '</small>' : '') + '</span></button>';
      }).join('') + '</div>';
      body.innerHTML = h;
      act.innerHTML = '<button type="button" class="btn btn-close" data-rp-act="close">ปิด</button>';
      return;
    }
    var t = st.target, info = reportClientInfo();
    body.innerHTML = '<div class="rp-to"' + (t.target === 'dept' ? deptColorAttr(t.department) : '') + '><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> ส่งถึง <b>' + escapeHtml(t.target === 'system' ? 'ผู้ดูแลระบบ (การใช้งานระบบ)' : 'เจ้าหน้าที่' + groupLabel(t.department)) + '</b><button type="button" class="rp-change" data-rp-act="back">เปลี่ยน</button></div>' +
      '<label class="rp-l" for="rpSubject">หัวข้อ</label><input type="text" id="rpSubject" maxlength="150" placeholder="' + (t.target === 'system' ? 'เช่น อัปโหลดไฟล์ PowerPoint ไม่ได้' : 'เช่น เกียรติบัตรอบรมไม่ครบ') + '" value="' + escapeHtml(st.subject || '') + '" />' +
      '<label class="rp-l" for="rpBody">รายละเอียดปัญหา</label><textarea id="rpBody" rows="5" maxlength="3000" placeholder="เล่าสิ่งที่เกิดขึ้น · ต้องการให้แก้ไขอะไร">' + escapeHtml(st.body || '') + '</textarea>' +
      '<div class="rp-l">แนบภาพหน้าจอ <span class="rp-hint">(ไม่บังคับ · สูงสุด ' + (st.meta.maxFiles || 3) + ' รูป)</span></div>' +
      '<div class="rp-att">' + st.files.map(function (f, i) { return '<span class="rp-thumb"><img src="' + f.url + '" alt="" /><button type="button" data-rp-rm="' + i + '" aria-label="เอารูปออก">✕</button></span>'; }).join('') +
        (st.files.length < (st.meta.maxFiles || 3) ? '<label class="rp-add" title="เพิ่มรูป"><i class="fa-solid fa-plus" aria-hidden="true"></i><input type="file" id="rpFiles" accept="image/*" multiple hidden /></label>' : '') + '</div>' +
      '<div class="rp-auto"><i class="fa-solid fa-circle-info" aria-hidden="true"></i> ระบบแนบให้อัตโนมัติ: หน้า <b>' + escapeHtml(info.page) + '</b> · ' + escapeHtml(info.ua) + '</div>' +
      '<div class="error-box" id="rpErr" hidden></div>';
    act.innerHTML = '<button type="button" class="btn btn-close" data-rp-act="close">ยกเลิก</button><button type="button" class="btn btn-primary" data-rp-act="send"><i class="fa-solid fa-paper-plane" aria-hidden="true"></i> ส่งเรื่อง</button>';
    ['rpSubject', 'rpBody'].forEach(function (id) { document.getElementById(id).addEventListener('input', function (e) { st[id === 'rpSubject' ? 'subject' : 'body'] = e.target.value; }); });
    return;
  }
  // เรื่องที่ฉันแจ้ง
  act.innerHTML = '<button type="button" class="btn btn-close" data-rp-act="close">ปิด</button>';
  if (!st.mine) {
    body.innerHTML = '<div class="loading">กำลังโหลด</div>';
    try { st.mine = (await apiCall('reportListMine', {})).items || []; } catch (e) { body.innerHTML = '<div class="error-box">' + escapeHtml(e.message) + '</div>'; return; }
  }
  if (!st.mine.length) { body.innerHTML = '<div class="empty-state">ยังไม่เคยแจ้งเรื่อง</div>'; return; }
  body.innerHTML = '<div class="rp-mine">' + st.mine.map(function (r) {
    var open = st.open === r.id;
    return '<div class="rp-item' + (open ? ' open' : '') + '" data-rp-id="' + escapeHtml(r.id) + '"><button type="button" class="rp-item-h" data-rp-toggle="' + escapeHtml(r.id) + '"><b>' + escapeHtml(r.subject) + '</b>' + reportStatusChip(r.status) + '</button>' +
      '<div class="rp-item-m">' + reportTargetChip(r) + ' · แจ้งเมื่อ ' + escapeHtml(formatDateTimeThai(r.createdAt)) + '</div>' +
      (open ? '<div class="rp-thread">' + reportFilesHtml(r.files) + reportThreadHtml(r.messages) +
        '<div class="rp-reply"><textarea rows="2" maxlength="3000" placeholder="ตอบกลับ..." data-rp-replytext="' + escapeHtml(r.id) + '"></textarea><button type="button" class="btn btn-primary btn-sm" data-rp-reply="' + escapeHtml(r.id) + '"><i class="fa-solid fa-reply" aria-hidden="true"></i> ส่ง</button></div></div>' : '') +
      '</div>';
  }).join('') + '</div>';
  var foc = st.open && body.querySelector('[data-rp-id="' + st.open + '"]');
  if (foc) foc.scrollIntoView({ block: 'nearest' });
}
async function onReportModalClick(e) {
  var st = _reportModal, b;
  if ((b = e.target.closest('[data-rp-target]'))) {
    st.target = { target: b.getAttribute('data-rp-target'), department: b.getAttribute('data-rp-dept') || '' };
    st.step = 2; renderReportModal(); setTimeout(function () { var i = document.getElementById('rpSubject'); if (i) i.focus(); }, 50); return;
  }
  if ((b = e.target.closest('[data-rp-rm]'))) { st.files.splice(Number(b.getAttribute('data-rp-rm')), 1); renderReportModal(); return; }
  if ((b = e.target.closest('[data-rp-toggle]'))) { var id = b.getAttribute('data-rp-toggle'); st.open = st.open === id ? '' : id; renderReportModal(); return; }
  if ((b = e.target.closest('[data-rp-img]'))) {
    var item = e.target.closest('[data-rp-id]'), rep = item && st.mine.filter(function (x) { return x.id === item.getAttribute('data-rp-id'); })[0];
    if (rep) openReportImages(rep.files, Number(b.getAttribute('data-rp-img'))); return;
  }
  if ((b = e.target.closest('[data-rp-reply]'))) {
    var rid = b.getAttribute('data-rp-reply'), ta = st.el.querySelector('[data-rp-replytext="' + rid + '"]');
    if (!ta || !ta.value.trim()) { if (ta) ta.focus(); return; }
    b.disabled = true;
    try { await apiCall('reportReply', { id: rid, body: ta.value }); st.mine = null; st.open = rid; renderReportModal(); showToast('ส่งข้อความแล้ว'); }
    catch (err) { showToast(err.message, true); b.disabled = false; }
    return;
  }
  if (!(b = e.target.closest('[data-rp-act]'))) return;
  var a = b.getAttribute('data-rp-act');
  if (a === 'close') { closeReportModal(); return; }
  if (a === 'back') { st.step = 1; renderReportModal(); return; }
  if (a === 'send') {
    var err = document.getElementById('rpErr'); err.hidden = true;
    var subject = (st.subject || '').trim(), text = (st.body || '').trim();
    if (!subject) { err.textContent = 'กรุณากรอกหัวข้อ'; err.hidden = false; document.getElementById('rpSubject').focus(); return; }
    if (!text) { err.textContent = 'กรุณากรอกรายละเอียดปัญหา'; err.hidden = false; document.getElementById('rpBody').focus(); return; }
    var info = reportClientInfo();
    var sentFiles = {}; // 1.85: กด "ส่งใหม่" ไม่อัปรูปที่ส่งสำเร็จแล้วซ้ำ
    var r = await withProgress('กำลังส่งเรื่อง', async function () {
      var files = [];
      for (var i = 0; i < st.files.length; i++) {
        if (sentFiles[i]) { files.push(sentFiles[i]); continue; }
        var f = st.files[i].file;
        var prep = await apiCall('reportFilePrepare', { fileName: f.name, mimeType: f.type, fileSize: f.size });
        var res = await fetch(prep.relayUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ uploadToken: prep.uploadToken, base64: await fileToBase64(f), filename: 'แจ้งปัญหา-' + Date.now() + '-' + (i + 1) + '.' + ((/\.(\w+)$/.exec(f.name) || [0, 'png'])[1]), mimeType: f.type }) });
        var j = JSON.parse(await res.text());
        if (!j.ok) throw new Error(j.error || 'อัปโหลดรูปไม่สำเร็จ');
        sentFiles[i] = { fileId: j.data.fileId, name: f.name };
        files.push(sentFiles[i]);
      }
      return apiCall('reportCreate', { target: st.target.target, department: st.target.department, subject: subject, body: text, page: info.page, ua: info.ua, files: files });
    }, { successLabel: 'ส่งเรื่องเรียบร้อยแล้ว', retry: st.files.length > 0 });
    if (r.ok) { st.step = 1; st.files = []; st.subject = ''; st.body = ''; st.tab = 'mine'; st.mine = null; st.open = r.data && r.data.id; renderReportModal(); }
  }
}
function onReportModalChange(e) {
  if (e.target.id !== 'rpFiles') return;
  var st = _reportModal, max = (st.meta && st.meta.maxFiles) || 3;
  Array.from(e.target.files || []).forEach(function (f) {
    if (st.files.length >= max) return;
    if (!/^image\//.test(f.type)) { showToast('แนบได้เฉพาะไฟล์รูปภาพ', true); return; }
    if (f.size > 8 * 1024 * 1024) { showToast('รูป ' + f.name + ' ใหญ่เกิน 8MB', true); return; }
    st.files.push({ file: f, url: URL.createObjectURL(f) });
  });
  renderReportModal();
}


// ======================================================================
// 1.92.1: ตารางสอนรายสัปดาห์ — ปุ่ม "ตารางสอนของฉัน" ในหน้าแรก (1.92.2: ย้ายจากแถบด้านบน ใต้ปุ่มหน้าผลงานของฉัน) → ป็อปอัปแบบใบตารางของโรงเรียน (ข้อมูลจากเว็บเช็คชื่อ BNKSA)
// ช่องกิจกรรมประจำของโรงเรียน (คาบ 7 อ./พ./พฤ.) แสดงให้ทุกคน ถ้ามีวิชาในช่องนั้น วิชาทับ
// ======================================================================
var TT_TIMES = { 1: '08.30–09.20', 2: '09.20–10.10', 3: '10.20–11.10', 4: '11.10–12.00', 5: '13.00–13.50', 6: '13.50–14.40', 7: '14.40–15.30', 8: '15.30–16.20' };
var TT_DAYS = ['จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.'];
var TT_FIXED = [{ day: 2, period: 7, label: 'ชุมนุม' }, { day: 3, period: 7, label: 'พัฒนาผู้เรียน' }, { day: 4, period: 7, label: 'คุณธรรมจริยธรรม' }];
var _tt = { data: null, view: 'me', loading: false };
function ttGradeCls(roomId) { var g = (/^m(\d)_/.exec(roomId || '') || [])[1]; return g ? 'g' + g : ''; }
function ttCellMap(slots) {
  var m = {};
  (slots || []).forEach(function (x) { if (x.period < 1 || x.period > 8 || x.day < 1 || x.day > 5) return; var k = x.day + '-' + x.period; (m[k] = m[k] || []).push(x); });
  return m;
}
function ttGridHtml(slots, mode) {
  var m = ttCellMap(slots);
  var h = '<table class="tt-grid' + (mode === 'room' ? ' room' : '') + '"><thead><tr><th class="tt-dh"></th>';
  for (var p = 1; p <= 8; p++) { h += '<th>' + p + '<small>' + TT_TIMES[p] + '</small></th>'; if (p === 4) h += '<th class="tt-lunch-h">พัก<small>12.00</small></th>'; }
  h += '</tr></thead><tbody>';
  for (var d = 1; d <= 5; d++) {
    h += '<tr><td class="tt-day">' + TT_DAYS[d - 1] + '</td>';
    for (var p2 = 1; p2 <= 8; p2++) {
      var xs = m[d + '-' + p2] || [], fx = TT_FIXED.filter(function (f) { return f.day === d && f.period === p2; })[0];
      if (xs.length) {
        var x = xs[0], sys = !!x.system;
        var top = sys ? x.subject : (x.code || x.subject), bottom = mode === 'room' ? (sys ? '' : (x.teachers || []).join(', ')) : x.room;
        h += '<td class="tt-c ' + (sys ? 'sys' : ttGradeCls(x.roomId)) + (xs.length > 1 ? ' clash' : '') + '" title="' + escapeHtml((x.subject || '') + (x.code ? ' (' + x.code + ')' : '') + ' · ' + x.room + ((x.teachers || []).length ? ' · ' + x.teachers.join(', ') : '') + (xs.length > 1 ? ' · ซ้อน ' + xs.length + ' รายการ' : '')) + '">' +
          '<div class="tt-in"><b>' + escapeHtml(top) + '</b>' + (!sys && x.code && x.subject && x.subject !== x.code ? '<i>' + escapeHtml(x.subject) + '</i>' : '') + (bottom ? '<span>' + escapeHtml(bottom) + '</span>' : '') + '</div>' + (xs.length > 1 ? '<em>+' + (xs.length - 1) + '</em>' : '') + '</td>'; // 1.96: + ชื่อวิชา · ย่อตัวอักษรให้พอดีช่อง (ttShrink)
      } else if (fx) h += '<td class="tt-c fixed"><div class="tt-in"><b>' + escapeHtml(fx.label) + '</b></div></td>';
      else h += '<td></td>';
      if (p2 === 4) h += d === 1 ? '<td class="tt-lunch" rowspan="5">พักเที่ยง</td>' : '';
    }
    h += '</tr>';
  }
  return h + '</tbody></table>';
}
// 1.96: ย่อตัวอักษรในช่องตารางสอนที่ข้อความยาวเกินช่อง (ทีละ 6% ต่ำสุด 55%) — ใช้ทั้งบนจอ ตอนพิมพ์ และบันทึกเป็นรูป
function ttShrink(root) {
  Array.prototype.forEach.call((root || document).querySelectorAll('.tt-in'), function (el) {
    el.style.fontSize = ''; if (!el.clientWidth) return;
    for (var k = 1; k > 0.55 && (el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1); k -= 0.06) el.style.fontSize = (k - 0.06).toFixed(2) + 'em';
  });
}
function ttStats(slots) {
  var cls = (slots || []).filter(function (x) { return !x.system && x.period >= 1 && x.period <= 8; });
  var rooms = {}, subs = {}; cls.forEach(function (x) { rooms[x.roomId] = 1; subs[x.code || x.subject] = 1; });
  return 'รวม ' + cls.length + ' คาบ/สัปดาห์ · สอน ' + Object.keys(rooms).length + ' ห้อง · ' + Object.keys(subs).length + ' รายวิชา';
}
function ttCurrent() {
  var d = _tt.data; if (!d) return null;
  if (_tt.view === 'me') return { title: (d.teacherName || session.name) + ' · ภาคเรียนที่ ' + d.term + '/' + d.year, slots: d.slots, mode: 'me', foot: ttStats(d.slots) };
  var r = (d.rooms || []).filter(function (x) { return x.roomId === _tt.view; })[0];
  return r ? { title: 'ชั้น ' + r.roomName + ' · ภาคเรียนที่ ' + d.term + '/' + d.year, slots: r.slots, mode: 'room', foot: 'ตารางเรียนของห้อง (ครูที่ปรึกษา)' } : null;
}
function ttRender() {
  var body = document.getElementById('ttBody'), seg = document.getElementById('ttSeg'), pr = document.getElementById('ttPrint'), im = document.getElementById('ttImg');
  if (!body) return;
  var d = _tt.data;
  if (_tt.loading) { body.innerHTML = '<div class="loading">กำลังดึงตารางสอนจากเว็บเช็คชื่อ</div>'; seg.innerHTML = ''; pr.disabled = true; if (im) im.disabled = true; return; }
  if (!d) return;
  if (!d.linked) {
    seg.innerHTML = ''; pr.disabled = true; if (im) im.disabled = true;
    body.innerHTML = '<div class="empty-state">' + escapeHtml(d.reason || 'ยังไม่พบชื่อของคุณในเว็บเช็คชื่อ — ให้ผู้ดูแลเว็บเช็คชื่อผูกรายชื่อครูกับ AcademicHub ก่อน') + '</div>';
    return;
  }
  seg.innerHTML = (d.rooms || []).length ? '<button type="button" data-ttv="me" class="' + (_tt.view === 'me' ? 'on' : '') + '">ตารางสอนของฉัน</button>' + d.rooms.map(function (r) { return '<button type="button" data-ttv="' + escapeHtml(r.roomId) + '" class="' + (_tt.view === r.roomId ? 'on' : '') + '">ห้อง ' + escapeHtml(r.roomName) + ' (ที่ปรึกษา)</button>'; }).join('') : '';
  var c = ttCurrent(); pr.disabled = !c; if (im) im.disabled = !c;
  body.innerHTML = c ? '<div class="tt-sheet" id="ttSheet"><div class="tt-ttl">' + escapeHtml(c.title) + '</div>' + ttGridHtml(c.slots, c.mode) + '</div>' +
    '<div class="tt-foot"><span>' + escapeHtml(c.foot) + '</span><span>ข้อมูลจากเว็บเช็คชื่อ' + (c.slots && c.slots.length ? '' : ' — ยังไม่มีคาบสอนในภาคเรียนนี้') + '</span></div>' : '';
  if (c) setTimeout(function () { ttShrink(body); }, 30); // 1.96
}
// 1.93.1: พิมพ์ / PDF = A4 แนวนอน 1 หน้าเสมอ (ย่อให้พอดีหน้า) · บันทึกเป็นรูป PNG (ภาพเดียวกับหน้าที่พิมพ์)
// ใช้เอกสารแยก (หน้าต่างใหม่ / iframe ซ่อน) ธีมสว่างเสมอ — ไม่ขึ้นกับโหมดมืดของหน้าเว็บ
var TT_PAGE_W = 1062, TT_PAGE_H = 733; // A4 แนวนอน 297×210 มม. − ขอบ 8 มม. (96 dpi)
function ttSheetDoc(mode) {
  var sh = document.getElementById('ttSheet'); if (!sh) return '';
  var base = location.href.replace(/[^/]*([?#].*)?$/, '');
  var styles = Array.prototype.map.call(document.querySelectorAll('link[rel="stylesheet"]'), function (l) { return '<link rel="stylesheet" href="' + l.href + '">'; }).join('');
  var themeVars = document.getElementById('bnkahThemeVars');
  var c = ttCurrent(), stamp = 'พิมพ์เมื่อ ' + formatDateThai(todayYmd()) + ' · ' + (c ? c.foot : '');
  return '<!doctype html><html lang="th" data-theme="light"><head><meta charset="utf-8"><base href="' + base + '"><title>ตารางสอน</title>' + styles +
    (themeVars ? '<style>' + themeVars.textContent + '</style>' : '') +
    '<style>@page{size:A4 landscape;margin:8mm}html,body{margin:0;background:#fff}*{-webkit-print-color-adjust:exact;print-color-adjust:exact}' +
    '.pg{width:' + TT_PAGE_W + 'px;height:' + TT_PAGE_H + 'px;overflow:hidden;background:#fff;box-sizing:border-box}' +
    '.fit{width:1120px;transform-origin:top left;padding:6px}.tt-sheet{overflow:visible;border-color:#0f172a;animation:none}table.tt-grid{min-width:0}' +
    '.tt-stamp{display:flex;justify-content:space-between;font-size:12px;color:#475569;margin-top:6px;padding:0 4px}' +
    (mode === 'image' ? '.pg{height:auto}' : '') + '</style></head><body><div class="pg" id="pg"><div class="fit" id="fit">' + sh.outerHTML +
    '<div class="tt-stamp"><span>' + escapeHtml(stamp) + '</span><span>BNKAcademicHub · ข้อมูลจากเว็บเช็คชื่อ</span></div></div></div>' +
    '<script>' + ttShrink.toString() + 'function ttFit(){ttShrink(document);var f=document.getElementById("fit");f.style.transform="none";' +
    // พิมพ์: ขยายความสูงแถวให้ตารางเต็มหน้า A4 (ไม่เหลือที่ว่างครึ่งหน้า) แล้วย่อทั้งใบให้พอดี 1 หน้า
    (mode === 'print' ? 'var sw=' + TT_PAGE_W + '/f.scrollWidth,need=' + TT_PAGE_H + '/Math.min(sw,1)-f.scrollHeight-4;if(need>0){var rows=f.querySelectorAll("table.tt-grid tbody tr");var add=Math.floor(need/rows.length),hs=Array.prototype.map.call(rows,function(r){return r.getBoundingClientRect().height;});Array.prototype.forEach.call(rows,function(r,i){r.style.height=(hs[i]+add)+"px";Array.prototype.forEach.call(r.children,function(td){if(!td.classList.contains("tt-lunch"))td.style.height="auto";});});}' : '') +
    'var s=Math.min(' + TT_PAGE_W + '/f.scrollWidth,' + TT_PAGE_H + '/f.scrollHeight,1);f.style.transform="scale("+s+")";' +
    (mode === 'image' ? 'var pg=document.getElementById("pg");pg.style.width=Math.ceil(f.scrollWidth*s)+"px";pg.style.height=Math.ceil(f.scrollHeight*s)+"px";' : '') + 'return s;}<\/script></body></html>';
}
function ttReady(win) {
  return new Promise(function (res) {
    var go = function () { (win.document.fonts && win.document.fonts.ready ? win.document.fonts.ready : Promise.resolve()).then(function () { setTimeout(function () { try { win.ttFit(); } catch (e) { /* ข้าม */ } res(); }, 150); }); };
    if (win.document.readyState === 'complete') go(); else win.addEventListener('load', go);
  });
}
// 1.96.1: ดาวน์โหลด PDF ทันที (A4 แนวนอน 1 หน้า) — ไม่เปิดหน้าตัวอย่าง/หน้าพิมพ์
async function ttPrint() {
  var html = ttSheetDoc('print'); if (!html) return;
  var b = document.getElementById('ttPrint'); if (b) b.disabled = true;
  var fr = document.createElement('iframe');
  fr.setAttribute('aria-hidden', 'true');
  fr.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + (TT_PAGE_W + 40) + 'px;height:' + (TT_PAGE_H + 400) + 'px;border:0;';
  document.body.appendChild(fr);
  try {
    var d = fr.contentWindow.document; d.open(); d.write(html); d.close();
    await ttReady(fr.contentWindow);
    await loadScriptOnce('assets/html2canvas.min.js'); await loadScriptOnce('assets/jspdf.umd.min.js');
    var canvas = await html2canvas(d.getElementById('pg'), { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true, windowWidth: TT_PAGE_W + 40 });
    var pdf = new window.jspdf.jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4', compress: true });
    var w = 297 - 16, h = w * canvas.height / canvas.width; if (h > 210 - 16) { h = 210 - 16; w = h * canvas.width / canvas.height; }
    pdf.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', (297 - w) / 2, 8, w, h);
    var name = 'timetable-' + (_tt.view === 'me' ? 'teacher' : 'room-' + String(_tt.view).replace(/[^\w-]/g, '')) + '-' + (_tt.data ? _tt.data.term + '-' + _tt.data.year : '') + '.pdf';
    downloadBlob(pdf.output('blob'), name);
    showToast('ดาวน์โหลดไฟล์ PDF แล้ว');
  } catch (err) { showToast('สร้างไฟล์ PDF ไม่สำเร็จ: ' + err.message, true); }
  finally { fr.remove(); if (b) b.disabled = false; }
}
async function ttSaveImage() {
  var html = ttSheetDoc('image'); if (!html) return;
  var b = document.getElementById('ttImg'); if (b) b.disabled = true;
  var fr = document.createElement('iframe');
  fr.setAttribute('aria-hidden', 'true');
  fr.style.cssText = 'position:fixed;left:-20000px;top:0;width:' + (TT_PAGE_W + 40) + 'px;height:' + (TT_PAGE_H + 400) + 'px;border:0;';
  document.body.appendChild(fr);
  try {
    var d = fr.contentWindow.document; d.open(); d.write(html); d.close();
    await ttReady(fr.contentWindow);
    await loadScriptOnce('assets/html2canvas.min.js');
    var pg = d.getElementById('pg');
    var canvas = await html2canvas(pg, { scale: 2, backgroundColor: '#ffffff', logging: false, useCORS: true, windowWidth: TT_PAGE_W + 40 });
    var c = ttCurrent();
    var name = 'timetable-' + (_tt.view === 'me' ? 'teacher' : 'room-' + String(_tt.view).replace(/[^\w-]/g, '')) + '-' + (_tt.data ? _tt.data.term + '-' + _tt.data.year : '') + '.png';
    var a = document.createElement('a'); a.href = canvas.toDataURL('image/png'); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    showToast('บันทึกรูปตารางสอนแล้ว' + (c ? ' (' + c.title + ')' : ''));
  } catch (err) { showToast('บันทึกรูปไม่สำเร็จ: ' + err.message, true); }
  finally { fr.remove(); if (b) b.disabled = false; }
}
function initTimetable() {
  var btn = document.getElementById('ttOpenBtn'); if (!btn) return;
  var wrap = document.createElement('div');
  wrap.innerHTML = '<div class="modal-backdrop" id="ttModal" hidden><div class="modal-box modal-box-wide tt-box">' +
    '<button type="button" class="modal-close-x" id="ttCloseX" aria-label="ปิด">✕</button>' +
    '<div class="tt-head"><h3><i class="fa-solid fa-table-cells" aria-hidden="true"></i> ตารางสอน</h3><div class="tt-seg" id="ttSeg" role="tablist"></div>' +
    '<span class="tt-acts"><button type="button" class="btn btn-secondary btn-sm" id="ttImg"><i class="fa-solid fa-image ui-icon" aria-hidden="true"></i> บันทึกเป็นรูป</button>' +
    '<button type="button" class="btn btn-secondary btn-sm" id="ttPrint"><i class="fa-solid fa-file-pdf ui-icon" aria-hidden="true"></i> ดาวน์โหลด PDF</button></span></div>' +
    '<div id="ttBody"></div></div></div>';
  document.body.appendChild(wrap.firstChild);
  var modal = document.getElementById('ttModal');
  document.getElementById('ttCloseX').addEventListener('click', function () { hideModalEl(modal); });
  document.getElementById('ttPrint').addEventListener('click', ttPrint);
  document.getElementById('ttImg').addEventListener('click', ttSaveImage); // 1.93.1
  document.getElementById('ttSeg').addEventListener('click', function (e) { var b = e.target.closest('[data-ttv]'); if (!b) return; _tt.view = b.getAttribute('data-ttv'); ttRender(); });
  btn.addEventListener('click', async function () {
    announceMenuOpen('tt');
    showModalEl(modal);
    if (_tt.data && Date.now() - (_tt.at || 0) < 5 * 60 * 1000) { ttRender(); return; }
    _tt.loading = true; ttRender();
    try { _tt.data = await apiCall('ttMine', {}); _tt.at = Date.now(); }
    catch (err) { _tt.data = { linked: false, reason: err.message }; }
    _tt.loading = false;
    if (_tt.view !== 'me' && !(_tt.data.rooms || []).some(function (r) { return r.roomId === _tt.view; })) _tt.view = 'me';
    ttRender();
  });
}

// ---------- 1.93: ตรวจรายคน (ประเภทงาน "แจ้งเตือน + เจ้าหน้าที่ตรวจรายคน") — ใช้ร่วมกันในหน้าประกาศและปฏิทิน / สรุปการส่งงาน ----------
// openManualCheck(eventId, { onSaved }) — เจ้าหน้าที่กลุ่มเจ้าของงาน/ผู้ดูแลระบบติ๊ก "ได้รับแล้ว" ทีละคน (หลายคนแล้วบันทึกครั้งเดียว) · ผู้บริหาร/หัวหน้ากลุ่มดูอย่างเดียว
var _mc = null;
function _mcEnsure() {
  var m = document.getElementById('mcModal');
  if (m) return m;
  var w = document.createElement('div');
  w.innerHTML = '<div class="modal-backdrop" id="mcModal" hidden><div class="modal-box modal-box-wide mc-box">' +
    '<button type="button" class="modal-close-x" id="mcX" aria-label="ปิด">✕</button>' +
    '<h3 id="mcTitle" class="mc-title"></h3><div class="mc-sub" id="mcSub"></div>' +
    '<div id="mcHead"></div><div id="mcList" class="mc-list"></div>' +
    '<div class="modal-actions mc-actions"><button type="button" class="btn btn-secondary" id="mcAll"><i class="fa-solid fa-check-double" aria-hidden="true"></i> ตรวจแล้วทุกคนในรายการ</button>' +
    '<span class="mc-gap"></span><button type="button" class="btn btn-ghost btn-close" id="mcClose">ปิด</button><button type="button" class="btn btn-success" id="mcSave"><i class="fa-solid fa-floppy-disk" aria-hidden="true"></i> <span id="mcSaveTx">บันทึก</span></button></div>' +
    '</div></div>';
  m = w.firstChild; document.body.appendChild(m);
  var close = async function () {
    if (_mc && _mcChanges().length && !(await askConfirm('ยังไม่ได้บันทึกการตรวจ ' + _mcChanges().length + ' คน ปิดโดยไม่บันทึก?', 'ปิดหน้าต่างตรวจรายคน'))) return;
    hideModalEl(m); _mc = null;
  };
  document.getElementById('mcX').addEventListener('click', close);
  document.getElementById('mcClose').addEventListener('click', close);
  document.getElementById('mcHead').addEventListener('click', function (e) {
    var b = e.target.closest('[data-mcf]'); if (!b || !_mc) return;
    _mc.filter = b.getAttribute('data-mcf'); _mc.keep = {}; _mcRenderHead(); _mcRenderList();
  });
  document.getElementById('mcHead').addEventListener('input', function (e) { if (e.target.id === 'mcQ' && _mc) { _mc.q = e.target.value; _mc.keep = {}; _mcRenderList(); } });
  document.getElementById('mcList').addEventListener('change', function (e) {
    // (1.95: เปลี่ยนเป็นปุ่ม ตรวจแล้ว / ส่งหลังกำหนด — ดู click ด้านล่าง)
  });
  document.getElementById('mcList').addEventListener('click', function (e) {
    var b = e.target.closest('[data-mcs]'); if (!b || !_mc || b.disabled) return;
    var uid = b.getAttribute('data-mcu'), v = b.getAttribute('data-mcs'), d = _mc.draft[uid];
    d.st = d.st === v ? '' : v; _mc.keep[uid] = 1; _mcRenderHead(); _mcRenderList(); // แถวที่เพิ่งกดยังอยู่จนกว่าจะเปลี่ยนตัวกรอง
  });
  document.getElementById('mcList').addEventListener('input', function (e) {
    var n = e.target.closest('[data-mcn]'); if (!n || !_mc) return;
    _mc.draft[n.getAttribute('data-mcn')].note = n.value; _mcSyncSave();
  });
  document.getElementById('mcAll').addEventListener('click', function () {
    if (!_mc) return;
    _mcVisible().forEach(function (r) { if (!_mc.draft[r.userId].st) _mc.draft[r.userId].st = 'received'; _mc.keep[r.userId] = 1; });
    _mcRenderHead(); _mcRenderList();
  });
  document.getElementById('mcSave').addEventListener('click', async function () {
    if (!_mc) return;
    var ch = _mcChanges(); if (!ch.length) { hideModalEl(m); _mc = null; return; }
    var cur = _mc;
    var r = await withProgress('กำลังบันทึกการตรวจ', function () { return apiCall('manualCheckSave', { eventId: cur.eventId, changes: ch }); }, { successLabel: 'บันทึกแล้ว' });
    if (!r.ok) return;
    hideModalEl(m); _mc = null;
    if (cur.onSaved) cur.onSaved();
  });
  return m;
}
function _mcVisible() {
  var q = String(_mc.q || '').replace(/\s+/g, '').toLowerCase();
  return _mc.rows.filter(function (r) {
    var d = _mc.draft[r.userId];
    if (_mc.keep[r.userId]) return true;
    if (_mc.filter === 'todo' && d.st) return false;
    if (_mc.filter === 'done' && d.st !== 'received') return false;
    if (_mc.filter === 'late' && d.st !== 'late') return false;
    if (_mc.filter === 'reported' && !(r.status === 'reported' && !d.st)) return false;
    return !q || (String(r.name) + String(r.subjectGroup || '')).replace(/\s+/g, '').toLowerCase().indexOf(q) !== -1;
  });
}
function _mcChanges() {
  if (!_mc) return [];
  return _mc.rows.filter(function (r) { var d = _mc.draft[r.userId]; return d.st !== _mcSt(r.status) || d.note.trim() !== (r.note || ''); })
    .map(function (r) { var d = _mc.draft[r.userId]; return { userId: r.userId, status: d.st, received: !!d.st, note: d.note.trim() }; });
}
function _mcSt(st) { return st === 'received' || st === 'late' ? st : ''; } // 1.95: received = ตรวจแล้ว · late = ส่งหลังกำหนด
function _mcSyncSave() {
  var n = _mcChanges().length;
  document.getElementById('mcSaveTx').textContent = n ? 'บันทึก (' + n + ' คน)' : 'บันทึก';
}
function _mcRenderHead() {
  var rows = _mc.rows, done = rows.filter(function (r) { return _mc.draft[r.userId].st; }).length;
  var late = rows.filter(function (r) { return _mc.draft[r.userId].st === 'late'; }).length;
  var rep = rows.filter(function (r) { return r.status === 'reported' && !_mc.draft[r.userId].st; }).length;
  var pct = rows.length ? Math.round(done / rows.length * 100) : 0;
  var seg = function (k, t) { return '<button type="button" data-mcf="' + k + '" class="' + (_mc.filter === k ? 'on' : '') + '">' + t + '</button>'; };
  var q = document.getElementById('mcQ'), keep = q ? q.value : (_mc.q || '');
  var had = q && document.activeElement === q;
  document.getElementById('mcHead').innerHTML =
    '<div class="mc-prog"><div class="mc-prog-t"><b>ตรวจแล้ว ' + done + ' / ' + rows.length + ' คน' + (late ? ' <span class="mc-late-n">(หลังกำหนด ' + late + ')</span>' : '') + '</b><span>' + pct + '%</span></div><div class="mc-bar"><i style="width:' + pct + '%"></i></div></div>' +
    '<div class="mc-tools"><div class="evk-seg mc-seg">' + seg('all', 'ทั้งหมด ' + rows.length) + seg('todo', 'ยังไม่ตรวจ ' + (rows.length - done)) + (_mc.selfReport || rep ? seg('reported', 'ครูแจ้งแล้ว ' + rep) : '') + seg('done', 'ตรวจแล้ว ' + (done - late)) + seg('late', 'ส่งหลังกำหนด ' + late) + '</div>' +
    '<input type="search" id="mcQ" class="mc-q" placeholder="ค้นหาชื่อครู / กลุ่มสาระ" aria-label="ค้นหาชื่อครู" value="' + escapeHtml(keep) + '" /></div>';
  if (had) { var nq = document.getElementById('mcQ'); nq.focus(); nq.setSelectionRange(nq.value.length, nq.value.length); }
  _mcSyncSave();
}
function _mcRenderList() {
  var list = _mcVisible(), ed = _mc.canEdit;
  var box = document.getElementById('mcList');
  if (!list.length) { box.innerHTML = '<div class="empty-state" style="padding:18px 4px;">' + (_mc.rows.length ? 'ไม่พบรายชื่อตามตัวกรอง' : 'ไม่มีครูในกลุ่มเป้าหมายของงานนี้') + '</div>'; return; }
  box.innerHTML = '<table class="mc-table"><thead><tr><th class="mc-c"></th><th>' + (_mc.rooms ? 'ห้อง' : 'ชื่อ') + '</th><th class="mc-sg">' + (_mc.rooms ? 'ครูที่ปรึกษา' : 'กลุ่มสาระ') + '</th><th>สถานะ</th><th>หมายเหตุ</th></tr></thead><tbody>' + list.map(function (r) {
    var d = _mc.draft[r.userId], was = _mcSt(r.status), when = '<small>' + escapeHtml(formatDateThai(String(r.checkedAt).slice(0, 10))) + (r.checkedBy ? ' · ' + escapeHtml(r.checkedBy) : '') + '</small>';
    var st = d.st
      ? (d.st === was ? (d.st === 'late' ? '<span class="mc-st late"><i class="fa-solid fa-clock" aria-hidden="true"></i> ส่งหลังกำหนด</span>' : '<span class="mc-st ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> ตรวจแล้ว</span>') + when
        : '<span class="mc-st new' + (d.st === 'late' ? ' late' : '') + '"><i class="fa-solid fa-' + (d.st === 'late' ? 'clock' : 'check') + '" aria-hidden="true"></i> ' + (d.st === 'late' ? 'ส่งหลังกำหนด' : 'ตรวจแล้ว') + ' (ยังไม่บันทึก)</span>')
      : (r.status === 'reported' ? '<span class="mc-st rep"><i class="fa-solid fa-hand" aria-hidden="true"></i> ครูแจ้งว่าส่งแล้ว</span><small>' + escapeHtml(formatDateThai(String(r.reportedAt).slice(0, 10))) + '</small>' : '<span class="mc-st no">ยังไม่ตรวจ</span>');
    var uid = escapeHtml(r.userId), nm = escapeHtml(r.name), dis = ed ? '' : ' disabled';
    return '<tr class="' + (d.st === 'late' ? 'is-late' : d.st ? 'is-ok' : '') + '"><td class="mc-c"><div class="mc-pick">' +
      '<button type="button" class="mc-pk ok' + (d.st === 'received' ? ' on' : '') + '" data-mcs="received" data-mcu="' + uid + '"' + dis + ' aria-pressed="' + (d.st === 'received') + '" title="ตรวจแล้ว" aria-label="ตรวจแล้ว: ' + nm + '"><i class="fa-solid fa-check" aria-hidden="true"></i></button>' +
      '<button type="button" class="mc-pk late' + (d.st === 'late' ? ' on' : '') + '" data-mcs="late" data-mcu="' + uid + '"' + dis + ' aria-pressed="' + (d.st === 'late') + '" title="ส่งหลังกำหนด" aria-label="ส่งหลังกำหนด: ' + nm + '"><i class="fa-solid fa-clock" aria-hidden="true"></i></button>' +
      '</div></td>' +
      '<td class="mc-name">' + escapeHtml(r.name) + (r.left ? ' <span class="mc-left">ย้ายออก</span>' : '') + '</td>' +
      '<td class="mc-sg">' + escapeHtml(r.subjectGroup ? (String(r.userId).indexOf('room:') === 0 ? r.subjectGroup : subjectShort(r.subjectGroup)) : '-') + '</td>' +
      '<td class="mc-stc">' + st + '</td>' +
      '<td class="mc-note">' + (ed ? '<input type="text" maxlength="300" data-mcn="' + escapeHtml(r.userId) + '" value="' + escapeHtml(d.note) + '" placeholder="—" aria-label="หมายเหตุ" />' : escapeHtml(d.note || '—')) + '</td></tr>';
  }).join('') + '</tbody></table>';
}
async function openManualCheck(eventId, opts) {
  opts = opts || {};
  var m = _mcEnsure();
  document.getElementById('mcTitle').innerHTML = '<i class="fa-solid fa-clipboard-check" aria-hidden="true"></i> ตรวจรายคน';
  document.getElementById('mcSub').textContent = 'กำลังโหลด…';
  document.getElementById('mcHead').innerHTML = ''; document.getElementById('mcList').innerHTML = '<div class="loading">กำลังโหลด</div>';
  showModalEl(m);
  try {
    var d = await apiCall('manualCheckList', { eventId: eventId });
    var ev = d.event, draft = {};
    d.rows.forEach(function (r) { draft[r.userId] = { st: _mcSt(r.status), note: r.note || '' }; });
    _mc = { rooms: !!ev.rooms, eventId: eventId, rows: d.rows, draft: draft, keep: {}, canEdit: !!d.canEdit, filter: 'all', q: '', selfReport: ev.selfReport, onSaved: opts.onSaved };
    document.getElementById('mcTitle').innerHTML = '<i class="fa-solid fa-clipboard-check" aria-hidden="true"></i> ' + (ev.rooms ? 'ตรวจรายห้อง' : 'ตรวจรายคน') + ': ' + escapeHtml(ev.title);
    var range = ev.endDate && ev.endDate !== ev.date ? formatDateThai(ev.date) + ' – ' + formatDateThai(ev.endDate) : formatDateThai(ev.date);
    document.getElementById('mcSub').textContent = 'กำหนดส่ง ' + range + ' · ' + (ev.semester === 'summer' ? 'ภาคฤดูร้อน' : 'ภาคเรียนที่ ' + ev.semester) + '/' + ev.academicYear + (ev.selfReport ? ' · ครูกดแจ้งว่าส่งแล้วได้' : '') + (d.canEdit ? '' : ' · ดูได้อย่างเดียว');
    document.getElementById('mcAll').hidden = !d.canEdit; document.getElementById('mcSave').hidden = !d.canEdit;
    _mcRenderHead(); _mcRenderList();
  } catch (err) {
    document.getElementById('mcSub').textContent = '';
    document.getElementById('mcList').innerHTML = '<div class="error-box">' + escapeHtml(err.message) + '</div>';
    document.getElementById('mcAll').hidden = true; document.getElementById('mcSave').hidden = true;
  }
}

// ---------- 1.93: ช่องผู้รับผิดชอบ (ปฏิทินโรงเรียน) — ข้อความ + เลือกรายชื่อครู ----------
// createResponsiblePicker(el, { users: fn, placeholder: fn }) → { get(), set(v), refresh() } · v = { text, users:[{id,name}] }
function createResponsiblePicker(el, opts) {
  opts = opts || {};
  var state = { text: '', users: [], open: false, q: '' };
  el.classList.add('rsp-pick');
  el.innerHTML = '<div class="rsp-row"><input type="text" class="rsp-text" maxlength="150" aria-label="ผู้รับผิดชอบ" /><button type="button" class="btn btn-secondary btn-sm rsp-tg"><i class="fa-solid fa-user-plus" aria-hidden="true"></i> เลือกรายชื่อครู</button></div>' +
    '<div class="rsp-sel"></div><div class="aud-people rsp-box" hidden><input type="search" class="aud-q" placeholder="ค้นหาชื่อ…" aria-label="ค้นหาชื่อ" /><div class="aud-list"></div></div>';
  var tx = el.querySelector('.rsp-text'), box = el.querySelector('.rsp-box'), sel = el.querySelector('.rsp-sel');
  function users() { return (typeof opts.users === 'function' ? opts.users() : opts.users) || []; }
  function render() {
    tx.placeholder = (typeof opts.placeholder === 'function' ? opts.placeholder() : opts.placeholder) || 'ว่าง = กลุ่มเจ้าของงาน';
    sel.innerHTML = state.users.map(function (u) { return '<span class="aud-chip">' + escapeHtml(u.name) + '<button type="button" data-rsp-rm="' + escapeHtml(u.id) + '" aria-label="เอาออก">✕</button></span>'; }).join('');
    box.hidden = !state.open;
    if (!state.open) return;
    var on = {}; state.users.forEach(function (u) { on[u.id] = 1; });
    var nq = state.q.replace(/\s+/g, '').toLowerCase();
    box.querySelector('.aud-list').innerHTML = users().filter(function (u) { return !nq || String(u.name).replace(/\s+/g, '').toLowerCase().indexOf(nq) !== -1; }).map(function (u) {
      return '<label class="aud-p"><input type="checkbox" data-rsp="' + escapeHtml(u.id) + '"' + (on[u.id] ? ' checked' : '') + ' /><span>' + escapeHtml(u.name) + '</span>' + (u.department ? '<small>' + escapeHtml(groupLabel(u.department)) + '</small>' : '') + '</label>';
    }).join('') || '<div class="hint" style="padding:8px">ไม่พบชื่อ</div>';
  }
  tx.addEventListener('input', function () { state.text = tx.value; });
  el.querySelector('.rsp-tg').addEventListener('click', function () { state.open = !state.open; render(); });
  box.querySelector('.aud-q').addEventListener('input', function () { state.q = this.value; render(); });
  box.addEventListener('change', function (e) {
    var c = e.target.closest('[data-rsp]'); if (!c) return;
    var id = c.getAttribute('data-rsp');
    if (c.checked) { var u = users().filter(function (x) { return x.id === id; })[0]; if (u && state.users.length < 30) state.users.push({ id: u.id, name: u.name }); }
    else state.users = state.users.filter(function (x) { return x.id !== id; });
    render();
  });
  sel.addEventListener('click', function (e) { var b = e.target.closest('[data-rsp-rm]'); if (!b) return; state.users = state.users.filter(function (x) { return x.id !== b.getAttribute('data-rsp-rm'); }); render(); });
  render();
  return {
    get: function () { return { text: state.text.trim(), users: state.users.slice() }; },
    set: function (v) { state.text = (v && v.text) || ''; state.users = (v && Array.isArray(v.users) ? v.users : []).slice(); state.open = false; state.q = ''; tx.value = state.text; box.querySelector('.aud-q').value = ''; render(); },
    refresh: render
  };
}
// ป้ายผู้รับผิดชอบ (ข้อความที่ตั้งไว้ ไม่งั้นกลุ่มเจ้าของงาน) — ใช้ในปฏิทินโรงเรียน
function responsibleText(e, catDept) {
  var r = e.responsible || null;
  if (r && r.text) return r.text;
  if (e.kind === 'activity' && e.attMode === 'holiday' && !e.ownerGroup) return 'วันหยุด'; // 1.96.4
  if (e.kind === 'activity') return e.ownerGroup ? (e.ownerType === 'subject' ? 'กลุ่มสาระการเรียนรู้' + e.ownerGroup : groupLabel(e.ownerGroup)) : '';
  return catDept ? groupLabel(catDept) : '';
}
// วันที่แสดงในปฏิทินโรงเรียนตาม calShow ('' = กำหนดส่งงาน → วันสุดท้าย · กิจกรรม → ช่วง)
function schoolCalSpan(e) {
  var mode = e.calShow || (e.kind === 'activity' ? 'range' : 'last'), end = e.endDate || e.date;
  if (mode === 'first') return { from: e.date, to: e.date, mode: mode };
  if (mode === 'last') return { from: end, to: end, mode: mode };
  if (mode === 'ends') return end === e.date ? { from: end, to: end, mode: 'last' } : { from: e.date, to: end, mode: 'ends' }; // 1.95: วันแรก + วันสุดท้าย (2 แถว)
  return { from: e.date, to: end, mode: 'range' };
}

// ===== 1.97: ข้อมูลที่ครูต้องกรอกตอนส่งงาน (ตั้งหัวข้อเองได้) — ใช้ร่วมกันทุกหน้า (ดู worker/src/lib/fields.js) =====
var FIELD_PRESETS = [
  { id: 'eventDate', label: 'วันที่', type: 'date', hint: 'เผื่อไว้สำหรับเกียรติบัตรการอบรม วันที่เข้าร่วม' },
  { id: 'location', label: 'สถานที่อบรม', type: 'text', hint: 'เผื่อไว้สำหรับเกียรติบัตรที่บอกสถานที่อบรม' },
  { id: 'award', label: 'รางวัล', type: 'text', hint: 'เผื่อไว้สำหรับเกียรติบัตรที่เป็นรางวัล' },
  { id: 'studentName', label: 'ชื่อนักเรียน', type: 'text', hint: 'เผื่อไว้สำหรับเกียรติบัตรที่เป็นผลงานนักเรียนแต่ครูเป็นผู้สอน' }
];
var FIELD_TYPE_LABEL = { text: 'ข้อความสั้น', textarea: 'ข้อความยาว', number: 'ตัวเลข', numlist: 'ตัวเลข + รายละเอียด', date: 'วันที่', select: 'เลือกจากรายการ', radio: 'เลือกได้ข้อเดียว', checks: 'เลือกได้หลายข้อ', rating: 'คะแนน 1–5' }; // 1.98: + 3 ชนิดสำหรับแบบสำรวจ
var FIELD_HAS_OPTIONS = { select: 1, radio: 1, checks: 1 };
// ค่า 1 ช่อง → ข้อความ (numlist = "4 (ก / ข / ค / ง)")
function fieldValueText(v, t) {
  if (Array.isArray(v)) return v.join(', '); // 1.98: เลือกได้หลายข้อ
  if (v && typeof v === 'object') return v.n + ((v.items || []).length ? ' (' + v.items.join(' / ') + ')' : '');
  if (t === 'date' && /^\d{4}-\d{2}-\d{2}$/.test(String(v || ''))) return formatDateThai(v);
  return String(v == null ? '' : v);
}
// ค่าที่ครูกรอกไว้ → [{ id, label, type, value, text, x, p }] (ใช้ชื่อหัวข้อที่เก็บไว้กับงาน — ค่าแบบเดิมใช้ชื่อสำเร็จรูป)
function fieldEntries(values) {
  var out = [];
  if (!values || typeof values !== 'object') return out;
  var meta = values.__meta;
  Object.keys(values).forEach(function (k) {
    if (k === '__meta') return;
    var v = values[k]; if (v == null || v === '' || (Array.isArray(v) && !v.length)) return;
    var m = meta && meta[k], pre = FIELD_PRESETS.filter(function (x) { return x.id === k; })[0];
    if (!m && !pre) return;
    var t = m ? m.t : pre.type;
    out.push({ id: k, label: m ? m.l : pre.label, type: t, value: v, text: fieldValueText(v, t), x: m ? !!m.x : true, p: m ? !!m.p : true });
  });
  return out;
}
function fieldsLineText(values) { return fieldEntries(values).map(function (e) { return e.label + ': ' + e.text; }).join(' · '); }
// ฟอร์มกรอก (ป็อปอัปส่งงาน / แก้ไขข้อมูลที่กรอก)
function fieldsFormHtml(defs, values) {
  values = values || {};
  return (defs || []).map(function (d) {
    var v = values[d.id], id = 'cf_' + d.id, req = d.required ? ' <span class="cf-req">*</span>' : ' <span class="opt">(ไม่บังคับ)</span>', inp;
    if (d.type === 'numlist') {
      var o = v && typeof v === 'object' ? v : { n: '', items: [] };
      inp = '<input id="' + id + '" type="number" min="1" max="' + d.max + '" inputmode="numeric" class="cf-n" data-cf="' + escapeHtml(d.id) + '" data-cf-type="numlist" value="' + escapeHtml(o.n) + '" style="max-width:120px" />' +
        '<div class="cf-items" data-cf-items="' + escapeHtml(d.id) + '" data-cf-dl="' + escapeHtml(d.detailLabel || 'รายละเอียด') + '" data-cf-max="' + d.max + '">' + cfItemsHtml(d, o.n, o.items || []) + '</div>';
    } else if (d.type === 'radio' || d.type === 'checks') { // 1.98: แบบสำรวจ
      var picked = Array.isArray(v) ? v : (v ? [v] : []);
      inp = '<div class="cf-opts" id="' + id + '" data-cf="' + escapeHtml(d.id) + '" data-cf-type="' + d.type + '">' + d.options.map(function (o) {
        return '<label class="cf-opt"><input type="' + (d.type === 'radio' ? 'radio' : 'checkbox') + '" name="' + id + '" value="' + escapeHtml(o) + '"' + (picked.indexOf(o) !== -1 ? ' checked' : '') + ' /> <span>' + escapeHtml(o) + '</span></label>';
      }).join('') + '</div>';
    } else if (d.type === 'rating') {
      inp = '<div class="cf-rate" id="' + id + '" data-cf="' + escapeHtml(d.id) + '" data-cf-type="rating">' + [1, 2, 3, 4, 5].map(function (n) {
        return '<label><input type="radio" name="' + id + '" value="' + n + '"' + (String(v) === String(n) ? ' checked' : '') + ' /><span>' + n + '</span></label>';
      }).join('') + '</div>';
    } else if (d.type === 'select') {
      inp = '<select id="' + id + '" data-cf="' + escapeHtml(d.id) + '"><option value="">— เลือก —</option>' + d.options.map(function (o) { return '<option' + (o === v ? ' selected' : '') + '>' + escapeHtml(o) + '</option>'; }).join('') + '</select>';
    } else if (d.type === 'textarea') {
      inp = '<textarea id="' + id + '" rows="3" maxlength="2000" data-cf="' + escapeHtml(d.id) + '">' + escapeHtml(v || '') + '</textarea>';
    } else {
      var ty = d.type === 'date' ? 'date' : (d.type === 'number' ? 'number' : 'text');
      inp = '<input id="' + id + '" type="' + ty + '"' + (ty === 'number' ? ' inputmode="decimal" step="any"' : ' maxlength="300"') + ' data-cf="' + escapeHtml(d.id) + '" value="' + escapeHtml(v || '') + '" />';
    }
    return '<div class="field cf-field"><label for="' + id + '">' + escapeHtml(d.label) + req + '</label>' + inp + (d.hint ? '<div class="hint">' + escapeHtml(d.hint) + '</div>' : '') + '</div>';
  }).join('');
}
function cfItemsHtml(d, n, items) {
  n = Math.min(Number(d.max) || 10, Math.max(0, Math.trunc(Number(n) || 0)));
  var h = '';
  for (var i = 0; i < n; i++) h += '<div class="cf-item"><b>' + (i + 1) + '.</b><input type="text" maxlength="200" data-cf-item="' + i + '" placeholder="' + escapeHtml(d.detailLabel || 'รายละเอียด') + '" value="' + escapeHtml(items[i] || '') + '" /></div>';
  return h;
}
// จำนวนเปลี่ยน → ช่องรายละเอียดเพิ่ม/ลดตาม (เก็บที่พิมพ์ไว้แล้ว)
function bindFieldsForm(box) {
  if (!box || box.__cfBound) return; box.__cfBound = true;
  box.addEventListener('input', function (e) {
    var n = e.target.closest('input[data-cf-type="numlist"]'); if (!n) return;
    var wrap = box.querySelector('[data-cf-items="' + n.getAttribute('data-cf') + '"]'); if (!wrap) return;
    var old = Array.prototype.map.call(wrap.querySelectorAll('[data-cf-item]'), function (x) { return x.value; });
    wrap.innerHTML = cfItemsHtml({ max: Number(wrap.getAttribute('data-cf-max')), detailLabel: wrap.getAttribute('data-cf-dl') }, n.value, old);
  });
}
function readFieldsForm(box) {
  var out = {};
  if (!box) return out;
  box.querySelectorAll('[data-cf]').forEach(function (el) {
    var k = el.getAttribute('data-cf');
    var ct = el.getAttribute('data-cf-type');
    if (ct === 'radio' || ct === 'rating') { var c1 = el.querySelector('input:checked'); out[k] = c1 ? c1.value : ''; }
    else if (ct === 'checks') out[k] = Array.prototype.map.call(el.querySelectorAll('input:checked'), function (x) { return x.value; });
    else if (ct === 'numlist') {
      var wrap = box.querySelector('[data-cf-items="' + k + '"]');
      out[k] = { n: el.value.trim(), items: wrap ? Array.prototype.map.call(wrap.querySelectorAll('[data-cf-item]'), function (x) { return x.value.trim(); }) : [] };
    } else out[k] = el.value.trim();
  });
  return out;
}
// ตรวจในหน้าเว็บก่อนส่ง (Worker ตรวจซ้ำ) — คืนข้อความผิดพลาด หรือ ''
function checkFieldsForm(defs, vals) {
  for (var i = 0; i < (defs || []).length; i++) {
    var d = defs[i], v = vals[d.id], name = '"' + d.label + '"';
    if (d.type === 'numlist') {
      var n = String((v && v.n) || '').trim();
      if (!n) { if (d.required) return 'กรุณากรอก ' + name; continue; }
      if (!/^\d+$/.test(n) || Number(n) < 1) return name + ' ต้องเป็นตัวเลขจำนวนเต็มตั้งแต่ 1 ขึ้นไป';
      if (Number(n) > d.max) return name + ' ใส่ได้ไม่เกิน ' + d.max;
      if (v.items.length < Number(n) || v.items.some(function (x) { return !x; })) return 'กรุณากรอก' + (d.detailLabel || 'รายละเอียด') + 'ของ ' + name + ' ให้ครบ ' + n + ' รายการ';
    } else if (d.type === 'checks') {
      if (!v || !v.length) { if (d.required) return 'กรุณาเลือก ' + name + ' อย่างน้อย 1 ข้อ'; continue; }
    } else {
      if (!v) { if (d.required) return (FIELD_HAS_OPTIONS[d.type] || d.type === 'rating' ? 'กรุณาเลือก ' : 'กรุณากรอก ') + name; continue; }
      if (d.type === 'number' && !/^-?\d+(\.\d+)?$/.test(v)) return name + ' ต้องเป็นตัวเลข';
    }
  }
  return '';
}

// 1.98: ดูคำตอบแบบสำรวจ (ป็อปอัปอ่านอย่างเดียว)
function showAnswersModal(title, values, sub) {
  var m = document.getElementById('answersModal');
  if (!m) {
    m = document.createElement('div'); m.className = 'modal-backdrop'; m.id = 'answersModal'; m.hidden = true;
    m.innerHTML = '<div class="modal-box modal-box-wide"><button type="button" class="modal-close-x" data-ans-x aria-label="ปิด">✕</button><h3 id="answersTitle"></h3><div class="hint" id="answersSub" style="margin-top:-6px"></div><div id="answersBody" class="ans-list"></div><div class="modal-actions"><button type="button" class="btn btn-ghost btn-close" data-ans-x>ปิด</button></div></div>';
    document.body.appendChild(m);
    m.addEventListener('click', function (e) { if (e.target.closest('[data-ans-x]')) hideModalEl(m); });
  }
  document.getElementById('answersTitle').textContent = title || 'คำตอบ';
  document.getElementById('answersSub').textContent = sub || '';
  var es = fieldEntries(values);
  document.getElementById('answersBody').innerHTML = es.length ? es.map(function (e, i) { return '<div class="ans-row"><div class="q">' + (i + 1) + '. ' + escapeHtml(e.label) + '</div><div class="a">' + escapeHtml(e.type === 'rating' ? e.text + ' / 5' : e.text) + '</div></div>'; }).join('') : '<div class="hint">ไม่มีคำตอบ</div>';
  showModalEl(m);
}
function isSurveySub(s) { return !!s && s.mimeType === 'survey'; }

// 1.97: ลิงก์ของกำหนดการ = ฟอร์ม/ไฟล์ตัวอย่าง (ก่อน) + ลิงก์แนบ
function evLinksOf(e) {
  if (!e) return [];
  return (e.sampleFiles || []).map(function (f) { return { url: f.url, label: f.note || f.name, name: f.name, sample: true }; }).concat(e.links || []);
}
function samplesListHtml(list) {
  if (!list || !list.length) return '';
  return '<div class="field"><label>ฟอร์ม / ไฟล์ตัวอย่างของงานนี้</label><div class="smp-list">' + list.map(function (f) {
    return '<div class="smp-item">' + fileTypeIconHtml(f.name, f.mime, 'sm') + '<div class="t">' + escapeHtml(f.name) + (f.note ? '<small>' + escapeHtml(f.note) + '</small>' : '') + '</div><div class="b">' +
      '<a class="btn btn-sm btn-secondary" href="' + escapeHtml(f.url) + '" target="_blank" rel="noopener"><i class="fa-solid fa-eye" aria-hidden="true"></i> เปิดดู</a>' +
      '<a class="btn btn-sm btn-primary" href="' + escapeHtml(driveDownloadUrl(f.url) || f.url) + '" target="_blank" rel="noopener"><i class="fa-solid fa-download" aria-hidden="true"></i> ดาวน์โหลด</a></div></div>';
  }).join('') + '</div></div>';
}
