// ==========================================================
// archive.js (BNKSA 2.06.0) — ไฟล์ข้อมูลรายปี + หน้าข้อมูลย้อนหลัง (อ่านอย่างเดียว)
// · ส่งออก: รวมรายชื่อ ห้อง ครู วิชา และการเช็คชื่อทุกคาบของทั้งปีเป็นไฟล์เดียว (บีบอัด) แล้วบันทึกลง Google Drive
//   ผ่าน Worker → Apps Script (ดึงข้อมูลทีละห้องในเบราว์เซอร์ — ไม่ใช้เวลาประมวลผลของ Worker)
// · หน้าข้อมูลย้อนหลัง: เปิดไฟล์ใน Drive หรือไฟล์ในเครื่อง ดูประวัติรายคน / รายห้อง · ไม่มีคำสั่งบันทึกข้อมูลใด ๆ
// · ปีการศึกษาในเมนู: แสดงเฉพาะปีที่แล้ว · ปีปัจจุบัน · ปีถัดไป (ปีเก่ากว่านั้นดูที่หน้าข้อมูลย้อนหลัง)
// ใช้ตัวแปรกลางของ app.js: settings, subjects, students, teachers, followUps, adminToken, currentUser, GOOGLE_APP_SCRIPT_URL
// ต้องโหลดหลัง app.js
// ==========================================================
(function () {
    const isSuper = () => !!(currentUser && currentUser.role === 'super_admin');
    const E = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const rn = (r) => { const m = /^m(\d)_(\d+)$/.exec(String(r || '')); return m ? `ม.${m[1]}/${m[2]}` : String(r || '-'); };
    const rOrd = (r) => { const m = /^m(\d)_(\d+)$/.exec(String(r || '')); return m ? +m[1] * 100 + +m[2] : 9999; };
    const TM = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'], TD = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
    const dOf = (ds) => { const p = String(ds || '').split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
    const thd = (ds, y) => { const d = dOf(ds); if (isNaN(d)) return String(ds || ''); return TD[d.getDay()] + ' ' + d.getDate() + ' ' + TM[d.getMonth()] + (y ? ' ' + (d.getFullYear() + 543) : ''); };
    const thDT = (iso) => { const d = new Date(iso); return isNaN(d) ? '' : d.getDate() + ' ' + TM[d.getMonth()] + ' ' + (d.getFullYear() + 543); };
    const mb = (n) => n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
    const num = (n) => Number(n || 0).toLocaleString('th-TH');
    const ST = ['มา', 'ร่วมกิจกรรม', 'สาย', 'ลากิจ', 'ลาป่วย', 'ขาด', 'โดดเรียน'];
    const PRESENT = { 'มา': 1, 'ร่วมกิจกรรม': 1, 'สาย': 1 };
    const SCLS = { 'มา': 'emerald-700|emerald-50|emerald-200', 'ร่วมกิจกรรม': 'cyan-700|cyan-50|cyan-200', 'สาย': 'amber-600|amber-50|amber-200', 'ลากิจ': 'indigo-600|indigo-50|indigo-200', 'ลาป่วย': 'blue-600|blue-50|blue-200', 'ขาด': 'rose-600|rose-50|rose-200', 'โดดเรียน': 'purple-700|purple-50|purple-200' };
    const chip = (s) => { const c = (SCLS[s] || 'slate-600|slate-50|slate-200').split('|'); return `<span class="bg-${c[1]} text-${c[0]} border border-${c[2]} px-2 py-0.5 rounded-full text-[10px] sm:text-[11px] font-black whitespace-nowrap">${E(s)}</span>`; };
    const curYear = () => Number(settings && settings.year) || 0;
    const API = (q) => GOOGLE_APP_SCRIPT_URL + '?' + q; // GET ของผู้ดูแล — app.js เติม token ให้เอง

    // ===================== ปีการศึกษาในเมนู (±1 ปี) =====================
    window.__showAllYears = false;
    window.__yaInWindow = function (y) { const c = curYear(); if (!c || window.__showAllYears) return true; const n = Number(y); return Math.abs(n - c) <= 1; };
    function oldYears() {
        const list = (settings.academicYears || []).filter((y) => isSuper() || !y.hidden);
        const c = curYear(); return list.filter((y) => c && Math.abs(Number(y.year) - c) > 1).map((y) => String(y.year)).sort();
    }
    window.__yaTag = function (year) {
        const c = curYear(), d = Number(year) - c; if (!c) return '';
        const t = d === 0 ? ['ปีปัจจุบัน', 'bg-indigo-50 text-indigo-700 border-indigo-200'] : d === 1 ? ['ปีถัดไป · เตรียมข้อมูล', 'bg-sky-50 text-sky-700 border-sky-200'] : d === -1 ? ['ปีที่แล้ว · แก้ไขย้อนหลังได้', 'bg-amber-50 text-amber-700 border-amber-200'] : ['ปีเก่า', 'bg-slate-100 text-slate-500 border-slate-200'];
        return `<span class="border text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded ${t[1]}">${t[0]}</span>`;
    };
    window.__yaOldRow = function () {
        const old = oldYears(); if (!old.length) return '';
        const range = old.length > 1 ? `${old[0]}–${old[old.length - 1]}` : old[0];
        const btns = isSuper() ? `<button onclick="window.openYearArchive()" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border border-indigo-200 px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold"><i class="fas fa-box-archive"></i> เปิดหน้าข้อมูลย้อนหลัง</button><button onclick="window.toggleShowAllYears()" class="bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold"><i class="fas ${window.__showAllYears ? 'fa-eye-slash' : 'fa-eye'}"></i> ${window.__showAllYears ? 'ซ่อนปีเก่า' : 'แสดงปีเก่าชั่วคราว'}</button>` : '';
        return `<div class="mb-3 flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-white border border-dashed border-slate-300 rounded-lg px-3 py-2.5"><div class="flex items-center gap-2.5"><span class="w-8 h-8 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center shrink-0"><i class="fas fa-box-archive"></i></span><div><div class="font-bold text-sm text-slate-600">ปีเก่า ${old.length} ปี (${range})${window.__showAllYears ? ' <span class="bg-amber-50 text-amber-700 border border-amber-200 text-[9px] font-black px-1.5 py-0.5 rounded">กำลังแสดงชั่วคราว</span>' : ''}</div><div class="text-[10px] sm:text-[11px] text-slate-400 font-medium">${window.__showAllYears ? 'แสดงปีเก่าในเมนูชั่วคราว (เฉพาะหน้าจอนี้ · โหลดหน้าใหม่แล้วซ่อนเอง)' : 'ไม่แสดงในเมนู · ' + (isSuper() ? 'ดูประวัติรายคน/รายห้องได้ที่หน้าข้อมูลย้อนหลัง (ไฟล์ใน Google Drive)' : 'ผู้ดูแลระบบสูงสุดเปิดดูได้ที่หน้าข้อมูลย้อนหลัง')}</div></div></div><div class="flex flex-wrap gap-1.5 shrink-0">${btns}</div></div>`;
    };
    window.__yaBarBtn = function () {
        if (!isSuper() || (!oldYears().length && !window.__showAllYears)) return '';
        return `<button onclick="window.openYearArchive()" title="ปีเก่า — หน้าข้อมูลย้อนหลัง" class="text-slate-500 hover:bg-slate-50 border-l border-indigo-100 ml-1 pl-2.5 pr-2 py-1 rounded-r-md font-bold text-[10px] sm:text-xs flex items-center gap-1"><i class="fas fa-box-archive"></i> ปีเก่า</button>`;
    };
    window.toggleShowAllYears = function () { if (!isSuper()) return; window.__showAllYears = !window.__showAllYears; renderAdmin(); };
    window.__yaAddOk = function (yr) {
        const c = curYear(); if (!c) return true;
        if (Math.abs(Number(yr) - c) > 1) { showToast(`เพิ่มได้เฉพาะปีที่แล้ว ปีปัจจุบัน และปีถัดไป (${c - 1}–${c + 1}) — ปีเก่าดูได้ที่หน้าข้อมูลย้อนหลัง`, 'error'); return false; }
        return true;
    };

    // ===================== ไฟล์ (บีบอัด / base64 / ตรวจความสมบูรณ์) =====================
    const canZip = () => typeof CompressionStream === 'function' && typeof DecompressionStream === 'function';
    async function gz(str) { return new Uint8Array(await new Response(new Blob([str]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer()); }
    async function gunzip(bytes) { return await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).text(); }
    function b64(bytes) { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000)); return btoa(s); }
    function unb64(str) { const bin = atob(str); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
    async function sha(str) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)); return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, '0')).join(''); }
    async function getJ(q) { for (let i = 0; i < 3; i++) { try { const r = await fetch(API(q)); if (r.status === 401) throw Object.assign(new Error('หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่'), { fatal: 1 }); const j = await r.json(); if (j && j.status === 'success') return j; if (i === 2) throw new Error((j && j.message) || 'โหลดข้อมูลไม่สำเร็จ'); } catch (e) { if (e.fatal || i === 2) throw e; } await new Promise((r) => setTimeout(r, 800 * (i + 1))); } }

    // ===================== ส่งออกข้อมูลทั้งปี =====================
    async function buildYear(Y, prog) {
        Y = String(Y);
        const subj = subjects.filter((s) => String(s.year) === Y);
        const terms = [...new Set(subj.map((s) => String(s.term)))].sort();
        const jobs = []; terms.forEach((t) => [...new Set(subj.filter((s) => String(s.term) === t).map((s) => s.roomId))].sort((a, b) => rOrd(a) - rOrd(b)).forEach((r) => jobs.push([t, r])));
        const att = {}, hr = {}; let done = 0, recs = 0, idx = 0;
        const worker = async () => { while (idx < jobs.length) { const [t, r] = jobs[idx++]; const q = `term=${encodeURIComponent(t)}&year=${Y}&room=${encodeURIComponent(r)}`;
            const a = await getJ('action=get_attendance&' + q); att[t + '|' + r] = a.attendanceData || []; recs += att[t + '|' + r].length;
            try { const h = await getJ('action=get_homeroom_logs&' + q); if ((h.logs || []).length) hr[t + '|' + r] = h.logs; } catch (e) { if (e.fatal) throw e; }
            done++; prog(done, jobs.length); } };
        await Promise.all([worker(), worker(), worker(), worker()]);
        const stu = students.filter((s) => String(s.year || '') === Y || (!s.year && Y === String(settings.year)));
        const pick = (o) => { const x = {}; Object.keys(o || {}).forEach((k) => { if (k.slice(-5) === '_' + Y) x[k] = o[k]; }); return x; };
        const fu = typeof followUps !== 'undefined' && Array.isArray(followUps) ? followUps.filter((f) => !f || !f.year || String(f.year) === Y) : [];
        const stats = { students: stu.length, rooms: new Set(jobs.map((j) => j[1])).size, records: recs, terms };
        const data = { kind: 'bnksa-year-archive', v: 1, year: Y, createdAt: new Date().toISOString(), by: (currentUser && currentUser.name) || '', app: typeof APP_VERSION !== 'undefined' ? APP_VERSION : '', school: settings.title || '', stats,
            settings: { termCount: settings.termCount || 2, roomCounts: settings.roomCounts || {}, advisors: pick(settings.advisors), staffs: pick(settings.staffs), thresholds: settings.thresholds || {}, holidays: settings.holidays || [], termLocks: pick(settings.termLocks) },
            teachers: typeof teachers !== 'undefined' ? teachers : [], subjects: subj, students: stu, followUps: fu, attendance: att, homeroom: hr };
        return { data, stats, empty: !jobs.length };
    }
    // ส่งออกแล้วบันทึกลง Drive — คืนค่า true เมื่อสำเร็จ
    window.exportYearArchive = async function (year, opts) {
        opts = opts || {}; const Y = String(year);
        if (!isSuper()) { showToast('เฉพาะผู้ดูแลระบบสูงสุด', 'error'); return false; }
        if (!canZip()) { showToast('เบราว์เซอร์นี้ไม่รองรับการบีบอัดไฟล์ กรุณาใช้ Chrome / Edge / Safari รุ่นใหม่', 'error'); return false; }
        showProgressModal(`ส่งออกข้อมูลปีการศึกษา ${Y}`, 'กำลังโหลดข้อมูลเช็คชื่อ...'); updateProgressModal(3, 'กำลังโหลดข้อมูลเช็คชื่อ...');
        try {
            const B = await buildYear(Y, (d, n) => updateProgressModal(3 + Math.round(d / n * 72), `โหลดข้อมูลเช็คชื่อ ${d}/${n} (ห้อง × ภาคเรียน)`));
            if (B.empty && !B.stats.students) throw new Error(`ปีการศึกษา ${Y} ยังไม่มีข้อมูลวิชาหรือนักเรียน`);
            updateProgressModal(78, 'กำลังบีบอัดไฟล์...');
            const json = JSON.stringify(B.data), h = await sha(json);
            const bytes = await gz('{"sha256":"' + h + '","data":' + json + '}');
            updateProgressModal(86, `กำลังบันทึกลง Google Drive (${mb(bytes.length)})...`);
            const meta = JSON.stringify({ s: B.stats.students, r: B.stats.rooms, n: B.stats.records, t: B.stats.terms, raw: json.length });
            const res = await fetch(API(`action=archive_put&year=${Y}&token=${encodeURIComponent(adminToken)}&meta=${encodeURIComponent(meta)}`), { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: b64(bytes) });
            let j = null; try { j = await res.json(); } catch (e) { j = null; }
            if (!j || j.status !== 'success') throw new Error((j && j.message) || 'บันทึกลง Google Drive ไม่สำเร็จ (HTTP ' + res.status + ')');
            LIST = null;
            updateProgressModal(100, 'เรียบร้อย');
            completeProgressModal('ส่งออกเรียบร้อย', `บันทึก ${j.name || ('ปีการศึกษา ' + Y)} (${mb(j.size || bytes.length)}) ลง Google Drive แล้ว · นักเรียน ${num(B.stats.students)} คน · ${num(B.stats.records)} คาบที่เช็ค`);
            try { logAction('ส่งออกข้อมูลรายปีลง Google Drive', `ปีการศึกษา ${Y} · ${mb(bytes.length)}`, 'settings'); } catch (e) { /* ข้าม */ }
            if (!opts.noRefresh) refreshCard();
            return true;
        } catch (e) { errorProgressModal(e.message || 'ส่งออกไม่สำเร็จ'); return false; }
    };
    // ก่อน "จัดเก็บปี" (app.js) — ผู้ดูแลระบบสูงสุดส่งออกลง Drive ก่อน · ไม่สำเร็จ = ถามว่าจะจัดเก็บต่อไหม
    window.__yaBeforeArchive = async function (year) {
        if (!isSuper()) return true;
        if (await window.exportYearArchive(year, { noRefresh: true })) return true;
        return await new Promise((res) => setTimeout(() => showConfirm('ส่งออกลง Google Drive ไม่สำเร็จ', `ยังไม่มีไฟล์ข้อมูลรายปีของปีการศึกษา ${year} ใน Drive — จะจัดเก็บปีนี้ต่อโดยไม่มีไฟล์หรือไม่? (แนะนำให้ยกเลิก แก้ปัญหาแล้วลองใหม่)`, () => res(true)), 300));
    };

    // ===================== รายการไฟล์ใน Drive =====================
    let LIST = null;
    async function listFiles(force) {
        if (!force && LIST && Date.now() - LIST.at < 120000) return LIST;
        const j = await getJ('action=archive_list');
        LIST = { at: Date.now(), files: j.files || [], folderUrl: j.folderUrl || '' }; return LIST;
    }
    const metaOf = (f) => { try { return JSON.parse(f.meta || '{}') || {}; } catch (e) { return {}; } };

    // ----- การ์ดในแท็บ "สำรองข้อมูล" -----
    window.__yaCardHtml = function () {
        if (!isSuper()) return '';
        return `<div class="mb-6 bg-emerald-50/60 p-4 sm:p-6 rounded-2xl border border-emerald-200"><div class="flex flex-wrap items-center justify-between gap-2 mb-1"><h4 class="text-base sm:text-lg font-extrabold text-emerald-800 flex items-center gap-2"><i class="fab fa-google-drive"></i> ไฟล์ข้อมูลรายปี (Google Drive)</h4><button onclick="window.openYearArchive()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs shadow-sm flex items-center gap-1.5"><i class="fas fa-box-archive"></i> เปิดหน้าข้อมูลย้อนหลัง</button></div><p class="text-[10px] sm:text-xs text-emerald-700 font-medium mb-3">รวมรายชื่อ ห้อง ครู วิชา และการเช็คชื่อทุกคาบของทั้งปีไว้ในไฟล์เดียว บันทึกลงโฟลเดอร์ "BNKSA ข้อมูลรายปี" ใน Google Drive ของโรงเรียนให้เอง · <b>ส่งออกให้อัตโนมัติเมื่อกด "จัดเก็บ" ปีการศึกษา</b> · ส่งออกซ้ำได้ (ไฟล์เดิมของปีนั้นลงถังขยะ กู้คืนได้ 30 วัน) · เปิดดูได้ที่หน้าข้อมูลย้อนหลัง (อ่านอย่างเดียว)</p><div id="yaBox" class="space-y-1.5"><div class="text-center text-slate-400 py-3 text-xs font-medium"><i class="fas fa-spinner fa-spin"></i> กำลังโหลดรายการไฟล์...</div></div></div>`;
    };
    function refreshCard() { if (document.getElementById('yaBox')) window.__yaCardLoad(true); }
    window.__yaCardLoad = async function (force) {
        const box = document.getElementById('yaBox'); if (!box) return;
        let L; try { L = await listFiles(force); } catch (e) { box.innerHTML = `<div class="bg-white border border-rose-200 rounded-lg px-3 py-2.5 text-xs sm:text-sm text-rose-600 font-bold"><i class="fas fa-triangle-exclamation"></i> ${E(e.message)}</div><button onclick="window.__yaCardLoad(true)" class="mt-1 bg-white border border-slate-200 text-slate-600 px-3 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold"><i class="fas fa-rotate"></i> ลองใหม่</button>`; return; }
        if (!document.getElementById('yaBox')) return;
        const fy = {}; L.files.forEach((f) => { fy[f.year] = f; });
        const ys = [...new Set((settings.academicYears || []).map((y) => String(y.year)).concat(Object.keys(fy)))].sort().reverse();
        const c = curYear();
        box.innerHTML = ys.map((y) => { const f = fy[y], m = f ? metaOf(f) : null, d = Number(y) - c;
            const tag = d === 0 ? '<span class="bg-indigo-50 text-indigo-700 border border-indigo-200 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 rounded">ปีปัจจุบัน</span>' : d > 0 ? '<span class="bg-sky-50 text-sky-700 border border-sky-200 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 rounded">ปีถัดไป</span>' : '';
            const st = f ? '<span class="bg-emerald-50 text-emerald-700 border border-emerald-200 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 rounded"><i class="fab fa-google-drive"></i> อยู่ใน Drive แล้ว</span>' : '';
            const info = f ? `${mb(f.size)} · ${thDT(f.updated)}${f.by ? ' · ' + E(f.by) : ''}${m && m.s ? ' · นักเรียน ' + num(m.s) + ' คน' : ''}` : (d >= 0 ? 'ยังไม่ส่งออก · ส่งออกระหว่างปีได้ (เป็นไฟล์สำรอง)' : 'ยังไม่มีไฟล์ใน Drive');
            const btn = f ? `<button onclick="window.openYearArchive('${E(f.id)}')" class="bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold"><i class="fas fa-eye"></i> เปิดดู</button><button onclick="window.exportYearArchive('${y}')" class="bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold"><i class="fas fa-rotate"></i> ส่งออกใหม่</button>` : `<button onclick="window.exportYearArchive('${y}')" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold"><i class="fas fa-cloud-arrow-up"></i> ส่งออกตอนนี้</button>`;
            return `<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2.5"><div class="flex items-center gap-2 flex-wrap"><span class="font-black text-sm text-slate-700">ปีการศึกษา ${y}</span>${tag}${st}<span class="text-[10px] sm:text-[11px] text-slate-400 font-medium">${info}</span></div><div class="flex gap-1.5 shrink-0">${btn}</div></div>`; }).join('') +
            (L.folderUrl ? `<p class="text-[10px] sm:text-[11px] text-slate-500 font-medium pt-1"><i class="fas fa-folder-open"></i> <a href="${E(L.folderUrl)}" target="_blank" rel="noopener" class="underline">เปิดโฟลเดอร์ใน Google Drive</a></p>` : '');
    };

    // ===================== หน้าข้อมูลย้อนหลัง =====================
    let ARC = null; // { file, D, ok, idx }
    const UI = { tab: 'stu', q: '', sid: '', term: '', room: '', rterm: '', rsub: '', evAll: false };
    window.openYearArchive = async function (fileId) {
        if (!isSuper()) { showToast('เฉพาะผู้ดูแลระบบสูงสุด', 'error'); return; }
        if (fileId) { const ok = await loadFromDrive(fileId); if (!ok) return; }
        navigate('admin_archive');
    };
    async function openParsed(text, name) {
        let o; try { o = JSON.parse(text); } catch (e) { throw new Error('ไฟล์นี้เปิดอ่านไม่ได้ (ไม่ใช่ไฟล์ข้อมูลรายปีของเว็บเช็คชื่อ)'); }
        const D = o && o.data; if (!D || D.kind !== 'bnksa-year-archive') throw new Error('ไฟล์นี้ไม่ใช่ไฟล์ข้อมูลรายปีของเว็บเช็คชื่อ');
        const ok = !!o.sha256 && (await sha(JSON.stringify(D))) === o.sha256;
        ARC = { name, D, ok, idx: indexArc(D) };
        Object.assign(UI, { tab: 'stu', q: '', sid: '', term: '', room: '', rterm: '', rsub: '', evAll: false });
    }
    async function loadFromDrive(id) {
        if (!canZip()) { showToast('เบราว์เซอร์นี้ไม่รองรับการเปิดไฟล์บีบอัด กรุณาใช้ Chrome / Edge / Safari รุ่นใหม่', 'error'); return false; }
        showLoadingSpinnerModal('กำลังเปิดไฟล์ข้อมูลรายปี', 'กำลังดาวน์โหลดจาก Google Drive...');
        try { const j = await getJ('action=archive_get&id=' + encodeURIComponent(id)); await openParsed(await gunzip(unb64(j.base64)), j.name || ''); window.closeProgressModal(); return true; }
        catch (e) { errorProgressModal(e.message || 'เปิดไฟล์ไม่สำเร็จ'); return false; }
    }
    window.__yaOpenLocal = async function (input) {
        const f = input.files && input.files[0]; input.value = ''; if (!f) return;
        showLoadingSpinnerModal('กำลังเปิดไฟล์ข้อมูลรายปี', f.name);
        try { const buf = new Uint8Array(await f.arrayBuffer()); const gzd = buf[0] === 0x1f && buf[1] === 0x8b; if (gzd && !canZip()) throw new Error('เบราว์เซอร์นี้ไม่รองรับการเปิดไฟล์บีบอัด');
            await openParsed(gzd ? await gunzip(buf) : new TextDecoder().decode(buf), f.name); window.closeProgressModal(); renderYearArchive(); }
        catch (e) { errorProgressModal(e.message || 'เปิดไฟล์ไม่สำเร็จ'); }
    };
    window.__yaClose = function () { ARC = null; renderYearArchive(); };

    // ดัชนี: นักเรียน → { c: { 'ภาค|วิชา': {สถานะ: จำนวน} }, ev: [[วันที่, คาบ, วิชา, สถานะ, ภาค]] }
    function indexArc(D) {
        const sub = {}, stu = {}, per = {};
        (D.subjects || []).forEach((s) => { sub[s.id] = s; }); (D.students || []).forEach((s) => { stu[s.id] = s; });
        Object.keys(D.attendance || {}).forEach((k) => { const t = k.split('|')[0];
            (D.attendance[k] || []).forEach((rec) => { const R = (rec && rec.records) || {};
                for (const sid in R) { const v = R[sid], st = typeof v === 'string' ? v : (v && v.status); if (!st) continue;
                    const P = per[sid] || (per[sid] = { c: {}, ev: [] }), key = t + '|' + rec.subjectId, c = P.c[key] || (P.c[key] = {});
                    c[st] = (c[st] || 0) + 1; if (st !== 'มา') P.ev.push([rec.date, Number(rec.period), rec.subjectId, st, t]); } }); });
        Object.keys(per).forEach((k) => per[k].ev.sort((a, b) => String(b[0]).localeCompare(String(a[0])) || a[1] - b[1]));
        const rooms = [...new Set((D.subjects || []).map((s) => s.roomId).concat((D.students || []).map((s) => s.roomId)))].filter(Boolean).sort((a, b) => rOrd(a) - rOrd(b));
        return { sub, stu, per, rooms };
    }
    const sumC = (P, term, subjF) => { const o = {}; if (!P) return o; Object.keys(P.c).forEach((k) => { const [t, sj] = k.split('|'); if (term && t !== term) return; if (subjF && !subjF(sj)) return; const c = P.c[k]; for (const s in c) o[s] = (o[s] || 0) + c[s]; }); return o; };
    const totOf = (o) => Object.keys(o).reduce((a, k) => a + o[k], 0);
    const pctOf = (o) => { const t = totOf(o); if (!t) return null; let p = 0; for (const k in o) if (PRESENT[k]) p += o[k]; return Math.round(p / t * 1000) / 10; };
    const pctTag = (p) => p == null ? '<span class="text-slate-300">-</span>' : `<span class="${p < 80 ? 'bg-rose-50 text-rose-600' : 'bg-emerald-50 text-emerald-700'} px-2 py-0.5 rounded-full text-xs font-black">${p}%</span>`;
    const advOf = (room, term) => { const A = ARC.D.settings.advisors || {}, Y = ARC.D.year; const ts = term ? [term] : ARC.D.stats.terms.slice().reverse(); for (const t of ts) { const v = (A[t + '_' + Y] || {})[room]; if (v && [].concat(v).length) return [].concat(v).join(', '); } return ''; };
    const subjName = (sj) => { const s = ARC.idx.sub[sj]; return s ? ((s.code ? s.code + ' ' : '') + s.name) : 'วิชาที่ถูกลบ'; };
    const termSeg = (val, fn) => `<div class="flex bg-slate-100 p-1 rounded-lg w-max">${[['', 'ทั้งปี']].concat(ARC.D.stats.terms.map((t) => [t, 'ภาคเรียน ' + t])).map((x) => `<button onclick="${fn}('${x[0]}')" class="px-2.5 sm:px-3 py-1 rounded-md text-[11px] sm:text-xs font-bold ${val === x[0] ? 'bg-white shadow-sm text-indigo-700' : 'text-slate-500'}">${x[1]}</button>`).join('')}</div>`;

    function renderYearArchive() {
        const mc = document.getElementById('mainContent'); if (!mc) return;
        const head = `<div class="flex flex-wrap items-center justify-between gap-2 mb-4 sm:mb-6"><div><h2 class="text-2xl sm:text-3xl font-extrabold text-slate-800 flex items-center gap-2"><i class="fas fa-box-archive text-indigo-500"></i> ข้อมูลย้อนหลัง</h2><p class="text-xs sm:text-sm text-slate-500 font-medium mt-1">อ่านอย่างเดียว · ข้อมูลอยู่ในเครื่องนี้ชั่วคราว ไม่มีการแก้ไขหรือส่งกลับเซิร์ฟเวอร์</p></div><button onclick="window.navigate('admin', { tab: 'backup' })" class="bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 px-3 py-2 rounded-xl font-bold text-xs sm:text-sm shadow-sm flex items-center gap-2"><i class="fas fa-arrow-left"></i> กลับหน้าจัดการระบบ</button></div>`;
        if (!isSuper()) { mc.innerHTML = `<div class="max-w-7xl mx-auto px-3 sm:px-6 py-6">${head}<div class="bg-white rounded-2xl border border-slate-200 p-6 text-center text-slate-500 font-bold"><i class="fas fa-lock"></i> เฉพาะผู้ดูแลระบบสูงสุด</div></div>`; return; }
        if (!ARC) { mc.innerHTML = `<div class="max-w-7xl mx-auto px-3 sm:px-6 py-6">${head}<div id="arcYears"><div class="text-center text-slate-400 py-10 font-medium"><i class="fas fa-spinner fa-spin"></i> กำลังโหลดรายการไฟล์จาก Google Drive...</div></div></div>`; drawYears(); return; }
        const D = ARC.D;
        mc.innerHTML = `<div class="max-w-7xl mx-auto px-3 sm:px-6 py-6">${head}<div class="bg-amber-50 border border-amber-200 rounded-2xl px-4 py-3 mb-4 flex flex-col sm:flex-row sm:items-center justify-between gap-2"><div class="flex items-center gap-2.5"><span class="w-9 h-9 rounded-xl bg-amber-500 text-white flex items-center justify-center shrink-0"><i class="fas fa-lock"></i></span><div><div class="font-extrabold text-amber-800 text-sm sm:text-base">กำลังดูข้อมูลปีการศึกษา ${E(D.year)} · อ่านอย่างเดียว</div><div class="text-[11px] text-amber-700 font-medium">${E(ARC.name || '')}${ARC.ok ? ' · ตรวจแล้ว ไฟล์สมบูรณ์' : ' · <b class="text-rose-600">ตรวจไม่ผ่าน — ไฟล์อาจเสียหายหรือถูกแก้ไข</b>'} · ส่งออกเมื่อ ${thDT(D.createdAt)}${D.by ? ' โดย ' + E(D.by) : ''}</div></div></div><button onclick="window.__yaClose()" class="bg-white border border-amber-200 text-amber-700 px-3 py-1.5 rounded-lg font-bold text-xs shrink-0"><i class="fas fa-repeat"></i> เปลี่ยนปี</button></div>
            <div class="flex items-center gap-1 bg-slate-100 p-1 rounded-xl w-max mb-4"><button onclick="window.__yaTab('stu')" class="px-3 sm:px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 ${UI.tab === 'stu' ? 'bg-white shadow-sm text-indigo-700' : 'text-slate-500'}"><i class="fas fa-user-graduate"></i> ประวัติรายคน</button><button onclick="window.__yaTab('room')" class="px-3 sm:px-4 py-2 rounded-lg font-bold text-sm flex items-center gap-2 ${UI.tab === 'room' ? 'bg-white shadow-sm text-indigo-700' : 'text-slate-500'}"><i class="fas fa-door-open"></i> รายห้อง</button></div><div id="arcBody"></div></div>`;
        drawBody();
    }
    window.renderYearArchive = renderYearArchive;
    async function drawYears() {
        const box = document.getElementById('arcYears'); if (!box) return;
        let L, err = ''; try { L = await listFiles(true); } catch (e) { err = e.message; L = { files: [] }; }
        if (!document.getElementById('arcYears')) return;
        const cards = L.files.map((f) => { const m = metaOf(f), tl = m.t || [];
            return `<div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-5"><div class="flex items-start justify-between gap-2"><div><div class="text-[11px] font-bold text-indigo-500">ปีการศึกษา</div><div class="text-3xl font-black text-slate-800 leading-none mt-1">${E(f.year)}</div></div>${tl.length ? `<span class="bg-emerald-50 text-emerald-700 border border-emerald-200 text-[10px] font-black px-2 py-1 rounded-full">ภาคเรียน ${E(tl.join(', '))}</span>` : ''}</div>
                <div class="grid grid-cols-3 gap-2 mt-4 text-center"><div class="bg-slate-50 rounded-lg py-2"><div class="text-sm font-black">${m.s != null ? num(m.s) : '-'}</div><div class="text-[10px] text-slate-500 font-bold">นักเรียน</div></div><div class="bg-slate-50 rounded-lg py-2"><div class="text-sm font-black">${m.r != null ? num(m.r) : '-'}</div><div class="text-[10px] text-slate-500 font-bold">ห้อง</div></div><div class="bg-slate-50 rounded-lg py-2"><div class="text-sm font-black">${m.n != null ? num(m.n) : '-'}</div><div class="text-[10px] text-slate-500 font-bold">คาบที่เช็ค</div></div></div>
                <div class="text-[11px] text-slate-500 font-medium mt-3 flex items-center gap-1.5"><i class="fab fa-google-drive text-emerald-500"></i> ${mb(f.size)} · บันทึก ${thDT(f.updated)}${f.by ? ' · ' + E(f.by) : ''}</div>
                <button onclick="window.__yaOpenDrive('${E(f.id)}')" class="mt-3 w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl py-2.5 font-bold text-sm flex items-center justify-center gap-2"><i class="fas fa-folder-open"></i> เปิดดู</button></div>`; }).join('');
        box.innerHTML = `<div class="mb-4"><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 flex items-center gap-2"><i class="fab fa-google-drive text-emerald-500"></i> ไฟล์ข้อมูลรายปีใน Google Drive</h3><p class="text-[11px] sm:text-xs text-slate-500 font-medium">ส่งออก/ส่งออกใหม่ได้ที่ จัดการระบบ › สำรองข้อมูล</p></div>` +
            (err ? `<div class="bg-white border border-rose-200 rounded-2xl p-4 text-sm text-rose-600 font-bold mb-4"><i class="fas fa-triangle-exclamation"></i> ${E(err)}</div>` : '') +
            (cards ? `<div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">${cards}</div>` : (err ? '' : '<div class="bg-white border border-slate-200 rounded-2xl p-6 text-center text-slate-400 font-bold">ยังไม่มีไฟล์ใน Drive — ส่งออกได้ที่ จัดการระบบ › สำรองข้อมูล</div>')) +
            `<div class="mt-4 sm:mt-6 bg-slate-50 border border-dashed border-slate-300 rounded-2xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"><div class="text-xs sm:text-sm text-slate-600 font-medium"><b class="text-slate-700">มีไฟล์อยู่ในเครื่อง?</b> เปิดไฟล์ .json.gz ที่ดาวน์โหลดจาก Drive ไว้ได้เลย (ระบบตรวจว่าไฟล์สมบูรณ์ก่อนแสดงผล)</div><label class="bg-white border border-slate-200 text-slate-700 px-4 py-2 rounded-xl font-bold text-sm shadow-sm shrink-0 cursor-pointer"><i class="fas fa-upload"></i> เปิดไฟล์จากเครื่อง<input type="file" accept=".gz,.json,application/gzip,application/json" class="hidden" onchange="window.__yaOpenLocal(this)"></label></div>`;
    }
    window.__yaOpenDrive = async function (id) { if (await loadFromDrive(id)) renderYearArchive(); };
    window.__yaTab = function (t) { UI.tab = t; renderYearArchive(); };

    function drawBody() { const b = document.getElementById('arcBody'); if (!b || !ARC) return; b.innerHTML = UI.tab === 'room' ? roomHtml() : stuHtml(); }
    // ----- ประวัติรายคน -----
    function stuMatches() {
        const q = UI.q.trim().toLowerCase(); if (!q) return [];
        return ARC.D.students.filter((s) => String(s.name || '').toLowerCase().includes(q) || String(s.code || '').includes(q)).sort((a, b) => rOrd(a.roomId) - rOrd(b.roomId) || (+a.number || 0) - (+b.number || 0)).slice(0, 40);
    }
    function stuListHtml() {
        const L = stuMatches();
        if (!UI.q.trim()) return '<div class="text-[11px] font-bold text-slate-400 px-2 py-3">พิมพ์ชื่อ นามสกุล หรือรหัสนักเรียน</div>';
        return `<div class="text-[11px] font-bold text-slate-400 px-2 py-1.5">พบ ${L.length}${L.length >= 40 ? '+' : ''} คน</div>` + (L.map((s) => `<button onclick="window.__yaPick('${E(s.id)}')" class="w-full text-left px-3 py-2.5 rounded-xl ${UI.sid === s.id ? 'bg-indigo-50 border border-indigo-200' : 'hover:bg-slate-50 border border-transparent'}"><div class="font-bold text-sm ${UI.sid === s.id ? 'text-indigo-700' : 'text-slate-700'}">${E(s.name)}</div><div class="text-[11px] text-slate-500 font-medium">${E(s.code || '-')} · ${rn(s.roomId)} เลขที่ ${E(s.number || '-')}</div></button>`).join('') || '<div class="text-xs text-slate-400 px-2 py-2">ไม่พบนักเรียน</div>');
    }
    function stuHtml() {
        return `<div class="relative mb-4"><i class="fas fa-search absolute left-4 top-1/2 -translate-y-1/2 text-slate-400"></i><input id="arcQ" oninput="window.__yaQ(this.value)" value="${E(UI.q)}" placeholder="ชื่อ / นามสกุล / รหัสนักเรียน" class="w-full bg-white border border-slate-200 rounded-2xl pl-11 pr-4 py-3 font-medium shadow-sm text-base outline-none focus:ring-2 focus:ring-indigo-400" autocomplete="off"></div>
            <div class="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-4"><div id="arcList" class="bg-white rounded-2xl border border-slate-200 shadow-sm p-2 h-max">${stuListHtml()}</div><div id="arcStu" class="space-y-4 min-w-0">${stuDetailHtml()}</div></div>`;
    }
    let qT = null;
    window.__yaQ = function (v) { UI.q = v; clearTimeout(qT); qT = setTimeout(() => { const el = document.getElementById('arcList'); if (el) el.innerHTML = stuListHtml(); }, 150); };
    window.__yaPick = function (sid) { UI.sid = sid; UI.evAll = false; const s = ARC.idx.stu[sid]; if (s && !UI.q) UI.q = s.name; const l = document.getElementById('arcList'); if (l) l.innerHTML = stuListHtml(); else { UI.tab = 'stu'; renderYearArchive(); return; } const d = document.getElementById('arcStu'); if (d) d.innerHTML = stuDetailHtml(); if (window.innerWidth < 1024 && d) d.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
    window.__yaTerm = function (t) { UI.term = t; const d = document.getElementById('arcStu'); if (d) d.innerHTML = stuDetailHtml(); };
    window.__yaEvAll = function () { UI.evAll = true; const d = document.getElementById('arcStu'); if (d) d.innerHTML = stuDetailHtml(); };
    function stuDetailHtml() {
        const s = ARC.idx.stu[UI.sid];
        if (!s) return '<div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-8 text-center text-slate-400 font-bold"><i class="fas fa-user-graduate text-3xl mb-2 block"></i>ค้นหาแล้วเลือกนักเรียนเพื่อดูประวัติ</div>';
        const P = ARC.idx.per[s.id], o = sumC(P, UI.term), p = pctOf(o), adv = advOf(s.roomId, UI.term);
        const cards = ST.map((k) => { const c = (SCLS[k]).split('|'); return `<div class="rounded-xl bg-${c[1]} border border-${c[2]} p-2 text-center"><div class="text-lg font-black text-${c[0]}">${num(o[k] || 0)}</div><div class="text-[10px] font-bold text-${c[0]}">${k}</div></div>`; }).join('');
        const rows = P ? Object.keys(P.c).filter((k) => !UI.term || k.split('|')[0] === UI.term).map((k) => { const [t, sj] = k.split('|'), c = P.c[k]; return { t, sj, c, p: pctOf(c) }; }).sort((a, b) => a.t.localeCompare(b.t) || subjName(a.sj).localeCompare(subjName(b.sj), 'th')) : [];
        const ev = P ? P.ev.filter((x) => !UI.term || x[4] === UI.term) : [], evS = UI.evAll ? ev : ev.slice(0, 30);
        return `<div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-5"><div class="flex items-start justify-between gap-3 flex-wrap"><div class="flex items-center gap-3 min-w-0"><div class="w-12 h-12 rounded-2xl bg-indigo-50 text-indigo-600 flex items-center justify-center text-xl shrink-0"><i class="fas fa-user-graduate"></i></div><div class="min-w-0"><div class="font-extrabold text-lg">${E(s.name)}</div><div class="text-xs text-slate-500 font-medium">รหัส ${E(s.code || '-')} · ${rn(s.roomId)} เลขที่ ${E(s.number || '-')}${adv ? ' · ครูที่ปรึกษา ' + E(adv) : ''}</div></div></div>
            <div class="flex gap-2 flex-wrap">${termSeg(UI.term, 'window.__yaTerm')}<button onclick="window.__yaXlsStu()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-bold text-xs"><i class="fas fa-file-excel"></i> Excel</button></div></div>
            <div class="grid grid-cols-3 sm:grid-cols-7 gap-2 mt-4">${cards}</div>
            <div class="mt-3 flex items-center gap-3"><div class="flex-1 h-2.5 bg-slate-100 rounded-full overflow-hidden"><div class="h-full ${p != null && p < 80 ? 'bg-rose-500' : 'bg-emerald-500'}" style="width:${p || 0}%"></div></div><div class="text-sm font-black ${p != null && p < 80 ? 'text-rose-600' : 'text-emerald-700'}">มาเรียน ${p == null ? '-' : p + '%'}</div></div><p class="text-[10px] text-slate-400 font-medium mt-1">% มาเรียน = (มา + ร่วมกิจกรรม + สาย) ÷ คาบที่เช็คทั้งหมด</p></div>
            <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden"><div class="px-4 sm:px-5 py-3 border-b border-slate-100 font-extrabold flex items-center gap-2"><i class="fas fa-book text-indigo-500"></i> แยกตามวิชา <span class="text-xs font-bold text-slate-400">(${UI.term ? 'ภาคเรียน ' + UI.term : 'ทั้งปี'})</span></div>
            <div class="overflow-x-auto"><table class="w-full text-sm"><thead class="bg-slate-50 text-[11px] text-slate-500"><tr><th class="text-left px-4 py-2">วิชา</th><th class="px-2">ภาค</th><th class="px-2 text-emerald-700">มา</th><th class="px-2 text-amber-600">สาย</th><th class="px-2 text-blue-600">ลา</th><th class="px-2 text-rose-600">ขาด</th><th class="px-2 text-purple-700">โดด</th><th class="px-3">% มาเรียน</th></tr></thead><tbody class="divide-y divide-slate-100 font-medium">${rows.map((r) => { const sj = ARC.idx.sub[r.sj]; return `<tr class="${r.p != null && r.p < 80 ? 'bg-rose-50/40' : ''}"><td class="px-4 py-2">${E(subjName(r.sj))}<div class="text-[11px] text-slate-400">${E((sj && sj.teacher) || '')}</div></td><td class="text-center">${E(r.t)}</td><td class="text-center">${(r.c['มา'] || 0) + (r.c['ร่วมกิจกรรม'] || 0)}</td><td class="text-center">${r.c['สาย'] || 0}</td><td class="text-center">${(r.c['ลากิจ'] || 0) + (r.c['ลาป่วย'] || 0)}</td><td class="text-center">${r.c['ขาด'] || 0}</td><td class="text-center">${r.c['โดดเรียน'] || 0}</td><td class="px-3">${pctTag(r.p)}</td></tr>`; }).join('') || '<tr><td colspan="8" class="px-4 py-4 text-center text-slate-400">ไม่มีข้อมูลการเช็คชื่อ</td></tr>'}</tbody></table></div><p class="text-[10px] text-slate-400 font-medium px-4 py-2">คอลัมน์ "มา" รวมร่วมกิจกรรม · "ลา" รวมลากิจและลาป่วย</p></div>
            <div class="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 sm:p-5"><div class="font-extrabold flex items-center gap-2 mb-3"><i class="fas fa-calendar-days text-indigo-500"></i> คาบที่ไม่ได้ "มา" <span class="text-xs font-bold text-slate-400">(ล่าสุดก่อน · ${num(ev.length)} รายการ)</span></div>
            <div class="text-sm font-medium">${evS.map((x) => `<div class="flex items-center gap-3 py-1.5 border-b border-slate-100"><span class="w-24 sm:w-28 text-xs text-slate-500 shrink-0">${thd(x[0], true)}</span><span class="w-20 text-center shrink-0">${chip(x[3])}</span><span class="min-w-0">${x[1] === 0 ? 'เข้าแถว' : x[1] < 0 ? '' : 'คาบ ' + x[1] + ' · '}${E(subjName(x[2]))}</span></div>`).join('') || '<div class="text-slate-400 text-sm">ไม่มี — มาเรียนทุกคาบ 👍</div>'}</div>
            ${ev.length > evS.length ? `<button onclick="window.__yaEvAll()" class="mt-3 text-indigo-600 font-bold text-sm">ดูทั้งหมด ${num(ev.length)} รายการ <i class="fas fa-chevron-down text-xs"></i></button>` : ''}</div>`;
    }
    // ----- รายห้อง -----
    function roomRows() {
        const room = UI.room || ARC.idx.rooms[0] || ''; UI.room = room;
        const subjF = UI.rsub ? (sj) => sj === UI.rsub : null;
        return ARC.D.students.filter((s) => s.roomId === room).sort((a, b) => (+a.number || 0) - (+b.number || 0)).map((s) => { const o = sumC(ARC.idx.per[s.id], UI.rterm, subjF); return { s, o, p: pctOf(o) }; });
    }
    function roomHtml() {
        const R = roomRows(), room = UI.room, adv = advOf(room, UI.rterm), ps = R.map((x) => x.p).filter((p) => p != null);
        const avg = ps.length ? Math.round(ps.reduce((a, b) => a + b, 0) / ps.length * 10) / 10 : null, low = ps.filter((p) => p < 80).length;
        const subs = ARC.D.subjects.filter((s) => s.roomId === room && (!UI.rterm || String(s.term) === UI.rterm)).sort((a, b) => String(a.term).localeCompare(String(b.term)) || String(a.name).localeCompare(String(b.name), 'th'));
        return `<div class="flex flex-wrap items-center gap-2 mb-4"><select onchange="window.__yaRoom(this.value)" class="bg-white border border-slate-200 rounded-xl px-3 py-2 font-bold text-sm shadow-sm">${ARC.idx.rooms.map((r) => `<option value="${E(r)}"${r === room ? ' selected' : ''}>${rn(r)}</option>`).join('')}</select>${termSeg(UI.rterm, 'window.__yaRTerm')}<select onchange="window.__yaRSub(this.value)" class="bg-white border border-slate-200 rounded-xl px-3 py-2 font-bold text-sm shadow-sm max-w-[16rem]"><option value="">ทุกวิชา</option>${subs.map((s) => `<option value="${E(s.id)}"${UI.rsub === s.id ? ' selected' : ''}>${E((s.code ? s.code + ' ' : '') + s.name)}${UI.rterm ? '' : ' (ภาค ' + E(s.term) + ')'}</option>`).join('')}</select><span class="flex-1"></span><button onclick="window.__yaXlsRoom()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-xl font-bold text-sm"><i class="fas fa-file-excel"></i> Excel</button></div>
            <div class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4"><div class="bg-white rounded-2xl border border-slate-200 p-4"><div class="text-[11px] font-bold text-slate-500">นักเรียน</div><div class="text-2xl font-black">${R.length}</div></div><div class="bg-white rounded-2xl border border-slate-200 p-4 min-w-0"><div class="text-[11px] font-bold text-slate-500">ครูที่ปรึกษา</div><div class="text-sm font-black mt-1 break-words">${E(adv || '-')}</div></div><div class="bg-white rounded-2xl border border-slate-200 p-4"><div class="text-[11px] font-bold text-slate-500">มาเรียนเฉลี่ย</div><div class="text-2xl font-black ${avg != null && avg < 80 ? 'text-rose-600' : 'text-emerald-700'}">${avg == null ? '-' : avg + '%'}</div></div><div class="rounded-2xl border ${low ? 'border-rose-200 bg-rose-50' : 'border-slate-200 bg-white'} p-4"><div class="text-[11px] font-bold ${low ? 'text-rose-600' : 'text-slate-500'}">ต่ำกว่า 80%</div><div class="text-2xl font-black ${low ? 'text-rose-600' : ''}">${low} คน</div></div></div>
            <div class="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden"><div class="overflow-x-auto"><table class="w-full text-sm"><thead class="bg-slate-50 text-[11px] text-slate-500"><tr><th class="px-3 py-2">เลขที่</th><th class="text-left px-3">ชื่อ</th><th class="px-2 text-emerald-700">มา</th><th class="px-2 text-amber-600">สาย</th><th class="px-2 text-blue-600">ลา</th><th class="px-2 text-rose-600">ขาด</th><th class="px-2 text-purple-700">โดด</th><th class="px-3">% มาเรียน</th><th></th></tr></thead><tbody class="divide-y divide-slate-100 font-medium">${R.map((x) => `<tr class="${x.p != null && x.p < 80 ? 'bg-rose-50/40' : ''}"><td class="text-center py-2">${E(x.s.number || '-')}</td><td class="px-3">${E(x.s.name)}</td><td class="text-center">${(x.o['มา'] || 0) + (x.o['ร่วมกิจกรรม'] || 0)}</td><td class="text-center">${x.o['สาย'] || 0}</td><td class="text-center">${(x.o['ลากิจ'] || 0) + (x.o['ลาป่วย'] || 0)}</td><td class="text-center">${x.o['ขาด'] || 0}</td><td class="text-center">${x.o['โดดเรียน'] || 0}</td><td class="px-3">${pctTag(x.p)}</td><td class="pr-3 text-right"><button onclick="window.__yaGoStu('${E(x.s.id)}')" class="text-indigo-600 text-xs font-bold whitespace-nowrap">ประวัติ <i class="fas fa-chevron-right"></i></button></td></tr>`).join('') || '<tr><td colspan="9" class="px-4 py-4 text-center text-slate-400">ไม่มีนักเรียนในห้องนี้</td></tr>'}</tbody></table></div></div>`;
    }
    window.__yaRoom = function (r) { UI.room = r; UI.rsub = ''; drawBody(); };
    window.__yaRTerm = function (t) { UI.rterm = t; UI.rsub = ''; drawBody(); };
    window.__yaRSub = function (v) { UI.rsub = v; drawBody(); };
    window.__yaGoStu = function (sid) { const s = ARC.idx.stu[sid]; UI.tab = 'stu'; UI.sid = sid; UI.q = s ? s.name : ''; UI.term = UI.rterm; UI.evAll = false; renderYearArchive(); window.scrollTo({ top: 0, behavior: 'smooth' }); };
    // ----- Excel -----
    function xls(sheets, file) {
        if (typeof XLSX === 'undefined') { showToast('ยังโหลดตัวสร้าง Excel ไม่เสร็จ กรุณาลองใหม่', 'error'); return; }
        const wb = XLSX.utils.book_new(); sheets.forEach(([name, rows]) => XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), name.slice(0, 31)));
        XLSX.writeFile(wb, file);
    }
    window.__yaXlsStu = function () {
        const s = ARC.idx.stu[UI.sid]; if (!s) return; const P = ARC.idx.per[s.id] || { c: {}, ev: [] }, Y = ARC.D.year, tl = UI.term ? 'ภาคเรียน ' + UI.term : 'ทั้งปี';
        const head = [[`ประวัติการมาเรียน ปีการศึกษา ${Y} (${tl}) — ${s.name} รหัส ${s.code || '-'} ${rn(s.roomId)} เลขที่ ${s.number || '-'}`], [], ['วิชา', 'ครูผู้สอน', 'ภาคเรียน'].concat(ST).concat(['% มาเรียน'])];
        const rows = Object.keys(P.c).filter((k) => !UI.term || k.split('|')[0] === UI.term).map((k) => { const [t, sj] = k.split('|'), c = P.c[k], x = ARC.idx.sub[sj]; return [subjName(sj), (x && x.teacher) || '', t].concat(ST.map((z) => c[z] || 0)).concat([pctOf(c)]); });
        const ev = [['วันที่', 'คาบ', 'วิชา', 'สถานะ', 'ภาคเรียน']].concat(P.ev.filter((x) => !UI.term || x[4] === UI.term).map((x) => [x[0], x[1], subjName(x[2]), x[3], x[4]]));
        xls([['สรุปรายวิชา', head.concat(rows)], ['คาบที่ไม่ได้มา', ev]], `ประวัติ_${s.name}_${Y}.xlsx`);
    };
    window.__yaXlsRoom = function () {
        const R = roomRows(), Y = ARC.D.year, tl = UI.rterm ? 'ภาคเรียน ' + UI.rterm : 'ทั้งปี', sj = UI.rsub ? subjName(UI.rsub) : 'ทุกวิชา';
        const rows = [[`สรุปการมาเรียน ${rn(UI.room)} ปีการศึกษา ${Y} (${tl} · ${sj})`], [], ['เลขที่', 'รหัส', 'ชื่อ-นามสกุล'].concat(ST).concat(['% มาเรียน'])].concat(R.map((x) => [x.s.number || '', x.s.code || '', x.s.name].concat(ST.map((z) => x.o[z] || 0)).concat([x.p])));
        xls([[rn(UI.room).replace('/', '-'), rows]], `สรุป_${rn(UI.room).replace('/', '-')}_${Y}.xlsx`);
    };
})();
