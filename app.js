// ==========================================================
// ระบบเช็คชื่อนักเรียนอัจฉริยะ - Application Logic
// แยกออกมาจาก index.html เพื่อให้ดูแลและแก้ไขโค้ดง่ายขึ้น
// หมายเหตุ: ไฟล์นี้ต้องถูกโหลดคู่กับ index.html เท่านั้น
// เพราะอ้างอิง element id ต่างๆ ที่อยู่ใน index.html โดยตรง
// ==========================================================

        // 🚨 นำ Web App URL ของคุณจาก Google Apps Script มาใส่ในบรรทัดด้านล่างนี้
        const GOOGLE_APP_SCRIPT_URL = "https://bnksa-attendance-api.bnkschool.workers.dev"; // ระบบเช็คชื่อรุ่นใหม่ ใช้ Cloudflare Worker แทน Google Apps Script 

        let isAdmin = false, isDbInitialized = false, currentAdminTab = 'settings', currentRoomId = null, currentSubjectId = null;
        let editingTeacherId = null, editingSubjectId = null, editingStudentId = null, editingUserId = null;
        // Data models
        let settings = { title: "ระบบเช็คชื่อนักเรียนอัจฉริยะ", faviconDataUrl: "", logoDataUrl: "", announcement: "", announcementStart: "", announcementEnd: "", announcements: [], term: "1", year: "2567", academicYears: [{ year: "2567", status: "active" }], roomCounts: { m1: 4, m2: 4, m3: 4, m4: 3, m5: 3, m6: 3 }, advisors: {}, staffs: {}, thresholds: { late: 4, absent: 4 }, storageLimitChars: 8000000, holidays: [], serverOnline: true, termLocks: {}, termCount: 2, users: [{ id: 'super_admin_root', username: 'BNKAdmin', password: '042499078', name: 'ผู้ดูแลระบบหลัก', role: 'super_admin', createdAt: new Date().toISOString() }] };
        let teachers = [], subjects = [], students = [], attendanceData = [], followUps = [], logs = [];
        let currentUser = null;
        let hubPeriods = []; // [v1.74] กิจกรรม/หยุดเรียนรายคาบจาก AcademicHub { date, mode: noclass|activity, title, grades, rooms, periods }
        let hubInterns = []; // [v2.02.0] นักศึกษาฝึกสอนจาก AcademicHub [{name, subjectIds}] — ครูสอนร่วม (ครูพี่เลี้ยงเลือกวิชาให้)
        function internNamesOf(subId) { return hubInterns.filter(x => (x.subjectIds || []).includes(subId)).map(x => x.name); }
        function internChipHtml(subId) { const n = internNamesOf(subId); return n.length ? `<span class="inline-flex items-center gap-1 ml-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-700 border border-violet-200 text-[10px] sm:text-xs font-bold whitespace-nowrap"><i class="fas fa-user-graduate"></i> นศ.ฝึกสอน ${n.map(escapeHtmlText).join(', ')}</span>` : ''; }
        let hubHolidays = []; // [v1.72.1] วันหยุดเรียนจากปฏิทิน AcademicHub (Worker เก็บไว้ให้ · แก้ที่ AcademicHub เท่านั้น)
        // ===== [v1.71.5] บัตรผ่านผู้ดูแล (token) — Worker ตรวจสิทธิ์งานของผู้ดูแลทุกครั้ง ส่วนครูเช็คชื่อ/บันทึกโฮมรูมไม่ต้องเข้าสู่ระบบเหมือนเดิม =====
        // แนบบัตรผ่านไปกับทุกคำขอที่ส่งไป Worker อัตโนมัติ (GET = ?token= · POST = __token ใน body) — ไม่ต้องแก้ทุกจุดที่เรียก fetch
        let adminToken = '';
        (function () {
            const origFetch = window.fetch.bind(window);
            window.fetch = function (input, init) {
                let withToken = false;
                try {
                    const url = typeof input === 'string' ? input : '';
                    if (adminToken && url && url.indexOf(GOOGLE_APP_SCRIPT_URL) === 0) {
                        const method = ((init && init.method) || 'GET').toUpperCase();
                        if (method === 'POST' && init && typeof init.body === 'string') {
                            const b = JSON.parse(init.body);
                            if (b && typeof b === 'object' && !Array.isArray(b)) { b.__token = adminToken; init = Object.assign({}, init, { body: JSON.stringify(b) }); withToken = true; }
                        } else if (method === 'GET') {
                            input = url + (url.indexOf('?') === -1 ? '?' : '&') + 'token=' + encodeURIComponent(adminToken); withToken = true;
                        }
                    }
                } catch (e) { /* ส่งแบบเดิม */ }
                const p = origFetch(input, init);
                if (withToken) p.then(res => { if (res && res.status === 401) setTimeout(() => window.__adminSessionExpired && window.__adminSessionExpired(), 0); }).catch(() => {});
                return p;
            };
        })();
        // ===== [ใหม่] กันสระ/วรรณยุกต์ไทยที่อยู่ใต้บรรทัด (เช่น สระอุ สระอู) โดนตัดตอนแคปภาพเป็น PDF/รูปภาพ (html2canvas) - ใส่ไว้ถาวรสำหรับทุกหน้า PDF (.a4-page) เพราะ class นี้ใช้เฉพาะตอนสร้างเอกสารส่งออกเท่านั้น ไม่กระทบการแสดงผลหน้าเว็บปกติ
        (function () { const s = document.createElement('style'); s.textContent = `.a4-page * { line-height: 2 !important; }`; document.head.appendChild(s); })();
        const statuses = {
            'มา': { color: 'text-emerald-700', bg: 'bg-emerald-50', border: 'border-emerald-200', activeBg: 'bg-emerald-500', icon: 'fa-check' },
            'ร่วมกิจกรรม': { color: 'text-cyan-700', bg: 'bg-cyan-50', border: 'border-cyan-200', activeBg: 'bg-cyan-500', icon: 'fa-running' },
            'สาย': { color: 'text-amber-600', bg: 'bg-amber-50', border: 'border-amber-200', activeBg: 'bg-amber-500', icon: 'fa-clock' },
            'ลากิจ': { color: 'text-indigo-600', bg: 'bg-indigo-50', border: 'border-indigo-200', activeBg: 'bg-indigo-500', icon: 'fa-envelope-open-text' },
            'ลาป่วย': { color: 'text-blue-600', bg: 'bg-blue-50', border: 'border-blue-200', activeBg: 'bg-blue-500', icon: 'fa-procedures' },
            'ขาด': { color: 'text-rose-600', bg: 'bg-rose-50', border: 'border-rose-200', activeBg: 'bg-rose-500', icon: 'fa-times' },
            'โดดเรียน': { color: 'text-purple-700', bg: 'bg-purple-50', border: 'border-purple-200', activeBg: 'bg-purple-600', icon: 'fa-walking' }
        };
        const STATUS_HEX = { 'มา': '#10b981', 'ร่วมกิจกรรม': '#06b6d4', 'สาย': '#f59e0b', 'ลาป่วย': '#3b82f6', 'ลากิจ': '#6366f1', 'ขาด': '#f43f5e', 'โดดเรียน': '#9333ea' };
        // ===== [ใหม่] ประเภทของวันที่ในปฏิทิน: วันหยุด (ไม่นับเป็นวันเรียนจริง) / วันกิจกรรม / วันสอบ (ยังนับเป็นวันเรียนจริง เช็คชื่อได้ปกติ) =====
        const HOLIDAY_TYPE_META = {
            holiday: { label: 'วันหยุด', activeBtn: 'border-rose-500 bg-rose-50 text-rose-700', dotHex: '#f43f5e', calCard: 'bg-rose-50 border-rose-300', calText: 'text-rose-600', calDot: 'text-rose-400', noteBg: 'bg-rose-50 border-2 border-rose-300', noteIconBg: 'bg-rose-500', noteText: 'text-rose-700' },
            activity: { label: 'วันกิจกรรม', activeBtn: 'border-sky-500 bg-sky-50 text-sky-700', dotHex: '#0ea5e9', calCard: 'bg-sky-50 border-sky-300', calText: 'text-sky-600', calDot: 'text-sky-400', noteBg: 'bg-sky-50 border-2 border-sky-300', noteIconBg: 'bg-sky-500', noteText: 'text-sky-700' },
            exam: { label: 'วันสอบ', activeBtn: 'border-amber-500 bg-amber-50 text-amber-700', dotHex: '#f59e0b', calCard: 'bg-amber-50 border-amber-300', calText: 'text-amber-600', calDot: 'text-amber-400', noteBg: 'bg-amber-50 border-2 border-amber-300', noteIconBg: 'bg-amber-500', noteText: 'text-amber-700' },
            makeup: { label: 'สอนชดเชย', activeBtn: 'border-violet-500 bg-violet-50 text-violet-700', dotHex: '#8b5cf6', calCard: 'bg-violet-50 border-violet-300', calText: 'text-violet-600', calDot: 'text-violet-400', noteBg: 'bg-violet-50 border-2 border-violet-300', noteIconBg: 'bg-violet-500', noteText: 'text-violet-700' },
        };
        const HOLIDAY_DURATION_LABEL = { morning: 'ครึ่งเช้า', afternoon: 'ครึ่งบ่าย', full: 'ตลอดวัน' };
        if (typeof Chart !== 'undefined' && typeof ChartDataLabels !== 'undefined') { Chart.register(ChartDataLabels); }
        // ===== เครื่องมือสร้างกราฟ (Chart.js) รองรับ Dark Mode และมือถือ พร้อมเปอร์เซ็นต์บนกราฟ =====
        function percentLabelFormatter(value, context) {
            const data = context.chart.data.datasets[context.datasetIndex].data;
            const total = data.reduce((a, b) => a + (Number(b) || 0), 0);
            if (!value || total === 0) return '';
            const pct = Math.round((value / total) * 100);
            return `${value} (${pct}%)`;
        }
        function chartTextColor() { return document.documentElement.classList.contains('dark') ? '#cbd5e1' : '#475569'; }
        function chartGridColor() { return document.documentElement.classList.contains('dark') ? 'rgba(148,163,184,0.12)' : 'rgba(100,116,139,0.12)'; }
        function chartBorderBg() { return document.documentElement.classList.contains('dark') ? '#141e33' : '#ffffff'; }
        function isMobileView() { return window.innerWidth < 640; }
        function makeStatusBarChart(canvasId, totals) {
            const el = document.getElementById(canvasId); if (!el || typeof Chart === 'undefined') return;
            const labels = Object.keys(totals);
            new Chart(el, { type: 'bar', data: { labels, datasets: [{ label: 'จำนวน (ครั้ง)', data: labels.map(l => totals[l] || 0), backgroundColor: labels.map(l => STATUS_HEX[l]), borderRadius: 8, maxBarThickness: 46 }] },
                options: { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 24 } }, plugins: { legend: { display: false }, tooltip: { titleFont: { size: 12 }, bodyFont: { size: 12 } },
                    datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, color: chartTextColor(), anchor: 'end', align: 'top', offset: 2, font: { weight: 'bold', size: isMobileView() ? 9 : 11 }, formatter: percentLabelFormatter } },
                    scales: { x: { ticks: { color: chartTextColor(), font: { weight: 'bold', size: isMobileView() ? 9 : 11 }, maxRotation: isMobileView() ? 60 : 0, minRotation: isMobileView() ? 60 : 0 }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: chartTextColor(), precision: 0, font: { size: 10 } }, grid: { color: chartGridColor() } } } } });
        }
        function makeStatusDoughnutChart(canvasId, totals) {
            const el = document.getElementById(canvasId); if (!el || typeof Chart === 'undefined') return;
            const legendEl = document.getElementById(canvasId + 'Legend');
            const labels = Object.keys(totals).filter(l => (totals[l] || 0) > 0);
            if (labels.length === 0) { const ctx = el.getContext('2d'); ctx.font = '13px Sarabun'; ctx.fillStyle = chartTextColor(); ctx.textAlign = 'center'; ctx.fillText('ยังไม่มีข้อมูลในเดือนนี้', el.width / 2, el.height / 2); if (legendEl) legendEl.innerHTML = ''; return; }
            const total = labels.reduce((a, l) => a + (totals[l] || 0), 0);
            new Chart(el, { type: 'doughnut', data: { labels, datasets: [{ data: labels.map(l => totals[l]), backgroundColor: labels.map(l => STATUS_HEX[l]), borderWidth: 2, borderColor: chartBorderBg() }] },
                options: { responsive: true, maintainAspectRatio: false, cutout: '60%', plugins: { legend: { display: false }, datalabels: { display: false }, tooltip: { callbacks: { label: (ctx) => { const pct = total > 0 ? Math.round((ctx.parsed / total) * 100) : 0; return ` ${ctx.label}: ${ctx.parsed} ครั้ง (${pct}%)`; } } } } } });
            if (legendEl) {
                legendEl.innerHTML = `<div class="grid grid-cols-1 sm:grid-cols-2 gap-1.5 sm:gap-2">${labels.map(l => { const count = totals[l] || 0; const pct = total > 0 ? Math.round((count / total) * 100) : 0;
                    return `<div class="flex items-center gap-2 bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-1.5 sm:px-3 sm:py-2"><span class="w-3 h-3 rounded-full shrink-0" style="background-color:${STATUS_HEX[l]}"></span><span class="font-bold text-slate-700 text-xs sm:text-sm flex-1 truncate">${l}</span><span class="font-black text-slate-800 text-xs sm:text-sm">${pct}%</span><span class="text-slate-400 text-[10px] sm:text-xs">(${count})</span></div>`; }).join('')}</div>`;
            }
        }
        function computeSchoolMonthlyStats(month) {
            let raw = {}; students.forEach(st => raw[st.id] = {});
            attendanceData.forEach(record => {
                if (!record.date || !record.date.startsWith(month)) return;
                const sub = subjects.find(s => s.id === record.subjectId); if (!sub) return;
                Object.keys(record.records || {}).forEach(stId => {
                    if (!raw[stId]) return; const status = record.records[stId]; if (!status) return;
                    if (!raw[stId][record.date]) raw[stId][record.date] = []; raw[stId][record.date].push({ period: record.period || 1, status });
                });
            });
            let totals = { 'มา': 0, 'ร่วมกิจกรรม': 0, 'สาย': 0, 'ลาป่วย': 0, 'ลากิจ': 0, 'ขาด': 0, 'โดดเรียน': 0 };
            Object.keys(raw).forEach(stId => { Object.keys(raw[stId]).forEach(date => { const dayResult = calculateDailyStatus(raw[stId][date]); if (dayResult.status && totals[dayResult.status] !== undefined) totals[dayResult.status]++; }); });
            return totals;
        }
        function computeLevelCounts() {
            let counts = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 };
            students.forEach(st => { if (st.status === 'resigned') return; const level = parseInt((st.roomId || '').split('_')[0].replace('m', '')); if (counts[level] !== undefined) counts[level]++; });
            return counts;
        }
        const periodLabel = p => (Number(p) === -2 ? 'A' : (Number(p) === 0 ? 'B' : String(p))); // [v1.71.1] คาบแยกจากการเรียน: A = เขตพื้นที่รับผิดชอบ, B = เข้าแถวเช้า (ภายในระบบยังเก็บเป็น -2 และ 0 เหมือนเดิม)
        const timeSlots = [ { period: -2, time: '07.30-08.00', name: 'เขตพื้นที่รับผิดชอบ' }, { period: 0, time: '08.00-08.30', name: 'เข้าแถวเช้า' }, { period: 1, time: '08.30-09.20' }, { period: 2, time: '09.20-10.10' }, { period: 3, time: '10.20-11.10' }, { period: 4, time: '11.10-12.00' }, { period: -1, time: '12.00-13.00', name: 'พักกลางวัน' }, { period: 5, time: '13.00-13.50' }, { period: 6, time: '13.50-14.40' }, { period: 7, time: '14.40-15.30' }, { period: 8, time: '15.30-16.20' } ];
        const daysLabel = ['วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์'];
        const daysLabelAll = (d) => ['', 'วันจันทร์', 'วันอังคาร', 'วันพุธ', 'วันพฤหัสบดี', 'วันศุกร์', 'วันเสาร์', 'วันอาทิตย์'][d] || ''; // [v2.02.1]
        // ===== [ใหม่] แปลง Date เป็นสตริง YYYY-MM-DD ตาม "เวลาท้องถิ่นของเครื่อง" (ไม่ใช่ UTC) =====
        // แก้บั๊ก: new Date().toISOString().split('T')[0] แปลงเป็นเวลา UTC เสมอ ซึ่งช้ากว่าไทย 7 ชั่วโมง
        // ทำให้ช่วง 00:00-06:59 น. ของทุกวัน ระบบจะเข้าใจผิดว่ายังเป็น "เมื่อวาน" อยู่ - ฟังก์ชันนี้ใช้ getFullYear/getMonth/getDate ซึ่งอ่านตามเวลาเครื่องจริง ไม่เลื่อนวันผิด
        function localDateStr(d) {
            d = d || new Date();
            const year = d.getFullYear();
            const month = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${year}-${month}-${day}`;
        }
        // ===== [ใหม่] หาว่า "วันที่" ที่ให้มา อยู่สัปดาห์ที่เท่าไหร่ของเดือน (นับแบบสัปดาห์ปฏิทินจริง เริ่มวันจันทร์เสมอ ไม่ใช่หารวันที่ด้วย 7 แบบเดิม) =====
        // ปัดเข้าช่องสัปดาห์ที่ 1-5 (ถ้าเดือนไหนมีสัปดาห์ที่ 6 โผล่มา เช่น เดือน 31 วันที่วันแรกตรงกับเสาร์/อาทิตย์ จะถูกยุบรวมเข้าสัปดาห์ 5 เพราะตารางมีแค่ 5 ช่อง)
        function getWeekOfMonth(dateStr) {
            const [y, m, d] = dateStr.split('-').map(Number);
            const firstDayOfWeekMon = (new Date(y, m - 1, 1).getDay() + 6) % 7; // จันทร์=0 ... อาทิตย์=6
            let week = Math.ceil((d + firstDayOfWeekMon) / 7);
            if (week > 5) week = 5;
            return week;
        }
        // ===== [ใหม่] คำนวณ "ช่วงวันที่" จริงของแต่ละสัปดาห์ในเดือนนั้น (เอาไว้แสดงเป็นคำชี้แจงใต้ตาราง) =====
        function getMonthWeekRanges(year, month) {
            const lastDay = new Date(year, month, 0).getDate();
            const ranges = {};
            for (let day = 1; day <= lastDay; day++) {
                const dStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                const week = getWeekOfMonth(dStr);
                if (!ranges[week]) ranges[week] = { start: day, end: day }; else ranges[week].end = day;
            }
            return ranges;
        }
        // ===== [ใหม่] คำนวณ "นักเรียนที่ต้องติดตาม" ของห้องหนึ่ง ในเดือนที่กำหนด - แยกออกมาจาก openRoomSummary เพื่อใช้ซ้ำได้ในแท็บ "ติดตามนักเรียน" แบบรวมทุกห้อง =====
        function computeRoomIncompleteList(roomId, selectedMonth) {
            const roomStudents = getRoomStudents(roomId).sort((a, b) => parseInt(a.number) - parseInt(b.number));
            const roomSubjects = getRoomSubjects(roomId);
            let roomDailyRaw = {}; roomStudents.forEach(st => roomDailyRaw[st.id] = {});
            attendanceData.forEach(record => { if (record.date.startsWith(selectedMonth)) { const sub = roomSubjects.find(s => s.id === record.subjectId); if (sub) { roomStudents.forEach(st => { const status = record.records[st.id];
            if (status) { if (!roomDailyRaw[st.id][record.date]) roomDailyRaw[st.id][record.date] = []; roomDailyRaw[st.id][record.date].push({ period: record.period || 1, status: status }); } }); } } });

            const INCOMPLETE_WINDOW_DAYS = 7;
            const INCOMPLETE_DAYS_THRESHOLD = (settings.thresholds && settings.thresholds.incompleteDays) || 3;
            const [selYearNum, selMonthNum] = selectedMonth.split('-').map(Number);
            const firstDayOfMonth = new Date(selYearNum, selMonthNum - 1, 1);
            const lastDayOfMonth = new Date(selYearNum, selMonthNum, 0);
            const extendedStart = new Date(firstDayOfMonth); extendedStart.setDate(extendedStart.getDate() - (INCOMPLETE_WINDOW_DAYS - 1));
            const extendedStartStr = localDateStr(extendedStart);
            const lastDayStr = localDateStr(lastDayOfMonth);
            let roomDailyRawExt = {}; roomStudents.forEach(st => roomDailyRawExt[st.id] = {});
            attendanceData.forEach(record => { if (record.date >= extendedStartStr && record.date <= lastDayStr) { const sub = roomSubjects.find(s => s.id === record.subjectId); if (sub) { roomStudents.forEach(st => { const status = record.records[st.id];
            if (status) { if (!roomDailyRawExt[st.id][record.date]) roomDailyRawExt[st.id][record.date] = []; roomDailyRawExt[st.id][record.date].push({ period: record.period || 1, status: status }); } }); } } });
            function findIncompleteTriggerDates(datesSorted) {
                const triggers = [];
                for (let i = 0; i < datesSorted.length; i++) {
                    const endDate = new Date(datesSorted[i] + 'T00:00:00');
                    const windowStart = new Date(endDate); windowStart.setDate(windowStart.getDate() - (INCOMPLETE_WINDOW_DAYS - 1));
                    let count = 0;
                    for (let j = 0; j <= i; j++) { const d = new Date(datesSorted[j] + 'T00:00:00'); if (d >= windowStart && d <= endDate) count++; }
                    if (count >= INCOMPLETE_DAYS_THRESHOLD) triggers.push(datesSorted[i]);
                }
                return triggers;
            }
            let studentSummaries = [];
            const LATE_MONTHLY_THRESHOLD = (settings.thresholds && settings.thresholds.late) || 4;
            const ABSENT_MONTHLY_THRESHOLD = (settings.thresholds && settings.thresholds.absent) || 4;
            roomStudents.forEach(st => {
                let sStats = { 'มา': 0, 'ร่วมกิจกรรม': 0, 'สาย': 0, 'ลาป่วย': 0, 'ลากิจ': 0, 'ขาด': 0, 'โดดเรียน': 0 }, wStats = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
                let incompleteDays = [];
                Object.keys(roomDailyRaw[st.id]).sort().forEach(date => { const dayResult = calculateDailyStatus(roomDailyRaw[st.id][date]); const dayStatus = dayResult.status; if (dayStatus) { sStats[dayStatus]++; if (dayStatus === 'มา' || dayStatus === 'ร่วมกิจกรรม' || dayStatus === 'สาย') { const week = getWeekOfMonth(date); wStats[week]++; } if (dayResult.incomplete) incompleteDays.push({ date, missingCount: dayResult.missingCount }); } });
                const extIncompleteDatesSorted = Object.keys(roomDailyRawExt[st.id]).sort().filter(date => calculateDailyStatus(roomDailyRawExt[st.id][date]).incomplete);
                const triggerDatesThisMonth = findIncompleteTriggerDates(extIncompleteDatesSorted).filter(d => d.startsWith(selectedMonth));
                const lateExceeded = sStats['สาย'] >= LATE_MONTHLY_THRESHOLD;
                const absentExceeded = sStats['ขาด'] >= ABSENT_MONTHLY_THRESHOLD;
                studentSummaries.push({ student: st, monthly: sStats, weekly: wStats, incompleteDays, triggerDatesThisMonth, lateExceeded, absentExceeded });
            });
            const incompleteAttendanceList = studentSummaries.filter(row => row.triggerDatesThisMonth.length > 0 || row.lateExceeded || row.absentExceeded);
            let roomTotals = { 'มา': 0, 'ร่วมกิจกรรม': 0, 'สาย': 0, 'ลาป่วย': 0, 'ลากิจ': 0, 'ขาด': 0, 'โดดเรียน': 0 };
            studentSummaries.forEach(row => { Object.keys(roomTotals).forEach(k => roomTotals[k] += (row.monthly[k] || 0)); });
            return { studentSummaries, incompleteAttendanceList, roomTotals };
        }
        const SUBJECT_DAY_MAP = { 'จันทร์': 1, 'จ': 1, 'อังคาร': 2, 'อ': 2, 'พุธ': 3, 'พ': 3, 'พฤหัสบดี': 4, 'พฤหัส': 4, 'พฤ': 4, 'ศุกร์': 5, 'ศ': 5 };
        function parseScheduleString(str) {
            if (!str) return [];
            const schedules = [];
            String(str).split(',').forEach(part => {
                const seg = part.trim(); if (!seg) return;
                const m = seg.split('-'); if (m.length < 2) return;
                const dayKey = m[0].trim().replace(/^วัน/, '');
                const day = SUBJECT_DAY_MAP[dayKey];
                const pRaw = m[1].trim().toUpperCase(); const period = (pRaw === 'A' || pRaw === '00') ? -2 : (pRaw === 'B' ? 0 : parseInt(pRaw));
                if (day && !isNaN(period) && (period === -2 || (period >= 0 && period <= 8))) schedules.push({ day, period });
            });
            return schedules;
        }

        // Department Configuration
        const deptConfig = {
            "คณิตศาสตร์": { bg: "bg-blue-100", text: "text-blue-600", border: "border-blue-200", hover: "hover:bg-blue-50", icon: "fa-calculator" },
            "วิทยาศาสตร์และเทคโนโลยี": { bg: "bg-emerald-100", text: "text-emerald-600", border: "border-emerald-200", hover: "hover:bg-emerald-50", icon: "fa-flask" },
            "ภาษาไทย": { bg: "bg-amber-100", text: "text-amber-600", border: "border-amber-200", hover: "hover:bg-amber-50", icon: "fa-book" },
            "ภาษาต่างประเทศ": { bg: "bg-rose-100", text: "text-rose-600", border: "border-rose-200", hover: "hover:bg-rose-50", icon: "fa-language" },
            "สังคมศึกษา ศาสนา และวัฒนธรรม": { bg: "bg-orange-100", text: "text-orange-600", border: "border-orange-200", hover: "hover:bg-orange-50", icon: "fa-globe-asia" },
            "สุขศึกษาและพลศึกษา": { bg: "bg-cyan-100", text: "text-cyan-600", border: "border-cyan-200", hover: "hover:bg-cyan-50", icon: "fa-running" },
            "ศิลปะ": { bg: "bg-purple-100", text: "text-purple-600", border: "border-purple-200", hover: "hover:bg-purple-50", icon: "fa-palette" },
            "การงานอาชีพ": { bg: "bg-teal-100", text: "text-teal-600", border: "border-teal-200", hover: "hover:bg-teal-50", icon: "fa-tools" },
            "ระบบ/อื่นๆ": { bg: "bg-slate-100", text: "text-slate-600", border: "border-slate-200", hover: "hover:bg-slate-50", icon: "fa-cog" }
        };
        const departmentsList = Object.keys(deptConfig);

        function generateId() { return Math.random().toString(36).substr(2, 9); }
        function formatRoomName(roomId) { const match = roomId?.match(/m(\d+)_(\d+)/); return match ? `ม.${match[1]}/${match[2]}` : (roomId || '-'); }
        function getRoomList() { let rooms = []; for (let i = 1; i <= 6; i++) { let count = settings.roomCounts[`m${i}`] || 0; for (let j = 1; j <= count; j++) { rooms.push(`m${i}_${j}`); } } return rooms; }

        // ===== Term/Year scoping helpers (ภาคเรียน/ปีการศึกษา) =====
        const WEEKLY_SLOTS_TOTAL = 45; // 5 วัน x 9 คาบ (0-8 ไม่รวมพักเที่ยง)
        // ภาคเรียนที่แอดมินกำลังจัดการข้อมูลอยู่ในหน้าแอดมิน — เก็บไว้เฉพาะ session/เครื่องของแอดมินคนนั้น
        // ไม่ถูกบันทึกลงเซิร์ฟเวอร์ และไม่กระทบสิ่งที่ผู้ใช้ทั่วไปเห็นที่หน้าแรก ทำให้แอดมินหลายคนจัดการคนละภาคเรียนพร้อมกันได้อย่างอิสระ
        let adminWorkingTerm = null;
        let adminWorkingYear = null;
        function adminTerm() { return adminWorkingTerm || settings.term; }
        function adminYear() { return adminWorkingYear || settings.year; } // ปีที่แอดมินกำลังจัดการอยู่ - แยกอิสระจากปีที่แสดงผลหน้าแรก (settings.year) เพื่อให้เตรียมข้อมูลปีใหม่ล่วงหน้าได้โดยไม่กระทบผู้ใช้ทั่วไป
        // ===== ทะเบียนปีการศึกษา (settings.academicYears) — แต่ละปีมีสถานะ 'active' (พร้อมใช้งาน) หรือ 'archived' (ถูกจัดเก็บแล้ว/ล็อค) =====
        function getYearStatus(year) {
            if (!settings.academicYears) return 'active';
            const entry = settings.academicYears.find(y => String(y.year) === String(year));
            return entry ? entry.status : 'active';
        }
        function sortedAcademicYears() {
            const isSuperAdminNow = currentUser && currentUser.role === 'super_admin';
            let list = (settings.academicYears || []).slice();
            if (!isSuperAdminNow) list = list.filter(y => !y.hidden); // ซ่อนปีที่ Super Admin ปิดไว้จากแอดมินทั่วไปทุกจุดที่ใช้ฟังก์ชันนี้ (ตัวเลือกภาคเรียน/ปีในแถบแอดมิน, แท็บตั้งค่าภาคเรียน, แท็บสำรองข้อมูล ฯลฯ)
            return list.sort((a, b) => String(b.year).localeCompare(String(a.year)));
        }
        // ภาคเรียนที่ผู้ใช้ทั่วไป/แอดมินเลือก "ดูตัวอย่าง" ชั่วคราวที่หน้าแรก — ไม่บันทึกลงเซิร์ฟเวอร์ รีเฟรชหน้าเว็บแล้วจะรีเซ็ตกลับไปภาคเรียนที่แอดมินตั้งไว้ (settings.term) เสมอ
        let guestPreviewTerm = null;
        function viewTerm() { return guestPreviewTerm || settings.term; } // ภาคเรียนที่ใช้แสดงผล/เรียกดูข้อมูลฝั่งผู้ใช้ทั่วไป (หน้าแรก, ห้องเรียน, รายงาน)
        function termKeyOf(term, year) { return `${term ?? settings.term}_${year ?? settings.year}`; }
        // สถานะภาคเรียน 3 แบบ: 'open' เปิดใช้งานปกติ, 'not_opened' ยังไม่เปิดใช้งาน (ผู้ใช้ทั่วไปสลับเข้ามาไม่ได้), 'locked' ล็อคข้อมูล (ปิดแล้ว แต่ดูย้อนหลังได้)
        function getTermStatus(term, year) {
            const v = settings.termLocks && settings.termLocks[termKeyOf(term, year)];
            if (v === true) return 'locked'; // ข้อมูลเก่า (boolean) แปลงเป็นสถานะล็อค
            if (v === 'open' || v === 'not_opened' || v === 'locked' || v === 'maintenance') return v;
            return 'open';
        }
        function publicTermStatus() { return getTermStatus(settings.term, settings.year); } // สถานะของภาคเรียนที่บังคับแสดงผลหน้าแรกสำหรับผู้ใช้ทั่วไป
        function adminTermStatus() { return getTermStatus(adminTerm(), adminYear()); } // สถานะของภาคเรียนที่แอดมินกำลังจัดการอยู่ในหน้าแอดมิน
        function currentTermStatus() { return publicTermStatus(); } // ใช้ที่หน้าแรกเท่านั้น (คงชื่อเดิมไว้เพื่อความเข้ากันได้)
        function currentTermLocked() { return publicTermStatus() === 'locked'; }
        // ล็อคเฉพาะสถานะ "locked" (เก็บถาวร) เท่านั้นที่ห้ามแก้ไขข้อมูลวิชา ส่วน "not_opened"/"maintenance" แอดมินยังแก้ไขข้อมูลได้ตามปกติ (ล็อคแค่การเช็คชื่อ) - อ้างอิงจากภาคเรียนที่แอดมินกำลังจัดการอยู่
        function guardTermLock(actionLabel) { if (adminTermStatus() === 'locked') { showToast(`ภาคเรียน ${adminTerm()}/${adminYear()} ถูกล็อคข้อมูลไว้ (เก็บถาวร) ไม่สามารถ${actionLabel || 'แก้ไขข้อมูล'}ได้`, "error"); return true; } return false; }
        // การเช็คชื่ออนุญาตเฉพาะเมื่อภาคเรียนนั้น "เปิดใช้งาน" (open) เท่านั้น
        function guardAttendanceLock(term, year) {
            const status = getTermStatus(term, year);
            if (status === 'open') return false;
            const msg = status === 'not_opened' ? `ภาคเรียน ${term}/${year} ยังไม่เปิดใช้งาน ไม่สามารถเช็คชื่อได้`
                : status === 'maintenance' ? `ภาคเรียน ${term}/${year} ปิดปรับปรุงชั่วคราว ไม่สามารถเช็คชื่อได้ในขณะนี้ (ข้อมูลอื่นยังดูได้ตามปกติ)`
                : `ภาคเรียน ${term}/${year} ถูกล็อคข้อมูลไว้แล้ว ไม่สามารถเช็คชื่อได้ (ดูข้อมูลย้อนหลังได้)`;
            showToast(msg, "error"); return true;
        }
        // ใช้เช็คว่าควรล็อค "ปุ่มเช็คชื่อ" (ทั้งปุ่มเข้าไปเช็คชื่อ และปุ่มบันทึกในหน้าเช็คชื่อ) หรือไม่
        // ต่างจาก guardTermLock ตรงที่ maintenance ก็ล็อคปุ่มนี้ด้วย แม้ข้อมูล/การแก้ไขวิชาอื่นๆ จะยังใช้งานได้ตามปกติ
        function isAttendanceEntryLocked(term, year) {
            const status = getTermStatus(term, year);
            return status === 'locked' || status === 'maintenance' || status === 'not_opened';
        }
        function termStatusCardConfig(status) {
            if (status === 'open') return { wrap: 'bg-emerald-50 border-emerald-300', dot: 'bg-emerald-500 animate-pulse', icon: 'fa-wifi', iconCls: 'text-emerald-600', text: 'ระบบเปิดให้ใช้งานสำหรับภาคเรียนนี้', textCls: 'text-emerald-800' };
            if (status === 'not_opened') return { wrap: 'bg-slate-100 border-slate-300', dot: 'bg-slate-400', icon: 'fa-power-off', iconCls: 'text-slate-500', text: 'ระบบยังไม่เปิดให้ใช้งานสำหรับภาคเรียนนี้', textCls: 'text-slate-600' };
            if (status === 'maintenance') return { wrap: 'bg-amber-50 border-amber-300', dot: 'bg-amber-500 animate-pulse', icon: 'fa-tools', iconCls: 'text-amber-600', text: 'ปิดปรับปรุงชั่วคราว - ดูข้อมูลได้ตามปกติ แต่เช็คชื่อไม่ได้ในขณะนี้', textCls: 'text-amber-800' };
            return { wrap: 'bg-blue-50 border-blue-300', dot: 'bg-blue-400', icon: 'fa-box-archive', iconCls: 'text-blue-600', text: 'ระบบปิดให้ใช้งานสำหรับภาคเรียนนี้แล้ว แต่สามารถดูข้อมูลได้', textCls: 'text-blue-800' };
        }
        // วิชาที่ยังไม่มี term/year (ข้อมูลเก่า) ให้ถือว่าอยู่ในภาคเรียน/ปีที่ระบุเสมอ (ป้องกันข้อมูลหาย)
        // ค่าเริ่มต้น (ไม่ระบุ term/year) จะอ้างอิงตาม viewTerm() เพื่อให้รองรับการดูตัวอย่างภาคเรียนอื่นชั่วคราวที่หน้าแรก
        function isActiveSubject(s, term, year) { term = term ?? viewTerm(); year = year ?? settings.year; return String(s.term ?? settings.term) === String(term) && String(s.year ?? settings.year) === String(year); }
        function activeSubjects(term, year) { return subjects.filter(s => isActiveSubject(s, term, year)); }
        function getRoomSubjects(roomId, term, year) { return activeSubjects(term, year).filter(s => s.roomId === roomId); }
        // นักเรียนที่ไม่มีปีระบุ (ข้อมูลเก่าก่อนรองรับการเลื่อนชั้น) ถือว่าอยู่ได้ทุกปีการศึกษา (ไม่กระทบข้อมูลเดิม)
        // นักเรียนที่ถูกเลื่อนชั้นแล้วจะมีปีระบุชัดเจน และแสดงเฉพาะปีการศึกษานั้นๆ
        // [v1.76] เลขประจำตัวนักเรียน (student.code) — แสดงตัวเล็กใต้ชื่อ
        const stuCodeHtml = (st) => st && st.code ? `<span class="w-full block text-[10px] sm:text-xs font-semibold text-slate-400 font-mono tracking-wide leading-tight">${hrEsc(st.code)}</span>` : '';
        const stuCodePdf = (st) => st && st.code ? ` <span style="font-weight:400; color:#64748b; font-size:0.85em;">(${hrEsc(st.code)})</span>` : '';
        // [v1.76] รายชื่อครูให้เลือก: เรียงตามตัวอักษร · ไม่รวมย้ายออก และหมวด "ระบบ/อื่นๆ"
        const pickableTeachers = () => teachers.filter(t => !t.inactive && (t.department || '') !== 'ระบบ/อื่นๆ').slice().sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'));
        // [v2.00.6] status 'hidden' = ซ่อน (เช่น นักเรียนแขวนลอย) — ไม่ขึ้นหน้าเช็คชื่อ/รายงาน · หลังบ้านเห็น (withHidden = true)
        function getRoomStudents(roomId, year, withHidden) { year = year ?? settings.year; return students.filter(s => s.roomId === roomId && (withHidden || s.status !== 'hidden') && (s.year === undefined || s.year === null || String(s.year) === String(year))); }
        // ครูที่ปรึกษา/เจ้าหน้าที่ประจำห้อง แยกเก็บตามภาคเรียน - รองรับข้อมูลเก่า (ก่อนแยกภาคเรียน) เป็นค่าสำรอง
        // หาข้อมูล (ครูที่ปรึกษา/เจ้าหน้าที่) ของห้องนี้จากภาคเรียน/ปีอื่นที่มีอยู่ ใกล้เคียงเป้าหมายที่สุดตามเวลา (ปีเดียวกันก่อน แล้วค่อยปีก่อนหน้า)
        // ใช้สำหรับ "คัดลอกข้อมูลเดิมมาก่อน" เวลาเปลี่ยนภาคเรียน/ปีที่ยังไม่เคยมีการตั้งค่าไว้ แอดมินจะได้ไม่ต้องเริ่มกรอกใหม่จากศูนย์
        function findNearestPersonnelData(registry, roomId, term, year) {
            if (!registry) return null;
            const targetYearNum = parseInt(year), targetTermNum = parseInt(term);
            const keys = Object.keys(registry).filter(k => registry[k] && registry[k][roomId]);
            if (keys.length === 0) return null;
            keys.sort((a, b) => {
                const [aTerm, aYear] = a.split('_'); const [bTerm, bYear] = b.split('_');
                const aYearDiff = Math.abs(parseInt(aYear) - targetYearNum), bYearDiff = Math.abs(parseInt(bYear) - targetYearNum);
                if (aYearDiff !== bYearDiff) return aYearDiff - bYearDiff;
                return Math.abs(parseInt(aTerm) - targetTermNum) - Math.abs(parseInt(bTerm) - targetTermNum);
            });
            return registry[keys[0]][roomId];
        }
        function getRoomAdvisors(roomId, term, year) {
            term = term ?? viewTerm(); year = year ?? settings.year;
            const key = termKeyOf(term, year);
            if (settings.advisors && settings.advisors[key] && settings.advisors[key][roomId]) return settings.advisors[key][roomId];
            if (settings.advisors && Array.isArray(settings.advisors[roomId])) return settings.advisors[roomId]; // ข้อมูลเก่าก่อนแยกภาคเรียน
            const nearest = findNearestPersonnelData(settings.advisors, roomId, term, year);
            if (nearest) return nearest;
            return ["", ""];
        }
        // ===== [ใหม่] สร้างคาบระบบอัตโนมัติต่อห้อง: "เข้าแถวเช้า" (คาบ 0) และ "โฮมรูม" - ครูที่ปรึกษาเป็นผู้สอน ลบไม่ได้ แต่แก้ไขหน่วยกิต/ตารางได้ =====
        function ensureSystemSubjectsForRoom(roomId, term, year) {
            const existing = getRoomSubjects(roomId, term, year);
            const advisors = getRoomAdvisors(roomId, term, year).filter(Boolean);
            const advisorName = advisors[0] || '';
            let changed = false;
            if (!existing.some(s => s.systemType === 'morning')) {
                subjects.push({ id: generateId(), roomId, name: 'เข้าแถวเช้า', code: '', teacher: advisorName, teacher2: advisors[1] || '', credits: 0.5, schedules: [1,2,3,4,5].map(d => ({ day: d, period: 0 })), term, year, locked: true, systemType: 'morning', sched171: true });
                changed = true;
            }
            if (!existing.some(s => s.systemType === 'zone')) {
                subjects.push({ id: generateId(), roomId, name: 'เขตพื้นที่รับผิดชอบ', code: '', teacher: advisorName, teacher2: advisors[1] || '', credits: 0, schedules: [1,2,3,4,5].map(d => ({ day: d, period: -2 })), term, year, locked: true, systemType: 'zone' });
                changed = true;
            }
            // [v1.74.6] คาบระบบ (เข้าแถว/เขตพื้นที่/โฮมรูม) ใช้ครูที่ปรึกษาปัจจุบันของห้องเสมอ — เปลี่ยนครูที่ปรึกษาแล้วคาบระบบเปลี่ยนตาม
            if (advisorName) existing.filter(s => s.systemType === 'morning' || s.systemType === 'zone' || s.systemType === 'homeroom').forEach(s => {
                const t2 = advisors[1] || '';
                if (s.teacher !== advisorName || (s.teacher2 || '') !== t2) { s.teacher = advisorName; s.teacher2 = t2; changed = true; }
            });
            if (!existing.some(s => s.systemType === 'homeroom')) {
                subjects.push({ id: generateId(), roomId, name: 'โฮมรูม', code: '', teacher: advisorName, teacher2: advisors[1] || '', credits: 0.5, schedules: [1,2,3,4,5].map(d => ({ day: d, period: 8 })), term, year, locked: true, systemType: 'homeroom', sched171: true });
                changed = true;
            } else {
                // ซิงก์ชื่อคาบระบบเดิมที่เคยสร้างไว้แล้วให้ตรงกับชื่อปัจจุบัน (ชื่อคาบระบบแก้เองไม่ได้อยู่แล้ว จึงซิงก์ให้ตรงเสมอได้อย่างปลอดภัย)
                const hr = existing.find(s => s.systemType === 'homeroom');
                if (hr && hr.name !== 'โฮมรูม') { hr.name = 'โฮมรูม'; changed = true; }
                // [v1.71] ย้ายโฮมรูมเดิม (คาบ 0 วันศุกร์) ไปเป็นคาบ 8 ทุกวัน - ทำครั้งเดียว หลังจากนี้แอดมินแก้ตารางเองได้ตามปกติ
                if (hr && !hr.sched171) { hr.schedules = [1,2,3,4,5].map(d => ({ day: d, period: 8 })); hr.sched171 = true; changed = true; }
            }
            {
                // [v1.71] เข้าแถวเช้าเป็นคาบ 0 ทุกวันจันทร์-ศุกร์ - เติมวันที่ขาดให้ครั้งเดียว
                const mo = getRoomSubjects(roomId, term, year).find(s => s.systemType === 'morning');
                if (mo && !mo.sched171) { const have = new Set((mo.schedules || []).map(sc => parseInt(sc.day) + '-' + parseInt(sc.period))); [1,2,3,4,5].forEach(d => { if (!have.has(d + '-0')) (mo.schedules = mo.schedules || []).push({ day: d, period: 0 }); }); mo.sched171 = true; changed = true; }
            }
            return changed;
        }
        function getRoomStaff(roomId, term, year) {
            term = term ?? viewTerm(); year = year ?? settings.year;
            const key = termKeyOf(term, year);
            if (settings.staffs && settings.staffs[key] && settings.staffs[key][roomId]) return settings.staffs[key][roomId];
            if (settings.staffs && typeof settings.staffs[roomId] === 'string' && settings.staffs[roomId]) return settings.staffs[roomId]; // ข้อมูลเก่าก่อนแยกภาคเรียน
            const nearest = findNearestPersonnelData(settings.staffs, roomId, term, year);
            if (nearest) return nearest;
            return '';
        }
        // true = ค่าที่ได้จาก getRoomAdvisors/getRoomStaff เป็นการคัดลอกมาจากภาคเรียน/ปีอื่น (ยังไม่เคยบันทึกไว้จริงสำหรับภาคเรียน/ปีนี้)
        function isPersonnelDataCopied(roomId, term, year) {
            const key = termKeyOf(term, year);
            const hasAdv = settings.advisors && settings.advisors[key] && settings.advisors[key][roomId];
            const hasStaff = settings.staffs && settings.staffs[key] && settings.staffs[key][roomId];
            return !hasAdv && !hasStaff;
        }
        // ===== [v1.71] คาบระบบ (เข้าแถว/โฮมรูม/เขตพื้นที่) ที่มีวิชาปกติลงทับในช่องเดียวกัน ถือว่า "สอนวิชานั้นแทน" - ตัดช่องนั้นออกจากตารางของคาบระบบ =====
        function effSched(s) {
            const list = (s && s.schedules) || [];
            if (!s || !s.systemType) return list;
            const others = subjects.filter(o => o.roomId === s.roomId && !o.systemType && o.id !== s.id && String(o.term) === String(s.term) && String(o.year) === String(s.year));
            if (others.length === 0) return list;
            return list.filter(sch => !others.some(o => (o.schedules || []).some(os => parseInt(os.day) === parseInt(sch.day) && parseInt(os.period) === parseInt(sch.period))));
        }
        function computeRoomScheduleStatus(roomId, term, year) { const list = getRoomSubjects(roomId, term, year); const filled = new Set(); list.forEach(s => (s.schedules || []).forEach(sch => { if (parseInt(sch.period) !== -2) filled.add(sch.day + '-' + sch.period); })); return { filled: filled.size, total: WEEKLY_SLOTS_TOTAL, done: filled.size >= WEEKLY_SLOTS_TOTAL, count: list.length }; }
        function findDuplicateSubjectsInRoom(roomId, term, year) {
            const list = getRoomSubjects(roomId, term, year); const dupIds = new Set();
            for (let i = 0; i < list.length; i++) { for (let j = i + 1; j < list.length; j++) {
                const a = list[i], b = list[j];
                if (a.systemType || b.systemType) continue; // โฮมรูมไม่นับว่าซ้ำกับวิชาใดๆ
                const sameTeacher = (a.teacher || '').trim() === (b.teacher || '').trim();
                const sameCode = (a.code || '').trim() === (b.code || '').trim();
                const sameName = (a.name || '').trim() === (b.name || '').trim();
                // แจ้งเตือนเฉพาะเมื่อซ้ำครบทั้ง 3 อย่าง (ครูผู้สอน + รหัสวิชา + ชื่อวิชา) เท่านั้น
                if (sameTeacher && sameCode && sameName) { dupIds.add(a.id); dupIds.add(b.id); }
            } }
            return dupIds;
        }
        // [v2.01.0] ประเภทครู: ครูต่างชาติ — ป้ายเฉพาะวิชาที่เป็นครูผู้สอนหลัก (ไม่รวมสอนร่วม)
        function isForeignTeacher(name) { const n = String(name || '').trim(); if (!n) return false; const t = teachers.find(x => x.name === n); return !!(t && t.foreign); }
        function isForeignSubject(s) { return !!s && !s.systemType && isForeignTeacher(s.teacher); }
        const FOREIGN_TAG = '<span style="display:inline-block;background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;border-radius:6px;padding:0 5px;font-size:9px;font-weight:800;margin-left:4px;vertical-align:1px;line-height:1.5">ครูต่างชาติ</span>';
        window.tcSetType = function (f) { document.querySelectorAll('input[name="newTcType"]').forEach(r => { r.checked = r.value === (f ? 'foreign' : 'th'); }); };
        function getTeacherDept(name) { const t = teachers.find(x => x.name === name); return t ? (t.department || 'ระบบ/อื่นๆ') : ''; }
        // หาคาบสอนที่ชนกันของครูคนเดียวกัน (ยกเว้นกลุ่มสาระ "ระบบ/อื่นๆ" ที่ให้ซ้ำได้ และวิชาโฮมรูมซึ่งไม่นับว่าชนกับวิชาใดๆ)
        function findTeacherConflicts(term, year) {
            const map = {};
            activeSubjects(term, year).forEach(s => {
                if (s.systemType) return; // โฮมรูม/เขตพื้นที่ไม่นับว่าซ้ำ/ชนกับวิชาใดๆ
                ['teacher', 'teacher2'].forEach(field => {
                    const tname = s[field]; if (!tname) return;
                    if (getTeacherDept(tname) === 'ระบบ/อื่นๆ') return;
                    (s.schedules || []).forEach(sch => {
                        const key = tname + '|' + sch.day + '|' + sch.period;
                        if (!map[key]) map[key] = [];
                        map[key].push({ subjectId: s.id, roomId: s.roomId, name: s.name, teacher: tname, day: sch.day, period: sch.period });
                    });
                });
            });
            return Object.values(map).filter(arr => arr.length > 1);
        }
        function subjectHasConflict(subjectId, term, year) { return findTeacherConflicts(term, year).some(group => group.some(g => g.subjectId === subjectId)); }
        function computePendingNotifications() {
            // แถบแจ้งเตือนนี้แสดงเฉพาะในหน้าแอดมิน จึงอ้างอิงจากภาคเรียนที่แอดมินกำลังจัดการข้อมูลอยู่
            const term = adminTerm(), year = adminYear();
            const items = []; const roomList = getRoomList();
            roomList.forEach(r => {
                const st = computeRoomScheduleStatus(r, term, year);
                if (!st.done) items.push({ type: 'incomplete', text: `ห้อง ${formatRoomName(r)} ยังลงวิชาไม่ครบตาราง (${st.filled}/${st.total} คาบ)`, action: () => { window.adminSelectedSubjectRoom = r; window.navigate('admin', { tab: 'subjects' }); } });
                const dupes = findDuplicateSubjectsInRoom(r, term, year);
                if (dupes.size > 0) items.push({ type: 'duplicate', text: `ห้อง ${formatRoomName(r)} มีรายวิชาซ้ำกัน ${dupes.size} รายการ`, action: () => { window.adminSelectedSubjectRoom = r; window.navigate('admin', { tab: 'subjects' }); } });
                const activeStu = getRoomStudents(r).filter(s => s.status !== 'resigned');
                if (activeStu.length === 0) items.push({ type: 'nostudents', text: `ห้อง ${formatRoomName(r)} ยังไม่มีรายชื่อนักเรียน`, action: () => { window.adminSelectedRoom = r; window.navigate('admin', { tab: 'students' }); } });
                const advisorsChk = getRoomAdvisors(r, term, year);
                const hasAdvisor = Array.isArray(advisorsChk) && advisorsChk.some(a => a && String(a).trim());
                if (!hasAdvisor) items.push({ type: 'noadvisor', text: `ห้อง ${formatRoomName(r)} ยังไม่มีครูที่ปรึกษา`, action: () => { window.navigate('admin', { tab: 'advisors' }); } });
                const staffChk = getRoomStaff(r, term, year);
                if (!staffChk || !String(staffChk).trim()) items.push({ type: 'nostaff', text: `ห้อง ${formatRoomName(r)} ยังไม่มีเจ้าหน้าที่ประจำห้อง`, action: () => { window.navigate('admin', { tab: 'advisors' }); } });
            });
            findTeacherConflicts(term, year).forEach(group => {
                const t = group[0].teacher;
                const daysTxt = group.map(g => `${daysLabel[g.day - 1].replace('วัน', '')} คาบ ${periodLabel(g.period)} (${formatRoomName(g.roomId)} · ${g.name})`).join(', ');
                items.push({ type: 'conflict', text: `ครู ${t} มีวิชาสอนชนกัน: ${daysTxt}`, action: () => { window.navigate('admin', { tab: 'subjects' }); } });
            });
            return items;
        }

        // สรุปสถานะ "ทั้งวัน" ของนักเรียน 1 คน จากรายการเช็คชื่อทุกคาบในวันนั้น
        // อัลกอริทึมตามที่ตกลงกัน:
        //   1) ถ้าคาบ 0 (เข้าแถว) = ขาด แต่มีคาบอื่นในวันเดียวกัน = มา/ร่วมกิจกรรม/สาย -> ถือคาบ 0 เป็น "สาย" (มาโรงเรียนแต่ไม่ทันเข้าแถว)
        //   2) ไล่ลำดับความสำคัญ: มา/ร่วมกิจกรรม > (ลาป่วย/ลากิจ ถ้าถึงเกณฑ์ leaveOverride ให้ชนะสาย/ขาด) > สาย > (ลาป่วย/ลากิจ ไม่ถึงเกณฑ์) > ขาด > โดดเรียน
        //      [เหตุผล: ถ้าคาบ 0 เช็คว่าสาย/ขาดไว้ก่อน (ยังไม่รู้เหตุผล) แต่พอถึงเวลาเรียนจริงมีคาบลาป่วย/ลากิจยืนยันมากพอ ควรถือว่าทั้งวันเป็นลาป่วย/ลากิจ ไม่ใช่สาย/ขาด]
        //   3) ถ้าผลสรุป = มา/สาย แต่มีคาบที่ไม่ใช่มา/ร่วมกิจกรรม/สาย ตั้งแต่ 4 คาบขึ้นไป -> ติดธง "เข้าเรียนไม่ครบ"
        // คืนค่าเป็น object {status, incomplete, missingCount} เสมอ (ไม่ใช่ string เปล่าๆ แบบเดิม)
        function calculateDailyStatus(recordsArray) {
            if (recordsArray) recordsArray = recordsArray.filter(r => parseInt(r.period) !== -2); // คาบ A (เขตพื้นที่รับผิดชอบ) แยกรายงานต่างหาก ไม่นับรวมสถานะรายวัน/สมุดทะเบียน
            if (!recordsArray || recordsArray.length === 0) return { status: null, incomplete: false, missingCount: 0 };
            const p0Record = recordsArray.find(r => parseInt(r.period) === 0);
            const otherRecords = recordsArray.filter(r => parseInt(r.period) !== 0);
            const otherHasPresence = otherRecords.some(r => r.status === 'มา' || r.status === 'ร่วมกิจกรรม' || r.status === 'สาย');
            let effectiveRecords = recordsArray;
            if (p0Record && p0Record.status === 'ขาด' && otherHasPresence) {
                effectiveRecords = recordsArray.map(r => (parseInt(r.period) === 0) ? { ...r, status: 'สาย' } : r);
            }
            let hasPresent = false, hasLate = false, sickCount = 0, leaveCount = 0, hasAbsent = false, hasSkip = false, missingCount = 0;
            effectiveRecords.forEach(r => {
                const s = r.status;
                if (s === 'มา' || s === 'ร่วมกิจกรรม') hasPresent = true;
                else if (s === 'สาย') hasLate = true;
                else if (s === 'ลาป่วย') { sickCount++; missingCount++; }
                else if (s === 'ลากิจ') { leaveCount++; missingCount++; }
                else if (s === 'ขาด') { hasAbsent = true; missingCount++; }
                else if (s === 'โดดเรียน') { hasSkip = true; missingCount++; }
            });
            const LEAVE_OVERRIDE_THRESHOLD = (settings.thresholds && settings.thresholds.leaveOverride) || 4;
            const leaveWinsOverLateAbsent = (sickCount + leaveCount) >= LEAVE_OVERRIDE_THRESHOLD;
            let status;
            if (hasPresent) status = 'มา';
            else if (hasLate && leaveWinsOverLateAbsent) status = (leaveCount > sickCount) ? 'ลากิจ' : 'ลาป่วย';
            else if (hasLate) status = 'สาย';
            else if (hasAbsent) status = 'ขาด'; // เช็คขาดคือขาดไปเลย - ลาป่วย/ลากิจ (แจ้งทีหลัง) ไม่สามารถชนะขาดได้ เพราะลาป่วยต้องแจ้งก่อน 8.00 น.
            else if (sickCount > 0 || leaveCount > 0) status = (leaveCount > sickCount) ? 'ลากิจ' : 'ลาป่วย';
            else if (hasSkip) status = 'โดดเรียน';
            else status = null;
            const INCOMPLETE_PERIOD_THRESHOLD = (settings.thresholds && settings.thresholds.incompletePeriods) || 4;
            const incomplete = (status === 'มา' || status === 'สาย') && missingCount >= INCOMPLETE_PERIOD_THRESHOLD;
            return { status, incomplete, missingCount };
        }


        // [v1.74.3] ห้องที่หน้านี้แสดงอยู่ (ใช้ตัดสินว่าห้องไหนต้องอัปเดตทันที) — ล้างทุกครั้งที่เปลี่ยนหน้า แล้วเติมจากหน้าใหม่
        function resetViewRooms(state) {
            const set = window.__viewRoomKeys = new Set(), list = [];
            try {
                const st = state || {}, add = (t, y, r) => { if (r) { set.add(roomAttKey_(t, y, r)); list.push({ t, y, r }); } };
                if (st.subjectId) { const sb = subjects.find(x => x.id === st.subjectId); if (sb) add(sb.term, sb.year, sb.roomId); }
                if (st.roomId) add(adminTerm(), adminYear(), st.roomId);
                if (st.studentId) { const sd = students.find(x => x.id === st.studentId); if (sd) add(adminTerm(), adminYear(), sd.roomId); }
            } catch (e) { /* ข้าม */ }
            // ห้องที่เคยโหลดไว้แต่มีการเปลี่ยนตอนไม่ได้แสดงอยู่ (ถูกทำเครื่องหมายว่าเก่า) — โหลดใหม่แล้ววาดหน้าซ้ำ
            const stale = list.filter(x => (window.__loadedRoomsList || []).some(l => roomAttKey_(l.term, l.year, l.roomId) === roomAttKey_(x.t, x.y, x.r)) && !(roomAttKey_(x.t, x.y, x.r) in (window.__loadedRoomLastModified || {})));
            if (stale.length) setTimeout(() => { Promise.all(stale.map(x => ensureAttendanceLoadedForRoom(x.t, x.y, x.r))).then(() => { const cur = history.state || {}; if (JSON.stringify(cur) === JSON.stringify(state)) { try { safeRenderState(cur); } catch (e) { /* ข้าม */ } } }); }, 0);
        }
        function navigate(view, params = {}, forceReplace = false) {
            resetViewRooms({ view, ...params });
            if (view === 'attendance') window.__attReturnState = history.state; // จำว่าเข้าหน้าเช็คชื่อมาจากหน้าไหน
            closeAllModals();
            window.scrollTo({ top: 0, behavior: 'smooth' });
            const state = { view, ...params };
            try {
                // [ใหม่] ใช้ replace (แทนที่ประวัติเดิมแทนการเพิ่มใหม่) เมื่อ: (1) ถูกระบุมาชัดเจนว่าเป็นหน้าย่อย/หน้ารายละเอียด
                // (forceReplace) หรือ (2) เป็นการสลับไปมาใน "หน้าประเภทเดียวกัน" กับที่เปิดอยู่แล้ว (เช่น สลับแท็บในหน้าแอดมิน,
                // สลับวันในตารางเช็คชื่อ) - ถือว่ายังอยู่หน้าเดิม ไม่ใช่หน้าใหม่ กันปุ่ม Back ต้องไล่ย้อนทุกครั้งที่คลิกสลับแท็บ/ตัวเลือกย่อย
                const currentState = history.state;
                const isSameViewType = currentState && currentState.view === view;
                const shouldReplace = forceReplace || isSameViewType;
                if (shouldReplace) history.replaceState(state, '', location.pathname + location.search);
                else history.pushState(state, '', location.pathname + location.search);
            } catch (e) { /* เบราว์เซอร์บางตัวอาจไม่รองรับ ไม่กระทบการทำงานหลัก */ }
            safeRenderState(state);
        }

        // เรนเดอร์แบบปลอดภัย: ถ้าเกิดข้อผิดพลาดใดๆ จะไม่ปล่อยให้หน้าจอว่างเปล่า (white screen)
        // แต่จะ fallback กลับไปหน้าแรกเสมอ
        function safeRenderState(state) {
            try {
                renderViewFromState(state);
            } catch (err) {
                console.error('Render error, falling back to dashboard:', err);
                try { renderDashboard(); } catch (err2) { location.reload(); }
                return;
            }
            // เช็คเผื่อกรณีเรนเดอร์แล้วเนื้อหาว่างเปล่าโดยไม่มี exception
            const mc = document.getElementById('mainContent');
            if (mc && isDbInitialized && mc.innerHTML.trim() === '') {
                try { renderDashboard(); } catch (err3) { location.reload(); }
            }
        }

        // จัดการปุ่ม Back ของเบราว์เซอร์และปุ่ม Back ฮาร์ดแวร์ของ Android
        window.addEventListener('popstate', (event) => {
            closeAllModals();
            const state = event.state || { view: 'dashboard' };
            resetViewRooms(state); // [v1.74.3]
            safeRenderState(state);
        });

        // ตาข่ายนิรภัยสุดท้าย: ถ้ามี error ที่ไม่ถูกดักจับเกิดขึ้นระหว่างการทำงาน และทำให้เนื้อหาหลักว่างเปล่า
        // ให้ดึงกลับมาที่หน้า dashboard แทนที่จะปล่อยให้จอขาวค้าง
        window.addEventListener('error', function() {
            const mc = document.getElementById('mainContent');
            if (mc && isDbInitialized && mc.innerHTML.trim() === '') {
                try { renderDashboard(); } catch (e) {}
            }
        });
        
        function closeAllModals() {
            ['subjectModal', 'studentModal', 'teacherModal', 'confirmModal', 'promptModal'].forEach(id => {
                const el = document.getElementById(id);
                if(el) { const box = el.querySelector('div[id$="Box"]'); if(box) { box.classList.remove('scale-100', 'opacity-100'); box.classList.add('scale-95', 'opacity-0'); } setTimeout(() => el.classList.add('hidden'), 100); }
            });
        }

        function renderViewFromState(state) {
            if (!isDbInitialized) return;
            if (!state || !state.view) { renderDashboard(); return; }
            if (state.view.startsWith('admin') && !isAdmin && state.view !== 'admin_login') { renderAdminLogin(); return; }
            try {
                switch(state.view) {
                    case 'dashboard': renderDashboard(); break;
                    case 'admin_login': renderAdminLogin(); break;
                    case 'admin': if(state.tab) currentAdminTab = state.tab; renderAdmin(); break;
                    case 'teacher_dash': openTeacherDashboard(state.teacherName); break;
                    case 'classroom': openClassroom(state.roomId, state.dayIndex); break;
                    case 'attendance': openAttendance(state.subjectId, state.period, state.fromTeacherDash, state.date); break;
                    case 'subject_summary': openSubjectSummary(state.subjectId, state.fromTeacherDash); break;
                    case 'student_summary': openStudentSummary(state.studentId, state.month); break;
                    case 'room_summary': openRoomSummary(state.roomId, state.month, state.tab); break;
                    case 'school_summary': renderSchoolSummary(state.month); break;
                    case 'privacy': renderPrivacyPolicy(); break;
                    case 'club_list': renderClubList(); break; // [v1.78]
                    case 'club_check': renderClubCheck(state.clubId); break;
                    default: renderDashboard();
                }
            } catch (error) { renderDashboard(); }
        }

        let pollingInterval = null;
        function startRealtimeSync() {
            if (pollingInterval) clearInterval(pollingInterval);
            // [v1.73] ประหยัดโควต้า: หน้าเว็บถูกย่อ/อยู่แท็บอื่น = ไม่ตรวจ (กลับมาที่หน้า = ตรวจทันที 1 ครั้ง)
            //        ข้อมูลเช็คชื่อของห้องที่เปิดอยู่ตรวจทุก 20 วินาทีเหมือนเดิม · ข้อมูลหลัก (ตั้งค่า/ครู/วิชา/นักเรียน) ตรวจทุก 60 วินาที
            // [v1.74.3] ประหยัดโควต้า: ถาม 1 คำขอ (?action=sync_meta) ได้ครบทั้งข้อมูลหลักและทุกห้อง แล้วโหลดเฉพาะส่วนที่เปลี่ยน
            //   หน้าที่แสดงข้อมูลเช็คชื่อ = ทุก 30 วินาที · หน้าอื่น (เช่น หน้าแรก) = ทุก 2 นาที
            //   ไม่มีการขยับเมาส์/แตะจอ/พิมพ์เกิน 5 นาที หรือย่อจอ/สลับแท็บ = หยุดถาม · กลับมาใช้ = ดึงทันที
            //   ห้องที่ไม่ได้แสดงอยู่ไม่โหลดซ้ำ แค่จำว่าเปลี่ยน (เปิดห้องนั้นครั้งหน้าจะโหลดใหม่)
            const SYNC_VIEW_MS = 30000, SYNC_IDLE_MS = 120000, IDLE_STOP_MS = 5 * 60000;
            window.__syncSeen = window.__syncSeen || { main: undefined, all: undefined, rooms: {} };
            window.__viewRoomKeys = window.__viewRoomKeys || new Set();
            window.__lastAct = Date.now();
            let lastSync = Date.now(), syncBusy = false;
            const roomsTick = (all) => { (window.__loadedRoomsList || []).forEach(r => { const k = roomAttKey_(r.term, r.year, r.roomId); if (all || window.__viewRoomKeys.has(k)) ensureAttendanceLoadedForRoom(r.term, r.year, r.roomId, true); }); };
            async function syncTick() {
                if (syncBusy) return; syncBusy = true; lastSync = Date.now();
                try {
                    let j = null;
                    try { const ty = [...new Set([`${settings.term}|${settings.year}`].concat((window.__loadedRoomsList || []).map(r => `${r.term}|${r.year}`)))].slice(0, 6).join(','); const r = await fetch(`${GOOGLE_APP_SCRIPT_URL}?action=sync_meta&ty=${encodeURIComponent(ty)}`); j = await r.json(); } /* [v2.02.2] อ่านเฉพาะภาคเรียนที่เปิดอยู่ */ catch (e) { j = null; }
                    if (!j || !j.syncMeta) { roomsTick(false); await mainTick(); return; } // Worker รุ่นเก่า — วิธีเดิม (เฉพาะห้องที่แสดงอยู่)
                    const seen = window.__syncSeen;
                    if (seen.main === undefined) seen.main = j.main;
                    else if (j.main !== seen.main) { await mainTick(); seen.main = j.main; }
                    const allChanged = seen.all !== undefined && j.all !== seen.all; seen.all = j.all;
                    for (const r of (window.__loadedRoomsList || []).slice()) {
                        const k = roomAttKey_(r.term, r.year, r.roomId), sk = `${r.term}|${r.year}|${r.roomId}`;
                        const v = j.rooms[sk] || 0;
                        if (!allChanged && v === (seen.rooms[k] || 0)) continue;
                        if (window.__viewRoomKeys.has(k)) await ensureAttendanceLoadedForRoom(r.term, r.year, r.roomId, true, true);
                        else { delete window.__loadedRoomLastModified[k]; delete seen.rooms[k]; } // ไม่ได้แสดงอยู่ = โหลดใหม่ตอนเปิดครั้งหน้า
                    }
                } finally { syncBusy = false; }
            }
            window.__syncNow = async () => { await syncTick(); };
            if (!window.__visSyncBound) {
                window.__visSyncBound = true;
                const wake = () => { const was = window.__syncIdle; window.__lastAct = Date.now(); if (was && isDbInitialized && !document.hidden) { window.__syncIdle = false; window.__syncNow(); } };
                ['click', 'keydown', 'touchstart', 'mousemove', 'scroll', 'wheel'].forEach(ev => window.addEventListener(ev, wake, { passive: true }));
                document.addEventListener('visibilitychange', () => { if (!document.hidden && isDbInitialized && window.__syncHidden) { window.__syncHidden = false; window.__lastAct = Date.now(); window.__syncIdle = false; window.__syncNow(); } });
            }
            pollingInterval = setInterval(() => {
                if (!isDbInitialized || GOOGLE_APP_SCRIPT_URL === "YOUR_WEB_APP_URL_HERE") return;
                if (document.hidden) { window.__syncHidden = true; return; }
                if (Date.now() - window.__lastAct > IDLE_STOP_MS) { window.__syncIdle = true; return; }
                const every = window.__viewRoomKeys.size ? SYNC_VIEW_MS : SYNC_IDLE_MS;
                if (Date.now() - lastSync >= every) syncTick();
            }, 10000);
            async function mainTick() {
                try {
                    const response = await fetch(GOOGLE_APP_SCRIPT_URL); const data = await response.json();
                    if (data && data.syncMain !== undefined && window.__syncSeen) { window.__syncSeen.main = data.syncMain; window.__syncSeen.all = data.syncAll; } // [v1.74.3]
                    if (data) {
                        // [v1.73] ห้องที่เปิดอยู่ตรวจแยกใน roomsTick แล้ว
                        followUps = data.followUps || [];
                        if (!isAdmin) {
                            teachers = data.teachers || []; subjects = data.subjects || []; students = data.students || [];
                            students = students.map(st => { if (st.title) { st.name = (st.title + (st.name || '')).trim(); st.title = ''; } return st; });
                            if (data.settings) {
                                if (data.settings.title && data.settings.title !== settings.title) {
                                    settings.title = data.settings.title;
                                    document.getElementById('navTitle').innerText = settings.title;
                                    document.title = settings.title;
                                }
                                if (data.settings.faviconDataUrl && data.settings.faviconDataUrl !== settings.faviconDataUrl) {
                                    settings.faviconDataUrl = data.settings.faviconDataUrl;
                                    applyFavicon();
                                }
                                if (data.settings.logoDataUrl !== undefined && data.settings.logoDataUrl !== settings.logoDataUrl) {
                                    settings.logoDataUrl = data.settings.logoDataUrl;
                                    applyHeaderLogo();
                                }
                                if (Array.isArray(data.settings.externalLinks)) settings.externalLinks = data.settings.externalLinks;
                                if (data.settings.recordHomeroom !== undefined) settings.recordHomeroom = data.settings.recordHomeroom;
                                if (data.settings.recordZone !== undefined) settings.recordZone = data.settings.recordZone;
                                if (JSON.stringify(data.settings.announcements || []) !== JSON.stringify(settings.announcements || [])) {
                                    settings.announcements = data.settings.announcements || [];
                                    updateAnnouncementBar();
                                }
                                if (JSON.stringify(data.settings.holidays || []) !== JSON.stringify(settings.holidays || []) || (Array.isArray(data.hubHolidays) && JSON.stringify(data.hubHolidays) !== JSON.stringify(hubHolidays))) {
                                    settings.holidays = data.settings.holidays || [];
                                    if (Array.isArray(data.hubHolidays)) hubHolidays = data.hubHolidays; if (Array.isArray(data.hubInterns)) hubInterns = data.hubInterns;
                                    updateHolidayBar();
                                }
                                if (Array.isArray(data.hubPeriods)) hubPeriods = data.hubPeriods; // [v1.74]
                                if (data.settings.serverOnline !== undefined && data.settings.serverOnline !== settings.serverOnline) {
                                    settings.serverOnline = data.settings.serverOnline;
                                    applyServerStatusBadge();
                                }
                                if (data.settings.termLocks && JSON.stringify(data.settings.termLocks) !== JSON.stringify(settings.termLocks || {})) {
                                    settings.termLocks = data.settings.termLocks;
                                    applyServerStatusBadge();
                                }
                                if (data.settings.termCount !== undefined && data.settings.termCount !== settings.termCount) {
                                    settings.termCount = data.settings.termCount;
                                }
                                if (data.settings.academicYears && JSON.stringify(data.settings.academicYears) !== JSON.stringify(settings.academicYears || [])) {
                                    settings.academicYears = data.settings.academicYears;
                                }
                                if (data.settings.term !== undefined && (data.settings.term !== settings.term || data.settings.year !== settings.year)) {
                                    settings.term = data.settings.term; settings.year = data.settings.year;
                                    document.getElementById('navSubtitle').innerText = `ปีการศึกษา ${settings.year}`;
                                    window.__justSwitchedTerm = true; // แสดงเอฟเฟคเตือนตอนภาคเรียนที่แสดงผลถูกเปลี่ยนจากแอดมิน
                                    applyServerStatusBadge();
                                    const st = history.state;
                                    if (st && (st.view === 'dashboard' || st.view === 'classroom' || st.view === 'teacher_dash')) { try { safeRenderState(st); } catch (e) {} }
                                }
                            }
                        }
                    }
                } catch (e) {}
            }
        }

        window.onload = async () => {
            document.getElementById('mainContent').innerHTML = `<div class="flex flex-col items-center justify-center py-20 sm:py-32"><i class="fas fa-cloud-download-alt text-5xl sm:text-6xl text-indigo-500 mb-6 animate-bounce"></i><h2 class="text-xl sm:text-2xl font-extrabold text-slate-800 text-center">กำลังซิงค์ข้อมูล...</h2><p class="text-sm sm:text-base text-slate-500 mt-2 font-medium text-center">โปรดรอสักครู่ ระบบกำลังโหลดข้อมูล</p></div>`;
            if (GOOGLE_APP_SCRIPT_URL === "YOUR_WEB_APP_URL_HERE") { document.getElementById('mainContent').innerHTML = '<div class="text-center p-6 sm:p-20 text-rose-500 font-bold text-base sm:text-2xl bg-white rounded-3xl shadow-sm border border-rose-200 mt-10"><i class="fas fa-exclamation-triangle mb-4 text-4xl sm:text-6xl"></i><br>กรุณาใส่ URL ของ Google Apps Script</div>'; return; }
            // ===== ดึงข้อมูลเริ่มต้นพร้อมลองใหม่อัตโนมัติ (กันปัญหาเชื่อมต่อสะดุดชั่วคราว/เซิร์ฟเวอร์ตื่นช้า) และจำกัดเวลาแต่ละครั้งไม่ให้ค้างรอไม่มีที่สิ้นสุด =====
            async function fetchInitialDataWithRetry(maxAttempts = 3, timeoutMs = 20000) {
                for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                    if (attempt > 1) {
                        document.getElementById('mainContent').innerHTML = `<div class="flex flex-col items-center justify-center py-20 sm:py-32"><i class="fas fa-cloud-download-alt text-5xl sm:text-6xl text-indigo-500 mb-6 animate-bounce"></i><h2 class="text-xl sm:text-2xl font-extrabold text-slate-800 text-center">กำลังซิงค์ข้อมูล... (ลองใหม่ครั้งที่ ${attempt}/${maxAttempts})</h2><p class="text-sm sm:text-base text-slate-500 mt-2 font-medium text-center">การเชื่อมต่อครั้งก่อนไม่สำเร็จ กำลังลองใหม่ โปรดรอสักครู่</p></div>`;
                    }
                    const controller = new AbortController();
                    const timer = setTimeout(() => controller.abort(), timeoutMs);
                    try {
                        const response = await fetch(GOOGLE_APP_SCRIPT_URL, { signal: controller.signal });
                        const data = await response.json();
                        clearTimeout(timer);
                        return data;
                    } catch (e) {
                        clearTimeout(timer);
                        if (attempt === maxAttempts) throw e;
                        await new Promise(r => setTimeout(r, 1500)); // เว้นจังหวะสั้นๆ ก่อนลองรอบถัดไป
                    }
                }
            }
            try {
                const data = await fetchInitialDataWithRetry();
                if (data && data.syncMain !== undefined) window.__syncSeen = { main: data.syncMain, all: data.syncAll, rooms: {} }; // [v1.74.3]
                if (Array.isArray(data.hubHolidays)) hubHolidays = data.hubHolidays; if (Array.isArray(data.hubInterns)) hubInterns = data.hubInterns; // [v1.72.1]
                if (Array.isArray(data.hubPeriods)) hubPeriods = data.hubPeriods; // [v1.74]
                if (data.settings && Object.keys(data.settings).length > 0) {
                    settings = data.settings;
                    settings.thresholds = settings.thresholds || { late: 4, absent: 4 };
                    if (!settings.staffs) settings.staffs = {};
                    if (!settings.advisors) settings.advisors = {};
                    if (!settings.title) settings.title = "ระบบเช็คชื่อนักเรียนอัจฉริยะ";
                    if (!settings.faviconDataUrl) settings.faviconDataUrl = "";
                    if (!settings.logoDataUrl) settings.logoDataUrl = "";
                    if (!settings.announcement) settings.announcement = "";
                    if (!settings.announcementStart) settings.announcementStart = "";
                    if (!settings.announcementEnd) settings.announcementEnd = "";
                    ensureAnnouncementsArray();
                    if (!settings.users || settings.users.length === 0) {
                        settings.users = [{ id: 'super_admin_root', username: 'BNKAdmin', password: '042499078', name: 'ผู้ดูแลระบบหลัก', role: 'super_admin', createdAt: new Date().toISOString() }];
                    }
                    // แก้ไขค่าเริ่มต้นเดิมที่อ้างอิงผิด (Google Sheets cell) ให้ตรงกับความจริง (Drive file ผ่าน DriveApp.createFile ซึ่งจำกัดที่ 10MB)
                    if (!settings.storageLimitChars || settings.storageLimitChars === 50000) settings.storageLimitChars = 8000000;
                    if (!settings.holidays) settings.holidays = [];
                    if (settings.serverOnline === undefined) settings.serverOnline = true;
                    if (!settings.termLocks) settings.termLocks = {};
                    Object.keys(settings.termLocks).forEach(k => { if (settings.termLocks[k] === true) settings.termLocks[k] = 'locked'; else if (settings.termLocks[k] === false) delete settings.termLocks[k]; });
                    if (![1, 2, 3].includes(settings.termCount)) settings.termCount = 2;
                    if (!settings.academicYears || !Array.isArray(settings.academicYears) || settings.academicYears.length === 0) {
                        settings.academicYears = [{ year: settings.year, status: 'active' }];
                    } else if (!settings.academicYears.some(y => String(y.year) === String(settings.year))) {
                        settings.academicYears.push({ year: settings.year, status: 'active' }); // ปีที่กำลังใช้แสดงผลอยู่ต้องอยู่ในทะเบียนเสมอ
                    }
                    teachers = data.teachers || [];
                    subjects = data.subjects || []; students = data.students || []; attendanceData = []; followUps = data.followUps || []; logs = data.logs || [];
                    // [ใหม่] ไม่โหลดข้อมูลเช็คชื่อของห้องไหนมาตอนเปิดเว็บอีกต่อไป - จะโหลดเฉพาะห้องที่เปิดดูจริงแบบ on-demand (ดู ensureAttendanceLoadedForRoom)
                    subjects = subjects.map(s => { if (s.day !== undefined && s.period !== undefined && !s.schedules) { s.credits = 0.5; s.schedules = [{ day: s.day, period: s.period }]; delete s.day; delete s.period; } if (s.term === undefined) s.term = settings.term; if (s.year === undefined) s.year = settings.year; if (s.locked === undefined) s.locked = false; return s; });
                    students = students.map(st => { if (!st.status) st.status = 'active'; if (st.title) { st.name = (st.title + (st.name || '')).trim(); st.title = ''; } return st; });
                } else {
                    document.getElementById('mainContent').innerHTML = `<div class="max-w-lg mx-auto mt-10 sm:mt-20 bg-white rounded-3xl shadow-sm border border-rose-200 p-6 sm:p-10 text-center"><div class="w-16 h-16 sm:w-20 sm:h-20 bg-rose-100 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6 text-rose-500 text-3xl sm:text-4xl"><i class="fas fa-exclamation-triangle"></i></div><h2 class="text-lg sm:text-2xl font-extrabold text-slate-800 mb-2">ไม่สามารถโหลดข้อมูลจากเซิร์ฟเวอร์ได้ตามปกติ</h2><p class="text-xs sm:text-sm text-slate-500 font-medium mb-6 leading-relaxed">ระบบไม่พบข้อมูลการตั้งค่าที่ถูกต้องจากเซิร์ฟเวอร์ อาจเกิดจากการเชื่อมต่อขัดข้องชั่วคราว เพื่อความปลอดภัยของข้อมูล ระบบจะไม่สร้างฐานข้อมูลใหม่ทับข้อมูลเดิมโดยอัตโนมัติ กรุณาลองรีเฟรชหน้านี้อีกครั้งก่อน</p><button onclick="location.reload()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-3 rounded-xl font-bold text-sm shadow-sm transition-colors mb-3"><i class="fas fa-sync-alt"></i> ลองโหลดใหม่อีกครั้ง</button><button onclick="window.__confirmFreshInstall()" class="w-full bg-white border border-rose-200 hover:bg-rose-50 text-rose-500 px-4 py-3 rounded-xl font-bold text-xs shadow-sm transition-colors">นี่คือการติดตั้งระบบครั้งแรก ยังไม่เคยมีข้อมูลใดๆ เลย - เริ่มต้นฐานข้อมูลใหม่</button></div>`;
                    isDbInitialized = false;
                    return;
                }
                isDbInitialized = true;
                document.getElementById('navTitle').innerText = settings.title;
                document.title = settings.title;
                document.getElementById('navSubtitle').innerText = `ปีการศึกษา ${settings.year}`;
                applyFavicon();
                applyHeaderLogo();
                updateAnnouncementBar();
                updateHolidayBar();
                applyServerStatusBadge();
                setInterval(updateAnnouncementBar, 60000);
                setInterval(updateHolidayBar, 60000);
                applyDarkModePreference();
                initInactivityTracking();
                // ตั้งค่าจุดเริ่มต้นของ history ให้เป็นหน้า dashboard เพื่อให้ปุ่ม Back ทำงานถูกต้องตั้งแต่แรก
                try { history.replaceState({ view: 'dashboard' }, '', location.pathname + location.search); } catch (e) {}
                showToast("พร้อมใช้งาน!", "success"); renderDashboard(); startRealtimeSync();
            } catch (error) { document.getElementById('mainContent').innerHTML = `<div class="max-w-lg mx-auto mt-10 sm:mt-20 bg-white rounded-3xl shadow-sm border border-rose-200 p-6 sm:p-10 text-center"><div class="w-16 h-16 sm:w-20 sm:h-20 bg-rose-100 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6 text-rose-500 text-3xl sm:text-4xl"><i class="fas fa-exclamation-triangle"></i></div><h2 class="text-lg sm:text-2xl font-extrabold text-slate-800 mb-2">ไม่สามารถเชื่อมต่อฐานข้อมูลได้</h2><p class="text-xs sm:text-sm text-slate-500 font-medium mb-6 leading-relaxed">ลองเชื่อมต่อหลายครั้งแล้วแต่ไม่สำเร็จ อาจเกิดจากอินเทอร์เน็ต/Wi-Fi ของอุปกรณ์นี้ไม่เสถียร หรือเครือข่ายที่ใช้อยู่ (เช่น Wi-Fi โรงเรียน) บล็อกการเชื่อมต่อไปยัง script.google.com ลองสลับไปใช้เน็ตมือถือ (4G/5G) เพื่อทดสอบ หรือลองรีเฟรชอีกครั้ง</p><button onclick="location.reload()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-3 rounded-xl font-bold text-sm shadow-sm transition-colors"><i class="fas fa-sync-alt"></i> ลองโหลดใหม่อีกครั้ง</button></div>`; }
        };

        // รวม log ของเครื่องนี้ (local) เข้ากับ log ล่าสุดบนเซิร์ฟเวอร์ (remote) แบบไม่ทับกัน
        function mergeLogsArrays(remote, local) {
            const map = new Map();
            (remote || []).forEach(l => map.set(l.id, l));
            (local || []).forEach(l => map.set(l.id, l));
            let merged = Array.from(map.values());
            merged.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
            if (merged.length > 500) merged = merged.slice(merged.length - 500);
            return merged;
        }

        // ===== ป้องกันข้อมูลชนกันเมื่อแอดมินหลายคนแก้ไข วิชา/นักเรียน/ครู พร้อมกัน =====
        // ก่อนแก้ไข ให้ดึงข้อมูลล่าสุดจากเซิร์ฟเวอร์มาแทนที่อาร์เรย์ในเครื่องก่อนเสมอ แล้วค่อยแก้ไข "รายการเดียว" ที่ต้องการทับลงไป
        // เพื่อไม่ให้การบันทึกแบบ 'full' (เขียนทับทั้งอาร์เรย์) ไปลบงานที่แอดมินอีกคนเพิ่งบันทึกไปพร้อมกัน
        async function refreshBeforeEdit(fields) {
            try {
                const response = await fetch(GOOGLE_APP_SCRIPT_URL);
                const latest = await response.json();
                if (!latest) return null;
                if (fields.includes('subjects') && latest.subjects) {
                    subjects = latest.subjects.map(s => {
                        if (s.day !== undefined && s.period !== undefined && !s.schedules) { s.credits = 0.5; s.schedules = [{ day: s.day, period: s.period }]; delete s.day; delete s.period; }
                        if (s.term === undefined) s.term = settings.term; if (s.year === undefined) s.year = settings.year; if (s.locked === undefined) s.locked = false;
                        return s;
                    });
                }
                if (fields.includes('students') && latest.students) {
                    students = latest.students.map(st => { if (!st.status) st.status = 'active'; if (st.title) { st.name = (st.title + (st.name || '')).trim(); st.title = ''; } return st; });
                }
                if (fields.includes('teachers') && latest.teachers) teachers = latest.teachers;
                return latest; // คืนข้อมูลที่ดึงมาให้ผู้เรียกใช้ต่อได้ - ป้องกัน saveData('full') ต้อง fetch DB ทั้งก้อนซ้ำอีกรอบทันที (ตัวการที่ทำให้บันทึกช้า/หน่วง)
            } catch (e) { /* เครือข่ายมีปัญหา ใช้ข้อมูลปัจจุบันในเครื่องแทนไปก่อน */ return null; }
        }

        // ===== [v1.74.5] บันทึกวิชาแบบส่งเฉพาะวิชาที่เปลี่ยน (เดิมดึงข้อมูลหลักทั้งชุดลงมา แล้วส่งทั้งชุดกลับขึ้นไป = ช้ามากเมื่อข้อมูลโต) =====
        // Worker รุ่นเก่ายังไม่รู้จักคำสั่งนี้ → ใช้วิธีเดิม (ดึงทั้งชุด + บันทึกทั้งชุด) ให้อัตโนมัติ
        // คืนค่า true = สำเร็จ · false = ไม่สำเร็จ (แจ้งผู้ใช้แล้ว) · ผู้เรียกส่ง fallback = ฟังก์ชันแก้ข้อมูลในเครื่อง ใช้กรณีต้องย้อนไปวิธีเดิม
        function normalizeSubject_(s) {
            if (s.day !== undefined && s.period !== undefined && !s.schedules) { s.credits = 0.5; s.schedules = [{ day: s.day, period: s.period }]; delete s.day; delete s.period; }
            if (s.term === undefined) s.term = settings.term; if (s.year === undefined) s.year = settings.year; if (s.locked === undefined) s.locked = false;
            return s;
        }
        async function saveSubjectsDelta(upsert, remove, opts = {}) {
            const t0 = Date.now();
            let res, j = null;
            try {
                res = await fetchWithRetry(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'subject_save', upsert: upsert || [], remove: remove || [], mustExist: !!opts.mustExist }) });
                try { j = await res.clone().json(); } catch (e) {}
            } catch (e) { res = null; }
            if (j && j.status === 'error' && /ไม่รู้จักคำสั่ง/.test(j.message || '')) { // Worker ยังเป็นรุ่นเก่า
                await refreshBeforeEdit(['subjects']);
                if (opts.applyLocal && opts.applyLocal() === false) return false;
                return await saveData('full');
            }
            if (j && j.status === 'error' && j.code === 'gone') { showToast(j.message, "error"); return false; }
            if (!res || !res.ok || !j || j.status !== 'success') {
                const msg = (j && j.message) || 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้';
                showToast("บันทึกข้อมูลไม่สำเร็จ: " + msg, "error");
                showConfirm("บันทึกข้อมูลไม่สำเร็จ", `${msg}\n\nกด "บันทึกอีกครั้ง" เพื่อลองส่งใหม่ (ถ้ายังไม่สำเร็จ ลองรีเฟรชหน้าเว็บ)`, () => saveSubjectsDelta(upsert, remove, opts), "บันทึกอีกครั้ง");
                return false;
            }
            if (Array.isArray(j.subjects)) subjects = j.subjects.map(normalizeSubject_); // ได้รายการวิชาล่าสุด (รวมที่ผู้ดูแลคนอื่นเพิ่งแก้) กลับมาด้วย
            window.__lastSaveMs = Date.now() - t0; window.__lastSaveTiming = j.timing || null;
            return true;
        }
        // ข้อความบันทึกสำเร็จ — ถ้าใช้เวลานาน บอกเวลาและจำนวนครั้งที่ต้องส่งซ้ำ (ช่วยหาสาเหตุ)
        function savedMsg_(text) {
            const ms = window.__lastSaveMs || 0, n = window.__lastFetchAttempts || 1, t = window.__lastSaveTiming;
            const sec = (x) => (x / 1000).toFixed(1);
            // [v1.74.6] แยกเวลา: อ่านข้อมูล / เขียน KV (ใน Worker) / ระหว่างทาง (เน็ต + คิว Cloudflare)
            const part = t ? ` · อ่าน ${sec(t.read)} · เขียน ${sec(t.write)} · ระหว่างทาง ${sec(Math.max(0, ms - t.read - t.write))}` : '';
            return ms > 3000 ? `${text} (ใช้เวลา ${sec(ms)} วินาที${part}${n > 1 ? ` · ส่งซ้ำ ${n - 1} ครั้ง` : ''})` : text;
        }

        // ===== บันทึกข้อมูลแบบ Real-time รองรับการบันทึกพร้อมกันจากหลายอุปกรณ์ =====
        // การเช็คชื่อ/ติดตามนักเรียน/ล้างข้อมูล จะส่งเฉพาะ "รายการที่เปลี่ยนแปลง" ไปให้ฝั่งเซิร์ฟเวอร์ผสานเข้ากับข้อมูลล่าสุดเองแบบอะตอมมิก
        // (ล็อกการเขียนไว้ฝั่ง Apps Script ด้วย LockService กันข้อมูลชนกันเวลาเช็คชื่อพร้อมกันหลายห้อง/หลายวิชา)
        // คืนค่า true/false บอกว่าบันทึกสำเร็จจริงหรือไม่ (เดิมไม่คืนค่าอะไรเลย ทำให้ถ้าบันทึกล้มเหลว (เช่น เน็ตหลุด/เซิร์ฟเวอร์ error) หน้าเว็บจะไม่รู้ตัวและไม่แจ้งเตือนผู้ใช้เลย
        // เข้าใจผิดว่าบันทึกสำเร็จ พอโหลดหน้าใหม่ค่าที่เพิ่งเปลี่ยน (เช่น ปีการศึกษา) จะหายไปเพราะไม่เคยถูกบันทึกจริงบนเซิร์ฟเวอร์)
        // ===== [ใหม่] ยิง fetch พร้อมลองใหม่อัตโนมัติเงียบๆ (ไม่ต้องให้ผู้ใช้เห็น) กันปัญหาคิวชั่วคราวตอนมีคนบันทึกพร้อมกันเยอะ - ก่อนจะถือว่า "ล้มเหลวจริง" =====
        async function fetchWithRetry(url, options, maxAttempts = 3) {
            let lastError = null;
            for (let attempt = 1; attempt <= maxAttempts; attempt++) {
                window.__lastFetchAttempts = attempt; // [v1.74.5] ใช้แจ้งผู้ใช้เมื่อบันทึกช้า (ต้องส่งซ้ำกี่ครั้ง)
                try {
                    const res = await fetch(url, options);
                    if (!res.ok) { lastError = new Error('HTTP ' + res.status); if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, 1200 * attempt)); continue; } return res; }
                    let json = null; try { json = await res.clone().json(); } catch (e) {}
                    if (json && json.status === 'error' && /คิว|busy|lock/i.test(json.message || '') && attempt < maxAttempts) {
                        await new Promise(r => setTimeout(r, 1200 * attempt)); continue; // คิวไม่ว่างชั่วคราว - รอสั้นๆ แล้วลองใหม่เงียบๆ ไม่ต้องให้ผู้ใช้รู้ตัว
                    }
                    return res;
                } catch (e) {
                    lastError = e;
                    if (attempt < maxAttempts) { await new Promise(r => setTimeout(r, 1200 * attempt)); continue; }
                }
            }
            throw lastError;
        }
        async function saveData(action = 'full', payload = null, prefetchedLatest = null, opts = {}) {
            try {
                if (GOOGLE_APP_SCRIPT_URL === "YOUR_WEB_APP_URL_HERE") return false;
                let res;
                if (action === 'attendance' && payload) {
                    const idx = attendanceData.findIndex(a => a.subjectId === payload.subjectId && a.date === payload.date && String(a.period) === String(payload.period));
                    if (idx >= 0) attendanceData[idx] = payload; else attendanceData.push(payload);
                    // ===== [ใหม่] หา term/year/roomId ของวิชานี้ ส่งแนบไปด้วย เพื่อให้เซิร์ฟเวอร์เขียนลงไฟล์เช็คชื่อของห้อง/ภาคเรียน/ปีที่ถูกต้องโดยตรง (ไม่ต้องอ่านไฟล์หลักอีก) =====
                    const subForAtt = subjects.find(s => s.id === payload.subjectId);
                    const attTerm = (subForAtt && subForAtt.term) || settings.term;
                    const attYear = (subForAtt && subForAtt.year) || settings.year;
                    const attRoom = subForAtt && subForAtt.roomId;
                    if (!attRoom) { showToast("ไม่พบข้อมูลห้องของวิชานี้ ไม่สามารถบันทึกได้ กรุณารีเฟรชหน้าเว็บแล้วลองใหม่", "error"); return false; }
                    res = await fetchWithRetry(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'upsert_attendance', record: payload, term: attTerm, year: attYear, roomId: attRoom }) });
                    if (attRoom) window.__loadedRoomLastModified[roomAttKey_(attTerm, attYear, attRoom)] = Date.now(); // เพิ่งเขียนเอง ไม่ต้องรอ meta-check รอบหน้า
                } else if (action === 'followup' && payload) {
                    followUps.push(payload);
                    res = await fetchWithRetry(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'upsert_followup', record: payload }) });
                } else if (action === 'reset_subject' && payload) {
                    attendanceData = attendanceData.filter(a => a.subjectId !== payload);
                    const subForReset = subjects.find(s => s.id === payload);
                    const resetTerm = (subForReset && subForReset.term) || adminTerm();
                    const resetYear = (subForReset && subForReset.year) || adminYear();
                    const resetRoom = subForReset && subForReset.roomId;
                    res = await fetchWithRetry(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'reset_subject_attendance', subjectId: payload, term: resetTerm, year: resetYear, roomId: resetRoom }) });
                } else if (action === 'reset_all') {
                    attendanceData = attendanceData.filter(a => { const s = subjects.find(x => x.id === a.subjectId); return !s || String(s.term) !== String(adminTerm()) || String(s.year) !== String(adminYear()); });
                    followUps = followUps.filter(f => f.term !== adminTerm() || f.year !== adminYear());
                    window.__loadedRoomLastModified = {}; window.__loadedRoomsList = []; // ล้างสถานะที่จำไว้ทั้งหมด กันเข้าใจผิดว่าห้องที่เพิ่งล้างไปแล้วยังเป็นข้อมูลเดิมที่เคยโหลดมา
                    res = await fetchWithRetry(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'reset_all_attendance', term: adminTerm(), year: adminYear() }) });
                } else {
                    // 'full' - ใช้สำหรับตั้งค่า/ครู/วิชา/นักเรียน/ผู้ใช้งาน ฯลฯ
                    // [ใหม่] ไม่ต้องแนบ/ผสาน attendanceData และ logs อีกต่อไป (attendanceData แยกเก็บเป็นไฟล์รายห้อง, logs บันทึกผ่าน action 'log' โดยตรงทันทีที่เกิดขึ้นแล้ว) ทำให้การบันทึกส่วนนี้เบาและเร็วขึ้นมาก
                    let dataToSave = { settings, teachers, subjects, students, followUps };
                    let latestData = prefetchedLatest;
                    if (!latestData) { const response = await fetchWithRetry(GOOGLE_APP_SCRIPT_URL, undefined, 2); latestData = await response.json(); }
                    if (latestData) {
                        dataToSave.followUps = latestData.followUps || followUps; followUps = dataToSave.followUps;
                    }
                    res = await fetchWithRetry(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(dataToSave) });
                }
                if (!res || !res.ok) {
                    if (!opts.silent) showToast("บันทึกข้อมูลไม่สำเร็จ (เชื่อมต่อเซิร์ฟเวอร์ไม่ได้)", "error");
                    if (!opts.silent) showConfirm("บันทึกข้อมูลไม่สำเร็จ", "ลองส่งข้อมูลหลายครั้งแล้วแต่ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กด \"บันทึกอีกครั้ง\" เพื่อลองส่งข้อมูลชุดนี้ใหม่ (ถ้ายังไม่สำเร็จอีก แนะนำให้ลองสลับเน็ต หรือรีเฟรชหน้าเว็บ)", () => saveData(action, payload, prefetchedLatest), "บันทึกอีกครั้ง");
                    return false;
                }
                let resultJson = null; try { resultJson = await res.json(); } catch (e2) {}
                if (resultJson && resultJson.status === 'error') {
                    if (!opts.silent) showToast(`บันทึกข้อมูลไม่สำเร็จ: ${resultJson.message || 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์'}`, "error");
                    if (!opts.silent) showConfirm("บันทึกข้อมูลไม่สำเร็จ", `เซิร์ฟเวอร์ตอบกลับว่า: ${resultJson.message || 'เกิดข้อผิดพลาด'}\n\nกด "บันทึกอีกครั้ง" เพื่อลองส่งข้อมูลชุดนี้ใหม่ (ถ้ายังไม่สำเร็จอีก แนะนำให้ลองรีเฟรชหน้าเว็บ)`, () => saveData(action, payload, prefetchedLatest), "บันทึกอีกครั้ง");
                    return false;
                }
                window.__lastSaveResult = resultJson; // [v1.74] ผลการล้างรูป (photosFailed) ของการล้างข้อมูลรายวิชา
                return true;
            } catch (e) {
                console.error("Save Error", e);
                if (!opts.silent) showToast("บันทึกข้อมูลไม่สำเร็จ (เชื่อมต่อเซิร์ฟเวอร์ไม่ได้)", "error");
                if (!opts.silent) showConfirm("บันทึกข้อมูลไม่สำเร็จ", "ลองส่งข้อมูลหลายครั้งแล้วแต่ยังเชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กด \"บันทึกอีกครั้ง\" เพื่อลองส่งข้อมูลชุดนี้ใหม่ (ถ้ายังไม่สำเร็จอีก แนะนำให้ลองสลับเน็ต หรือรีเฟรชหน้าเว็บ)", () => saveData(action, payload, prefetchedLatest), "บันทึกอีกครั้ง");
                return false;
            }
        }

        // บันทึก Log การแก้ไขของผู้ใช้แต่ละคน (เก็บย้อนหลังสูงสุด 500 รายการล่าสุด)
        // category: 'settings' = ปรับตั้งค่าระบบ, 'data' = ลงข้อมูลต่างๆ, 'account' = บัญชีผู้ใช้/เข้าออกระบบ
        function logAction(action, details = '', category = 'data') {
            const logRecord = { id: generateId(), timestamp: new Date().toISOString(), username: currentUser ? currentUser.username : 'system', name: currentUser ? currentUser.name : 'ระบบ', action, details, category };
            logs.push(logRecord);
            if (logs.length > 500) logs = logs.slice(logs.length - 500);
            // ===== [ใหม่] บันทึก log แยกต่างหากทันที ไม่ต้องรอ/พ่วงไปกับการบันทึกแบบ 'full' อีกต่อไป (เบากว่าเดิมมาก ไม่ต้องส่ง log ทั้ง 500 รายการไปมาทุกครั้งที่แก้ตั้งค่า/ครู/วิชา/นักเรียน) - แบบ fire-and-forget ไม่บล็อกการทำงานอื่น
            if (GOOGLE_APP_SCRIPT_URL !== "YOUR_WEB_APP_URL_HERE") {
                fetch(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'append_log', record: logRecord }) }).catch(() => { /* log พลาดไม่ใช่เรื่องใหญ่ ไม่ต้องแจ้งเตือนผู้ใช้ */ });
            }
        }

        function seedSampleData() {
            const sampleTeacher = "ครูสมใจ รักเรียน";
            teachers.push({ id: generateId(), name: sampleTeacher, department: "ระบบ/อื่นๆ" });
            students.push({ id: generateId(), roomId: 'm1_1', number: '1', name: 'ด.ช.รักเรียน เพียรศึกษา', status: 'active' });
            subjects.push({ id: generateId(), roomId: 'm1_1', name: 'เช็คแถวเช้า', code: '', teacher: sampleTeacher, teacher2: '', credits: 0.5, schedules: [{day: 1, period: 0}] }); saveData('full');
        }
        // ปุ่มยืนยันชัดเจนก่อนเริ่มฐานข้อมูลใหม่ (เรียกจากหน้าจอ error ตอนโหลดข้อมูลล้มเหลวเท่านั้น) - ป้องกันการ seed ทับข้อมูลจริงโดยไม่ตั้งใจ
        window.__confirmFreshInstall = function() {
            showConfirm("ยืนยันเริ่มต้นฐานข้อมูลใหม่", "คำเตือน: การกดยืนยันจะสร้างฐานข้อมูลตัวอย่างใหม่และเขียนทับข้อมูลทั้งหมดที่มีอยู่บนเซิร์ฟเวอร์ (ถ้ามี) อย่างถาวร ใช้เฉพาะกรณีติดตั้งระบบครั้งแรกจริงๆ เท่านั้น หากไม่แน่ใจให้กด \"ยกเลิก\" แล้วลองรีเฟรชหน้าใหม่แทน", () => {
                isDbInitialized = true;
                seedSampleData();
                showToast("สร้างฐานข้อมูลใหม่แล้ว"); renderDashboard(); startRealtimeSync();
            });
        };

        function applyFavicon() {
            const link = document.getElementById('faviconLink');
            if (link) link.href = settings.faviconDataUrl && settings.faviconDataUrl.length > 0 ? settings.faviconDataUrl : 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/svgs/solid/graduation-cap.svg';
        }

        function updateCurrentUserBadge() {
            const badge = document.getElementById('currentUserBadge');
            const nameEl = document.getElementById('currentUserBadgeName');
            const roleEl = document.getElementById('currentUserBadgeRole');
            if (!badge || !nameEl || !roleEl) return;
            if (isAdmin && currentUser) {
                nameEl.innerText = currentUser.name;
                const isSuper = currentUser.role === 'super_admin';
                roleEl.innerText = isSuper ? 'Super Admin' : 'เจ้าหน้าที่';
                roleEl.className = `hidden sm:inline-block px-1.5 py-0.5 rounded-full text-[9px] sm:text-[10px] font-black ${isSuper ? 'bg-purple-100 text-purple-700' : 'bg-indigo-100 text-indigo-700'}`;
                badge.classList.remove('hidden'); badge.classList.add('flex');
            } else {
                badge.classList.add('hidden'); badge.classList.remove('flex');
            }
        }
        window.showUserBadgeInfo = function() {
            if (!isAdmin || !currentUser) return;
            const roleLabel = currentUser.role === 'super_admin' ? 'Super Admin' : 'เจ้าหน้าที่';
            showToast(`เข้าสู่ระบบในชื่อ: ${currentUser.name} (${roleLabel})`, "success");
        };

        function applyHeaderLogo() {
            const icon = document.getElementById('navLogoIcon'), img = document.getElementById('navLogoImg');
            if (!icon || !img) return;
            if (settings.logoDataUrl && settings.logoDataUrl.length > 0) {
                img.src = settings.logoDataUrl; img.classList.remove('hidden'); icon.classList.add('hidden');
            } else {
                img.classList.add('hidden'); img.src = ''; icon.classList.remove('hidden');
            }
        }

        // ===== Dark Mode =====
        function applyDarkModePreference() {
            let pref = 'light';
            try { pref = localStorage.getItem('bnksa_theme') || 'light'; } catch (e) {}
            setDarkMode(pref === 'dark', false);
        }
        function setDarkMode(isDark, persist = true) {
            document.documentElement.classList.toggle('dark', isDark);
            const icon = document.getElementById('darkModeIcon');
            if (icon) { icon.classList.toggle('fa-moon', !isDark); icon.classList.toggle('fa-sun', isDark); }
            if (persist) { try { localStorage.setItem('bnksa_theme', isDark ? 'dark' : 'light'); } catch (e) {} }
        }
        window.toggleDarkMode = function() {
            const isDark = !document.documentElement.classList.contains('dark');
            setDarkMode(isDark, true);
            try { safeRenderState(history.state || { view: 'dashboard' }); } catch (e) {}
        };

        // ===== 1.75.0: ติดตั้งเป็นแอป (PWA) — ปุ่มข้างปุ่มโหมดมืด/สว่าง =====
        // Chrome/Edge (คอม + Android) = กดแล้วขึ้นหน้าต่างติดตั้งของเบราว์เซอร์ทันที · Safari (iPhone/iPad/Mac) และเบราว์เซอร์อื่น = ป็อปอัปบอกวิธี
        // เปิดจากแอปที่ติดตั้งแล้ว (standalone) = ซ่อนปุ่ม · ไม่เก็บแคชข้อมูล (sw.js ส่งต่อไปเซิร์ฟเวอร์ทุกครั้ง)
        let deferredInstallPrompt = null;
        function isStandaloneApp() {
            try { return window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: window-controls-overlay)').matches || window.navigator.standalone === true; } catch (e) { return false; }
        }
        function updateInstallButton() {
            const b = document.getElementById('btnInstallApp');
            if (!b) return;
            b.classList.toggle('hidden', isStandaloneApp());
        }
        window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredInstallPrompt = e; updateInstallButton(); });
        window.addEventListener('appinstalled', () => { deferredInstallPrompt = null; updateInstallButton(); try { showToast('ติดตั้งแอปเรียบร้อยแล้ว — เปิดได้จากหน้าจอหลัก/เมนูแอป', 'success'); } catch (e) {} });
        function installHelpHtml() {
            const ua = navigator.userAgent || '';
            const ios = /iPhone|iPad|iPod/i.test(ua) || (/Macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
            const safariMac = !ios && /Macintosh/i.test(ua) && /Safari/i.test(ua) && !/Chrome|Chromium|Edg|Firefox/i.test(ua);
            const android = /Android/i.test(ua);
            const step = (n, t) => '<div class="flex gap-3 items-start"><span class="w-6 h-6 rounded-full bg-indigo-100 text-indigo-700 text-xs font-extrabold flex items-center justify-center shrink-0 mt-0.5">' + n + '</span><span>' + t + '</span></div>';
            if (ios) return step(1, 'เปิดเว็บนี้ด้วย <b>Safari</b>') + step(2, 'กดปุ่ม <b>แชร์</b> <i class="fas fa-arrow-up-from-bracket text-indigo-600"></i> (ด้านล่างหรือด้านบนของจอ)') + step(3, 'เลื่อนหาแล้วกด <b>เพิ่มไปยังหน้าจอโฮม</b> <i class="far fa-square-plus text-indigo-600"></i>') + step(4, 'กด <b>เพิ่ม</b> — ไอคอนแอปจะอยู่บนหน้าจอโฮม');
            if (safariMac) return step(1, 'ที่แถบเมนูด้านบน กด <b>ไฟล์ (File)</b>') + step(2, 'เลือก <b>เพิ่มไปยัง Dock (Add to Dock)</b>') + step(3, 'กด <b>เพิ่ม</b>');
            if (android) return step(1, 'กดปุ่มเมนู <b>⋮</b> มุมขวาบนของ Chrome') + step(2, 'เลือก <b>ติดตั้งแอป</b> หรือ <b>เพิ่มลงในหน้าจอหลัก</b>') + step(3, 'กด <b>ติดตั้ง</b>') + '<p class="text-xs text-slate-500 pt-1">ถ้าไม่มีเมนูนี้ ให้เปิดเว็บด้วย Google Chrome</p>';
            return step(1, 'ใช้ <b>Google Chrome</b> หรือ <b>Microsoft Edge</b>') + step(2, 'กดไอคอนติดตั้ง <i class="fas fa-download text-indigo-600"></i> ที่ท้ายช่องที่อยู่เว็บ (แถบ URL) หรือเมนู <b>⋮ / …</b> → <b>ติดตั้งแอป / แอป → ติดตั้งไซต์นี้เป็นแอป</b>') + step(3, 'กด <b>ติดตั้ง</b> — แอปจะเปิดเป็นหน้าต่างของตัวเอง และมีไอคอนบนเดสก์ท็อป/เมนู Start') + '<p class="text-xs text-slate-500 pt-1">Firefox ยังไม่รองรับการติดตั้งเว็บเป็นแอป</p>';
        }
        window.installApp = async function() {
            if (deferredInstallPrompt) {
                const ev = deferredInstallPrompt; deferredInstallPrompt = null;
                try { ev.prompt(); const r = await ev.userChoice; if (r && r.outcome === 'accepted') return; } catch (e) {}
                return;
            }
            const m = document.getElementById('installModal');
            document.getElementById('installHelpBody').innerHTML = installHelpHtml();
            m.classList.remove('hidden');
        };
        window.closeInstallHelp = function() { const m = document.getElementById('installModal'); if (m) m.classList.add('hidden'); };
        if ('serviceWorker' in navigator && location.protocol !== 'file:') {
            window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js', { scope: './' }).catch(() => {}); });
        }
        updateInstallButton();
        try { window.matchMedia('(display-mode: standalone)').addEventListener('change', updateInstallButton); } catch (e) {}

        // ===== รีเฟรชข้อมูล (ใช้ได้ทุกหน้า) =====
        window.refreshData = async function() {
            const icon = document.getElementById('refreshIcon');
            if (icon) icon.classList.add('fa-spin');
            if (GOOGLE_APP_SCRIPT_URL === "YOUR_WEB_APP_URL_HERE") { if (icon) icon.classList.remove('fa-spin'); return; }
            try {
                const response = await fetch(GOOGLE_APP_SCRIPT_URL); const data = await response.json();
                if (data) {
                    // [แก้ไข] ไม่แตะ attendanceData ที่นี่อีกต่อไป เพราะ default GET ไม่ได้แนบข้อมูลเช็คชื่อมาด้วยแล้ว (ย้ายไปเก็บแยกรายห้องใน D1)
                    // ของเดิมเขียนทับด้วย data.attendanceData ที่เป็น [] เสมอ ทำให้ข้อมูลเช็คชื่อที่โหลดไว้หายหมดทุกครั้งที่กดรีเฟรช - นี่คือบั๊กที่พบและแก้แล้ว
                    followUps = data.followUps || followUps;
                    if (!isAdmin) {
                        teachers = data.teachers || teachers; subjects = data.subjects || subjects;
                        students = (data.students || students).map(st => { if (st.title) { st.name = (st.title + (st.name || '')).trim(); st.title = ''; } return st; });
                        if (data.settings) {
                            if (data.settings.title) { settings.title = data.settings.title; document.getElementById('navTitle').innerText = settings.title; document.title = settings.title; }
                            if (data.settings.faviconDataUrl !== undefined) { settings.faviconDataUrl = data.settings.faviconDataUrl; applyFavicon(); }
                            if (data.settings.logoDataUrl !== undefined) { settings.logoDataUrl = data.settings.logoDataUrl; applyHeaderLogo(); }
                            settings.announcements = data.settings.announcements || []; updateAnnouncementBar();
                            settings.holidays = data.settings.holidays || []; if (Array.isArray(data.hubHolidays)) hubHolidays = data.hubHolidays; if (Array.isArray(data.hubInterns)) hubInterns = data.hubInterns; if (Array.isArray(data.hubPeriods)) hubPeriods = data.hubPeriods; updateHolidayBar();
                            settings.externalLinks = Array.isArray(data.settings.externalLinks) ? data.settings.externalLinks : [];
                            if (data.settings.serverOnline !== undefined) { settings.serverOnline = data.settings.serverOnline; applyServerStatusBadge(); }
                        }
                    }
                }
                // ===== [ใหม่] รีเฟรชข้อมูลเช็คชื่อของห้องที่กำลังโหลดอยู่จริง (ผ่านช่องทางที่ถูกต้อง แยกรายห้อง) ให้ปุ่มนี้ยังรีเฟรชข้อมูลเช็คชื่อได้จริงเหมือนเดิม =====
                if (Array.isArray(window.__loadedRoomsList) && window.__loadedRoomsList.length > 0) {
                    await Promise.all(window.__loadedRoomsList.map(r => ensureAttendanceLoadedForRoom(r.term, r.year, r.roomId, true)));
                }
                // ===== [ใหม่] ถ้าเคยเปิดแท็บ "ประวัติการแก้ไข" มาแล้วในเซสชันนี้ ให้ดึง log ชุดล่าสุดมาด้วย (log ก็แยกเก็บต่างหากเหมือนข้อมูลเช็คชื่อ ไม่ได้มากับ default GET) =====
                if (window.__logsLoaded) {
                    try {
                        const logsRes = await fetch(`${GOOGLE_APP_SCRIPT_URL}?action=get_logs`);
                        const logsData = await logsRes.json();
                        if (logsData && logsData.status === 'success' && Array.isArray(logsData.logs)) logs = logsData.logs;
                    } catch (e) { /* ดึง log ใหม่ไม่สำเร็จ - ใช้ของเดิมที่มีอยู่ไปก่อน ไม่ทำให้รีเฟรชทั้งหมดล้มเหลว */ }
                }
                safeRenderState(history.state || { view: 'dashboard' });
                showToast("รีเฟรชข้อมูลสำเร็จ");
            } catch (e) { showToast("รีเฟรชข้อมูลไม่สำเร็จ ลองอีกครั้ง", "error"); }
            if (icon) icon.classList.remove('fa-spin');
        };

        // ===== ประกาศแจ้งเตือน (รองรับหลายรายการพร้อมลำดับความสำคัญ) =====
        function ensureAnnouncementsArray() {
            if (!Array.isArray(settings.announcements)) settings.announcements = [];
            // ย้ายข้อมูลประกาศเดี่ยวแบบเก่ามาไว้ในลิสต์ใหม่ครั้งเดียว (เผื่อยังมีข้อมูลเก่าค้างอยู่)
            if ((settings.announcement || '').trim() && settings.announcements.length === 0) {
                settings.announcements.push({ id: generateId(), text: settings.announcement.trim(), start: settings.announcementStart || '', end: settings.announcementEnd || '', priority: 'normal' });
                settings.announcement = ''; settings.announcementStart = ''; settings.announcementEnd = '';
            }
        }
        function isAnnouncementItemActive(a) {
            if (!a || !(a.text || '').trim()) return false;
            const now = new Date();
            if (a.start) { const start = new Date(a.start); if (!isNaN(start) && now < start) return false; }
            if (a.end) { const end = new Date(a.end); if (!isNaN(end) && now > end) return false; }
            return true;
        }
        // ===== [ใหม่] จัดรูปแบบช่วงเวลาของประกาศเป็นแบบ 24 ชั่วโมง (พ.ศ. + ชม.:นาที) ไว้แสดงในรายการ =====
        function formatAnnouncementRange(start, end) {
            if (!start && !end) return '';
            const fmt = (v) => { const d = new Date(v); if (isNaN(d)) return ''; const datePart = d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short', year: 'numeric' }); const timePart = d.toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit', hour12: false }); return `${datePart} ${timePart} น.`; };
            const startLabel = start ? fmt(start) : 'ทันที';
            const endLabel = end ? fmt(end) : 'ไม่มีวันหมด';
            return `${startLabel} — ${endLabel}`;
        }
        const ANNOUNCEMENT_PRIORITY_ORDER = { high: 0, normal: 1, low: 2 };
        const ANNOUNCEMENT_PRIORITY_META = {
            high: { label: 'ด่วนมาก', icon: 'fa-triangle-exclamation', light: { bg: '#fef2f2', bgTo: '#fee2e2', border: '#fca5a5', text: '#991b1b', iconBg: '#ef4444' }, dark: { bg: 'rgba(76,29,39,0.5)', bgTo: 'rgba(69,10,10,0.5)', border: 'rgba(248,113,113,0.4)', text: '#fecaca', iconBg: '#ef4444' } },
            normal: { label: 'ทั่วไป', icon: 'fa-bullhorn', light: { bg: '#fffbeb', bgTo: '#fff7ed', border: '#fcd34d', text: '#78350f', iconBg: '#fbbf24' }, dark: { bg: 'rgba(69,39,9,0.5)', bgTo: 'rgba(67,20,7,0.5)', border: 'rgba(251,191,36,0.35)', text: '#fde68a', iconBg: '#f59e0b' } },
            low: { label: 'แจ้งเพื่อทราบ', icon: 'fa-circle-info', light: { bg: '#eff6ff', bgTo: '#f0f9ff', border: '#93c5fd', text: '#1e3a8a', iconBg: '#3b82f6' }, dark: { bg: 'rgba(23,37,84,0.5)', bgTo: 'rgba(12,74,110,0.4)', border: 'rgba(96,165,250,0.35)', text: '#bfdbfe', iconBg: '#3b82f6' } },
        };
        function getActiveAnnouncements() {
            ensureAnnouncementsArray();
            return settings.announcements.filter(isAnnouncementItemActive).sort((a, b) => (ANNOUNCEMENT_PRIORITY_ORDER[a.priority] ?? 1) - (ANNOUNCEMENT_PRIORITY_ORDER[b.priority] ?? 1));
        }
        function updateAnnouncementBar() {
            const container = document.getElementById('announcementBarContainer');
            if (!container) return;
            const active = getActiveAnnouncements();
            if (active.length === 0) { container.innerHTML = ''; container.classList.add('hidden'); return; }
            // [แก้ไข] ไม่ปรับสีตาม Dark Mode อีกต่อไป - ใช้ชุดสีเดียว (light) เสมอ ตามที่ขอ
            container.innerHTML = active.map(a => {
                const meta = ANNOUNCEMENT_PRIORITY_META[a.priority] || ANNOUNCEMENT_PRIORITY_META.normal;
                const c = meta.light;
                return `<div class="border-b-2 shadow-sm" style="background: linear-gradient(to right, ${c.bg}, ${c.bgTo}); border-color: ${c.border};"><div class="max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-2 sm:py-3 flex items-start sm:items-center gap-2 sm:gap-3"><div class="w-6 h-6 sm:w-8 sm:h-8 text-white rounded-full flex items-center justify-center text-[10px] sm:text-sm shrink-0 shadow-sm" style="background-color: ${c.iconBg};"><i class="fas ${meta.icon}"></i></div><span class="flex-1 min-w-0 text-[11px] sm:text-sm font-bold leading-snug break-words" style="color: ${c.text};">${(a.text || '').replace(/</g,'&lt;')}</span></div></div>`;
            }).join('');
            container.classList.remove('hidden');
        }

        // ===== ระบบวันหยุด =====
        function getHolidayForDate(dateStr) {
            // [v1.72.1] วันหยุดที่ตั้งในเว็บเช็คชื่อมาก่อน (ตั้งทับได้ เช่น เปลี่ยนเป็นวันชดเชย) แล้วจึงดูวันหยุดเรียนจาก AcademicHub
            return (settings.holidays || []).find(h => h.date === dateStr) || (hubHolidays || []).find(h => h.date === dateStr) || null;
        }
        // ===== [ใหม่] หา "วันในสัปดาห์ที่ควรใช้หาตารางสอน" ของวันที่ที่ให้มา - ปกติคือวันจริงตามปฏิทิน แต่ถ้าวันนั้นตั้งเป็น "สอนชดเชย" (type: makeup) จะใช้ตารางของวันที่ระบุไว้แทนทั้งวัน =====
        function getEffectiveDayOfWeek(dateStr) {
            const holiday = getHolidayForDate(dateStr);
            if (holiday && holiday.type === 'makeup' && holiday.useDayOfWeek) return parseInt(holiday.useDayOfWeek);
            return new Date(dateStr).getDay() || 7; // จันทร์=1 ... เสาร์=6, อาทิตย์ 0->7 (ปกติจะไม่มีตารางวันเสาร์-อาทิตย์อยู่แล้ว เว้นแต่เป็นวันสอนชดเชย)
        }
        function todayDateStr() {
            const d = new Date();
            return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
        }
        function updateHolidayBar() {
            const bar = document.getElementById('holidayBar');
            const textEl = document.getElementById('holidayBarText');
            if (!bar || !textEl) return;
            const todayHoliday = getHolidayForDate(todayDateStr());
            if (todayHoliday) {
                const type = todayHoliday.type || 'holiday';
                const durLabel = todayHoliday.duration ? ` (${HOLIDAY_DURATION_LABEL[todayHoliday.duration] || ''})` : '';
                const prefix = type === 'holiday' ? 'วันนี้เป็นวันหยุด' : (type === 'activity' ? 'วันนี้มีกิจกรรม' : 'วันนี้มีสอบ');
                textEl.innerText = `${prefix}: ${todayHoliday.label}${durLabel}`;
                bar.classList.remove('hidden');
            }
            else { bar.classList.add('hidden'); textEl.innerText = ''; }
        }

        // ===== สถานะเซิร์ฟเวอร์ (ออนไลน์/ปิดปรับปรุง) =====
        function applyServerStatusBadge() {
            const badge = document.getElementById('serverStatusBadge');
            const dot = document.getElementById('serverStatusDot');
            const text = document.getElementById('serverStatusText');
            if (!badge || !dot || !text) return;
            const manualOnline = settings.serverOnline !== false;
            const termMaintenance = publicTermStatus() === 'maintenance';
            const online = manualOnline && !termMaintenance;
            badge.classList.remove('hidden'); badge.classList.add('inline-flex');
            if (online) {
                badge.className = 'inline-flex items-center gap-1 text-[9px] sm:text-[10px] font-bold px-1.5 py-0.5 rounded-full border bg-emerald-50 border-emerald-200 text-emerald-700';
                dot.className = 'w-1.5 h-1.5 rounded-full bg-emerald-500';
                text.innerText = 'ออนไลน์';
            } else {
                badge.className = 'inline-flex items-center gap-1 text-[9px] sm:text-[10px] font-bold px-1.5 py-0.5 rounded-full border bg-rose-50 border-rose-200 text-rose-600';
                dot.className = 'w-1.5 h-1.5 rounded-full bg-rose-500';
                text.innerText = (!manualOnline) ? 'ปิดปรับปรุง' : 'ปิดปรับปรุงชั่วคราว (ภาคเรียนนี้)';
            }
        }
        window.toggleServerOnline = function() {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่เปลี่ยนสถานะนี้ได้", "error"); return; }
            const newVal = !(settings.serverOnline !== false);
            showConfirm(newVal ? "เปิดสถานะออนไลน์" : "ปิดสถานะออนไลน์ (ปรับปรุงเว็บไซต์)", newVal ? "ต้องการเปลี่ยนสถานะเว็บไซต์กลับเป็นออนไลน์ใช่หรือไม่?" : "ต้องการตั้งสถานะเว็บไซต์เป็น 'ปิดปรับปรุง' ใช่หรือไม่? (ผู้ใช้ทุกคนจะเห็นสถานะนี้)", () => {
                settings.serverOnline = newVal;
                applyServerStatusBadge();
                logAction(newVal ? 'เปิดสถานะเว็บไซต์เป็นออนไลน์' : 'ปิดสถานะเว็บไซต์ (ปรับปรุง)', '', 'settings');
                saveData('full'); showToast(newVal ? "ตั้งสถานะเป็นออนไลน์แล้ว" : "ตั้งสถานะเป็นปิดปรับปรุงแล้ว"); renderAdminTab();
            });
        };

        // ===== [v1.70] Toast แบบใหม่: แถบเดียวล่างจอ เปลี่ยนสถานะในตัว (กำลังบันทึก → บันทึกแล้ว) ไม่ซ้อนกันหลายอัน =====
        // error จะค้างนานขึ้นและมีปุ่มปิด / ส่ง opts.action = { label, onClick } เพื่อแสดงปุ่มลัด เช่น "ลองอีกครั้ง"
        let __toastEl = null, __toastTimer = null;
        function __ensureToastStyle() {
            if (document.getElementById('__toastStyleV170')) return;
            const st = document.createElement('style'); st.id = '__toastStyleV170';
            st.textContent = `@keyframes __tRise{from{transform:translateY(16px);opacity:0}to{transform:translateY(0);opacity:1}}@keyframes __tDropIn{from{transform:translateY(-18px) scale(.92);opacity:0}to{transform:translateY(0) scale(1);opacity:1}}@keyframes __tFlash{0%{background-color:#bbf7d0;box-shadow:inset 0 0 0 2px #34d399}100%{background-color:transparent;box-shadow:inset 0 0 0 2px transparent}}@keyframes __tDrop{0%{transform:translate(-50%,-24px);opacity:0}10%{transform:translate(-50%,0);opacity:1}88%{transform:translate(-50%,0);opacity:1}100%{transform:translate(-50%,-8px);opacity:0}}@keyframes __tTick{from{stroke-dashoffset:24}to{stroke-dashoffset:0}}@keyframes __tShake{0%,100%{transform:translateX(0)}25%{transform:translateX(-5px)}75%{transform:translateX(5px)}}@keyframes __tBolt{0%{transform:scale(.3);opacity:0}70%{transform:scale(1.25);opacity:1}100%{transform:scale(1)}}.__t-rise{animation:__tRise .28s cubic-bezier(.2,.8,.2,1)}.__t-drop{animation:__tDropIn .3s cubic-bezier(.2,.8,.2,1)}.__t-out{transition:opacity .25s, transform .25s;opacity:0;transform:translateY(-10px)}.__t-tick{stroke-dasharray:24;animation:__tTick .4s .12s ease-out both}.row-flash,.row-flash>td{animation:__tFlash 2s ease-out}.__rt-chip{animation:__tDrop 3.4s ease forwards}.__shake{animation:__tShake .3s ease-in-out 2}.__bolt{animation:__tBolt .35s ease-out both}`;
            document.head.appendChild(st);
        }
        function hideToast() {
            clearTimeout(__toastTimer);
            const el = __toastEl; if (!el) return;
            __toastEl = null; el.classList.add('__t-out'); setTimeout(() => { if (el.parentNode) el.parentNode.removeChild(el); }, 260);
        }
        // [v1.71.3] ป้ายแจ้งเตือนแบบ C: ป้ายเล็กกลางจอด้านบน สีเขียว = สำเร็จ, สีม่วง = กำลังทำ, สีแดง = ผิดพลาด (ค้างนานกว่า + ปุ่มปิด)
        function showToast(message, type = 'success', opts = {}) {
            const container = document.getElementById('toastContainer'); if (!container) return;
            __ensureToastStyle();
            container.className = 'fixed top-20 sm:top-24 left-1/2 -translate-x-1/2 z-[70] w-max max-w-[92vw] pointer-events-none flex justify-center';
            container.setAttribute('role', 'status'); container.setAttribute('aria-live', 'polite');
            const tick = '<span class="w-6 h-6 rounded-full bg-white flex items-center justify-center shrink-0"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#059669" stroke-width="3.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path class="__t-tick" d="M5 12.5l4.5 4.5L19 7.5"></path></svg></span>';
            const conf = {
                success: { cls: 'bg-emerald-600 rounded-full pl-2 pr-4', icon: tick, dur: 3000 },
                info: { cls: 'bg-indigo-600 rounded-full pl-3 pr-4', icon: '<i class="fas fa-circle-notch fa-spin text-indigo-100"></i>', dur: 10000 },
                error: { cls: 'bg-rose-600 rounded-2xl pl-3 pr-2', icon: '<i class="fas fa-exclamation-circle text-rose-100 text-lg"></i>', dur: 7000 }
            }[type] || { cls: 'bg-slate-700 rounded-full pl-3 pr-4', icon: '<i class="fas fa-info-circle"></i>', dur: 3500 };
            const dur = opts.duration || conf.dur;
            const isNew = !__toastEl;
            if (isNew) { __toastEl = document.createElement('div'); container.appendChild(__toastEl); }
            const el = __toastEl;
            el.className = `pointer-events-auto text-white shadow-lg flex items-center gap-2 py-2 ${conf.cls} ${isNew ? '__t-drop' : ''}`;
            const safeMsg = String(message == null ? '' : message).replace(/&/g, '&amp;').replace(/</g, '&lt;');
            const actionBtn = opts.action ? `<button type="button" class="__t-action shrink-0 h-8 px-3 rounded-full bg-white font-extrabold text-xs sm:text-sm" style="color:${type === 'error' ? '#be123c' : '#4338ca'}">${opts.action.label}</button>` : '';
            const closeBtn = type === 'error' ? `<button type="button" class="__t-close shrink-0 w-8 h-8 rounded-full text-white/80 hover:text-white" aria-label="ปิดการแจ้งเตือน"><i class="fas fa-times"></i></button>` : '';
            el.innerHTML = `${conf.icon}<span class="font-bold text-sm sm:text-base leading-snug">${safeMsg}</span>${actionBtn}${closeBtn}`;
            const a = el.querySelector('.__t-action'); if (a) a.onclick = () => { hideToast(); try { opts.action.onClick(); } catch (e) {} };
            const c = el.querySelector('.__t-close'); if (c) c.onclick = hideToast;
            clearTimeout(__toastTimer); __toastTimer = setTimeout(hideToast, dur);
        }

        let confirmCallback = null, promptCallback = null;
        function showConfirm(title, message, callback, confirmLabel, hideCancel, theme) { 
            document.getElementById('confirmTitle').innerText = title;
            document.getElementById('confirmMessage').innerText = message; document.getElementById('confirmBtn').innerText = confirmLabel || 'ยืนยัน'; confirmCallback = callback; const modal = document.getElementById('confirmModal');
            const confirmBtn = document.getElementById('confirmBtn');
            // ===== [ใหม่] ป็อปอัพแบบ "สำเร็จ" ใช้ปุ่มสีเขียว + ไอคอนติ๊กถูกแทนไอคอนตกใจ/เตือนสีแดงเริ่มต้น (อ้างอิง class จริงจาก index.html ตรงๆ ไม่ต้องเดา) =====
            const badgeWrap = document.querySelector('#confirmModalBox .rounded-full'); // ป้ายวงกลมไอคอน (bg-rose-100 text-rose-500 <i>...)
            const badgeIcon = badgeWrap ? badgeWrap.querySelector('i') : null;
            if (theme === 'success') {
                confirmBtn.className = confirmBtn.className.replace('bg-rose-600', 'bg-emerald-600').replace('hover:bg-rose-700', 'hover:bg-emerald-700').replace('shadow-rose-200', 'shadow-emerald-200');
                if (badgeWrap) badgeWrap.className = badgeWrap.className.replace('bg-rose-100', 'bg-emerald-100').replace('text-rose-500', 'text-emerald-500');
                if (badgeIcon) badgeIcon.className = 'fas fa-check-circle';
            } else {
                confirmBtn.className = confirmBtn.className.replace('bg-emerald-600', 'bg-rose-600').replace('hover:bg-emerald-700', 'hover:bg-rose-700').replace('shadow-emerald-200', 'shadow-rose-200');
                if (badgeWrap) badgeWrap.className = badgeWrap.className.replace('bg-emerald-100', 'bg-rose-100').replace('text-emerald-500', 'text-rose-500');
                if (badgeIcon) badgeIcon.className = 'fas fa-exclamation-triangle';
            }
            const cancelBtn = document.getElementById('confirmBtn').previousElementSibling; if (cancelBtn) cancelBtn.classList.toggle('hidden', !!hideCancel); // ซ่อนปุ่ม "ยกเลิก" สำหรับป็อปอัพแจ้งผลแบบมีแค่ปุ่มเดียว (เช่น แจ้งเช็คชื่อสำเร็จ)
            const box = document.getElementById('confirmModalBox'); modal.classList.remove('hidden'); setTimeout(() => { box.classList.remove('scale-95', 'opacity-0'); box.classList.add('scale-100', 'opacity-100'); }, 10);
        }
        function closeConfirm() { const modal = document.getElementById('confirmModal'); const box = document.getElementById('confirmModalBox');
            box.classList.remove('scale-100', 'opacity-100'); box.classList.add('scale-95', 'opacity-0'); setTimeout(() => { modal.classList.add('hidden'); confirmCallback = null; }, 300);
        }
        document.getElementById('confirmBtn').addEventListener('click', () => { if (confirmCallback) confirmCallback(); closeConfirm(); });
        function showPrompt(title, message, defaultValue, callback) { document.getElementById('promptTitle').innerText = title; document.getElementById('promptMessage').innerText = message; document.getElementById('promptInput').value = defaultValue; promptCallback = callback;
            const modal = document.getElementById('promptModal'); const box = document.getElementById('promptModalBox'); modal.classList.remove('hidden'); setTimeout(() => { box.classList.remove('scale-95', 'opacity-0'); box.classList.add('scale-100', 'opacity-100'); document.getElementById('promptInput').focus(); }, 10);
        }
        function closePrompt() { const modal = document.getElementById('promptModal'); const box = document.getElementById('promptModalBox');
            box.classList.remove('scale-100', 'opacity-100'); box.classList.add('scale-95', 'opacity-0'); setTimeout(() => { modal.classList.add('hidden'); promptCallback = null; }, 300);
        }
        document.getElementById('promptBtn').addEventListener('click', () => { const val = document.getElementById('promptInput').value.trim(); if (promptCallback) promptCallback(val); closePrompt(); });
        // ===== ป็อปอัพแสดง Progress Bar สำหรับงานที่ใช้เวลานาน (เช่น สร้างสมุดทะเบียนหลายสิบหน้า) =====
        function showProgressModal(title, message) {
            document.getElementById('progressTitle').innerText = title;
            document.getElementById('progressMessage').innerText = message || 'กรุณารอสักครู่...';
            document.getElementById('progressBarFill').style.width = '0%';
            document.getElementById('progressPercentText').innerText = '0%';
            document.getElementById('progressIconWrap').className = 'w-16 h-16 sm:w-20 sm:h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6 text-indigo-500 text-3xl sm:text-4xl shadow-inner';
            document.getElementById('progressIcon').className = 'fas fa-cog fa-spin';
            document.getElementById('progressCloseBtn').classList.add('hidden');
            const modal = document.getElementById('progressModal'); const box = document.getElementById('progressModalBox');
            modal.classList.remove('hidden'); setTimeout(() => { box.classList.remove('scale-95', 'opacity-0'); box.classList.add('scale-100', 'opacity-100'); }, 10);
        }
        function updateProgressModal(percent, message) {
            document.getElementById('progressBarFill').style.width = Math.min(100, Math.max(0, percent)) + '%';
            document.getElementById('progressPercentText').innerText = Math.round(percent) + '%';
            if (message) document.getElementById('progressMessage').innerText = message;
        }
        function completeProgressModal(title, message) {
            document.getElementById('progressBarFill').style.width = '100%';
            document.getElementById('progressPercentText').innerText = '100%';
            document.getElementById('progressTitle').innerText = title || 'ดำเนินการเสร็จสิ้น';
            document.getElementById('progressMessage').innerText = message || '';
            document.getElementById('progressIconWrap').className = 'w-16 h-16 sm:w-20 sm:h-20 bg-emerald-100 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6 text-emerald-500 text-3xl sm:text-4xl shadow-inner';
            document.getElementById('progressIcon').className = 'fas fa-check';
            document.getElementById('progressCloseBtn').classList.remove('hidden');
        }
        function errorProgressModal(message) {
            document.getElementById('progressTitle').innerText = 'เกิดข้อผิดพลาด';
            document.getElementById('progressMessage').innerText = message || 'กรุณาลองใหม่อีกครั้ง';
            document.getElementById('progressIconWrap').className = 'w-16 h-16 sm:w-20 sm:h-20 bg-rose-100 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6 text-rose-500 text-3xl sm:text-4xl shadow-inner';
            document.getElementById('progressIcon').className = 'fas fa-exclamation-triangle';
            document.getElementById('progressCloseBtn').classList.remove('hidden');
        }
        // ===== [ใหม่] เวอร์ชันสปินเนอร์ล้วนๆ ของ progressModal (ไม่มีหลอด % ปลอม) - ใช้กับงานเร็วๆ ที่ไม่มีความคืบหน้าจริงให้แสดง เช่น บันทึกเช็คชื่อ =====
        function showLoadingSpinnerModal(title, message) {
            document.getElementById('progressTitle').innerText = title;
            document.getElementById('progressMessage').innerText = message || 'กรุณารอสักครู่...';
            document.getElementById('progressIconWrap').className = 'w-16 h-16 sm:w-20 sm:h-20 bg-indigo-100 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6 text-indigo-500 text-3xl sm:text-4xl shadow-inner';
            document.getElementById('progressIcon').className = 'fas fa-spinner fa-spin';
            document.getElementById('progressBarFill').parentElement.classList.add('hidden');
            document.getElementById('progressPercentText').classList.add('hidden');
            document.getElementById('progressCloseBtn').classList.add('hidden');
            const modal = document.getElementById('progressModal'); const box = document.getElementById('progressModalBox');
            modal.classList.remove('hidden'); setTimeout(() => { box.classList.remove('scale-95', 'opacity-0'); box.classList.add('scale-100', 'opacity-100'); }, 10);
        }
        window.closeProgressModal = function() {
            document.getElementById('progressBarFill').parentElement.classList.remove('hidden'); // คืนค่าให้แสดงหลอด % ตามปกติ เผื่อครั้งต่อไปเป็นงานที่มีความคืบหน้าจริง (เช่น สร้างสมุดทะเบียน)
            document.getElementById('progressPercentText').classList.remove('hidden');
            const modal = document.getElementById('progressModal'); const box = document.getElementById('progressModalBox');
            box.classList.remove('scale-100', 'opacity-100'); box.classList.add('scale-95', 'opacity-0');
            setTimeout(() => { modal.classList.add('hidden'); }, 300);
        };
        function renderAdminLogin() {
            if (isAdmin) { navigate('admin'); return; }
            let rememberedUser = ''; let rememberedPass = ''; let rememberedChecked = false;
            try {
                const saved = localStorage.getItem('bnksa_remember_login');
                if (saved) { const parsed = JSON.parse(saved); rememberedUser = parsed.u || ''; rememberedPass = parsed.p || ''; rememberedChecked = true; }
            } catch (e) {}
            document.getElementById('mainContent').innerHTML = `<div class="max-w-md mx-auto mt-8 sm:mt-16 bg-white rounded-[2rem] shadow-xl border border-slate-100 p-6 sm:p-10 transform transition-all mx-2 sm:mx-auto"><div class="text-center mb-8 sm:mb-10"><div class="w-16 h-16 sm:w-20 sm:h-20 bg-indigo-50 rounded-full flex items-center justify-center mx-auto mb-4 sm:mb-6 text-indigo-600 text-2xl sm:text-3xl shadow-inner border border-indigo-100"><i class="fas fa-user-shield"></i></div><h2 class="text-2xl sm:text-3xl font-extrabold text-slate-800">ผู้ดูแลระบบ</h2><p class="text-sm sm:text-base text-slate-500 mt-2 font-medium">จัดการระบบเช็คชื่อนักเรียน</p></div><div class="space-y-4 sm:space-y-5"><div><label class="block text-xs sm:text-sm font-bold text-slate-700 mb-2 ml-1">ชื่อผู้ใช้งาน</label><input type="text" id="adminUser" value="${rememberedUser}" class="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 sm:px-5 sm:py-3.5 text-base focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-500 font-medium text-slate-700" placeholder="Username" autocapitalize="off" autocorrect="off"></div><div><label class="block text-xs sm:text-sm font-bold text-slate-700 mb-2 ml-1">รหัสผ่าน</label><div class="relative"><input type="password" id="adminPass" value="${rememberedPass}" class="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 sm:px-5 sm:py-3.5 pr-12 text-base focus:outline-none focus:ring-4 focus:ring-indigo-500/20 focus:border-indigo-500 font-medium text-slate-700" placeholder="••••••••" onkeyup="if(event.key === 'Enter') window.processLogin()"><button type="button" onclick="window.toggleLoginPasswordVisibility()" tabindex="-1" class="absolute right-3 sm:right-4 top-1/2 -translate-y-1/2 text-slate-400 hover:text-indigo-600 transition-colors"><i class="fas fa-eye" id="loginPassToggleIcon"></i></button></div></div><label class="flex items-center gap-2 pl-1 cursor-pointer select-none"><input type="checkbox" id="rememberLoginCheck" ${rememberedChecked ? 'checked' : ''} class="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"><span class="text-xs sm:text-sm font-bold text-slate-600">จดจำการเข้าสู่ระบบ</span></label><div class="pt-2 sm:pt-4 space-y-3"><button onclick="window.processLogin()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white rounded-2xl py-3 sm:py-4 font-bold text-base sm:text-lg transition-all shadow-lg shadow-indigo-200 flex items-center justify-center gap-2"><i class="fas fa-sign-in-alt"></i> เข้าสู่ระบบ</button><button onclick="window.navigate('dashboard')" class="w-full bg-white hover:bg-slate-50 text-slate-600 border border-slate-200 rounded-2xl py-3 sm:py-3.5 font-bold text-sm sm:text-base transition-colors">กลับหน้าหลัก</button></div></div></div>`;
        }

        window.toggleLoginPasswordVisibility = function() {
            const input = document.getElementById('adminPass');
            const icon = document.getElementById('loginPassToggleIcon');
            if (!input || !icon) return;
            const showing = input.type === 'text';
            input.type = showing ? 'password' : 'text';
            icon.classList.toggle('fa-eye', showing);
            icon.classList.toggle('fa-eye-slash', !showing);
        };

        // ===== [ใหม่] เข้ารหัสรหัสผ่านแบบ SHA-256 - เก็บเป็น hash แทนตัวหนังสือธรรมดา แกะย้อนกลับเป็นรหัสผ่านจริงไม่ได้แม้จะเห็นข้อมูลดิบ =====
        async function sha256Hex(text) {
            const enc = new TextEncoder().encode(text);
            const hashBuf = await crypto.subtle.digest('SHA-256', enc);
            return Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
        }
        async function processLogin() {
            const uname = document.getElementById('adminUser').value.trim();
            const pass = document.getElementById('adminPass').value;
            const passHash = await sha256Hex(pass);
            // [v1.71.5] ตรวจชื่อผู้ใช้/รหัสผ่านที่ Worker (หน้าเว็บไม่มีรายชื่อบัญชีและรหัสผ่านอีกต่อไป) — ชื่อผู้ใช้ไม่สนตัวพิมพ์เล็ก-ใหญ่ · บัญชีเก่าที่เก็บรหัสผ่านตรงๆ Worker เปลี่ยนเป็น hash ให้เอง
            let j = null;
            try {
                const res = await fetch(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'login', username: uname, passHash }) });
                j = await res.json();
            } catch (e) { showToast("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่", "error"); return; }
            if (!j || j.status !== 'success' || !j.token) { showToast((j && j.message) || "ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง", "error"); return; }
            adminToken = j.token;
            settings.users = Array.isArray(j.users) ? j.users : [];
            isAdmin = true; currentUser = { id: j.user.id, username: j.user.username, name: j.user.name, role: j.user.role };
            const remember = document.getElementById('rememberLoginCheck').checked;
            try {
                if (remember) localStorage.setItem('bnksa_remember_login', JSON.stringify({ u: uname, p: pass }));
                else localStorage.removeItem('bnksa_remember_login');
            } catch (e) {}
            document.getElementById('btnAdminLogin').classList.add('hidden'); document.getElementById('btnAdminPanel').classList.remove('hidden'); document.getElementById('btnAdminLogout').classList.remove('hidden'); updateCurrentUserBadge(); showToast("เข้าสู่ระบบสำเร็จ");
            logAction('เข้าสู่ระบบ', `เข้าสู่ระบบด้วยบัญชีเจ้าหน้าที่`, 'account');
            navigate('admin');
        }
        // [v1.71.5] บัตรผ่านหมดอายุ (เกิน 12 ชั่วโมง) หรือบัญชีถูกลบ/เปลี่ยนสิทธิ์ — ออกจากระบบแล้วให้เข้าสู่ระบบใหม่
        window.__adminSessionExpired = function () {
            if (!isAdmin) return;
            isAdmin = false; currentUser = null; adminToken = ''; adminWorkingTerm = null;
            document.getElementById('btnAdminLogin').classList.remove('hidden'); document.getElementById('btnAdminPanel').classList.add('hidden'); document.getElementById('btnAdminLogout').classList.add('hidden'); updateCurrentUserBadge();
            showToast("หมดเวลาเข้าสู่ระบบ กรุณาเข้าสู่ระบบใหม่", "error");
            navigate('admin_login');
        };
        function logoutAdmin() {
            showConfirm("ออกจากระบบ", "คุณต้องการออกจากระบบผู้ดูแลใช่หรือไม่?", () => {
                if (currentUser) { logAction('ออกจากระบบ', `ออกจากระบบบัญชีเจ้าหน้าที่`, 'account'); }
                isAdmin = false; currentUser = null; adminWorkingTerm = null; adminToken = '';
                document.getElementById('btnAdminLogin').classList.remove('hidden'); document.getElementById('btnAdminPanel').classList.add('hidden'); document.getElementById('btnAdminLogout').classList.add('hidden'); updateCurrentUserBadge(); showToast("ออกจากระบบแล้ว"); navigate('dashboard');
            });
        }

        // ===== ออกจากระบบอัตโนมัติเมื่อไม่มีการใช้งานเกิน 30 นาที =====
        let lastActivityTime = Date.now();
        const INACTIVITY_LIMIT_MS = 30 * 60 * 1000;
        function initInactivityTracking() {
            ['click', 'keydown', 'touchstart', 'mousemove', 'scroll'].forEach(evt => {
                window.addEventListener(evt, () => { lastActivityTime = Date.now(); }, { passive: true });
            });
            setInterval(() => {
                if (isAdmin && (Date.now() - lastActivityTime > INACTIVITY_LIMIT_MS)) {
                    autoLogoutDueToInactivity();
                }
            }, 60000);
        }
        function autoLogoutDueToInactivity() {
            if (!isAdmin) return;
            const uname = currentUser ? currentUser.username : '';
            if (currentUser) { logAction('ออกจากระบบอัตโนมัติ (หมดเวลา)', `ไม่มีการใช้งานเกิน 30 นาที บัญชี ${uname}`, 'account'); }
            isAdmin = false; currentUser = null; adminToken = '';
            document.getElementById('btnAdminLogin').classList.remove('hidden'); document.getElementById('btnAdminPanel').classList.add('hidden'); document.getElementById('btnAdminLogout').classList.add('hidden'); updateCurrentUserBadge();
            showToast("ออกจากระบบอัตโนมัติ เนื่องจากไม่มีการใช้งานเกิน 30 นาที", "error");
            navigate('dashboard');
        }

        function renderDashboard() {
            if(isAdmin) { document.getElementById('btnAdminLogin').classList.add('hidden');
                document.getElementById('btnAdminPanel').classList.remove('hidden'); document.getElementById('btnAdminLogout').classList.remove('hidden'); }
            const isDarkNow = document.documentElement.classList.contains('dark'); // เช็คโหมดมืดตรงๆ ตอนวาดหน้า กันปัญหาการไล่สีพาสเทลไม่ยอมเปลี่ยนเป็นสีเข้ม (แก้ตรงจุดแทนพึ่ง CSS override ที่อาจโดนแคช/ลำดับชนกัน)
            // หน้าแรกแสดงภาคเรียนเริ่มต้นตามที่แอดมินกำหนดไว้เสมอเมื่อเข้าเว็บ/รีเฟรช (settings.term)
            // แต่สามารถกดปุ่มด้านล่างเพื่อ "ดูตัวอย่าง" ภาคเรียนอื่นชั่วคราวได้ - การเลือกนี้ไม่ถูกบันทึก รีเฟรชหน้าเว็บแล้วจะกลับไปภาคเรียนเริ่มต้นเสมอ
            const termCount = settings.termCount || 2;
            const previewButtonsHtml = termCount >= 2 ? `<div class="flex items-center justify-center gap-1.5 bg-slate-100 p-1 rounded-xl w-max mx-auto mt-4">${Array.from({length: termCount}, (_, i) => i + 1).map(tn => {
                const st = getTermStatus(tn, settings.year);
                const isActiveBtn = String(viewTerm()) === String(tn);
                const guestLocked = st === 'not_opened' && !isAdmin;
                if (guestLocked) {
                    return `<button disabled title="ภาคเรียนนี้ยังไม่เปิดใช้งาน" class="px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg font-bold text-xs sm:text-sm flex items-center gap-1.5 bg-slate-200 text-slate-400 cursor-not-allowed"><i class="fas fa-lock"></i> ภาคเรียน ${tn}</button>`;
                }
                const activeCls = isActiveBtn ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:bg-white active:scale-95';
                return `<button onclick="window.previewSwitchTerm('${tn}')" class="px-3 sm:px-4 py-1.5 sm:py-2 rounded-lg font-bold text-xs sm:text-sm transition-all flex items-center gap-1.5 ${activeCls}">${isActiveBtn ? '<i class="fas fa-check-circle"></i>' : ''} ภาคเรียน ${tn}</button>`;
            }).join('')}</div>` : '';
            const stCfg = termStatusCardConfig(getTermStatus(viewTerm(), settings.year));
            const justSwitched = !!window.__justSwitchedTerm; window.__justSwitchedTerm = false;
            let html = buildExternalLinksHtml() + `<div id="termStatusCard" class="mb-6 sm:mb-8 ${stCfg.wrap} border-2 rounded-2xl sm:rounded-3xl p-4 sm:p-6 transition-all ${justSwitched ? 'term-switch-flash term-switch-ring' : ''}"><div class="flex flex-col items-center text-center gap-1.5"><div class="w-12 h-12 sm:w-14 sm:h-14 rounded-full bg-white shadow-sm flex items-center justify-center relative"><span class="absolute top-0 right-0 inline-flex h-3 w-3 rounded-full ${stCfg.dot}"></span><i class="fas ${stCfg.icon} ${stCfg.iconCls} text-xl sm:text-2xl"></i></div><p class="font-extrabold text-sm sm:text-lg ${stCfg.textCls}">${stCfg.text}</p><p class="text-[10px] sm:text-xs text-slate-500 font-bold"><i class="fas fa-calendar-alt"></i> ภาคเรียนที่ ${viewTerm()} ปีการศึกษา ${settings.year}</p></div>${previewButtonsHtml}</div>`;
            html += `<div id="clubBanner"></div>`; setTimeout(() => window.loadClubBanner && window.loadClubBanner(), 0); // [v1.78] ปุ่มเช็คชื่อชุมนุม (เฉพาะวันชุมนุม)
            html += `<div class="text-center mb-8 sm:mb-12"><h2 class="text-2xl sm:text-4xl font-extrabold text-slate-800 tracking-tight">เลือกห้องเรียน</h2><p class="text-sm sm:text-lg text-slate-500 mt-2 sm:mt-3">เลือกระดับชั้นเพื่อดำเนินการเช็คชื่อหรือดูรายงาน</p></div><div class="grid grid-cols-1 gap-6 sm:gap-10">`;
            const levelColors = {
                1: { gradient: 'from-blue-500 to-indigo-600', icon: 'text-blue-500', cardBg: 'bg-blue-50/70', cardBorder: 'border-blue-200', cardHoverBorder: 'hover:border-blue-400', cardText: 'text-blue-800', cardHoverText: 'group-hover:text-blue-600', cardShadow: 'hover:shadow-blue-200/60', arrow: 'text-blue-400' },
                2: { gradient: 'from-emerald-500 to-teal-600', icon: 'text-emerald-500', cardBg: 'bg-emerald-50/70', cardBorder: 'border-emerald-200', cardHoverBorder: 'hover:border-emerald-400', cardText: 'text-emerald-800', cardHoverText: 'group-hover:text-emerald-600', cardShadow: 'hover:shadow-emerald-200/60', arrow: 'text-emerald-400' },
                3: { gradient: 'from-amber-500 to-orange-600', icon: 'text-amber-500', cardBg: 'bg-amber-50/70', cardBorder: 'border-amber-200', cardHoverBorder: 'hover:border-amber-400', cardText: 'text-amber-800', cardHoverText: 'group-hover:text-amber-600', cardShadow: 'hover:shadow-amber-200/60', arrow: 'text-amber-400' },
                4: { gradient: 'from-rose-500 to-pink-600', icon: 'text-rose-500', cardBg: 'bg-rose-50/70', cardBorder: 'border-rose-200', cardHoverBorder: 'hover:border-rose-400', cardText: 'text-rose-800', cardHoverText: 'group-hover:text-rose-600', cardShadow: 'hover:shadow-rose-200/60', arrow: 'text-rose-400' },
                5: { gradient: 'from-purple-500 to-violet-600', icon: 'text-purple-500', cardBg: 'bg-purple-50/70', cardBorder: 'border-purple-200', cardHoverBorder: 'hover:border-purple-400', cardText: 'text-purple-800', cardHoverText: 'group-hover:text-purple-600', cardShadow: 'hover:shadow-purple-200/60', arrow: 'text-purple-400' },
                6: { gradient: 'from-cyan-500 to-sky-600', icon: 'text-cyan-500', cardBg: 'bg-cyan-50/70', cardBorder: 'border-cyan-200', cardHoverBorder: 'hover:border-cyan-400', cardText: 'text-cyan-800', cardHoverText: 'group-hover:text-cyan-600', cardShadow: 'hover:shadow-cyan-200/60', arrow: 'text-cyan-400' }
            };
            for (let i = 1; i <= 6; i++) {
                let count = settings.roomCounts[`m${i}`] || 0; if (count === 0) continue;
                let levelGradient = levelColors[i].gradient;
                let iconColor = levelColors[i].icon;
                const lc = levelColors[i];
                html += `<div class="bg-white rounded-3xl sm:rounded-[2rem] shadow-sm border border-slate-200 p-4 sm:p-8 relative overflow-hidden group/level"><div class="absolute top-0 left-0 w-1.5 sm:w-2.5 h-full bg-gradient-to-b ${levelGradient}"></div><h3 class="text-lg sm:text-2xl font-extrabold text-slate-800 mb-4 sm:mb-8 flex items-center gap-2 sm:gap-3 pl-3 sm:pl-4"><i class="fas fa-layer-group ${iconColor}"></i> มัธยมศึกษาปีที่ ${i} <span class="text-xs sm:text-base font-bold text-slate-400">(ภาคเรียนที่ ${viewTerm()} / ${settings.year})</span></h3><div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3 sm:gap-5 pl-3 sm:pl-4">`;
                for (let j = 1; j <= count; j++) { html += `<button onclick="window.navigate('classroom', {roomId: 'm${i}_${j}'})" class="${lc.cardBg} hover:bg-white border ${lc.cardBorder} ${lc.cardHoverBorder} rounded-xl sm:rounded-2xl p-3 sm:p-5 transition-all hover:-translate-y-1 hover:shadow-lg ${lc.cardShadow} text-left flex flex-col justify-between min-h-[80px] sm:min-h-[120px] group"><span class="text-xl sm:text-3xl font-black ${lc.cardText} ${lc.cardHoverText} transition-colors">ม.${i}/${j}</span><span class="text-[10px] sm:text-sm text-slate-500 font-bold mt-2 sm:mt-3 flex items-center justify-between">เข้าสู่ห้องเรียน <i class="fas fa-arrow-right ${lc.arrow} opacity-0 group-hover:opacity-100 transform -translate-x-3 group-hover:translate-x-0 transition-all duration-300"></i></span></button>`;
                }
                html += `</div></div>`;
            }

            html += `<div class="bg-white rounded-3xl sm:rounded-[2rem] shadow-sm border border-slate-200 p-4 sm:p-8 relative overflow-hidden group/level"><div class="absolute top-0 left-0 w-1.5 sm:w-2.5 h-full bg-gradient-to-b from-slate-500 to-slate-700"></div><button onclick="window.navigate('school_summary')" class="w-full text-left flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 pl-3 sm:pl-4 group"><div class="flex items-center gap-3 sm:gap-4"><div class="w-10 h-10 sm:w-14 sm:h-14 bg-slate-100 text-slate-700 rounded-xl sm:rounded-2xl flex items-center justify-center text-xl sm:text-2xl shrink-0 group-hover:scale-110 transition-transform shadow-sm"><i class="fas fa-school"></i></div><div><h3 class="text-lg sm:text-2xl font-extrabold text-slate-800 flex items-center gap-2">รวมทุกห้อง</h3><p class="text-xs sm:text-sm text-slate-500 mt-1 font-medium">ภาพรวมจำนวนนักเรียนและสถิติการมาเรียนทั้งโรงเรียนรายเดือน</p></div></div><span class="shrink-0 bg-slate-700 group-hover:bg-slate-800 text-white px-4 py-2.5 sm:px-6 sm:py-3 rounded-xl font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-2 w-full sm:w-auto justify-center"><i class="fas fa-chart-pie"></i> ดูภาพรวมทั้งโรงเรียน</span></button></div>`;
            
            html += `</div><div class="mt-12 sm:mt-20 mb-8"><div class="${isDarkNow ? 'bg-[#141e33]' : 'bg-gradient-to-br from-indigo-50 via-white to-blue-50'} rounded-[2rem] sm:rounded-[2.5rem] border-2 ${isDarkNow ? 'border-[#2d3d5a]' : 'border-indigo-100'} shadow-xl ${isDarkNow ? '' : 'shadow-indigo-100/60'} p-5 sm:p-10 relative overflow-hidden"><div class="absolute -top-16 -right-16 w-56 h-56 ${isDarkNow ? 'bg-indigo-500/10' : 'bg-indigo-200/30'} rounded-full blur-3xl pointer-events-none"></div><div class="absolute -bottom-16 -left-16 w-56 h-56 ${isDarkNow ? 'bg-blue-500/10' : 'bg-blue-200/30'} rounded-full blur-3xl pointer-events-none"></div><div class="relative z-10"><div class="text-center mb-8 sm:mb-10"><div class="inline-flex items-center justify-center w-14 h-14 sm:w-20 sm:h-20 bg-gradient-to-br from-indigo-500 to-blue-600 rounded-2xl sm:rounded-3xl shadow-lg shadow-indigo-300/50 mb-4 sm:mb-5 text-white text-2xl sm:text-4xl"><i class="fas fa-chalkboard-teacher"></i></div><span class="${isDarkNow ? 'bg-[#1f2c47] text-indigo-300 border-[#2d3d5a]' : 'bg-white text-indigo-700 border-indigo-200'} font-black px-3 py-1 sm:px-4 sm:py-1.5 rounded-full text-[10px] sm:text-sm inline-block mb-2 sm:mb-3 shadow-sm border tracking-wide">สำหรับคุณครูผู้สอน</span><h2 class="text-xl sm:text-4xl font-extrabold text-slate-800">ระบบจัดการประจำตัวครู</h2><p class="text-xs sm:text-lg text-slate-500 mt-2 sm:mt-3 font-medium px-4">เลือกกลุ่มสาระด้านล่าง แล้วแตะชื่อของท่านเพื่อเช็คชื่อหรือดูรายงาน</p></div>`;
            if (teachers.length === 0) { 
                html += `<div class="text-center text-slate-400 p-6 sm:p-8 bg-white/70 rounded-3xl border-2 border-slate-200 border-dashed text-sm sm:text-lg font-medium">ยังไม่มีข้อมูลครูผู้สอนในระบบ</div>`;
            } else { 
                // แสดงเป็นแท็บกลุ่มสาระ แทนการเรียงการ์ดครูทุกกลุ่มสาระต่อกันยาวๆ กันหน้าเว็บยาวเกินไป
                const dashSubs = activeSubjects(); const dashTeachers = teachers.filter(t => !t.inactive || dashSubs.some(s => s.teacher === t.name || s.teacher2 === t.name)); // [v1.71.2] ครูที่ย้ายออก แสดงเฉพาะภาคเรียนที่ยังมีวิชาสอน
                const deptsWithTeachers = departmentsList.filter(d => dashTeachers.some(t => (t.department || 'ระบบ/อื่นๆ') === d));
                if (!window.dashboardTeacherDept || !deptsWithTeachers.includes(window.dashboardTeacherDept)) {
                    window.dashboardTeacherDept = deptsWithTeachers[0];
                }
                const deptSolid = (cfg) => { const m = cfg.bg.match(/bg-(\w+)-100/); const color = m ? m[1] : 'indigo'; return { bg: `bg-${color}-600`, shadow: `shadow-${color}-200` }; };
                html += `<div class="grid grid-cols-2 sm:grid-cols-3 gap-2 sm:gap-3 mb-8 sm:mb-10 max-w-3xl mx-auto">${deptsWithTeachers.map(d => { const cfg = deptConfig[d]; const solid = deptSolid(cfg); const cnt = teachers.filter(t => (t.department || 'ระบบ/อื่นๆ') === d).length; const active = window.dashboardTeacherDept === d; return `<button onclick="window.selectDashboardTeacherDept('${d}')" class="${active ? `${solid.bg} text-white shadow-lg ${solid.shadow} scale-105 border-2 border-transparent` : `bg-white text-slate-600 border-2 border-slate-200 hover:${cfg.border} hover:shadow-md`} w-full px-3 sm:px-4 py-2.5 sm:py-3 rounded-2xl font-bold text-[11px] sm:text-sm transition-all duration-200 flex items-center justify-center gap-1.5 sm:gap-2"><i class="fas ${cfg.icon} ${active ? '' : cfg.text} shrink-0"></i><span class="truncate">${d}</span><span class="${active ? 'bg-white/25' : 'bg-slate-100 ' + cfg.text} px-1.5 py-0.5 rounded-full text-[9px] sm:text-[10px] font-black shrink-0">${cnt}</span></button>`; }).join('')}</div>`;

                const activeDept = window.dashboardTeacherDept;
                const cfg = deptConfig[activeDept];
                const solid = deptSolid(cfg);
                const deptTeachers = dashTeachers.filter(t => (t.department || 'ระบบ/อื่นๆ') === activeDept);
                html += `<div class="mb-2"><div class="flex items-center gap-3 mb-5 sm:mb-6"><div class="w-9 h-9 sm:w-11 sm:h-11 ${solid.bg} text-white rounded-xl flex items-center justify-center text-sm sm:text-lg shadow-md ${solid.shadow} shrink-0"><i class="fas ${cfg.icon}"></i></div><h3 class="text-lg sm:text-2xl font-extrabold text-slate-800">${activeDept}</h3><span class="ml-auto bg-white border ${cfg.border} ${cfg.text} text-[10px] sm:text-xs font-black px-2.5 py-1 rounded-full shadow-sm shrink-0">${deptTeachers.length} ท่าน</span></div><div class="grid grid-cols-2 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 sm:gap-5">${deptTeachers.sort((a,b) => a.name.localeCompare(b.name)).map(t => { const taughtSubjects = activeSubjects().filter(s => s.teacher === t.name || s.teacher2 === t.name);
                    return `<button onclick="window.navigate('teacher_dash', {teacherName: '${t.name}'})" class="bg-white border-2 ${cfg.border} rounded-2xl sm:rounded-3xl p-4 sm:p-6 transition-all duration-200 hover:shadow-2xl hover:-translate-y-1.5 text-left flex flex-col items-center text-center group relative overflow-hidden min-h-[140px] sm:min-h-[190px] justify-start"><div class="absolute top-0 left-0 w-full h-1.5 ${solid.bg}"></div><div class="w-12 h-12 sm:w-[4.5rem] sm:h-[4.5rem] ${solid.bg} text-white rounded-full flex items-center justify-center text-xl sm:text-3xl mb-3 sm:mb-4 mt-1 group-hover:scale-110 transition-transform shadow-md ${solid.shadow} shrink-0"><i class="fas fa-user-tie"></i></div><h4 class="font-extrabold text-xs sm:text-lg text-slate-800 relative w-full whitespace-nowrap overflow-hidden text-ellipsis px-1 leading-tight" title="${t.name}">${t.name}</h4><p class="text-[10px] sm:text-xs ${cfg.text} mt-2 font-bold ${cfg.bg} px-2.5 py-1 rounded-full shadow-sm relative mt-auto"><i class="fas fa-book mr-1"></i>${taughtSubjects.length} วิชา</p></button>`; }).join('')}</div></div>`;
            }
            html += `</div></div></div>`; document.getElementById('mainContent').innerHTML = html;
        }
        window.selectDashboardTeacherDept = function(dept) { window.dashboardTeacherDept = dept; renderDashboard(); };
        window.toggleTeacherLogRow = function(idx) {
            const detail = document.getElementById(`teacherLogDetail${idx}`); const chevron = document.getElementById(`teacherLogChevron${idx}`);
            if (!detail) return;
            const isHidden = detail.classList.contains('hidden');
            if (isHidden) { detail.classList.remove('hidden'); if (chevron) chevron.classList.add('rotate-90'); }
            else { detail.classList.add('hidden'); if (chevron) chevron.classList.remove('rotate-90'); }
        };

        // ===== [v1.71.3] หัวหน้าสรุปแบบเดียวกันทุกหน้า: ชื่อหน้า + ปุ่มกลับ / ปุ่มสลับมุมมอง / ปุ่มดาวน์โหลด-จัดการ ขนาดเท่ากัน =====
        function summaryHeaderHtml(o) {
            const tones = { indigo: 'bg-indigo-50 border-indigo-200 text-indigo-700 hover:bg-indigo-100', teal: 'bg-teal-50 border-teal-200 text-teal-700 hover:bg-teal-100', violet: 'bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100', purple: 'bg-purple-50 border-purple-200 text-purple-700 hover:bg-purple-100', emerald: 'bg-emerald-50 border-emerald-200 text-emerald-700 hover:bg-emerald-100', pink: 'bg-pink-50 border-pink-200 text-pink-700 hover:bg-pink-100', blue: 'bg-blue-50 border-blue-200 text-blue-700 hover:bg-blue-100', rose: 'bg-rose-50 border-rose-200 text-rose-600 hover:bg-rose-100', orange: 'bg-orange-50 border-orange-200 text-orange-700 hover:bg-orange-100', locked: 'bg-slate-100 border-slate-200 text-slate-400 cursor-not-allowed' };
            const tabs = o.tabs || [], actions = o.actions || [];
            const tabHtml = tabs.length ? `<div class="grid gap-1 bg-slate-100 p-1 rounded-xl w-full sm:max-w-md" style="grid-template-columns:repeat(${tabs.length},minmax(0,1fr))">${tabs.map(t => `<button onclick="${t.onclick}" class="h-9 sm:h-10 rounded-lg text-xs sm:text-sm font-extrabold transition-colors ${t.active ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-600 hover:bg-white'}">${t.label}</button>`).join('')}</div>` : '';
            const cols = Math.min(actions.length, 3);
            const actHtml = actions.length ? `<div>${o.actionsLabel !== '' ? `<p class="text-[11px] sm:text-xs font-extrabold text-slate-500 mb-1.5">${o.actionsLabel || 'ดาวน์โหลด / จัดการ'}</p>` : ''}<div class="grid gap-2 sm:flex sm:flex-wrap" style="grid-template-columns:repeat(${cols},minmax(0,1fr))">${actions.map(x => `<button ${x.disabled ? 'disabled' : `onclick="${x.onclick}"`} ${x.title ? `title="${x.title}"` : ''} class="min-h-[56px] sm:min-h-0 sm:h-11 sm:px-4 rounded-xl border-2 ${tones[x.tone] || tones.indigo} px-1 py-1.5 flex flex-col sm:flex-row items-center justify-center gap-1 sm:gap-2 text-[11px] sm:text-sm font-extrabold text-center leading-tight transition-colors"><i class="fas ${x.icon} text-base sm:text-sm"></i><span>${x.label}</span></button>`).join('')}</div></div>` : '';
            return `<div class="mb-4 sm:mb-8 bg-white p-4 sm:p-6 rounded-[1.5rem] sm:rounded-[2rem] shadow-sm border border-slate-200 flex flex-col gap-3 sm:gap-4"><div class="flex items-center gap-3">${o.iconHtml || ''}<div class="flex-1 min-w-0"><h2 class="text-lg sm:text-3xl font-extrabold text-slate-800 tracking-tight leading-tight break-words">${o.title}</h2>${o.subHtml || ''}</div><button onclick="${o.backAction}" class="shrink-0 h-10 sm:h-11 px-3 sm:px-5 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 font-extrabold text-sm flex items-center gap-1.5"><i class="fas fa-arrow-left"></i> กลับ</button></div>${tabHtml}${o.controlsHtml || ''}${actHtml}</div>`;
        }
        function renderSchoolSummary(selectedMonth = null) {
            const schoolTerm = settings.term, schoolYear = settings.year;
            const schoolTermYearKey = String(schoolTerm) + '_' + String(schoolYear);
            if (!window.__adminTermRoomsLoaded.has(schoolTermYearKey)) {
                document.getElementById('mainContent').innerHTML = renderLoadingProgressHTML('กำลังโหลดข้อมูลเช็คชื่อทุกห้อง...', 5, 'schoolLoadBar');
                ensureAttendanceLoadedForAllRoomsInTerm(schoolTerm, schoolYear, (done, total) => {
                    const pct = Math.round((done / total) * 100);
                    const bar = document.getElementById('schoolLoadBar'); if (bar) bar.style.width = pct + '%';
                    const pctText = document.getElementById('schoolLoadBar_pct'); if (pctText) pctText.textContent = pct;
                }).then(() => { window.__adminTermRoomsLoaded.add(schoolTermYearKey); renderSchoolSummary(selectedMonth); });
                return;
            }
            let currentDate = new Date();
            if (!selectedMonth) { let month = (currentDate.getMonth() + 1).toString().padStart(2, '0'); selectedMonth = `${currentDate.getFullYear()}-${month}`; }
            const monthNames = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
            const displayMonthYear = `${monthNames[parseInt(selectedMonth.split('-')[1])-1]} ${parseInt(selectedMonth.split('-')[0])+543}`;
            const activeStudents = students.filter(s => s.status !== 'resigned' && s.status !== 'hidden');
            const resignedCount = students.length - activeStudents.length;
            const levelCounts = computeLevelCounts();
            const totals = computeSchoolMonthlyStats(selectedMonth);
            const totalRecorded = Object.values(totals).reduce((a, b) => a + b, 0);
            const roomCount = getRoomList().length;

            let html = summaryHeaderHtml({ iconHtml: `<div class="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-slate-700 to-slate-900 rounded-2xl flex items-center justify-center text-white text-2xl sm:text-3xl shadow-lg shrink-0"><i class="fas fa-school"></i></div>`, title: `รวมทุกห้อง (ภาพรวมทั้งโรงเรียน)`, subHtml: `<p class="text-slate-500 font-bold mt-1 text-xs sm:text-sm">${roomCount} ห้องเรียน ทุกระดับชั้น</p>`, backAction: `window.navigate('dashboard')`, controlsHtml: `<label class="block"><span class="text-[11px] sm:text-xs font-extrabold text-slate-500">เดือน</span><input type="month" value="${selectedMonth}" onchange="window.navigate('school_summary', {month: this.value})" class="mt-1 w-full sm:w-auto h-10 bg-slate-50 border-2 border-slate-200 text-slate-700 rounded-xl px-3 font-bold text-sm outline-none"></label>`, actions: [{ label: 'PDF', icon: 'fa-file-pdf', tone: 'purple', onclick: `window.exportSectionInfographicPDF('schoolInfographicSection', 'ภาพรวมทั้งโรงเรียน_${selectedMonth}', 'pdf')` }, { label: 'รูปภาพ', icon: 'fa-file-image', tone: 'pink', onclick: `window.exportSectionInfographicPDF('schoolInfographicSection', 'ภาพรวมทั้งโรงเรียน_${selectedMonth}', 'image')` }] });

            html += `<div id="schoolInfographicSection">`;

            html += `<div class="bg-white border border-slate-200 rounded-2xl p-4 sm:p-6 mb-4 sm:mb-6 text-center">${pdfLogoHtml()}${pdfDocMeta()}<h2 class="text-lg sm:text-2xl font-extrabold text-slate-800">ภาพรวมทั้งโรงเรียน ประจำเดือน${displayMonthYear}</h2></div>`;

            html += `<div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5 sm:gap-4 mb-4 sm:mb-8">
                <div class="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 text-center shadow-sm"><div class="w-9 h-9 sm:w-11 sm:h-11 bg-slate-100 text-slate-700 rounded-full flex items-center justify-center mx-auto mb-2 text-sm sm:text-base"><i class="fas fa-users"></i></div><div class="text-2xl sm:text-4xl font-black text-slate-800">${students.length}</div><div class="text-[10px] sm:text-xs font-bold text-slate-500 mt-1">นักเรียนทั้งหมด</div></div>
                <div class="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 text-center shadow-sm"><div class="w-9 h-9 sm:w-11 sm:h-11 bg-emerald-50 text-emerald-600 rounded-full flex items-center justify-center mx-auto mb-2 text-sm sm:text-base"><i class="fas fa-user-check"></i></div><div class="text-2xl sm:text-4xl font-black text-emerald-600">${activeStudents.length}</div><div class="text-[10px] sm:text-xs font-bold text-slate-500 mt-1">กำลังเรียนอยู่</div></div>
                <div class="bg-white border border-slate-200 rounded-2xl p-4 sm:p-5 text-center shadow-sm col-span-2 sm:col-span-1"><div class="w-9 h-9 sm:w-11 sm:h-11 bg-rose-50 text-rose-600 rounded-full flex items-center justify-center mx-auto mb-2 text-sm sm:text-base"><i class="fas fa-user-minus"></i></div><div class="text-2xl sm:text-4xl font-black text-rose-500">${resignedCount}</div><div class="text-[10px] sm:text-xs font-bold text-slate-500 mt-1">ออก/ย้าย</div></div>
            </div>`;

            html += `<div class="bg-white rounded-[1.5rem] sm:rounded-[2rem] shadow-sm border border-slate-200 p-4 sm:p-8 mb-4 sm:mb-8"><h3 class="text-base sm:text-2xl font-extrabold text-slate-800 mb-4 sm:mb-6 flex items-center gap-2"><i class="far fa-calendar-check text-indigo-500"></i> สถิติการมาเรียนทั้งโรงเรียน เดือน${displayMonthYear}</h3><div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 sm:gap-3">${Object.entries(totals).map(([name, count]) => { const style = statuses[name];
                return `<div class="bg-white border border-slate-200 rounded-xl sm:rounded-2xl p-3 sm:p-4 text-center flex flex-col items-center justify-center gap-1.5"><div class="w-8 h-8 sm:w-10 sm:h-10 ${style.bg} ${style.color} rounded-full flex items-center justify-center text-sm sm:text-lg mb-1 border ${style.border}"><i class="fas ${style.icon}"></i></div><div class="${style.color} text-[9px] sm:text-xs font-extrabold">${name}</div><div class="text-xl sm:text-3xl font-black text-slate-800">${count}</div></div>`; }).join('')}</div>${totalRecorded === 0 ? `<div class="text-center text-slate-400 mt-4 text-xs sm:text-sm font-medium"><i class="fas fa-info-circle"></i> ยังไม่มีข้อมูลการเช็คชื่อในเดือนนี้</div>` : ''}</div>`;

            html += `<div class="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6">
                <div class="bg-white rounded-2xl sm:rounded-[2rem] border border-slate-200 shadow-sm p-4 sm:p-6"><h4 class="font-extrabold text-sm sm:text-lg text-slate-800 mb-3 sm:mb-4 flex items-center gap-2"><i class="fas fa-layer-group text-blue-500"></i> จำนวนนักเรียนแต่ละระดับชั้น</h4><div class="relative h-56 sm:h-72"><canvas id="schoolLevelChart"></canvas></div></div>
                <div class="bg-white rounded-2xl sm:rounded-[2rem] border border-slate-200 shadow-sm p-4 sm:p-6"><h4 class="font-extrabold text-sm sm:text-lg text-slate-800 mb-3 sm:mb-4 flex items-center gap-2"><i class="fas fa-chart-pie text-purple-500"></i> สัดส่วนสถานะการมาเรียน (เดือน${displayMonthYear})</h4><div class="relative h-56 sm:h-72"><canvas id="schoolStatusChart"></canvas></div><div id="schoolStatusChartLegend" class="mt-4"></div></div>
            </div>`;

            html += `</div>`;

            document.getElementById('mainContent').innerHTML = html;
            const levelCtxEl = document.getElementById('schoolLevelChart');
            if (levelCtxEl && typeof Chart !== 'undefined') {
                new Chart(levelCtxEl, { type: 'bar', data: { labels: [1,2,3,4,5,6].map(i => `ม.${i}`), datasets: [{ label: 'จำนวนนักเรียน', data: [1,2,3,4,5,6].map(i => levelCounts[i] || 0), backgroundColor: ['#3b82f6','#10b981','#f59e0b','#f43f5e','#a855f7','#06b6d4'], borderRadius: 8, maxBarThickness: 50 }] },
                    options: { responsive: true, maintainAspectRatio: false, layout: { padding: { top: 24 } }, plugins: { legend: { display: false },
                        datalabels: { display: (ctx) => ctx.dataset.data[ctx.dataIndex] > 0, color: chartTextColor(), anchor: 'end', align: 'top', offset: 2, font: { weight: 'bold', size: isMobileView() ? 10 : 12 }, formatter: percentLabelFormatter } },
                        scales: { x: { ticks: { color: chartTextColor(), font: { weight: 'bold', size: isMobileView() ? 10 : 12 } }, grid: { display: false } }, y: { beginAtZero: true, ticks: { color: chartTextColor(), precision: 0 }, grid: { color: chartGridColor() } } } } });
            }
            makeStatusDoughnutChart('schoolStatusChart', totals);
        }

        // ===== [ใหม่] ค้นหาวิชาในหน้าของครู - กรองด้วย JS ฝั่ง client เลย ไม่ต้องโหลดหน้าใหม่ =====
        window.filterTeacherSubjects = function(query) {
            const q = (query || '').trim().toLowerCase();
            document.querySelectorAll('.teacher-subject-item').forEach(el => {
                const match = !q || (el.dataset.search || '').includes(q);
                el.classList.toggle('hidden', !match);
            });
        };
        // ===== [ใหม่] สลับมุมมองการ์ด/ลิสต์ในหน้าของครู - จำค่าไว้ในเซสชันนี้ =====
        window.setTeacherSubjectView = function(mode) {
            window.__teacherDashViewMode = mode;
            const cardView = document.getElementById('teacherSubjectCardView'), listView = document.getElementById('teacherSubjectListView');
            const cardBtn = document.getElementById('viewModeCardBtn'), listBtn = document.getElementById('viewModeListBtn');
            if (cardView) cardView.classList.toggle('hidden', mode !== 'card');
            if (listView) listView.classList.toggle('hidden', mode !== 'list');
            if (cardBtn) { cardBtn.classList.toggle('bg-white', mode === 'card'); cardBtn.classList.toggle('shadow-sm', mode === 'card'); cardBtn.classList.toggle('text-indigo-700', mode === 'card'); cardBtn.classList.toggle('text-slate-500', mode !== 'card'); }
            if (listBtn) { listBtn.classList.toggle('bg-white', mode === 'list'); listBtn.classList.toggle('shadow-sm', mode === 'list'); listBtn.classList.toggle('text-indigo-700', mode === 'list'); listBtn.classList.toggle('text-slate-500', mode !== 'list'); }
            // คงคำค้นหาเดิมไว้ตอนสลับมุมมอง ไม่ต้องพิมพ์ใหม่
            const searchInput = document.getElementById('teacherSubjectSearch');
            if (searchInput && searchInput.value) window.filterTeacherSubjects(searchInput.value);
        };
        function openTeacherDashboard(teacherName) {
            const isDarkNow = document.documentElement.classList.contains('dark');
            const tSubjects = activeSubjects().filter(s => s.teacher === teacherName || s.teacher2 === teacherName);
            const periods = [-2, 0, 1, 2, 3, 4, 'lunch', 5, 6, 7, 8];
            let scheduleHtml = `<div class="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 sm:p-6 mb-6 overflow-hidden"><h3 class="font-extrabold text-base sm:text-lg text-slate-800 mb-4 flex items-center gap-2"><i class="fas fa-calendar-alt text-indigo-500"></i> ตารางสอนรายสัปดาห์</h3><div class="overflow-x-auto border border-slate-200 rounded-xl shadow-sm w-full"><table class="w-full text-center border-collapse min-w-[700px] sm:min-w-[950px] text-[10px] sm:text-sm"><thead class="bg-slate-100 text-slate-700"><tr><th class="p-2 sm:p-3 border-b border-slate-300 w-16 sm:w-24 bg-slate-100 sticky left-0 z-10">วัน / คาบ</th>`;
            periods.forEach(p => { if (p === 'lunch') { scheduleHtml += `<th class="p-2 sm:p-3 border-b border-l border-amber-200 w-14 sm:w-20 bg-amber-50 text-amber-700"><i class="fas fa-utensils"></i><span class="hidden sm:inline"> พักเที่ยง</span></th>`; } else { scheduleHtml += `<th class="p-2 sm:p-3 border-b border-l border-slate-200 w-16 sm:w-24">คาบ ${periodLabel(p)}</th>`; } });
            scheduleHtml += `</tr></thead><tbody class="divide-y divide-slate-200">`;
            const teacherScheduleDayColors = { 1: 'bg-yellow-500', 2: 'bg-pink-500', 3: 'bg-green-600', 4: 'bg-orange-500', 5: 'bg-sky-500' };
            for(let d = 1; d <= 5; d++) {
                let subsOnDay = [];
                tSubjects.forEach(sub => { if(sub.schedules) { effSched(sub).forEach(sch => { if(parseInt(sch.day) === d) subsOnDay.push({ ...sub, period: parseInt(sch.period) }); }); } });
                scheduleHtml += `<tr class="hover:bg-slate-50 transition-colors"><td class="p-2 sm:p-3 font-extrabold text-white ${teacherScheduleDayColors[d]} sticky left-0 z-10 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">${daysLabel[d-1].replace('วัน','')}</td>`;
                periods.forEach(p => { if (p === 'lunch') { scheduleHtml += `<td class="p-1 sm:p-2 border-l border-amber-100 bg-amber-50/70 h-full align-middle"><div class="flex flex-col items-center justify-center h-full min-h-[50px] text-amber-500"><i class="fas fa-utensils text-xs sm:text-sm"></i></div></td>`; return; } const candidatesAtP = subsOnDay.filter(s => s.period === p); const subj = candidatesAtP.find(s => s.systemType !== 'homeroom') || candidatesAtP[0]; if (subj) { const isLocked = isAttendanceEntryLocked(subj.term, subj.year); scheduleHtml += `<td class="p-1 sm:p-2 border-l border-slate-100 ${isLocked ? 'bg-slate-100/60' : 'bg-indigo-50/40 hover:bg-indigo-100'} transition-colors h-full align-middle"><div class="flex flex-col items-center justify-center h-full min-h-[50px] p-1 sm:p-1.5 rounded-lg ${isLocked ? 'cursor-not-allowed opacity-60' : 'cursor-pointer'}" ${isLocked ? 'title="ภาคเรียนนี้ถูกล็อคข้อมูลไว้ ไม่สามารถเช็คชื่อได้"' : `onclick="window.navigate('subject_summary', {subjectId: '${subj.id}', fromTeacherDash: true})"`}>${isLocked ? '<i class="fas fa-lock text-slate-400 text-[10px] sm:text-xs mb-0.5"></i>' : ''}<span class="font-black ${isLocked ? 'text-slate-500' : 'text-indigo-800'} text-[9px] sm:text-xs leading-tight line-clamp-2" title="${subj.name}">${subj.name}</span><span class="text-[8px] sm:text-[10px] font-bold text-slate-600 mt-1 bg-white border border-indigo-200 px-1.5 py-0.5 rounded shadow-sm">ม.${subj.roomId.replace('m', '').replace('_', '/')}</span></div></td>`;
                } else { scheduleHtml += `<td class="p-1 sm:p-2 border-l border-slate-100 text-slate-300 font-medium">-</td>`; } });
                scheduleHtml += `</tr>`;
            }
            scheduleHtml += `</tbody></table></div></div>`;
            let html = `<div class="mb-4 sm:mb-6 flex flex-col md:flex-row md:items-center justify-between gap-3 sm:gap-6 bg-white p-4 sm:p-8 rounded-[2rem] sm:rounded-[2.5rem] shadow-sm border border-slate-200 relative overflow-hidden"><div class="absolute right-0 top-0 w-1/3 h-full ${isDarkNow ? '' : 'bg-gradient-to-l from-indigo-50 to-transparent opacity-60'}"></div><div class="relative z-10 flex gap-3 sm:gap-5 items-center"><div class="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-indigo-500 to-blue-600 rounded-full flex items-center justify-center text-white text-xl sm:text-3xl shadow-lg shadow-indigo-200 shrink-0"><i class="fas fa-chalkboard-teacher"></i></div><div><h2 class="text-xl sm:text-3xl font-extrabold text-slate-800 tracking-tight">ครู : ${teacherName}</h2><p class="text-slate-600 font-bold mt-1 flex flex-wrap items-center gap-2"><span class="bg-indigo-100 text-indigo-800 px-2 py-1 rounded text-[10px] sm:text-sm border border-indigo-200"><i class="fas fa-book-open"></i> สอนทั้งหมด ${tSubjects.length} วิชา</span></p></div></div><div class="relative z-10 w-full md:w-auto"><button onclick="window.navigate('dashboard')" class="w-full md:w-auto bg-white border-2 border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2.5 sm:py-3.5 rounded-xl shadow-sm transition-all flex items-center justify-center gap-2 font-bold text-sm sm:text-base"><i class="fas fa-arrow-left"></i> กลับ</button></div></div>${scheduleHtml}`;
            // ===== [ใหม่] ช่องค้นหาวิชา + ปุ่มสลับมุมมองการ์ด/ลิสต์ - อยู่ระหว่างตารางสอนกับรายการวิชา =====
            const tdViewMode = window.__teacherDashViewMode === 'list' ? 'list' : 'card';
            html += `<div class="mb-4 sm:mb-6 flex flex-col sm:flex-row gap-3 items-stretch sm:items-center justify-between"><div class="relative flex-1 max-w-md"><i class="fas fa-search absolute left-3.5 top-1/2 -translate-y-1/2 text-slate-400 text-sm"></i><input type="text" id="teacherSubjectSearch" oninput="window.filterTeacherSubjects(this.value)" placeholder="ค้นหาชื่อวิชา / รหัสวิชา..." class="w-full pl-9 pr-3 py-2.5 sm:py-3 bg-white border border-slate-200 rounded-xl text-sm font-medium outline-none focus:ring-2 focus:ring-indigo-400 shadow-sm"></div><div class="flex gap-1.5 bg-slate-100 p-1 rounded-xl shrink-0"><button onclick="window.setTeacherSubjectView('card')" id="viewModeCardBtn" class="px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition-all flex items-center gap-1.5 ${tdViewMode === 'card' ? 'bg-white shadow-sm text-indigo-700' : 'text-slate-500'}"><i class="fas fa-th-large"></i> <span class="hidden sm:inline">การ์ด</span></button><button onclick="window.setTeacherSubjectView('list')" id="viewModeListBtn" class="px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition-all flex items-center gap-1.5 ${tdViewMode === 'list' ? 'bg-white shadow-sm text-indigo-700' : 'text-slate-500'}"><i class="fas fa-list"></i> <span class="hidden sm:inline">ลิสต์</span></button></div></div>`;
            html += `<div id="teacherSubjectCardView" class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4 sm:gap-6 ${tdViewMode !== 'card' ? 'hidden' : ''}">`;
            if (tSubjects.length === 0) { html += `<div class="col-span-full text-center text-slate-400 p-8 sm:p-12 bg-white rounded-3xl border border-slate-200 border-dashed shadow-sm text-sm sm:text-lg font-medium">ไม่มีรายวิชาที่สอนในระบบ</div>`;
            } else {
                tSubjects.sort((a,b) => a.roomId.localeCompare(b.roomId) || a.name.localeCompare(b.name)).forEach(sub => {
                    let schedCards = (sub.schedules || []).map(sch => `<div class="flex items-center justify-between border-b border-slate-100 last:border-0 py-1.5 sm:py-2"><span class="text-slate-600 text-[10px] sm:text-sm"><i class="far fa-calendar-alt text-indigo-400 w-4"></i> ${daysLabel[sch.day - 1] || 'ไม่ระบุ'}</span><span class="text-indigo-700 font-bold bg-indigo-50 px-2 py-0.5 rounded border border-indigo-100 text-[10px] sm:text-xs">คาบ ${periodLabel(sch.period)}</span></div>`).join('');
                    const isSubLocked = isAttendanceEntryLocked(sub.term, sub.year);
                    html += `<div class="teacher-subject-item bg-white border border-slate-200 rounded-2xl sm:rounded-3xl p-4 sm:p-5 hover:shadow-xl transition-all relative group flex flex-col h-full overflow-hidden stat-card-hover" data-search="${(sub.name + ' ' + (sub.code || '')).toLowerCase()}"><div class="absolute top-0 left-0 w-full h-1 bg-indigo-500"></div><div class="flex justify-between items-start mb-2 sm:mb-3 mt-1"><span class="bg-indigo-50 text-indigo-700 border border-indigo-100 text-[10px] sm:text-xs font-black px-2 py-1 rounded w-fit">ห้อง ${formatRoomName(sub.roomId)}</span><span class="bg-slate-100 text-slate-500 border border-slate-200 text-[9px] sm:text-xs font-bold px-2 py-1 rounded w-fit">${sub.credits || 0.5} นก.</span></div><h4 class="font-extrabold text-base sm:text-xl mb-1 text-slate-800 leading-tight line-clamp-2">${sub.name}</h4><p class="text-[10px] sm:text-sm text-slate-500 mb-3 font-mono bg-slate-50 px-2 py-1 rounded w-fit border border-slate-100">${sub.code || 'ไม่มีรหัสวิชา'}</p><div class="bg-slate-50 rounded-xl px-2.5 py-1 mb-4 border border-slate-100 font-medium text-slate-600 flex flex-col">${schedCards}</div><div class="mt-auto flex flex-col gap-2">${isSubLocked ? `<button disabled title="ไม่สามารถเช็คชื่อได้ในขณะนี้" class="w-full bg-slate-200 text-slate-400 py-2.5 sm:py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 cursor-not-allowed"><i class="fas fa-lock"></i> ล็อคแล้ว</button>` : `<button onclick="window.navigate('attendance', {subjectId: '${sub.id}', fromTeacherDash: true})" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-2.5 sm:py-3 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 shadow-md"><i class="fas fa-clipboard-check"></i> เช็คชื่อ</button>`}<button onclick="window.navigate('subject_summary', {subjectId: '${sub.id}', fromTeacherDash: true})" class="w-full bg-emerald-50 hover:bg-emerald-600 text-emerald-600 hover:text-white border border-emerald-200 hover:border-emerald-600 py-2.5 sm:py-3 rounded-xl text-sm font-bold transition-all flex items-center justify-center gap-2 shadow-sm"><i class="fas fa-chart-pie"></i> สรุปผล</button></div></div>`;
                });
            }
            html += `</div>`;
            // ===== [ใหม่] มุมมองแบบลิสต์รายการ - ข้อมูลเดียวกัน แค่จัดวางกระชับกว่า =====
            html += `<div id="teacherSubjectListView" class="flex flex-col gap-2 ${tdViewMode !== 'list' ? 'hidden' : ''}">`;
            if (tSubjects.length === 0) { html += `<div class="text-center text-slate-400 p-8 sm:p-12 bg-white rounded-3xl border border-slate-200 border-dashed shadow-sm text-sm sm:text-lg font-medium">ไม่มีรายวิชาที่สอนในระบบ</div>`;
            } else {
                tSubjects.forEach(sub => {
                    const schedInline = (sub.schedules || []).map(sch => `<span class="text-slate-500 bg-slate-50 border border-slate-200 px-1.5 py-0.5 rounded text-[9px] sm:text-[11px] whitespace-nowrap">${(daysLabel[sch.day - 1] || '-').replace('วัน','')} คาบ ${periodLabel(sch.period)}</span>`).join(' ');
                    const isSubLocked = isAttendanceEntryLocked(sub.term, sub.year);
                    html += `<div class="teacher-subject-item bg-white border border-slate-200 rounded-xl p-3 sm:p-4 flex flex-col sm:flex-row sm:items-center gap-3" data-search="${(sub.name + ' ' + (sub.code || '')).toLowerCase()}"><div class="flex-1 min-w-0"><div class="flex flex-wrap items-center gap-1.5 mb-1"><span class="bg-indigo-50 text-indigo-700 border border-indigo-100 text-[9px] sm:text-[11px] font-black px-1.5 py-0.5 rounded">ห้อง ${formatRoomName(sub.roomId)}</span>${schedInline}</div><div class="font-extrabold text-sm sm:text-base text-slate-800 truncate">${sub.name}</div><div class="text-[10px] sm:text-xs text-slate-400 font-mono">${sub.code || 'ไม่มีรหัสวิชา'}</div></div><div class="flex gap-2 shrink-0">${isSubLocked ? `<button disabled title="ไม่สามารถเช็คชื่อได้ในขณะนี้" class="bg-slate-100 text-slate-400 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-bold cursor-not-allowed whitespace-nowrap"><i class="fas fa-lock"></i></button>` : `<button onclick="window.navigate('attendance', {subjectId: '${sub.id}', fromTeacherDash: true})" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition-all shadow-sm whitespace-nowrap"><i class="fas fa-clipboard-check"></i> เช็คชื่อ</button>`}<button onclick="window.navigate('subject_summary', {subjectId: '${sub.id}', fromTeacherDash: true})" class="bg-emerald-50 hover:bg-emerald-600 text-emerald-600 hover:text-white border border-emerald-200 hover:border-emerald-600 px-3 sm:px-4 py-2 rounded-lg text-xs sm:text-sm font-bold transition-all whitespace-nowrap"><i class="fas fa-chart-pie"></i> สรุปผล</button></div></div>`;
                });
            }
            html += `</div>`;
            document.getElementById('mainContent').innerHTML = html;
        }

        // [v2.00.3] ป้าย "ไปราชการ / ลา" ในตารางห้องเรียน (ข้อมูลจาก AcademicHub · โหลดครั้งเดียวต่อสัปดาห์ที่ดู)
        function lvCellHtml(s, ds, p) {
            const lv = wrLeavesFor(lvMonday(ds)); if (!lv) { wrLoadLeaves(lvMonday(ds)); return ''; }
            const w = lvWho(lv, s, ds, p); if (!w.length) return '';
            const multi = lvTeachersOf(s).length > 1 || s.systemType;
            return `<span class="flex flex-wrap gap-1 mt-0.5">${w.map(x => (multi ? `<span class="text-[8px] sm:text-xs font-bold text-slate-500 truncate">${x.name}</span>` : '') + lvBadge(x)).join('')}</span>`;
        }
        // [v2.00.3] หน้าเช็คชื่อ: แถบแจ้งเมื่อครูของคาบนี้แจ้งไปราชการ / ลา
        function lvAttBanner(subject, ds) {
            const draw = () => {
                const old = document.getElementById('lvAttBanner'); if (old) old.remove();
                const lv = wrLeavesFor(lvMonday(ds)); if (!lv) return;
                const pEl = document.getElementById('attPeriod'), p = pEl ? pEl.value : '';
                const w = lvWho(lv, subject, ds, p); if (!w.length) return;
                const all = lvTeachersOf(subject), rest = all.filter(n => !w.some(x => x.name === n));
                const main = document.getElementById('mainContent'); if (!main) return;
                const box = rest.length
                    ? `<div class="flex gap-2.5 items-start bg-slate-50 border border-slate-300 text-slate-700 rounded-2xl px-3 sm:px-4 py-2.5 sm:py-3 mb-3 sm:mb-4 text-xs sm:text-sm font-semibold"><i class="fas fa-users mt-0.5"></i><div>คาบที่มีครูร่วม: ${w.map(x => `<b>${x.name}</b> ${x.label}${lvPeriodsTxt(x.periods)}`).join(' · ')} · <b>${rest.join(', ')}</b> เช็คชื่อได้ตามปกติ</div></div>`
                    : `<div class="flex gap-2.5 items-start bg-amber-50 border border-amber-300 text-amber-900 rounded-2xl px-3 sm:px-4 py-2.5 sm:py-3 mb-3 sm:mb-4 text-xs sm:text-sm font-bold"><i class="fas fa-user-clock mt-0.5"></i><div>วันนี้ ${w.map(x => `<b>${x.name}</b> แจ้ง${x.label}${lvPeriodsTxt(x.periods)}`).join(' · ')} (แจ้งจาก AcademicHub)<span class="block font-medium mt-0.5">ครูที่สอนแทนเช็คชื่อได้ตามปกติ — เลือก "มีการสอนแทน" แล้วเลือกชื่อครูที่สอนแทน</span></div></div>`;
                main.insertAdjacentHTML('afterbegin', box.replace('<div class="flex', '<div id="lvAttBanner" class="flex'));
            };
            window.__lvAttRefresh = draw;
            const pEl = document.getElementById('attPeriod'); if (pEl && !pEl.__lv) { pEl.__lv = true; pEl.addEventListener('change', draw); }
            if (wrLeavesFor(lvMonday(ds))) draw(); else wrLoadLeaves(lvMonday(ds));
        }
        // ===== [v2.02.2] รายงานการเข้าแถวเช้า (คาบ B) รายวัน — ปุ่มบนหน้าห้อง แสดงเมื่อเช็คแถวของวันที่เลือกแล้วเท่านั้น =====
        //   กดแล้วสร้างรูปในเครื่อง (ไม่ส่งคำขอไปเซิร์ฟเวอร์) · มือถือ = เปิดหน้าต่างแชร์ (เลือก LINE ได้) · คอม = ดาวน์โหลดรูป
        const ASM_C = { 'มา': '#10b981', 'ร่วมกิจกรรม': '#06b6d4', 'สาย': '#f59e0b', 'ลาป่วย': '#3b82f6', 'ลากิจ': '#6366f1', 'ขาด': '#f43f5e', 'โดดเรียน': '#9333ea' };
        const ASM_S = { 'มา': 'มา', 'ร่วมกิจกรรม': 'กิจกรรม', 'สาย': 'สาย', 'ลาป่วย': 'ลาป่วย', 'ลากิจ': 'ลากิจ', 'ขาด': 'ขาด', 'โดดเรียน': 'โดด' };
        const ASM_TH_M = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
        function asmFind(roomId, date) {
            const ms = getRoomSubjects(roomId).find(s => s.systemType === 'morning'); if (!ms) return null;
            const rec = attendanceData.filter(a => a.subjectId === ms.id && a.date === date).sort((a, b) => Number(a.period) - Number(b.period))[0];
            return rec ? { ms, rec } : null;
        }
        function asmCounts(rec) {
            const c = { ok: 0, late: 0, leave: 0, abs: 0 };
            Object.values(rec.records || {}).forEach(v => { if (v === 'มา' || v === 'ร่วมกิจกรรม') c.ok++; else if (v === 'สาย') c.late++; else if (v === 'ลาป่วย' || v === 'ลากิจ') c.leave++; else if (v) c.abs++; });
            return c;
        }
        function ensureAsmStyle() {
            if (document.getElementById('asmStyle')) return;
            const s = document.createElement('style'); s.id = 'asmStyle';
            s.textContent = `.asm-btn{display:block;width:100%;padding:0;border:2px solid #06c755;border-radius:16px;overflow:hidden;background:#f0fdf4;text-align:left;cursor:pointer;box-shadow:0 4px 12px rgba(6,199,85,.22);transition:transform .12s}
.asm-btn:active{transform:scale(.985)}
.asm-t{background:#06c755;color:#fff;padding:9px 12px;display:flex;align-items:center;gap:8px;font-weight:800;font-size:14px;line-height:1.3}
.asm-t .asm-d{margin-left:auto;font-size:11px;font-weight:700;background:rgba(255,255,255,.22);border-radius:999px;padding:1px 8px;white-space:nowrap}
.asm-s{display:flex;font-size:11px;font-weight:700;color:#166534}
.asm-s div{flex:1;text-align:center;padding:4px 0;border-right:1px solid #bbf7d0;line-height:1.25}.asm-s div:last-child{border-right:0}
.asm-s b{display:block;font-size:16px}
.dark .asm-btn{background:rgba(6,199,85,.10)}.dark .asm-s{color:#86efac}.dark .asm-s div{border-color:rgba(134,239,172,.25)}
.asm-btn.asm-busy{opacity:.7;pointer-events:none}
@keyframes asmPulse{0%{box-shadow:0 0 0 0 rgba(6,199,85,.55)}70%{box-shadow:0 0 0 14px rgba(6,199,85,0)}100%{box-shadow:0 0 0 0 rgba(6,199,85,0)}}
.asm-pulse{animation:asmPulse 1s ease-out 3}
@media (min-width:640px){.asm-btn{min-width:330px}.asm-t{font-size:15px}.asm-row>button{flex:1 1 0!important}}`;
            document.head.appendChild(s);
        }
        function asmButtonHtml(roomId, date) {
            const f = asmFind(roomId, date); if (!f) return '';
            ensureAsmStyle();
            const c = asmCounts(f.rec), d = new Date(date + 'T00:00:00');
            const dl = d.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' });
            return `<button type="button" id="asmBtn" class="asm-btn" onclick="window.asmReport('${roomId}', '${date}')"><div class="asm-t"><i class="fas fa-paper-plane"></i><span>ส่งรายงานเข้าแถวให้ผู้ปกครอง</span><span class="asm-d">${dl}</span><i class="fas fa-chevron-right"></i></div><div class="asm-s"><div><b>${c.ok}</b>มา</div><div><b>${c.late}</b>สาย</div><div><b>${c.leave}</b>ลา</div><div><b>${c.abs}</b>ขาด</div></div></button>`;
        }
        // หลังบันทึกเช็คแถว: เลื่อนจอมาที่ปุ่ม + กะพริบ 3 ครั้ง
        function asmFocus(tries) {
            const b = document.getElementById('asmBtn');
            if (!b) { if ((tries || 0) < 12) setTimeout(() => asmFocus((tries || 0) + 1), 250); return; }
            b.scrollIntoView({ behavior: 'smooth', block: 'center' }); b.classList.remove('asm-pulse'); void b.offsetWidth; b.classList.add('asm-pulse');
        }
        function asmEsc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
        function asmBuildHtml(roomId, date, f) {
            const d = new Date(date + 'T00:00:00'), dow = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'][d.getDay()];
            const dTxt = `วัน${dow}ที่ ${d.getDate()} ${ASM_TH_M[d.getMonth()]} ${d.getFullYear() + 543}`;
            const st = getRoomStudents(roomId).filter(s => s.status !== 'resigned').sort((a, b) => parseInt(a.number) - parseInt(b.number));
            const rows = st.map(s => ({ s, v: (f.rec.records || {})[s.id] || '' }));
            const cnt = {}; rows.forEach(r => { if (r.v) cnt[r.v] = (cnt[r.v] || 0) + 1; });
            const order = ['มา', 'ร่วมกิจกรรม', 'สาย', 'ลาป่วย', 'ลากิจ', 'ขาด', 'โดดเรียน'];
            const sum = order.filter(k => cnt[k]).map(k => `<span style="background:${ASM_C[k]};color:#fff;border-radius:9px;padding:3px 10px;font-size:13.5px;font-weight:700;line-height:1.6">${k} ${cnt[k]}</span>`).join('');
            const half = Math.ceil(rows.length / 2), cols = [rows.slice(0, half), rows.slice(half)];
            const cell = (r) => `<div style="display:flex;align-items:center;gap:6px;padding:3px 0;border-bottom:1px solid #f1f5f9;font-size:13.5px;line-height:1.55;min-width:0"><span style="color:#94a3b8;width:20px;text-align:right;font-size:12px;flex:none">${asmEsc(r.s.number)}</span><span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${asmEsc(r.s.name)}</span><span style="flex:none;background:${ASM_C[r.v] || '#94a3b8'};color:#fff;border-radius:7px;padding:0 7px;font-size:12px;font-weight:700;min-width:46px;text-align:center">${ASM_S[r.v] || '-'}</span></div>`;
            const adv = getRoomAdvisors(roomId).filter(a => a && String(a).trim());
            const t = f.rec.checkedAt ? new Date(f.rec.checkedAt) : null;
            const tTxt = t && !isNaN(t) && localDateStr(t) === date ? `เช็คเวลา ${String(t.getHours()).padStart(2, '0')}.${String(t.getMinutes()).padStart(2, '0')} น.` : '';
            const logo = settings.logoDataUrl || 'icons/icon-192.png';
            return `<div style="width:560px;background:#fff;color:#1e293b;font-family:'Sarabun','Noto Sans Thai',sans-serif">
<div style="background:linear-gradient(135deg,#4338ca,#6d28d9);color:#fff;padding:18px 22px;display:flex;gap:14px;align-items:center"><img src="${logo}" style="width:58px;height:58px;border-radius:50%;background:#fff;padding:3px;object-fit:contain;flex:none"><div style="min-width:0;line-height:1.45"><div style="font-size:13.5px;opacity:.92">${asmEsc(settings.title || 'ระบบเช็คชื่อ')}</div><div style="font-size:22px;font-weight:800">รายงานการเข้าแถวเช้า ห้อง ${asmEsc(formatRoomName(roomId))}</div><div style="font-size:14px;opacity:.92">${dTxt} · นักเรียน ${rows.length} คน</div></div></div>
<div style="padding:14px 20px 16px"><div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px">${sum}</div><div style="display:grid;grid-template-columns:1fr 1fr;column-gap:16px">${cols.map(c => `<div style="min-width:0">${c.map(cell).join('')}</div>`).join('')}</div></div>
<div style="background:#f8fafc;border-top:1px solid #e2e8f0;padding:9px 20px;font-size:12px;color:#64748b;display:flex;justify-content:space-between;gap:10px;line-height:1.5"><span>ครูที่ปรึกษา ${asmEsc(adv.join(' · ') || '-')}</span><span style="white-space:nowrap">${tTxt}</span></div></div>`;
        }
        async function asmMakeFile(roomId, date) {
            const f = asmFind(roomId, date); if (!f) return null;
            const wrap = document.createElement('div'); wrap.style.cssText = 'position:fixed;left:-30000px;top:0;z-index:-1';
            wrap.innerHTML = asmBuildHtml(roomId, date, f); document.body.appendChild(wrap);
            const wasDark = document.documentElement.classList.contains('dark'); if (wasDark) document.documentElement.classList.remove('dark');
            try {
                await document.fonts.ready; await Promise.all(Array.from(wrap.querySelectorAll('img')).map(im => im.complete ? 0 : new Promise(r => { im.onload = im.onerror = r; })));
                const cv = await html2canvas(wrap.firstElementChild, { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
                const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
                if (!blob) return null;
                const name = `รายงานเข้าแถว_${formatRoomName(roomId).replace(/\//g, '-')}_${date}.png`;
                return { blob, name, file: (typeof File === 'function') ? new File([blob], name, { type: 'image/png' }) : null };
            } finally { wrap.remove(); if (wasDark) document.documentElement.classList.add('dark'); }
        }
        function asmDownload(out) { const u = URL.createObjectURL(out.blob), a = document.createElement('a'); a.href = u; a.download = out.name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), 4000); }
        function asmCanShare(out) { try { return !!(out.file && navigator.share && navigator.canShare && navigator.canShare({ files: [out.file] }) && window.matchMedia('(pointer: coarse)').matches); } catch (e) { return false; } }
        // แชร์ไม่ผ่านเพราะเบราว์เซอร์ต้องการให้แตะอีกครั้ง (สร้างรูปนานเกินไป) → แสดงรูปพร้อมปุ่มแชร์/บันทึก
        function asmPreview(out) {
            const old = document.getElementById('asmPrev'); if (old) old.remove();
            const u = URL.createObjectURL(out.blob), ov = document.createElement('div'); ov.id = 'asmPrev';
            ov.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(15,23,42,.6);display:flex;align-items:center;justify-content:center;padding:16px';
            ov.innerHTML = `<div style="background:#fff;border-radius:20px;max-width:440px;width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden"><div style="display:flex;align-items:center;justify-content:space-between;padding:12px 14px;font-weight:800;color:#1e293b"><span><i class="fas fa-paper-plane" style="color:#06c755"></i> รายงานการเข้าแถว</span><button type="button" id="asmPrevX" style="width:34px;height:34px;border-radius:10px;background:#ef4444;color:#fff;border:0"><i class="fas fa-xmark"></i></button></div><div style="overflow:auto;padding:0 14px"><img src="${u}" style="width:100%;border-radius:10px;border:1px solid #e2e8f0;display:block"></div><div style="display:flex;gap:8px;padding:12px 14px"><button type="button" id="asmPrevShare" style="flex:1;height:44px;border-radius:12px;border:0;background:#06c755;color:#fff;font-weight:800"><i class="fas fa-share-nodes"></i> แชร์ / ส่ง LINE</button><button type="button" id="asmPrevSave" style="flex:1;height:44px;border-radius:12px;border:2px solid #e2e8f0;background:#fff;color:#334155;font-weight:800"><i class="fas fa-download"></i> บันทึกรูป</button></div></div>`;
            document.body.appendChild(ov);
            const close = () => { ov.remove(); URL.revokeObjectURL(u); };
            ov.querySelector('#asmPrevX').onclick = close; ov.addEventListener('click', e => { if (e.target === ov) close(); });
            ov.querySelector('#asmPrevSave').onclick = () => asmDownload(out);
            const sh = ov.querySelector('#asmPrevShare'); if (!asmCanShare(out)) sh.style.display = 'none';
            sh.onclick = async () => { try { await navigator.share({ files: [out.file] }); close(); } catch (e) { if (!e || e.name !== 'AbortError') showToast('แชร์ไม่สำเร็จ กรุณากดบันทึกรูปแล้วส่งเอง', 'error'); } };
        }
        window.asmReport = async function (roomId, date) {
            const b = document.getElementById('asmBtn'); if (b) b.classList.add('asm-busy');
            try {
                if (typeof html2canvas !== 'function') { showToast('โหลดตัวสร้างรูปไม่สำเร็จ กรุณารีเฟรชหน้า', 'error'); return; }
                const out = await asmMakeFile(roomId, date);
                if (!out) { showToast('ยังไม่มีข้อมูลการเข้าแถวของวันนี้', 'error'); return; }
                if (asmCanShare(out)) {
                    try { await navigator.share({ files: [out.file] }); }
                    catch (e) { if (!e || e.name !== 'AbortError') asmPreview(out); }
                } else { asmDownload(out); showToast('บันทึกรูปรายงานการเข้าแถวแล้ว', 'success'); }
            } catch (e) { showToast('สร้างรูปรายงานไม่สำเร็จ', 'error'); }
            finally { const b2 = document.getElementById('asmBtn'); if (b2) b2.classList.remove('asm-busy'); }
        };
        function openClassroom(roomId, dayIndex = null) {
            const isDarkNow = document.documentElement.classList.contains('dark');
            currentRoomId = roomId;
            // [v2.02.1] เสาร์-อาทิตย์ (ที่ไม่ใช่วันสอนชดเชย): ไม่เปิดแท็บวันจันทร์ที่ผ่านมาให้เอง (เดิมทำให้ครูเช็คชื่อผิดวัน)
            //   ไม่เลือกวัน = แถบแจ้ง "วันนี้ไม่มีคาบเรียน" · แตะวัน = ตารางสัปดาห์หน้า (ดูอย่างเดียว) · dayIndex 11-15 = สัปดาห์นี้ (ย้อนหลัง ตามสิทธิ์เดิม)
            const wkNowDow = new Date().getDay() || 7, wkTodayHol = getHolidayForDate(localDateStr());
            const wkEnd = wkNowDow >= 6 && !(wkTodayHol && wkTodayHol.type === 'makeup');
            let wkThis = false; if (wkEnd && dayIndex !== null && dayIndex > 10) { wkThis = true; dayIndex -= 10; }
            const wkNoPick = wkEnd && dayIndex === null, wkNext = wkEnd && !wkThis && !wkNoPick;
            if (dayIndex === null) {
                let today = new Date().getDay() || 7; // จันทร์=1 ... อาทิตย์=7
                if (today >= 1 && today <= 5) dayIndex = today;
                else { const h = getHolidayForDate(localDateStr()); dayIndex = (h && h.type === 'makeup') ? today : 1; } // เสาร์-อาทิตย์: ถ้าวันนี้มีสอนชดเชยพอดี ให้เปิดแท็บนั้นเลย ไม่งั้น default ไปจันทร์
            }
            // ===== [ใหม่] แอบโหลดข้อมูลเช็คชื่อของห้องนี้ไว้ล่วงหน้าเงียบๆ (ไม่บล็อกการแสดงผลหน้านี้) เผื่อผู้ใช้กด "เช็คชื่อ"/"สรุป" ต่อ จะได้ไม่ต้องรอโหลดซ้ำ =====
            // [v1.75.4] โหลดตามภาคเรียน/ปีของวิชาที่แสดงจริง + โหลดเสร็จแล้ววาดหน้านี้ใหม่ (เดิมรีเฟรชแล้วปุ่มค้าง "ยังไม่เช็ค" เพราะวาดก่อนข้อมูลมาถึงและไม่วาดซ้ำ)
            //   ไม่เพิ่มคำขอ — โหลดห้องนี้อยู่แล้วทุกครั้งที่เปิด · วาดใหม่เฉพาะเมื่อมีห้อง/ภาคเรียนที่เพิ่งโหลดครั้งแรก และยังอยู่หน้าห้องเดิม
            const renderId = window.__classroomRenderId = (window.__classroomRenderId || 0) + 1;
            const preloadTerm = adminTerm ? adminTerm() : settings.term, preloadYear = adminYear ? adminYear() : settings.year;
            const preTY = [...new Set(getRoomSubjects(roomId).map(s => `${s.term}|${s.year}`))];
            if (!preTY.length) preTY.push(`${preloadTerm}|${preloadYear}`);
            const notYet = preTY.filter(k => !(roomAttKey_(k.split('|')[0], k.split('|')[1], roomId) in (window.__loadedRoomLastModified || {})));
            Promise.all(preTY.map(k => ensureAttendanceLoadedForRoom(k.split('|')[0], k.split('|')[1], roomId))).then(() => {
                if (notYet.length && window.__classroomRenderId === renderId && currentRoomId === roomId && ((history.state || {}).view || 'classroom') === 'classroom') openClassroom(roomId, wkNoPick ? null : (wkThis ? dayIndex + 10 : dayIndex));
            }).catch(() => {});
            
            const roomNameStr = formatRoomName(roomId);
            const advData = getRoomAdvisors(roomId);
            let advisorText = "ยังไม่ระบุ";
            if (Array.isArray(advData)) { let validAdvs = advData.filter(a => a && a.trim() !== "");
                if (validAdvs.length > 0) advisorText = validAdvs.join(' และ '); }

            const roomSubjects = getRoomSubjects(roomId);
            const roomStudents = getRoomStudents(roomId).sort((a, b) => parseInt(a.number) - parseInt(b.number));
            const activeStudents = roomStudents.filter(s => s.status !== 'resigned');
            // ===== [ใหม่] หาวันจันทร์ของสัปดาห์นี้ไว้ล่วงหน้า (ใช้คำนวณวันที่จริงของทุกแท็บ รวมถึงเสาร์-อาทิตย์ที่อาจมีสอนชดเชย) =====
            const todayForWeek = new Date(); const todayDowForWeek = todayForWeek.getDay() || 7; // จันทร์=1 ... อาทิตย์=7
            const mondayOfWeek = new Date(todayForWeek); mondayOfWeek.setDate(todayForWeek.getDate() - (todayDowForWeek - 1));
            if (wkEnd && !wkThis) mondayOfWeek.setDate(mondayOfWeek.getDate() + 7); // [v2.02.1] วันหยุดสุดสัปดาห์: แท็บเป็นสัปดาห์หน้า
            const dateForDayIndex = (idx) => { const d = new Date(mondayOfWeek); d.setDate(mondayOfWeek.getDate() + (idx - 1)); return d; };
            // ===== [ใหม่] เช็คว่าเสาร์(6)/อาทิตย์(7) ของสัปดาห์นี้ มีการตั้ง "สอนชดเชย" ไว้ไหม - ถ้ามีให้โผล่เป็นแท็บเพิ่มด้วย (ปกติมีแค่จันทร์-ศุกร์) =====
            const weekendMakeupDays = [6, 7].filter(idx => { const h = getHolidayForDate(localDateStr(dateForDayIndex(idx))); return h && h.type === 'makeup'; });
            const visibleDayIndexes = [1, 2, 3, 4, 5, ...weekendMakeupDays];
            // ===== [ใหม่] คำนวณวันที่จริงของแท็บที่กำลังดูอยู่ก่อน แล้วค่อยหา "วันที่ควรใช้หาตารางสอน" (เผื่อวันนี้ตั้งเป็นสอนชดเชย จะได้ใช้ตารางที่ยืมมาแทน) =====
            const dateToPass = localDateStr(dateForDayIndex(dayIndex));
            const effectiveDayForSchedule = getEffectiveDayOfWeek(dateToPass);
            const makeupInfo = getHolidayForDate(dateToPass);
            const isMakeupDay = makeupInfo && makeupInfo.type === 'makeup';
            const daySubjects = [];
            roomSubjects.forEach(s => { if(!s.schedules) return; const schedsOnDay = effSched(s).filter(sch => parseInt(sch.day) === effectiveDayForSchedule); schedsOnDay.forEach(sch => { daySubjects.push({ ...s, currentPeriod: parseInt(sch.period) }); }); });
            let html = `<div class="mb-4 sm:mb-8 flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4 bg-white p-4 sm:p-8 rounded-[2rem] sm:rounded-[2.5rem] shadow-sm border border-slate-200 relative overflow-hidden"><div class="absolute right-0 top-0 w-48 sm:w-64 h-full ${isDarkNow ? '' : 'bg-gradient-to-l from-indigo-50 to-transparent opacity-50'}"></div><div class="relative z-10"><h2 class="text-xl sm:text-4xl font-extrabold text-slate-800 tracking-tight flex items-center gap-2 sm:gap-4"><div class="w-10 h-10 sm:w-14 sm:h-14 bg-indigo-600 text-white rounded-xl sm:rounded-2xl flex items-center justify-center shadow-lg shadow-indigo-200"><i class="fas fa-door-open text-lg sm:text-2xl"></i></div> ห้องเรียน ${roomNameStr}</h2><div class="flex flex-wrap items-center gap-2 mt-3 text-[10px] sm:text-sm"><p class="text-slate-600 bg-slate-100 px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-slate-200 font-bold flex items-center gap-1 sm:gap-2"><i class="fas fa-user-tie text-indigo-500"></i> <span class="hidden sm:inline">ที่ปรึกษา: </span><span class="text-indigo-700">${advisorText}</span></p><p class="text-slate-600 bg-slate-100 px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg border border-slate-200 font-bold flex items-center gap-1 sm:gap-2"><i class="fas fa-users text-blue-500"></i> <span class="hidden sm:inline">นักเรียน: </span><span class="text-blue-700">${activeStudents.length} คน</span></p></div></div><div class="relative z-10 flex flex-col gap-2 w-full sm:w-auto"><div class="flex gap-2 w-full asm-row"><button onclick="window.navigate('room_summary', {roomId: '${roomId}', tab: 'daily'})" class="flex-1 sm:flex-none bg-emerald-600 hover:bg-emerald-700 text-white border border-emerald-700 px-3 py-2 sm:px-6 sm:py-3 rounded-xl shadow-sm transition-all flex items-center justify-center gap-1.5 font-bold text-xs sm:text-base"><i class="fas fa-chart-bar"></i> ภาพรวมห้อง</button><button onclick="window.navigate('dashboard')" class="flex-1 sm:flex-none bg-white border-2 border-slate-200 hover:bg-slate-50 text-slate-700 px-3 py-2 sm:px-6 sm:py-3 rounded-xl shadow-sm transition-all flex items-center justify-center gap-1.5 font-bold text-xs sm:text-base"><i class="fas fa-arrow-left"></i> กลับ</button></div>${wkNoPick ? '' : asmButtonHtml(roomId, dateToPass)}</div></div>`;
            const todayFullThaiDateStr = new Date().toLocaleDateString('th-TH', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
            let todayProminentDateStr = `วันนี้ ${todayFullThaiDateStr}`;
            const wkFmt = (d) => d.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
            if (wkNext) todayProminentDateStr = `ดูตาราง ${dateForDayIndex(dayIndex).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' })} (ดูอย่างเดียว)`;
            if (wkThis) todayProminentDateStr = `สัปดาห์นี้ ${dateForDayIndex(dayIndex).toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short' })} (ย้อนหลัง)`;
            const wkWeekTxt = `${wkFmt(dateForDayIndex(1))} – ${wkFmt(dateForDayIndex(5))}`;
            const wkChips = `<div class="flex flex-wrap gap-1.5 mt-2"><button onclick="window.navigate('classroom', {roomId: '${roomId}', dayIndex: 1})" class="bg-white border-2 border-violet-300 text-violet-700 rounded-full px-3 py-1 text-[11px] sm:text-xs font-bold"><i class="fas fa-calendar-day"></i> ดูตารางวันจันทร์หน้า (${wkFmt(wkThis ? new Date(dateForDayIndex(1).getTime() + 7 * 864e5) : dateForDayIndex(1))})</button><button onclick="window.navigate('classroom', {roomId: '${roomId}', dayIndex: 15})" class="bg-white border border-slate-300 text-slate-600 rounded-full px-3 py-1 text-[11px] sm:text-xs font-bold"><i class="fas fa-history"></i> สัปดาห์นี้ (ย้อนหลัง)</button></div>`;
            const wkBanner = !wkEnd ? '' : wkNoPick
                ? `<div class="mb-3 sm:mb-4 rounded-2xl border-2 ${isDarkNow ? 'border-violet-400/40 bg-violet-500/10' : 'border-violet-200 bg-violet-50'} p-3 sm:p-4 flex items-start gap-3"><div class="w-10 h-10 rounded-full bg-violet-500 text-white flex items-center justify-center shrink-0 text-lg"><i class="fas fa-mug-hot"></i></div><div class="min-w-0"><div class="font-extrabold ${isDarkNow ? 'text-violet-200' : 'text-violet-800'} text-sm sm:text-base">วันนี้${daysLabelAll(wkNowDow)} ไม่มีคาบเรียน</div><div class="text-[11px] sm:text-xs ${isDarkNow ? 'text-violet-300' : 'text-violet-700'} mt-0.5 leading-snug">เช็คชื่อได้ในวันเรียน · แตะวันด้านบนเพื่อดูตารางสัปดาห์หน้า ${wkWeekTxt} (ดูอย่างเดียว)</div>${wkChips}</div></div>`
                : `<div class="mb-3 sm:mb-4 rounded-xl border ${isDarkNow ? 'border-violet-400/40 bg-violet-500/10 text-violet-200' : 'border-violet-200 bg-violet-50 text-violet-700'} px-3 py-2 text-[11px] sm:text-sm font-bold flex items-center gap-2 flex-wrap"><i class="fas ${wkThis ? 'fa-history' : 'fa-eye'}"></i> <span>วันนี้${daysLabelAll(wkNowDow)} — ${wkThis ? `กำลังดูสัปดาห์นี้ ${wkWeekTxt} (ย้อนหลัง)` : `กำลังดูตารางสัปดาห์หน้า ${wkWeekTxt} · เช็คชื่อได้เมื่อถึงวันเรียน`}</span><button onclick="window.navigate('classroom', {roomId: '${roomId}', dayIndex: ${wkThis ? 1 : 15}})" class="ml-auto underline">${wkThis ? 'ดูสัปดาห์หน้า' : 'ดูสัปดาห์นี้ (ย้อนหลัง)'}</button></div>`;
            html += `<div class="bg-white rounded-2xl sm:rounded-3xl shadow-sm border border-slate-200 p-3 sm:p-8 mb-6 sm:mb-10"><div class="flex flex-col lg:flex-row lg:items-center justify-between gap-3 mb-4 sm:mb-8"><h3 class="text-lg sm:text-2xl font-extrabold text-slate-800 flex items-center gap-2 flex-wrap"><i class="far fa-calendar-alt text-blue-500 text-xl sm:text-3xl"></i> ตารางเรียน <span class="text-xs sm:text-base font-black ${isDarkNow ? 'bg-indigo-500/20 text-indigo-300 border-indigo-400/40' : 'bg-indigo-50 text-indigo-700 border-indigo-200'} border px-2.5 py-1 rounded-full">${todayProminentDateStr}</span></h3><div class="flex overflow-x-auto gap-1.5 sm:gap-2 pb-2 lg:pb-0 w-full lg:w-auto">`;
            for(let i of visibleDayIndexes) {
                const dateForThisDay = dateForDayIndex(i);
                const dayDateLabel = dateForThisDay.toLocaleDateString('th-TH', { day: 'numeric', month: 'short' });
                // สีประจำวันแบบไทย: จันทร์เหลือง อังคารชมพู พุธเขียว พฤหัสส้ม ศุกร์ฟ้า เสาร์ม่วง(สอนชดเชย) อาทิตย์แดง(สอนชดเชย)
                const dayColorMap = {
                    1: { active: 'bg-yellow-500 border-yellow-500', text: 'text-yellow-700', hoverBorder: 'hover:border-yellow-300' },
                    2: { active: 'bg-pink-500 border-pink-500', text: 'text-pink-700', hoverBorder: 'hover:border-pink-300' },
                    3: { active: 'bg-green-600 border-green-600', text: 'text-green-700', hoverBorder: 'hover:border-green-300' },
                    4: { active: 'bg-orange-500 border-orange-500', text: 'text-orange-700', hoverBorder: 'hover:border-orange-300' },
                    5: { active: 'bg-sky-500 border-sky-500', text: 'text-sky-700', hoverBorder: 'hover:border-sky-300' },
                    6: { active: 'bg-violet-500 border-violet-500', text: 'text-violet-700', hoverBorder: 'hover:border-violet-300' },
                    7: { active: 'bg-violet-600 border-violet-600', text: 'text-violet-700', hoverBorder: 'hover:border-violet-300' },
                };
                const dayNameFor = (idx) => idx <= 5 ? daysLabel[idx-1].replace('วัน','') : (idx === 6 ? 'เสาร์*' : 'อาทิตย์*');
                const dc = dayColorMap[i];
                const activeClass = (i === dayIndex && !wkNoPick) ? `${dc.active} text-white shadow-md` : `bg-white border-slate-200 text-slate-700 hover:bg-slate-50 ${dc.hoverBorder}`;
                html += `<button onclick="window.navigate('classroom', {roomId: '${roomId}', dayIndex: ${wkThis ? 10 + i : i}})" class="px-2 sm:px-3 lg:px-5 py-1.5 sm:py-2 rounded-lg border font-bold whitespace-nowrap transition-all flex flex-col items-center justify-center gap-0.5 flex-1 ${activeClass}"><span class="text-[8px] sm:text-[10px] font-medium opacity-80 leading-none">${dayDateLabel}</span><span class="text-[10px] sm:text-sm flex items-center gap-1 leading-none">${i === dayIndex && !wkNoPick ? '<i class="fas fa-check-circle"></i>' : ''} ${dayNameFor(i)}</span></button>`; }
            if (weekendMakeupDays.length > 0) html += `<p class="w-full text-[9px] sm:text-[10px] text-violet-500 font-bold mt-1">* มีสอนชดเชยวันหยุดสุดสัปดาห์</p>`;
            if (isMakeupDay) html += `<div class="mb-3 sm:mb-4 bg-violet-50 border-2 border-violet-300 rounded-xl px-3 py-2 sm:px-4 sm:py-3 flex items-center gap-2.5"><div class="w-8 h-8 sm:w-10 sm:h-10 bg-violet-500 text-white rounded-full flex items-center justify-center text-xs sm:text-base shrink-0"><i class="fas fa-exchange-alt"></i></div><span class="text-violet-700 font-bold text-[11px] sm:text-sm">วันนี้เป็นวันสอนชดเชย: ${makeupInfo.label} — ใช้ตารางสอนของวัน${daysLabel[effectiveDayForSchedule-1].replace('วัน','')}แทน</span></div>`;
            const wkMark = html.length; // [v2.02.1]
            html += `</div></div>${wkBanner}<div class="rounded-xl border border-slate-200 shadow-sm w-full overflow-hidden"><table class="w-full text-left border-collapse table-fixed"><colgroup><col style="width:14%"><col style="width:32%"><col style="width:23%"><col style="width:31%"></colgroup><thead><tr class="bg-slate-50 text-slate-700 text-[9px] sm:text-sm border-b-2 border-slate-200 uppercase tracking-wider"><th class="p-1.5 sm:p-3 lg:p-5 font-extrabold text-center">คาบ</th><th class="p-1.5 sm:p-3 lg:p-5 font-extrabold">วิชา / กิจกรรม</th><th class="p-1.5 sm:p-3 lg:p-5 font-extrabold">ครูผู้สอน</th><th class="p-1.5 sm:p-3 lg:p-5 font-extrabold text-center">จัดการ</th></tr></thead><tbody class="divide-y divide-slate-100">`;
            timeSlots.forEach(slot => {
                if (slot.period === -1) { html += `<tr class="bg-amber-50/70 border-y border-amber-100"><td class="p-1.5 sm:p-3 lg:p-5 text-center font-bold text-amber-600 bg-amber-100/50 text-[9px] sm:text-base"><i class="fas fa-utensils"></i></td><td class="p-1.5 sm:p-3 lg:p-5 font-black text-amber-700 text-center tracking-widest text-[11px] sm:text-lg" colspan="3">${slot.name}</td></tr>`; } else {
                    const subjectInSlot = daySubjects.find(s => s.currentPeriod === slot.period);
                    const periodCellHtml = (dim) => `<td class="p-1.5 sm:p-3 lg:p-5 text-center bg-slate-50/50"><div class="font-black ${dim ? 'text-slate-400' : 'text-slate-700'} text-sm sm:text-lg leading-none">${periodLabel(slot.period)}</div><div class="font-bold ${dim ? 'text-slate-300' : 'text-slate-400'} font-mono text-[8px] sm:text-xs mt-0.5">${slot.time.split('-')[0]}</div></td>`;
                    if (subjectInSlot && isClubSubject(subjectInSlot)) { html += clubRowHtml(slot, subjectInSlot); } else if (subjectInSlot) { const isSlotLocked = wkNext || isAttendanceEntryLocked(subjectInSlot.term, subjectInSlot.year); const replacedSys = !subjectInSlot.systemType ? roomSubjects.find(rs => rs.systemType && (rs.schedules || []).some(sc => parseInt(sc.day) === effectiveDayForSchedule && parseInt(sc.period) === slot.period)) : null; const isSlotChecked = attendanceData.some(a => a.subjectId === subjectInSlot.id && a.date === dateToPass && String(a.period) === String(slot.period)); html += `<tr data-att-key="${subjectInSlot.id}|${slot.period}|${dateToPass}" class="${isSlotChecked ? 'bg-emerald-50 hover:bg-emerald-100/60' : 'hover:bg-indigo-50/40'} transition-colors group">${isSlotChecked ? `<td class="p-1.5 sm:p-3 lg:p-5 text-center"><div class="w-6 h-6 sm:w-8 sm:h-8 mx-auto rounded-full bg-emerald-500 text-white flex items-center justify-center text-[10px] sm:text-sm"><i class="fas fa-check"></i></div><div class="font-extrabold text-emerald-700 text-[8px] sm:text-xs mt-0.5">คาบ ${periodLabel(slot.period)}</div></td>` : periodCellHtml(false)}<td class="p-1.5 sm:p-3 lg:p-5 min-w-0"><div class="font-extrabold ${isSlotChecked ? 'text-emerald-800' : 'text-blue-700'} text-[11px] sm:text-lg leading-tight break-words">${subjectInSlot.name}</div>${replacedSys ? `<div class="text-[8px] sm:text-xs font-bold text-amber-700 mt-0.5">สอนแทน${replacedSys.name}</div>` : ''}${subjectInSlot.code ? `<div class="text-[8px] sm:text-xs font-bold text-slate-400 mt-1 uppercase bg-slate-100 inline-block px-1 sm:px-1.5 py-0.5 rounded border border-slate-200 truncate max-w-full">${subjectInSlot.code}</div>` : ''}</td><td class="p-1.5 sm:p-3 lg:p-5 font-bold text-slate-600 text-[9px] sm:text-base min-w-0"><span class="flex flex-col min-w-0">${subjectInSlot.teacher ? `<span class="truncate block" title="${subjectInSlot.teacher}">${subjectInSlot.teacher}</span>` : (subjectInSlot.systemType ? '' : '<span>-</span>')}${subjectInSlot.teacher2 ? `<span class="truncate block" title="${subjectInSlot.teacher2}">${subjectInSlot.teacher2}</span>` : ''}${lvCellHtml(subjectInSlot, dateToPass, slot.period)}</span></td><td class="p-1 sm:p-3 lg:p-5">${isSlotLocked ? `<button disabled title="ไม่สามารถเช็คชื่อได้ในขณะนี้" class="w-full bg-slate-100 text-slate-400 py-1 sm:py-1.5 rounded-full text-[9px] sm:text-sm font-bold cursor-not-allowed whitespace-nowrap"><i class="fas fa-lock"></i> <span>${wkNext ? 'ยังไม่ถึงวัน' : 'ล็อคแล้ว'}</span></button>` : (isSlotChecked ? `<button onclick="window.navigate('attendance', {subjectId: '${subjectInSlot.id}', period: ${slot.period}, date: '${dateToPass}'})" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white py-1 sm:py-1.5 px-1 rounded-xl sm:rounded-2xl shadow-sm transition-all flex flex-col items-center justify-center leading-tight"><span class="flex items-center gap-1 text-[9px] sm:text-sm font-extrabold whitespace-nowrap"><i class="fas fa-check"></i> เช็คแล้ว</span><span class="flex items-center gap-1 text-[8px] sm:text-[11px] font-bold text-emerald-100 whitespace-nowrap"><i class="fas fa-pen text-[7px] sm:text-[9px]"></i> แตะเพื่อแก้ไข</span></button>` : `<button onclick="window.navigate('attendance', {subjectId: '${subjectInSlot.id}', period: ${slot.period}, date: '${dateToPass}'})" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white py-1 sm:py-1.5 pl-1 sm:pl-1.5 pr-2.5 sm:pr-3.5 rounded-full text-[9px] sm:text-sm font-bold transition-all shadow-sm whitespace-nowrap flex items-center justify-center gap-1 sm:gap-1.5"><span class="w-4 h-4 sm:w-5 sm:h-5 bg-white text-indigo-600 rounded-full flex items-center justify-center shrink-0 text-[8px] sm:text-xs"><i class="fas fa-check"></i></span><span>เริ่มเช็คชื่อ</span></button>`)}</td></tr>`;
                    } 
                    else { html += `<tr>${periodCellHtml(true)}<td class="p-1.5 sm:p-3 lg:p-5 text-slate-300 font-medium italic text-[9px] sm:text-sm" colspan="3">- ว่าง -</td></tr>`;
                    }
                }
            });
            html += `</tbody></table></div></div>`;
            if (wkNoPick) html = html.slice(0, wkMark) + `</div></div>${wkBanner}<div class="text-center py-8 sm:py-12 text-slate-400"><i class="fas fa-umbrella-beach text-4xl mb-3 opacity-50"></i><div class="font-bold ${isDarkNow ? 'text-slate-300' : 'text-slate-500'}">ยังไม่ได้เลือกวัน</div><div class="text-xs mt-1">แตะวันด้านบนเพื่อดูตารางสัปดาห์หน้า</div></div></div>`; // [v2.02.1]
            
            html += `<h3 class="text-lg sm:text-2xl font-extrabold mb-4 sm:mb-6 text-slate-800 flex items-center gap-2"><i class="fas fa-users text-indigo-500 text-xl sm:text-3xl"></i> รายชื่อนักเรียนห้อง ${roomNameStr}</h3><div class="bg-white rounded-2xl sm:rounded-3xl shadow-sm border border-slate-200 overflow-hidden mb-8 w-full"><div class="overflow-x-auto w-full"><table class="w-full text-left border-collapse min-w-[300px] sm:min-w-[500px]"><thead><tr class="bg-slate-50 text-slate-700 text-[10px] sm:text-sm border-b-2 border-slate-200 uppercase tracking-wider"><th class="p-3 sm:p-5 font-extrabold w-[40px] sm:w-[80px] min-w-[40px] sm:min-w-[80px] text-center sticky left-0 z-20 bg-slate-50 border-r border-slate-200 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">เลขที่</th><th class="p-3 sm:p-5 font-extrabold">ชื่อ-นามสกุล</th><th class="p-3 sm:p-5 font-extrabold text-center w-24 sm:w-48">ดูสถิติ</th></tr></thead><tbody class="divide-y divide-slate-100">`;
            if (roomStudents.length === 0) { html += `<tr><td colspan="3" class="p-8 text-center text-slate-400 font-medium text-xs sm:text-lg">ยังไม่มีรายชื่อนักเรียน</td></tr>`;
            } else {
                roomStudents.forEach((st, idx) => {
                    const statusBadge = st.status === 'resigned' ? `<span class="bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded text-[8px] sm:text-xs ml-1 sm:ml-2 border border-rose-200 font-black">ออก/ย้าย</span>` : ''; const rowClass = st.status === 'resigned' ? 'opacity-60 bg-slate-50' : (idx%2===0 ? 'bg-white' : 'bg-slate-50/50'); const bgForSticky = st.status === 'resigned' ? 'bg-slate-100' : (idx%2===0 ? 'bg-white' : 'bg-slate-50');
                    html += `<tr class="${rowClass} hover:bg-slate-100 transition-colors"><td class="p-3 sm:p-5 text-center font-black text-slate-500 text-sm sm:text-lg sticky left-0 z-10 ${bgForSticky} border-r border-slate-200 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">${st.number}</td><td class="p-3 sm:p-5 font-bold text-slate-800 text-[11px] sm:text-base">${st.name} ${statusBadge}${stuCodeHtml(st)}</td><td class="p-2 sm:p-5 text-center bg-white"><button onclick="window.navigate('student_summary', {studentId: '${st.id}'})" class="bg-white hover:bg-blue-50 text-blue-600 border border-slate-200 px-2 sm:px-4 py-1.5 sm:py-2.5 rounded-lg text-[10px] sm:text-sm font-bold shadow-sm w-full"><i class="fas fa-chart-line"></i> รายบุคคล</button></td></tr>`;
                });
            }
            html += `</tbody></table></div></div>`; document.getElementById('mainContent').innerHTML = html;
        }

        // ===== [v2.02.1] หน้าเช็คชื่อบนมือถือ: มุมมองปกติ / ย่อ (เห็นนักเรียนพร้อมกันมากขึ้น) — จำไว้ในเครื่อง =====
        const ATT_SHORT = { 'มา': 'มา', 'ขาด': 'ขาด', 'สาย': 'สาย', 'ร่วมกิจกรรม': 'กิจกรรม', 'ลาป่วย': 'ป่วย', 'ลากิจ': 'ลากิจ', 'โดดเรียน': 'โดด' };
        function attCompactOn() { try { return localStorage.getItem('bnksa_att_compact') === '1'; } catch (e) { return false; } }
        function setAttCompact(on) {
            try { localStorage.setItem('bnksa_att_compact', on ? '1' : '0'); } catch (e) { /* ไม่เป็นไร */ }
            const list = document.getElementById('attMobileList'); if (list) list.classList.toggle('amc-on', !!on);
            document.querySelectorAll('[data-amc]').forEach(b => { const me = (b.getAttribute('data-amc') === '1') === !!on; b.setAttribute('aria-pressed', me); b.className = 'px-3 py-1 rounded-full ' + (me ? 'bg-indigo-600 text-white' : 'text-slate-500'); });
        }
        window.setAttCompact = setAttCompact;
        function ensureAttCompactStyle() {
            if (document.getElementById('amcStyle')) return;
            const st = document.createElement('style'); st.id = 'amcStyle';
            st.textContent = `.amc-ls{display:none}
@media (max-width:1023px){
#attMobileList.amc-on .amc-card{padding:7px 10px;display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:8px}
#attMobileList.amc-on .amc-head{grid-column:1;margin:0 0 5px;gap:8px;min-width:0}
#attMobileList.amc-on .amc-head>span:first-child{width:26px;height:26px;font-size:12px;border-radius:8px;box-shadow:none}
#attMobileList.amc-on .amc-head>div{font-size:13px;line-height:1.3;flex-wrap:nowrap;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;display:block}
#attMobileList.amc-on .amc-head>div span{font-size:10px;display:inline!important;width:auto!important;margin-left:5px}
#attMobileList.amc-on .amc-dots{grid-column:2;grid-row:1;margin:0 0 5px;padding:0;gap:3px}
#attMobileList.amc-on .amc-dots>div{width:7px!important;height:7px!important}
#attMobileList.amc-on .amc-btns{grid-column:1/-1;display:grid;grid-template-columns:1.25fr repeat(6,minmax(0,1fr));gap:4px}
#attMobileList.amc-on .amc-btns>*{margin:0!important}
#attMobileList.amc-on .amc-btns>.grid{display:contents}
#attMobileList.amc-on .amc-btns label>div{height:40px;padding:0!important;flex-direction:column;gap:2px!important;font-size:10px!important;line-height:1.1;border-width:1.5px;border-radius:10px}
#attMobileList.amc-on .amc-btns label>div i{font-size:12px}
#attMobileList.amc-on .amc-lf{display:none}
#attMobileList.amc-on .amc-ls{display:inline}
}`;
            document.head.appendChild(st);
        }
        function openAttendance(subjectId, initialPeriod = null, fromTeacherDash = false, passedDate = null) {
            currentSubjectId = subjectId;
            const subject = subjects.find(s => s.id === subjectId); if (!subject) return;
            // ===== [ใหม่] เช็คก่อนว่าโหลดข้อมูลเช็คชื่อของห้องนี้มาแล้วหรือยัง ถ้ายัง โหลดก่อนแล้วค่อยวาดหน้าใหม่ (กันเห็นฟอร์มว่างผิดๆ ทั้งที่จริงมีข้อมูลอยู่แล้ว) =====
            const roomKeyForGate = roomAttKey_(subject.term, subject.year, subject.roomId);
            if (!(roomKeyForGate in window.__loadedRoomLastModified)) {
                document.getElementById('mainContent').innerHTML = `<div class="flex flex-col items-center justify-center py-20 sm:py-32"><i class="fas fa-spinner fa-spin text-4xl text-indigo-500 mb-4"></i><p class="text-slate-500 font-bold text-sm sm:text-base">กำลังโหลดข้อมูลห้อง ${formatRoomName(subject.roomId)}...</p></div>`;
                ensureAttendanceLoadedForRoom(subject.term, subject.year, subject.roomId).then(() => openAttendance(subjectId, initialPeriod, fromTeacherDash, passedDate));
                return;
            }
            const roomStudents = getRoomStudents(subject.roomId).sort((a, b) => parseInt(a.number) - parseInt(b.number));
            const today = passedDate || localDateStr();
            let selectedPeriod = initialPeriod;
            if (!selectedPeriod && subject.schedules && subject.schedules.length > 0) { const todayDay = getEffectiveDayOfWeek(today);
                const todaySched = effSched(subject).find(s => parseInt(s.day) === todayDay); selectedPeriod = todaySched ? todaySched.period : subject.schedules[0].period;
            }
            let tcOptions = `<option value="" disabled selected>-- เลือกครูที่มาสอนแทน --</option>`;
            pickableTeachers().forEach(t => { if (t.name !== subject.teacher && t.name !== subject.teacher2) tcOptions += `<option value="${t.name}">${t.name}</option>`; }); // [v1.76] เรียงตามตัวอักษร ไม่รวมหมวดระบบ/อื่นๆ
            const backAction = 'history.back()';

            // ===== [ใหม่] แสดงตารางสอนทั้งหมดของวิชานี้เป็นป้ายสีตามวัน (สีเดียวกับหน้าห้องเรียน: จันทร์เหลือง อังคารชมพู พุธเขียว พฤหัสส้ม ศุกร์ฟ้า) ให้เห็นบริบทว่าวิชานี้สอนวันไหนคาบไหนบ้าง ไม่ต้องสลับไปดูหน้าอื่น =====
            const scheduleColorMap = { 1: 'bg-yellow-500', 2: 'bg-pink-500', 3: 'bg-green-600', 4: 'bg-orange-500', 5: 'bg-sky-500' };
            const sortedSchedules = (subject.schedules || []).slice().sort((a, b) => parseInt(a.day) - parseInt(b.day) || parseInt(a.period) - parseInt(b.period));
            const scheduleBadgesHtml = sortedSchedules.length > 0 ? `<div class="mt-2 sm:mt-3 flex flex-wrap items-center gap-1.5"><span class="text-[10px] sm:text-xs font-bold text-slate-400 mr-0.5">วิชานี้มีสอน:</span>${sortedSchedules.map(sch => `<span class="${scheduleColorMap[parseInt(sch.day)] || 'bg-slate-400'} text-white font-bold text-[9px] sm:text-xs px-2 py-1 rounded-lg whitespace-nowrap">${daysLabel[sch.day - 1].replace('วัน', '')} คาบ ${periodLabel(sch.period)}</span>`).join('')}</div>` : '';
            let html = `<div class="mb-4 sm:mb-8 flex flex-col md:flex-row md:items-end justify-between gap-4 sm:gap-6 bg-white p-4 sm:p-8 rounded-[2rem] sm:rounded-[2.5rem] shadow-sm border border-slate-200 relative overflow-hidden"><div class="relative z-10 w-full"><div class="flex flex-wrap items-center gap-2 mb-2 sm:mb-3"><span class="bg-indigo-100 text-indigo-700 font-bold px-2 py-1 rounded text-[10px] sm:text-sm">ห้อง ${formatRoomName(subject.roomId)}</span></div><h2 class="text-xl sm:text-3xl font-extrabold text-slate-800 tracking-tight flex items-center gap-2"><i class="fas fa-clipboard-check text-indigo-500"></i> ${subject.name}</h2><p class="text-slate-500 mt-1 text-[11px] sm:text-base font-medium flex items-center gap-1.5"><i class="fas fa-chalkboard-teacher"></i> ครู: <span class="text-slate-700">${subject.teacher || '-'}${subject.teacher2 ? ' / ' + subject.teacher2 : ''}</span>${internChipHtml(subject.id)}</p>${scheduleBadgesHtml}</div><div class="flex flex-col gap-3 relative z-10 w-full md:w-auto md:min-w-[23rem] mt-2 md:mt-0"><div class="flex flex-row gap-2 w-full"><input type="date" id="attDate" value="${today}" onchange="window.navigate('attendance', {subjectId: '${subjectId}', fromTeacherDash: ${fromTeacherDash}, date: this.value}, true)" class="flex-1 bg-slate-50 border border-slate-200 text-slate-800 px-3 py-2 sm:py-3 rounded-xl shadow-inner focus:ring-2 focus:ring-indigo-500 text-base sm:text-sm font-bold outline-none"><select id="attPeriod" class="w-24 sm:w-32 bg-slate-50 border border-slate-200 text-slate-800 px-2 py-2 sm:py-3 rounded-xl shadow-inner focus:ring-2 focus:ring-indigo-500 text-base sm:text-sm font-bold outline-none"></select></div><input type="checkbox" id="isSubstitute" class="hidden" onchange="window.subOnToggle(this.checked)"><div id="subSeg" role="radiogroup" aria-label="ผู้สอนคาบนี้" class="flex w-full bg-slate-100 rounded-2xl p-1 gap-1"><button type="button" role="radio" data-sub-seg="0" onclick="window.subSetMode(false)" class="flex-1 rounded-xl py-3 px-2 font-extrabold text-sm sm:text-base md:text-sm whitespace-nowrap flex items-center justify-center gap-1.5 transition-colors"><i class="fas fa-chalkboard-teacher"></i> ครูประจำวิชาสอน</button><button type="button" role="radio" data-sub-seg="1" onclick="window.subSetMode(true)" class="flex-1 rounded-xl py-3 px-2 font-extrabold text-sm sm:text-base md:text-sm whitespace-nowrap flex items-center justify-center gap-1.5 transition-colors"><i class="fas fa-user-clock"></i> มีการสอนแทน</button></div><select id="substituteTeacher" class="hidden w-full bg-white border border-amber-300 text-slate-800 px-3 py-2 rounded-xl shadow-inner focus:ring-2 focus:ring-amber-500 text-base sm:text-sm font-bold outline-none">${tcOptions}</select>${subAssignSectionHtml()}${recFeatureOn('substitute') ? subPhotoSectionHtml() : ''}<button onclick="${backAction}" class="w-full bg-white border-2 border-slate-200 hover:bg-slate-50 text-slate-700 px-4 py-2 sm:py-3 rounded-xl shadow-sm transition-all font-bold text-sm">ย้อนกลับ</button></div></div>`;
            
            html += `<div id="attHolidayNote" class="hidden mb-4 sm:mb-6 bg-rose-50 border-2 border-rose-300 rounded-2xl p-3 sm:p-4 flex items-center gap-3"><div class="w-9 h-9 sm:w-11 sm:h-11 bg-rose-500 text-white rounded-full flex items-center justify-center text-sm sm:text-lg shrink-0"><i class="fas fa-calendar-times"></i></div><span id="attHolidayNoteText" class="text-rose-700 font-bold text-xs sm:text-sm"></span></div>`;
            html += `<div id="attActNote" class="hidden mb-4 sm:mb-6 rounded-2xl p-3 sm:p-4 flex items-center gap-3 border-2"></div>`; // [v1.74] กิจกรรม/หยุดเรียนรายคาบจาก AcademicHub
            html += `<div id="attNoPeriodBanner" class="hidden mb-4 sm:mb-6 bg-orange-50 border-2 border-orange-400 rounded-2xl p-4 sm:p-5 flex items-center gap-3"><div class="w-10 h-10 sm:w-12 sm:h-12 bg-orange-500 text-white rounded-full flex items-center justify-center text-lg sm:text-xl shrink-0"><i class="fas fa-exclamation-triangle"></i></div><div><p class="text-orange-800 font-extrabold text-sm sm:text-lg">ไม่มีคาบสอนในวันที่นี้</p><p class="text-orange-600 font-medium text-[10px] sm:text-sm">วิชานี้ไม่มีตารางสอนตรงกับวันที่เลือก จึงไม่สามารถเช็คชื่อหรือบันทึกข้อมูลได้ กรุณาเลือกวันที่อื่น</p></div></div>`;
            if (getTermStatus(subject.term, subject.year) !== 'open') {
                const st = getTermStatus(subject.term, subject.year);
                const msg = st === 'not_opened' ? `ภาคเรียน ${subject.term}/${subject.year} ยังไม่เปิดใช้งาน (ยังไม่สามารถบันทึกการเช็คชื่อได้)` : `ภาคเรียน ${subject.term}/${subject.year} ถูกล็อคข้อมูลไว้ (ดูข้อมูลย้อนหลังได้ แต่ไม่สามารถบันทึกการเช็คชื่อได้)`;
                html += `<div class="mb-4 sm:mb-6 bg-rose-50 border-2 border-rose-300 rounded-2xl p-3 sm:p-4 flex items-center gap-3"><div class="w-9 h-9 sm:w-11 sm:h-11 bg-rose-500 text-white rounded-full flex items-center justify-center text-sm sm:text-lg shrink-0"><i class="fas fa-lock"></i></div><span class="text-rose-700 font-bold text-xs sm:text-sm">${msg}</span></div>`;
            }
            
            html += `<div class="bg-white rounded-[1.5rem] sm:rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden mb-10"><div class="bg-slate-50 border-b border-slate-200 p-2.5 sm:p-4" style="display:grid; grid-template-columns:repeat(${Math.ceil(Object.keys(statuses).length / 2) * 2}, minmax(0,1fr)); gap:6px;">${Object.entries(statuses).map(([name, style], i, arr) => { const per = Math.ceil(arr.length / 2), r2 = arr.length - per; return `<div style="grid-column:${i === per && r2 < per ? (per - r2 + 1) + ' / ' : ''}span 2;" class="flex items-center justify-center gap-1 px-1 sm:px-3 py-1 bg-white border border-slate-200 rounded-lg shadow-sm text-[10px] sm:text-xs font-bold text-slate-600 whitespace-nowrap"><div class="w-2 h-2 sm:w-3 sm:h-3 rounded-full bg-${style.activeBg.replace('bg-','')}"></div> ${name}</div>`; }).join('')}</div>`; // [v1.76] 2 แถว ป้ายกว้างเท่ากัน
            // ===== [ใหม่] หาว่าวันนี้ (${today}) แต่ละคาบ (0-8) ห้องนี้มีวิชาอะไร และเช็คชื่อไปหรือยัง - ใช้แสดงจุดสีบอกสถานะคาบอื่นๆ ในวันเดียวกันให้ครูเห็นบริบท ไม่ต้องสลับหน้าไปดู =====
            const dayOfWeekNumForDots = getEffectiveDayOfWeek(today);
            const roomSubjectsForDots = getRoomSubjects(subject.roomId, subject.term, subject.year);
            const periodSubjectMap = {}; // period -> วิชาที่สอนคาบนี้วันนี้
            roomSubjectsForDots.forEach(s => { effSched(s).forEach(sch => { if (parseInt(sch.day) === dayOfWeekNumForDots) periodSubjectMap[sch.period] = s; }); });
            const periodRecordMap = {}; // period -> record การเช็คชื่อของวันนี้ (ถ้ามี)
            Object.keys(periodSubjectMap).forEach(p => {
                const rec = attendanceData.find(a => a.subjectId === periodSubjectMap[p].id && a.date === today && String(a.period) === String(p));
                if (rec) periodRecordMap[p] = rec;
            });
            const buildDayDots = (studentId, big) => [-2,0,1,2,3,4,5,6,7,8].map((p) => {
                const sub = periodSubjectMap[p];
                const rec = periodRecordMap[p];
                const stStatus = rec ? rec.records[studentId] : null;
                const isCurrent = String(p) === String(selectedPeriod);
                const color = stStatus ? (STATUS_HEX[stStatus] || '#cbd5e1') : (sub ? '#e2e8f0' : 'transparent');
                const sizeCls = big ? 'w-3 h-3' : 'w-2.5 h-2.5';
                const detail = !sub ? `คาบ ${periodLabel(p)}: ไม่มีวิชา` : (stStatus ? `คาบ ${periodLabel(p)} (${sub.name}): ${stStatus}` : `คาบ ${periodLabel(p)} (${sub.name}): ยังไม่เช็ค`);
                return `<div title="${detail}" class="${sizeCls} rounded-full shrink-0 ${isCurrent ? 'ring-2 ring-offset-1 ring-indigo-400' : ''} ${sub ? '' : 'opacity-30'}" style="background-color:${color}"></div>`;
            }).join('');
            ensureAttCompactStyle(); // [v2.02.1] มือถือ: มุมมองปกติ / ย่อ (จำไว้ในเครื่อง)
            const amcOn = attCompactOn(), amcN = roomStudents.length, isDarkNow = document.documentElement.classList.contains('dark');
            html += `<div class="lg:hidden flex items-center justify-between gap-2 px-3 py-2 border-b border-slate-200 ${isDarkNow ? 'bg-slate-800/40' : 'bg-white'}"><span class="text-[11px] font-bold text-slate-500"><i class="fas fa-users"></i> นักเรียน ${amcN} คน</span><div class="inline-flex rounded-full border border-slate-200 ${isDarkNow ? 'bg-slate-800' : 'bg-slate-50'} p-0.5 text-[11px] font-bold" role="group" aria-label="มุมมองรายชื่อ"><button type="button" data-amc="0" onclick="setAttCompact(false)" aria-pressed="${!amcOn}" class="px-3 py-1 rounded-full ${amcOn ? 'text-slate-500' : 'bg-indigo-600 text-white'}"><i class="fas fa-square"></i> ปกติ</button><button type="button" data-amc="1" onclick="setAttCompact(true)" aria-pressed="${amcOn}" class="px-3 py-1 rounded-full ${amcOn ? 'bg-indigo-600 text-white' : 'text-slate-500'}"><i class="fas fa-bars"></i> ย่อ</button></div></div>`;
            html += `<div id="attMobileList" class="block lg:hidden divide-y divide-slate-100 ${amcOn ? 'amc-on' : ''}">`;
            if (roomStudents.length === 0) { html += `<div class="p-10 text-center text-slate-400 font-medium">ไม่มีรายชื่อนักเรียน</div>`;
            } else {
                roomStudents.forEach(st => {
                    const isResigned = st.status === 'resigned'; const statusBadge = isResigned ? `<span class="bg-rose-100 text-rose-700 px-1.5 py-0.5 rounded text-[8px] ml-1 font-black border border-rose-200">ออก/ย้าย</span>` : '';
                    const mkMobileBtn = (status, big) => { const style = statuses[status]; const sizeCls = big ? 'py-3.5 text-base gap-2' : 'py-2.5 text-xs gap-1'; return `<label class="cursor-pointer block ${isResigned ? 'pointer-events-none' : ''}"><input type="radio" name="att_mobile_${st.id}" value="${status}" onchange="syncRadio('${st.id}', '${status}')" class="peer sr-only"><div class="w-full ${sizeCls} rounded-xl border-2 ${style.border} ${style.bg} ${style.color} font-bold transition-all peer-checked:${style.activeBg} peer-checked:text-white peer-checked:border-transparent peer-checked:shadow-md flex items-center justify-center"><i class="fas ${style.icon}"></i><span class="amc-lf">&nbsp;${status}</span><span class="amc-ls">${ATT_SHORT[status] || status}</span></div></label>`; };
                    html += `<div class="amc-card p-3 sm:p-5 ${isResigned ? 'bg-rose-100/70' : 'bg-white'}"><div class="amc-head flex items-center gap-3 mb-2"><span class="shrink-0 font-black text-white ${isResigned ? 'bg-rose-500' : 'bg-indigo-500'} text-lg sm:text-xl w-11 h-11 sm:w-12 sm:h-12 rounded-xl flex items-center justify-center shadow-sm">${st.number}</span><div class="font-extrabold ${isResigned ? 'text-rose-700' : 'text-slate-800'} text-base sm:text-lg leading-snug flex items-center flex-wrap gap-x-1 min-w-0">${st.name} ${statusBadge}${stuCodeHtml(st)}</div></div>${Object.keys(periodSubjectMap).length > 0 ? `<div class="amc-dots flex items-center gap-1 mb-3 pl-1">${buildDayDots(st.id, false)}</div>` : ''}<div class="amc-btns space-y-1.5">${mkMobileBtn('มา', true)}<div class="grid grid-cols-3 gap-1.5">${mkMobileBtn('ขาด', false)}${mkMobileBtn('สาย', false)}${mkMobileBtn('ร่วมกิจกรรม', false)}</div><div class="grid grid-cols-3 gap-1.5">${mkMobileBtn('ลาป่วย', false)}${mkMobileBtn('ลากิจ', false)}${mkMobileBtn('โดดเรียน', false)}</div></div></div>`;
                });
            }
            
            html += `</div><div class="hidden lg:block overflow-x-auto w-full"><table class="w-full text-left border-collapse min-w-[950px]"><thead><tr class="bg-white text-slate-700 border-b-2 border-slate-100 uppercase tracking-wider text-sm"><th class="p-5 font-extrabold w-[80px] min-w-[80px] text-center sticky left-0 z-20 bg-white border-r border-slate-100 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">เลขที่</th><th class="p-5 font-extrabold w-[250px] min-w-[250px] sticky left-[80px] z-20 bg-white border-r border-slate-100 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">ชื่อ-นามสกุล</th><th class="p-5 font-extrabold text-center bg-slate-50/50">สถานะการมาเรียน (รายคาบ)</th></tr></thead><tbody class="divide-y divide-slate-100" id="attendanceTableBody">`;
            if (roomStudents.length > 0) {
                roomStudents.forEach((st, idx) => {
                    const isRes = st.status === 'resigned'; const statusBadge = isRes ? `<span class="bg-rose-100 text-rose-700 px-2 py-0.5 rounded text-[10px] ml-2 border border-rose-200 font-black">ออก/ย้าย</span>` : ''; const rowBg = isRes ? 'bg-rose-100/70' : (idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'); const bgForSticky = isRes ? 'bg-rose-100' : (idx % 2 === 0 ? 'bg-white' : 'bg-slate-50');
                    html += `<tr class="${rowBg} hover:bg-indigo-50/30 transition-colors"><td class="p-5 text-center font-black ${isRes ? 'text-rose-600' : 'text-indigo-600'} text-3xl sticky left-0 z-10 ${bgForSticky} border-r border-slate-100 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">${st.number}</td><td class="p-5 border-r border-slate-100 sticky left-[80px] z-10 ${bgForSticky} shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]"><div class="font-bold ${isRes ? 'text-rose-700' : 'text-slate-800'} flex items-center flex-wrap gap-x-1">${st.name} ${statusBadge}${stuCodeHtml(st)}</div>${Object.keys(periodSubjectMap).length > 0 ? `<div class="flex items-center gap-1 mt-1.5">${buildDayDots(st.id, true)}</div>` : ''}</td><td class="p-4 ${isRes ? 'bg-rose-50/60' : 'bg-slate-50/30'}"><div class="flex justify-center gap-2">`;
                    Object.keys(statuses).forEach(status => { const style = statuses[status]; html += `<label class="cursor-pointer"><input type="radio" name="att_${st.id}" value="${status}" onchange="syncRadio('${st.id}', '${status}')" class="peer sr-only" ${isRes ? 'disabled' : ''}><div class="px-3 py-2 rounded-xl border-2 ${style.border} ${style.bg} ${style.color} text-base font-bold transition-all peer-checked:${style.activeBg} peer-checked:text-white peer-checked:border-transparent peer-checked:shadow-md hover:scale-105 active:scale-95 flex items-center gap-1.5 whitespace-nowrap"><i class="fas ${style.icon} opacity-50 peer-checked:opacity-100"></i> ${status}</div></label>`; });
                    html += `</div></td></tr>`;
                });
            }
            const recKind = subject.systemType === 'homeroom' ? 'homeroom' : (subject.systemType === 'zone' ? 'zone' : null);
            const hrSectionHtml = (recKind && recFeatureOn(recKind) && !isAttendanceEntryLocked(subject.term, subject.year) && effSched(subject).some(sc => parseInt(sc.day) === getEffectiveDayOfWeek(today))) ? buildRecordSectionHtml(recKind) : '';
            if (hrSectionHtml) setTimeout(() => hrInitSection(subject, today, recKind), 0);
            html += `</tbody></table></div><div class="p-4 sm:p-8 bg-slate-50 border-t border-slate-200 flex flex-col justify-end items-center shadow-inner">${hrSectionHtml}<div id="attSaveBanner" class="hidden w-full mb-3"></div>${isAttendanceEntryLocked(subject.term, subject.year) ? `<button id="saveAttBtn" disabled class="w-full bg-slate-300 text-slate-500 px-8 py-3.5 sm:py-4 rounded-xl sm:rounded-2xl font-extrabold text-base sm:text-lg flex items-center justify-center gap-2 cursor-not-allowed"><i class="fas fa-lock text-xl"></i> ไม่สามารถบันทึกการเช็คชื่อได้ในขณะนี้</button>` : `<button id="saveAttBtn" onclick="window.saveAttendance(${fromTeacherDash})" class="w-full mx-auto bg-indigo-600 hover:bg-indigo-700 text-white px-8 py-3.5 sm:py-4 rounded-full font-extrabold text-base sm:text-lg transition-all duration-300 shadow-xl shadow-indigo-200 flex items-center justify-center gap-2"><i class="fas fa-cloud-upload-alt text-xl"></i> บันทึกข้อมูลเช็คชื่อ</button>`}</div></div>`;
            document.getElementById('mainContent').innerHTML = html;
            
            window.updatePeriodDropdown = function() {
                const dateVal = document.getElementById('attDate').value;
                setTimeout(() => applyPastLockUi(dateVal), 0); // [v1.78]
                const dayOfWeek = getEffectiveDayOfWeek(dateVal);
                const schedsOnDay = effSched(subject).filter(s => parseInt(s.day) === dayOfWeek);
                const selectEl = document.getElementById('attPeriod'), saveBtn = document.getElementById('saveAttBtn');
                const noPeriodBanner = document.getElementById('attNoPeriodBanner');
                if (schedsOnDay.length > 0) {
                    selectEl.innerHTML = schedsOnDay.map(sch => `<option value="${sch.period}" ${String(sch.period) === String(selectedPeriod) ? 'selected' : ''}>คาบ ${periodLabel(sch.period)} (${daysLabel[sch.day-1]})</option>`).join('');
                    selectEl.disabled = false; saveBtn.disabled = false; saveBtn.innerHTML = '<i class="fas fa-cloud-upload-alt text-xl"></i> บันทึกข้อมูลเช็คชื่อ';
                    saveBtn.classList.replace('bg-slate-400', 'bg-indigo-600'); saveBtn.classList.replace('hover:bg-slate-500', 'hover:bg-indigo-700');
                    if (noPeriodBanner) noPeriodBanner.classList.add('hidden');
                    document.querySelectorAll('input[name^="att_"]').forEach(r => { r.disabled = false; }); // ===== [ใหม่] เปิดให้กดเช็คสถานะนักเรียนได้ตามปกติ เมื่อวันที่เลือกมีคาบสอนจริง =====
                    loadExistingAttendance(subjectId, dateVal, selectEl.value);
                } else {
                    selectEl.innerHTML = `<option value="">ไม่มีคาบสอน</option>`;
                    selectEl.disabled = true; saveBtn.disabled = true;
                    saveBtn.innerHTML = '<i class="fas fa-times-circle text-xl"></i> ไม่มีคาบสอนในวันที่เลือก';
                    saveBtn.classList.replace('bg-indigo-600', 'bg-slate-400'); saveBtn.classList.replace('hover:bg-indigo-700', 'hover:bg-slate-500');
                    if (noPeriodBanner) noPeriodBanner.classList.remove('hidden'); applyActivityPeriodUi(null);
                    document.querySelectorAll('input[type="radio"]').forEach(r => r.checked = false);
                    document.querySelectorAll('input[name^="att_"]').forEach(r => { r.disabled = true; }); // ===== [ใหม่] ปิดปุ่มเช็คสถานะนักเรียนทุกคนด้วย ไม่ใช่แค่ปุ่มบันทึกสุดท้าย เมื่อไม่มีคาบสอนวันนี้ =====
                }
            };
            window.updateAttendanceHolidayNote = function() {
                const dateVal = document.getElementById('attDate').value;
                const noteEl = document.getElementById('attHolidayNote'), textEl = document.getElementById('attHolidayNoteText');
                if (!noteEl || !textEl) return;
                const holiday = getHolidayForDate(dateVal);
                if (holiday) {
                    const type = holiday.type || 'holiday';
                    const meta = HOLIDAY_TYPE_META[type];
                    const durLabel = holiday.duration ? ` (${HOLIDAY_DURATION_LABEL[holiday.duration] || ''})` : '';
                    let msg;
                    if (type === 'holiday') msg = `วันที่เลือกเป็นวันหยุด: ${holiday.label} (ยังสามารถเช็คชื่อได้ตามปกติหากมีการเรียนการสอน)`;
                    else msg = `วันที่เลือกมี${meta.label}: ${holiday.label}${durLabel} — เช็คชื่อได้ตามปกติ`;
                    textEl.innerText = msg;
                    noteEl.className = `mb-4 sm:mb-6 rounded-2xl p-3 sm:p-4 flex items-center gap-3 ${meta.noteBg}`;
                    const iconWrap = noteEl.querySelector('div'); if (iconWrap) iconWrap.className = `w-9 h-9 sm:w-11 sm:h-11 ${meta.noteIconBg} text-white rounded-full flex items-center justify-center text-sm sm:text-lg shrink-0`;
                    textEl.className = `font-bold text-xs sm:text-sm ${meta.noteText}`;
                    noteEl.classList.remove('hidden');
                }
                else { noteEl.classList.add('hidden'); }
            };
            window.updatePeriodDropdown();
            window.updateAttendanceHolidayNote();
            document.getElementById('attPeriod').addEventListener('change', (e) => { loadExistingAttendance(subjectId, document.getElementById('attDate').value, e.target.value); });
            try { lvAttBanner(subject, today); } catch (e) { /* [v2.00.3] ข้าม */ }
        }
        
        window.syncRadio = function(stId, val) {
            const m = document.querySelector(`input[name="att_mobile_${stId}"][value="${val}"]`);
            const d = document.querySelector(`input[name="att_${stId}"][value="${val}"]`);
            if(m && !m.disabled) m.checked = true; if(d && !d.disabled) d.checked = true;
        };
        // ===== [v1.74] กิจกรรม/หยุดเรียนรายคาบ (ตั้งในปฏิทินกิจกรรมของ AcademicHub) — หยุดเรียนมาก่อนกิจกรรม =====
        function hubPeriodFor(roomId, date, period) {
            const label = periodLabel(period), g = (/^m(\d)_/.exec(roomId || '') || [])[1] || '';
            const hit = (hubPeriods || []).filter(e => e.date === date && (e.periods === 'all' || (e.periods || []).includes(String(label))) && ((!(e.grades || []).length && !(e.rooms || []).length) || (e.grades || []).includes(g) || (e.rooms || []).includes(roomId)));
            return hit.find(e => e.mode === 'noclass') || hit[0] || null;
        }
        function applyActivityPeriodUi(entry) {
            const box = document.getElementById('attActNote');
            const isAct = !!(entry && entry.mode === 'activity');
            // คาบกิจกรรม: ซ่อนปุ่ม "มา" ใช้ "ร่วมกิจกรรม" แทน (นับเป็นมาเรียนเหมือนกันทุกรายงาน)
            document.querySelectorAll('input[type="radio"][value="มา"]').forEach(r => { const l = r.closest('label'); if (l) l.style.display = isAct ? 'none' : ''; });
            if (!box) return;
            if (!entry) { box.classList.add('hidden'); box.innerHTML = ''; return; }
            const t = escapeHtmlText(entry.title || '');
            box.className = `mb-4 sm:mb-6 rounded-2xl p-3 sm:p-4 flex flex-wrap items-center gap-3 border-2 ${isAct ? 'bg-cyan-50 border-cyan-300' : 'bg-orange-50 border-orange-300'}`;
            box.innerHTML = isAct
                ? `<div class="w-9 h-9 sm:w-11 sm:h-11 bg-cyan-500 text-white rounded-full flex items-center justify-center text-sm sm:text-lg shrink-0"><i class="fas fa-running"></i></div><div class="flex-1 min-w-[200px]"><p class="text-cyan-800 font-extrabold text-xs sm:text-sm">คาบนี้มีกิจกรรม: ${t}</p><p class="text-cyan-700 font-semibold text-[11px] sm:text-xs">เช็คชื่อหรือไม่ก็ได้ (ไม่บังคับ) · ถ้าเช็ค ใช้ปุ่ม "ร่วมกิจกรรม" แทน "มา"</p></div><button type="button" onclick="window.markAllActivity()" class="bg-cyan-600 hover:bg-cyan-700 text-white px-3 py-2 rounded-lg font-bold text-xs sm:text-sm shrink-0"><i class="fas fa-users"></i> ทุกคนร่วมกิจกรรม</button>`
                : `<div class="w-9 h-9 sm:w-11 sm:h-11 bg-orange-500 text-white rounded-full flex items-center justify-center text-sm sm:text-lg shrink-0"><i class="fas fa-school-circle-xmark"></i></div><div class="flex-1 min-w-[200px]"><p class="text-orange-800 font-extrabold text-xs sm:text-sm">คาบนี้${entry.holiday ? 'เป็นวันหยุด' : 'หยุดเรียน'}: ${t}</p><p class="text-orange-700 font-semibold text-[11px] sm:text-xs">ไม่ต้องเช็คชื่อ (ถ้ามีการเรียนการสอนก็เช็คได้ตามปกติ)</p></div>`;
        }
        function escapeHtmlText(v) { return String(v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
        window.markAllActivity = function() {
            document.querySelectorAll('input[type="radio"][value="ร่วมกิจกรรม"]').forEach(r => { if (!r.disabled) r.checked = true; });
        };
        function loadExistingAttendance(subjectId, date, period) {
            if (!period) return;
            document.querySelectorAll('input[type="radio"]').forEach(r => r.checked = false);
            const subForAct = subjects.find(s => s.id === subjectId);
            const actEntry = subForAct ? hubPeriodFor(subForAct.roomId, date, period) : null; applyActivityPeriodUi(actEntry); // [v1.74]
            const isActPeriod = !!(actEntry && actEntry.mode === 'activity');
            document.getElementById('isSubstitute').checked = false; document.getElementById('substituteTeacher').classList.add('hidden'); document.getElementById('substituteTeacher').value = ""; subSegPaint(false); // [v1.76]
            let record = attendanceData.find(a => a.subjectId === subjectId && a.date === date && String(a.period) === String(period));
            subResetState(record); // [v1.71.6] รูปการสอนแทนของคาบนี้ (ถ้ามี)
            subAssignSet(record && (record.subAssign === 'yes' || record.subAssign === 'no') ? record.subAssign : ''); // [v2.02.3]
            if (record) {
                if(record.substituteTeacher) { document.getElementById('isSubstitute').checked = true;
                    document.getElementById('substituteTeacher').classList.remove('hidden'); document.getElementById('substituteTeacher').value = record.substituteTeacher; window.subOnToggle(true); }
                Object.keys(record.records).forEach(stId => { const v0 = record.records[stId]; syncRadio(stId, isActPeriod && v0 === 'มา' ? 'ร่วมกิจกรรม' : v0); });
                showToast(`โหลดข้อมูลเก่าแล้ว`, "success");
            } else {
                let copiedFromPrev = false;
                {
                    const subForCopy = subjects.find(s => s.id === subjectId);
                    const prevPeriod = parseInt(period) - 1;
                    const dow2 = getEffectiveDayOfWeek(date);
                    const hasPrevSchedule = subForCopy && (subForCopy.schedules || []).some(s => parseInt(s.day) === dow2 && parseInt(s.period) === prevPeriod);
                    if (hasPrevSchedule) {
                        const prevRecord = attendanceData.find(a => a.subjectId === subjectId && a.date === date && String(a.period) === String(prevPeriod));
                        if (prevRecord) {
                            Object.keys(prevRecord.records).forEach(stId => { const v1 = prevRecord.records[stId]; syncRadio(stId, isActPeriod && v1 === 'มา' ? 'ร่วมกิจกรรม' : v1); });
                            showToast(`คัดลอกข้อมูลจากคาบ ${periodLabel(prevPeriod)} ของวิชานี้ให้แล้ว - กรุณาตรวจสอบก่อนกดบันทึก`, "info");
                            copiedFromPrev = true;
                        }
                    }
                }
                if (!copiedFromPrev && !(actEntry && actEntry.mode === 'noclass')) { document.querySelectorAll(`input[type="radio"][value="${isActPeriod ? 'ร่วมกิจกรรม' : 'มา'}"]`).forEach(r => { if(!r.disabled) r.checked = true; }); } // [v1.74] คาบกิจกรรม = ร่วมกิจกรรม · คาบหยุดเรียน = ไม่ติ๊กให้
            }
        }


        // ======================================================================
        // ===== [v1.71.3] บันทึกกิจกรรมพร้อมรูป: คาบโฮมรูม และคาบ A (เขตพื้นที่รับผิดชอบ) =====
        // รูปเก็บใน Google Drive ของโรงเรียน ส่ง 2 ทาง: (1) ส่งตรงเข้า Apps Script ของโรงเรียน (ทางหลัก)
        //                                         (2) Relay ผ่าน Cloudflare Worker (ใช้เมื่อส่งตรงไม่ผ่าน)
        // เปิด/ปิดได้ที่หน้าตั้งค่าทั่วไป (Super Admin): settings.recordHomeroom (ค่าเริ่มต้นเปิด), settings.recordZone (ค่าเริ่มต้นปิด)
        // ======================================================================
        const HOMEROOM_DRIVE_URL = 'https://script.google.com/macros/s/AKfycbzlwK5VgNNA53zaNyKeiZ950DrX-soKYMOyTn_zebU_Ga8_h1y_z-CxJ1pl8Eqp7UOlSg/exec';
        const HOMEROOM_DRIVE_TOKEN = 'bnksa-hr-2569'; // ต้องตรงกับ TOKEN ใน Apps Script และ RELAY_TOKEN ใน Worker
        window.__hrLogsCache = window.__hrLogsCache || {};

        function recFeatureOn(kind) { return kind === 'zone' ? settings.recordZone === true : (kind === 'substitute' ? settings.recordSubstitute === true : settings.recordHomeroom !== false); }
        function recStoreRoomId(kind, roomId) { return kind === 'zone' ? `${roomId}#zone` : roomId; } // คาบ A เก็บแยกด้วยรหัสห้อง + #zone (ใช้ตารางเดียวกับโฮมรูม)
        async function hrFetchJson(url, body, timeoutMs) {
            const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeoutMs || 30000);
            try {
                const opt = body ? { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(body), signal: ctrl.signal } : { signal: ctrl.signal };
                const r = await fetch(url, opt); if (!r.ok) return null; return await r.json();
            } catch (e) { return null; } finally { clearTimeout(t); }
        }
        // ส่งแบบ XHR เพื่อให้รู้ % การอัปโหลด
        function hrXhrJson(url, body, timeoutMs, onPct) {
            return new Promise((resolve) => {
                try {
                    const x = new XMLHttpRequest(); x.open('POST', url, true); x.timeout = timeoutMs || 60000;
                    x.setRequestHeader('Content-Type', 'text/plain;charset=utf-8');
                    if (onPct && x.upload) x.upload.onprogress = (ev) => { if (ev.lengthComputable) onPct(Math.min(95, Math.round(ev.loaded / ev.total * 95))); };
                    x.onload = () => { try { resolve(x.status >= 200 && x.status < 300 ? JSON.parse(x.responseText) : null); } catch (e) { resolve(null); } };
                    x.onerror = () => resolve(null); x.ontimeout = () => resolve(null);
                    x.send(JSON.stringify(body));
                } catch (e) { resolve(null); }
            });
        }
        function hrRoomKey(term, year, storeRoomId) { return `${term}|${year}|${storeRoomId}`; }
        async function hrLoadLogs(term, year, storeRoomId, force) {
            const key = hrRoomKey(term, year, storeRoomId);
            if (!force && window.__hrLogsCache[key]) return window.__hrLogsCache[key];
            const j = await hrFetchJson(`${GOOGLE_APP_SCRIPT_URL}?action=get_homeroom_logs&term=${encodeURIComponent(term)}&year=${encodeURIComponent(year)}&room=${encodeURIComponent(storeRoomId)}`, null, 20000);
            if (j && j.status === 'success' && Array.isArray(j.logs)) { window.__hrLogsCache[key] = j.logs; return j.logs; }
            return window.__hrLogsCache[key] || null; // null = โหลดไม่สำเร็จ
        }
        // [v1.71.4] โครงสร้างโฟลเดอร์: โฮมรูม|เขตพื้นที่ / ปีการศึกษา 2569 / ภาคเรียน 2 / ห้อง ม.2-3
        function hrTermFolderPath(term, year, kind) { return `${kind === 'zone' ? 'เขตพื้นที่' : (kind === 'substitute' ? 'สอนแทน' : 'โฮมรูม')}/ปีการศึกษา ${year}/ภาคเรียน ${term}`; }
        function hrFolderPath(term, year, roomId, kind) { return `${hrTermFolderPath(term, year, kind)}/ห้อง ${formatRoomName(roomId).replace(/\//g, '-')}`; }
        // ย้ายโฟลเดอร์รูปของภาคเรียนนั้นลงถังขยะของ Drive (กู้คืนได้ภายใน 30 วัน) - ส่งตรงก่อน ไม่ผ่านค่อยใช้ Relay
        async function hrTrashTermFolders(term, year) {
            let failed = 0; // [v1.74] นับโฟลเดอร์ที่ย้ายไม่สำเร็จ แจ้งผู้ใช้ (เดิมเงียบ)
            for (const kind of ['homeroom', 'zone', 'substitute']) {
                const path = hrTermFolderPath(term, year, kind);
                let r = HOMEROOM_DRIVE_URL ? await hrFetchJson(HOMEROOM_DRIVE_URL, { action: 'trashPath', token: HOMEROOM_DRIVE_TOKEN, path }, 30000) : null;
                if (!r || r.status !== 'success') r = await hrFetchJson(GOOGLE_APP_SCRIPT_URL, { __mode: 'relay_folder_trash', path }, 30000);
                if (!r || r.status !== 'success') failed++;
            }
            window.__hrLogsCache = {};
            return failed;
        }
        // ส่งรูป 1 รูป: ส่งตรงก่อน ไม่ผ่านค่อยใช้ Relay คืนค่า { id, route } หรือ null
        async function hrUploadPhoto(dataUrl, fileName, folderPath, onProgress) {
            const body = { fileName, mime: 'image/jpeg', base64: String(dataUrl).split(',')[1], folderPath };
            if (HOMEROOM_DRIVE_URL) {
                if (onProgress) onProgress(5, 'direct');
                const direct = await hrXhrJson(HOMEROOM_DRIVE_URL, Object.assign({ action: 'upload', token: HOMEROOM_DRIVE_TOKEN }, body), 90000, p => onProgress && onProgress(p, 'direct'));
                if (direct && direct.status === 'success' && direct.id) return { id: direct.id, route: 'direct' };
            }
            if (onProgress) onProgress(5, 'relay');
            const viaRelay = await hrXhrJson(GOOGLE_APP_SCRIPT_URL, Object.assign({ __mode: 'relay_photo' }, body), 90000, p => onProgress && onProgress(p, 'relay'));
            if (viaRelay && viaRelay.status === 'success' && viaRelay.id) return { id: viaRelay.id, route: 'relay' };
            return null;
        }
        // [v1.75.2] รูปใน PDF: ตัดกลางภาพให้เป็นอัตราส่วน 4:3 ก่อนวาง (html2canvas ไม่รองรับ object-fit:cover จึงยืด/บีบรูป) — รูปต้นฉบับใน Drive ไม่ถูกแก้
        function hrCropCover(url, ratio = 4 / 3, maxW = 1200) {
            if (!url) return Promise.resolve(url);
            return new Promise(resolve => {
                const img = new Image();
                img.onload = () => {
                    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
                    if (!iw || !ih) { resolve(url); return; }
                    let sw = iw, sh = Math.round(iw / ratio);
                    if (sh > ih) { sh = ih; sw = Math.round(ih * ratio); }
                    const W = Math.min(maxW, sw), H = Math.round(W / ratio);
                    const c = document.createElement('canvas'); c.width = W; c.height = H;
                    const ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
                    ctx.drawImage(img, Math.round((iw - sw) / 2), Math.round((ih - sh) / 2), sw, sh, 0, 0, W, H);
                    try { resolve(c.toDataURL('image/jpeg', 0.88)); } catch (e) { resolve(url); }
                };
                img.onerror = () => resolve(url);
                img.src = url;
            });
        }
        async function hrGetPhotoPdf(id) { return hrCropCover(await hrGetPhoto(id)); }
        // [v2.02.2] จำรูปที่โหลดแล้วไว้ในหน่วยความจำของหน้าเว็บ (ปิด/รีเฟรชหน้า = ล้าง ไม่เก็บรูปนักเรียนค้างในเครื่องที่ใช้ร่วมกัน)
        //   สร้าง PDF ซ้ำ = ไม่ดึงรูปเดิมจาก Drive อีก · รหัสรูปไม่ซ้ำกัน (เปลี่ยนรูป = รหัสใหม่) จึงไม่มีรูปเก่าค้าง
        const HR_PH_MEM = new Map(), HR_PH_MAX = 120;
        async function hrGetPhoto(id) {
            if (HR_PH_MEM.has(id)) { const v = HR_PH_MEM.get(id); HR_PH_MEM.delete(id); HR_PH_MEM.set(id, v); return v; }
            const u = await hrGetPhotoNet(id);
            if (u) { HR_PH_MEM.set(id, u); while (HR_PH_MEM.size > HR_PH_MAX) HR_PH_MEM.delete(HR_PH_MEM.keys().next().value); }
            return u;
        }
        // โหลดหลายรูปพร้อมกันครั้งละ 3 รูป (เดิมทีละรูป) — ผลเรียงตามลำดับเดิม
        async function hrMapLimit(items, limit, fn, onEach) {
            const out = new Array(items.length); let next = 0, done = 0;
            const worker = async () => { while (next < items.length) { const i = next++; try { out[i] = await fn(items[i], i); } catch (e) { out[i] = null; } done++; if (onEach) onEach(done, items.length); } };
            await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
            return out;
        }
        async function hrGetPhotoNet(id) {
            if (HOMEROOM_DRIVE_URL) {
                const direct = await hrFetchJson(HOMEROOM_DRIVE_URL, { action: 'get', token: HOMEROOM_DRIVE_TOKEN, id }, 60000);
                if (direct && direct.status === 'success' && direct.base64) return `data:${direct.mime || 'image/jpeg'};base64,${direct.base64}`;
            }
            const viaRelay = await hrFetchJson(GOOGLE_APP_SCRIPT_URL, { __mode: 'relay_photo_get', id }, 45000);
            if (viaRelay && viaRelay.status === 'success' && viaRelay.base64) return `data:${viaRelay.mime || 'image/jpeg'};base64,${viaRelay.base64}`;
            return null;
        }
        function hrTrashPhotos(ids) {
            (ids || []).forEach(async (id) => {
                const r = HOMEROOM_DRIVE_URL ? await hrFetchJson(HOMEROOM_DRIVE_URL, { action: 'trash', token: HOMEROOM_DRIVE_TOKEN, id }, 30000) : null;
                if (!r || r.status !== 'success') hrFetchJson(GOOGLE_APP_SCRIPT_URL, { __mode: 'relay_photo_trash', id }, 30000);
            });
        }
        // ย่อรูปก่อนส่ง (ด้านยาวสุด 1280px, JPEG คุณภาพ 0.8 ≈ 100-250 KB)
        function hrResizeImage(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(new Error('read'));
                reader.onload = (e) => {
                    const img = new Image();
                    img.onerror = () => reject(new Error('img'));
                    img.onload = () => {
                        const MAX = 1280; const scale = Math.min(1, MAX / Math.max(img.width, img.height));
                        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
                        const c = document.createElement('canvas'); c.width = w; c.height = h;
                        const ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(img, 0, 0, w, h);
                        resolve(c.toDataURL('image/jpeg', 0.8));
                    };
                    img.src = e.target.result;
                };
                reader.readAsDataURL(file);
            });
        }
        function hrEsc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

        function buildRecordSectionHtml(kind) {
            const inp = 'mt-1 w-full h-11 px-3 rounded-xl border-2 border-slate-200 focus:border-indigo-400 outline-none text-sm sm:text-base font-semibold text-slate-700 bg-white';
            const lab = 'block text-xs sm:text-sm font-extrabold text-slate-600';
            const photoBlock = (n) => `<div><p class="${lab}">${n}. ${kind === 'zone' ? 'รูปรายงาน' : 'รูปกิจกรรม'} <span class="text-rose-500">* 1 รูป</span> <span class="font-semibold text-slate-500">(ระบบย่อรูปให้อัตโนมัติ)</span></p>
                    <input type="file" id="hrCamInput" accept="image/*" capture="environment" class="hidden" onchange="window.hrPickPhoto(event)">
                    <input type="file" id="hrGalInput" accept="image/*" class="hidden" onchange="window.hrPickPhoto(event)">
                    <div id="hrPhotoBox" class="mt-1.5"></div></div>`;
            const head = `<div class="flex items-center gap-2 mb-3"><i class="fas ${kind === 'zone' ? 'fa-broom' : 'fa-clipboard-list'} text-indigo-500"></i><h3 class="font-extrabold text-slate-800 text-base sm:text-lg">${kind === 'zone' ? 'บันทึกเขตพื้นที่รับผิดชอบ' : 'บันทึกกิจกรรมโฮมรูม'}</h3><span class="ml-auto text-[10px] sm:text-xs font-extrabold text-rose-600 bg-rose-50 px-2 py-0.5 rounded-full">ต้องกรอก</span></div>
                <div id="hrExistingNote" class="mb-3 text-xs sm:text-sm text-slate-500 font-semibold"><i class="fas fa-circle-notch fa-spin"></i> กำลังโหลดบันทึกเดิม…</div>`;
            if (kind === 'zone') {
                const chip = (t) => `<button type="button" onclick="document.getElementById('hrZoneCond').value='${t}'" class="h-9 px-3.5 rounded-full border-2 border-slate-200 bg-white text-slate-600 text-xs sm:text-sm font-extrabold hover:border-indigo-300 hover:text-indigo-600">${t}</button>`;
                return `<div id="hrSection" data-kind="zone" class="w-full mb-4 bg-white border-2 border-indigo-200 rounded-2xl p-4 sm:p-5 text-left transition-shadow">${head}
                    <div class="space-y-3"><div><label class="${lab}">1. สภาพเขตพื้นที่ <span class="text-rose-500">*</span><input id="hrZoneCond" type="text" maxlength="200" placeholder="เช่น สะอาด เก็บขยะเรียบร้อย" class="${inp}"></label><div class="flex flex-wrap gap-1.5 mt-2">${chip('สะอาด')}${chip('พอใช้')}${chip('สกปรก')}</div></div>${photoBlock(2)}</div></div>`;
            }
            return `<div id="hrSection" data-kind="homeroom" class="w-full mb-4 bg-white border-2 border-indigo-200 rounded-2xl p-4 sm:p-5 text-left transition-shadow">${head}
                <p class="${lab} mb-1.5">1. วันนี้ได้จัดกิจกรรมไหม <span class="text-rose-500">*</span></p>
                <div class="grid grid-cols-2 gap-2 mb-3">
                    <button type="button" id="hrHeldYes" onclick="window.hrSetHeld(true)" class="h-11 rounded-xl border-2 border-slate-200 bg-white text-slate-700 font-extrabold text-sm sm:text-base transition-colors">จัดกิจกรรม</button>
                    <button type="button" id="hrHeldNo" onclick="window.hrSetHeld(false)" class="h-11 rounded-xl border-2 border-slate-200 bg-white text-slate-700 font-extrabold text-sm sm:text-base transition-colors">ไม่ได้จัด</button>
                </div>
                <div id="hrYesBox" class="hidden space-y-3">
                    <label class="${lab}">2. กิจกรรมที่จัด <span class="text-rose-500">*</span><input id="hrActivity" type="text" maxlength="150" placeholder="พิมพ์ชื่อกิจกรรม" class="${inp}"></label>
                    <label class="${lab}">3. บันทึกเพิ่มเติม (สั้นๆ)<textarea id="hrNote" rows="2" maxlength="500" placeholder="เช่น พูดคุยเรื่องการเตรียมสอบ นักเรียนสนใจดี" class="mt-1 w-full px-3 py-2 rounded-xl border-2 border-slate-200 focus:border-indigo-400 outline-none text-sm sm:text-base font-semibold text-slate-700 resize-none bg-white"></textarea></label>
                    ${photoBlock(4)}
                </div>
                <div id="hrNoBox" class="hidden"><label class="${lab}">2. เหตุผลที่ไม่ได้จัด <span class="text-rose-500">*</span><input id="hrReason" type="text" maxlength="150" placeholder="เช่น ติดกิจกรรมของโรงเรียน" class="${inp}"></label></div>
            </div>`;
        }
        window.hrSetHeld = function(v) {
            window.__hrHeld = v;
            const y = document.getElementById('hrHeldYes'), n = document.getElementById('hrHeldNo'); if (!y || !n) return;
            const on = 'h-11 rounded-xl border-2 border-indigo-500 bg-indigo-50 text-indigo-700 font-extrabold text-sm sm:text-base transition-colors';
            const off = 'h-11 rounded-xl border-2 border-slate-200 bg-white text-slate-700 font-extrabold text-sm sm:text-base transition-colors';
            y.className = v === true ? on : off; n.className = v === false ? on : off;
            document.getElementById('hrYesBox').classList.toggle('hidden', v !== true);
            document.getElementById('hrNoBox').classList.toggle('hidden', v !== false);
        };
        function hrRenderPhoto() {
            const box = document.getElementById('hrPhotoBox'); if (!box) return;
            const p = window.__hrNewPhoto; const prev = window.__hrExisting; const oldCount = prev && Array.isArray(prev.photos) ? prev.photos.length : 0;
            const btn2 = (cls) => `<div class="grid grid-cols-2 gap-2 ${cls || ''}"><button type="button" onclick="document.getElementById('hrCamInput').click()" class="min-h-[64px] rounded-xl border-2 border-indigo-500 bg-indigo-50 text-indigo-700 font-extrabold text-sm flex flex-col items-center justify-center gap-1"><i class="fas fa-camera text-lg"></i>${oldCount ? 'ถ่ายรูปใหม่' : 'ถ่ายรูปเลย'}</button><button type="button" onclick="document.getElementById('hrGalInput').click()" class="min-h-[64px] rounded-xl border-2 border-slate-200 bg-white text-slate-700 font-extrabold text-sm flex flex-col items-center justify-center gap-1"><i class="fas fa-images text-lg"></i>เลือกจากคลังรูป</button></div>`;
            if (p) {
                const kb = Math.round(String(p.dataUrl).length * 0.75 / 1024);
                box.innerHTML = `<div class="relative rounded-xl overflow-hidden bg-slate-100"><img src="${p.dataUrl}" alt="รูปที่เลือก" class="w-full max-h-64 object-cover"><span class="absolute left-2 bottom-2 bg-slate-900/75 text-white text-[11px] font-bold px-2 py-0.5 rounded-full">ย่อแล้ว ${kb} KB</span></div>
                    <div class="grid grid-cols-3 gap-2 mt-2"><button type="button" onclick="document.getElementById('hrCamInput').click()" class="h-10 rounded-xl border-2 border-slate-200 bg-white text-slate-700 font-extrabold text-xs sm:text-sm">ถ่ายใหม่</button><button type="button" onclick="document.getElementById('hrGalInput').click()" class="h-10 rounded-xl border-2 border-slate-200 bg-white text-slate-700 font-extrabold text-xs sm:text-sm">เลือกรูปอื่น</button><button type="button" onclick="window.hrRemovePhoto()" class="h-10 rounded-xl border-2 border-rose-200 bg-rose-50 text-rose-600 font-extrabold text-xs sm:text-sm">ลบรูป</button></div>${oldCount ? '<p class="text-[11px] sm:text-xs text-amber-700 font-semibold mt-1.5">รูปใหม่จะแทนที่รูปเดิมเมื่อกดบันทึก</p>' : ''}`;
            } else if (oldCount) {
                box.innerHTML = `<div class="flex items-center gap-3 bg-emerald-50 border-2 border-emerald-200 rounded-xl px-3 py-2.5 mb-2"><i class="fas fa-check-circle text-emerald-600 text-xl"></i><div class="flex-1 text-xs sm:text-sm font-bold text-emerald-800">ส่งรูปไว้แล้ว${isAdmin ? ` · <button type="button" onclick="window.hrViewOldPhotos()" class="underline">ดูรูป</button>` : ''}<br><span class="font-semibold text-emerald-700">ไม่ต้องส่งใหม่ ถ้าไม่ต้องการเปลี่ยนรูป</span></div></div>${btn2()}`;
            } else box.innerHTML = btn2();
        }
        window.hrPickPhoto = async function(e) {
            const f = (e.target && e.target.files && e.target.files[0]) || null; e.target.value = '';
            if (!f || !(f.type || '').startsWith('image/')) { if (f) showToast('กรุณาเลือกไฟล์รูปภาพ', 'error'); return; }
            try { window.__hrNewPhoto = { dataUrl: await hrResizeImage(f), uploaded: null }; hrRenderPhoto(); }
            catch (err) { showToast('ไม่สามารถอ่านไฟล์รูปนี้ได้', 'error'); }
        };
        window.hrRemovePhoto = function() { window.__hrNewPhoto = null; hrRenderPhoto(); };
        window.hrViewOldPhotos = async function() {
            const prev = window.__hrExisting; if (!isAdmin || !prev || !Array.isArray(prev.photos)) return;
            const box = document.getElementById('hrPhotoBox'); if (!box) return;
            let v = document.getElementById('hrOldPhotoView');
            if (!v) { v = document.createElement('div'); v.id = 'hrOldPhotoView'; v.className = 'grid grid-cols-3 gap-2 mt-2'; box.appendChild(v); }
            v.innerHTML = prev.photos.map(() => `<div class="aspect-square rounded-xl bg-slate-100 flex items-center justify-center text-slate-400"><i class="fas fa-circle-notch fa-spin"></i></div>`).join('');
            const urls = await Promise.all(prev.photos.map(p => hrGetPhoto(p.id)));
            v.innerHTML = urls.map((u, i) => u ? `<a href="${u}" target="_blank" rel="noopener" class="block aspect-square rounded-xl overflow-hidden bg-slate-100"><img src="${u}" alt="รูปเดิม ${i + 1}" class="w-full h-full object-cover"></a>` : `<div class="aspect-square rounded-xl bg-rose-50 text-rose-500 text-[11px] font-bold flex items-center justify-center text-center p-1">โหลดรูปไม่สำเร็จ</div>`).join('');
        };
        async function hrInitSection(subject, date, kind) {
            window.__recKind = kind; window.__hrHeld = null; window.__hrNewPhoto = null; window.__hrExisting = null;
            hrRenderPhoto();
            const logs = await hrLoadLogs(subject.term, subject.year, recStoreRoomId(kind, subject.roomId), true);
            const note = document.getElementById('hrExistingNote'); if (!note || currentSubjectId !== subject.id) return;
            if (logs === null) { note.innerHTML = '<i class="fas fa-exclamation-triangle text-amber-500"></i> โหลดบันทึกเดิมไม่สำเร็จ (ยังบันทึกใหม่ได้ตามปกติ)'; return; }
            const rec = logs.find(l => l.date === date);
            if (!rec) { note.classList.add('hidden'); return; }
            window.__hrExisting = rec;
            note.className = 'mb-3 bg-emerald-50 border border-emerald-200 rounded-xl px-3 py-2 text-xs sm:text-sm font-semibold text-emerald-800';
            note.innerHTML = `<i class="fas fa-check-circle"></i> บันทึกไว้แล้ว${rec.recordedBy ? ' โดย ' + hrEsc(rec.recordedBy) : ''}${rec.editCount ? ` · แก้ไขแล้ว ${rec.editCount} ครั้ง` : ''}<br><span class="text-emerald-700">แก้ไขได้ แล้วกดบันทึกเพื่อส่งใหม่แทนที่ของเดิม</span>`;
            if (kind === 'zone') { const c = document.getElementById('hrZoneCond'); if (c) c.value = rec.condition || ''; }
            else {
                window.hrSetHeld(rec.held === true ? true : (rec.held === false ? false : null));
                const a = document.getElementById('hrActivity'); if (a) a.value = rec.activity || '';
                const n = document.getElementById('hrNote'); if (n) n.value = rec.note || '';
                const r = document.getElementById('hrReason'); if (r) r.value = rec.reason || '';
            }
            hrRenderPhoto();
        }
        function hrHasPhoto() { const prev = window.__hrExisting; return !!window.__hrNewPhoto || !!(prev && Array.isArray(prev.photos) && prev.photos.length); }
        function hrValidate() {
            const kind = window.__recKind;
            if (kind === 'zone') {
                if (!(document.getElementById('hrZoneCond').value || '').trim()) return 'กรุณาระบุสภาพเขตพื้นที่';
                if (!hrHasPhoto()) return 'กรุณาแนบรูปรายงานเขตพื้นที่ 1 รูปก่อนบันทึก';
                return null;
            }
            if (window.__hrHeld !== true && window.__hrHeld !== false) return 'กรุณาเลือกว่า "จัดกิจกรรม" หรือ "ไม่ได้จัด"';
            if (window.__hrHeld === true && !(document.getElementById('hrActivity').value || '').trim()) return 'กรุณาพิมพ์ชื่อกิจกรรมโฮมรูมที่จัด';
            if (window.__hrHeld === true && !hrHasPhoto()) return 'กรุณาแนบรูปกิจกรรม 1 รูปก่อนบันทึก';
            if (window.__hrHeld === false && !(document.getElementById('hrReason').value || '').trim()) return 'กรุณาพิมพ์เหตุผลที่ไม่ได้จัดกิจกรรมโฮมรูม';
            return null;
        }
        // หลอดแสดงการส่งรูปใต้ปุ่มบันทึก (มีสายฟ้าเล็กเมื่อส่งตรงเข้า Drive)
        function hrBar(pct, route, done) {
            const btn = document.getElementById('saveAttBtn'); if (!btn) return;
            let bar = document.getElementById('hrUploadBar');
            if (!bar) { bar = document.createElement('div'); bar.id = 'hrUploadBar'; bar.className = 'w-full max-w-md mx-auto mt-2 px-2 __t-rise'; btn.insertAdjacentElement('afterend', bar); }
            const bolt = route === 'direct' ? `<svg class="__bolt" width="14" height="14" viewBox="0 0 24 24" fill="#eab308" stroke="#a16207" stroke-width="1.2" stroke-linejoin="round" role="img" aria-label="ส่งตรงเข้า Drive"><path d="M13.5 2L4 13.5h6.5L9.5 22 20 9.5h-6.5L13.5 2z"></path></svg>` : '';
            const label = done ? (route === 'direct' ? 'ส่งรูปแล้ว (ส่งตรงเข้า Drive)' : 'ส่งรูปแล้ว (ผ่าน Relay)') : (route === 'direct' ? 'กำลังส่งตรงเข้า Drive' : 'กำลังส่งผ่าน Relay');
            bar.innerHTML = `<div class="flex items-center gap-1.5 text-[11px] sm:text-xs font-bold text-slate-500 mb-1"><span>${label}</span>${bolt}<span class="ml-auto">${pct}%</span></div><div class="h-1.5 bg-slate-200 rounded-full overflow-hidden"><div class="h-full rounded-full transition-all duration-500 ${done ? 'bg-emerald-500' : 'bg-indigo-500'}" style="width:${pct}%"></div></div>`;
        }
        // ส่งบันทึก (และรูป) หลังบันทึกเช็คชื่อสำเร็จ คืนค่า true/false
        async function hrSubmit(subject, date, onProgress) {
            const kind = window.__recKind || 'homeroom';
            const prev = window.__hrExisting;
            const needPhoto = kind === 'zone' || window.__hrHeld === true;
            let photos = needPhoto && prev && Array.isArray(prev.photos) ? prev.photos : [];
            let toTrash = (!needPhoto && prev && Array.isArray(prev.photos)) ? prev.photos.map(p => p.id) : [];
            const np = window.__hrNewPhoto;
            if (needPhoto && np) {
                if (!np.uploaded) {
                    if (onProgress) onProgress('กำลังส่งรูป…');
                    const res = await hrUploadPhoto(np.dataUrl, `${date}_${formatRoomName(subject.roomId).replace(/\//g, '-')}${kind === 'zone' ? '_เขต' : ''}.jpg`, hrFolderPath(subject.term, subject.year, subject.roomId, kind), (pct, route) => hrBar(pct, route, false));
                    if (!res) return false;
                    np.uploaded = res; hrBar(100, res.route, true);
                }
                toTrash = prev && Array.isArray(prev.photos) ? prev.photos.map(p => p.id) : [];
                photos = [{ id: np.uploaded.id, name: 'รูปที่ 1' }];
            }
            if (onProgress) onProgress(kind === 'zone' ? 'กำลังบันทึกเขตพื้นที่…' : 'กำลังบันทึกกิจกรรม…');
            const base = { roomId: subject.roomId, date, term: String(subject.term), year: String(subject.year), subjectId: subject.id, kind,
                photos, recordedBy: (currentUser && currentUser.name) || (getRoomAdvisors(subject.roomId)[0] || ''),
                recordedAt: new Date().toISOString(), editCount: prev ? (prev.editCount || 0) + 1 : 0 };
            const rec = kind === 'zone' ? Object.assign(base, { condition: document.getElementById('hrZoneCond').value.trim() })
                : Object.assign(base, { held: window.__hrHeld === true, activity: window.__hrHeld === true ? document.getElementById('hrActivity').value.trim() : '',
                    note: window.__hrHeld === true ? document.getElementById('hrNote').value.trim() : '', reason: window.__hrHeld === true ? '' : document.getElementById('hrReason').value.trim() });
            const storeId = recStoreRoomId(kind, subject.roomId);
            const j = await hrFetchJson(GOOGLE_APP_SCRIPT_URL, { __mode: 'upsert_homeroom_log', record: rec, term: rec.term, year: rec.year, roomId: storeId }, 30000);
            if (!j || j.status !== 'success') return false;
            const key = hrRoomKey(rec.term, rec.year, storeId);
            const list = (window.__hrLogsCache[key] || []).filter(l => l.date !== date); list.push(rec); window.__hrLogsCache[key] = list;
            window.__hrExisting = rec; window.__hrNewPhoto = null;
            if (toTrash.length) hrTrashPhotos(toTrash.filter(id => !photos.some(p => p.id === id)));
            return true;
        }

        // ===== [v1.72] เชื่อมกับ BNKAcademicHub ขั้น 1: ดึงรายชื่อครูมาผูกกับครูในเว็บเช็คชื่อ (teachers[].hubId) =====
        // ผูกแล้วชื่อในเว็บเช็คชื่อไม่เปลี่ยน (วิชา/ครูที่ปรึกษาอ้างชื่อเดิมได้ต่อ) · ครูใหม่จาก AcademicHub เพิ่มได้ · กลุ่มสาระปรับตาม AcademicHub ได้
        const HUB_LINK_BADGE = '<i class="fas fa-link text-violet-500 text-[9px] sm:text-[10px] ml-1" title="เชื่อมกับ AcademicHub แล้ว" aria-label="เชื่อมกับ AcademicHub แล้ว"></i>';
        const NAME_PREFIXES = ['ว่าที่ร้อยตรีหญิง', 'ว่าที่ร้อยตรี', 'ว่าที่ร.ต.หญิง', 'ว่าที่ร.ต.', 'นางสาว', 'น.ส.', 'นาย', 'นาง', 'ดร.'];
        function normTeacherName(n) {
            let x = String(n || '').replace(/\s+/g, '');
            for (let guard = 0; guard < 3; guard++) { const pre = NAME_PREFIXES.find(pf => x.indexOf(pf) === 0); if (!pre) break; x = x.slice(pre.length); }
            return x;
        }
        // [v1.72.1] ขั้น 2: ดึงวันหยุดเรียนจาก AcademicHub ทันที (ปกติ Worker ดึงให้เองทุกประมาณ 6 ชั่วโมง)
        window.syncHubHolidays = async function() {
            if (!isAdmin) return;
            showLoadingSpinnerModal('กำลังดึงวันหยุดเรียนจาก AcademicHub', 'กรุณารอสักครู่...');
            let j = null;
            try { const res = await fetch(`${GOOGLE_APP_SCRIPT_URL}?action=hub_holidays_sync`); j = await res.json(); } catch (e) { j = null; }
            window.closeProgressModal();
            if (!j || j.status !== 'success') { showConfirm('ดึงวันหยุดไม่สำเร็จ', (j && j.message) || 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่', () => {}); return; }
            hubHolidays = j.holidays || []; if (Array.isArray(j.periods)) hubPeriods = j.periods; updateHolidayBar();
            logAction('ดึงวันหยุดเรียนจาก AcademicHub', `${hubHolidays.length} วัน`, 'settings');
            showToast(`ดึงแล้ว: วันหยุดเรียนจาก AcademicHub ${hubHolidays.length} วัน · กิจกรรม/หยุดเรียนรายคาบ ${hubPeriods.length} รายการ`, 'success'); renderAdminTab();
        };
        window.openHubTeacherSync = async function() {
            if (!isAdmin) return;
            showLoadingSpinnerModal('กำลังดึงรายชื่อจาก AcademicHub', 'กรุณารอสักครู่...');
            let j = null;
            try { const res = await fetch(`${GOOGLE_APP_SCRIPT_URL}?action=hub_teachers`); j = await res.json(); } catch (e) { j = null; }
            window.closeProgressModal();
            if (!j || j.status !== 'success') { showConfirm('เชื่อม AcademicHub ไม่สำเร็จ', (j && j.message) || 'เชื่อมต่อเซิร์ฟเวอร์ไม่ได้ กรุณาลองใหม่', () => {}); return; }
            const hub = (j.teachers || []).filter(h => h && h.id && h.name);
            const hubById = {}; hub.forEach(h => { hubById[h.id] = h; });
            const usedHub = new Set(teachers.filter(t => t.hubId && hubById[t.hubId]).map(t => t.hubId));
            const rows = teachers.slice().sort((a, b) => a.name.localeCompare(b.name)).map(t => {
                if (t.hubId && hubById[t.hubId]) return { t, kind: 'linked', hub: hubById[t.hubId] };
                const cands = hub.filter(h => !usedHub.has(h.id) && normTeacherName(h.name) === normTeacherName(t.name));
                if (cands.length === 1) { usedHub.add(cands[0].id); return { t, kind: 'match', hub: cands[0], wasLinked: !!t.hubId }; }
                return { t, kind: 'none', hub: null, wasLinked: !!t.hubId };
            });
            const fresh = hub.filter(h => !usedHub.has(h.id));
            window.__hubSync = { hub, hubById, rows, fresh };
            const esc = hrEsc;
            const grp = (h) => h && h.subjectGroup ? `<span class="text-[10px] font-bold text-slate-500">${esc(h.subjectGroup)}</span>` : '';
            const optList = (sel) => `<option value="">— ไม่ผูก —</option>` + fresh.concat(rows.filter(r => r.kind === 'match').map(r => r.hub)).sort((a, b) => a.name.localeCompare(b.name)).map(h => `<option value="${esc(h.id)}" ${sel === h.id ? 'selected' : ''}>${esc(h.name)}${h.subjectGroup ? ' · ' + esc(h.subjectGroup) : ''}</option>`).join('');
            const nLinked = rows.filter(r => r.kind === 'linked').length, nMatch = rows.filter(r => r.kind === 'match').length, nNone = rows.filter(r => r.kind === 'none').length;
            const sec = (icon, color, title, n, body) => n ? `<div class="mb-4"><h5 class="font-extrabold text-sm ${color} mb-2 flex items-center gap-1.5"><i class="fas ${icon}"></i> ${title} <span class="text-slate-400 font-semibold">(${n})</span></h5>${body}</div>` : '';
            const matchRows = rows.filter(r => r.kind === 'match').map(r => `<label class="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs sm:text-sm"><input type="checkbox" data-hs-match="${esc(r.t.id)}" checked class="w-4 h-4"><span class="flex-1 min-w-0"><b>${esc(r.t.name)}</b>${r.t.name !== r.hub.name ? ` <span class="text-slate-500">↔ ${esc(r.hub.name)}</span>` : ''}</span>${grp(r.hub)}</label>`).join('');
            const noneRows = rows.filter(r => r.kind === 'none').map(r => `<div class="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs sm:text-sm"><span class="flex-1 min-w-0 font-bold">${esc(r.t.name)}${r.t.inactive ? ' <span class="text-slate-400 font-semibold">(ย้ายออก)</span>' : ''}${r.wasLinked ? ' <span class="text-rose-600 font-semibold">(บัญชีที่เคยผูกไม่มีใน AcademicHub แล้ว)</span>' : ''}</span><select data-hs-pick="${esc(r.t.id)}" class="sm:w-64 bg-white border border-amber-300 rounded px-2 py-1.5 text-base sm:text-xs font-bold">${optList('')}</select></div>`).join('');
            const freshRows = fresh.map(h => `<label class="flex items-center gap-2 bg-sky-50 border border-sky-200 rounded-lg px-3 py-2 text-xs sm:text-sm"><input type="checkbox" data-hs-new="${esc(h.id)}" ${h.executive || h.staff ? '' : 'checked'} class="w-4 h-4"><span class="flex-1 min-w-0 font-bold">${esc(h.name)}${h.executive ? ' <span class="text-slate-500 font-semibold">(ผู้บริหาร)</span>' : (h.staff ? ' <span class="text-slate-500 font-semibold">(เจ้าหน้าที่)</span>' : '')}</span>${grp(h)}</label>`).join('');
            // [v1.73] แก้คู่ / ยกเลิกการผูกทีละคน
            const linkedOpts = (cur) => `<option value="${esc(cur.id)}" selected>${esc(cur.name)}${cur.subjectGroup ? ' · ' + esc(cur.subjectGroup) : ''}</option><option value="__unlink">— ยกเลิกการผูก —</option>` + fresh.slice().sort((a, b) => a.name.localeCompare(b.name)).map(h => `<option value="${esc(h.id)}">เปลี่ยนเป็น: ${esc(h.name)}${h.subjectGroup ? ' · ' + esc(h.subjectGroup) : ''}</option>`).join('');
            const linkedRows = rows.filter(r => r.kind === 'linked').map(r => `<div class="flex flex-col sm:flex-row sm:items-center gap-1.5 sm:gap-2 bg-slate-50 border border-slate-200 rounded-lg px-3 py-1.5 text-xs sm:text-sm"><span class="flex-1 min-w-0 font-bold"><i class="fas fa-link text-violet-500"></i> ${esc(r.t.name)}</span><select data-hs-linked="${esc(r.t.id)}" class="sm:w-64 bg-white border border-slate-300 rounded px-2 py-1.5 text-base sm:text-xs font-bold">${linkedOpts(r.hub)}</select></div>`).join('');
            const ov = document.createElement('div'); ov.id = 'hubSyncModal';
            ov.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-3';
            ov.innerHTML = `<div class="bg-white rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-2xl max-h-[90vh] flex flex-col"><div class="flex items-center justify-between gap-2 p-4 sm:p-5 border-b"><div><h4 class="font-extrabold text-lg text-slate-800"><i class="fas fa-link text-violet-600"></i> ผูกรายชื่อครูกับ AcademicHub</h4><p class="text-xs text-slate-500 font-semibold">AcademicHub ${hub.length} คน · เว็บเช็คชื่อ ${teachers.length} คน · ชื่อในเว็บเช็คชื่อไม่เปลี่ยน</p></div><button type="button" onclick="document.getElementById('hubSyncModal').remove()" class="w-9 h-9 rounded-full bg-rose-50 text-rose-600 hover:bg-rose-100 text-lg shrink-0" aria-label="ปิด"><i class="fas fa-times"></i></button></div>
                <div class="p-4 sm:p-5 overflow-y-auto">
                ${sec('fa-check-circle', 'text-emerald-700', 'ชื่อตรงกัน — ผูกให้ (ไม่สนคำนำหน้าและช่องว่าง)', nMatch, `<div class="space-y-1.5">${matchRows}</div>`)}
                ${sec('fa-question-circle', 'text-amber-700', 'หาชื่อไม่เจอ — เลือกเองได้', nNone, `<div class="space-y-1.5">${noneRows}</div>`)}
                ${sec('fa-user-plus', 'text-sky-700', 'มีใน AcademicHub แต่ยังไม่มีในเว็บเช็คชื่อ — เพิ่มเข้ามา', fresh.length, `<div class="space-y-1.5">${freshRows}</div>`)}
                ${sec('fa-link', 'text-violet-700', 'ผูกไว้แล้ว', nLinked, `<details><summary class="text-xs font-bold text-slate-500 cursor-pointer mb-1.5">ดูรายชื่อ / แก้คู่ / ยกเลิกการผูก</summary><div class="space-y-1">${linkedRows}</div></details>`)}
                <label class="flex items-start gap-2 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2 text-xs sm:text-sm font-semibold text-violet-800"><input type="checkbox" id="hsDept" checked class="w-4 h-4 mt-0.5"> ปรับกลุ่มสาระฯ ของครูที่ผูกแล้วให้ตรงกับ AcademicHub (เฉพาะคนที่ AcademicHub ระบุกลุ่มสาระไว้)</label>
                </div>
                <div class="flex justify-end gap-2 p-4 border-t"><button type="button" onclick="document.getElementById('hubSyncModal').remove()" class="bg-slate-100 hover:bg-slate-200 px-4 py-2 rounded-lg font-bold text-sm">ยกเลิก</button><button type="button" onclick="window.applyHubTeacherSync()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-4 py-2 rounded-lg font-bold text-sm shadow-sm"><i class="fas fa-check"></i> บันทึกการผูก</button></div></div>`;
            document.body.appendChild(ov);
        };
        window.applyHubTeacherSync = async function() {
            const st = window.__hubSync; if (!st) return;
            const q = (sel) => Array.prototype.slice.call(document.querySelectorAll(sel));
            const link = {}; // teacherId -> hubId
            q('[data-hs-match]').forEach(cb => { const r = st.rows.find(x => x.t.id === cb.getAttribute('data-hs-match')); if (cb.checked && r) link[r.t.id] = r.hub.id; });
            const unlink = {};
            q('[data-hs-linked]').forEach(sel => { const tid = sel.getAttribute('data-hs-linked'); if (sel.value === '__unlink') unlink[tid] = true; else if (sel.value) link[tid] = sel.value; });
            const picked = {};
            q('[data-hs-pick]').forEach(sel => { if (sel.value) { if (picked[sel.value]) { picked.__dup = true; } picked[sel.value] = true; link[sel.getAttribute('data-hs-pick')] = sel.value; } });
            const used = {}; let dup = !!picked.__dup;
            Object.keys(link).forEach(tid => { if (used[link[tid]]) dup = true; used[link[tid]] = true; });
            if (dup) { showToast('บัญชี AcademicHub 1 บัญชีผูกกับครูได้คนเดียว กรุณาตรวจสอบรายการที่เลือกซ้ำ', 'error'); return; }
            const addIds = q('[data-hs-new]').filter(cb => cb.checked && !used[cb.getAttribute('data-hs-new')]).map(cb => cb.getAttribute('data-hs-new'));
            const fixDept = document.getElementById('hsDept').checked;
            let nLink = 0, nAdd = 0, nDept = 0, nUnlink = 0;
            teachers.forEach(t => {
                if (unlink[t.id]) { if (t.hubId) { delete t.hubId; nUnlink++; } return; }
                if (link[t.id]) { if (t.hubId !== link[t.id]) nLink++; t.hubId = link[t.id]; }
                else if (t.hubId && !st.hubById[t.hubId]) { delete t.hubId; nUnlink++; } // บัญชีปลายทางไม่มีแล้ว
                const h = t.hubId && st.hubById[t.hubId];
                if (fixDept && h && h.subjectGroup && departmentsList.includes(h.subjectGroup) && t.department !== h.subjectGroup) { t.department = h.subjectGroup; nDept++; }
            });
            addIds.forEach(id => { const h = st.hubById[id]; if (!h) return;
                let name = h.name; if (teachers.some(t => t.name === name)) name = name + ' (AcademicHub)';
                teachers.push({ id: generateId(), name, department: departmentsList.includes(h.subjectGroup) ? h.subjectGroup : 'ระบบ/อื่นๆ', hubId: h.id }); nAdd++; });
            if (!nLink && !nAdd && !nDept && !nUnlink) { document.getElementById('hubSyncModal').remove(); showToast('ไม่มีอะไรเปลี่ยนแปลง', 'info'); return; }
            logAction('ผูกรายชื่อครูกับ AcademicHub', `ผูกใหม่ ${nLink} · เพิ่มครู ${nAdd} · ปรับกลุ่มสาระ ${nDept}${nUnlink ? ' · ยกเลิกการผูก ' + nUnlink : ''}`, 'data');
            const ok = await saveData('full');
            document.getElementById('hubSyncModal').remove();
            if (ok) showToast(`บันทึกแล้ว: ผูกใหม่ ${nLink} คน · เพิ่มครู ${nAdd} คน · ปรับกลุ่มสาระ ${nDept} คน`, 'success');
            window.__hubSync = null; renderAdminTab();
        };

        // ===== [v1.71.6] รูปการสอนแทน (เปิด/ปิดได้: settings.recordSubstitute ค่าเริ่มต้นปิด) =====
        // ติ๊ก "มีการสอนแทน" แล้วต้องแนบรูป 1 รูป · เก็บใน Drive โฟลเดอร์ สอนแทน/ปีการศึกษา/ภาคเรียน/ห้อง · ข้อมูลรูปอยู่ในรายการเช็คชื่อ (subPhoto)
        function subPhotoSectionHtml() {
            return `<div id="subPhotoWrap" class="hidden w-full bg-amber-50 border border-amber-200 rounded-xl p-2.5 sm:p-3 text-left transition-shadow"><p class="text-[11px] sm:text-xs font-extrabold text-amber-800 mb-1.5"><i class="fas fa-camera"></i> รูปการสอนแทน <span class="text-rose-500">* 1 รูป</span> <span class="font-semibold text-amber-700">(ระบบย่อรูปให้อัตโนมัติ)</span></p>
                <input type="file" id="subCamInput" accept="image/*" capture="environment" class="hidden" onchange="window.subPickPhoto(event)">
                <input type="file" id="subGalInput" accept="image/*" class="hidden" onchange="window.subPickPhoto(event)">
                <div id="subPhotoBox"></div></div>`;
        }
        // ===== [v2.02.3] ครูเจ้าของวิชามอบหมายงานไว้หรือไม่ — บังคับเลือกทุกครั้งที่สอนแทน (ไม่เกี่ยวกับรูป) · เก็บใน record.subAssign = 'yes' / 'no' =====
        function subAssignSectionHtml() {
            const b = (v, ic, t) => `<button type="button" role="radio" data-sub-asg="${v}" onclick="window.subAssignPick('${v}')" class="min-h-[54px] rounded-xl border-2 font-extrabold text-xs sm:text-sm flex flex-col items-center justify-center gap-0.5 px-1 text-center transition-colors"><i class="fas ${ic} text-base"></i>${t}</button>`;
            return `<div id="subAssignWrap" class="hidden w-full border-2 rounded-xl p-2.5 sm:p-3 text-left transition-colors"><p id="subAssignHead" class="text-[11px] sm:text-xs font-extrabold mb-1.5"><i class="fas fa-clipboard-list"></i> ครูเจ้าของวิชามอบหมายงานไว้ไหม <span class="text-rose-500">* เลือก 1 ข้อ</span></p><div role="radiogroup" aria-label="ครูเจ้าของวิชามอบหมายงานไว้ไหม" class="grid grid-cols-2 gap-2">${b('yes', 'fa-clipboard-check', 'มอบหมายงานไว้')}${b('no', 'fa-circle-xmark', 'ไม่ได้มอบหมายงาน')}</div><p id="subAssignHint" class="hidden text-[11px] sm:text-xs font-bold text-rose-600 mt-1.5"><i class="fas fa-exclamation-triangle"></i> กรุณาเลือกก่อนบันทึก</p></div>`;
        }
        function subAssignPaint(need) {
            const w = document.getElementById('subAssignWrap'); if (!w) return;
            const v = window.__subAssign || '';
            w.className = 'w-full border-2 rounded-xl p-2.5 sm:p-3 text-left transition-colors ' + (need ? 'border-rose-300 bg-rose-50' : 'border-indigo-200 bg-indigo-50') + (document.getElementById('isSubstitute') && document.getElementById('isSubstitute').checked ? '' : ' hidden');
            const hd = document.getElementById('subAssignHead'); if (hd) hd.className = 'text-[11px] sm:text-xs font-extrabold mb-1.5 ' + (need ? 'text-rose-700' : 'text-indigo-800');
            const hn = document.getElementById('subAssignHint'); if (hn) hn.classList.toggle('hidden', !need);
            w.querySelectorAll('[data-sub-asg]').forEach(x => { const me = x.getAttribute('data-sub-asg') === v, y = x.getAttribute('data-sub-asg') === 'yes'; x.setAttribute('aria-checked', String(me));
                x.className = 'min-h-[54px] rounded-xl border-2 font-extrabold text-xs sm:text-sm flex flex-col items-center justify-center gap-0.5 px-1 text-center transition-colors ' + (me ? (y ? 'bg-emerald-600 border-emerald-600 text-white' : 'bg-rose-600 border-rose-600 text-white') : 'bg-white border-slate-200 text-slate-600 ' + (y ? '[&>i]:text-emerald-600' : '[&>i]:text-rose-600')); });
        }
        function subAssignSet(v) { window.__subAssign = v || ''; subAssignPaint(false); }
        window.subAssignPick = function(v) { window.__subAssign = v; subAssignPaint(false); };
        function subAssignLabel(a) { return a && a.subAssign === 'yes' ? 'มอบหมายงานไว้' : (a && a.subAssign === 'no' ? 'ไม่ได้มอบหมายงาน' : ''); }
        function subResetState(record) { window.__subNewPhoto = null; window.__subExisting = record && record.subPhoto ? record.subPhoto : null; const w = document.getElementById('subPhotoWrap'); if (w) w.classList.add('hidden'); subRenderPhoto(); }
        function subHasPhoto() { return !!window.__subNewPhoto || !!window.__subExisting; }
        // [v1.76] ปุ่มเลือก 2 ทาง (ครูประจำวิชาสอน / มีการสอนแทน) — ใช้ช่อง #isSubstitute (ซ่อน) เก็บค่าเหมือนเดิม
        function subSegPaint(on) {
            document.querySelectorAll('#subSeg [data-sub-seg]').forEach(b => {
                const me = (b.getAttribute('data-sub-seg') === '1') === !!on;
                b.setAttribute('aria-checked', String(me));
                b.className = 'flex-1 rounded-xl py-3 px-1 font-extrabold text-sm sm:text-base flex items-center justify-center gap-1.5 transition-colors ' + (me ? (on ? 'bg-amber-500 text-white shadow-md' : 'bg-white text-indigo-700 shadow-sm') : 'text-slate-500 hover:bg-white/60');
            });
        }
        window.subSetMode = function(on) { const cb = document.getElementById('isSubstitute'); if (!cb) return; cb.checked = !!on; if (!on) { const sel = document.getElementById('substituteTeacher'); if (sel) sel.value = ''; } window.subOnToggle(!!on); };
        window.subOnToggle = function(on) {
            subSegPaint(on);
            document.getElementById('substituteTeacher').classList.toggle('hidden', !on);
            const w = document.getElementById('subPhotoWrap'); if (w) { w.classList.toggle('hidden', !on); subRenderPhoto(); }
            if (!on) window.__subAssign = ''; subAssignPaint(false); // [v2.02.3]
        };
        function subRenderPhoto() {
            const box = document.getElementById('subPhotoBox'); if (!box) return;
            const p = window.__subNewPhoto, old = window.__subExisting;
            const btns = (t1) => `<div class="grid grid-cols-2 gap-2"><button type="button" onclick="document.getElementById('subCamInput').click()" class="min-h-[52px] rounded-xl border-2 border-amber-500 bg-white text-amber-700 font-extrabold text-xs sm:text-sm flex flex-col items-center justify-center gap-0.5"><i class="fas fa-camera"></i>${t1}</button><button type="button" onclick="document.getElementById('subGalInput').click()" class="min-h-[52px] rounded-xl border-2 border-slate-200 bg-white text-slate-700 font-extrabold text-xs sm:text-sm flex flex-col items-center justify-center gap-0.5"><i class="fas fa-images"></i>เลือกจากคลังรูป</button></div>`;
            if (p) {
                const kb = Math.round(String(p.dataUrl).length * 0.75 / 1024);
                box.innerHTML = `<div class="relative rounded-xl overflow-hidden bg-slate-100"><img src="${p.dataUrl}" alt="รูปการสอนแทน" class="w-full max-h-44 object-cover"><span class="absolute left-2 bottom-2 bg-slate-900/75 text-white text-[11px] font-bold px-2 py-0.5 rounded-full">ย่อแล้ว ${kb} KB</span></div>
                    <div class="grid grid-cols-3 gap-2 mt-2"><button type="button" onclick="document.getElementById('subCamInput').click()" class="h-9 rounded-xl border-2 border-slate-200 bg-white text-slate-700 font-extrabold text-xs">ถ่ายใหม่</button><button type="button" onclick="document.getElementById('subGalInput').click()" class="h-9 rounded-xl border-2 border-slate-200 bg-white text-slate-700 font-extrabold text-xs">เลือกรูปอื่น</button><button type="button" onclick="window.subRemovePhoto()" class="h-9 rounded-xl border-2 border-rose-200 bg-rose-50 text-rose-600 font-extrabold text-xs">ลบรูป</button></div>${old ? '<p class="text-[11px] text-amber-700 font-semibold mt-1.5">รูปใหม่จะแทนที่รูปเดิมเมื่อกดบันทึก</p>' : ''}`;
            } else if (old) {
                box.innerHTML = `<div class="flex items-center gap-2 bg-emerald-50 border-2 border-emerald-200 rounded-xl px-3 py-2 mb-2"><i class="fas fa-check-circle text-emerald-600 text-lg"></i><div class="flex-1 text-xs font-bold text-emerald-800">ส่งรูปไว้แล้ว${isAdmin ? ` · <button type="button" onclick="window.subViewOldPhoto()" class="underline">ดูรูป</button>` : ''}<br><span class="font-semibold text-emerald-700">ไม่ต้องส่งใหม่ ถ้าไม่ต้องการเปลี่ยนรูป</span></div></div><div id="subOldView"></div>${btns('ถ่ายรูปใหม่')}`;
            } else box.innerHTML = btns('ถ่ายรูปเลย');
        }
        window.subPickPhoto = async function(e) {
            const f = (e.target && e.target.files && e.target.files[0]) || null; e.target.value = '';
            if (!f || !(f.type || '').startsWith('image/')) { if (f) showToast('กรุณาเลือกไฟล์รูปภาพ', 'error'); return; }
            try { window.__subNewPhoto = { dataUrl: await hrResizeImage(f), uploaded: null }; subRenderPhoto(); }
            catch (err) { showToast('ไม่สามารถอ่านไฟล์รูปนี้ได้', 'error'); }
        };
        window.subRemovePhoto = function() { window.__subNewPhoto = null; subRenderPhoto(); };
        window.subViewOldPhoto = async function() {
            const old = window.__subExisting, v = document.getElementById('subOldView'); if (!isAdmin || !old || !v) return;
            v.innerHTML = '<div class="h-32 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400 mb-2"><i class="fas fa-circle-notch fa-spin"></i></div>';
            const u = await hrGetPhoto(old.id);
            v.innerHTML = u ? `<a href="${u}" target="_blank" rel="noopener" class="block rounded-xl overflow-hidden bg-slate-100 mb-2"><img src="${u}" alt="รูปการสอนแทน" class="w-full max-h-44 object-cover"></a>` : '<div class="rounded-xl bg-rose-50 text-rose-500 text-xs font-bold p-2 mb-2 text-center">โหลดรูปไม่สำเร็จ</div>';
        };

        // ===== [v2.02.3] รายงานสอนแทน — หลังบ้าน › รายงาน (Super Admin) · เดือน + ห้องเดียว / ระดับชั้น / ทุกห้อง · ก. รวมตารางเดียว / ข. แยกหน้าตามห้อง
        //   ทำได้ทั้งเปิดหรือปิดรูปการสอนแทน (ปิด = ตารางอย่างเดียว) · คอลัมน์ "งานที่มอบหมาย" (record.subAssign) =====
        const SR_MON = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
        const SR_MS = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
        function srState() { if (!window.__sr) { const d = new Date(); window.__sr = { month: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, mode: 'all', grades: [], room: '', layout: 'merge', table: true, photos: true }; } return window.__sr; }
        function srMonthTxt(m) { const [y, mm] = String(m).split('-'); return `${SR_MON[parseInt(mm) - 1]} ${parseInt(y) + 543}`; }
        function srRoomsSel(term, year) { const w = srState(); if (w.mode === 'room') return w.room ? [w.room] : []; return wrRooms(term, year, w.mode === 'grades' ? w.grades : []); }
        function srRows(term, year, rooms, month) {
            const rset = new Set(rooms), subMap = {}; subjects.forEach(su => { if (String(su.term) === String(term) && String(su.year) === String(year) && rset.has(su.roomId)) subMap[su.id] = su; });
            return attendanceData.filter(a => a.substituteTeacher && subMap[a.subjectId] && String(a.date || '').startsWith(month)).map(a => {
                const sub = subMap[a.subjectId], c = { 'มา': 0, 'สาย': 0, 'ลา': 0, 'ขาด': 0 };
                Object.values(a.records || {}).forEach(st => { if (st === 'มา' || st === 'ร่วมกิจกรรม') c['มา']++; else if (st === 'สาย') c['สาย']++; else if (st === 'ลาป่วย' || st === 'ลากิจ') c['ลา']++; else c['ขาด']++; });
                return { a, sub, room: sub.roomId, c, owner: [sub.teacher, sub.teacher2].filter(Boolean).join(', ') || '-' };
            }).sort((x, y) => rooms.indexOf(x.room) - rooms.indexOf(y.room) || String(x.a.date).localeCompare(String(y.a.date)) || parseInt(x.a.period) - parseInt(y.a.period));
        }
        function srCount(rows) { const o = { n: rows.length, yes: 0, no: 0, none: 0, photo: 0 }; rows.forEach(r => { if (r.a.subAssign === 'yes') o.yes++; else if (r.a.subAssign === 'no') o.no++; else o.none++; if (r.a.subPhoto) o.photo++; }); return o; }
        function srTabHtml() {
            const w = srState(), term = adminTerm(), year = adminYear(), rooms = srRoomsSel(term, year), rows = srRows(term, year, rooms, w.month), K = srCount(rows);
            const photoOn = recFeatureOn('substitute'), grades = [1, 2, 3, 4, 5, 6].filter(g => (settings.roomCounts || {})['m' + g]), allRooms = wrRooms(term, year, []);
            const chip = (on, label, attr) => `<button type="button" onclick="${attr}" class="${on ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'} border-2 px-3 py-1 rounded-full text-xs sm:text-sm font-bold">${label}</button>`;
            const chk = (on, label, desc, key, dis) => `<label class="flex items-start gap-3 border-2 ${on && !dis ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white'} rounded-xl p-3 ${dis ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer'}"><input type="checkbox" ${on && !dis ? 'checked' : ''} ${dis ? 'disabled' : ''} onchange="window.srSet('${key}', this.checked)" class="mt-1 w-4 h-4 accent-indigo-600"><span><span class="block font-extrabold text-slate-800 text-sm">${label}</span><span class="block text-xs text-slate-500 font-semibold">${desc}</span></span></label>`;
            const lay = (v, t, d) => `<button type="button" onclick="window.srSet('layout', '${v}')" class="text-left border-2 ${w.layout === v ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white hover:bg-slate-50'} rounded-xl p-3"><span class="block font-extrabold text-slate-800 text-sm">${t}</span><span class="block text-xs text-slate-500 font-semibold mt-0.5">${d}</span></button>`;
            const multi = w.mode !== 'room', usePh = photoOn && w.photos, pages = srPlan(rows, rooms, w, usePh).length;
            let h = `<div class="flex flex-col lg:flex-row gap-4 sm:gap-6"><div class="lg:w-[420px] shrink-0"><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-1 flex items-center gap-2"><i class="fas fa-user-clock text-amber-500"></i> รายงานการสอนแทนรายเดือน</h3><p class="text-xs sm:text-sm text-slate-500 font-semibold mb-4">คาบที่มีการสอนแทน · ภาคเรียนที่ ${term}/${year}</p>`;
            h += `<p class="font-bold text-slate-700 text-sm mb-1.5">เดือน</p><div class="flex items-center gap-2 mb-4"><button type="button" onclick="window.srMonth(-1)" class="w-9 h-9 rounded-lg border-2 border-slate-200 hover:bg-slate-50 text-slate-600" aria-label="เดือนก่อน"><i class="fas fa-chevron-left"></i></button><div class="flex-1 text-center border-2 border-slate-200 rounded-lg py-1.5 font-extrabold text-slate-800 text-sm">${srMonthTxt(w.month)}</div><button type="button" onclick="window.srMonth(1)" class="w-9 h-9 rounded-lg border-2 border-slate-200 hover:bg-slate-50 text-slate-600" aria-label="เดือนถัดไป"><i class="fas fa-chevron-right"></i></button></div>`;
            h += `<p class="font-bold text-slate-700 text-sm mb-1.5">ห้องเรียน</p><div class="flex flex-wrap gap-1.5 mb-2">${chip(w.mode === 'room', 'ห้องเดียว', "window.srMode('room')")}${chip(w.mode === 'all', `ทุกห้อง (${allRooms.length})`, "window.srMode('all')")}${grades.map(g => chip(w.mode === 'grades' && w.grades.includes(String(g)), 'ม.' + g, `window.srGrade('${g}')`)).join('')}</div>`;
            if (w.mode === 'room') h += `<select onchange="window.srSet('room', this.value)" class="w-full mb-2 border-2 border-slate-200 rounded-lg px-3 py-2 text-sm font-bold"><option value="">— เลือกห้อง —</option>${allRooms.map(r => `<option value="${r}" ${r === w.room ? 'selected' : ''}>ห้อง ${formatRoomName(r)}</option>`).join('')}</select>`;
            h += `<div class="mb-4"></div>`;
            if (multi) h += `<p class="font-bold text-slate-700 text-sm mb-1.5">รูปแบบไฟล์ (หลายห้อง)</p><div class="grid grid-cols-2 gap-2 mb-4">${lay('merge', 'ก. รวมเป็นตารางเดียว', 'ทุกห้องเรียงต่อกันในตารางเดียว แล้วตามด้วยหน้ารูปทั้งหมด')}${lay('split', 'ข. แยกหน้าตามห้อง', 'แต่ละห้องขึ้นหน้าใหม่ (ตาราง + รูปของห้องนั้น) ไฟล์เดียวกัน')}</div>`;
            h += `<p class="font-bold text-slate-700 text-sm mb-1.5">เนื้อหาในไฟล์</p><div class="flex flex-col gap-2 mb-3">${chk(w.table, 'หน้าสรุป + ตารางการสอนแทน', 'วันที่ · คาบ · วิชา · ครูเจ้าของวิชา · ครูที่สอนแทน · งานที่มอบหมาย', 'table')}${chk(w.photos, 'หน้ารูปการสอนแทน', photoOn ? '4 รูปต่อหน้า' : 'ปิดรูปการสอนแทนไว้ (ตั้งค่าทั่วไป) — รายงานมีแค่ตาราง', 'photos', !photoOn)}</div>`;
            h += `<div class="text-xs text-slate-500 font-semibold bg-slate-50 rounded-lg px-3 py-2 mb-3"><i class="fas fa-info-circle"></i> ${K.n} คาบ · ประมาณ ${pages} หน้า · ใช้คอมพิวเตอร์จะเร็วกว่า</div>`;
            h += `<button type="button" onclick="window.exportSubstituteReport()" ${pages && K.n ? '' : 'disabled'} class="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-extrabold py-2.5 rounded-xl flex items-center justify-center gap-2"><i class="fas fa-file-download"></i> ส่งออก PDF</button></div>`;
            const per = rooms.map(r => { const rr = rows.filter(x => x.room === r); return { r, k: srCount(rr) }; }).filter(x => x.k.n);
            const st = (t, v, c) => `<div class="border border-slate-200 rounded-xl px-3 py-2"><span class="block text-xs text-slate-500 font-semibold">${t}</span><span class="block text-xl sm:text-2xl font-extrabold" style="color:${c}">${v}</span></div>`;
            h += `<div class="flex-1 min-w-0"><div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">${st('คาบที่สอนแทน', K.n, '#1e293b')}${st('มอบหมายงานไว้', K.yes, '#047857')}${st('ไม่ได้มอบหมาย', K.no, '#be123c')}${st('ไม่ระบุ (บันทึกก่อนมีช่องนี้)', K.none, '#94a3b8')}</div>`;
            h += per.length ? `<div class="overflow-x-auto border border-slate-200 rounded-xl"><table class="w-full text-xs sm:text-sm"><thead class="bg-slate-50 text-slate-600"><tr><th class="p-2 text-left">ห้อง</th><th class="p-2">คาบที่สอนแทน</th><th class="p-2">มอบหมายไว้</th><th class="p-2">ไม่ได้มอบหมาย</th><th class="p-2">ไม่ระบุ</th><th class="p-2">มีรูป</th></tr></thead><tbody>${per.map(x => `<tr class="border-t border-slate-100"><td class="p-2 font-bold">${formatRoomName(x.r)}</td><td class="p-2 text-center">${x.k.n}</td><td class="p-2 text-center font-extrabold text-emerald-700">${x.k.yes}</td><td class="p-2 text-center font-extrabold ${x.k.no ? 'text-rose-700' : ''}">${x.k.no}</td><td class="p-2 text-center text-slate-400">${x.k.none}</td><td class="p-2 text-center">${x.k.photo}</td></tr>`).join('')}</tbody></table></div><p class="text-xs text-slate-400 font-semibold mt-2 text-center">ห้องที่ไม่มีการสอนแทนในเดือนนี้ไม่ขึ้นในรายงาน</p>`
                : `<div class="text-center text-slate-400 py-12 text-sm font-semibold border-2 border-dashed border-slate-200 rounded-xl"><i class="fas fa-user-clock text-3xl mb-2 block"></i>${w.mode === 'room' && !w.room ? 'เลือกห้องก่อน' : 'ไม่มีการสอนแทนในเดือนนี้'}</div>`;
            return h + `</div></div>`;
        }
        function rptTabHtml() {
            const k = window.__rptKind || 'weekly';
            const b = (v, ic, t) => `<button type="button" onclick="window.rptKind('${v}')" class="${k === v ? 'border-indigo-600 bg-indigo-50 text-indigo-700' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'} border-2 rounded-xl px-3 sm:px-4 py-2 text-xs sm:text-sm font-extrabold flex items-center gap-2"><i class="fas ${ic}"></i> ${t}</button>`;
            return `<div class="flex flex-wrap gap-2 mb-4 sm:mb-5">${b('weekly', 'fa-calendar-week', 'รายงานเช็คชื่อประจำสัปดาห์')}${b('sub', 'fa-user-clock', 'รายงานสอนแทน')}</div>` + (k === 'sub' ? srTabHtml() : wrTabHtml());
        }
        window.rptKind = function(k) { window.__rptKind = k; renderAdminTab(); };
        window.srMonth = function(n) { const w = srState(); const [y, m] = w.month.split('-').map(Number); const d = new Date(y, m - 1 + n, 1); w.month = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`; renderAdminTab(); };
        window.srMode = function(m) { const w = srState(); w.mode = m; if (m !== 'grades') w.grades = []; renderAdminTab(); };
        window.srGrade = function(g) { const w = srState(); if (w.mode !== 'grades') { w.mode = 'grades'; w.grades = []; } const i = w.grades.indexOf(g); if (i >= 0) w.grades.splice(i, 1); else w.grades.push(g); if (!w.grades.length) w.mode = 'all'; renderAdminTab(); };
        window.srSet = function(k, v) { srState()[k] = v; renderAdminTab(); };
        // หน้า PDF: { kind: 'sum' | 'tbl' | 'ph', room?, rows } — ใช้ทั้งนับหน้าและสร้างไฟล์
        function srPlan(rows, rooms, w, usePh) {
            const out = [], PER = 14, PERP = 4, single = w.mode === 'room', split = !single && w.layout === 'split';
            const tbl = (rr, room) => { for (let i = 0; i < Math.max(1, Math.ceil(rr.length / PER)); i++) out.push({ kind: 'tbl', room, rows: rr.slice(i * PER, (i + 1) * PER), first: i === 0, last: (i + 1) * PER >= rr.length }); };
            const ph = (rr, room) => { const p = rr.filter(r => r.a.subPhoto); for (let i = 0; i < Math.ceil(p.length / PERP); i++) out.push({ kind: 'ph', room, rows: p.slice(i * PERP, (i + 1) * PERP) }); };
            if (!rows.length) return out;
            if (split) {
                if (w.table) out.push({ kind: 'sum', rows });
                rooms.forEach(r => { const rr = rows.filter(x => x.room === r); if (!rr.length) return; if (w.table) tbl(rr, r); if (usePh) ph(rr, r); });
            } else {
                if (w.table) tbl(rows, single ? rooms[0] : '');
                if (usePh) ph(rows, single ? rooms[0] : '');
            }
            return out;
        }
        window.exportSubstituteReport = async function() {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast('เฉพาะ Super Admin เท่านั้น', 'error'); return; }
            const w = srState(), term = adminTerm(), year = adminYear(), rooms = srRoomsSel(term, year), rows = srRows(term, year, rooms, w.month);
            const usePh = recFeatureOn('substitute') && w.photos, plan = srPlan(rows, rooms, w, usePh);
            if (!rows.length) { showToast('ไม่มีการสอนแทนในเดือนที่เลือก', 'error'); return; }
            if (!plan.length) { showToast('เลือกเนื้อหาในไฟล์อย่างน้อย 1 อย่าง', 'error'); return; }
            const single = w.mode === 'room', scope = single ? `ห้อง ${formatRoomName(rooms[0])}` : (w.mode === 'grades' ? w.grades.slice().sort().map(g => 'ม.' + g).join(', ') : 'ทุกห้อง');
            const fmtD = (s) => { const d = new Date(s); return `${d.getDate()} ${SR_MS[d.getMonth()]} ${d.getFullYear() + 543}`; };
            const asg = (a) => a.subAssign === 'yes' ? '<b style="color:#047857">มอบหมายไว้</b>' : (a.subAssign === 'no' ? '<b style="color:#be123c">ไม่ได้มอบหมาย</b>' : '<span style="color:#94a3b8">ไม่ระบุ</span>');
            const head = (t, room) => rpHead(t, rpPill(`${room ? 'ห้อง ' + formatRoomName(room) : scope} · ${srMonthTxt(w.month)} · ภาคเรียนที่ ${term}/${year}`));
            const tile = (n, t, c, bg) => `<div style="border:1px solid #e2e8f0; background:${bg}; border-radius:12px; padding:10px; text-align:center;"><div style="font-size:24px; font-weight:800; color:${c};">${n}</div><div style="font-size:12px; font-weight:700; color:${c};">${t}</div></div>`;
            const tiles = (rr) => { const k = srCount(rr); return `<div style="display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:8px; margin-bottom:14px;">${tile(k.n, 'คาบที่มีการสอนแทน', '#92400e', '#fffbeb')}${tile(k.yes, 'มอบหมายงานไว้', '#047857', '#ecfdf5')}${tile(k.no, 'ไม่ได้มอบหมายงาน', '#be123c', '#fff1f2')}${tile(k.none, 'ไม่ระบุ', '#64748b', '#ffffff')}</div>`; };
            const signersOf = (roomId) => { const adv = getRoomAdvisors(roomId).filter(Boolean), staff = getRoomStaff(roomId), sg = []; if (adv[0]) sg.push({ name: adv[0], role: adv[1] ? 'ครูที่ปรึกษาคนที่ 1' : 'ครูที่ปรึกษา' }); if (adv[1]) sg.push({ name: adv[1], role: 'ครูที่ปรึกษาคนที่ 2' }); sg.push({ name: staff, role: 'เจ้าหน้าที่' }); return sg; };
            const td = 'class="p-1.5 border border-slate-500"';
            const showRoom = !single && w.layout !== 'split';
            const tblHtml = (rr) => `<table class="w-full border-collapse bg-white border border-slate-500" style="table-layout:fixed; font-size:10.5px;"><thead class="bg-slate-100"><tr>${showRoom ? `<th ${td} style="width:8%;">ห้อง</th>` : ''}<th ${td} style="width:12%;">วันที่</th><th ${td} style="width:6%;">คาบ</th><th ${td} style="text-align:left;">วิชา</th><th ${td} style="text-align:left; width:16%;">ครูเจ้าของวิชา</th><th ${td} style="text-align:left; width:16%;">ครูที่สอนแทน</th><th ${td} style="width:13%;">งานที่มอบหมาย</th><th ${td} style="width:11%;">มา/สาย/ลา/ขาด</th>${usePh ? `<th ${td} style="width:5%;">รูป</th>` : ''}</tr></thead><tbody>${rr.map(r => `<tr>${showRoom ? `<td ${td} style="text-align:center; font-weight:700;">${formatRoomName(r.room)}</td>` : ''}<td ${td} style="font-weight:700;">${fmtD(r.a.date)}</td><td ${td} style="text-align:center;">${hrEsc(periodLabel(r.a.period))}</td><td ${td}>${hrEsc(r.sub.name || '-')}</td><td ${td}>${hrEsc(r.owner)}</td><td ${td} style="font-weight:700; color:#92400e;">${hrEsc(r.a.substituteTeacher)}</td><td ${td} style="text-align:center;">${asg(r.a)}</td><td ${td} style="text-align:center;">${r.c['มา']}/${r.c['สาย']}/${r.c['ลา']}/${r.c['ขาด']}</td>${usePh ? `<td ${td} style="text-align:center;">${r.a.subPhoto ? '1' : '–'}</td>` : ''}</tr>`).join('')}</tbody></table>`;
            showProgressModal('กำลังจัดทำรายงานสอนแทน', 'กำลังเตรียมข้อมูล...');
            const need = usePh ? plan.filter(x => x.kind === 'ph').reduce((a, x) => a.concat(x.rows), []) : [];
            const urls = new Map();
            if (need.length) { const got = await hrMapLimit(need, 3, (r) => hrGetPhotoPdf(r.a.subPhoto.id), (d, n) => updateProgressModal((d / n) * 30, `กำลังโหลดรูปการสอนแทน ${d}/${n}...`)); need.forEach((r, i) => urls.set(r, got[i])); }
            const parts = plan.map(pg => {
                const wrapCol = (inner, foot) => `<div style="height:100%; display:flex; flex-direction:column; justify-content:space-between;"><div>${inner}</div>${foot || ''}</div>`;
                if (pg.kind === 'sum') {
                    const per = rooms.map(r => ({ r, k: srCount(rows.filter(x => x.room === r)) })).filter(x => x.k.n);
                    return `${pdfPageBadge('หน้าสรุป')}${head('รายงานการสอนแทน', '')}${tiles(rows)}<table class="w-full border-collapse bg-white border border-slate-500" style="font-size:11px;"><thead class="bg-slate-100"><tr><th ${td}>ห้อง</th><th ${td}>คาบที่สอนแทน</th><th ${td}>มอบหมายไว้</th><th ${td}>ไม่ได้มอบหมาย</th><th ${td}>ไม่ระบุ</th>${usePh ? `<th ${td}>มีรูป</th>` : ''}</tr></thead><tbody>${per.map(x => `<tr><td ${td} style="font-weight:700;">${formatRoomName(x.r)}</td><td ${td} style="text-align:center;">${x.k.n}</td><td ${td} style="text-align:center; color:#047857; font-weight:700;">${x.k.yes}</td><td ${td} style="text-align:center; color:#be123c; font-weight:700;">${x.k.no}</td><td ${td} style="text-align:center; color:#94a3b8;">${x.k.none}</td>${usePh ? `<td ${td} style="text-align:center;">${x.k.photo}</td>` : ''}</tr>`).join('')}</tbody></table>`;
                }
                if (pg.kind === 'tbl') {
                    const rr = pg.room ? rows.filter(x => x.room === pg.room) : rows;
                    return wrapCol(`${pdfPageBadge(pg.room && !single ? 'ห้อง ' + formatRoomName(pg.room) : 'ตารางการสอนแทน')}${head('รายงานการสอนแทน', pg.room)}${pg.first ? tiles(rr) : ''}${tblHtml(pg.rows)}`, pg.last && pg.room ? buildPdfSignatureBlock(signersOf(pg.room)) : '');
                }
                const cells = pg.rows.map(r => { const u = urls.get(r); return `<div style="border:1px solid #cbd5e1; border-radius:12px; padding:10px; display:flex; flex-direction:column; gap:6px;"><div style="font-size:13px; font-weight:800; line-height:1.6;">${!pg.room ? 'ห้อง ' + formatRoomName(r.room) + ' · ' : ''}${fmtD(r.a.date)} · คาบ ${hrEsc(periodLabel(r.a.period))}</div><div style="font-size:12px; color:#475569; line-height:1.6;">${hrEsc(r.sub.name || '-')} · สอนแทนโดย <b style="color:#92400e;">${hrEsc(r.a.substituteTeacher)}</b> · ${asg(r.a)}</div>${u ? `<div style="aspect-ratio:4/3; border-radius:8px; overflow:hidden; background:#f1f5f9;"><img src="${u}" style="width:100%; height:100%; object-fit:cover; display:block;"></div>` : '<div style="aspect-ratio:4/3; border-radius:8px; background:#f1f5f9; display:flex; align-items:center; justify-content:center; color:#94a3b8; font-size:12px;">โหลดรูปไม่สำเร็จ</div>'}</div>`; }).join('');
                return `${pdfPageBadge('รูปการสอนแทน')}${head('รูปการสอนแทน', pg.room)}<div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px;">${cells}</div>`;
            });
            const fname = `รายงานสอนแทน_${single ? formatRoomName(rooms[0]).replace(/\//g, '-') : (w.mode === 'grades' ? 'ม' + w.grades.slice().sort().join('-') : 'ทุกห้อง')}_${w.month}${single ? '' : (w.layout === 'split' ? '_แยกห้อง' : '_รวม')}.pdf`;
            const ok = await rpRenderPdf(parts, fname, 'กำลังจัดทำรายงานสอนแทน', { scale: 2 });
            if (ok) logAction('ส่งออกรายงานสอนแทน', `${scope} · ${srMonthTxt(w.month)}`, 'data');
        };

        // ===== สวิตช์เปิด/ปิดการบันทึกพร้อมรูป (Super Admin) =====
        function buildRecordToggleSettingsHtml() {
            const row = (key, on, title, desc) => `<div class="flex items-center gap-3 bg-white border border-slate-200 rounded-xl p-3"><div class="flex-1 min-w-0"><p class="font-extrabold text-slate-800 text-sm sm:text-base">${title}</p><p class="text-xs text-slate-500 font-semibold">${desc}</p></div><button type="button" role="switch" aria-checked="${on}" aria-label="${title}" onclick="window.toggleRecordFeature('${key}')" class="relative w-14 h-8 rounded-full transition-colors shrink-0 ${on ? 'bg-emerald-500' : 'bg-slate-300'}"><span class="absolute top-1 ${on ? 'left-7' : 'left-1'} w-6 h-6 rounded-full bg-white shadow transition-all"></span></button></div>`;
            return `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-1 border-t pt-4 sm:pt-6 flex items-center gap-2"><i class="fas fa-camera text-indigo-500"></i> บันทึกกิจกรรมพร้อมรูป</h3><p class="text-xs sm:text-sm text-slate-500 mb-3">เมื่อปิด หน้าเช็คชื่อคาบนั้นจะเหลือแค่เช็คชื่อตามปกติ ข้อมูลที่บันทึกไว้แล้วยังอยู่ครบ</p><div class="space-y-2 mb-6">${row('recordHomeroom', settings.recordHomeroom !== false, 'คาบโฮมรูม', 'จัดกิจกรรมหรือไม่ + กิจกรรม + รูป 1 รูป')}${row('recordZone', settings.recordZone === true, 'คาบ A เขตพื้นที่รับผิดชอบ', 'สภาพเขตพื้นที่ + รูปรายงาน 1 รูป')}${row('recordSubstitute', settings.recordSubstitute === true, 'การสอนแทน', 'รูปการสอนแทน 1 รูปตอนเช็คชื่อ + รายงานสอนแทน (หน้ารายงานห้อง)')}</div>`;
        }
        // ===== [v1.78] ชุมนุม — ข้อมูลอยู่ที่ AcademicHub · เว็บนี้เช็คได้เฉพาะ "วันนี้" ที่เป็นวันชุมนุม (ไม่ต้องเข้าสู่ระบบ) · แก้ย้อนหลังที่ AcademicHub เมนู "ชุมนุม" =====
        function isClubSubject(s) { return !!s && !s.systemType && (/ครูกิจกรรมชุมนุม/.test(String(s.teacher || '') + ' ' + String(s.teacher2 || '')) || /^ชุมนุม/.test(String(s.name || '').trim())); }
        function clubRowHtml(slot, s) {
            return `<tr class="bg-yellow-50 hover:bg-yellow-100/70 transition-colors"><td class="p-1.5 sm:p-3 lg:p-5 text-center bg-yellow-100/60"><div class="font-black text-yellow-800 text-sm sm:text-lg leading-none">${periodLabel(slot.period)}</div><div class="font-bold text-yellow-600 font-mono text-[8px] sm:text-xs mt-0.5">${slot.time.split('-')[0]}</div></td><td class="p-1.5 sm:p-3 lg:p-5 min-w-0"><div class="font-extrabold text-yellow-900 text-[11px] sm:text-lg leading-tight break-words">${wrEsc(s.name || 'ชุมนุม')}</div><div class="text-[8px] sm:text-xs font-bold text-yellow-700 mt-0.5">เช็คแยกที่เมนูชุมนุม</div></td><td class="p-1.5 sm:p-3 lg:p-5 font-bold text-yellow-800 text-[9px] sm:text-base min-w-0"><span class="truncate block">${wrEsc(s.teacher || 'ครูกิจกรรมชุมนุม')}</span></td><td class="p-1 sm:p-3 lg:p-5"><button onclick="window.navigate('club_list')" class="w-full bg-yellow-400 hover:bg-yellow-500 text-yellow-950 py-1 sm:py-1.5 px-1 rounded-full text-[9px] sm:text-sm font-extrabold whitespace-nowrap flex items-center justify-center gap-1"><i class="fas fa-users"></i> ไปที่ชุมนุม</button></td></tr>`;
        }
        async function clubApi(mode, extra) {
            const r = await fetchWithRetry(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(Object.assign({ __mode: mode }, extra || {})) }, 2);
            const j = await r.json(); if (j.status !== 'success') throw new Error(j.message || 'ไม่สำเร็จ'); return j;
        }
        const CLUB_TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'], CLUB_TH_D = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'];
        const clubThai = (ds) => { const p = String(ds || '').split('-'); if (p.length !== 3) return ''; const d = new Date(+p[0], +p[1] - 1, +p[2]); return `${CLUB_TH_D[d.getDay()]} ${d.getDate()} ${CLUB_TH_M[d.getMonth()]}`; };
        window.loadClubBanner = async function () {
            const el = document.getElementById('clubBanner'); if (!el) return;
            let j = window.__clubToday;
            if (!j || Date.now() - j.__at > 60000) { try { j = await clubApi('club_today'); j.__at = Date.now(); window.__clubToday = j; } catch (e) { return; } }
            if (!j.session || j.session.off) { el.innerHTML = ''; return; }
            const done = (j.clubs || []).filter(c => c.checked).length;
            el.innerHTML = `<button onclick="window.navigate('club_list')" class="w-full mb-6 sm:mb-8 rounded-2xl sm:rounded-3xl p-4 sm:p-5 text-left text-white shadow-lg flex items-center gap-3 sm:gap-4 transition-transform active:scale-[.99]" style="background:linear-gradient(135deg,#7c3aed,#c026d3)"><span class="w-11 h-11 sm:w-14 sm:h-14 rounded-2xl bg-white/20 flex items-center justify-center text-xl sm:text-2xl shrink-0"><i class="fas fa-users"></i></span><span class="flex-1 min-w-0"><span class="block font-extrabold text-base sm:text-xl">เช็คชื่อชุมนุม</span><span class="block text-xs sm:text-sm text-white/90 font-semibold">วันนี้มีชุมนุม · ครั้งที่ ${j.session.no} · ${clubThai(j.session.date)} · ${j.open ? `เช็คแล้ว ${done}/${(j.clubs || []).length} ชุมนุม` : `เปิดให้เช็ค ${wrEsc(j.openTime)} น.`}</span></span><i class="fas fa-chevron-right"></i></button>`;
        };
        window.__clubFilter = { q: '', mode: 'all' };
        async function renderClubList(useCache) {
            const main = document.getElementById('mainContent');
            let j = useCache ? window.__clubToday : null;
            if (!j) main.innerHTML = `<div class="text-center py-16 text-slate-400 font-bold"><i class="fas fa-circle-notch fa-spin text-2xl mb-2 block"></i> กำลังโหลดรายชื่อชุมนุม...</div>`;
            if (!j) try { j = await clubApi('club_today'); j.__at = Date.now(); window.__clubToday = j; } catch (e) { main.innerHTML = `<div class="max-w-xl mx-auto bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl p-5 font-bold">${wrEsc(e.message)}</div>`; return; }
            const back = `<button onclick="window.navigate('dashboard')" class="mb-4 text-slate-600 hover:text-indigo-600 font-bold text-sm flex items-center gap-2"><i class="fas fa-arrow-left"></i> กลับหน้าหลัก</button>`;
            if (!j.session) { main.innerHTML = back + `<div class="max-w-xl mx-auto bg-white border border-slate-200 rounded-3xl p-8 text-center"><i class="fas fa-users text-4xl text-violet-400 mb-3 block"></i><p class="font-extrabold text-slate-800 text-lg">วันนี้ไม่มีชุมนุม</p><p class="text-slate-500 text-sm mt-1">${j.next ? 'ชุมนุมครั้งถัดไป: ' + clubThai(j.next) : 'แอดมินยังไม่ได้กำหนดวันชุมนุม'}</p></div>`; return; }
            if (j.session.off) { main.innerHTML = back + `<div class="max-w-xl mx-auto bg-white border border-slate-200 rounded-3xl p-8 text-center"><p class="font-extrabold text-slate-800 text-lg">วันนี้หยุด — ไม่มีการเช็คชื่อชุมนุม</p></div>`; return; }
            const f = window.__clubFilter, all = j.clubs || [];
            const L = all.filter(c => (f.mode === 'all' || (f.mode === 'todo' ? !c.checked : !!c.checked)) && (!f.q || (c.name + ' ' + c.teachers.join(' ')).indexOf(f.q) !== -1));
            const seg = (k, t) => `<button onclick="window.__clubFilter.mode='${k}'; renderClubListAgain()" class="flex-1 py-1.5 rounded-lg text-xs sm:text-sm font-bold ${f.mode === k ? 'bg-white text-indigo-700 shadow-sm' : 'text-slate-600'}">${t}</button>`;
            main.innerHTML = back + `<div class="max-w-3xl mx-auto"><div class="bg-white border border-slate-200 rounded-3xl p-4 sm:p-6 mb-4"><h2 class="text-xl sm:text-3xl font-extrabold text-slate-800 flex items-center gap-2"><i class="fas fa-users text-violet-500"></i> เช็คชื่อชุมนุม</h2><p class="text-slate-500 text-sm font-semibold mt-1">ครั้งที่ ${j.session.no}/${j.session.total} · ${clubThai(j.session.date)} · ${j.open ? 'เช็คได้ถึง 23:59 น.' : `เปิดให้เช็คตั้งแต่ ${wrEsc(j.openTime)} น.`} · ย้อนหลังแก้ที่ AcademicHub เมนู "ชุมนุม"</p></div>
              <input id="clubQ" value="${wrEsc(f.q)}" oninput="window.__clubFilter.q=this.value.trim(); clearTimeout(window.__clubQT); window.__clubQT=setTimeout(()=>renderClubListAgain(true),260)" placeholder="ค้นหาชื่อครู หรือชื่อชุมนุม" class="w-full border-2 border-slate-200 rounded-xl px-4 py-2.5 mb-3 text-sm sm:text-base">
              <div class="flex gap-1 bg-slate-200/60 p-1 rounded-xl mb-3">${seg('all', `ทั้งหมด ${all.length}`)}${seg('todo', `ยังไม่เช็ค ${all.filter(c => !c.checked).length}`)}${seg('done', `เช็คแล้ว ${all.filter(c => c.checked).length}`)}</div>
              <div class="flex flex-col gap-2">${L.map(c => `<button onclick="window.navigate('club_check', {clubId: '${wrEsc(c.id)}'})" class="w-full text-left rounded-2xl border p-3 sm:p-4 flex items-center gap-3 ${c.checked ? 'bg-emerald-50 border-emerald-200' : 'bg-white border-slate-200 hover:border-indigo-300'}"><span class="w-10 h-10 rounded-xl flex items-center justify-center shrink-0 ${c.checked ? 'bg-emerald-500 text-white' : 'bg-violet-50 text-violet-600'}"><i class="fas ${c.checked ? 'fa-check' : 'fa-users'}"></i></span><span class="flex-1 min-w-0"><span class="block font-extrabold text-slate-800">${wrEsc(c.name)}</span><span class="block text-xs text-slate-500 truncate">${wrEsc(c.teachers.join(' · '))} · ${c.count} คน${c.checked ? ` · มา ${c.checked.present}/${c.checked.n}` : ''}</span></span><span class="shrink-0 rounded-full px-3 py-1 text-xs sm:text-sm font-extrabold ${c.checked ? 'bg-emerald-600 text-white' : 'bg-indigo-600 text-white'}">${c.checked ? '<i class="fas fa-check"></i> เช็คแล้ว' : 'เริ่มเช็คชื่อ'}</span></button>`).join('') || '<p class="text-center text-slate-400 font-bold py-8">ไม่มีรายการ</p>'}</div></div>`;
            if (window.__clubQFocus) { const q = document.getElementById('clubQ'); q.focus(); q.setSelectionRange(q.value.length, q.value.length); window.__clubQFocus = false; }
        }
        window.renderClubListAgain = function (keepFocus) { window.__clubQFocus = !!keepFocus; renderClubList(true); };
        const CLUB_ST = [['มา', 'bg-emerald-500 border-emerald-500'], ['สาย', 'bg-amber-500 border-amber-500'], ['ลาป่วย', 'bg-blue-500 border-blue-500'], ['ลากิจ', 'bg-indigo-500 border-indigo-500'], ['ขาด', 'bg-rose-500 border-rose-500']];
        async function renderClubCheck(clubId) {
            const main = document.getElementById('mainContent');
            main.innerHTML = `<div class="text-center py-16 text-slate-400 font-bold"><i class="fas fa-circle-notch fa-spin text-2xl mb-2 block"></i> กำลังโหลดรายชื่อนักเรียน...</div>`;
            let j; try { j = await clubApi('club_get', { clubId }); } catch (e) { main.innerHTML = `<button onclick="window.navigate('club_list')" class="mb-4 text-slate-600 font-bold text-sm"><i class="fas fa-arrow-left"></i> รายชื่อชุมนุม</button><div class="max-w-xl mx-auto bg-rose-50 border border-rose-200 text-rose-700 rounded-2xl p-5 font-bold">${wrEsc(e.message)}</div>`; return; }
            window.__clubCk = { id: clubId, data: Object.assign({}, j.data || {}), room: '', q: '' };
            const rooms = [...new Set((j.members || []).map(m => m.roomId))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
            const ro = !j.open;
            main.innerHTML = `<button onclick="window.navigate('club_list')" class="mb-4 text-slate-600 hover:text-indigo-600 font-bold text-sm flex items-center gap-2"><i class="fas fa-arrow-left"></i> รายชื่อชุมนุม</button>
              <div class="max-w-3xl mx-auto pb-24"><div class="bg-white border border-slate-200 rounded-3xl p-4 sm:p-6 mb-3"><h2 class="text-xl sm:text-3xl font-extrabold text-slate-800">${wrEsc(j.club.name)}</h2><p class="text-slate-500 text-sm font-semibold mt-1">ครั้งที่ ${j.session.no} · ${clubThai(j.session.date)} · ${wrEsc(j.club.teachers.join(' · '))}</p>
              ${ro ? `<div class="mt-3 bg-amber-50 border border-amber-200 text-amber-800 rounded-xl px-3 py-2 text-sm font-bold"><i class="fas fa-clock"></i> เปิดให้เช็คตั้งแต่ ${wrEsc(j.openTime)} น.</div>` : ''}
              <label class="block font-bold text-slate-700 text-sm mt-3 mb-1">กิจกรรมที่ทำวันนี้ <span class="text-rose-500">*</span></label><textarea id="clubAct" rows="2" maxlength="600" ${ro ? 'disabled' : ''} class="w-full border-2 border-slate-200 rounded-xl px-3 py-2 text-sm" placeholder="เช่น นักเรียนศึกษาหาข้อมูลเรื่องที่สนใจ และบันทึกลงในสมุด">${wrEsc(j.activity || '')}</textarea></div>
              <div class="flex flex-wrap gap-2 mb-3">${ro ? '' : `<button onclick="window.clubAllPresent()" class="bg-emerald-100 text-emerald-800 font-bold text-sm px-3 py-2 rounded-xl"><i class="fas fa-check-double"></i> มาทั้งหมด</button>`}<select onchange="window.__clubCk.room=this.value; window.clubDrawRows()" class="border-2 border-slate-200 rounded-xl px-3 py-2 text-sm font-bold"><option value="">ทุกห้อง</option>${rooms.map(r => `<option value="${r}">${formatRoomName(r)}</option>`).join('')}</select><input oninput="window.__clubCk.q=this.value.trim(); window.clubDrawRows()" placeholder="ค้นหาชื่อ" class="flex-1 min-w-[140px] border-2 border-slate-200 rounded-xl px-3 py-2 text-sm"></div>
              <div id="clubRows" class="flex flex-col gap-2"></div></div>
              ${ro ? '' : `<div class="fixed left-0 right-0 bottom-0 p-3 sm:p-4 bg-white/90 backdrop-blur border-t border-slate-200 z-40"><div class="max-w-3xl mx-auto"><button id="clubSaveBtn" onclick="window.clubSave()" class="w-full bg-indigo-600 hover:bg-indigo-700 text-white font-extrabold py-3 rounded-2xl shadow-lg text-base"><i class="fas fa-save"></i> บันทึกการเช็คชื่อ (<span id="clubCnt">0</span>/${(j.members || []).length} คน)</button></div></div>`}`;
            window.__clubMembers = j.members || []; window.__clubRo = ro; window.clubDrawRows();
        }
        window.clubDrawRows = function () {
            const c = window.__clubCk, box = document.getElementById('clubRows'); if (!box) return;
            const L = (window.__clubMembers || []).filter(m => (!c.room || m.roomId === c.room) && (!c.q || m.name.indexOf(c.q) !== -1));
            box.innerHTML = L.map((m, i) => `<div class="bg-white border border-slate-200 rounded-2xl p-3"><div class="font-bold text-slate-800 text-sm sm:text-base">${i + 1}. ${wrEsc(m.name)} <span class="text-xs text-slate-400 font-semibold">${formatRoomName(m.roomId)}</span></div><div class="grid grid-cols-5 gap-1.5 mt-2">${CLUB_ST.map(x => `<button ${window.__clubRo ? 'disabled' : ''} onclick="window.clubSet('${wrEsc(m.id)}','${x[0]}')" class="py-1.5 rounded-xl border-2 text-xs sm:text-sm font-bold ${c.data[m.id] === x[0] ? x[1] + ' text-white' : 'bg-white border-slate-200 text-slate-600'}">${x[0]}</button>`).join('')}</div></div>`).join('') || '<p class="text-center text-slate-400 font-bold py-8">ไม่มีนักเรียน</p>';
            const n = document.getElementById('clubCnt'); if (n) n.textContent = Object.keys(c.data).length;
        };
        window.clubSet = function (sid, v) { window.__clubCk.data[sid] = v; window.clubDrawRows(); };
        window.clubAllPresent = function () { const c = window.__clubCk; (window.__clubMembers || []).forEach(m => { if (!c.data[m.id]) c.data[m.id] = 'มา'; }); window.clubDrawRows(); };
        window.clubSave = async function () {
            const c = window.__clubCk, act = String(document.getElementById('clubAct').value || '').trim();
            if (!act) { showToast('กรุณากรอก "กิจกรรมที่ทำวันนี้"', 'error'); document.getElementById('clubAct').focus(); return; }
            const miss = (window.__clubMembers || []).filter(m => !c.data[m.id]).length;
            const go = async () => {
                const btn = document.getElementById('clubSaveBtn'); if (btn) { btn.disabled = true; btn.innerHTML = '<i class="fas fa-circle-notch fa-spin"></i> กำลังบันทึก...'; }
                try { await clubApi('club_save', { clubId: c.id, data: c.data, activity: act }); window.__clubToday = null; showToast('บันทึกการเช็คชื่อชุมนุมแล้ว'); window.navigate('club_list'); }
                catch (e) { showToast(e.message, 'error'); if (btn) { btn.disabled = false; btn.innerHTML = `<i class="fas fa-save"></i> บันทึกการเช็คชื่อ (<span id="clubCnt">${Object.keys(c.data).length}</span>/${(window.__clubMembers || []).length} คน)`; } }
            };
            if (miss) showConfirm('ยังเช็คไม่ครบ', `ยังไม่ได้เลือกสถานะ ${miss} คน — บันทึกเท่าที่เลือกไว้?`, go); else go();
        };
        // ===== [v1.78] ล็อกการแก้ย้อนหลัง: บันทึกได้เฉพาะวันนี้ (ถึง 23:59 น.) · ย้อนหลังไปแก้ที่ AcademicHub · Super Admin แก้ฉุกเฉินได้ (เก็บประวัติ) =====
        function pastEditLocked(date) { return settings.lockPastEdit === true && !!date && date < todayDateStr(); }
        function hubTeachUrl() { const u = String(settings.hubSiteUrl || '').trim().replace(/\/+$/, ''); return u ? u + '/teach.html' : ''; }
        function pastEditBlocked(date) {
            if (!pastEditLocked(date)) return false;
            if (currentUser && currentUser.role === 'super_admin') return false; // ฉุกเฉิน — Worker บันทึกประวัติการแก้ให้
            const u = hubTeachUrl();
            showConfirm('แก้ย้อนหลังที่ AcademicHub', `การเช็คชื่อของวันที่ผ่านมาแล้ว บันทึก/แก้ไขได้ที่ AcademicHub เมนู "วิชาที่สอน" เท่านั้น${u ? '<br><br>กด "ยืนยัน" เพื่อเปิด AcademicHub' : ''}`, () => { if (u) window.open(u, '_blank', 'noopener'); });
            return true;
        }
        function applyPastLockUi(date) {
            const btn = document.getElementById('saveAttBtn'); if (!btn) return;
            let bar = document.getElementById('pastLockBar');
            const block = pastEditLocked(date) && !(currentUser && currentUser.role === 'super_admin');
            if (!block) { if (bar) bar.remove(); return; }
            if (!bar) { bar = document.createElement('div'); bar.id = 'pastLockBar'; bar.className = 'mb-3 bg-amber-50 border-2 border-amber-300 text-amber-800 rounded-xl px-3 py-2.5 text-xs sm:text-sm font-bold flex items-center gap-2'; btn.parentNode.insertBefore(bar, btn); }
            const u = hubTeachUrl();
            bar.innerHTML = `<i class="fas fa-lock"></i><span class="flex-1">วันที่ผ่านมาแล้ว — บันทึก/แก้ไขที่ AcademicHub เมนู "วิชาที่สอน"</span>${u ? `<a href="${wrEsc(u)}" target="_blank" rel="noopener" class="shrink-0 bg-amber-500 hover:bg-amber-600 text-white px-3 py-1 rounded-lg">เปิด AcademicHub</a>` : ''}`;
        }
        function buildPastLockSettingsHtml() {
            const on = settings.lockPastEdit === true;
            const term = adminTerm ? adminTerm() : settings.term, year = adminYear ? adminYear() : settings.year;
            const used = new Set(); subjects.filter(x => String(x.term) === String(term) && String(x.year) === String(year) && !x.systemType).forEach(x => [x.teacher, x.teacher2].forEach(n => { n = String(n || '').trim(); if (n && !/ชุมนุม/.test(n)) used.add(n); }));
            Object.values(((settings.advisors || {})[termKeyOf(term, year)]) || {}).forEach(a => (Array.isArray(a) ? a : []).forEach(n => { n = String(n || '').trim(); if (n) used.add(n); }));
            const linked = new Set((teachers || []).filter(t => t.hubId).map(t => String(t.name || '').trim()));
            const missing = [...used].filter(n => !linked.has(n)).sort((a, b) => a.localeCompare(b, 'th'));
            return `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-1 border-t pt-4 sm:pt-6 flex items-center gap-2"><i class="fas fa-history text-indigo-500"></i> ล็อกการแก้เช็คชื่อย้อนหลัง</h3><p class="text-xs sm:text-sm text-slate-500 mb-3">เปิดแล้ว: เช็คชื่อได้เฉพาะ "วันนี้" ถึง 23:59 น. · วันที่ผ่านมาแล้วต้องบันทึก/แก้ที่ AcademicHub เมนู "วิชาที่สอน" (มีประวัติว่าใครแก้) · Super Admin ยังแก้ฉุกเฉินได้ (บันทึกประวัติ)</p>
            <div class="flex items-center gap-3 bg-white border border-slate-200 rounded-xl p-3 mb-2"><div class="flex-1 min-w-0"><p class="font-extrabold text-slate-800 text-sm sm:text-base">ล็อกการแก้ย้อนหลัง</p><p class="text-xs text-slate-500 font-semibold">${on ? 'เปิดอยู่ — ครู/เจ้าหน้าที่แก้ย้อนหลังในเว็บนี้ไม่ได้' : 'ปิดอยู่ — แก้ย้อนหลังในเว็บนี้ได้เหมือนเดิม'}</p></div><button type="button" onclick="window.togglePastLock()" class="relative inline-flex h-7 w-12 shrink-0 rounded-full transition-colors ${on ? 'bg-emerald-500' : 'bg-slate-300'}" aria-label="ล็อกการแก้ย้อนหลัง"><span class="inline-block h-6 w-6 mt-0.5 rounded-full bg-white shadow transform transition ${on ? 'translate-x-5' : 'translate-x-0.5'}"></span></button></div>
            <div class="flex flex-col sm:flex-row sm:items-center gap-2 bg-white border border-slate-200 rounded-xl p-3 mb-2"><label class="text-sm font-bold text-slate-700 shrink-0" for="hubSiteUrlIn">ที่อยู่เว็บ AcademicHub</label><input id="hubSiteUrlIn" value="${wrEsc(settings.hubSiteUrl || '')}" placeholder="https://.../ (ใช้ทำปุ่มพาไปแก้ย้อนหลัง)" class="flex-1 border border-slate-300 rounded-lg px-3 py-1.5 text-sm"><button type="button" onclick="window.saveHubSiteUrl()" class="bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm px-4 py-1.5 rounded-lg"><i class="fas fa-check"></i> บันทึก</button></div>
            <div class="rounded-xl p-3 mb-4 ${missing.length ? 'bg-amber-50 border border-amber-200' : 'bg-emerald-50 border border-emerald-200'}"><p class="font-extrabold text-sm ${missing.length ? 'text-amber-800' : 'text-emerald-800'}"><i class="fas ${missing.length ? 'fa-exclamation-triangle' : 'fa-check-circle'}"></i> ${missing.length ? `ครูที่ยังไม่ได้ผูกบัญชี AcademicHub ${missing.length} คน (แก้ย้อนหลังไม่ได้จนกว่าจะผูก — ผูกที่แท็บ "ครู")` : 'ครูที่มีวิชา/เป็นครูที่ปรึกษาภาคเรียนนี้ ผูกบัญชี AcademicHub ครบแล้ว'}</p>${missing.length ? `<p class="text-xs text-amber-700 mt-1 leading-relaxed">${missing.map(wrEsc).join(' · ')}</p>` : ''}</div>`;
        }
        window.togglePastLock = function () {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast('เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้', 'error'); return; }
            const next = settings.lockPastEdit !== true;
            showConfirm(next ? 'เปิดล็อกการแก้ย้อนหลัง?' : 'ปิดล็อกการแก้ย้อนหลัง?', next ? 'ครูและเจ้าหน้าที่จะเช็คชื่อได้เฉพาะวันนี้ ย้อนหลังต้องไปแก้ที่ AcademicHub' : 'ทุกคนจะกลับมาแก้ย้อนหลังในเว็บนี้ได้เหมือนเดิม', () => {
                settings.lockPastEdit = next; logAction(`${next ? 'เปิด' : 'ปิด'}ล็อกการแก้เช็คชื่อย้อนหลัง`, '', 'settings'); saveData('full'); showToast(next ? 'เปิดล็อกแล้ว' : 'ปิดล็อกแล้ว'); renderAdminTab();
            });
        };
        window.saveHubSiteUrl = function () {
            if (!currentUser || currentUser.role !== 'super_admin') return;
            const v = String(document.getElementById('hubSiteUrlIn').value || '').trim();
            if (v && !/^https:\/\/[^\s]+$/.test(v)) { showToast('ที่อยู่เว็บต้องขึ้นต้นด้วย https://', 'error'); return; }
            settings.hubSiteUrl = v; logAction('ตั้งที่อยู่เว็บ AcademicHub', v, 'settings'); saveData('full'); showToast('บันทึกแล้ว'); renderAdminTab();
        };
        window.toggleRecordFeature = function(key) {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast('เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้', 'error'); return; }
            const cur = key === 'recordHomeroom' ? settings.recordHomeroom !== false : settings[key] === true;
            settings[key] = !cur;
            logAction(`${!cur ? 'เปิด' : 'ปิด'}การบันทึกพร้อมรูป`, key === 'recordZone' ? 'คาบ A เขตพื้นที่รับผิดชอบ' : (key === 'recordSubstitute' ? 'การสอนแทน' : 'คาบโฮมรูม'), 'settings');
            saveData('full'); showToast(!cur ? 'เปิดใช้งานแล้ว' : 'ปิดใช้งานแล้ว'); renderAdminTab();
        };

        // ===== เล่มสรุปโฮมรูม (รายสัปดาห์ / รายเดือน) - ทุกคนกดสร้างได้ =====
        window.openHomeroomBookletChooser = function(roomId, month) {
            const hrSub = getRoomSubjects(roomId).find(s => s.systemType === 'homeroom');
            if (!hrSub) { showToast('ห้องนี้ยังไม่มีคาบโฮมรูม (แอดมินเปิดแท็บ "วิชา" หนึ่งครั้งเพื่อสร้างคาบระบบ)', 'error'); return; }
            const [y, m] = month.split('-').map(Number);
            const ranges = getMonthWeekRanges(y, m);
            const thM = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."][m - 1];
            const weekBtns = Object.keys(ranges).sort((a, b) => a - b).map(w => { const r = ranges[w]; return `<button type="button" onclick="window.__hrPickRange('${roomId}', '${month}', ${r.start}, ${r.end}, 'สัปดาห์ที่ ${w}')" class="w-full text-left bg-slate-50 hover:bg-indigo-50 border-2 border-slate-200 hover:border-indigo-300 rounded-xl px-4 py-3 font-bold text-slate-700 text-sm sm:text-base">สัปดาห์ที่ ${w} <span class="text-slate-500 font-semibold">(${r.start}–${r.end} ${thM})</span></button>`; }).join('');
            const last = new Date(y, m, 0).getDate();
            const ov = document.createElement('div'); ov.id = 'hrBookletChooser';
            ov.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4';
            ov.innerHTML = `<div class="bg-white rounded-3xl shadow-2xl w-full max-w-md p-5 sm:p-6 max-h-[90vh] overflow-y-auto"><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-1">สรุปโฮมรูม ห้อง ${formatRoomName(roomId)}</h3><p class="text-sm text-slate-500 mb-4">เลือกช่วงที่ต้องการทำเล่มสรุป</p><button type="button" onclick="window.__hrPickRange('${roomId}', '${month}', 1, ${last}, 'ทั้งเดือน')" class="w-full text-left bg-indigo-600 hover:bg-indigo-700 text-white rounded-xl px-4 py-3 font-extrabold text-sm sm:text-base mb-2">ทั้งเดือน ${thM} ${y + 543}</button><div class="space-y-2">${weekBtns}</div><button type="button" onclick="document.getElementById('hrBookletChooser').remove()" class="mt-4 w-full bg-slate-100 hover:bg-slate-200 text-slate-700 py-3 rounded-xl font-bold">ยกเลิก</button></div>`;
            document.body.appendChild(ov);
        };
        window.__hrPickRange = function(roomId, month, d1, d2, label) {
            const el = document.getElementById('hrBookletChooser'); if (el) el.remove();
            const [y, m] = month.split('-').map(Number);
            const ds = d => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            window.__runHomeroomBooklet(roomId, ds(d1), ds(d2), label);
        };
        window.__runHomeroomBooklet = async function(roomId, startStr, endStr, label) {
            const hrSub = getRoomSubjects(roomId).find(s => s.systemType === 'homeroom'); if (!hrSub) return;
            showProgressModal('กำลังจัดทำเล่มสรุปโฮมรูม', 'กำลังโหลดบันทึกโฮมรูม...');
            const logs = await hrLoadLogs(hrSub.term, hrSub.year, roomId, true);
            if (logs === null) { errorProgressModal('โหลดบันทึกโฮมรูมไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วลองใหม่'); return; }
            const roomSubs = getRoomSubjects(roomId);
            const dayNames = ['', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์', 'อาทิตย์'];
            const thMs = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
            const fmtD = (s) => { const d = new Date(s); return `${d.getDate()} ${thMs[d.getMonth()]} ${d.getFullYear() + 543}`; };
            const rows = [];
            for (let d = new Date(startStr); localDateStr(d) <= endStr; d.setDate(d.getDate() + 1)) {
                const dateStr = localDateStr(d); const eff = getEffectiveDayOfWeek(dateStr);
                const hol = getHolidayForDate(dateStr);
                const realDow = d.getDay(); if ((realDow === 0 || realDow === 6) && !(hol && hol.type === 'makeup')) continue;
                const raw = (hrSub.schedules || []).find(sc => parseInt(sc.day) === eff); if (!raw) continue;
                const row = { dateStr, label: `${dayNames[eff] ? dayNames[realDow === 0 ? 7 : realDow] : ''} ${fmtD(dateStr)}`, kind: '', text: '', photos: 0, log: null };
                if (hol && (!hol.type || hol.type === 'holiday')) { row.kind = 'holiday'; row.text = `วันหยุด: ${hol.label || ''}`; }
                else if (!effSched(hrSub).some(sc => parseInt(sc.day) === eff)) {
                    const ov = roomSubs.find(s => !s.systemType && (s.schedules || []).some(sc => parseInt(sc.day) === eff && parseInt(sc.period) === parseInt(raw.period)));
                    row.kind = 'override'; row.text = `คาบ ${periodLabel(raw.period)} มีการสอน ${ov ? ov.name : 'วิชาอื่น'} แทนโฮมรูม`;
                } else {
                    const lg = logs.find(l => l.date === dateStr);
                    if (lg) { row.log = lg; row.kind = lg.held ? 'held' : 'not'; row.text = lg.held ? `${lg.activity || ''}${lg.note ? ' — ' + lg.note : ''}` : `เหตุผล: ${lg.reason || '-'}`; row.photos = (lg.photos || []).length; }
                    else { row.kind = 'none'; row.text = 'ยังไม่ได้บันทึก'; }
                }
                rows.push(row);
            }
            const cnt = k => rows.filter(r => r.kind === k).length;
            const kindMeta = { held: ['จัด', '#047857'], not: ['ไม่ได้จัด', '#be123c'], override: ['สอนแทน', '#92400e'], holiday: ['วันหยุด', '#475569'], none: ['ยังไม่บันทึก', '#b45309'] };
            // โหลดรูปของวันที่จัดกิจกรรม
            const photoMap = {}; const photoJobs = [];
            rows.forEach(r => { if (r.log && r.log.held) (r.log.photos || []).forEach(p => photoJobs.push({ date: r.dateStr, id: p.id })); });
            const jobUrls = await hrMapLimit(photoJobs, 3, (j) => hrGetPhotoPdf(j.id), (d, n) => updateProgressModal((d / Math.max(1, n)) * 40, `กำลังโหลดรูปกิจกรรม ${d}/${n}...`)); // [v2.02.2]
            photoJobs.forEach((j, i) => { (photoMap[j.date] = photoMap[j.date] || []).push(jobUrls[i]); });
            const roomName = formatRoomName(roomId);
            const adv = getRoomAdvisors(roomId).filter(Boolean); const staff = getRoomStaff(roomId);
            const signers = []; if (adv[0]) signers.push({ name: adv[0], role: adv[1] ? 'ครูที่ปรึกษาคนที่ 1' : 'ครูที่ปรึกษา' }); if (adv[1]) signers.push({ name: adv[1], role: 'ครูที่ปรึกษาคนที่ 2' }); signers.push({ name: staff, role: 'เจ้าหน้าที่' });
            const rangeTxt = `${fmtD(startStr)} – ${fmtD(endStr)}`;
            const head = (sub) => `${rpHead(`สรุปกิจกรรมโฮมรูม ${label === 'ทั้งเดือน' ? 'รายเดือน' : 'รายสัปดาห์'}`, rpPill(`ห้อง ${roomName} · ${label} (${rangeTxt})`))}${sub || ''}`;
            const tile = (n, t, c, bg) => `<div style="border:1px solid #e2e8f0; background:${bg}; border-radius:12px; padding:10px; text-align:center;"><div style="font-size:24px; font-weight:800; color:${c};">${n}</div><div style="font-size:12px; font-weight:700; color:${c};">${t}</div></div>`;
            const PER = 14; const pages = Math.ceil(rows.length / PER) || 1;
            let html = `<div id="pdf-hr-container" class="a4-export-container text-slate-800" style="font-family: 'Sarabun', sans-serif;">`;
            for (let p = 0; p < pages; p++) {
                const chunk = rows.slice(p * PER, (p + 1) * PER);
                const tbl = `<table class="w-full border-collapse bg-white border border-slate-500" style="table-layout:fixed; font-size:12px;"><thead class="bg-slate-100"><tr><th class="p-2 border border-slate-500 text-left" style="width:24%;">วัน</th><th class="p-2 border border-slate-500" style="width:13%;">สถานะ</th><th class="p-2 border border-slate-500 text-left">กิจกรรม / บันทึก</th><th class="p-2 border border-slate-500" style="width:8%;">รูป</th></tr></thead><tbody>${chunk.map(r => `<tr><td class="p-2 border border-slate-500 font-bold">${hrEsc(r.label)}</td><td class="p-2 border border-slate-500 text-center font-bold" style="color:${kindMeta[r.kind][1]}">${kindMeta[r.kind][0]}</td><td class="p-2 border border-slate-500">${hrEsc(r.text)}</td><td class="p-2 border border-slate-500 text-center">${r.photos || '–'}</td></tr>`).join('') || '<tr><td colspan="4" class="p-4 border border-slate-500 text-center text-slate-400">ไม่มีคาบโฮมรูมในช่วงนี้</td></tr>'}</tbody></table>`;
                const tiles = p === 0 ? `<div style="display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap:8px; margin-bottom:16px;">${tile(rows.length - cnt('holiday'), 'วันตามตาราง', '#334155', '#ffffff')}${tile(cnt('held'), 'จัดกิจกรรม', '#047857', '#ecfdf5')}${tile(cnt('not'), 'ไม่ได้จัด', '#be123c', '#fff1f2')}${tile(cnt('override'), 'สอนวิชาอื่นแทน', '#92400e', '#fffbeb')}${tile(cnt('none'), 'ยังไม่บันทึก', '#b45309', '#fff7ed')}</div>` : '';
                html += `<div class="a4-page flex flex-col justify-between bg-white">${pdfPageBadge(pages > 1 ? `หน้าสรุป ${p + 1}/${pages}` : '')}<div>${head()}${tiles}${tbl}</div>${p === pages - 1 ? buildPdfSignatureBlock(signers) : ''}</div>`;
            }
            // [v2.02.2] บันทึกรายวัน 4 วันต่อหน้า (เดิม 1 วันต่อหน้า — รูปมีวันละ 1 รูป เหลือที่ว่างครึ่งหน้า) · วันที่ไม่ได้จัดกิจกรรมดูเหตุผลในตารางสรุป
            const dayCard = (r) => {
                const lg = r.log;
                const recs = attendanceData.filter(a => a.subjectId === hrSub.id && a.date === r.dateStr);
                const c = { 'มา': 0, 'สาย': 0, 'ลา': 0, 'ขาด': 0 };
                recs.forEach(a => Object.values(a.records || {}).forEach(st => { if (st === 'มา' || st === 'ร่วมกิจกรรม') c['มา']++; else if (st === 'สาย') c['สาย']++; else if (st === 'ลาป่วย' || st === 'ลากิจ') c['ลา']++; else c['ขาด']++; }));
                const t = lg.recordedAt ? new Date(lg.recordedAt) : null;
                const ph = photoMap[r.dateStr] || [], u = ph[0];
                const img = u ? `<div style="aspect-ratio:4/3; border-radius:9px; overflow:hidden; background:#e2e8f0; position:relative;"><img src="${u}" style="width:100%; height:100%; object-fit:cover; display:block;">${ph.length > 1 ? `<span style="position:absolute; right:6px; bottom:6px; background:rgba(15,23,42,.7); color:#fff; font-size:11px; font-weight:700; border-radius:6px; padding:0 6px;">+${ph.length - 1} รูป</span>` : ''}</div>`
                    : `<div style="aspect-ratio:4/3; border-radius:9px; background:${ph.length ? '#fff1f2' : '#f1f5f9'}; color:${ph.length ? '#be123c' : '#94a3b8'}; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700;">${ph.length ? 'โหลดรูปไม่สำเร็จ' : 'ไม่มีรูป'}</div>`;
                const field = (k, v, clamp) => `<div style="color:#64748b; font-weight:700;">${k}</div><div style="min-width:0;${clamp ? ' max-height:40px; overflow:hidden;' : ''}">${v}</div>`;
                return `<div style="border:1px solid #cbd5e1; border-radius:12px; padding:9px 10px; display:flex; flex-direction:column; gap:6px; min-width:0;"><div style="display:flex; align-items:center; justify-content:space-between; gap:6px;"><b style="font-size:13.5px;">${hrEsc(r.label)}</b><span style="font-size:11px; font-weight:800; padding:0 9px; border-radius:999px; background:#d1fae5; color:${kindMeta[r.kind][1]}; white-space:nowrap;">${kindMeta[r.kind][0]}กิจกรรม</span></div>${img}<div style="display:grid; grid-template-columns:58px minmax(0,1fr); gap:0 8px; font-size:12px;">${field('กิจกรรม', `<b>${hrEsc(lg.activity || '-')}</b>`, true)}${lg.note ? field('บันทึก', hrEsc(lg.note), true) : ''}${field('นักเรียน', recs.length ? `มา ${c['มา']} · สาย ${c['สาย']} · ลา ${c['ลา']} · ขาด ${c['ขาด']}` : 'ไม่มีข้อมูลเช็คชื่อ')}${field('บันทึกโดย', `${hrEsc(lg.recordedBy || '-')}${t && !isNaN(t) ? ` · ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')} น.` : ''}`)}</div></div>`;
            };
            const heldRows = rows.filter(r => r.log && r.log.held), DPP = 4, dPages = Math.ceil(heldRows.length / DPP);
            for (let p = 0; p < dPages; p++) {
                html += `<div class="a4-page flex flex-col bg-white">${pdfPageBadge('บันทึกรายวัน')}${head()}<div style="font-size:15px; font-weight:800; margin:2px 0 10px;">บันทึกกิจกรรมรายวัน${dPages > 1 ? ` (${p + 1}/${dPages})` : ''}</div><div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px;">${heldRows.slice(p * DPP, (p + 1) * DPP).map(dayCard).join('')}</div></div>`;
            }
            html += `</div>`;
            const wasDark = document.documentElement.classList.contains('dark'); if (wasDark) document.documentElement.classList.remove('dark');
            document.body.insertAdjacentHTML('beforeend', html); rpFinalize(document.body.lastElementChild);
            await document.fonts.ready; await new Promise(res => setTimeout(res, 600));
            try {
                const pdfDoc = new jspdf.jsPDF('p', 'pt', 'a4');
                const els = document.querySelectorAll('#pdf-hr-container .a4-page');
                for (let i = 0; i < els.length; i++) {
                    updateProgressModal(40 + (i / els.length) * 60, `กำลังสร้างหน้าที่ ${i + 1} จาก ${els.length}...`);
                    const canvas = await html2canvas(els[i], { scale: 2, backgroundColor: '#ffffff', useCORS: true, logging: false });
                    if (i > 0) pdfDoc.addPage(); pdfDoc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', 0, 0, 595.28, 841.89);
                }
                updateProgressModal(100, 'กำลังบันทึกไฟล์...');
                pdfDoc.save(`สรุปโฮมรูม_${roomName.replace(/\//g, '-')}_${startStr}_${endStr}.pdf`);
                completeProgressModal('ดำเนินการเสร็จสิ้น', `สร้างเล่มสรุปโฮมรูม (${els.length} หน้า) สำเร็จ ไฟล์ถูกดาวน์โหลดแล้ว`);
            } catch (err) { errorProgressModal('เกิดข้อผิดพลาดในการสร้างเล่มสรุป กรุณาลองใหม่อีกครั้ง'); }
            const el = document.getElementById('pdf-hr-container'); if (el) el.remove();
            if (wasDark) document.documentElement.classList.add('dark');
        };

        // ===== [v1.70] ตัวช่วยของปุ่มบันทึกเช็คชื่อ / กล่องแจ้งผล / แถวกะพริบ =====
        function setAttSaveBtnState(state) {
            const btn = document.getElementById('saveAttBtn'); if (!btn) return;
            if (!btn.dataset.origHtml) { btn.dataset.origHtml = btn.innerHTML; btn.dataset.origCls = btn.className; }
            btn.className = btn.dataset.origCls;
            btn.style.maxWidth = '100%'; btn.disabled = false;
            if (state === 'saving') {
                btn.disabled = true; btn.style.maxWidth = '260px';
                btn.innerHTML = '<i class="fas fa-circle-notch fa-spin text-xl"></i> กำลังบันทึก…';
            } else if (state === 'saved') {
                btn.disabled = true; btn.style.maxWidth = '220px';
                btn.className = btn.className.replace('bg-indigo-600', 'bg-emerald-600').replace('hover:bg-indigo-700', 'hover:bg-emerald-600').replace('shadow-indigo-200', 'shadow-emerald-200');
                btn.innerHTML = '<i class="fas fa-check text-xl"></i> บันทึกแล้ว';
            } else if (state === 'failed') {
                btn.className = btn.className.replace('bg-indigo-600', 'bg-rose-600').replace('hover:bg-indigo-700', 'hover:bg-rose-700').replace('shadow-indigo-200', 'shadow-rose-200');
                btn.innerHTML = '<i class="fas fa-redo text-xl"></i> ลองส่งเลยตอนนี้';
            } else btn.innerHTML = btn.dataset.origHtml;
        }
        function setAttSaveBanner(kind, secondsLeft, title) {
            const box = document.getElementById('attSaveBanner'); if (!box) return;
            if (!kind) { box.classList.add('hidden'); box.innerHTML = ''; return; }
            __ensureToastStyle();
            const retryTxt = secondsLeft > 0 ? `ระบบจะลองส่งให้อีกครั้งใน ${secondsLeft} วินาที` : 'ลองส่งหลายครั้งแล้วยังไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วกดปุ่มด้านล่าง';
            box.innerHTML = `<div role="alert" class="__t-rise flex gap-3 bg-rose-50 border-2 border-rose-200 rounded-2xl px-4 py-3 text-left"><i class="fas fa-exclamation-circle text-rose-600 text-xl mt-0.5"></i><div class="flex-1"><p class="font-extrabold text-rose-800 text-sm sm:text-base">${title || 'ส่งข้อมูลไม่สำเร็จ (สัญญาณอินเทอร์เน็ตไม่เสถียร)'}</p><p class="text-rose-700 text-xs sm:text-sm mt-0.5 leading-relaxed">ที่เช็คไว้ยังอยู่ครบ ไม่ต้องเช็คใหม่ · ${retryTxt}</p></div></div>`;
            box.classList.remove('hidden');
        }
        function flashAttRow(key) {
            if (!key) return;
            __ensureToastStyle();
            document.querySelectorAll(`[data-att-key="${key}"]`).forEach(el => { el.classList.remove('row-flash'); void el.offsetWidth; el.classList.add('row-flash'); setTimeout(() => el.classList.remove('row-flash'), 2100); });
        }
        // ป้ายเล็กด้านบนเวลามีครูคนอื่นเช็คชื่อในห้องที่กำลังเปิดดูอยู่
        function showRealtimeChip(text) {
            __ensureToastStyle();
            const old = document.getElementById('__rtChip'); if (old) old.remove();
            const chip = document.createElement('div'); chip.id = '__rtChip'; chip.setAttribute('role', 'status');
            chip.className = '__rt-chip fixed top-20 sm:top-24 left-1/2 z-[65] flex items-center gap-2 whitespace-nowrap bg-indigo-600 text-white rounded-full px-4 py-2 text-xs sm:text-sm font-bold shadow-lg pointer-events-none';
            chip.innerHTML = `<i class="fas fa-sync-alt text-indigo-100"></i> ${String(text).replace(/</g, '&lt;')}`;
            document.body.appendChild(chip); setTimeout(() => chip.remove(), 3500);
        }
        window.saveAttendance = async function(fromTeacherDash = false, isAutoRetry = false) {
            if (!isAutoRetry) window.__attRetryCount = 0; // กดเองถือว่าเริ่มนับรอบลองใหม่อัตโนมัติใหม่
            const date = document.getElementById('attDate').value, period = document.getElementById('attPeriod').value;
            const isSub = document.getElementById('isSubstitute').checked, subTeacher = document.getElementById('substituteTeacher').value;
            if (!period) return; if (isSub && !subTeacher) { showToast("กรุณาเลือกชื่อครูที่มาสอนแทน", "error"); return;
            }
            const subject = subjects.find(s => s.id === currentSubjectId), roomStudents = getRoomStudents(subject.roomId);
            if (guardAttendanceLock(subject.term, subject.year)) return;
            if (pastEditBlocked(date)) return; // [v1.78]
            let records = {}, allFilled = true;
            roomStudents.forEach(st => { if (st.status !== 'resigned') { const selected = document.querySelector(`input[name="att_${st.id}"]:checked`) || document.querySelector(`input[name="att_mobile_${st.id}"]:checked`); if (selected) records[st.id] = selected.value; else allFilled = false; } });
            if (!allFilled) { showToast("กรุณาเช็คชื่อให้ครบทุกคน", "error"); return; }
            const hrActive = !!document.getElementById('hrSection');
            if (hrActive) { const hrErr = hrValidate(); if (hrErr) { showToast(hrErr, 'error'); const sec = document.getElementById('hrSection'); sec.scrollIntoView({ behavior: 'smooth', block: 'center' }); __ensureToastStyle(); sec.classList.remove('__shake'); void sec.offsetWidth; sec.classList.add('ring-4', 'ring-rose-200', '__shake'); setTimeout(() => sec.classList.remove('ring-4', 'ring-rose-200', '__shake'), 1800); return; } }
            const existingRec = attendanceData.find(a => a.subjectId === currentSubjectId && a.date === date && String(a.period) === String(period));
            if (isSub && window.__subAssign !== 'yes' && window.__subAssign !== 'no') { showToast('กรุณาเลือกว่าครูเจ้าของวิชามอบหมายงานไว้หรือไม่', 'error'); subAssignPaint(true); const w = document.getElementById('subAssignWrap'); if (w) { w.scrollIntoView({ behavior: 'smooth', block: 'center' }); __ensureToastStyle(); w.classList.remove('__shake'); void w.offsetWidth; w.classList.add('__shake'); setTimeout(() => w.classList.remove('__shake'), 1800); } return; } // [v2.02.3]
            const subPhotoOn = isSub && recFeatureOn('substitute');
            if (subPhotoOn && !subHasPhoto()) { showToast('กรุณาแนบรูปการสอนแทน 1 รูปก่อนบันทึก', 'error'); const w = document.getElementById('subPhotoWrap'); if (w) { w.scrollIntoView({ behavior: 'smooth', block: 'center' }); __ensureToastStyle(); w.classList.remove('__shake'); void w.offsetWidth; w.classList.add('ring-4', 'ring-rose-200', '__shake'); setTimeout(() => w.classList.remove('ring-4', 'ring-rose-200', '__shake'), 1800); } return; }
            const payloadData = { id: (existingRec && existingRec.id) || generateId(), subjectId: currentSubjectId, date: date, period: period, records: records, createdAt: (existingRec && existingRec.createdAt) || new Date().toISOString(), checkedAt: new Date().toISOString(), checkedBy: currentUser ? currentUser.name : '' };
            if(isSub) { payloadData.substituteTeacher = subTeacher; payloadData.subAssign = window.__subAssign; } // [v2.02.3] มอบหมายงานไว้ไหม
            // [v1.71.6] รูปการสอนแทน: ส่งรูปใหม่ก่อน (ส่งแล้วจำไว้ ลองใหม่ไม่ต้องส่งซ้ำ) · ไม่ได้เปลี่ยนรูป = ใช้รูปเดิม · ปิดฟีเจอร์อยู่ = คงรูปเดิมไว้ในข้อมูล
            const oldSubPhoto = existingRec && existingRec.subPhoto ? existingRec.subPhoto : null;
            if (isSub && oldSubPhoto) payloadData.subPhoto = oldSubPhoto;
            if (subPhotoOn && window.__subNewPhoto) {
                const np = window.__subNewPhoto;
                if (!np.uploaded) {
                    setAttSaveBtnState('saving');
                    const b0 = document.getElementById('saveAttBtn'); if (b0) b0.innerHTML = '<i class="fas fa-circle-notch fa-spin text-xl"></i> กำลังส่งรูปการสอนแทน…';
                    const subj0 = subjects.find(s => s.id === currentSubjectId);
                    const res = await hrUploadPhoto(np.dataUrl, `${date}_คาบ${periodLabel(period)}_${formatRoomName(subj0.roomId).replace(/\//g, '-')}_${String(subj0.name || '').replace(/[\\/:*?"<>|]/g, ' ')}.jpg`, hrFolderPath(subj0.term, subj0.year, subj0.roomId, 'substitute'), (pct, route) => hrBar(pct, route, false));
                    if (!res) { setAttSaveBtnState('failed'); setAttSaveBanner('error', 0, 'ส่งรูปการสอนแทนไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ตแล้วกดบันทึกอีกครั้ง'); return; }
                    np.uploaded = res; hrBar(100, res.route, true);
                }
                payloadData.subPhoto = { id: np.uploaded.id, at: new Date().toISOString() };
            }
            // ===== [v1.70] บันทึกแบบไม่บล็อกหน้าจอ: ปุ่มเปลี่ยนสถานะในตัว → ติ๊กเขียว → กลับหน้าเดิมเอง (ไม่ต้องกด "ตกลง") =====
            clearInterval(window.__attRetryTick); window.__attRetryTick = null;
            setAttSaveBtnState('saving'); setAttSaveBanner(null);
            const saveSuccess = await saveData('attendance', payloadData, null, { silent: true });
            window.__lastAttendanceSaveAt = Date.now();
            const failAndRetry = (title) => {
                // บันทึกไม่สำเร็จ: แจ้งในหน้าเดิม ข้อมูลที่เช็คไว้ยังอยู่ครบ และลองส่งให้เองอัตโนมัติ (สูงสุด 3 รอบ)
                window.__attRetryCount = (window.__attRetryCount || 0) + 1;
                setAttSaveBtnState('failed');
                if (window.__attRetryCount <= 3) {
                    let left = 5;
                    setAttSaveBanner('error', left, title);
                    window.__attRetryTick = setInterval(() => {
                        if (!document.getElementById('saveAttBtn')) { clearInterval(window.__attRetryTick); window.__attRetryTick = null; return; } // ออกจากหน้านี้ไปแล้ว
                        left--; if (left <= 0) { clearInterval(window.__attRetryTick); window.__attRetryTick = null; window.saveAttendance(fromTeacherDash, true); } else setAttSaveBanner('error', left, title);
                    }, 1000);
                } else setAttSaveBanner('error', 0, title);
            };
            if (!saveSuccess) { failAndRetry(); return; }
            // [v1.71.6] รูปการสอนแทนเดิมที่ถูกแทนที่ / ยกเลิกการสอนแทน → ย้ายลงถังขยะ Drive
            if (oldSubPhoto && (!payloadData.subPhoto || payloadData.subPhoto.id !== oldSubPhoto.id)) hrTrashPhotos([oldSubPhoto.id]);
            window.__subNewPhoto = null;
            await ensureAttendanceLoadedForRoom(subject.term, subject.year, subject.roomId, true);
            if (hrActive) {
                const hrOk = await hrSubmit(subject, date, (txt) => { const b = document.getElementById('saveAttBtn'); if (b) b.innerHTML = `<i class="fas fa-circle-notch fa-spin text-xl"></i> ${txt}`; });
                if (!hrOk) { failAndRetry('เช็คชื่อบันทึกแล้ว แต่ส่งบันทึก/รูปไม่สำเร็จ'); return; }
            }
            window.__attRetryCount = 0;
            setAttSaveBtnState('saved');
            const nowD = new Date(); const hhmm = String(nowD.getHours()).padStart(2, '0') + ':' + String(nowD.getMinutes()).padStart(2, '0');
            const doneMsg = `บันทึกคาบ ${periodLabel(period)} แล้ว · ${hhmm} น.`;
            const flashKey = `${currentSubjectId}|${period}|${date}`;
            const retState = window.__attReturnState;
            setTimeout(() => {
                // [v1.71.3] กลับไปหน้าห้องเรียนของวิชานั้นเสมอ (ถ้ามาจากหน้าห้องเดียวกันก็ย้อนกลับ ถ้ามาจากที่อื่นให้เปิดหน้าห้องแทนหน้าเช็คชื่อ)
                const dowSaved = getEffectiveDayOfWeek(date);
                if (retState && retState.view === 'classroom' && retState.roomId === subject.roomId) history.back();
                else navigate('classroom', { roomId: subject.roomId, dayIndex: (dowSaved >= 1 && dowSaved <= 5) ? dowSaved : null }, true);
                setTimeout(() => { showToast(doneMsg, 'success'); flashAttRow(flashKey); if (subject.systemType === 'morning') setTimeout(() => asmFocus(0), 500); }, 350); // [v2.02.2] เช็คแถวแล้ว = เลื่อนไปที่ปุ่มส่งรายงาน
            }, 850);
        };

        window.resetSubjectAttendance = async function(subjectId) {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่ล้างข้อมูลเช็คชื่อได้", "error"); return; }
            const subChk = subjects.find(s => s.id === subjectId);
            if (subChk && guardAttendanceLock(subChk.term, subChk.year)) return;
            showConfirm("ยืนยันการล้างข้อมูล", "ข้อมูลการเช็คชื่อทั้งหมดในวิชานี้จะถูกลบอย่างถาวรและไม่สามารถกู้คืนได้" + (subChk && (subChk.systemType === 'homeroom' || subChk.systemType === 'zone') ? " รวมถึงบันทึกกิจกรรมของคาบนี้" : "") + " ส่วนรูปที่แนบไว้ (กิจกรรม/สอนแทน) จะถูกย้ายลงถังขยะของ Google Drive (กู้คืนได้ภายใน 30 วัน) คุณแน่ใจหรือไม่?", async () => {
                showToast("กำลังล้างข้อมูล... (อัปเดตแบบเรียลไทม์)", "info"); 
                document.body.style.pointerEvents = 'none';
                const sub = subjects.find(s => s.id === subjectId);
                logAction('ล้างข้อมูลเช็คชื่อของวิชา', sub ? sub.name : subjectId);
                window.__lastSaveResult = null;
                await saveData('reset_subject', subjectId); 
                document.body.style.pointerEvents = 'auto'; 
                window.__hrLogsCache = {};
                const phr = window.__lastSaveResult || {};
                if (phr.photosFailed) showConfirm("ล้างข้อมูลแล้ว แต่ย้ายรูปไม่สำเร็จ", `ล้างข้อมูลเช็คชื่อเรียบร้อยแล้ว แต่ย้ายรูปลงถังขยะไม่สำเร็จ ${phr.photosFailed} รายการ — ตรวจสอบว่า Apps Script รูปโฮมรูม (HomeroomPhotoRelay) ยังใช้งานได้ หรือลบรูปในโฟลเดอร์ Google Drive เอง`, () => {}, 'ตกลง', true);
                else showToast("ล้างข้อมูลวิชาเรียบร้อยแล้ว", "success"); 
                openSubjectSummary(subjectId);
            });
        };

        // ===== [ใหม่] ล้างข้อมูลเช็คชื่อเฉพาะวันที่ต้องการ (ไม่กระทบวันอื่น) - ปลอดภัยกว่าล้างทั้งวิชา =====
        window.openResetByDateModal = async function(subjectId) {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่ล้างข้อมูลเช็คชื่อได้", "error"); return; }
            const subChk = subjects.find(s => s.id === subjectId);
            if (subChk && guardAttendanceLock(subChk.term, subChk.year)) return;
            showLoadingSpinnerModal("กำลังโหลดรายการวันที่", "กรุณารอสักครู่...");
            try {
                const res = await fetch(`${GOOGLE_APP_SCRIPT_URL}?action=get_subject_dates&subjectId=${subjectId}`);
                const data = await res.json();
                window.closeProgressModal();
                if (!data || data.status !== 'success' || !Array.isArray(data.dates) || data.dates.length === 0) {
                    showToast("ไม่พบข้อมูลเช็คชื่อของวิชานี้เลย", "error"); return;
                }
                const listHtml = data.dates.map(d => {
                    const dObj = new Date(d.date);
                    const thaiDate = isNaN(dObj) ? d.date : dObj.toLocaleDateString('th-TH', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
                    return `<button onclick="window.confirmResetSubjectDate('${subjectId}', '${d.date}', '${thaiDate.replace(/'/g, "\\'")}')" class="w-full flex items-center justify-between bg-white hover:bg-rose-50 border border-slate-200 hover:border-rose-300 rounded-lg px-3 py-2.5 text-left transition-colors"><span class="font-bold text-slate-700 text-sm">${thaiDate}</span><span class="text-xs text-slate-400 font-medium">${d.cnt} รายการ <i class="fas fa-chevron-right ml-1"></i></span></button>`;
                }).join('');
                const modalHtml = `<div id="resetByDateModal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[70] flex items-center justify-center p-4"><div class="bg-white rounded-3xl shadow-2xl w-full max-w-md max-h-[80vh] flex flex-col"><div class="p-5 border-b border-slate-100 flex items-center justify-between shrink-0"><h3 class="font-extrabold text-slate-800 text-base sm:text-lg flex items-center gap-2"><i class="fas fa-calendar-times text-orange-500"></i> เลือกวันที่ต้องการล้าง</h3><button onclick="document.getElementById('resetByDateModal').remove()" class="text-slate-400 hover:text-slate-600"><i class="fas fa-times text-xl"></i></button></div><div class="p-4 overflow-y-auto space-y-2">${listHtml}</div></div></div>`;
                document.body.insertAdjacentHTML('beforeend', modalHtml);
            } catch (e) {
                window.closeProgressModal();
                showToast("โหลดรายการวันที่ไม่สำเร็จ ลองใหม่อีกครั้ง", "error");
            }
        };
        window.confirmResetSubjectDate = function(subjectId, dateStr, thaiDateLabel) {
            const m = document.getElementById('resetByDateModal'); if (m) m.remove();
            showConfirm("ยืนยันการล้างข้อมูล", `ต้องการล้างข้อมูลเช็คชื่อของวันที่ ${thaiDateLabel} ทั้งหมดใช่หรือไม่? การลบนี้ไม่สามารถกู้คืนได้ (วันอื่นจะไม่ถูกกระทบ) — บันทึกกิจกรรมของวันนั้นจะถูกลบด้วย และรูปที่แนบไว้จะถูกย้ายลงถังขยะของ Google Drive (กู้คืนได้ภายใน 30 วัน)`, async () => {
                showLoadingSpinnerModal("กำลังล้างข้อมูล", "กรุณารอสักครู่...");
                const sub = subjects.find(s => s.id === subjectId);
                try {
                    const res = await fetch(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'reset_subject_date', subjectId, date: dateStr }) });
                    const data = await res.json();
                    window.closeProgressModal();
                    if (data && data.status === 'success') {
                        attendanceData = attendanceData.filter(a => !(a.subjectId === subjectId && a.date === dateStr));
                        logAction('ล้างข้อมูลเช็คชื่อเฉพาะวัน', `${sub ? sub.name : subjectId} - วันที่ ${dateStr}`);
                        window.__hrLogsCache = {};
                        if (data.photosFailed) showToast(`ล้างข้อมูลแล้ว แต่ย้ายรูปลงถังขยะไม่สำเร็จ ${data.photosFailed} รายการ`, "error");
                        else showToast("ล้างข้อมูลวันที่เลือกเรียบร้อยแล้ว", "success");
                        openSubjectSummary(subjectId);
                    } else {
                        showToast((data && data.message) || "ล้างข้อมูลไม่สำเร็จ", "error");
                    }
                } catch (e) {
                    window.closeProgressModal();
                    showToast("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้", "error");
                }
            }, "ยืนยันลบ");
        };

        function openSubjectSummary(subjectId, fromTeacherDash = false) {
            const isDarkNow = document.documentElement.classList.contains('dark');
            const subject = subjects.find(s => s.id === subjectId);
            if (!subject) return;
            const roomKeyForGate3 = roomAttKey_(subject.term, subject.year, subject.roomId);
            if (!(roomKeyForGate3 in window.__loadedRoomLastModified)) {
                document.getElementById('mainContent').innerHTML = `<div class="flex flex-col items-center justify-center py-20 sm:py-32"><i class="fas fa-spinner fa-spin text-4xl text-indigo-500 mb-4"></i><p class="text-slate-500 font-bold text-sm sm:text-base">กำลังโหลดข้อมูลห้อง ${formatRoomName(subject.roomId)}...</p></div>`;
                ensureAttendanceLoadedForRoom(subject.term, subject.year, subject.roomId).then(() => openSubjectSummary(subjectId, fromTeacherDash));
                return;
            }
            const roomStudents = getRoomStudents(subject.roomId).sort((a, b) => parseInt(a.number) - parseInt(b.number));
            const subjectAtt = attendanceData.filter(a => a.subjectId === subjectId).sort((a, b) => new Date(a.date) - new Date(b.date) || parseInt(a.period || 0) - parseInt(b.period || 0));
            let uniqueCols = []; subjectAtt.forEach(att => { const key = `${att.date}_${att.period}`; if (!uniqueCols.find(c => c.key === key)) { uniqueCols.push({ key, date: att.date, period: att.period, data: att.records, subTeacher: att.substituteTeacher, subAssign: att.subAssign || '' }); } });
            const totalClasses = uniqueCols.length;
            const backAction = 'history.back()';
            const isSummaryLocked = getTermStatus(subject.term, subject.year) === 'locked';
            const isSummaryAttendanceLocked = isAttendanceEntryLocked(subject.term, subject.year);
            const __sumActs = []; if (isAdmin && currentUser && currentUser.role === 'super_admin') { if (isSummaryLocked) __sumActs.push({ label: 'ล้าง', icon: 'fa-lock', tone: 'locked', disabled: true }); else { __sumActs.push({ label: 'ล้างทั้งวิชา', icon: 'fa-redo', tone: 'rose', onclick: `window.resetSubjectAttendance('${subjectId}')` }); __sumActs.push({ label: 'ล้างเฉพาะวัน', icon: 'fa-calendar-times', tone: 'orange', onclick: `window.openResetByDateModal('${subjectId}')` }); } }
            __sumActs.push(isSummaryAttendanceLocked ? { label: 'ล็อคแล้ว', icon: 'fa-lock', tone: 'locked', disabled: true } : { label: 'แก้ไขเช็คชื่อ', icon: 'fa-edit', tone: 'blue', onclick: `window.navigate('attendance', {subjectId: '${subjectId}', fromTeacherDash: ${fromTeacherDash}})` });
            __sumActs.push({ label: 'PDF', icon: 'fa-file-pdf', tone: 'purple', onclick: `window.downloadInfographicPDF('${subjectId}')` }, { label: 'Excel', icon: 'fa-file-excel', tone: 'emerald', onclick: `window.exportSubjectExcel('${subjectId}')` });
            let html = summaryHeaderHtml({ iconHtml: `<div class="w-12 h-12 sm:w-20 sm:h-20 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-full flex items-center justify-center text-white text-xl sm:text-3xl shadow-lg border-2 sm:border-4 ${isDarkNow ? 'border-[#141e33]' : 'border-white'} shrink-0"><i class="fas fa-book"></i></div>`, title: `${subject.name}`, subHtml: `<p class="text-slate-600 font-bold mt-1 sm:mt-2 flex flex-wrap items-center gap-1 sm:gap-3"><span class="bg-emerald-100 text-emerald-900 px-2 sm:px-4 py-0.5 sm:py-1.5 rounded-md sm:rounded-xl text-[10px] sm:text-sm shadow-sm">ห้อง ${formatRoomName(subject.roomId)}</span><span class="bg-slate-100 text-slate-700 px-2 sm:px-4 py-0.5 sm:py-1.5 rounded-md sm:rounded-xl text-[10px] sm:text-sm shadow-sm"><i class="fas fa-chalkboard-teacher mr-1"></i> ${subject.teacher || '-'}${subject.teacher2 ? ' / ' + subject.teacher2 : ''}</span>${internChipHtml(subject.id)}</p>`, backAction: backAction, actions: __sumActs });
            
            html += `<div class="bg-white rounded-[1.5rem] sm:rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden p-3 sm:p-8"><div class="flex flex-col sm:flex-row items-start sm:items-center justify-between mb-3 sm:mb-6 gap-2"><h3 class="text-lg sm:text-3xl font-extrabold text-slate-800 flex items-center gap-2"><i class="fas fa-table text-indigo-500"></i> บันทึกเวลาเรียน</h3><div class="bg-slate-100 px-3 py-1.5 sm:px-5 sm:py-3 rounded-xl text-slate-600 font-bold border border-slate-200 shadow-inner text-xs sm:text-base w-full sm:w-auto text-center"><i class="fas fa-history text-slate-400"></i> สอนแล้ว: <span class="text-indigo-600 text-base sm:text-2xl font-black">${totalClasses}</span> ครั้ง</div></div><div class="overflow-x-auto rounded-xl border border-slate-200 shadow-sm relative max-h-[600px] w-full"><table class="w-full text-left border-collapse min-w-[500px] sm:min-w-[700px] text-[10px] sm:text-sm"><thead class="sticky top-0 z-30 shadow-sm bg-slate-100"><tr class="bg-slate-100 text-slate-700 border-b-2 border-slate-300 uppercase tracking-wider"><th class="p-2 sm:p-4 font-extrabold w-[40px] sm:w-[60px] min-w-[40px] sm:min-w-[60px] text-center border-r border-slate-300 sticky left-0 bg-slate-100 z-20 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">เลขที่</th><th class="p-2 sm:p-4 font-extrabold w-[120px] sm:w-[200px] min-w-[120px] sm:min-w-[200px] border-r border-slate-300 sticky left-[40px] sm:left-[60px] bg-slate-100 z-20 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">ชื่อ-นามสกุล</th>`;
            if (totalClasses === 0) { html += `<th class="p-4 font-bold text-center text-slate-400">ยังไม่มีข้อมูล</th>`;
            } else { uniqueCols.forEach(col => { const d = new Date(col.date); html += `<th class="p-1 sm:p-2 font-extrabold text-center border-r border-slate-200 min-w-[50px] sm:min-w-[80px] bg-slate-50 relative group" title="${col.date}"><div class="text-[9px] sm:text-sm">${d.getDate()}/${d.getMonth()+1}</div><div class="text-[8px] sm:text-[10px] text-slate-500 bg-slate-200/70 px-1 py-0.5 rounded inline-block mt-0.5 border border-slate-300">ค.${col.period || '-'}</div>${col.subTeacher ? `<i class="fas fa-user-edit text-amber-500 absolute top-1 right-1 text-[8px]" title="สอนแทนโดย: ${col.subTeacher}"></i>` : ''}</th>`; });
            }
            html += `<th class="p-2 sm:p-4 font-extrabold text-center bg-emerald-100 text-emerald-900 border-l-2 border-emerald-300 min-w-[60px]">รวมมา</th></tr></thead><tbody class="divide-y divide-slate-100 font-medium">`;
            let subjectTotals = { 'มา': 0, 'ร่วมกิจกรรม': 0, 'สาย': 0, 'ลาป่วย': 0, 'ลากิจ': 0, 'ขาด': 0, 'โดดเรียน': 0 };
            roomStudents.forEach((st, idx) => {
                let validCount = 0; let lateCount = 0; let absentCount = 0;
                const percent = totalClasses > 0 ? Math.round((validCount/totalClasses)*100) : 0; const scoreColor = percent >= 80 ? 'text-emerald-700 bg-emerald-50' : (percent >= 50 ? 'text-amber-700 bg-amber-50' : 'text-rose-700 bg-rose-50');
                const isRes = st.status === 'resigned'; const rowBg = isRes ? 'bg-slate-100/60 opacity-80' : (idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'); const bgForSticky = isRes ? 'bg-slate-100' : (idx % 2 === 0 ? 'bg-white' : 'bg-slate-50');
                
                html += `<tr class="${rowBg} hover:bg-indigo-50/60 transition-colors"><td class="p-2 sm:p-4 text-center text-slate-600 border-r border-slate-200 font-black sticky left-0 z-10 ${bgForSticky} text-xs sm:text-base shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">${st.number}</td><td class="p-2 sm:p-4 text-slate-800 border-r border-slate-200 font-bold whitespace-nowrap sticky left-[40px] sm:left-[60px] z-10 ${bgForSticky} text-[10px] sm:text-sm shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">${st.name} ${isRes?'<span class="text-[8px] bg-rose-100 text-rose-700 px-1 rounded ml-1 border border-rose-200">ออก</span>':''}</td>`;
                if (totalClasses === 0) { html += `<td class="p-4 text-center text-slate-300">-</td>`;
                } else {
                    uniqueCols.forEach(col => {
                        const status = col.data[st.id] || '-'; if (status === 'มา' || status === 'ร่วมกิจกรรม') validCount++; if (status === 'สาย') lateCount++; if (status === 'ขาด') absentCount++;
                        if (!isRes && subjectTotals[status] !== undefined) subjectTotals[status]++;
                        let dotClass = 'bg-slate-200 text-slate-400'; if(status !== '-') dotClass = statuses[status].bg + ' border-' + statuses[status].activeBg.replace('bg-','') + ' ' + statuses[status].color;
                        html += `<td class="p-1 sm:p-2 text-center border-r border-slate-100" title="${status}">${status !== '-' ? `<div class="w-5 h-5 sm:w-7 sm:h-7 rounded-full mx-auto border-2 text-[8px] sm:text-[10px] flex items-center justify-center font-black ${dotClass} shadow-sm">${status.substring(0,1)}</div>` : '-'}</td>`;
                    });
                }
                
                let remarks = [];
                if (lateCount >= (settings.thresholds?.late||4)) remarks.push(`สาย ${lateCount}`); if (absentCount >= (settings.thresholds?.absent||4)) remarks.push(`ขาด ${absentCount}`);
                let remarkHtml = remarks.length > 0 ? `<div class="text-[8px] sm:text-[10px] text-rose-600 font-bold mt-1 bg-rose-50 rounded px-1.5 py-0.5 border border-rose-200 inline-block shadow-sm w-max whitespace-nowrap"><i class="fas fa-exclamation-circle"></i> ${remarks.join(', ')} ครั้ง</div>` : '';
                html += `<td class="p-2 sm:p-4 text-center font-black text-sm sm:text-xl ${scoreColor} border-l-2 border-emerald-200">${validCount} <span class="text-[8px] sm:text-[10px] font-bold text-slate-400">/ ${totalClasses}</span><br>${remarkHtml}</td></tr>`;
            });
            let subNotesList = uniqueCols.filter(c => c.subTeacher);
            let subNotesHtml = '';
            if (subNotesList.length > 0) {
                subNotesHtml = `<div class="mt-4 sm:mt-6 bg-amber-50 border border-amber-200 p-3 sm:p-4 rounded-xl shadow-inner"><h4 class="font-bold text-amber-800 text-xs sm:text-sm mb-2 flex items-center gap-2"><i class="fas fa-user-edit"></i> หมายเหตุ: การสอนแทน</h4><ul class="text-[10px] sm:text-xs text-amber-700 list-disc list-inside pl-2 sm:pl-5 space-y-1">`;
                subNotesList.forEach(c => { subNotesHtml += `<li>วันที่ ${c.date.split('-').reverse().join('/')} คาบ ${periodLabel(c.period)} - สอนแทนโดย <strong>${c.subTeacher}</strong>${c.subAssign === 'yes' ? ' <span class="inline-block bg-emerald-100 text-emerald-700 font-bold text-[10px] sm:text-xs px-2 py-0.5 rounded-full">มอบหมายงานไว้</span>' : c.subAssign === 'no' ? ' <span class="inline-block bg-rose-100 text-rose-700 font-bold text-[10px] sm:text-xs px-2 py-0.5 rounded-full">ไม่ได้มอบหมายงาน</span>' : ''}</li>`; }); // [v2.02.3]
                subNotesHtml += `</ul></div>`;
            }

            html += `</tbody></table></div><div class="mt-4 sm:mt-6 flex flex-wrap gap-1.5 sm:gap-3 text-[9px] sm:text-xs font-bold text-slate-600 justify-center bg-slate-50 border border-slate-200 p-2.5 sm:p-4 rounded-xl shadow-inner"><span class="mr-1 sm:mr-2 text-slate-400 flex items-center gap-1"><i class="fas fa-info-circle"></i> สัญลักษณ์:</span>${Object.entries(statuses).map(([name, style]) => `<div class="flex items-center gap-1 bg-white px-1.5 sm:px-2 py-0.5 sm:py-1 rounded-md border border-slate-200 shadow-sm"><div class="w-3 h-3 sm:w-5 sm:h-5 rounded-full border-2 border-${style.activeBg.replace('bg-','')} ${style.bg} ${style.color} flex items-center justify-center text-[7px] sm:text-[9px] font-black">${name.substring(0,1)}</div> <span>${name}</span></div>`).join('')}</div>${subNotesHtml}</div>`;
            const subjectTotalRecorded = Object.values(subjectTotals).reduce((a, b) => a + b, 0);
            html += `<div id="subjectChartInfographicSection" class="bg-white rounded-[1.5rem] sm:rounded-[2rem] shadow-sm border border-slate-200 p-4 sm:p-6 mt-4 sm:mt-6"><div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 mb-3"><h3 class="text-sm sm:text-lg font-extrabold text-slate-800 flex items-center gap-2"><i class="fas fa-chart-pie text-emerald-500"></i> กราฟสรุปสถิติการมาเรียนของวิชานี้</h3>${subjectTotalRecorded > 0 ? `<div class="flex gap-1.5"><button onclick="window.exportSectionInfographicPDF('subjectChartInfographicSection', 'กราฟวิชา_${subject.name}', 'pdf')" class="bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm shadow-sm flex items-center gap-1.5 transition-colors"><i class="fas fa-file-pdf"></i> PDF</button><button onclick="window.exportSectionInfographicPDF('subjectChartInfographicSection', 'กราฟวิชา_${subject.name}', 'image')" class="bg-pink-600 hover:bg-pink-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm shadow-sm flex items-center gap-1.5 transition-colors"><i class="fas fa-file-image"></i> รูปภาพ</button></div>` : ''}</div>${subjectTotalRecorded === 0 ? `<div class="text-center text-slate-400 py-8 text-xs sm:text-sm font-medium"><i class="fas fa-info-circle"></i> ยังไม่มีข้อมูลการเช็คชื่อ</div>` : `<div class="relative h-56 sm:h-72"><canvas id="subjectStatusChart"></canvas></div><div id="subjectStatusChartLegend" class="mt-4"></div>`}</div>`;
            document.getElementById('mainContent').innerHTML = html;
            if (subjectTotalRecorded > 0) makeStatusDoughnutChart('subjectStatusChart', subjectTotals);
        }

        function openStudentSummary(studentId, selectedMonth = null) {
            const isDarkNow = document.documentElement.classList.contains('dark');
            const student = students.find(s => s.id === studentId);
            if (!student) return;
            const roomKeyForGate4 = roomAttKey_(adminTerm(), adminYear(), student.roomId);
            if (!(roomKeyForGate4 in window.__loadedRoomLastModified)) {
                document.getElementById('mainContent').innerHTML = `<div class="flex flex-col items-center justify-center py-20 sm:py-32"><i class="fas fa-spinner fa-spin text-4xl text-indigo-500 mb-4"></i><p class="text-slate-500 font-bold text-sm sm:text-base">กำลังโหลดข้อมูลห้อง ${formatRoomName(student.roomId)}...</p></div>`;
                ensureAttendanceLoadedForRoom(adminTerm(), adminYear(), student.roomId).then(() => openStudentSummary(studentId, selectedMonth));
                return;
            }
            let currentDate = new Date(); if (!selectedMonth) { let month = (currentDate.getMonth() + 1).toString().padStart(2, '0');
                selectedMonth = `${currentDate.getFullYear()}-${month}`; }
            const roomName = formatRoomName(student.roomId), roomSubjects = getRoomSubjects(student.roomId);
            let dailyRaw = {}; attendanceData.forEach(record => { const sub = roomSubjects.find(s => s.id === record.subjectId); if (sub) { const status = record.records[studentId]; if (status) { if (!dailyRaw[record.date]) dailyRaw[record.date] = []; dailyRaw[record.date].push({ period: record.period || 1, status: status }); } } });
            let dailyRecords = {}; Object.keys(dailyRaw).forEach(date => { dailyRecords[date] = calculateDailyStatus(dailyRaw[date]); });
            const filteredDates = Object.keys(dailyRecords).filter(d => d.startsWith(selectedMonth)).sort();
            let monthlyStats = { 'มา':0, 'ร่วมกิจกรรม':0, 'สาย':0, 'ลาป่วย':0, 'ลากิจ':0, 'ขาด':0, 'โดดเรียน':0 };
            let weeklyStats = {};
            for(let i=1; i<=5; i++) weeklyStats[i] = { 'มา':0, 'ร่วมกิจกรรม':0, 'สาย':0, 'ลาป่วย':0, 'ลากิจ':0, 'ขาด':0, 'โดดเรียน':0 };
            filteredDates.forEach(d => { const status = dailyRecords[d].status; if(status && monthlyStats[status] !== undefined) monthlyStats[status]++; const week = getWeekOfMonth(d); if(status && weeklyStats[week][status] !== undefined) weeklyStats[week][status]++; });
            const monthNames = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
            const displayMonthYear = `${monthNames[parseInt(selectedMonth.split('-')[1])-1]} ${parseInt(selectedMonth.split('-')[0])+543}`;
            const statusBadge = student.status === 'resigned' ? `<span class="bg-rose-100 text-rose-800 px-2 py-0.5 rounded text-[10px] border border-rose-200 font-black">ออก/ย้าย</span>` : '';
            const backAction = 'history.back()';
            window.tempStudentReport = { student: student, room: roomName, month: selectedMonth, monthly: monthlyStats, weekly: weeklyStats, daily: dailyRecords, dates: filteredDates };
            let html = summaryHeaderHtml({ iconHtml: `<div class="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-blue-500 to-indigo-600 rounded-full flex items-center justify-center text-white text-2xl sm:text-3xl shadow-lg border-2 sm:border-4 ${isDarkNow ? 'border-[#141e33]' : 'border-white'} shrink-0"><i class="fas fa-user-graduate"></i></div>`, title: `${student.name}`, subHtml: `<p class="text-slate-600 font-bold mt-1 flex flex-wrap gap-1.5"><span class="bg-blue-100 text-blue-800 px-2 py-0.5 rounded text-[10px] sm:text-xs">เลขที่ ${student.number}</span><span class="bg-indigo-100 text-indigo-800 px-2 py-0.5 rounded text-[10px] sm:text-xs">ห้อง ${roomName}</span>${statusBadge}</p>`, backAction: backAction, controlsHtml: `<label class="block"><span class="text-[11px] sm:text-xs font-extrabold text-slate-500">ชนิดเอกสาร PDF</span><select id="studentPdfType" class="mt-1 w-full sm:w-auto h-10 bg-slate-50 border-2 border-slate-200 text-slate-700 rounded-xl px-3 font-bold text-sm outline-none"><option value="monthly">PDF สรุปรายเดือน</option><option value="weekly">PDF สรุปรายสัปดาห์</option><option value="daily">PDF บันทึกรายวัน</option></select></label>`, actions: [{ label: 'โหลด PDF', icon: 'fa-file-pdf', tone: 'purple', onclick: `window.downloadStudentPDF('${student.id}', '${selectedMonth}')` }, { label: 'Excel', icon: 'fa-file-excel', tone: 'emerald', onclick: `window.exportStudentExcel('${student.id}', '${selectedMonth}')` }] });
            html += `<div class="bg-slate-800 rounded-2xl sm:rounded-[2rem] shadow-xl p-4 sm:p-6 mb-4 sm:mb-8 flex flex-col sm:flex-row justify-between items-center gap-3 text-white relative overflow-hidden"><div class="absolute inset-0 bg-[url('https://www.transparenttextures.com/patterns/cubes.png')] opacity-10"></div><h3 class="text-base sm:text-xl font-extrabold flex items-center gap-2 relative z-10"><i class="far fa-calendar-check text-blue-400"></i> สถิติประจำเดือน: <span class="text-blue-300">${displayMonthYear}</span></h3><input type="month" value="${selectedMonth}" class="w-full sm:w-auto relative z-10 bg-slate-700/50 border border-slate-600 rounded-lg px-4 py-2 focus:ring-2 focus:ring-blue-400 font-bold text-sm outline-none" onchange="window.navigate('student_summary', {studentId: '${student.id}', month: this.value})"></div><div class="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-7 gap-2 sm:gap-4 mb-6 sm:mb-10">${Object.entries(monthlyStats).map(([name, count]) => { const style = statuses[name];
                return `<div class="bg-white border border-slate-200 rounded-xl sm:rounded-2xl p-3 sm:p-4 text-center flex flex-col items-center justify-center gap-1.5 relative overflow-hidden"><div class="absolute inset-0 bg-gradient-to-t from-${style.bg.replace('bg-','')} to-transparent opacity-50"></div><div class="w-8 h-8 sm:w-10 sm:h-10 ${style.bg} ${style.color} rounded-full flex items-center justify-center text-sm sm:text-lg mb-1 relative z-10 border ${style.border}"><i class="fas ${style.icon}"></i></div><div class="${style.color} text-[10px] sm:text-xs font-extrabold relative z-10">${name}</div><div class="text-2xl sm:text-4xl font-black text-slate-800 relative z-10">${count}</div></div>`;
            }).join('')}</div><div class="grid grid-cols-1 xl:grid-cols-2 gap-4 sm:gap-6"><div class="bg-white rounded-2xl border border-slate-200 overflow-hidden flex flex-col shadow-sm"><div class="p-3 sm:p-5 border-b border-slate-200 bg-slate-50 flex items-center gap-2"><div class="w-8 h-8 bg-blue-100 text-blue-600 rounded-lg flex items-center justify-center text-sm"><i class="fas fa-calendar-week"></i></div><h4 class="font-extrabold text-base sm:text-xl text-slate-800">สรุปรายสัปดาห์</h4></div><div class="overflow-x-auto w-full"><table class="w-full text-center text-[10px] sm:text-xs min-w-[400px]"><thead class="bg-white text-slate-500 border-b-2 border-slate-100"><tr><th class="p-2 sm:p-3">สัปดาห์</th><th class="p-2 text-emerald-600">มา</th><th class="p-2 text-cyan-600">กิจกรรม</th><th class="p-2 text-amber-500">สาย</th><th class="p-2 text-blue-500">ป่วย</th><th class="p-2 text-indigo-500">ลากิจ</th><th class="p-2 text-rose-500">ขาด</th><th class="p-2 text-purple-600">โดด</th></tr></thead><tbody class="divide-y divide-slate-100 font-bold">${[1,2,3,4,5].map(w => `<tr><td class="p-2 bg-slate-50/50">สัปดาห์ ${w}</td><td class="p-2 bg-emerald-50/30">${weeklyStats[w]['มา']||'-'}</td><td class="p-2 bg-cyan-50/30">${weeklyStats[w]['ร่วมกิจกรรม']||'-'}</td><td class="p-2 bg-amber-50/30">${weeklyStats[w]['สาย']||'-'}</td><td class="p-2 bg-blue-50/30">${weeklyStats[w]['ลาป่วย']||'-'}</td><td class="p-2 bg-indigo-50/30">${weeklyStats[w]['ลากิจ']||'-'}</td><td class="p-2 bg-rose-50/30">${weeklyStats[w]['ขาด']||'-'}</td><td class="p-2 bg-purple-50/30">${weeklyStats[w]['โดดเรียน']||'-'}</td></tr>`).join('')}</tbody></table></div></div><div class="bg-white rounded-2xl border border-slate-200 overflow-hidden flex flex-col shadow-sm"><div class="p-3 sm:p-5 border-b border-slate-200 bg-slate-50 flex items-center gap-2"><div class="w-8 h-8 bg-indigo-100 text-indigo-600 rounded-lg flex items-center justify-center text-sm"><i class="fas fa-history"></i></div><h4 class="font-extrabold text-base sm:text-xl text-slate-800">ประวัติรายวัน</h4></div><div class="overflow-y-auto max-h-[300px] p-2 sm:p-4 bg-slate-50/30">${filteredDates.length > 0 ? `<ul class="space-y-1.5 sm:space-y-2">${filteredDates.map(d => { const stat = dailyRecords[d].status; const style = statuses[stat]; return `<li class="p-2.5 sm:p-3 rounded-xl border border-slate-200 bg-white shadow-sm flex justify-between items-center"><div class="flex items-center gap-2"><div class="w-8 h-8 rounded-full bg-slate-100 flex items-center justify-center text-slate-500 text-xs"><i class="far fa-calendar-alt"></i></div><span class="font-extrabold text-slate-800 text-xs sm:text-sm">${d.split('-').reverse().join('/')}</span></div><span class="px-2 py-1 sm:px-3 sm:py-1.5 rounded-lg border-2 ${style.border} ${style.bg} ${style.color} text-[9px] sm:text-xs font-extrabold flex items-center gap-1"><i class="fas ${style.icon}"></i> ${stat}</span></li>`; }).join('')}</ul>` : `<div class="p-8 text-center text-slate-400 font-medium text-xs"><i class="fas fa-box-open text-2xl mb-2 opacity-50"></i> ไม่มีข้อมูลในเดือนนี้</div>`}</div></div></div>`;
            document.getElementById('mainContent').innerHTML = html;
        }

        // ===== [ใหม่] บันทึกติดตามพร้อมหมายเหตุ - ใช้แทน markFollowUp เดิมทุกจุด เพื่อให้บันทึกรายละเอียดการติดตามได้ (เช่น ครูที่ปรึกษารายงานว่าอย่างไร) =====
        window.markFollowUpWithNote = async function(studentId, month) {
            showPrompt("บันทึกการติดตาม", "รายละเอียดการติดตาม (เช่น ครูที่ปรึกษารายงานว่าอย่างไร, ติดต่อผู้ปกครองหรือยัง) - เว้นว่างได้ถ้าไม่มี", "", async (notes) => {
                showToast("กำลังบันทึกข้อมูล... (อัปเดตแบบเรียลไทม์)", "info");
                await saveData('followup', { studentId, month, timestamp: new Date().toISOString(), notes: (notes || '').trim() });
                showToast("บันทึกติดตามเรียบร้อยแล้ว", "success");
                renderAdminTab();
                if (currentRoomId) openRoomSummary(currentRoomId, month, 'monthly');
            });
        };

        function openRoomSummary(roomId, selectedMonth = null, tab = 'monthly') {
            const isDarkNow = document.documentElement.classList.contains('dark');
            // ===== [ใหม่] เช็คก่อนว่าโหลดข้อมูลเช็คชื่อของห้องนี้มาแล้วหรือยัง ถ้ายัง โหลดก่อนแล้วค่อยวาดหน้าใหม่ =====
            const roomKeyForGate2 = roomAttKey_(adminTerm(), adminYear(), roomId);
            if (!(roomKeyForGate2 in window.__loadedRoomLastModified)) {
                document.getElementById('mainContent').innerHTML = `<div class="flex flex-col items-center justify-center py-20 sm:py-32"><i class="fas fa-spinner fa-spin text-4xl text-indigo-500 mb-4"></i><p class="text-slate-500 font-bold text-sm sm:text-base">กำลังโหลดข้อมูลห้อง ${formatRoomName(roomId)}...</p></div>`;
                ensureAttendanceLoadedForRoom(adminTerm(), adminYear(), roomId).then(() => openRoomSummary(roomId, selectedMonth, tab));
                return;
            }
            let currentDate = new Date();
            if (!selectedMonth) { let month = (currentDate.getMonth() + 1).toString().padStart(2, '0'); selectedMonth = `${currentDate.getFullYear()}-${month}`;
            }
            const roomName = formatRoomName(roomId), roomStudents = getRoomStudents(roomId).sort((a,b) => parseInt(a.number) - parseInt(b.number)), roomSubjects = getRoomSubjects(roomId);
            const monthNames = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
            const displayMonthYear = `${monthNames[parseInt(selectedMonth.split('-')[1])-1]} ${parseInt(selectedMonth.split('-')[0])+543}`;
            const backAction = 'history.back()';
            let roomTotals = null;
            let html = summaryHeaderHtml({ iconHtml: `<div class="w-12 h-12 sm:w-16 sm:h-16 bg-gradient-to-br from-emerald-500 to-teal-600 rounded-xl flex items-center justify-center text-white text-xl sm:text-3xl shadow-lg shrink-0"><i class="fas fa-chart-bar"></i></div>`, title: `รายงานห้อง ${roomName}`, backAction: backAction, tabs: [{ label: 'สรุปรายเดือน', active: tab === 'monthly', onclick: `window.navigate('room_summary', {roomId: '${roomId}', month: '${selectedMonth}', tab: 'monthly'})` }, { label: 'สรุปรายวัน', active: tab === 'daily', onclick: `window.navigate('room_summary', {roomId: '${roomId}', month: '${selectedMonth}', tab: 'daily'})` }], actionsLabel: 'ดาวน์โหลดเอกสาร PDF', actions: tab === 'monthly' ? [{ label: 'สมุดทะเบียน', icon: 'fa-book', tone: 'indigo', onclick: `window.downloadRoomMonthlyRegisterPDF('${roomId}', '${selectedMonth}')` }, { label: 'สรุปเขตรับผิดชอบ', icon: 'fa-map-marked-alt', tone: 'teal', onclick: `window.downloadZoneSummaryPDF('${roomId}', '${selectedMonth}')` }, { label: 'สรุปโฮมรูม', icon: 'fa-users', tone: 'violet', onclick: `window.openHomeroomBookletChooser('${roomId}', '${selectedMonth}')` }]/* [v2.02.3] รายงานสอนแทนย้ายไปหลังบ้าน › รายงาน (Super Admin) */ : [] });

            if (tab === 'monthly') {
                const { studentSummaries, incompleteAttendanceList, roomTotals: computedRoomTotals } = computeRoomIncompleteList(roomId, selectedMonth);
                roomTotals = computedRoomTotals;
                window.tempRoomReport = { roomId: roomId, month: selectedMonth, data: studentSummaries, incompleteList: incompleteAttendanceList };
                const roomTotalRecorded = Object.values(roomTotals).reduce((a, b) => a + b, 0);
                html += `<div class="bg-white rounded-[1.5rem] sm:rounded-[2rem] shadow-sm border border-slate-200 overflow-hidden p-3 sm:p-8"><div class="flex flex-col md:flex-row justify-between items-start md:items-center mb-4 gap-3"><h3 class="text-lg sm:text-2xl font-extrabold text-slate-800 flex items-center gap-2"><i class="far fa-calendar-check text-indigo-500"></i> เดือน ${displayMonthYear}</h3><div class="flex flex-wrap gap-1.5 sm:gap-2 w-full md:w-auto"><input type="month" value="${selectedMonth}" onchange="window.navigate('room_summary', {roomId: '${roomId}', month: this.value, tab: 'monthly'})" class="flex-1 md:flex-none bg-slate-50 border border-slate-200 text-slate-700 px-2 py-1.5 sm:px-3 sm:py-2 rounded-lg text-base sm:text-sm font-bold outline-none"><button onclick="window.exportRoomMonthlyExcel('${roomId}', '${selectedMonth}')" class="flex-1 md:flex-none bg-emerald-600 hover:bg-emerald-700 text-white px-2 py-1.5 sm:px-4 sm:py-2 rounded-lg text-[10px] sm:text-sm font-bold shadow-sm flex gap-1.5 items-center justify-center transition-colors"><i class="fas fa-file-excel"></i> Excel</button></div></div><div class="overflow-x-auto rounded-xl border border-slate-200 shadow-sm max-h-[600px] w-full"><table class="w-full text-center border-collapse min-w-[700px] sm:min-w-[900px] text-[10px] sm:text-sm"><thead class="sticky top-0 z-30 shadow-sm bg-slate-100 text-slate-700 uppercase"><tr class="border-b border-slate-200"><th class="p-2 font-extrabold sticky left-0 z-20 bg-slate-100 border-r border-slate-300 w-[40px] sm:w-[60px] min-w-[40px] sm:min-w-[60px] text-center shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">เลขที่</th><th class="p-2 font-extrabold sticky left-[40px] sm:left-[60px] z-20 bg-slate-100 border-r border-slate-300 w-[150px] sm:w-[250px] min-w-[150px] sm:min-w-[250px] text-left shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">ชื่อ-นามสกุล / การติดตาม</th><th class="p-2 font-extrabold border-x border-slate-200 bg-slate-50" colspan="5">สัปดาห์ที่ (เข้าเรียน)</th><th class="p-2 font-extrabold bg-blue-50" colspan="7">รวมทั้งเดือน (วัน)</th></tr><tr class="border-b-2 border-slate-300"><th class="p-1 border-r border-slate-300 bg-slate-100 sticky left-0 z-20 top-[33px] sm:top-[41px]"></th><th class="p-1 border-r border-slate-300 bg-slate-100 sticky left-[40px] sm:left-[60px] z-20 top-[33px] sm:top-[41px]"></th><th class="p-1 border-x border-slate-200">1</th><th class="p-1 border-r border-slate-200">2</th><th class="p-1 border-r border-slate-200">3</th><th class="p-1 border-r border-slate-200">4</th><th class="p-1 border-r border-slate-200">5</th><th class="p-1 text-emerald-700">รวมมาเรียน</th><th class="p-1 text-cyan-700">กิจ</th><th class="p-1 text-amber-700">สาย</th><th class="p-1 text-blue-700">ป่วย</th><th class="p-1 text-indigo-700">ลากิจ</th><th class="p-1 text-rose-700">ขาด</th><th class="p-1 text-purple-700">โดด</th></tr></thead><tbody class="divide-y divide-slate-100 font-medium">`;
                if (studentSummaries.length === 0) { html += `<tr><td colspan="14" class="p-10 text-slate-400">ไม่มีข้อมูล</td></tr>`;
                } 
                else {
                    studentSummaries.forEach((row, idx) => {
                        const isRes = row.student.status === 'resigned'; const bg = isRes ? 'bg-slate-100/60 opacity-80' : (idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'); const bgForSticky = isRes ? 'bg-slate-100' : (idx % 2 === 0 ? 'bg-white' : 'bg-slate-50');
                        let valid = row.monthly['มา'] + row.monthly['ร่วมกิจกรรม'] + row.monthly['สาย'];
                        
                        let lateCount = row.monthly['สาย'] || 0; let absentCount = row.monthly['ขาด'] || 0;
                        let lateLimit = settings.thresholds?.late || 4; let absLimit = settings.thresholds?.absent || 4;
                        let incompleteTriggered = (row.triggerDatesThisMonth || []).length > 0;
                        let needsFollowUp = (lateCount >= lateLimit) || (absentCount >= absLimit) || incompleteTriggered;
                        let alertHtml = '';
            
                        if (needsFollowUp) {
                            const isFollowedUp = followUps.find(f => f.studentId === row.student.id && f.month === selectedMonth);
                            const incompleteNote = incompleteTriggered ? `<div class="mt-1 text-[9px] font-bold text-orange-700 bg-orange-100 border border-orange-200 px-1.5 py-0.5 rounded inline-flex items-center gap-1 shadow-sm w-max"><i class="fas fa-door-open"></i> เข้าเรียนไม่ครบ ${(settings.thresholds && settings.thresholds.incompleteDays) || 3} วัน ภายใน 1 สัปดาห์</div>` : '';
                            if (isFollowedUp) { alertHtml = `${incompleteNote}<div class="mt-1 text-[9px] font-bold text-emerald-700 bg-emerald-100 border border-emerald-200 px-1.5 py-0.5 rounded inline-flex items-center gap-1 shadow-sm"><i class="fas fa-check-circle"></i> ที่ปรึกษาติดตามแล้ว</div>`;
                            } 
                            else {
                                alertHtml = `${incompleteNote}<div class="mt-1 flex flex-col sm:flex-row items-start sm:items-center gap-1.5"><span class="text-[9px] font-bold text-rose-700 bg-rose-100 border border-rose-200 px-1.5 py-0.5 rounded inline-flex items-center gap-1 shadow-sm"><i class="fas fa-exclamation-triangle"></i> ต้องติดตาม</span>`;
                                if (isAdmin) { alertHtml += `<button onclick="window.markFollowUpWithNote('${row.student.id}', '${selectedMonth}')" class="text-[9px] bg-indigo-600 hover:bg-indigo-700 text-white px-2 py-0.5 rounded shadow-sm transition-colors border border-indigo-700"><i class="fas fa-clipboard-check"></i> บันทึกติดตาม</button>`;
                                }
                                alertHtml += `</div>`;
                            }
                        }

                        html += `<tr class="${bg} hover:bg-slate-100 transition-colors"><td class="p-1.5 sm:p-2 text-center sticky left-0 z-10 ${bgForSticky} border-r border-slate-200 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)] font-black text-slate-500">${row.student.number}</td><td class="p-1.5 sm:p-3 text-left sticky left-[40px] sm:left-[60px] z-10 ${bgForSticky} border-r border-slate-200 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)] font-bold text-[9px] sm:text-sm break-words"><div class="flex items-center flex-wrap">${row.student.name} ${isRes?'<span class="text-[8px] bg-rose-100 text-rose-700 px-1 rounded border border-rose-200 ml-1">ออก</span>':''}</div>${alertHtml}</td><td class="p-1.5">${row.weekly[1]||'-'}</td><td class="p-1.5">${row.weekly[2]||'-'}</td><td class="p-1.5">${row.weekly[3]||'-'}</td><td class="p-1.5">${row.weekly[4]||'-'}</td><td class="p-1.5 border-r border-slate-200">${row.weekly[5]||'-'}</td><td class="p-1.5 font-black text-emerald-600 bg-emerald-50/30">${valid||'-'}</td><td class="p-1.5 font-black text-cyan-600">${row.monthly['ร่วมกิจกรรม']||'-'}</td><td class="p-1.5 font-black text-amber-500">${row.monthly['สาย']||'-'}</td><td class="p-1.5 font-black text-blue-500">${row.monthly['ลาป่วย']||'-'}</td><td class="p-1.5 font-black text-indigo-500">${row.monthly['ลากิจ']||'-'}</td><td class="p-1.5 font-black text-rose-500">${row.monthly['ขาด']||'-'}</td><td class="p-1.5 font-black text-purple-600">${row.monthly['โดดเรียน']||'-'}</td></tr>`;
                    });
                }
                html += `</tbody></table></div>`;
                // ===== [ใหม่] คำชี้แจงใต้ตาราง บอกช่วงวันที่จริงของแต่ละสัปดาห์ (นับแบบปฏิทินจริง เริ่มวันจันทร์เสมอ) =====
                const [legendYear, legendMonth] = selectedMonth.split('-').map(Number);
                const weekRanges = getMonthWeekRanges(legendYear, legendMonth);
                html += `<div class="mt-2 px-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] sm:text-[11px] text-slate-400 font-medium"><span class="font-bold text-slate-500"><i class="far fa-calendar-alt"></i> ช่วงวันที่ของแต่ละสัปดาห์:</span>${[1,2,3,4,5].filter(w => weekRanges[w]).map(w => `<span>สัปดาห์ ${w} = วันที่ ${weekRanges[w].start}${weekRanges[w].end !== weekRanges[w].start ? '-' + weekRanges[w].end : ''}</span>`).join('')}</div>`;
                html += `</div>`;
                html += `<div id="roomChartInfographicSection" class="bg-white rounded-[1.5rem] sm:rounded-[2rem] shadow-sm border border-slate-200 p-4 sm:p-6 mt-4 sm:mt-6"><h3 class="text-sm sm:text-lg font-extrabold text-slate-800 flex items-center gap-2 mb-3"><i class="fas fa-chart-pie text-emerald-500"></i> กราฟสรุปสถิติการมาเรียนของห้อง เดือน${displayMonthYear}</h3>${roomTotalRecorded === 0 ? `<div class="text-center text-slate-400 py-8 text-xs sm:text-sm font-medium"><i class="fas fa-info-circle"></i> ยังไม่มีข้อมูลการเช็คชื่อในเดือนนี้</div>` : `<div class="relative h-64 sm:h-72"><canvas id="roomMonthlyChart"></canvas></div><div id="roomMonthlyChartLegend" class="mt-4"></div>`}</div>`;

                // ===== ส่วนแยก: นักเรียนที่ต้องติดตาม (รวม 2 เกณฑ์: เข้าเรียนไม่ครบ + สาย/ขาดเกินเกณฑ์ต่อเดือน) =====
                if (incompleteAttendanceList.length > 0) {
                    html += `<div class="mt-4 sm:mt-6 bg-orange-50 border-2 border-orange-200 rounded-2xl p-4 sm:p-6"><h3 class="text-base sm:text-lg font-extrabold text-orange-800 mb-1 flex items-center gap-2"><i class="fas fa-user-clock"></i> นักเรียนที่ต้องติดตาม (${incompleteAttendanceList.length} คน)</h3><p class="text-[10px] sm:text-xs text-orange-600 font-medium mb-4">รวม 2 เกณฑ์: (1) มาโรงเรียนแต่ขาดเรียนตั้งแต่ ${(settings.thresholds && settings.thresholds.incompletePeriods) || 4} คาบขึ้นไปในวันเดียวกัน ซ้ำตั้งแต่ ${(settings.thresholds && settings.thresholds.incompleteDays) || 3} วัน ภายใน 1 สัปดาห์ใดๆ (นับต่อเนื่องข้ามเดือนได้) และ (2) สาย/ขาด เกิน ${(settings.thresholds && settings.thresholds.late) || 4}/${(settings.thresholds && settings.thresholds.absent) || 4} วันต่อเดือนตามลำดับ</p><div class="space-y-2">${incompleteAttendanceList.map(row => { const isFollowedUp = followUps.find(f => f.studentId === row.student.id && f.month === selectedMonth); const triggerDatesDisplay = row.triggerDatesThisMonth.map(d => { const parts = d.split('-'); return `${parts[2]}/${parts[1]}`; }).join(', '); const reasonBadges = [ row.triggerDatesThisMonth.length > 0 ? `<span class="bg-orange-100 text-orange-700 border border-orange-200 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded"><i class="fas fa-door-open"></i> เข้าเรียนไม่ครบ (${triggerDatesDisplay})</span>` : '', row.lateExceeded ? `<span class="bg-amber-100 text-amber-700 border border-amber-200 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded"><i class="fas fa-clock"></i> สายเกินเกณฑ์ (${row.monthly['สาย']} วัน)</span>` : '', row.absentExceeded ? `<span class="bg-rose-100 text-rose-700 border border-rose-200 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded"><i class="fas fa-user-times"></i> ขาดเกินเกณฑ์ (${row.monthly['ขาด']} วัน)</span>` : '' ].filter(Boolean).join(' '); return `<div class="bg-white border border-orange-200 rounded-xl p-3"><div class="flex flex-wrap items-center justify-between gap-2"><div class="min-w-0"><span class="font-bold text-slate-800 text-xs sm:text-sm">${row.student.number}. ${row.student.name}</span><div class="flex flex-wrap gap-1 mt-1">${reasonBadges}</div></div>${isFollowedUp ? `<span class="text-[9px] sm:text-[10px] font-bold text-emerald-700 bg-emerald-100 border border-emerald-200 px-2 py-1 rounded-full shrink-0"><i class="fas fa-check-circle"></i> ติดตามแล้ว</span>` : (isAdmin ? `<button onclick="window.markFollowUpWithNote('${row.student.id}', '${selectedMonth}')" class="text-[9px] sm:text-[10px] bg-indigo-600 hover:bg-indigo-700 text-white px-2.5 py-1 rounded-full shadow-sm transition-colors font-bold shrink-0"><i class="fas fa-clipboard-check"></i> บันทึกติดตาม</button>` : `<span class="text-[9px] sm:text-[10px] font-bold text-rose-700 bg-rose-100 border border-rose-200 px-2 py-1 rounded-full shrink-0"><i class="fas fa-exclamation-triangle"></i> ต้องติดตาม</span>`)}</div>${isFollowedUp && isFollowedUp.notes ? `<div class="mt-2 pt-2 border-t border-orange-100 text-[10px] sm:text-xs text-slate-500"><i class="fas fa-sticky-note text-slate-400"></i> ${isFollowedUp.notes.replace(/</g,'&lt;')}</div>` : ''}</div>`; }).join('')}</div></div>`;
                }
            } 
            else if (tab === 'daily') {
                const todayStr = localDateStr();
                const displayDate = window.tempDailyDate || todayStr; const dObj = new Date(displayDate); const dayOfWeek = dObj.getDay();
                let dayIndexForSched = getEffectiveDayOfWeek(displayDate);
                const monday = new Date(dObj);
                const diffToMonday = dayOfWeek === 0 ? -6 : 1 - dayOfWeek; monday.setDate(dObj.getDate() + diffToMonday);
                const subjectsToday = [];
                roomSubjects.forEach(s => { if (s.schedules) { effSched(s).forEach(sch => { if (parseInt(sch.day) === dayIndexForSched) { subjectsToday.push({ ...s, period: parseInt(sch.period) }); } }); } });
                subjectsToday.sort((a,b) => a.period - b.period);
                const dailyAttRecords = attendanceData.filter(a => a.date === displayDate && subjectsToday.some(st => st.id === a.subjectId && String(st.period) === String(a.period)));
                let dayButtonsHtml = `<div class="flex flex-wrap gap-1 w-full mt-2 sm:mt-0 sm:w-auto justify-center bg-slate-50 p-1.5 rounded-lg border border-slate-200">`;
                for(let i=1; i<=5; i++) { let iterDate = new Date(monday); iterDate.setDate(monday.getDate() + (i-1)); let iterDateStr = localDateStr(iterDate);
                    let isActive = iterDateStr === displayDate; let activeCls = isActive ? 'bg-indigo-600 text-white shadow-md' : 'bg-transparent text-slate-600 hover:bg-slate-200';
                    dayButtonsHtml += `<button onclick="window.tempDailyDate='${iterDateStr}'; window.navigate('room_summary', {roomId: '${roomId}', month: '${selectedMonth}', tab: 'daily'})" class="px-2 py-1 sm:px-3 sm:py-1.5 rounded text-[10px] sm:text-sm font-bold transition-colors ${activeCls}">${daysLabel[i-1].replace('วัน','')}</button>`;
                }
                dayButtonsHtml += `</div>`;
                html += `<div class="bg-white rounded-[1.5rem] sm:rounded-[2rem] shadow-sm border border-slate-200 p-3 sm:p-8"><div class="flex flex-col mb-4 gap-2"><h3 class="text-lg sm:text-2xl font-extrabold text-slate-800 flex items-center gap-2"><i class="far fa-calendar-day text-indigo-500"></i> เช็คชื่อรวมรายวิชา</h3><div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-2"><div class="flex flex-col sm:flex-row gap-2 w-full md:w-auto"><input type="date" value="${displayDate}" onchange="window.tempDailyDate=this.value; window.navigate('room_summary', {roomId: '${roomId}', month: '${selectedMonth}', tab: 'daily'})" class="w-full sm:w-auto bg-slate-50 border border-slate-200 text-slate-700 px-3 py-1.5 rounded-lg text-[11px] sm:text-sm font-bold shadow-inner outline-none focus:ring-2 focus:ring-indigo-500">${dayButtonsHtml}</div><div class="flex gap-1.5 w-full md:w-auto mt-2 md:mt-0"><button onclick="window.downloadRoomDailyPDF('${roomId}', '${displayDate}')" class="flex-1 md:flex-none bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm shadow-sm flex gap-1 items-center justify-center transition-colors"><i class="fas fa-file-pdf"></i> PDF</button><button onclick="window.exportRoomDailyExcel('${roomId}', '${displayDate}')" class="flex-1 md:flex-none bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm shadow-sm flex gap-1 items-center justify-center transition-colors"><i class="fas fa-file-excel"></i> Excel</button></div></div></div><div class="overflow-x-auto rounded-xl border border-slate-200 shadow-sm max-h-[600px] w-full"><table class="w-full text-center border-collapse text-[10px] sm:text-sm min-w-[500px] sm:min-w-[800px]"><thead class="bg-slate-100 sticky top-0 z-30 shadow-sm border-b-2 border-slate-200"><tr><th class="p-2 font-extrabold sticky left-0 z-20 bg-slate-100 border-r border-slate-300 w-[40px] sm:w-[60px] min-w-[40px] sm:min-w-[60px] text-center shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">เลขที่</th><th class="p-2 font-extrabold sticky left-[40px] sm:left-[60px] z-20 bg-slate-100 border-r border-slate-300 w-[120px] sm:w-[200px] min-w-[120px] sm:min-w-[200px] text-left shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">ชื่อ-นามสกุล</th>`;
                if (subjectsToday.length === 0) { html += `<th class="p-2 text-slate-500">ไม่มีวิชาเรียนในวันนี้</th>`;
                } else { subjectsToday.forEach(sub => { html += `<th class="p-1 sm:p-2 border-r border-slate-200 bg-slate-50 min-w-[60px] sm:min-w-[80px]"><div class="font-extrabold text-indigo-700 break-words line-clamp-2 max-w-[100px] mx-auto leading-tight" title="${sub.name}">${sub.name}</div><div class="text-[8px] sm:text-[10px] text-slate-500 mt-0.5 bg-slate-200/50 rounded inline-block px-1 border border-slate-300">ค.${sub.period}</div></th>`; });
                }
                html += `</tr></thead><tbody class="divide-y divide-slate-100">`;
                if (roomStudents.length > 0) {
                    roomStudents.forEach((st, idx) => {
                        const isRes = st.status === 'resigned'; const bg = isRes ? 'bg-slate-100/60 opacity-80' : (idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/50'); const bgForSticky = isRes ? 'bg-slate-100' : (idx % 2 === 0 ? 'bg-white' : 'bg-slate-50');
                        html += `<tr class="${bg} hover:bg-slate-100 transition-colors"><td class="p-1.5 sm:p-2 text-center sticky left-0 z-10 ${bgForSticky} border-r border-slate-200 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)] font-black text-slate-500">${st.number}</td><td class="p-1.5 sm:p-2 text-left sticky left-[40px] sm:left-[60px] z-10 ${bgForSticky} border-r border-slate-200 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)] font-bold text-[9px] sm:text-sm break-words">${st.name} ${isRes?'<span class="text-[8px] bg-rose-100 text-rose-700 px-1 rounded border border-rose-200">ออก</span>':''}</td>`;
                        if (subjectsToday.length === 0) html += `<td>-</td>`;
                        else { subjectsToday.forEach(sub => { const attRecord = dailyAttRecords.find(a => a.subjectId === sub.id && String(a.period) === String(sub.period)); let statusStr = '-'; let displayHtml = '<span class="text-slate-300">-</span>'; if (attRecord && attRecord.records[st.id]) { statusStr = attRecord.records[st.id]; const stl = statuses[statusStr]; displayHtml = `<span class="${stl.color} font-bold text-[8px] sm:text-[10px] bg-white border ${stl.border} px-1 py-0.5 rounded shadow-sm whitespace-nowrap">${statusStr}</span>`; } html += `<td class="p-1 sm:p-2 border-r border-slate-100">${displayHtml}</td>`; });
                        }
                        html += `</tr>`;
                    });
                }
                html += `</tbody></table></div></div>`;
            }
            document.getElementById('mainContent').innerHTML = html;
            if (roomTotals) { const rSum = Object.values(roomTotals).reduce((a,b)=>a+b,0); if (rSum > 0) makeStatusDoughnutChart('roomMonthlyChart', roomTotals); }
        }

        window.__adminTermRoomsLoaded = new Set(); // "term_year" ที่เคยโหลดข้อมูลเช็คชื่อทุกห้องมาแล้ว (ใช้เฉพาะ 2 แท็บที่จำเป็นจริงๆ คือ "ติดตามครู" และสถิติในแท็บ "สำรองข้อมูล" - แท็บอื่นไม่ต้องใช้เลย)
        function renderAdmin() {
            const isSuperAdmin = currentUser && currentUser.role === 'super_admin';
            window.__pendingNotifs = computePendingNotifications();
            const notifCategoryLabels = { incomplete: 'ตารางเรียนไม่ครบ', duplicate: 'วิชาซ้ำกัน', nostudents: 'ยังไม่มีนักเรียน', noadvisor: 'ยังไม่มีครูที่ปรึกษา', nostaff: 'ยังไม่มีเจ้าหน้าที่ประจำห้อง', conflict: 'ตารางสอนชนกัน' };
            const notifCategoryIcons = { incomplete: 'fa-calendar-day', duplicate: 'fa-clone', nostudents: 'fa-user-slash', noadvisor: 'fa-id-badge', nostaff: 'fa-user-tie', conflict: 'fa-triangle-exclamation' };
            let notifHtml = '';
            if (window.__pendingNotifs.length > 0) {
                const notifExpanded = !!window.__notifBarExpanded;
                const byCategory = {};
                window.__pendingNotifs.forEach((n, idx) => { const cat = n.type || 'other'; if (!byCategory[cat]) byCategory[cat] = []; byCategory[cat].push({ ...n, idx }); });
                const categoryChipsHtml = Object.keys(byCategory).map(cat => `<span class="bg-white border border-amber-200 text-amber-800 text-[10px] sm:text-xs font-bold px-2 py-1 rounded-lg">${notifCategoryLabels[cat] || cat} (${byCategory[cat].length})</span>`).join('');
                const categoryDetailHtml = Object.keys(byCategory).map(cat => `<div class="mb-2 last:mb-0"><p class="text-[10px] sm:text-xs font-black text-amber-700 mb-1.5 flex items-center gap-1.5"><i class="fas ${notifCategoryIcons[cat] || 'fa-info-circle'}"></i> ${notifCategoryLabels[cat] || cat} (${byCategory[cat].length})</p><div class="flex flex-wrap gap-1.5 pl-1">${byCategory[cat].map(n => `<button onclick="window.goToNotification(${n.idx})" class="bg-white border border-amber-200 hover:bg-amber-100/60 text-slate-700 text-[10px] sm:text-xs font-bold px-2.5 py-1.5 rounded-lg transition-colors">${n.text}</button>`).join('')}</div></div>`).join('');
                notifHtml = `<div class="mb-4 sm:mb-6 bg-amber-50 border-2 border-amber-300 rounded-2xl p-3 sm:p-5"><button onclick="window.toggleNotifBar()" class="w-full flex items-center justify-between gap-2 text-left"><h3 class="text-xs sm:text-base font-extrabold text-amber-800 flex items-center gap-2"><i class="fas fa-bell"></i> แถบแจ้งเตือนที่รอการแก้ไข (${window.__pendingNotifs.length})</h3><i class="fas fa-chevron-${notifExpanded ? 'up' : 'down'} text-amber-500"></i></button>${notifExpanded ? `<div class="mt-3 pt-3 border-t border-amber-200">${categoryDetailHtml}</div>` : `<div class="flex flex-wrap gap-1.5 mt-2.5">${categoryChipsHtml}</div>`}</div>`;
            } else {
                notifHtml = `<div class="mb-4 sm:mb-6 bg-emerald-50 border-2 border-emerald-300 rounded-2xl p-3 sm:p-5 flex items-center gap-2.5"><i class="fas fa-circle-check text-emerald-500 text-lg sm:text-xl"></i><h3 class="text-xs sm:text-base font-extrabold text-emerald-800">ข้อมูลครบพร้อมใช้งาน</h3></div>`;
            }
            let html = notifHtml + `<div class="mb-4 sm:mb-8 flex flex-col md:flex-row md:items-center justify-between gap-3"><div><h2 class="text-xl sm:text-4xl font-extrabold text-slate-800 tracking-tight flex items-center gap-2"><i class="fas fa-tools text-indigo-500"></i> จัดการระบบ</h2>${currentUser ? `<p class="text-xs sm:text-sm text-slate-500 font-bold mt-1">เข้าสู่ระบบในชื่อ: ${currentUser.name} <span class="ml-1 ${currentUser.role === 'super_admin' ? 'bg-purple-100 text-purple-700 border-purple-200' : 'bg-indigo-100 text-indigo-700 border-indigo-200'} border px-2 py-0.5 rounded-full text-[10px] font-black">${currentUser.role === 'super_admin' ? 'Super Admin' : 'เจ้าหน้าที่'}</span></p>` : ''}</div></div><div class="mb-4 sm:mb-6 bg-indigo-50 border border-indigo-200 rounded-2xl px-3 sm:px-5 py-2.5 sm:py-3 flex flex-col gap-2.5"><div class="flex items-center gap-2 text-indigo-700 font-bold text-xs sm:text-sm"><i class="fas fa-user-edit"></i> คุณกำลังจัดการข้อมูลภาคเรียน ${adminTerm()}/${adminYear()} <span class="text-[9px] sm:text-[11px] font-medium text-indigo-500">(เฉพาะหน้าจอของคุณเอง ไม่กระทบสิ่งที่ผู้ใช้ทั่วไปเห็นที่หน้าแรกซึ่งยังเป็นภาคเรียน ${settings.term}/${settings.year})</span></div><div class="flex flex-wrap items-center gap-2"><div class="flex items-center gap-1.5 bg-white p-1 rounded-lg border border-indigo-200 w-max"><span class="text-[9px] sm:text-[10px] font-black text-indigo-400 pl-1.5 pr-0.5 uppercase">ภาคเรียน</span>${Array.from({length: settings.termCount === 3 ? 3 : 2}, (_, i) => i + 1).map(tn => `<button onclick="window.setAdminWorkingTerm('${tn}')" class="${String(adminTerm()) === String(tn) ? 'bg-indigo-600 text-white shadow-sm' : 'text-indigo-600 hover:bg-indigo-50'} px-2.5 sm:px-3 py-1 rounded-md font-bold text-[10px] sm:text-xs transition-all">${tn}</button>`).join('')}</div><div class="flex items-center gap-1.5 bg-white p-1 rounded-lg border border-indigo-200 w-max"><span class="text-[9px] sm:text-[10px] font-black text-indigo-400 pl-1.5 pr-0.5 uppercase">ปี</span>${sortedAcademicYears().map(y => `<button onclick="window.setAdminWorkingYear('${y.year}')" class="${String(adminYear()) === String(y.year) ? 'bg-indigo-600 text-white shadow-sm' : 'text-indigo-600 hover:bg-indigo-50'} px-2.5 sm:px-3 py-1 rounded-md font-bold text-[10px] sm:text-xs transition-all flex items-center gap-1">${y.year}${y.status === 'archived' ? '<i class="fas fa-lock text-[8px]"></i>' : ''}</button>`).join('')}</div></div></div><div class="mb-4 sm:mb-6"><p class="text-[10px] sm:text-xs font-black text-slate-400 uppercase tracking-wider mb-1.5 pl-1"><i class="fas fa-sliders-h"></i> ตั้งค่าระบบ (ใช้ร่วมกันทุกภาคเรียน/ทุกปี)</p><div class="flex flex-wrap gap-1.5 bg-slate-200/50 p-1.5 rounded-xl w-full shadow-inner"><button onclick="window.navigate('admin', {tab: 'settings'})" class="${currentAdminTab === 'settings' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-cog text-indigo-500"></i> ตั้งค่าทั่วไป</button><button onclick="window.navigate('admin', {tab: 'term_settings'})" class="${currentAdminTab === 'term_settings' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-calendar-alt text-purple-500"></i> ตั้งค่าภาคเรียน</button><button onclick="window.navigate('admin', {tab: 'data_health'})" class="${currentAdminTab === 'data_health' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-hdd text-blue-500"></i> สถานะข้อมูลระบบ</button><button onclick="window.navigate('admin', {tab: 'holidays'})" class="${currentAdminTab === 'holidays' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-calendar-times text-rose-500"></i> วันหยุดและประกาศ</button><button onclick="window.navigate('admin', {tab: 'backup'})" class="${currentAdminTab === 'backup' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-shield-alt text-emerald-500"></i> สำรองข้อมูล</button>${isSuperAdmin ? `<button onclick="window.navigate('admin', {tab: 'users'})" class="${currentAdminTab === 'users' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-user-cog text-amber-500"></i> ผู้ใช้งาน</button>` : ''}<button onclick="window.navigate('admin', {tab: 'logs'})" class="${currentAdminTab === 'logs' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-history text-slate-500"></i> Log</button></div></div><div class="mb-4 sm:mb-8"><p class="text-[10px] sm:text-xs font-black text-slate-400 uppercase tracking-wider mb-1.5 pl-1"><i class="fas fa-layer-group"></i> ข้อมูลรายภาคเรียน/รายปี (ภาคเรียน ${adminTerm()}/${adminYear()})</p><div class="flex flex-wrap gap-1.5 bg-slate-200/50 p-1.5 rounded-xl w-full shadow-inner"><button onclick="window.navigate('admin', {tab: 'data_status'})" class="${currentAdminTab === 'data_status' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-database text-teal-500"></i> ความพร้อมของข้อมูล</button><button onclick="window.navigate('admin', {tab: 'student_followup'})" class="${currentAdminTab === 'student_followup' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-user-graduate text-orange-500"></i> ติดตามนักเรียน</button>${isSuperAdmin ? `<button onclick="window.navigate('admin', {tab: 'teacher_log'})" class="${currentAdminTab === 'teacher_log' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-user-clock text-rose-500"></i> ติดตามครู</button><button onclick="window.navigate('admin', {tab: 'att_report'})" class="${currentAdminTab === 'att_report' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-file-pdf text-red-500"></i> รายงาน</button>` : ''}<button onclick="window.navigate('admin', {tab: 'teachers'})" class="${currentAdminTab === 'teachers' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-chalkboard-teacher text-orange-500"></i> ครู</button><button onclick="window.navigate('admin', {tab: 'advisors'})" class="${currentAdminTab === 'advisors' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-id-badge text-pink-500"></i> ครูที่ปรึกษา</button><button onclick="window.navigate('admin', {tab: 'subjects'})" class="${currentAdminTab === 'subjects' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-book text-cyan-500"></i> วิชา</button><button onclick="window.navigate('admin', {tab: 'students'})" class="${currentAdminTab === 'students' ? 'bg-white shadow-md text-indigo-700' : 'text-slate-600 hover:bg-white/50'} px-3 sm:px-5 py-2 sm:py-2.5 rounded-lg transition-all text-[10px] sm:text-sm font-bold whitespace-nowrap flex items-center gap-1.5 shrink-0"><i class="fas fa-users text-violet-500"></i> นักเรียน</button></div></div><div id="adminContent" class="bg-white rounded-2xl sm:rounded-[2rem] shadow-sm border border-slate-200 p-4 sm:p-8 w-full"></div>`;
            document.getElementById('mainContent').innerHTML = html; renderAdminTab();
        }
        // สลับภาคเรียนที่แอดมินกำลังจัดการอยู่ในหน้าแอดมิน - เป็นการตั้งค่าเฉพาะเครื่อง/เซสชันของแอดมินคนนี้เท่านั้น
        // ไม่บันทึก log และไม่ส่งข้อมูลขึ้นเซิร์ฟเวอร์ จึงไม่กระทบสิ่งที่ผู้ใช้ทั่วไปเห็นที่หน้าแรก และแอดมินแต่ละคนสลับภาคเรียนกันได้อิสระ
        // ===== [ใหม่] โหลดข้อมูลเช็คชื่อของภาคเรียน/ปีอื่น (นอกเหนือจากภาคเรียน/ปีปัจจุบันที่โหลดมาตอนเปิดเว็บ) แบบ on-demand =====
        // ใช้ตอนแอดมินสลับไปดู/จัดการภาคเรียน-ปีอื่นที่ไม่ใช่ภาคเรียนปัจจุบัน จะได้ไม่ต้องโหลดข้อมูลทุกภาคเรียนทุกปีมาตั้งแต่ต้น (ทำให้เว็บช้า)
        // ===== [ใหม่] โหลดข้อมูลเช็คชื่อแบบ on-demand ทีละ "ห้อง" (ไม่ใช่ทั้งภาคเรียนเหมือนเดิม) - เบากว่ามาก =====
        // เช็คก่อนด้วย endpoint เบาๆ (get_attendance_meta) ว่าไฟล์ห้องนี้มีการแก้ไขล่าสุดเมื่อไหร่ ถ้าตรงกับที่มีอยู่แล้วในเครื่อง ข้ามไปเลย ไม่โหลดซ้ำ
        window.__loadedRoomLastModified = {}; // key: "term_year_roomId" -> timestamp ล่าสุดที่โหลดมา
        window.__loadedRoomsList = []; // [{term, year, roomId}] - เก็บแยกไว้ต่างหาก (แม่นยำกว่าแกะจาก key string) ใช้ตอน realtime sync เช็คทุกห้องที่เคยโหลด
        function roomAttKey_(term, year, roomId) { return String(term) + '_' + String(year) + '_' + String(roomId); }
        // ===== [v1.70] มีการเช็คชื่อใหม่จากเครื่องอื่น: ถ้ากำลังเปิดหน้าห้องนั้นอยู่ วาดหน้าใหม่ + แถวกะพริบ + ป้ายเล็กด้านบน =====
        function notifyRealtimeAttendanceChanges(roomId, changes) {
            const st = history.state;
            if (!st || st.view !== 'classroom' || st.roomId !== roomId) return;
            if (document.querySelector('.fixed.inset-0:not(.hidden)')) return; // มีป็อปอัพเปิดอยู่ ไม่รบกวน
            try { safeRenderState(st); } catch (e) { return; }
            const shown = changes.filter(c => document.querySelector(`[data-att-key="${c.subjectId}|${c.period}|${c.date}"]`));
            shown.forEach(c => flashAttRow(`${c.subjectId}|${c.period}|${c.date}`));
            if (shown.length === 1) { const c = shown[0]; showRealtimeChip(`${c.checkedBy ? c.checkedBy + ' ' : ''}เช็คชื่อคาบ ${periodLabel(c.period)} แล้ว`); }
            else if (shown.length > 1) showRealtimeChip(`มีการเช็คชื่อใหม่ ${shown.length} คาบ`);
        }
        async function ensureAttendanceLoadedForRoom(term, year, roomId, forceCheck = false, skipMeta = false) {
            const key = roomAttKey_(term, year, roomId);
            if (!forceCheck) { (window.__roomLastUse = window.__roomLastUse || {})[key] = Date.now(); (window.__viewRoomKeys = window.__viewRoomKeys || new Set()).add(key); } // [v1.74.3] ห้องที่แสดงอยู่ในหน้านี้
            const alreadyLoaded = key in window.__loadedRoomLastModified;
            if (alreadyLoaded && !forceCheck) return; // เคยโหลดแล้ว และไม่ได้บังคับให้เช็คซ้ำ - ข้ามเลย
            try {
                if (alreadyLoaded && !skipMeta) {
                    // เคยโหลดแล้ว แค่เช็คว่ามีการแก้ไขใหม่ไหม (payload เล็กมาก) ก่อนตัดสินใจโหลดเต็ม
                    const metaRes = await fetch(`${GOOGLE_APP_SCRIPT_URL}?action=get_attendance_meta&term=${encodeURIComponent(term)}&year=${encodeURIComponent(year)}&room=${encodeURIComponent(roomId)}`);
                    const meta = await metaRes.json();
                    if (meta && meta.status === 'success' && meta.lastModified === window.__loadedRoomLastModified[key]) return; // ไม่มีอะไรเปลี่ยน - ไม่ต้องโหลดเต็ม
                }
                const res = await fetch(`${GOOGLE_APP_SCRIPT_URL}?action=get_attendance&term=${encodeURIComponent(term)}&year=${encodeURIComponent(year)}&room=${encodeURIComponent(roomId)}`);
                const data = await res.json();
                if (data && data.status === 'success' && Array.isArray(data.attendanceData)) {
                    // ล้างข้อมูลเก่าของห้องนี้ออกก่อน (เผื่อมีการลบ record ไปฝั่งเซิร์ฟเวอร์) แล้วแทนที่ด้วยชุดล่าสุด - ไม่กระทบข้อมูลห้องอื่นที่โหลดไว้อยู่แล้ว
                    const roomSubjectIds = new Set(subjects.filter(s => s.roomId === roomId).map(s => s.id));
                    const __before = {}; attendanceData.forEach(a => { if (roomSubjectIds.has(a.subjectId)) __before[a.subjectId + '|' + a.period + '|' + a.date] = a.checkedAt || a.createdAt || ''; });
                    attendanceData = attendanceData.filter(a => !roomSubjectIds.has(a.subjectId));
                    attendanceData.push(...data.attendanceData);
                    if (!window.__loadedRoomsList.some(x => roomAttKey_(x.term, x.year, x.roomId) === key)) window.__loadedRoomsList.push({ term, year, roomId });
                    if (window.__syncSeen && data.syncV !== undefined) window.__syncSeen.rooms[key] = data.syncV; // [v1.74.3]
                    window.__loadedRoomLastModified[key] = data.lastModified || Date.now();
                    if (alreadyLoaded) {
                        const changes = data.attendanceData.filter(a => { const k = a.subjectId + '|' + a.period + '|' + a.date; return !(k in __before) || __before[k] !== (a.checkedAt || a.createdAt || ''); });
                        if (changes.length > 0) notifyRealtimeAttendanceChanges(roomId, changes);
                    }
                }
            } catch (e) { /* เน็ตมีปัญหา - ข้อมูลห้องนี้อาจยังไม่ครบ แต่ไม่ทำให้ทั้งระบบล่ม ลองใหม่ได้ */ }
        }
        // ใช้เฉพาะ 2 แท็บที่ต้องดูภาพรวม "ทุกห้อง" ของภาคเรียนนั้นจริงๆ (ติดตามครู, สถิติในแท็บสำรองข้อมูล) - โหลดทีละห้องแต่ยิงพร้อมกันได้ (Promise.all) พร้อมรายงานความคืบหน้าจริงผ่าน onProgress
        async function ensureAttendanceLoadedForAllRoomsInTerm(term, year, onProgress = null) {
            const roomIds = [...new Set(subjects.filter(s => String(s.term) === String(term) && String(s.year) === String(year)).map(s => s.roomId))];
            roomIds.forEach(r => (window.__viewRoomKeys = window.__viewRoomKeys || new Set()).add(roomAttKey_(term, year, r))); // [v1.74.3] หน้าภาพรวมทุกห้อง
            let doneCount = 0;
            await Promise.all(roomIds.map(r => ensureAttendanceLoadedForRoom(term, year, r).then(() => { doneCount++; if (onProgress) onProgress(doneCount, roomIds.length); })));
        }
        // ===== [v1.77] รายงานการเช็คชื่อประจำสัปดาห์ (Super Admin) — วาดหน้ารายงานจากข้อมูลเดียวกับปุ่ม "เช็คแล้ว" (สีเขียว) ในหน้าห้องเรียน =====
        // นับทุกคาบที่มีในตารางสอน (รวม A/B/โฮมรูม) · ไม่นับ: วันหยุด/ครึ่งวันที่หยุด · คาบหยุดเรียนจาก AcademicHub · คาบที่ยังไม่ถึงเวลา · คาบกิจกรรมที่ไม่ได้เช็ค
        const WR_TH_M = ['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'], WR_TH_D = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์'], WR_TH_DS = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.'];
        const wrEsc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
        const wrD = (ds) => { const p = ds.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]); };
        const wrAdd = (ds, n) => { const d = wrD(ds); d.setDate(d.getDate() + n); return localDateStr(d); };
        const wrThai = (ds, withYear) => { const d = wrD(ds); return d.getDate() + ' ' + WR_TH_M[d.getMonth()] + (withYear ? ' ' + (d.getFullYear() + 543) : ''); };
        const wrCls = (p) => p >= 90 ? '#16a34a' : (p >= 75 ? '#d97706' : '#dc2626');
        function wrDefaultMonday() { const t = new Date(); const dow = t.getDay() || 7; const m = new Date(t); m.setDate(t.getDate() - (dow - 1)); if (dow < 5) m.setDate(m.getDate() - 7); return localDateStr(m); } // จันทร์–พฤหัส = สัปดาห์ที่แล้ว · ศุกร์–อาทิตย์ = สัปดาห์นี้
        function wrState() { if (!window.__wr) window.__wr = { monday: wrDefaultMonday(), grades: [], sum: true, rooms: true }; return window.__wr; }
        function wrWeekDates(monday) { const out = []; for (let i = 0; i < 7; i++) { const ds = wrAdd(monday, i); if (i < 5) out.push(ds); else { const h = getHolidayForDate(ds); if (h && h.type === 'makeup') out.push(ds); } } return out; }
        function wrRooms(term, year, grades) { const has = new Set(activeSubjects(term, year).map(s => s.roomId)); return getRoomList().filter(r => has.has(r) && (!grades.length || grades.includes((/^m(\d)_/.exec(r) || [])[1]))); }
        // [v2.00.1] ครูที่แจ้งไปราชการ / ลา (AcademicHub) — คาบที่ไม่ได้เช็คในวันนั้นเป็นสีเทา ไม่นับ
        window.__wrLeaves = window.__wrLeaves || {};
        window.__wrLeavesAt = window.__wrLeavesAt || {};
        function wrLeavesFor(monday) { if (window.__wrLeaves[monday] && Date.now() - (window.__wrLeavesAt[monday] || 0) > 600000) { delete window.__wrLeaves[monday]; return null; } return window.__wrLeaves[monday] || null; } // [v2.00.3] เก่ากว่า 10 นาที = โหลดใหม่
        window.__wrLeavesP = window.__wrLeavesP || {};
        function wrLoadLeaves(monday) {
            if (wrLeavesFor(monday)) return Promise.resolve();
            if (window.__wrLeavesP[monday]) return window.__wrLeavesP[monday];
            return (window.__wrLeavesP[monday] = (async () => {
                let items = [];
                try { const r = await fetch(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'hub_leaves', from: monday, to: wrAdd(monday, 6) }) }); const j = await r.json(); if (j && j.status === 'success') items = j.items || []; } catch (e) { items = []; }
                window.__wrLeaves[monday] = items; window.__wrLeavesAt[monday] = Date.now(); delete window.__wrLeavesP[monday];
                if (!items.length) return;
                const v = (history.state || {}).view;
                if (document.querySelector('[onclick="window.exportWeeklyReport()"]')) renderAdminTab();
                else if (v === 'classroom' && history.state.roomId === currentRoomId) openClassroom(history.state.roomId, history.state.dayIndex); // [v2.00.3] ป้ายไปราชการ / ลา
                else if (v === 'attendance' && typeof window.__lvAttRefresh === 'function') window.__lvAttRefresh();
            })());
        }
        // [v2.00.3] ครูของคาบ (วิชา = ครูผู้สอน 1–2 คน · คาบระบบ = ครูที่ปรึกษา) + ใครแจ้งไปราชการ / ลา
        function lvTeachersOf(s) { return (s.systemType ? getRoomAdvisors(s.roomId, s.term, s.year) : [s.teacher, s.teacher2]).map(n => String(n || '').trim()).filter(Boolean); }
        function lvHubOf() { const m = {}; (teachers || []).forEach(t => { if (t.hubId) m[String(t.name || '').trim()] = t.hubId; }); return m; }
        function lvWho(lv, s, ds, p) { // [{ name, label, periods }] ของครูในคาบนี้ที่แจ้งไว้
            if (!lv || !lv.length || !s) return [];
            const hub = lvHubOf();
            return lvTeachersOf(s).map(n => { const l = hub[n] && lv.find(x => x.hubId === hub[n] && x.date === ds && (!x.periods || !x.periods.length || x.periods.includes(Number(p)))); return l ? { name: n, label: l.label || 'ไปราชการ', periods: l.periods || [] } : null; }).filter(Boolean);
        }
        function wrLeaveOf(lv, s, ds, p) { const w = lvWho(lv, s, ds, p), all = lvTeachersOf(s); return w.length && w.length === all.length ? w[0] : null; } // ครูทุกคนของคาบนั้นแจ้งไว้
        function lvMonday(ds) { const d = wrD(ds), dw = d.getDay() || 7; return wrAdd(ds, 1 - dw); }
        function lvPeriodsTxt(ps) { if (!ps || !ps.length) return ''; const L = ps.map(periodLabel); return ' (คาบ ' + L.join(', ') + ')'; }
        function lvBadge(w) { const sick = /ป่วย/.test(w.label), per = /กิจ/.test(w.label); return `<span class="inline-flex items-center gap-1 ${sick ? 'bg-blue-50 border-blue-200 text-blue-700' : per ? 'bg-indigo-50 border-indigo-200 text-indigo-700' : 'bg-slate-100 border-slate-300 text-slate-600'} border rounded-full px-1.5 sm:px-2 py-0.5 text-[8px] sm:text-xs font-extrabold whitespace-nowrap"><i class="fas fa-user-clock"></i> ${w.label}${lvPeriodsTxt(w.periods)}</span>`; }
        function wrCompute(term, year, monday, grades) {
            const lv = wrLeavesFor(monday);
            const done = new Set((attendanceData || []).map(a => a.subjectId + '|' + a.date + '|' + String(a.period)));
            const now = new Date(), today = localDateStr(now), hm = String(now.getHours()).padStart(2, '0') + '.' + String(now.getMinutes()).padStart(2, '0');
            const dates = wrWeekDates(monday), rooms = wrRooms(term, year, grades);
            const res = rooms.map(roomId => {
                const subs = getRoomSubjects(roomId, term, year);
                const days = dates.map(ds => {
                    const hol = getHolidayForDate(ds), isHol = hol && (!hol.type || hol.type === 'holiday');
                    if (isHol && (!hol.duration || hol.duration === 'full')) return { ds, off: hol.label || hol.name || 'วันหยุด', slots: [], ok: 0, tot: 0 };
                    const eff = getEffectiveDayOfWeek(ds), half = isHol ? hol.duration : '';
                    let ok = 0, tot = 0;
                    const slots = timeSlots.map(sl => {
                        if (sl.period === -1) return { p: -1, st: 'lunch' };
                        const s = subs.find(x => effSched(x).some(sc => parseInt(sc.day) === eff && parseInt(sc.period) === sl.period));
                        if (!s) return { p: sl.period, st: 'empty' };
                        const checked = done.has(s.id + '|' + ds + '|' + sl.period);
                        if (isClubSubject(s)) return { p: sl.period, st: 'club', s }; // [v1.78] คาบชุมนุม = เช็คแยกในระบบชุมนุม (ไม่นับ)
                        let st = '';
                        if ((half === 'morning' && sl.period <= 4) || (half === 'afternoon' && sl.period >= 5)) st = 'off';
                        else { const hp = hubPeriodFor(roomId, ds, sl.period); if (hp) st = hp.mode === 'noclass' ? 'off' : (checked ? 'ok' : 'act'); }
                        if (!st) st = checked ? 'ok' : ((ds > today || (ds === today && hm < sl.time.split('-')[1])) ? 'future' : 'no');
                        let lvNote = '';
                        if (st === 'no') { const l = wrLeaveOf(lv, s, ds, sl.period); if (l) return { p: sl.period, st: 'leave', s, lv: (l.label || 'ไปราชการ') + ' (ไม่นับ)' }; lvNote = lvWho(lv, s, ds, sl.period).map(w => w.name + ' ' + w.label).join(', '); } // [v2.00.3] ครูร่วม: คนหนึ่งแจ้ง = ยังนับ (อีกคนเช็คได้) + บอกเหตุผล
                        if (st === 'ok') { ok++; tot++; } else if (st === 'no') tot++;
                        return { p: sl.period, st, s, lvNote };
                    });
                    return { ds, slots, ok, tot, makeup: hol && hol.type === 'makeup' ? (hol.label || 'สอนชดเชย') : '' };
                });
                const ok = days.reduce((a, d) => a + d.ok, 0), tot = days.reduce((a, d) => a + d.tot, 0);
                return { roomId, days, ok, tot, pct: tot ? Math.round(ok / tot * 100) : null };
            });
            const ok = res.reduce((a, r) => a + r.ok, 0), tot = res.reduce((a, r) => a + r.tot, 0);
            const missing = []; res.forEach(r => r.days.forEach(d => d.slots.forEach(x => { if (x.st === 'no') missing.push({ ds: d.ds, roomId: r.roomId, p: x.p, s: x.s, lvNote: x.lvNote || '' }); })));
            missing.sort((a, b) => a.ds.localeCompare(b.ds) || a.roomId.localeCompare(b.roomId, undefined, { numeric: true }) || a.p - b.p);
            return { dates, rooms: res, ok, tot, pct: tot ? Math.round(ok / tot * 1000) / 10 : null, missing };
        }
        const wrBar = (pct) => pct == null ? '<span style="color:#94a3b8">-</span>' : `<span style="display:inline-flex;align-items:center;gap:6px"><span style="display:inline-block;position:relative;width:80px;height:8px;border-radius:99px;background:#fee2e2"><span style="position:absolute;left:0;top:0;height:8px;width:${Math.round(pct * 0.8)}px;border-radius:99px;background:${wrCls(pct)}"></span></span><b style="color:${wrCls(pct)}">${pct}%</b></span>`;
        // หน้าสรุป: ตารางห้อง 26 แถว/หน้า · คาบที่ยังไม่เช็คต่อท้ายหน้าสุดท้าย แล้วหน้าละ 34 แถว
        function wrSumLayout(nRooms, nMiss) { const chunks = Math.max(1, Math.ceil(nRooms / 26)), last = nRooms - (chunks - 1) * 26, room0 = Math.max(0, 30 - last - (chunks === 1 ? 4 : 0)), cap = room0 > 2 ? room0 : 0; return { chunks, cap, pages: chunks + (nMiss ? Math.ceil(Math.max(0, nMiss - cap) / 34) : 0) }; } // [v2.01.0] ตรงกับ wrSummaryPagesHtml
        function wrTabHtml() {
            const w = wrState(); wrLoadLeaves(w.monday);
            const term = adminTerm(), year = adminYear(), R = wrCompute(term, year, w.monday, w.grades);
            const grades = [1, 2, 3, 4, 5, 6].filter(g => (settings.roomCounts || {})['m' + g]);
            const chip = (on, label, attr) => `<button type="button" onclick="${attr}" class="${on ? 'bg-indigo-600 border-indigo-600 text-white' : 'bg-white border-slate-300 text-slate-700 hover:bg-slate-50'} border-2 px-3 py-1 rounded-full text-xs sm:text-sm font-bold">${label}</button>`;
            const chk = (on, label, desc, key) => `<label class="flex items-start gap-3 border-2 ${on ? 'border-indigo-500 bg-indigo-50' : 'border-slate-200 bg-white'} rounded-xl p-3 cursor-pointer"><input type="checkbox" ${on ? 'checked' : ''} onchange="window.wrSet('${key}', this.checked)" class="mt-1 w-4 h-4 accent-indigo-600"><span><span class="block font-extrabold text-slate-800 text-sm">${label}</span><span class="block text-xs text-slate-500 font-semibold">${desc}</span></span></label>`;
            const pages = (w.sum ? wrSumLayout(R.rooms.length, R.missing.length).pages : 0) + (w.rooms ? R.rooms.length : 0);
            let h = `<div class="flex flex-col lg:flex-row gap-4 sm:gap-6"><div class="lg:w-[420px] shrink-0"><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-1 flex items-center gap-2"><i class="fas fa-file-pdf text-red-500"></i> รายงานการเช็คชื่อประจำสัปดาห์</h3><p class="text-xs sm:text-sm text-slate-500 font-semibold mb-4">เฉพาะ Super Admin · นับจากปุ่มเช็คชื่อ (เขียว = เช็คแล้ว) · ภาคเรียน ${term}/${year}</p>`;
            h += `<p class="font-bold text-slate-700 text-sm mb-1.5">สัปดาห์</p><div class="flex items-center gap-2 mb-4"><button type="button" onclick="window.wrWeek(-1)" class="w-9 h-9 rounded-lg border-2 border-slate-200 hover:bg-slate-50 text-slate-600" aria-label="สัปดาห์ก่อน"><i class="fas fa-chevron-left"></i></button><div class="flex-1 text-center border-2 border-slate-200 rounded-lg py-1.5 font-extrabold text-slate-800 text-sm">${wrThai(w.monday)} – ${wrThai(wrAdd(w.monday, 4), true)}</div><button type="button" onclick="window.wrWeek(1)" class="w-9 h-9 rounded-lg border-2 border-slate-200 hover:bg-slate-50 text-slate-600" aria-label="สัปดาห์ถัดไป"><i class="fas fa-chevron-right"></i></button></div>`;
            h += `<p class="font-bold text-slate-700 text-sm mb-1.5">ห้องเรียน</p><div class="flex flex-wrap gap-1.5 mb-4">${chip(!w.grades.length, `ทุกห้อง (${wrRooms(term, year, []).length})`, "window.wrGrade('')")}${grades.map(g => chip(w.grades.includes(String(g)), 'ม.' + g, `window.wrGrade('${g}')`)).join('')}</div>`;
            h += `<p class="font-bold text-slate-700 text-sm mb-1.5">เนื้อหาในไฟล์</p><div class="flex flex-col gap-2 mb-3">${chk(w.sum, 'หน้าสรุปทุกห้อง', '% การเช็คชื่อแต่ละห้อง แยกรายวัน + รายการคาบที่ยังไม่เช็ค', 'sum')}${chk(w.rooms, 'หน้ารายห้อง (1 ห้อง = 1 หน้า)', 'จันทร์–ศุกร์เรียงกัน แบบหน้าเช็คชื่อ คาบเขียว/แดง', 'rooms')}</div>`;
            h += `<div class="text-xs text-slate-500 font-semibold bg-slate-50 rounded-lg px-3 py-2 mb-3"><i class="fas fa-info-circle"></i> ประมาณ ${pages} หน้า · วันหยุด/คาบหยุดเรียนตามปฏิทินไม่นับ · ใช้คอมพิวเตอร์จะเร็วกว่า</div>`;
            h += `<button type="button" onclick="window.exportWeeklyReport()" ${pages && R.rooms.length ? '' : 'disabled'} class="w-full bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 text-white font-extrabold py-2.5 rounded-xl flex items-center justify-center gap-2"><i class="fas fa-file-download"></i> ส่งออก PDF</button></div>`;
            h += `<div class="flex-1 min-w-0"><div class="grid grid-cols-3 gap-2 mb-3">${[['เช็คแล้ว', R.ok, '#16a34a'], ['ยังไม่เช็ค', R.tot - R.ok, '#dc2626'], ['ภาพรวม', R.pct == null ? '-' : R.pct + '%', R.pct == null ? '#64748b' : wrCls(R.pct)]].map(x => `<div class="border border-slate-200 rounded-xl px-3 py-2"><span class="block text-xs text-slate-500 font-bold">${x[0]}</span><b class="text-xl" style="color:${x[2]}">${x[1]}</b></div>`).join('')}</div>`;
            h += `<div class="overflow-x-auto border border-slate-200 rounded-xl"><table class="w-full text-xs sm:text-sm"><thead class="bg-slate-50 text-slate-600"><tr><th class="p-2 text-left">ห้อง</th>${R.dates.map(ds => `<th class="p-2">${WR_TH_DS[wrD(ds).getDay()]} ${wrD(ds).getDate()}</th>`).join('')}<th class="p-2 text-left">%</th></tr></thead><tbody>${R.rooms.map(r => `<tr class="border-t border-slate-100"><td class="p-2 font-extrabold">${formatRoomName(r.roomId)}</td>${r.days.map(d => `<td class="p-2 text-center ${d.off ? 'text-slate-400' : ''}">${d.off ? 'หยุด' : (d.tot ? d.ok + '/' + d.tot : '-')}</td>`).join('')}<td class="p-2 whitespace-nowrap">${wrBar(r.pct)}</td></tr>`).join('') || `<tr><td colspan="9" class="p-6 text-center text-slate-400">ไม่มีห้องเรียนในภาคเรียนนี้</td></tr>`}</tbody></table></div></div></div>`;
            return h;
        }
        window.wrWeek = function (n) { const w = wrState(); w.monday = wrAdd(w.monday, n * 7); renderAdminTab(); };
        window.wrGrade = function (g) { const w = wrState(); if (!g) w.grades = []; else { const i = w.grades.indexOf(g); if (i >= 0) w.grades.splice(i, 1); else w.grades.push(g); } renderAdminTab(); };
        window.wrSet = function (k, v) { wrState()[k] = !!v; renderAdminTab(); };
        // [v2.01.0] รายงานประจำสัปดาห์แบบใหม่: หน้าสรุป (สีตามระดับ %) + หน้ารายห้องเป็นตารางคาบ × วัน (ทุกช่องสูงเท่ากัน ไม่เลื่อน)
        const WR_C = { ok: ['#ecfdf5', '#10b981', 'เช็คแล้ว', '#047857'], no: ['#fef2f2', '#ef4444', 'ยังไม่เช็ค', '#b91c1c'], off: ['#f8fafc', '#cbd5e1', 'หยุดเรียน', '#64748b'], act: ['#f0f9ff', '#7dd3fc', 'กิจกรรม', '#0369a1'], future: ['#f8fafc', '#cbd5e1', 'ยังไม่ถึง', '#94a3b8'], club: ['#fefce8', '#facc15', 'ชุมนุม (ไม่นับ)', '#a16207'], leave: ['#f1f5f9', '#94a3b8', 'ครูไปราชการ (ไม่นับ)', '#475569'], empty: ['#ffffff', '#e2e8f0', '', '#94a3b8'] };
        function wrCellBg(ok, tot) { if (!tot) return ''; const p = ok / tot * 100; return p >= 100 ? '#dcfce7' : (p >= 75 ? '#fef9c3' : '#fee2e2'); }
        function wrSlotTd(x, h) {
            const C = WR_C[x.st] || WR_C.empty, s = x.s, f = !!(s && isForeignSubject(s));
            const nm = s ? (s.code ? s.code + ' ' : '') + (s.name || '') : 'ว่าง', tc = s ? [s.teacher, s.teacher2].filter(Boolean).join(', ') : '';
            const lab = x.st === 'leave' ? 'ครู' + (x.lv || 'ไปราชการ (ไม่นับ)') : C[2];
            return `<td style="background:${C[0]}!important;padding:0!important;vertical-align:top;height:${h}px"><div style="display:flex;gap:5px;padding:4px 5px;height:${h - 1}px;box-sizing:border-box;overflow:hidden;border-left:3px solid ${f ? '#0ea5e9' : 'transparent'}"><span style="flex:none;width:15px;height:15px;border-radius:50%;background:${C[1]};color:#fff;font-size:8px;font-weight:800;display:flex;align-items:center;justify-content:center;margin-top:2px">${periodLabel(x.p)}</span><div style="min-width:0;flex:1;font-size:9.5px"><div style="font-weight:800;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:${s ? '#0f172a' : '#94a3b8'}">${wrEsc(nm)}</div>${tc ? `<div style="color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${wrEsc(tc)}</div>` : ''}${s ? `<div style="white-space:nowrap;overflow:hidden"><b style="color:${C[3]}">${wrEsc(lab)}</b>${f ? '<span class="rp-ftag">ครูต่างชาติ</span>' : ''}</div>` : ''}${x.lvNote ? `<div style="color:#64748b;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${wrEsc(x.lvNote)}</div>` : ''}</div></div></td>`;
        }
        // หน้ารายห้อง (ใช้ร่วมกับหน้าแรกผู้บริหารใน AcademicHub ผ่าน wrRoomPageHtml)
        function wrRoomPageHtml(r, weekTxt, term, year) {
            const adv = (getRoomAdvisors(r.roomId, term, year) || []).filter(Boolean);
            const nRows = timeSlots.filter(t => t.period !== -1).length, rowH = Math.max(46, Math.min(70, Math.floor(760 / Math.max(1, nRows))));
            const head = `<tr><th style="width:42px">คาบ</th>${r.days.map(d => { const dt = wrD(d.ds), pct = d.tot ? Math.round(d.ok / d.tot * 100) : null; return `<th>${WR_TH_D[dt.getDay()]} ${wrThai(d.ds)}<div style="font-weight:600;color:${d.off ? '#94a3b8' : rpPctColor(pct)};font-size:10px">${d.off ? 'วันหยุด' : (d.tot ? `${d.ok}/${d.tot} · ${pct}%` : 'ไม่นับ')}${d.makeup ? ' · ' + wrEsc(d.makeup) : ''}</div></th>`; }).join('')}</tr>`;
            let body = '', offDone = {};
            timeSlots.forEach((sl, j) => {
                if (sl.period === -1) { const lu = 'background:#fffbeb!important;color:#b45309;font-weight:700;font-size:10px;text-align:center;padding:1px!important'; body += `<tr><td style="${lu}">พัก</td>${r.days.map((d, di) => { if (d.off) { if (offDone[di]) return ''; offDone[di] = 1; return `<td rowspan="${timeSlots.length - j}" style="background:#f8fafc!important;text-align:center;vertical-align:middle;color:#94a3b8;font-weight:800">วันหยุด<div style="font-weight:400;font-size:10px">${wrEsc(d.off)}</div></td>`; } return `<td style="${lu}">พักกลางวัน</td>`; }).join('')}</tr>`; return; }
                body += `<tr><td style="background:#eef2ff!important;color:#3730a3;font-weight:800;text-align:center">${periodLabel(sl.period)}</td>` + r.days.map((d, di) => {
                    if (d.off) { if (offDone[di]) return ''; offDone[di] = 1; return `<td rowspan="${timeSlots.length - j}" style="background:#f8fafc!important;text-align:center;vertical-align:middle;color:#94a3b8;font-weight:800">วันหยุด<div style="font-weight:400;font-size:10px">${wrEsc(d.off)}</div></td>`; }
                    const x = d.slots.find(z => z.p === sl.period) || { p: sl.period, st: 'empty' };
                    return wrSlotTd(x, rowH);
                }).join('') + `</tr>`;
            });
            const legend = `<div class="rp-lg">${['ok', 'no', 'off', 'club', 'act', 'leave'].map(k => `<span><i style="background:${WR_C[k][1]}"></i>${WR_C[k][2]}</span>`).join('')}<span><i style="background:#0ea5e9"></i>ขอบฟ้า = คาบของครูต่างชาติ</span></div>`;
            return rpHead(`${formatRoomName(r.roomId)} · รายงานการเช็คชื่อประจำสัปดาห์`, `ครูที่ปรึกษา: ${wrEsc(adv.join(', ') || '-')}`, `${rpPill('สัปดาห์ ' + weekTxt)}<div style="font-size:20px;font-weight:800;color:${rpPctColor(r.pct)};margin-top:4px">${r.pct == null ? '-' : r.pct + '%'} <span style="font-size:11px;color:#64748b">(${r.ok}/${r.tot} คาบ)</span></div>`) +
                `<table style="table-layout:fixed"><thead>${head}</thead><tbody>${body}</tbody></table>${legend}`;
        }
        function wrSummaryPagesHtml(R, weekTxt) {
            const kp = rpKpis([['คาบที่ต้องเช็ค', R.tot, '#0f172a'], ['เช็คแล้ว', R.ok, '#16a34a'], ['ยังไม่เช็ค', R.tot - R.ok, '#dc2626'], ['ภาพรวม', R.pct == null ? '-' : R.pct + '%', rpPctColor(R.pct)]]);
            const roomRow = (r) => `<tr><td><b>${formatRoomName(r.roomId)}</b></td>${r.days.map(d => `<td style="text-align:center;${d.off ? 'color:#94a3b8' : (d.tot ? 'background:' + wrCellBg(d.ok, d.tot) + '!important' : '')}">${d.off ? 'หยุด' : (d.tot ? d.ok + '/' + d.tot : '-')}</td>`).join('')}<td style="text-align:center">${r.ok}/${r.tot}</td><td><div style="display:flex;align-items:center;gap:6px"><div style="flex:1;height:7px;border-radius:9px;background:#e2e8f0;overflow:hidden"><div style="height:7px;width:${r.pct || 0}%;background:${rpPctColor(r.pct)}"></div></div><b style="color:${rpPctColor(r.pct)};width:36px;text-align:right">${r.pct == null ? '-' : r.pct + '%'}</b></div></td></tr>`;
            const roomHead = `<tr><th style="width:62px">ห้อง</th>${R.dates.map(ds => `<th>${WR_TH_DS[wrD(ds).getDay()]} ${wrD(ds).getDate()}</th>`).join('')}<th style="width:64px">รวม</th><th style="width:140px">%</th></tr>`;
            const missRow = (m) => `<tr><td style="text-align:center;white-space:nowrap">${WR_TH_DS[wrD(m.ds).getDay()]} ${wrThai(m.ds)}</td><td style="text-align:center"><b>${formatRoomName(m.roomId)}</b></td><td style="text-align:center">${periodLabel(m.p)}</td><td>${wrEsc((m.s.code ? m.s.code + ' ' : '') + (m.s.name || ''))}</td><td>${wrEsc([m.s.teacher, m.s.teacher2].filter(Boolean).join(', ') || '-')}${isForeignSubject(m.s) ? '<span class="rp-ftag">ครูต่างชาติ</span>' : ''}${m.lvNote ? `<span style="color:#64748b"> (${wrEsc(m.lvNote)})</span>` : ''}</td></tr>`;
            const missHead = `<tr><th style="width:82px">วันที่</th><th style="width:56px">ห้อง</th><th style="width:36px">คาบ</th><th>วิชา</th><th>ครูผู้สอน</th></tr>`;
            const missTitle = (cont) => rpSec(`คาบที่ยังไม่เช็คชื่อ${cont ? ' (ต่อ)' : ''}`, `${R.missing.length} คาบ · เรียงตามวัน`, '#b91c1c');
            const head = (first) => rpHead('รายงานการเช็คชื่อประจำสัปดาห์', first ? 'สรุปทุกห้อง · นับจากคาบที่ต้องเช็คตามตารางสอน (วันหยุด / หยุดเรียน / ชุมนุม ไม่นับ)' : 'สรุปทุกห้อง (ต่อ)', rpPill('สัปดาห์ ' + weekTxt));
            const parts = [], MAXR = 26, chunks = []; for (let i = 0; i < R.rooms.length; i += MAXR) chunks.push(R.rooms.slice(i, i + MAXR)); if (!chunks.length) chunks.push([]);
            let mi = 0;
            chunks.forEach((ch, i) => {
                let inner = head(i === 0) + (i === 0 ? kp : '') + rpSec('สรุปรายห้อง', 'สีช่อง: เขียว = ครบ · เหลือง = 75% ขึ้นไป · แดง = ต่ำกว่า 75%') + `<table><thead>${roomHead}</thead><tbody>${ch.map(roomRow).join('')}</tbody></table>`;
                if (i === chunks.length - 1) {
                    const room = Math.max(0, 30 - ch.length - (i === 0 ? 4 : 0));
                    if (!R.missing.length) inner += `<div style="margin-top:12px;color:#16a34a;font-weight:800;font-size:14px">เช็คชื่อครบทุกคาบ</div>`;
                    else if (room > 2) { inner += missTitle(false) + `<table><thead>${missHead}</thead><tbody>${R.missing.slice(0, room).map(missRow).join('')}</tbody></table>`; mi = room; }
                }
                parts.push(inner);
            });
            while (mi < R.missing.length) { parts.push(head(false) + missTitle(mi > 0) + `<table><thead>${missHead}</thead><tbody>${R.missing.slice(mi, mi + 34).map(missRow).join('')}</tbody></table>`); mi += 34; }
            return parts;
        }
        // แปลงชุด HTML ของแต่ละหน้า → PDF (หัว/ท้ายกระดาษแบบใหม่) · ใช้ร่วมหลายรายงาน
        async function rpRenderPdf(parts, fileName, progressTitle, opts) {
            opts = opts || {};
            showProgressModal(progressTitle || 'กำลังสร้างรายงาน PDF', 'กำลังเตรียมหน้ารายงาน...');
            const wasDark = document.documentElement.classList.contains('dark'); if (wasDark) document.documentElement.classList.remove('dark');
            const box = document.createElement('div'); box.className = 'a4-export-container'; box.id = 'pdf-rp-container';
            box.innerHTML = parts.map(x => typeof x === 'object' && x.cover ? `<div class="a4-page rp-cover">${x.html}</div>` : `<div class="a4-page">${x}</div>`).join(''); document.body.appendChild(box);
            rpFinalize(box, opts.docTitle);
            let ok = false;
            try {
                await document.fonts.ready; await new Promise(res => setTimeout(res, 300));
                const pdfDoc = new jspdf.jsPDF('p', 'pt', 'a4'), els = box.querySelectorAll('.a4-page');
                for (let i = 0; i < els.length; i++) {
                    updateProgressModal(5 + (i / els.length) * 90, `กำลังสร้างหน้าที่ ${i + 1} จาก ${els.length}...`);
                    const canvas = await html2canvas(els[i], { scale: opts.scale || 1.8, backgroundColor: '#ffffff', logging: false, useCORS: true, windowWidth: 794 });
                    if (i > 0) pdfDoc.addPage(); pdfDoc.addImage(canvas.toDataURL('image/jpeg', 0.9), 'JPEG', 0, 0, 595.28, 841.89);
                }
                updateProgressModal(100, 'กำลังบันทึกไฟล์...');
                pdfDoc.save(fileName);
                completeProgressModal('ดำเนินการเสร็จสิ้น', `สร้างรายงาน (${els.length} หน้า) สำเร็จ ไฟล์ถูกดาวน์โหลดแล้ว`); ok = true;
            } catch (err) { console.error(err); errorProgressModal('เกิดข้อผิดพลาดในการสร้างรายงาน กรุณาลองใหม่อีกครั้ง'); }
            box.remove(); if (wasDark) document.documentElement.classList.add('dark');
            return ok;
        }
        window.exportWeeklyReport = async function () {
            await wrLoadLeaves(wrState().monday); // [v2.00.1] ครูไปราชการ / ลา
            if (!currentUser || currentUser.role !== 'super_admin') { showToast('เฉพาะ Super Admin เท่านั้น', 'error'); return; }
            const w = wrState(), term = adminTerm(), year = adminYear(), R = wrCompute(term, year, w.monday, w.grades);
            const weekTxt = `${wrThai(w.monday)} – ${wrThai(wrAdd(w.monday, 4), true)}`;
            const parts = [];
            if (w.sum) wrSummaryPagesHtml(R, weekTxt).forEach(x => parts.push(x));
            if (w.rooms) R.rooms.forEach(r => parts.push(wrRoomPageHtml(r, weekTxt, term, year)));
            if (!parts.length) { showToast('เลือกเนื้อหาในไฟล์อย่างน้อย 1 อย่าง', 'error'); return; }
            const ok = await rpRenderPdf(parts, `รายงานเช็คชื่อประจำสัปดาห์_${w.monday}${w.grades.length ? '_ม' + w.grades.join('-') : ''}.pdf`, 'กำลังสร้างรายงาน PDF', { docTitle: 'รายงานการเช็คชื่อประจำสัปดาห์' });
            if (ok) logAction('ส่งออกรายงานเช็คชื่อประจำสัปดาห์', weekTxt, 'data');
        };
        // ===== [ใหม่] HTML หลอด Progress แบบใช้ร่วมกันทุกจุดที่ต้องรอโหลดข้อมูลเช็คชื่อ =====
        function renderLoadingProgressHTML(message, pct, id) {
            return `<div class="flex flex-col items-center justify-center py-16 sm:py-24 px-4"><i class="fas fa-cloud-download-alt text-3xl sm:text-4xl text-indigo-400 mb-4"></i><p class="text-slate-600 font-bold text-sm sm:text-base mb-3">${message}</p><div class="w-full max-w-xs sm:max-w-sm h-2.5 sm:h-3 bg-slate-200 rounded-full overflow-hidden"><div id="${id}" class="bg-indigo-500 h-full rounded-full transition-all duration-300" style="width: ${pct}%"></div></div><p class="text-[10px] sm:text-xs text-slate-400 font-bold mt-2"><span id="${id}_pct">${Math.round(pct)}</span>%</p></div>`;
        }
        window.setAdminWorkingTerm = function(term) {
            term = String(term);
            if (term === String(adminTerm())) return;
            showConfirm("ยืนยันการสลับภาคเรียน", `ต้องการสลับไปจัดการข้อมูลภาคเรียน ${term}/${adminYear()} ใช่หรือไม่? (มีผลเฉพาะหน้าจอของคุณเองเท่านั้น ไม่กระทบสิ่งที่ผู้ใช้ทั่วไปเห็นที่หน้าแรก)`, () => {
                adminWorkingTerm = term;
                renderAdmin();
            });
        };
        // สลับปีการศึกษาที่แอดมินกำลังจัดการอยู่ (แยกอิสระจากปีที่แสดงผลจริงที่หน้าแรก) - ใช้เตรียมข้อมูลปีใหม่ล่วงหน้า หรือย้อนกลับไปดู/แก้ไขปีเก่าได้โดยไม่กระทบผู้ใช้ทั่วไป
        window.setAdminWorkingYear = function(year) {
            year = String(year);
            if (year === String(adminYear())) return;
            showConfirm("ยืนยันการสลับปีการศึกษา", `ต้องการสลับไปจัดการข้อมูลปีการศึกษา ${year} ใช่หรือไม่? (มีผลเฉพาะหน้าจอของคุณเองเท่านั้น ไม่กระทบปีการศึกษาที่ผู้ใช้ทั่วไปเห็นที่หน้าแรกซึ่งยังคงเป็น ${settings.year} ตามเดิม จนกว่าคุณจะไปตั้งค่าที่แท็บ "ตั้งค่าภาคเรียน" อย่างชัดเจน)`, () => {
                adminWorkingYear = year;
                adminWorkingTerm = null; // เปลี่ยนปีแล้วรีเซ็ตกลับไปภาคเรียน 1 ของปีนั้นเพื่อไม่ให้สับสน
                renderAdmin();
            });
        };
        // ตัวกรองภาคเรียน/ปีเฉพาะของแท็บ "สถานะข้อมูล" — ไม่กระทบภาคเรียนที่แอดมินกำลังจัดการอยู่ (แถบสีม่วงด้านบน) และไม่บันทึกลงเซิร์ฟเวอร์
        window.setDataStatusTerm = function(term) { window.dataStatusTerm = String(term); renderAdminTab(); };
        window.setDataStatusYear = function(year) { window.dataStatusYear = String(year); renderAdminTab(); };
        window.setTeacherStatusTerm = function(term) { window.teacherStatusTerm = String(term); renderAdminTab(); };
        window.setTeacherStatusYear = function(year) { window.teacherStatusYear = String(year); renderAdminTab(); };

        // ===== [ใหม่] ลบประกาศที่หมดเวลาแล้วเกิน 7 วัน อัตโนมัติ (ทำเมื่อแอดมินเปิดหน้าจัดการ) =====
        function pruneExpiredItems() {
            const cutoff = new Date(); cutoff.setDate(cutoff.getDate() - 7);
            const cutoffStr = localDateStr(cutoff);
            let delA = 0, delH = 0; // วันหยุดไม่ลบอัตโนมัติ (ต้องคงไว้สำหรับสมุดทะเบียนย้อนหลัง) ยกเว้นเก่ากว่า 1 ปีในแท็บวันหยุด
            if (Array.isArray(settings.announcements)) {
                const before = settings.announcements.length;
                settings.announcements = settings.announcements.filter(a => { if (!a || !a.end) return true; const e = new Date(a.end); return isNaN(e) || e >= cutoff; });
                delA = before - settings.announcements.length;
            }
            if (delA > 0) { logAction('ลบประกาศที่หมดเวลาเกิน 7 วันอัตโนมัติ', `${delA} รายการ`, 'settings'); saveData('full'); }
        }
        function renderAdminTab() {
            pruneExpiredItems();
            const content = document.getElementById('adminContent');
            if (currentAdminTab === 'settings') {
                const isSuperAdminSettings = currentUser && currentUser.role === 'super_admin';
                let html = `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-3 flex items-center gap-2"><i class="fas fa-server text-indigo-500"></i> สถานะเว็บไซต์</h3><div class="mb-6 bg-slate-50 p-3 sm:p-4 rounded-xl border border-slate-100 flex items-center justify-between gap-3 flex-wrap"><div class="flex items-center gap-2"><span class="w-2.5 h-2.5 rounded-full ${settings.serverOnline !== false ? 'bg-emerald-500' : 'bg-rose-500'}"></span><span class="font-bold text-sm sm:text-base ${settings.serverOnline !== false ? 'text-emerald-700' : 'text-rose-600'}">${settings.serverOnline !== false ? 'ออนไลน์ (เปิดใช้งานปกติ)' : 'ปิดปรับปรุง'}</span></div>${isSuperAdminSettings ? `<button onclick="window.toggleServerOnline()" class="${settings.serverOnline !== false ? 'bg-rose-50 border-rose-200 hover:bg-rose-100 text-rose-600' : 'bg-emerald-50 border-emerald-200 hover:bg-emerald-100 text-emerald-700'} border px-3 py-1.5 rounded-lg font-bold text-xs sm:text-sm transition-colors flex items-center gap-1.5"><i class="fas fa-power-off"></i> ${settings.serverOnline !== false ? 'ปิดสถานะออนไลน์' : 'เปิดสถานะออนไลน์'}</button>` : `<span class="text-[10px] sm:text-xs font-bold text-slate-400 flex items-center gap-1"><i class="fas fa-lock"></i> เฉพาะ Super Admin</span>`}</div><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-3 flex items-center gap-2"><i class="fas fa-heading text-indigo-500"></i> ชื่อหัวเรื่องระบบ</h3><div class="mb-6 bg-slate-50 p-3 sm:p-4 rounded-xl border border-slate-100">${!isSuperAdminSettings ? `<div class="flex items-center gap-1.5 text-[10px] sm:text-xs font-bold text-slate-400 mb-2"><i class="fas fa-lock"></i> เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้</div>` : ''}<label class="block text-[10px] sm:text-xs font-bold text-slate-700 mb-1">ชื่อระบบ (แสดงที่แถบด้านบน)</label><input type="text" id="setSiteTitle" value="${settings.title || 'ระบบเช็คชื่อนักเรียนอัจฉริยะ'}" ${!isSuperAdminSettings ? 'disabled' : ''} class="w-full ${!isSuperAdminSettings ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'bg-white'} border border-slate-200 rounded-lg px-3 py-2 text-base sm:text-sm font-bold focus:ring-2 focus:ring-indigo-500 outline-none" placeholder="เช่น ระบบเช็คชื่อนักเรียนอัจฉริยะ">${isSuperAdminSettings ? `<div class="flex justify-end mt-3"><button onclick="window.saveSiteTitleSettings()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-save"></i> บันทึกชื่อระบบ</button></div>` : ''}</div><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-3 flex items-center gap-2"><i class="fas fa-icons text-indigo-500"></i> ไอคอนเว็บไซต์ (Favicon)</h3><div class="mb-6 bg-slate-50 p-3 sm:p-4 rounded-xl border border-slate-100 flex items-center gap-4 flex-wrap"><img id="faviconPreview" src="${settings.faviconDataUrl || 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/svgs/solid/graduation-cap.svg'}" class="w-14 h-14 rounded-xl border border-slate-200 bg-white object-contain p-1 shadow-sm"><div class="flex-1 min-w-[200px]">${isSuperAdminSettings ? `<input type="file" id="faviconFileInput" accept="image/*" class="hidden" onchange="window.handleFaviconUpload(event)"><button onclick="document.getElementById('faviconFileInput').click()" class="bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 px-3 sm:px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors"><i class="fas fa-upload"></i> เลือกรูปไอคอนใหม่</button><p class="text-[10px] sm:text-xs text-slate-400 mt-1.5 font-medium">แนะนำไฟล์ภาพสี่เหลี่ยมจัตุรัส ระบบจะปรับขนาดให้อัตโนมัติ และบันทึกทันทีที่เลือกไฟล์</p>` : `<div class="flex items-center gap-1.5 text-[10px] sm:text-xs font-bold text-slate-400"><i class="fas fa-lock"></i> เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้</div>`}</div></div><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-3 flex items-center gap-2"><i class="fas fa-image text-indigo-500"></i> โลโก้บนแถบหัวเว็บไซต์</h3><div class="mb-6 bg-slate-50 p-3 sm:p-4 rounded-xl border border-slate-100 flex items-center gap-4 flex-wrap"><div id="navLogoPreviewBox" class="w-14 h-14 rounded-xl border border-slate-200 bg-white flex items-center justify-center overflow-hidden shadow-sm">${settings.logoDataUrl ? `<img id="navLogoPreview" src="${settings.logoDataUrl}" class="w-full h-full object-cover">` : `<i class="fas fa-graduation-cap text-indigo-400 text-xl" id="navLogoPreview"></i>`}</div><div class="flex-1 min-w-[200px]">${isSuperAdminSettings ? `<input type="file" id="navLogoFileInput" accept="image/*" class="hidden" onchange="window.handleHeaderLogoUpload(event)"><button onclick="document.getElementById('navLogoFileInput').click()" class="bg-white border border-slate-200 hover:bg-slate-100 text-slate-700 px-3 sm:px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors"><i class="fas fa-upload"></i> เลือกรูปโลโก้ใหม่</button>${settings.logoDataUrl ? `<button onclick="window.removeHeaderLogo()" class="ml-2 bg-rose-50 border border-rose-200 hover:bg-rose-100 text-rose-600 px-3 sm:px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors"><i class="fas fa-times"></i> ลบโลโก้</button>` : ''}<p class="text-[10px] sm:text-xs text-slate-400 mt-1.5 font-medium">แสดงแทนไอคอนหมวกบัณฑิตที่มุมซ้ายบนของเว็บ บันทึกทันทีที่เลือกไฟล์</p>` : `<div class="flex items-center gap-1.5 text-[10px] sm:text-xs font-bold text-slate-400"><i class="fas fa-lock"></i> เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้</div>`}</div></div><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-3 border-t pt-4 sm:pt-6 flex items-center gap-2"><i class="fas fa-cubes text-indigo-500"></i> จำนวนห้อง (ต่อชั้นปี)</h3>${!isSuperAdminSettings ? `<div class="flex items-center gap-1.5 text-[10px] sm:text-xs font-bold text-slate-400 mb-2"><i class="fas fa-lock"></i> เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้</div>` : ''}<div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2 sm:gap-3 mb-3">`;
                for(let i=1; i<=6; i++) { html += `<div class="bg-slate-50 p-2 sm:p-3 rounded-lg border border-slate-100 text-center"><label class="block font-black text-[10px] sm:text-xs text-slate-700 mb-1 sm:mb-2">ม.${i}</label><input type="number" id="setCountM${i}" value="${settings.roomCounts[`m${i}`]}" min="0" max="15" ${!isSuperAdminSettings ? 'disabled' : ''} class="w-full text-center py-1.5 sm:py-2 rounded border border-slate-200 font-bold ${!isSuperAdminSettings ? 'bg-slate-100 text-slate-400 cursor-not-allowed' : 'text-indigo-600'} outline-none text-base sm:text-sm"></div>`;
                }
                html += `</div>${isSuperAdminSettings ? `<div class="flex justify-end mb-6"><button onclick="window.saveRoomCountsSettings()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-save"></i> บันทึกจำนวนห้อง</button></div>` : '<div class="mb-6"></div>'}<h3 class="text-lg sm:text-xl font-extrabold text-rose-600 mb-3 border-t pt-4 sm:pt-6 flex items-center gap-2"><i class="fas fa-exclamation-triangle"></i> ล้างข้อมูลทั้งระบบ</h3><div class="bg-rose-50 p-4 rounded-xl border border-rose-200 shadow-sm flex flex-col sm:flex-row justify-between items-center gap-4"><div><h4 class="font-bold text-rose-800 text-sm sm:text-base">ล้างข้อมูลการเช็คชื่อทั้งหมด</h4><p class="text-[10px] sm:text-xs text-rose-600 font-medium">ลบประวัติการเช็คชื่อของทุกวิชา ทุกห้อง ทุกวัน (ไม่สามารถกู้คืนได้)</p>${!isSuperAdminSettings ? `<p class="text-[10px] sm:text-xs text-slate-400 font-bold mt-1"><i class="fas fa-lock"></i> เฉพาะ Super Admin เท่านั้นที่ใช้งานส่วนนี้ได้</p>` : ''}</div>${isSuperAdminSettings ? `<button onclick="window.resetAllAttendanceData()" class="w-full sm:w-auto bg-rose-600 hover:bg-rose-700 text-white px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg font-bold shadow-sm transition-colors text-sm whitespace-nowrap"><i class="fas fa-trash-alt"></i> ล้างข้อมูลทั้งหมด</button>` : `<button disabled title="เฉพาะ Super Admin เท่านั้น" class="w-full sm:w-auto bg-slate-200 text-slate-400 px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg font-bold text-sm whitespace-nowrap cursor-not-allowed"><i class="fas fa-lock"></i> ล้างข้อมูลทั้งหมด</button>`}</div>`;
                if (isSuperAdminSettings) html += buildRecordToggleSettingsHtml() + buildPastLockSettingsHtml() + buildExternalLinksSettingsHtml();
                content.innerHTML = html;
            } 
            else if (currentAdminTab === 'term_settings') {
                let html = `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-3 flex items-center gap-2"><i class="fas fa-sliders-h text-indigo-500"></i> ข้อมูลภาคเรียน</h3><div class="mb-4 bg-indigo-50/70 p-3 sm:p-4 rounded-xl border border-indigo-200"><label class="block text-[10px] sm:text-xs font-bold text-indigo-700 mb-1.5"><i class="fas fa-broadcast-tower"></i> ภาคเรียนที่บังคับแสดงผลหน้าแรก (สำหรับผู้ใช้ทั่วไปที่ยังไม่ได้ล็อกอิน)</label><p class="text-[9px] sm:text-[11px] text-indigo-500 font-medium mb-3">ผู้ใช้ทั่วไปจะถูกบังคับให้เห็นเฉพาะภาคเรียนนี้เสมอเมื่อเข้าเว็บ และไม่สามารถสลับเองได้ - เลือกแล้วต้องกด "บันทึก" ด้านล่างจึงจะมีผลจริง</p><div class="flex items-center gap-1.5 flex-wrap mb-3">${(() => { const pendingTerm = (window.__pendingPublicTerm !== undefined && window.__pendingPublicTerm !== null) ? String(window.__pendingPublicTerm) : String(settings.term); return Array.from({length: settings.termCount || 2}, (_, i) => i + 1).map(tn => { const isSel = pendingTerm === String(tn); const isSaved = String(settings.term) === String(tn); return `<button onclick="window.selectPendingPublicTerm('${tn}')" class="${isSel ? 'bg-indigo-600 text-white shadow-sm' : 'bg-white border border-indigo-200 text-indigo-600 hover:bg-indigo-100'} px-3 sm:px-4 py-2 rounded-lg font-bold text-xs sm:text-sm transition-all flex items-center gap-1.5">${isSel ? '<i class="fas fa-check-circle"></i>' : ''} ภาคเรียน ${tn}${isSaved ? ' <span class="text-[8px] sm:text-[9px] font-normal opacity-75">(ปัจจุบัน)</span>' : ''}</button>`; }).join(''); })()}</div><div class="flex justify-end"><button onclick="window.savePublicTermSetting()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-save"></i> บันทึกภาคเรียนที่แสดงผลหน้าแรก</button></div></div><div class="mb-3 bg-slate-50 p-3 sm:p-4 rounded-xl border border-slate-100"><label class="block text-[10px] sm:text-xs font-bold text-slate-700 mb-2">จำนวนภาคเรียนของระบบ (ต่อปีการศึกษา)</label><div class="flex items-center gap-1.5 flex-wrap mb-3">${[1,2,3].map(n => { const pendingN = (window.__pendingTermCount !== undefined && window.__pendingTermCount !== null) ? Number(window.__pendingTermCount) : Number(settings.termCount || 2); const isSel = pendingN === n; const isSaved = Number(settings.termCount || 2) === n; return `<button onclick="window.selectPendingTermCount(${n})" class="${isSel ? 'bg-indigo-600 text-white shadow-sm' : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-100'} px-3 sm:px-4 py-2 rounded-lg font-bold text-xs sm:text-sm transition-all flex items-center gap-1.5">${isSel ? '<i class="fas fa-check-circle"></i>' : ''} ${n} ภาคเรียน${isSaved ? ' <span class="text-[8px] sm:text-[9px] font-normal opacity-75">(ปัจจุบัน)</span>' : ''}</button>`; }).join('')}</div><div class="flex justify-end"><button onclick="window.saveTermCountSetting()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-save"></i> บันทึกจำนวนภาคเรียน</button></div></div><div class="mb-3 bg-slate-50 p-3 sm:p-4 rounded-xl border border-slate-100"><div class="flex items-center justify-between mb-2"><label class="block text-[10px] sm:text-xs font-bold text-slate-700">ปีการศึกษา</label><button onclick="window.openAddYearPrompt()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-plus"></i> เพิ่มปี</button></div><p class="text-[9px] sm:text-[11px] text-slate-400 font-medium mb-3">เลือกปีที่ต้องการแสดงผลแล้วกด "บันทึก" ด้านล่างจึงจะมีผลจริง ปีที่ถูกจัดเก็บแล้ว (เก็บถาวร) จะถูกล็อคไว้ ต้องให้ Super Admin ปลดล็อคก่อนจึงจะเลือกใช้งานได้อีกครั้ง</p><div class="space-y-2 mb-3">${sortedAcademicYears().map(y => { const st = y.status === 'archived' ? 'archived' : 'active'; const pendingYear = (window.__pendingYear !== undefined && window.__pendingYear !== null) ? String(window.__pendingYear) : String(settings.year); const isSel = pendingYear === String(y.year); const isSaved = String(settings.year) === String(y.year); const isSuperAdminYr = currentUser && currentUser.role === 'super_admin'; return `<div class="flex items-center justify-between gap-2 bg-white border ${st === 'archived' ? 'border-blue-200' : 'border-slate-200'} rounded-lg px-3 py-2"><button onclick="window.selectPendingYear('${y.year}')" ${st === 'archived' ? 'disabled' : ''} class="flex-1 text-left flex items-center gap-2 ${st === 'archived' ? 'cursor-not-allowed opacity-70' : ''}">${isSel ? '<i class="fas fa-check-circle text-indigo-600"></i>' : (st === 'archived' ? '<i class="fas fa-lock text-blue-400"></i>' : '<i class="far fa-circle text-slate-300"></i>')}<span class="font-bold text-sm ${isSel ? 'text-indigo-700' : 'text-slate-600'}">ปีการศึกษา ${y.year}</span>${isSaved ? '<span class="text-[8px] sm:text-[9px] font-normal text-slate-400">(กำลังแสดงผลอยู่)</span>' : ''}${st === 'archived' ? '<span class="bg-blue-50 text-blue-600 border border-blue-200 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded">ถูกจัดเก็บแล้ว</span>' : '<span class="bg-emerald-50 text-emerald-600 border border-emerald-200 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded">พร้อมใช้งาน</span>'}${y.hidden ? '<span class="bg-slate-700 text-white text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded ml-1"><i class="fas fa-eye-slash"></i> ซ่อนจากแอดมินทั่วไป</span>' : ''}</button><div class="shrink-0 flex items-center gap-1.5">${st === 'archived' ? (isSuperAdminYr ? `<button onclick="window.unlockAcademicYear('${y.year}')" title="ปลดล็อคปีนี้ (เฉพาะ Super Admin)" class="bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-200 px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-colors"><i class="fas fa-lock-open"></i> ปลดล็อค</button>` : '') : `<button onclick="window.archiveAcademicYear('${y.year}')" title="จัดเก็บปีนี้ (เก็บถาวร)" class="bg-white hover:bg-rose-50 text-rose-500 border border-rose-200 px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-colors"><i class="fas fa-archive"></i> จัดเก็บ</button>`}${isSuperAdminYr ? `<button onclick="window.toggleYearVisibility('${y.year}')" title="${y.hidden ? 'แสดงปีนี้ให้แอดมินทั่วไปเห็นอีกครั้ง' : 'ซ่อนปีนี้จากแอดมินทั่วไป (เฉพาะ Super Admin เห็น)'}" class="${y.hidden ? 'bg-amber-50 hover:bg-amber-100 text-amber-600 border-amber-200' : 'bg-white hover:bg-slate-50 text-slate-400 border-slate-200'} border px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-colors"><i class="fas ${y.hidden ? 'fa-eye-slash' : 'fa-eye'}"></i></button>` : ''}<button onclick="window.deleteAcademicYear('${y.year}')" title="ลบปีการศึกษานี้ (เผื่อสร้างผิดพลาด)" class="bg-white hover:bg-rose-50 text-rose-400 border border-slate-200 hover:border-rose-200 px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-colors"><i class="fas fa-trash-alt"></i></button></div></div>`; }).join('')}</div><div class="flex justify-end"><button onclick="window.saveYearSetting()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5 shrink-0"><i class="fas fa-save"></i> บันทึกปีการศึกษาที่แสดงผล</button></div></div><h3 class="text-base sm:text-lg font-extrabold text-slate-800 mb-1.5 flex items-center gap-2"><i class="fas fa-toggle-on text-indigo-500"></i> สถานะการใช้งานแต่ละภาคเรียน</h3><p class="text-[9px] sm:text-[11px] text-slate-400 font-medium mb-3">เลือกสถานะแล้วต้องกด "บันทึก" ของภาคเรียนนั้นๆ จึงจะมีผลจริง</p>${Array.from({length: settings.termCount || 2}, (_, i) => i + 1).map(tn => { const pendingMap = window.__pendingTermStatusByTerm || {}; const pendingStatus = pendingMap[tn] || getTermStatus(tn, settings.year); const isPublicNow = Number(settings.term) === tn; const opts = [
    { key: 'open', label: 'เปิดใช้งาน', desc: 'ลงข้อมูล/เช็คชื่อได้ปกติ', icon: 'fa-wifi', activeCls: 'bg-emerald-600 text-white border-emerald-600', idleCls: 'bg-white border-slate-200 text-emerald-600 hover:bg-emerald-50' },
    { key: 'maintenance', label: 'ปิดปรับปรุงชั่วคราว', desc: 'ดูข้อมูลได้ปกติ แต่เช็คชื่อไม่ได้ชั่วคราว', icon: 'fa-tools', activeCls: 'bg-amber-500 text-white border-amber-500', idleCls: 'bg-white border-slate-200 text-amber-600 hover:bg-amber-50' },
    { key: 'not_opened', label: 'ยังไม่เปิดใช้งาน', desc: 'ผู้ใช้ทั่วไปสลับมาภาคเรียนนี้ไม่ได้', icon: 'fa-power-off', activeCls: 'bg-slate-500 text-white border-slate-500', idleCls: 'bg-white border-slate-200 text-slate-500 hover:bg-slate-100' },
    { key: 'locked', label: 'ล็อคข้อมูล', desc: 'ปิดใช้งานแล้ว แต่ดูข้อมูลย้อนหลังได้', icon: 'fa-box-archive', activeCls: 'bg-blue-600 text-white border-blue-600', idleCls: 'bg-white border-slate-200 text-blue-600 hover:bg-blue-50' }
]; return `<div class="mb-4 bg-slate-50 p-3 sm:p-4 rounded-xl border border-slate-100"><h4 class="text-sm sm:text-base font-extrabold text-slate-700 mb-2 flex items-center gap-2">ภาคเรียน ${tn}/${settings.year}${isPublicNow ? ' <span class="bg-indigo-100 text-indigo-700 border border-indigo-200 px-2 py-0.5 rounded-full text-[9px] sm:text-[10px] font-black"><i class="fas fa-broadcast-tower"></i> กำลังแสดงผลหน้าแรก</span>' : ''}</h4><div class="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-2">${opts.map(opt => `<button onclick="window.selectPendingTermStatusFor(${tn}, '${opt.key}')" class="${pendingStatus === opt.key ? opt.activeCls : opt.idleCls} border-2 rounded-xl px-3 py-2.5 sm:py-3 font-bold text-xs sm:text-sm transition-all flex flex-col items-center gap-1 text-center"><i class="fas ${opt.icon} text-base sm:text-lg"></i><span>${opt.label}</span><span class="text-[9px] sm:text-[10px] font-medium opacity-80">${opt.desc}</span></button>`).join('')}</div><div class="flex justify-end"><button onclick="window.saveTermStatusSettingFor(${tn})" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-save"></i> บันทึกสถานะภาคเรียน ${tn}</button></div></div>`; }).join('')}<div class="space-y-1.5 text-[10px] sm:text-[11px] text-slate-500 font-medium bg-white/70 rounded-lg p-3 border border-slate-200 mb-3"><p><span class="font-bold text-emerald-600"><i class="fas fa-wifi"></i> เปิดใช้งาน:</span> ผู้ใช้ทั่วไปสลับมาดู/ใช้งานภาคเรียนนี้ได้ตามปกติที่หน้าแรก ครูเช็คชื่อได้ และแอดมินลงข้อมูลวิชาได้ตามปกติ</p><p><span class="font-bold text-amber-600"><i class="fas fa-tools"></i> ปิดปรับปรุงชั่วคราว:</span> ทุกคนยังเข้าดูข้อมูล/รายงานของภาคเรียนนี้ได้ตามปกติ แอดมินยังแก้ไขวิชา/นักเรียนได้ตามปกติ แต่ครูจะเช็คชื่อไม่ได้ชั่วคราวจนกว่าจะเปลี่ยนกลับเป็น "เปิดใช้งาน" เหมาะสำหรับตอนต้องหยุดรับข้อมูลชั่วคราว เช่น กำลังตรวจสอบ/แก้ไขข้อมูลครั้งใหญ่</p><p><span class="font-bold text-slate-600"><i class="fas fa-power-off"></i> ยังไม่เปิดใช้งาน:</span> ปุ่มเลือกภาคเรียนนี้ที่หน้าแรกจะถูกล็อคไว้สำหรับผู้ใช้ทั่วไป มีเพียงแอดมินเท่านั้นที่เข้าถึงและจัดเตรียมรายวิชาล่วงหน้าได้ แต่ครูยังเช็คชื่อไม่ได้จนกว่าจะเปลี่ยนเป็น "เปิดใช้งาน"</p><p><span class="font-bold text-blue-600"><i class="fas fa-box-archive"></i> ล็อคข้อมูล:</span> ใช้เมื่อจบภาคเรียนแล้ว ทุกคนยังดูรายงาน/ประวัติย้อนหลังของภาคเรียนนี้ได้ตามปกติ แต่ไม่สามารถเพิ่ม/แก้ไขวิชาหรือเช็คชื่อเพิ่มเติมได้อีก</p></div>`;
                content.innerHTML = html;
            }
            else if (currentAdminTab === 'advisors') {
                let html = `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-1.5 flex items-center gap-2"><i class="fas fa-id-badge text-indigo-500"></i> ครูที่ปรึกษา และ เจ้าหน้าที่ <span class="text-[10px] sm:text-xs font-bold text-slate-400">(ภาคเรียน ${adminTerm()}/${adminYear()})</span></h3><p class="text-[9px] sm:text-[11px] text-slate-400 font-medium mb-3">ข้อมูลนี้แยกเก็บตามภาคเรียน กำหนดครูที่ปรึกษา/เจ้าหน้าที่ต่างกันในแต่ละภาคเรียนได้ (สลับภาคเรียนที่ต้องการแก้ไขได้จากแถบสีม่วงด้านบนสุดของหน้านี้) หากภาคเรียน/ปีนี้ยังไม่เคยตั้งค่าไว้ ระบบจะคัดลอกข้อมูลล่าสุดจากภาคเรียน/ปีที่ใกล้เคียงที่สุดมาให้ก่อนโดยอัตโนมัติ (มีป้ายกำกับ "คัดลอกมา") กรุณาตรวจสอบแล้วกดบันทึกเพื่อยืนยันสำหรับภาคเรียนนี้</p><div class="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-8">`;
                let tcOptions = teachers && teachers.length > 0 ? teachers.filter(t => !t.inactive).sort((a,b) => a.name.localeCompare(b.name)).map(t => `<option value="${t.name}">`).join('') : '';
                const teacherDatalistHtml = `<datalist id="teacherNamesDatalist">${tcOptions}</datalist>`;

                getRoomList().forEach(roomId => { 
                    const advs = getRoomAdvisors(roomId, adminTerm(), adminYear()); const adv1 = advs[0] || ""; const adv2 = advs[1] || "";
                    const staff = getRoomStaff(roomId, adminTerm(), adminYear());
                    const isCopied = (adv1 || adv2 || staff) && isPersonnelDataCopied(roomId, adminTerm(), adminYear());
                    const hasAdvisorAssigned = !!(adv1 || adv2);
                    const hasStaffAssigned = !!staff;
                    const isIncomplete = !hasAdvisorAssigned || !hasStaffAssigned;

                    html += `<div class="bg-slate-50 p-2.5 rounded-lg border-2 ${isIncomplete ? 'border-rose-400' : (isCopied ? 'border-amber-300' : 'border-slate-100')} flex flex-col gap-1.5 shadow-sm"><div class="font-black text-indigo-800 text-[10px] sm:text-sm mb-1 flex items-center justify-between flex-wrap gap-1"><span><i class="fas fa-users"></i> ห้อง ${formatRoomName(roomId)}</span><span class="flex gap-1">${isIncomplete ? `<span class="bg-rose-100 text-rose-700 border border-rose-300 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded" title="ยังไม่มีครูที่ปรึกษาและ/หรือเจ้าหน้าที่ประจำห้อง"><i class="fas fa-exclamation-triangle"></i> ข้อมูลยังไม่ครบ</span>` : ''}${isCopied ? '<span class="bg-amber-100 text-amber-700 border border-amber-300 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded" title="คัดลอกจากภาคเรียน/ปีอื่น ยังไม่ได้บันทึกสำหรับภาคเรียนนี้"><i class="fas fa-copy"></i> คัดลอกมา</span>' : ''}</span></div><input type="text" list="teacherNamesDatalist" id="adv1_${roomId}" value="${(adv1||'').replace(/"/g,'&quot;')}" placeholder="พิมพ์ชื่อครูที่ปรึกษาคนที่ 1..." class="w-full bg-white border border-slate-200 rounded px-2 py-1.5 text-base sm:text-sm font-bold focus:ring-1 focus:ring-indigo-500 outline-none text-slate-600"><input type="text" list="teacherNamesDatalist" id="adv2_${roomId}" value="${(adv2||'').replace(/"/g,'&quot;')}" placeholder="พิมพ์ชื่อครูที่ปรึกษาคนที่ 2..." class="w-full bg-white border border-slate-200 rounded px-2 py-1.5 text-base sm:text-sm font-bold focus:ring-1 focus:ring-indigo-500 outline-none text-slate-600"><input type="text" list="teacherNamesDatalist" id="staff_${roomId}" value="${(staff||'').replace(/"/g,'&quot;')}" placeholder="พิมพ์ชื่อเจ้าหน้าที่ประจำห้อง..." class="w-full bg-white border border-slate-200 rounded px-2 py-1.5 text-base sm:text-sm font-bold focus:ring-1 focus:ring-indigo-500 outline-none text-slate-600"></div>`;
                });
                html += teacherDatalistHtml;
                html += `</div><div class="flex justify-end mb-8"><button onclick="window.saveAdvisors()" class="w-full sm:w-auto bg-emerald-600 hover:bg-emerald-700 text-white px-4 sm:px-6 py-2 sm:py-2.5 rounded-lg font-bold shadow-sm transition-colors text-sm"><i class="fas fa-save"></i> บันทึกบุคลากรประจำห้อง</button></div>`;
                content.innerHTML = html;
            }
            else if (currentAdminTab === 'data_health') {
                const isSuperAdminDS = currentUser && currentUser.role === 'super_admin';
                const fmtSize = (b) => b < 1024 ? `${b} B` : (b < 1024*1024 ? `${(b/1024).toFixed(1)} KB` : `${(b/1024/1024).toFixed(2)} MB`);
                const limitChars = settings.storageLimitChars || 8000000;

                // ===== [ใหม่] ดึงขนาดไฟล์จริงจาก Drive (ไฟล์หลัก + ไฟล์เช็คชื่อรายภาคเรียน/ปีทุกไฟล์) แทนการคำนวณจากข้อมูลในเครื่องซึ่งตอนนี้มีแค่ภาคเรียนปัจจุบัน =====
                if (!window.__storageInfo && !window.__storageInfoLoading) {
                    window.__storageInfoLoading = true;
                    fetch(`${GOOGLE_APP_SCRIPT_URL}?action=get_storage_info`).then(r => r.json()).then(info => {
                        window.__storageInfo = info; window.__storageInfoLoading = false;
                        if (currentAdminTab === 'data_health') renderAdminTab();
                    }).catch(() => { window.__storageInfoLoading = false; });
                }

                let html = `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-3 flex items-center gap-2"><i class="fas fa-hdd text-indigo-500"></i> ขนาดข้อมูลที่ใช้ไป</h3><p class="text-[10px] sm:text-xs text-slate-500 font-medium mb-4">ข้อมูลตอนนี้แยกเก็บเป็นหลายไฟล์บน Drive (ไฟล์หลัก + ไฟล์เช็คชื่อแยกรายภาคเรียน/ปี) แต่ละไฟล์มีขีดจำกัดขนาดของตัวเองแยกกัน ไม่รวมกันเหมือนเดิม</p>`;

                if (!window.__storageInfo) {
                    html += `<div class="flex items-center justify-center py-10 text-slate-400 gap-2"><i class="fas fa-spinner fa-spin"></i> กำลังดึงขนาดไฟล์จริงจากเซิร์ฟเวอร์...</div>`;
                } else {
                    const info = window.__storageInfo;
                    const renderFileBar = (label, icon, color, bytes) => {
                        const usagePct = Math.min(100, Math.round((bytes / limitChars) * 100));
                        const barColor = usagePct >= 100 ? 'bg-rose-600' : (usagePct >= 90 ? 'bg-rose-500' : (usagePct >= 70 ? 'bg-amber-500' : 'bg-emerald-500'));
                        return `<div class="bg-slate-50 p-3 sm:p-4 rounded-xl border border-slate-100 mb-2"><div class="flex justify-between items-center mb-1.5"><span class="text-xs sm:text-sm font-bold text-slate-700 flex items-center gap-1.5"><i class="fas ${icon} ${color.replace('bg-','text-')}"></i> ${label}</span><span class="text-xs sm:text-sm font-black ${usagePct >= 90 ? 'text-rose-500' : (usagePct >= 70 ? 'text-amber-500' : 'text-emerald-600')}">${fmtSize(bytes)} (${usagePct}%)</span></div><div class="w-full h-2.5 sm:h-3 bg-slate-200 rounded-full overflow-hidden"><div class="${barColor} h-full rounded-full transition-all duration-700" style="width: ${usagePct}%"></div></div></div>`;
                    };

                    html += `<h4 class="text-xs sm:text-sm font-black text-slate-500 uppercase tracking-wider mb-2 mt-4"><i class="fas fa-file-alt"></i> ไฟล์หลัก (ตั้งค่า/ครู/วิชา/นักเรียน)</h4>`;
                    html += info.mainFile ? renderFileBar('SchoolAttendanceDB.json', 'fa-database', 'bg-indigo-400', info.mainFile.sizeBytes) : `<p class="text-xs text-slate-400 mb-4">ยังไม่พบไฟล์หลัก</p>`;
                    if (info.mainFile) {
                        html += info.mainFileHasLeftoverAttendance
                            ? `<div class="flex flex-wrap items-center justify-between gap-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 -mt-1 mb-3"><span class="text-[10px] sm:text-xs font-bold text-amber-700"><i class="fas fa-exclamation-triangle"></i> พบข้อมูลเช็คชื่อค้างอยู่ในไฟล์หลัก (ระบบจะล้างให้อัตโนมัติเมื่อมีการใช้งานครั้งถัดไป)</span>${isSuperAdminDS ? `<button onclick="window.forceCleanMainFile()" class="bg-amber-600 hover:bg-amber-700 text-white px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold shrink-0"><i class="fas fa-broom"></i> ล้างทันที</button>` : ''}</div>`
                            : `<div class="flex items-center gap-2 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 -mt-1 mb-3"><span class="text-[10px] sm:text-xs font-bold text-emerald-700"><i class="fas fa-check-circle"></i> ไฟล์หลักสะอาด ไม่มีข้อมูลเช็คชื่อตกค้าง</span></div>`;
                    }

                    html += `<h4 class="text-xs sm:text-sm font-black text-slate-500 uppercase tracking-wider mb-2 mt-4"><i class="fas fa-history"></i> ไฟล์ประวัติการแก้ไข (แยกต่างหาก)</h4>`;
                    html += info.logsFile ? renderFileBar('ActivityLogs.json', 'fa-history', 'bg-slate-400', info.logsFile.sizeBytes) : `<p class="text-xs text-slate-400 mb-4">ยังไม่มีไฟล์ log (จะสร้างอัตโนมัติเมื่อมีการใช้งานครั้งแรก)</p>`;

                    const currentTermYearKey = String(adminTerm()) + '/' + String(adminYear());
                    // แอดมินทั่วไปเห็นแค่ภาคเรียน/ปีที่กำลังดูอยู่ (เบากว่า ไม่ต้องแสดงทุกภาคเรียน) - Super Admin เห็นครบทุกภาคเรียน/ปี พร้อมย่อ/ขยายได้
                    const visibleAttFiles = isSuperAdminDS ? info.attendanceFiles : info.attendanceFiles.filter(f => (f.term + '/' + f.year) === currentTermYearKey);
                    html += `<h4 class="text-xs sm:text-sm font-black text-slate-500 uppercase tracking-wider mb-2 mt-5"><i class="fas fa-calendar-check"></i> ไฟล์เช็คชื่อแยกรายห้อง (${visibleAttFiles.length} ไฟล์${isSuperAdminDS ? '' : ` - ภาคเรียน ${currentTermYearKey}`})</h4>`;
                    if (visibleAttFiles.length === 0) {
                        html += `<p class="text-xs text-slate-400 mb-2">ยังไม่มีไฟล์เช็คชื่อ${isSuperAdminDS ? '' : 'ของภาคเรียนนี้'}</p>`;
                    } else {
                        // จัดกลุ่มตามภาคเรียน/ปีก่อน แล้วเรียงห้องภายในแต่ละกลุ่ม อ่านง่ายกว่าเรียงมั่ว
                        const grouped = {};
                        visibleAttFiles.forEach(f => {
                            const key = f.term + '/' + f.year;
                            if (!grouped[key]) grouped[key] = [];
                            grouped[key].push(f);
                        });
                        if (!window.__storageGroupExpanded) window.__storageGroupExpanded = {};
                        Object.keys(grouped).sort().reverse().forEach(key => {
                            const isCurrentTerm = key === currentTermYearKey;
                            const groupBytes = grouped[key].reduce((sum, f) => sum + f.sizeBytes, 0);
                            const roomFilesHtml = grouped[key].sort((a, b) => (a.room || '').localeCompare(b.room || '')).map(f => {
                                const label = f.legacyPendingMigration ? `⏳ ไฟล์รวมทุกห้อง (รอแยกเป็นรายห้องอัตโนมัติ)` : `ห้อง ${formatRoomName(f.room)}`;
                                return renderFileBar(label, 'fa-calendar-check', 'bg-emerald-400', f.sizeBytes);
                            }).join('');
                            if (isSuperAdminDS) {
                                // Super Admin: หัวข้อกดย่อ/ขยายได้ ค่าเริ่มต้นเปิดเฉพาะภาคเรียนที่กำลังดูอยู่
                                const expanded = key in window.__storageGroupExpanded ? window.__storageGroupExpanded[key] : isCurrentTerm;
                                html += `<button onclick="window.__storageGroupExpanded['${key}'] = ${!expanded}; renderAdminTab();" class="w-full flex items-center justify-between gap-2 mt-3 mb-1.5 text-left"><span class="text-[10px] sm:text-xs font-black text-slate-500">ภาคเรียน ${key}${isCurrentTerm ? ' <span class="text-indigo-500">(กำลังดูอยู่)</span>' : ''} <span class="text-slate-400 font-medium">(${grouped[key].length} ห้อง, รวม ${fmtSize(groupBytes)})</span></span><i class="fas fa-chevron-${expanded ? 'up' : 'down'} text-slate-400 text-[10px]"></i></button>${expanded ? roomFilesHtml : ''}`;
                            } else {
                                html += `<p class="text-[10px] sm:text-xs font-black text-slate-400 mt-3 mb-1.5">ภาคเรียน ${key} <span class="text-indigo-500">(กำลังดูอยู่)</span></p>${roomFilesHtml}`;
                            }
                        });
                    }

                    if (isSuperAdminDS) {
                        html += `<div class="flex flex-wrap items-center justify-between gap-2 bg-teal-50 border border-teal-200 rounded-lg px-3 py-2.5 mt-2 mb-2"><span class="text-[10px] sm:text-xs font-bold text-teal-700"><i class="fas fa-folder-plus"></i> สร้างไฟล์เช็คชื่อล่วงหน้าให้ครบทุกห้องของภาคเรียน ${adminTerm()}/${adminYear()} (ไม่บังคับ - ไฟล์จะถูกสร้างอัตโนมัติอยู่แล้วตอนเช็คชื่อจริงครั้งแรก)</span><button onclick="window.ensureRoomFilesForCurrentTerm()" class="bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold shrink-0"><i class="fas fa-plus"></i> สร้างไฟล์ล่วงหน้า</button></div>`;
                    }
                    html += isSuperAdminDS ? `<div class="flex flex-wrap items-end gap-2 mt-4 pt-4 border-t border-slate-200"><div class="flex-1 min-w-[160px]"><label class="block text-[10px] sm:text-xs font-bold text-slate-700 mb-1">ตั้งขีดจำกัดพื้นที่ต่อไฟล์ (ตัวอักษร)</label><input type="number" id="setStorageLimit" value="${limitChars}" min="1000" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-indigo-500 outline-none"></div><button onclick="window.saveStorageLimit()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-save"></i> บันทึกขีดจำกัด</button></div><p class="text-[10px] sm:text-xs text-slate-400 font-medium mt-2"><i class="fas fa-info-circle"></i> ขีดจำกัดนี้ใช้ประเมิน % ของแต่ละไฟล์แยกกัน (ไม่ใช่รวมกัน) อ้างอิงขีดจำกัดจริงของ DriveApp.createFile() ที่ประมาณ 10MB ต่อไฟล์ เผื่อระยะปลอดภัยไว้ที่ 8,000,000 ตัวอักษร</p>` : `<p class="text-[10px] sm:text-xs text-slate-400 font-medium mt-3"><i class="fas fa-lock"></i> เฉพาะ Super Admin เท่านั้นที่ตั้งขีดจำกัดพื้นที่จัดเก็บได้</p>`;
                }

content.innerHTML = html;
            }
            else if (currentAdminTab === 'backup') {
                const isSuperAdminBk = currentUser && currentUser.role === 'super_admin';
                const backupTermYearKey = String(adminTerm()) + '_' + String(adminYear());
                if (!window.__adminTermRoomsLoaded.has(backupTermYearKey)) {
                    content.innerHTML = renderLoadingProgressHTML(`กำลังโหลดข้อมูลเช็คชื่อภาคเรียน ${adminTerm()}/${adminYear()} (สำหรับสถิติ)...`, 5, 'backupLoadBar');
                    ensureAttendanceLoadedForAllRoomsInTerm(adminTerm(), adminYear(), (done, total) => {
                        const pct = Math.round((done / total) * 100);
                        const bar = document.getElementById('backupLoadBar'); if (bar) bar.style.width = pct + '%';
                        const pctText = document.getElementById('backupLoadBar_pct'); if (pctText) pctText.textContent = pct;
                    }).then(() => { window.__adminTermRoomsLoaded.add(backupTermYearKey); renderAdminTab(); });
                    return;
                }
                const oldestDate = attendanceData.reduce((min, a) => (a.date && (!min || a.date < min)) ? a.date : min, null);
                let html = `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-1 flex items-center gap-2"><i class="fas fa-shield-alt text-purple-500"></i> สำรองข้อมูล</h3><p class="text-[10px] sm:text-xs text-slate-500 font-medium mb-6">รวมทุกช่องทางการเก็บถาวร/สำรองข้อมูลเช็คชื่อไว้ในที่เดียว ไม่ว่าจะเก็บถาวรแบบไหน ไฟล์จะถูกบันทึกไว้บนเซิร์ฟเวอร์เสมอ และดูย้อนหลังหรือดาวน์โหลดซ้ำได้จากส่วน "ดูข้อมูลเช็คชื่อที่เก็บถาวรแล้ว" ด้านล่างทั้งหมด (ระบบยังมีนโยบายเก็บถาวรข้อมูลที่เก่ากว่า 2 ปีให้อัตโนมัติอยู่แล้วทุกครั้งที่บันทึกข้อมูลด้วย)</p>`;

                // ===== 1. เก็บถาวรข้อมูลเช็คชื่อเก่า (เก็บด่วน/นอกรอบ) =====
                html += `<div class="mb-6 bg-purple-50/60 p-4 sm:p-6 rounded-2xl border border-purple-200"><h4 class="text-base sm:text-lg font-extrabold text-purple-800 mb-2 flex items-center gap-2"><i class="fas fa-archive text-purple-500"></i> เก็บถาวรข้อมูลเช็คชื่อเก่า (เก็บด่วน/นอกรอบ)</h4><p class="text-[10px] sm:text-xs text-purple-600 font-medium mb-3">ใช้เผื่อต้องการเก็บถาวรข้อมูลเร็วกว่ากำหนด หรือกำหนดวันที่เอง เช่น ก่อนขึ้นภาคเรียนใหม่${oldestDate ? ` (ข้อมูลเก่าสุดที่มีอยู่: ${oldestDate.split('-').reverse().join('/')})` : ''}</p><div class="flex flex-wrap items-end gap-2"><div class="flex-1 min-w-[160px]"><label class="block text-[10px] sm:text-xs font-bold text-purple-700 mb-1">เก็บถาวรข้อมูลที่บันทึกก่อนวันที่</label><input type="date" id="archiveCutoffDate" onchange="window.updateArchivePreview()" class="w-full bg-white border border-purple-200 rounded-lg px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-purple-400 outline-none"></div><button onclick="window.archiveOldAttendance()" class="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-file-download"></i> เก็บถาวร</button></div><p id="archivePreviewText" class="text-[10px] sm:text-xs text-purple-500 font-bold mt-2">เลือกวันที่เพื่อดูจำนวนข้อมูลที่จะถูกเก็บถาวร</p></div>`;

                // ===== 2. จัดเก็บปีการศึกษา (เชื่อมกับทะเบียนปีการศึกษาโดยตรง) =====
                html += `<div class="mb-6 bg-blue-50/60 p-4 sm:p-6 rounded-2xl border border-blue-200"><h4 class="text-base sm:text-lg font-extrabold text-blue-800 mb-2 flex items-center gap-2"><i class="fas fa-graduation-cap text-blue-500"></i> จัดเก็บข้อมูลรายปีการศึกษา</h4><p class="text-[10px] sm:text-xs text-blue-600 font-medium mb-3">จัดเก็บ (archive) ข้อมูลเช็คชื่อทั้งปีการศึกษาในคราวเดียว เหมาะสำหรับตอนจบปีการศึกษา ปีที่ถูกจัดเก็บแล้วจะถูกล็อค ต้องให้ Super Admin ปลดล็อคก่อนจึงจะนำกลับมาใช้งานได้ (จัดการปีการศึกษาเพิ่มเติม/เพิ่มปีใหม่ได้ที่แท็บ "ตั้งค่าภาคเรียน")</p><div class="space-y-1.5">${sortedAcademicYears().map(y => { const st = y.status === 'archived' ? 'archived' : 'active'; const isCurrentPublic = String(settings.year) === String(y.year);
                    return `<div class="flex items-center justify-between gap-2 bg-white border ${st === 'archived' ? 'border-blue-200' : 'border-slate-200'} rounded-lg px-3 py-2"><div class="flex items-center gap-2"><span class="font-bold text-sm text-slate-700">ปีการศึกษา ${y.year}</span>${isCurrentPublic ? '<span class="text-[8px] sm:text-[9px] font-normal text-slate-400">(กำลังแสดงผลอยู่)</span>' : ''}${st === 'archived' ? '<span class="bg-blue-50 text-blue-600 border border-blue-200 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded">ถูกจัดเก็บแล้ว</span>' : '<span class="bg-emerald-50 text-emerald-600 border border-emerald-200 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded">พร้อมใช้งาน</span>'}</div>${st === 'archived' ? (isSuperAdminBk ? `<button onclick="window.unlockAcademicYear('${y.year}')" class="bg-blue-50 hover:bg-blue-100 text-blue-600 border border-blue-200 px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-colors"><i class="fas fa-lock-open"></i> ปลดล็อค</button>` : '<span class="text-[9px] sm:text-[10px] text-slate-400 font-bold"><i class="fas fa-lock"></i> เฉพาะ Super Admin</span>') : `<button onclick="window.archiveAcademicYear('${y.year}')" class="bg-white hover:bg-blue-50 text-blue-500 border border-blue-200 px-2.5 py-1.5 rounded-lg text-[10px] sm:text-xs font-bold transition-colors"><i class="fas fa-archive"></i> จัดเก็บปีนี้</button>`}</div>`; }).join('')}</div></div>`;

                // ===== 3. ดูข้อมูลเช็คชื่อที่เก็บถาวรแล้ว (รวมทุกแหล่งที่มาไว้ในที่เดียว) =====
                html += `<div class="mb-6 bg-slate-50 p-4 sm:p-6 rounded-2xl border border-slate-200"><div class="flex flex-wrap items-center justify-between gap-2 mb-2"><h4 class="text-base sm:text-lg font-extrabold text-slate-800 flex items-center gap-2"><i class="fas fa-box-open text-slate-500"></i> ดูข้อมูลเช็คชื่อที่เก็บถาวรแล้ว</h4><button onclick="window.loadArchiveList()" class="bg-white border border-slate-300 hover:bg-slate-100 text-slate-700 px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-sync-alt"></i> โหลดรายชื่อไฟล์</button></div><p class="text-[10px] sm:text-xs text-slate-500 font-medium mb-3">รวมไฟล์ที่เก็บถาวรไว้ทั้งหมด ไม่ว่าจะมาจากนโยบายอัตโนมัติทุก 2 ปี, เก็บด่วนนอกรอบ, หรือจัดเก็บรายปีการศึกษาด้านบน กดปุ่ม "โหลดรายชื่อไฟล์" เพื่อเริ่มดู แล้วเลือกไฟล์ที่ต้องการดาวน์โหลดเป็น Excel เพื่อดูรายละเอียด</p><div id="archiveListContainer" class="space-y-0"><div class="text-center text-slate-400 py-4 text-xs sm:text-sm font-medium">กดปุ่ม "โหลดรายชื่อไฟล์" ด้านบนเพื่อเริ่มต้น</div></div></div>`;

                // ===== 4. กู้คืนฐานข้อมูลจาก Snapshot (สำรองอัตโนมัติรายสัปดาห์) - เฉพาะ Super Admin เท่านั้น เพราะเป็นการเขียนทับข้อมูลปัจจุบันทั้งหมด =====
                if (isSuperAdminBk) {
                    html += `<div class="mb-6 bg-rose-50/60 p-4 sm:p-6 rounded-2xl border-2 border-rose-300"><div class="flex flex-wrap items-center justify-between gap-2 mb-2"><h4 class="text-base sm:text-lg font-extrabold text-rose-800 flex items-center gap-2"><i class="fas fa-history text-rose-500"></i> สำรอง / กู้คืนฐานข้อมูล (Snapshot)</h4><div class="flex flex-wrap gap-1.5"><button onclick="window.snapshotNow()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-save"></i> สำรองตอนนี้</button><button onclick="window.loadSnapshotList()" class="bg-white border border-rose-300 hover:bg-rose-100 text-rose-700 px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-sync-alt"></i> โหลดรายชื่อไฟล์สำรอง</button></div></div><p class="text-[10px] sm:text-xs text-slate-600 font-medium mb-2"><i class="fas fa-info-circle"></i> ไฟล์สำรองเก็บ ห้อง / วิชา / ครู / นักเรียน / ตั้งค่า (ไม่รวมการเช็คชื่อ — การเช็คชื่อมีสำรองแยกรายห้อง) · ระบบสำรองให้อัตโนมัติรายสัปดาห์ + ทุกครั้งก่อนนำเข้ารายชื่อนักเรียน · "กู้คืนเฉพาะรายชื่อนักเรียน" = เปลี่ยนแค่รายชื่อ (ห้อง/วิชา/ครู/ตั้งค่า คงเดิม)</p><p class="text-[10px] sm:text-xs text-rose-600 font-bold mb-3"><i class="fas fa-exclamation-triangle"></i> ใช้เฉพาะกรณีฉุกเฉินเท่านั้น เช่น ข้อมูลถูกล้าง/เขียนทับผิดพลาด — การกู้คืนจะ<u>เขียนทับข้อมูลปัจจุบันทั้งหมด</u>ด้วยข้อมูล ณ เวลาที่สำรองไว้ (ระบบจะสำรองสถานะปัจจุบันไว้ก่อนกู้คืนให้อัตโนมัติเผื่อกู้คืนผิดไฟล์)</p><div id="snapshotListContainer" class="space-y-1.5"><div class="text-center text-slate-400 py-4 text-xs sm:text-sm font-medium">กดปุ่ม "โหลดรายชื่อไฟล์สำรอง" ด้านบนเพื่อเริ่มต้น</div></div></div>`;
                }

                content.innerHTML = html;
            }
            else if (currentAdminTab === 'student_followup') {
                // ===== [ใหม่] แท็บติดตามนักเรียน แบบรวมทุกห้อง แบ่งตามระดับชั้น - สำหรับเจ้าหน้าที่บันทึกแทนครูที่ปรึกษาที่มารายงานด้วยวาจา/ช่องทางอื่น =====
                const fuTermYearKey = String(adminTerm()) + '_' + String(adminYear());
                if (!window.__adminTermRoomsLoaded.has(fuTermYearKey)) {
                    content.innerHTML = renderLoadingProgressHTML(`กำลังโหลดข้อมูลเช็คชื่อภาคเรียน ${adminTerm()}/${adminYear()} ทุกห้อง...`, 5, 'fuLoadBar');
                    ensureAttendanceLoadedForAllRoomsInTerm(adminTerm(), adminYear(), (done, total) => {
                        const pct = Math.round((done / total) * 100);
                        const bar = document.getElementById('fuLoadBar'); if (bar) bar.style.width = pct + '%';
                        const pctText = document.getElementById('fuLoadBar_pct'); if (pctText) pctText.textContent = pct;
                    }).then(() => { window.__adminTermRoomsLoaded.add(fuTermYearKey); renderAdminTab(); });
                    return;
                }
                if (!window.__followupSelectedMonth) { const now = new Date(); window.__followupSelectedMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`; }
                const fuMonth = window.__followupSelectedMonth;
                const fuMonthNames = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
                const fuDisplayMonth = `${fuMonthNames[parseInt(fuMonth.split('-')[1]) - 1]} ${parseInt(fuMonth.split('-')[0]) + 543}`;
                // รวมรายชื่อที่ต้องติดตามจากทุกห้อง แล้วจัดกลุ่มตามระดับชั้น (ม.1-ม.6)
                const fuGroups = { 1: [], 2: [], 3: [], 4: [], 5: [], 6: [] };
                getRoomList().forEach(roomId => {
                    const gradeMatch = roomId.match(/m(\d+)_/);
                    if (!gradeMatch) return;
                    const grade = parseInt(gradeMatch[1]);
                    const { incompleteAttendanceList } = computeRoomIncompleteList(roomId, fuMonth);
                    incompleteAttendanceList.forEach(row => { if (row.student.status !== 'resigned') fuGroups[grade].push({ ...row, roomId }); });
                });
                let html = `<div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4"><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 flex items-center gap-2"><i class="fas fa-user-graduate text-orange-500"></i> ติดตามนักเรียน (ทุกห้อง)</h3><input type="month" value="${fuMonth}" onchange="window.__followupSelectedMonth = this.value; renderAdminTab();" class="bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-bold outline-none focus:ring-2 focus:ring-orange-400"></div><p class="text-[10px] sm:text-xs text-slate-500 font-medium mb-5">รวมนักเรียนที่ต้องติดตามจากทุกห้อง ประจำเดือน${fuDisplayMonth} แบ่งตามระดับชั้น — ใช้บันทึกแทนครูที่ปรึกษาที่มารายงานผลการติดตามด้วยวาจา/ช่องทางอื่น</p>`;
                const totalFuCount = Object.values(fuGroups).reduce((a, arr) => a + arr.length, 0);
                if (totalFuCount === 0) {
                    html += `<div class="text-center text-slate-400 py-16 font-medium"><i class="fas fa-check-circle text-3xl mb-3 block text-emerald-400"></i>ไม่มีนักเรียนที่ต้องติดตามในเดือนนี้ ทุกห้อง</div>`;
                } else {
                    [1,2,3,4,5,6].forEach(grade => {
                        const list = fuGroups[grade];
                        if (list.length === 0) return;
                        const followedCount = list.filter(row => followUps.find(f => f.studentId === row.student.id && f.month === fuMonth)).length;
                        html += `<div class="mb-5"><h4 class="font-extrabold text-slate-700 text-sm sm:text-base mb-2 flex items-center gap-2"><span class="bg-indigo-100 text-indigo-700 border border-indigo-200 px-2.5 py-1 rounded-lg text-xs sm:text-sm">ม.${grade}</span><span class="text-slate-400 font-medium text-xs">${followedCount}/${list.length} ติดตามแล้ว</span></h4><div class="space-y-2">`;
                        list.sort((a, b) => a.roomId.localeCompare(b.roomId) || parseInt(a.student.number) - parseInt(b.student.number)).forEach(row => {
                            const fu = followUps.find(f => f.studentId === row.student.id && f.month === fuMonth);
                            const reasonBadges = [
                                row.triggerDatesThisMonth.length > 0 ? `<span class="bg-orange-100 text-orange-700 border border-orange-200 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded"><i class="fas fa-door-open"></i> เข้าเรียนไม่ครบ</span>` : '',
                                row.lateExceeded ? `<span class="bg-amber-100 text-amber-700 border border-amber-200 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded"><i class="fas fa-clock"></i> สายเกินเกณฑ์ (${row.monthly['สาย']} วัน)</span>` : '',
                                row.absentExceeded ? `<span class="bg-rose-100 text-rose-700 border border-rose-200 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded"><i class="fas fa-user-times"></i> ขาดเกินเกณฑ์ (${row.monthly['ขาด']} วัน)</span>` : ''
                            ].filter(Boolean).join(' ');
                            html += `<div class="bg-white border border-slate-200 rounded-xl p-3"><div class="flex flex-wrap items-center justify-between gap-2"><div class="min-w-0"><span class="font-bold text-slate-800 text-xs sm:text-sm">${row.student.number}. ${row.student.name}</span> <span class="text-slate-400 text-[10px] sm:text-xs font-bold">${formatRoomName(row.roomId)}</span><div class="flex flex-wrap gap-1 mt-1">${reasonBadges}</div></div>${fu ? `<span class="text-[9px] sm:text-[10px] font-bold text-emerald-700 bg-emerald-100 border border-emerald-200 px-2 py-1 rounded-full shrink-0"><i class="fas fa-check-circle"></i> ติดตามแล้ว</span>` : `<button onclick="window.markFollowUpWithNote('${row.student.id}', '${fuMonth}')" class="text-[9px] sm:text-[10px] bg-indigo-600 hover:bg-indigo-700 text-white px-2.5 py-1 rounded-full shadow-sm transition-colors font-bold shrink-0"><i class="fas fa-clipboard-check"></i> บันทึกติดตาม</button>`}</div>${fu && fu.notes ? `<div class="mt-2 pt-2 border-t border-slate-100 text-[10px] sm:text-xs text-slate-500"><i class="fas fa-sticky-note text-slate-400"></i> ${fu.notes.replace(/</g,'&lt;')}</div>` : ''}</div>`;
                        });
                        html += `</div></div>`;
                    });
                }
                content.innerHTML = html;
            }
            else if (currentAdminTab === 'att_report') {
                // ===== [v1.77] รายงานการเช็คชื่อประจำสัปดาห์ (PDF) — เฉพาะ Super Admin =====
                if (!currentUser || currentUser.role !== 'super_admin') { content.innerHTML = `<div class="text-center text-slate-400 py-14 text-sm font-medium"><i class="fas fa-lock text-3xl mb-3 block"></i> หน้านี้สำหรับ Super Admin เท่านั้น</div>`; return; }
                const wrKey = String(adminTerm()) + '_' + String(adminYear());
                if (!window.__adminTermRoomsLoaded.has(wrKey)) {
                    content.innerHTML = renderLoadingProgressHTML(`กำลังโหลดข้อมูลเช็คชื่อภาคเรียน ${adminTerm()}/${adminYear()} ทุกห้อง...`, 5, 'wrLoadBar');
                    ensureAttendanceLoadedForAllRoomsInTerm(adminTerm(), adminYear(), (done, total) => {
                        const pct = Math.round((done / total) * 100);
                        const bar = document.getElementById('wrLoadBar'); if (bar) bar.style.width = pct + '%';
                        const t = document.getElementById('wrLoadBar_pct'); if (t) t.textContent = pct;
                    }).then(() => { window.__adminTermRoomsLoaded.add(wrKey); renderAdminTab(); });
                    return;
                }
                content.innerHTML = rptTabHtml(); // [v2.02.3] แท็บรายงาน = ประจำสัปดาห์ + สอนแทน
            }
            else if (currentAdminTab === 'teacher_log') {
                // ===== เฉพาะ Super Admin เท่านั้นที่ดูแท็บนี้ได้ =====
                const isSuperAdminLog = currentUser && currentUser.role === 'super_admin';
                if (!isSuperAdminLog) {
                    content.innerHTML = `<div class="text-center text-slate-400 py-14 text-sm font-medium"><i class="fas fa-lock text-3xl mb-3 block"></i> หน้านี้สำหรับ Super Admin เท่านั้น</div>`;
                    return;
                }
                const logTermYearKey = String(adminTerm()) + '_' + String(adminYear());
                if (!window.__adminTermRoomsLoaded.has(logTermYearKey)) {
                    content.innerHTML = renderLoadingProgressHTML(`กำลังโหลดข้อมูลเช็คชื่อภาคเรียน ${adminTerm()}/${adminYear()} ทุกห้อง...`, 5, 'logLoadBar');
                    ensureAttendanceLoadedForAllRoomsInTerm(adminTerm(), adminYear(), (done, total) => {
                        const pct = Math.round((done / total) * 100);
                        const bar = document.getElementById('logLoadBar'); if (bar) bar.style.width = pct + '%';
                        const pctText = document.getElementById('logLoadBar_pct'); if (pctText) pctText.textContent = pct;
                    }).then(() => { window.__adminTermRoomsLoaded.add(logTermYearKey); renderAdminTab(); });
                    return;
                }
                // ===== log แจ้งว่าวิชาไหน ครูคนไหน เช็คชื่อไปเมื่อไหร่ (เรียงล่าสุดขึ้นก่อน) =====
                const trackedSubjectIds = new Set(subjects.filter(s => String(s.term) === String(adminTerm()) && String(s.year) === String(adminYear())).map(s => s.id));
                const allTeacherNamesInLog = Array.from(new Set(
                    subjects.filter(s => trackedSubjectIds.has(s.id)).flatMap(s => [s.teacher, s.teacher2]).filter(Boolean)
                ));
                // จัดกลุ่มครูตามกลุ่มสาระการเรียนรู้ (department) สำหรับ dropdown - ครูที่ไม่มีข้อมูล department จะถูกจัดไว้ในกลุ่ม "ไม่ระบุกลุ่มสาระ"
                const teacherDeptGroups = {};
                allTeacherNamesInLog.forEach(name => {
                    const t = teachers.find(x => x.name === name);
                    const dept = (t && t.department) ? t.department : 'ไม่ระบุกลุ่มสาระ';
                    if (!teacherDeptGroups[dept]) teacherDeptGroups[dept] = [];
                    teacherDeptGroups[dept].push(name);
                });
                Object.keys(teacherDeptGroups).forEach(dept => teacherDeptGroups[dept].sort((a, b) => a.localeCompare(b, 'th')));
                const sortedDeptNames = Object.keys(teacherDeptGroups).sort((a, b) => a.localeCompare(b, 'th'));
                if (!window.__teacherLogState) window.__teacherLogState = { mode: 'all', teacherFilter: null, search: '' };
                const tls = window.__teacherLogState;
                let events = attendanceData
                    .filter(a => trackedSubjectIds.has(a.subjectId))
                    .map(a => {
                        const sub = subjects.find(s => s.id === a.subjectId);
                        const teacherNames = sub ? [sub.teacher, sub.teacher2].filter(Boolean).join(' และ ') : '-';
                        return {
                            id: a.id,
                            subjectName: sub ? sub.name : '(ไม่พบวิชานี้แล้ว)',
                            roomId: sub ? sub.roomId : '',
                            teacherList: sub ? [sub.teacher, sub.teacher2].filter(Boolean) : [],
                            teacherNames: a.substituteTeacher ? `${teacherNames} <span class="text-amber-600">(สอนแทนโดย ${a.substituteTeacher}${subAssignLabel(a) ? ' · ' + subAssignLabel(a) : ''})</span>` : teacherNames,
                            date: a.date, period: a.period,
                            checkedAt: a.checkedAt || null,
                            createdAt: a.createdAt || null,
                            checkedBy: a.checkedBy || ''
                        };
                    })
                    .sort((x, y) => (y.checkedAt || y.date).localeCompare(x.checkedAt || x.date));

                if (tls.mode === 'teacher' && tls.teacherFilter) events = events.filter(ev => ev.teacherList.includes(tls.teacherFilter) || ev.teacherNames.includes(tls.teacherFilter));
                if (tls.search && tls.search.trim()) {
                    const q = tls.search.trim().toLowerCase();
                    events = events.filter(ev => ev.subjectName.toLowerCase().includes(q) || ev.teacherNames.toLowerCase().includes(q) || formatRoomName(ev.roomId).toLowerCase().includes(q));
                }

                let html = `<div class="flex flex-wrap items-center justify-between gap-2 mb-1"><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 flex items-center gap-2"><i class="fas fa-user-clock text-rose-500"></i> ติดตามครู</h3><button onclick="window.refreshTeacherLog()" class="bg-white border border-slate-200 hover:bg-slate-50 text-slate-600 px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-sync-alt${window.__teacherLogRefreshing ? ' fa-spin' : ''}"></i> รีเฟรช</button></div><p class="text-[10px] sm:text-xs text-slate-500 font-medium mb-4">รายการแจ้งเตือนว่าวิชาใด ของครูคนใด มีการเช็คชื่อไปแล้วเมื่อใด (เฉพาะภาคเรียน ${adminTerm()}/${adminYear()}) เรียงจากล่าสุดไปเก่าสุด</p>`;
                html += `<div class="flex flex-wrap items-center gap-2 mb-3"><span class="text-[10px] sm:text-xs font-bold text-slate-500">แสดง:</span><select onchange="if (this.value === '__all__') window.setTeacherLogMode('all', null); else window.setTeacherLogMode('teacher', this.value);" class="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[10px] sm:text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-400"><option value="__all__" ${tls.mode === 'all' ? 'selected' : ''}>ทั้งหมด</option>${sortedDeptNames.map(dept => `<optgroup label="${dept}">${teacherDeptGroups[dept].map(t => `<option value="${t}" ${tls.mode === 'teacher' && tls.teacherFilter === t ? 'selected' : ''}>${t}</option>`).join('')}</optgroup>`).join('')}</select></div>`;
                html += `<div class="relative mb-4"><i class="fas fa-search absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs"></i><input type="text" value="${(tls.search || '').replace(/"/g, '&quot;')}" oninput="window.setTeacherLogSearch(this.value)" placeholder="ค้นหาชื่อครู / ห้องเรียน / วิชาเรียน..." class="w-full bg-white border border-slate-200 rounded-lg pl-8 pr-3 py-2 text-xs sm:text-sm font-medium focus:ring-2 focus:ring-indigo-500 outline-none"></div>`;
                if (events.length === 0) {
                    html += `<div class="text-center text-slate-400 py-10 text-sm font-medium"><i class="fas fa-info-circle"></i> ยังไม่มีการเช็คชื่อในภาคเรียนนี้</div>`;
                } else {
                    html += `<div class="space-y-1.5 max-h-[32rem] overflow-y-auto">${events.map(ev => {
                        const firstCheckStr = ev.createdAt ? new Date(ev.createdAt).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : (ev.checkedAt ? new Date(ev.checkedAt).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '- (ไม่มีข้อมูลเวลา)');
                        const latestEditStr = ev.checkedAt ? new Date(ev.checkedAt).toLocaleString('th-TH', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '-';
                        // ถ้าเวลาสร้างครั้งแรก (createdAt) กับเวลาบันทึกล่าสุด (checkedAt) ต่างกัน แปลว่ามีการแก้ไขการเช็คชื่อภายหลัง (ไม่ว่าจะแก้กี่ครั้งก็ตาม เก็บแค่ครั้งแรกกับล่าสุด)
                        const wasEdited = ev.createdAt && ev.checkedAt && ev.createdAt !== ev.checkedAt;
                        const isExpanded = !!(window.__teacherLogExpanded && window.__teacherLogExpanded[ev.id]);
                        return `<div class="bg-white border border-slate-200 rounded-lg overflow-hidden">
                            <div class="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-[11px] sm:text-xs">
                                <div class="flex items-center gap-2 min-w-0">
                                    <i class="fas fa-check-circle text-emerald-500 shrink-0"></i>
                                    <span class="font-bold text-slate-800 truncate">${ev.subjectName}</span>
                                    <span class="text-slate-400">·</span>
                                    <span class="text-slate-600 truncate">${ev.teacherNames}</span>
                                    <span class="bg-emerald-100 text-emerald-700 border border-emerald-300 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 rounded shrink-0"><i class="fas fa-check"></i> เช็คครั้งแรก</span>
                                    ${wasEdited ? `<button onclick="window.toggleTeacherLogExpand('${ev.id}')" class="bg-amber-100 text-amber-700 border border-amber-300 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 rounded shrink-0 hover:bg-amber-200 transition-colors"><i class="fas fa-pen"></i> แก้ไขแล้ว <i class="fas fa-chevron-${isExpanded ? 'up' : 'down'} ml-0.5"></i></button>` : ''}
                                </div>
                                <div class="flex items-center gap-2 shrink-0 text-slate-500">
                                    <span>${formatRoomName(ev.roomId)}</span>
                                    <span class="font-bold text-slate-700"><i class="far fa-calendar-alt"></i> ${new Date(ev.date).toLocaleDateString('th-TH', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
                                    <span>คาบ ${periodLabel(ev.period)}</span>
                                    <span class="font-bold text-indigo-600"><i class="far fa-clock"></i> ${firstCheckStr}</span>
                                </div>
                            </div>
                            ${(wasEdited && isExpanded) ? `<div class="bg-amber-50 border-t border-amber-200 px-3 py-2 text-[10px] sm:text-xs flex flex-wrap items-center gap-2"><i class="fas fa-pen text-amber-500"></i><span class="font-bold text-amber-800">แก้ไขล่าสุด${ev.checkedBy ? ` โดย ${ev.checkedBy}` : ''}:</span><span class="font-bold text-indigo-600"><i class="far fa-clock"></i> ${latestEditStr}</span></div>` : ''}
                        </div>`;
                    }).join('')}</div>`;
                }
                content.innerHTML = html;
            }
            else if (currentAdminTab === 'data_status') {
                // ===== 2. สถานะการลงข้อมูลนักเรียนรายห้อง =====
                const roomList = getRoomList();
                const roomsWithNone = roomList.filter(r => getRoomStudents(r).length === 0);
                const TOTAL_WEEKLY_SLOTS = 45; // 5 วัน x 9 คาบ (0-8 ไม่รวมพักเที่ยง)
                const dsTerm = window.dataStatusTerm || adminTerm();
                const dsYear = window.dataStatusYear || adminYear();
                const roomScheduleFillPct = roomList.map(r => { const filled = new Set(); getRoomSubjects(r, dsTerm, dsYear).forEach(s => (s.schedules || []).forEach(sch => filled.add(sch.day + '-' + sch.period))); return Math.min(100, Math.round((filled.size / TOTAL_WEEKLY_SLOTS) * 100)); });
                const roomsFullSchedule = roomList.filter((r, i) => roomScheduleFillPct[i] >= 100);
                // ===== Progress Bar ภาพรวมความพร้อมของข้อมูล (อิงจาก 2 ปัจจัย: ลงรายชื่อนักเรียนครบทุกห้อง + ลงรายวิชาเต็มตารางทุกห้อง) =====
                const studentPct = roomList.length > 0 ? Math.round(((roomList.length - roomsWithNone.length) / roomList.length) * 100) : 0;
                // นับ % แบบเฉลี่ยความคืบหน้าของแต่ละห้อง (ไม่ใช่นับเฉพาะห้องที่ครบ 45 คาบเท่านั้น) ห้องที่ลงไปแล้วบางส่วนก็นับเป็นเปอร์เซ็นต์ย่อยได้
                const schedulePct = roomList.length > 0 ? Math.round(roomScheduleFillPct.reduce((a, b) => a + b, 0) / roomList.length) : 0;
                const roomsWithAdvisorStaff = roomList.filter(r => {
                    const advs = getRoomAdvisors(r, dsTerm, dsYear);
                    const hasAdv = Array.isArray(advs) && advs.some(a => a && String(a).trim());
                    const staff = getRoomStaff(r, dsTerm, dsYear);
                    const hasStaff = !!(staff && String(staff).trim());
                    return hasAdv && hasStaff;
                });
                const advisorPct = roomList.length > 0 ? Math.round((roomsWithAdvisorStaff.length / roomList.length) * 100) : 0;
                const overallPct = Math.round((studentPct + schedulePct + advisorPct) / 3);
                const overallBarColor = overallPct >= 100 ? 'bg-emerald-500' : (overallPct >= 60 ? 'bg-amber-500' : 'bg-rose-500');
                let html = `<div class="mb-6 bg-slate-50 p-4 sm:p-6 rounded-2xl border border-slate-100"><div class="flex justify-between items-end mb-2"><span class="font-extrabold text-slate-700 text-sm sm:text-base flex items-center gap-2"><i class="fas fa-tasks text-indigo-500"></i> ความพร้อมของข้อมูลโดยรวม <span class="text-[9px] sm:text-[10px] font-medium text-slate-400">(ภาคเรียน ${dsTerm}/${dsYear})</span></span><span class="text-lg sm:text-2xl font-black ${overallPct >= 100 ? 'text-emerald-500' : (overallPct >= 60 ? 'text-amber-500' : 'text-rose-500')}">${overallPct}%</span></div><div class="w-full h-3 sm:h-4 bg-slate-200 rounded-full overflow-hidden shadow-inner mb-3"><div class="${overallBarColor} h-full rounded-full transition-all duration-700 shadow-sm" style="width: ${overallPct}%"></div></div><div class="grid grid-cols-1 sm:grid-cols-3 gap-3"><div><div class="flex justify-between items-center mb-1"><span class="text-[10px] sm:text-xs font-bold text-slate-600"><i class="fas fa-users text-blue-400"></i> ลงรายชื่อนักเรียนครบทุกห้อง</span><span class="text-[10px] sm:text-xs font-black text-slate-500">${studentPct}%</span></div><div class="w-full h-2 bg-slate-200 rounded-full overflow-hidden"><div class="bg-blue-500 h-full rounded-full transition-all duration-700" style="width: ${studentPct}%"></div></div></div><div><div class="flex justify-between items-center mb-1"><span class="text-[10px] sm:text-xs font-bold text-slate-600"><i class="fas fa-calendar-check text-indigo-400"></i> ลงรายวิชาเต็มตารางทุกห้อง</span><span class="text-[10px] sm:text-xs font-black text-slate-500">${schedulePct}%</span></div><div class="w-full h-2 bg-slate-200 rounded-full overflow-hidden"><div class="bg-indigo-500 h-full rounded-full transition-all duration-700" style="width: ${schedulePct}%"></div></div></div><div><div class="flex justify-between items-center mb-1"><span class="text-[10px] sm:text-xs font-bold text-slate-600"><i class="fas fa-id-badge text-purple-400"></i> แต่งตั้งครูที่ปรึกษา+เจ้าหน้าที่ครบทุกห้อง</span><span class="text-[10px] sm:text-xs font-black text-slate-500">${advisorPct}%</span></div><div class="w-full h-2 bg-slate-200 rounded-full overflow-hidden"><div class="bg-purple-600 h-full rounded-full transition-all duration-700" style="width: ${advisorPct}%"></div></div></div></div></div><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-3 flex items-center gap-2"><i class="fas fa-clipboard-check text-indigo-500"></i> สถานะการลงข้อมูลนักเรียนรายห้อง</h3><div class="mb-3 flex flex-wrap items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl p-2.5"><label class="text-[10px] sm:text-xs font-bold text-slate-500 pl-1"><i class="fas fa-filter"></i> ดูสถานะตาราง/วิชาของ:</label><select onchange="window.setDataStatusYear(this.value)" class="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[10px] sm:text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-400">${sortedAcademicYears().map(y => `<option value="${y.year}" ${String(dsYear) === String(y.year) ? 'selected' : ''}>ปีการศึกษา ${y.year}${y.status === 'archived' ? ' (เก็บถาวรแล้ว)' : ''}</option>`).join('')}</select><select onchange="window.setDataStatusTerm(this.value)" class="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[10px] sm:text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-400">${Array.from({length: settings.termCount || 2}, (_, i) => i + 1).map(tn => `<option value="${tn}" ${String(dsTerm) === String(tn) ? 'selected' : ''}>ภาคเรียน ${tn}</option>`).join('')}</select><span class="text-[9px] sm:text-[10px] text-slate-400 font-medium">(ไม่กระทบภาคเรียนที่กำลังจัดการอยู่ด้านบนสุดของหน้า)</span></div><div class="mb-3 flex flex-wrap gap-2"><span class="bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] sm:text-xs font-bold px-2.5 py-1 rounded-full"><i class="fas fa-check-circle"></i> ลงข้อมูลแล้ว ${roomList.length - roomsWithNone.length} ห้อง</span><span class="bg-rose-50 border border-rose-200 text-rose-600 text-[10px] sm:text-xs font-bold px-2.5 py-1 rounded-full"><i class="fas fa-exclamation-circle"></i> ยังไม่ได้ลงข้อมูล ${roomsWithNone.length} ห้อง</span><span class="bg-indigo-50 border border-indigo-200 text-indigo-700 text-[10px] sm:text-xs font-bold px-2.5 py-1 rounded-full"><i class="fas fa-calendar-check"></i> ตารางเต็มแล้ว ${roomsFullSchedule.length} ห้อง</span></div><div class="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-2.5 mb-8">${roomList.map(r => { const cnt = getRoomStudents(r).length; const activeCnt = getRoomStudents(r).filter(s => s.status !== 'resigned').length; const done = cnt > 0;
                    const roomSubjects = getRoomSubjects(r, dsTerm, dsYear);
                    const filledSlots = new Set(); roomSubjects.forEach(s => (s.schedules || []).forEach(sch => filledSlots.add(sch.day + '-' + sch.period)));
                    const missingSlots = TOTAL_WEEKLY_SLOTS - filledSlots.size; const isFullSchedule = filledSlots.size >= TOTAL_WEEKLY_SLOTS;
                    return `<div class="rounded-xl border p-3 ${done ? 'bg-emerald-50 border-emerald-200' : 'bg-rose-50 border-rose-200'}"><div class="flex items-center justify-between mb-1"><span class="font-black text-slate-700 text-xs sm:text-sm">ห้อง ${formatRoomName(r)}</span><i class="fas ${done ? 'fa-check-circle text-emerald-500' : 'fa-times-circle text-rose-400'} text-sm"></i></div><div class="text-[10px] sm:text-xs font-bold ${done ? 'text-emerald-700' : 'text-rose-500'} mb-1.5">${done ? `${activeCnt} คน` : 'ยังไม่มีข้อมูล'}</div><div class="text-[9px] sm:text-[10px] font-bold ${isFullSchedule ? 'text-indigo-600' : 'text-amber-600'} border-t pt-1.5 ${done ? 'border-emerald-200' : 'border-rose-200'}">${isFullSchedule ? `<i class="fas fa-calendar-check"></i> ตารางเต็มแล้ว (${roomSubjects.length} วิชา)` : `<i class="fas fa-calendar-day"></i> ${roomSubjects.length} วิชา · ขาด ${missingSlots} คาบ`}</div></div>`; }).join('')}</div>`;

                // ===== 3. สถานะการลงข้อมูลรายวิชาของครู =====
                const tsTerm = window.teacherStatusTerm || adminTerm();
                const tsYear = window.teacherStatusYear || adminYear();
                html += `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-3 flex items-center gap-2"><i class="fas fa-chalkboard-teacher text-indigo-500"></i> สถานะการลงข้อมูลรายวิชาของครู</h3><div class="mb-3 flex flex-wrap items-center gap-2 bg-slate-50 border border-slate-200 rounded-xl p-2.5"><label class="text-[10px] sm:text-xs font-bold text-slate-500 pl-1"><i class="fas fa-filter"></i> ดูสถานะของ:</label><select onchange="window.setTeacherStatusYear(this.value)" class="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[10px] sm:text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-400">${sortedAcademicYears().map(y => `<option value="${y.year}" ${String(tsYear) === String(y.year) ? 'selected' : ''}>ปีการศึกษา ${y.year}${y.status === 'archived' ? ' (เก็บถาวรแล้ว)' : ''}</option>`).join('')}</select><select onchange="window.setTeacherStatusTerm(this.value)" class="bg-white border border-slate-200 rounded-lg px-2 py-1.5 text-[10px] sm:text-xs font-bold outline-none focus:ring-1 focus:ring-indigo-400">${Array.from({length: settings.termCount || 2}, (_, i) => i + 1).map(tn => `<option value="${tn}" ${String(tsTerm) === String(tn) ? 'selected' : ''}>ภาคเรียน ${tn}</option>`).join('')}</select><span class="text-[9px] sm:text-[10px] text-slate-400 font-medium">(แยกอิสระจากตัวกรองของส่วนห้องเรียนด้านบน)</span></div>`;
                const nonSystemDepts = departmentsList.filter(d => d !== 'ระบบ/อื่นๆ');
                const teacherDeptCounts = {};
                teachers.forEach(t => { const d = t.department || 'ระบบ/อื่นๆ'; teacherDeptCounts[d] = (teacherDeptCounts[d] || 0) + 1; });
                const nonSystemTeacherTotal = nonSystemDepts.reduce((sum, d) => sum + (teacherDeptCounts[d] || 0), 0);
                html += `<div class="mb-3 flex items-center gap-2"><span class="bg-indigo-50 border border-indigo-200 text-indigo-700 text-xs sm:text-sm font-black px-3 py-1.5 rounded-full flex items-center gap-1.5"><i class="fas fa-chalkboard-teacher"></i> เพิ่มครูแล้วทั้งหมด ${nonSystemTeacherTotal} คน</span><span class="text-[9px] sm:text-[10px] text-slate-400 font-medium">(ไม่รวมกลุ่ม "ระบบ/อื่นๆ")</span></div>`;
                html += `<div class="grid grid-cols-2 sm:grid-cols-4 gap-2.5 mb-6">${nonSystemDepts.map(d => { const cfg = deptConfig[d]; const cnt = teacherDeptCounts[d] || 0;
                    return `<div class="rounded-xl border ${cnt > 0 ? cfg.border : 'border-slate-200'} ${cnt > 0 ? cfg.bg : 'bg-slate-50'} p-3 sm:p-4 text-center"><div class="w-9 h-9 sm:w-11 sm:h-11 bg-white ${cnt > 0 ? cfg.text : 'text-slate-400'} rounded-full flex items-center justify-center mx-auto mb-2 text-sm sm:text-lg border ${cnt > 0 ? cfg.border : 'border-slate-200'} shadow-sm"><i class="fas ${cfg.icon}"></i></div><div class="font-bold text-slate-700 text-[10px] sm:text-xs mb-1 leading-tight min-h-[2em] sm:min-h-[1.5em] flex items-center justify-center">${d}</div><div class="text-xl sm:text-2xl font-black ${cnt > 0 ? cfg.text : 'text-slate-300'}">${cnt}</div><div class="text-[9px] sm:text-[10px] text-slate-400 font-medium">คน</div></div>`; }).join('')}</div>`;
                if (teachers.length === 0) {
                    html += `<div class="text-center text-slate-400 py-10 font-medium bg-slate-50 rounded-xl border border-slate-100">ยังไม่มีข้อมูลครูในระบบ</div>`;
                } else {
                    html += `<div class="overflow-x-auto rounded-xl border border-slate-200"><table class="w-full text-left text-xs sm:text-sm min-w-[500px]"><thead class="bg-slate-100"><tr><th class="p-2.5 font-extrabold">ชื่อครู</th><th class="p-2.5 font-extrabold text-center">จำนวนวิชา</th><th class="p-2.5 font-extrabold text-center">จำนวนชั้น</th><th class="p-2.5 font-extrabold text-center">จำนวนห้อง</th></tr></thead><tbody class="divide-y divide-slate-100">`;
                    teachers.slice().sort((a,b) => a.name.localeCompare(b.name)).forEach(t => {
                        const taught = activeSubjects(tsTerm, tsYear).filter(s => s.teacher === t.name || s.teacher2 === t.name);
                        const rooms = [...new Set(taught.map(s => s.roomId))];
                        const levels = [...new Set(rooms.map(r => r.split('_')[0]))];
                        html += `<tr class="hover:bg-slate-50 transition-colors"><td class="p-2.5 font-bold text-slate-700">${t.name}</td><td class="p-2.5 text-center font-black ${taught.length === 0 ? 'text-rose-400' : 'text-indigo-600'}">${taught.length}</td><td class="p-2.5 text-center font-black text-slate-600">${levels.length}</td><td class="p-2.5 text-center font-black text-slate-600">${rooms.length}</td></tr>`;
                    });
                    html += `</tbody></table></div>`;
                }
                content.innerHTML = html;
            }
            else if (currentAdminTab === 'teachers') {
                let deptOptions = departmentsList.map(d => `<option value="${d}">${d}</option>`).join('');
                let html = `<div class="flex flex-col sm:flex-row justify-between sm:items-center mb-3 gap-2"><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 flex items-center gap-2"><i class="fas fa-chalkboard-teacher text-indigo-500"></i> จัดการครูผู้สอน</h3><div class="flex flex-wrap gap-1.5"><button onclick="window.openTeacherModal()" class="flex-1 sm:flex-none bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors"><i class="fas fa-plus"></i> เพิ่มครูใหม่</button><button onclick="window.downloadTeacherTemplate()" class="flex-1 sm:flex-none bg-amber-500 hover:bg-amber-600 text-white px-3 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-file-download"></i> โหลดฟอร์มครู</button><label class="flex-1 sm:flex-none bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-lg font-bold text-xs sm:text-sm cursor-pointer text-center shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-file-import"></i> นำเข้ารายชื่อครู<input type="file" accept=".xlsx, .xls" class="hidden" onchange="window.handleImportTeachers(event)"></label><button onclick="window.openHubTeacherSync()" class="flex-1 sm:flex-none bg-violet-600 hover:bg-violet-700 text-white px-3 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-link"></i> ดึงรายชื่อจาก AcademicHub</button></div></div>${(() => { const n = teachers.filter(t => t.hubId).length; return n ? `<p class="text-[11px] sm:text-xs font-semibold text-violet-700 mb-3"><i class="fas fa-link"></i> เชื่อมกับ AcademicHub แล้ว ${n} จาก ${teachers.length} คน</p>` : ''; })()}`;
                html += `<div class="mb-4 bg-slate-50 p-2 rounded-xl border border-slate-200 shadow-sm"><div class="relative"><div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><i class="fas fa-search text-slate-400"></i></div><input type="text" id="searchTeacherInput" onkeyup="window.filterTeachers()" class="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-400 shadow-inner" placeholder="ค้นหาชื่อครู หรือกลุ่มสาระฯ..."></div></div>`;
                html += `<div id="teacherModal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] hidden flex items-center justify-center p-3 transition-opacity"><div class="bg-white rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-md max-h-[90vh] overflow-y-auto transform scale-95 opacity-0 transition-all duration-300" id="teacherModalBox"><div class="p-4 sm:p-6"><div class="flex justify-between items-center mb-3 border-b pb-2"><h4 class="font-extrabold text-lg" id="teacherModalTitle">เพิ่มครูใหม่</h4><button onclick="window.closeTeacherModal()" class="text-slate-400 text-xl hover:text-rose-500 transition-colors"><i class="fas fa-times"></i></button></div><div class="flex flex-col gap-3 mb-4"><div><label class="block text-[10px] sm:text-xs font-bold mb-1">ชื่อ-นามสกุล ครูผู้สอน</label><input type="text" id="newTcName" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-base sm:text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-400" placeholder="เช่น ครูสมใจ รักเรียน"></div><div><label class="block text-[10px] sm:text-xs font-bold mb-1">กลุ่มสาระการเรียนรู้</label><select id="newTcDept" class="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-base sm:text-sm font-bold outline-none focus:ring-2 focus:ring-indigo-400">${deptOptions}</select></div><div><label class="block text-[10px] sm:text-xs font-bold mb-1">ประเภทครู</label><div class="grid grid-cols-2 gap-2"><label class="flex items-center gap-2 border-2 border-slate-200 rounded-lg px-3 py-2 cursor-pointer has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50"><input type="radio" name="newTcType" value="th" class="accent-indigo-600"><span class="font-bold text-sm">ครูไทย</span></label><label class="flex items-center gap-2 border-2 border-slate-200 rounded-lg px-3 py-2 cursor-pointer has-[:checked]:border-sky-500 has-[:checked]:bg-sky-50"><input type="radio" name="newTcType" value="foreign" class="accent-sky-600"><span class="font-bold text-sm">ครูต่างชาติ</span></label></div><p class="text-[10px] sm:text-xs text-slate-500 mt-1">ครูต่างชาติ: วิชาที่เป็นครูผู้สอนหลัก (ไม่รวมสอนร่วม) มีป้าย "ครูต่างชาติ" ในรายงาน · ยังนับเป็นคาบที่ต้องเช็คตามปกติ</p></div></div><div class="flex justify-end gap-2"><button onclick="window.closeTeacherModal()" class="bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded font-bold text-sm transition-colors">ยกเลิก</button><button onclick="window.saveTeacherForm()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded font-bold text-sm shadow-sm transition-colors"><i class="fas fa-save"></i> บันทึก</button></div></div></div></div>`;
                html += `<div class="mb-4 flex items-center gap-1.5"><span class="text-[10px] sm:text-xs font-bold text-slate-500 mr-1">มุมมอง:</span><button onclick="window.setTeacherViewMode('grid')" class="${(window.__teacherViewMode||'grid') === 'grid' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'} px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs transition-colors"><i class="fas fa-th-large"></i> Grid</button><button onclick="window.setTeacherViewMode('list')" class="${window.__teacherViewMode === 'list' ? 'bg-indigo-600 text-white shadow-sm' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'} px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs transition-colors"><i class="fas fa-list"></i> List</button></div>`;
                const teacherDeptSections = {};
                teachers.forEach(t => { const dept = t.department || 'ระบบ/อื่นๆ'; if (!teacherDeptSections[dept]) teacherDeptSections[dept] = []; teacherDeptSections[dept].push(t); });
                const orderedDeptNames = departmentsList.filter(d => teacherDeptSections[d]).concat(Object.keys(teacherDeptSections).filter(d => !departmentsList.includes(d)));
                const isListView = window.__teacherViewMode === 'list';
                html += `<div id="adminTeacherGrid">`;
                orderedDeptNames.forEach(dept => {
                    const list = teacherDeptSections[dept].sort((a,b) => a.name.localeCompare(b.name));
                    html += `<div class="mb-4"><h4 class="text-[10px] sm:text-xs font-black text-indigo-600 uppercase tracking-wider mb-2 flex items-center gap-1.5"><i class="fas fa-layer-group"></i> ${dept} <span class="text-slate-400 font-medium normal-case">(${list.length} คน)</span></h4>`;
                    if (isListView) {
                        html += `<div class="border border-slate-200 rounded-xl overflow-hidden divide-y divide-slate-100">${list.map(t => { const count = activeSubjects(adminTerm(), adminYear()).filter(s => s.teacher === t.name || s.teacher2 === t.name).length; return `<div class="teacher-card flex items-center gap-3 bg-white hover:bg-slate-50 px-3 py-2 transition-colors" data-search="${t.name} ${dept}"><div class="w-8 h-8 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center text-sm shrink-0"><i class="fas fa-user-tie"></i></div><span class="flex-1 min-w-0 font-bold ${t.inactive ? 'text-slate-400' : 'text-slate-800'} text-xs sm:text-sm truncate">${t.name}${t.hubId ? HUB_LINK_BADGE : ''}${t.foreign ? FOREIGN_TAG : ''}${t.inactive ? '<span class="ml-1 text-[9px] sm:text-[10px] font-extrabold text-slate-500 bg-slate-200 px-1.5 py-0.5 rounded">ย้ายออก</span>' : ''}</span><span class="text-[9px] sm:text-[10px] font-bold text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded border border-slate-100 shrink-0">สอน ${count} วิชา</span><button onclick="window.toggleTeacherActive('${t.id}')" title="${t.inactive ? 'กลับมาใช้งาน' : 'ย้ายออก / ไม่ใช้งาน'}" aria-label="${t.inactive ? 'กลับมาใช้งาน' : 'ย้ายออก / ไม่ใช้งาน'}" class="w-7 h-7 ${t.inactive ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-600' : 'bg-slate-100 hover:bg-slate-200 text-slate-500'} rounded-full flex items-center justify-center shrink-0"><i class="fas ${t.inactive ? 'fa-user-check' : 'fa-user-slash'} text-[10px]"></i></button><button onclick="window.prepareEditTeacher('${t.id}')" class="w-7 h-7 bg-amber-50 hover:bg-amber-100 text-amber-600 rounded-full flex items-center justify-center shrink-0"><i class="fas fa-edit text-[10px]"></i></button><button onclick="window.deleteTeacher('${t.id}', ${count})" class="w-7 h-7 bg-rose-50 hover:bg-rose-100 text-rose-500 rounded-full flex items-center justify-center shrink-0"><i class="fas fa-trash text-[10px]"></i></button></div>`; }).join('')}</div>`;
                    } else {
                        html += `<div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-3">${list.map(t => { const count = activeSubjects(adminTerm(), adminYear()).filter(s => s.teacher === t.name || s.teacher2 === t.name).length; return `<div class="bg-white border border-slate-200 rounded-xl p-3 text-center relative group shadow-sm hover:shadow-md transition-shadow teacher-card" data-search="${t.name} ${dept}"><div class="absolute top-1.5 right-1.5 flex gap-1"><button onclick="window.toggleTeacherActive('${t.id}')" title="${t.inactive ? 'กลับมาใช้งาน' : 'ย้ายออก / ไม่ใช้งาน'}" aria-label="${t.inactive ? 'กลับมาใช้งาน' : 'ย้ายออก / ไม่ใช้งาน'}" class="w-6 h-6 ${t.inactive ? 'bg-emerald-50 hover:bg-emerald-100 text-emerald-600' : 'bg-slate-100 hover:bg-slate-200 text-slate-500'} rounded-full flex items-center justify-center opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity"><i class="fas ${t.inactive ? 'fa-user-check' : 'fa-user-slash'} text-[10px]"></i></button><button onclick="window.prepareEditTeacher('${t.id}')" class="w-6 h-6 bg-amber-50 hover:bg-amber-100 text-amber-600 rounded-full flex items-center justify-center opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity"><i class="fas fa-edit text-[10px]"></i></button><button onclick="window.deleteTeacher('${t.id}', ${count})" class="w-6 h-6 bg-rose-50 hover:bg-rose-100 text-rose-500 rounded-full flex items-center justify-center opacity-100 sm:opacity-0 group-hover:opacity-100 transition-opacity"><i class="fas fa-trash text-[10px]"></i></button></div><div class="w-10 h-10 bg-indigo-100 text-indigo-600 rounded-full flex items-center justify-center mx-auto text-lg mb-2"><i class="fas fa-user-tie"></i></div><h4 class="font-bold ${t.inactive ? 'text-slate-400' : 'text-slate-800'} text-[11px] sm:text-sm line-clamp-2" title="${t.name}">${t.name}${t.hubId ? HUB_LINK_BADGE : ''}${t.foreign ? FOREIGN_TAG : ''}</h4>${t.inactive ? '<span class="ml-1 text-[9px] sm:text-[10px] font-extrabold text-slate-500 bg-slate-200 px-1.5 py-0.5 rounded">ย้ายออก</span>' : ''}<span class="text-[9px] sm:text-[10px] font-bold text-slate-500 bg-slate-50 px-1.5 py-0.5 rounded mt-1 inline-block border border-slate-100">สอน ${count} วิชา</span></div>`; }).join('')}</div>`;
                    }
                    html += `</div>`;
                });
                html += `</div>`;
                content.innerHTML = html;
            }
            else if (currentAdminTab === 'subjects') {
                let tcOptions = '';
                if (teachers.length > 0) {
                    const deptGroups = {};
                    teachers.filter(t => !t.inactive).forEach(t => { const dept = t.department || 'ไม่ระบุกลุ่มสาระ'; if (!deptGroups[dept]) deptGroups[dept] = []; deptGroups[dept].push(t); });
                    Object.keys(deptGroups).sort((a, b) => a.localeCompare(b)).forEach(dept => {
                        tcOptions += `<optgroup label="${dept}">`;
                        deptGroups[dept].sort((a, b) => a.name.localeCompare(b.name)).forEach(t => { tcOptions += `<option value="${t.name}">${t.name}</option>`; });
                        tcOptions += `</optgroup>`;
                    });
                } else { tcOptions = `<option value="" disabled selected>-- ไม่มีข้อมูล --</option>`; }
                const subjRoomList = getRoomList();
                let __sysSubjectsChanged = false;
                const __sysBefore = new Map(subjects.filter(s => s.systemType).map(s => [s.id, JSON.stringify(s)]));
                subjRoomList.forEach(r => { if (ensureSystemSubjectsForRoom(r, adminTerm(), adminYear())) __sysSubjectsChanged = true; });
                if (__sysSubjectsChanged) { // [v1.74.5] ส่งเฉพาะคาบระบบที่สร้าง/ปรับ ไม่ส่งข้อมูลทั้งชุด
                    const __sysUp = subjects.filter(s => s.systemType && __sysBefore.get(s.id) !== JSON.stringify(s));
                    logAction('สร้าง/ปรับคาบระบบอัตโนมัติ', 'เขตพื้นที่รับผิดชอบ / เข้าแถวเช้า (คาบ 0) / โฮมรูม (คาบ 8)');
                    if (__sysUp.length) saveSubjectsDelta(__sysUp, [], { applyLocal: () => { const ids = new Set(__sysUp.map(x => x.id)); subjects = subjects.filter(s => !ids.has(s.id)).concat(__sysUp); } });
                }
                if (!window.adminSelectedSubjectRoom) window.adminSelectedSubjectRoom = 'all';
                if (window.adminSelectedSubjectRoom !== 'all' && !subjRoomList.includes(window.adminSelectedSubjectRoom)) window.adminSelectedSubjectRoom = 'all';
                const isAllRooms = window.adminSelectedSubjectRoom === 'all';
                let html = `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-3 flex items-center gap-2"><i class="fas fa-book-open text-indigo-500"></i> จัดการวิชา <span class="text-[10px] sm:text-xs font-bold text-slate-400">(ภาคเรียน ${adminTerm()}/${adminYear()})</span></h3>`;
                if (adminTermStatus() === 'locked') { html += `<div class="mb-3 bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-3 py-2 text-[10px] sm:text-sm font-bold flex items-center gap-2"><i class="fas fa-lock"></i> ภาคเรียนนี้ถูกล็อคข้อมูลไว้ (เก็บถาวร) ไม่สามารถเพิ่ม/แก้ไข/ลบวิชาได้ (ไปเปลี่ยนสถานะที่แท็บ "ตั้งค่า")</div>`; }
                else if (adminTermStatus() === 'not_opened') { html += `<div class="mb-3 bg-slate-100 border border-slate-200 text-slate-600 rounded-xl px-3 py-2 text-[10px] sm:text-sm font-bold flex items-center gap-2"><i class="fas fa-power-off"></i> ภาคเรียนนี้ยังไม่เปิดใช้งาน ครูยังเช็คชื่อไม่ได้ แต่แอดมินยังจัดเตรียมรายวิชาล่วงหน้าได้ตามปกติ</div>`; }
                html += `<div class="flex flex-col lg:flex-row justify-between lg:items-center mb-3 gap-2"><div class="flex items-center gap-1 w-full lg:w-auto"><div class="flex flex-col shrink-0"><button onclick="window.stepAdminSubjectRoom(-1)" title="ห้องก่อนหน้า" class="bg-white border-2 border-slate-200 hover:bg-slate-50 text-slate-500 rounded-t-lg px-2 py-1 text-xs leading-none"><i class="fas fa-chevron-up"></i></button><button onclick="window.stepAdminSubjectRoom(1)" title="ห้องถัดไป" class="bg-white border-2 border-t-0 border-slate-200 hover:bg-slate-50 text-slate-500 rounded-b-lg px-2 py-1 text-xs leading-none"><i class="fas fa-chevron-down"></i></button></div><select id="adminSubjectRoomSelect" onchange="window.adminSelectedSubjectRoom = this.value; window.renderAdminTab();" class="bg-white border-2 border-slate-200 rounded-lg px-3 py-1.5 font-bold text-sm w-full lg:w-auto outline-none focus:border-indigo-400 shadow-sm"><option value="all" ${isAllRooms ? 'selected' : ''}>รวมทุกห้อง (ทั้งหมด)</option>${subjRoomList.map(r => `<option value="${r}" ${window.adminSelectedSubjectRoom === r ? 'selected' : ''}>ห้อง ${formatRoomName(r)}</option>`).join('')}</select></div><div class="flex flex-wrap gap-1.5"><button onclick="window.openSubjectModal()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-2 rounded-lg font-bold text-[10px] sm:text-sm shadow-sm transition-colors flex items-center justify-center gap-1.5 flex-1 sm:flex-none"><i class="fas fa-plus"></i> เพิ่มวิชาใหม่${!isAllRooms ? ` (ห้อง ${formatRoomName(window.adminSelectedSubjectRoom)})` : ''}</button>${!isAllRooms ? `<button onclick="window.downloadSubjectTemplate()" class="bg-amber-500 hover:bg-amber-600 text-white px-3 py-2 rounded-lg font-bold text-[10px] sm:text-sm flex-1 sm:flex-none shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-file-download"></i> โหลดฟอร์มวิชา</button><label class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-2 rounded-lg font-bold text-[10px] sm:text-sm cursor-pointer flex-1 sm:flex-none text-center shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-file-import"></i> นำเข้ารายวิชา Excel<input type="file" accept=".xlsx, .xls" class="hidden" onchange="window.handleImportSubjects(event)"></label><button onclick="window.openExportSubjectsModal()" class="bg-teal-600 hover:bg-teal-700 text-white px-3 py-2 rounded-lg font-bold text-[10px] sm:text-sm flex-1 sm:flex-none shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-file-export"></i> ส่งออกรายวิชา</button><button onclick="window.clearRoomSubjects('${window.adminSelectedSubjectRoom}')" class="bg-rose-600 hover:bg-rose-700 text-white px-3 py-2 rounded-lg font-bold text-[10px] sm:text-sm flex-1 sm:flex-none shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-broom"></i> ลบวิชาทั้งหมดในห้อง</button>` : `<span class="text-[10px] sm:text-xs text-slate-400 font-bold flex items-center px-2">เลือกห้องที่ต้องการเพื่อนำเข้า/โหลดฟอร์ม/ลบวิชา</span>`}</div></div>`;
                if (!isAllRooms) {
                    const rst = computeRoomScheduleStatus(window.adminSelectedSubjectRoom, adminTerm(), adminYear());
                    const dupes = findDuplicateSubjectsInRoom(window.adminSelectedSubjectRoom, adminTerm(), adminYear());
                    html += `<div class="mb-3 flex flex-wrap gap-2">`;
                    html += rst.done ? `<span class="bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] sm:text-xs font-bold px-2.5 py-1 rounded-full"><i class="fas fa-calendar-check"></i> ตารางเรียนครบแล้ว (${rst.filled}/${rst.total} คาบ)</span>` : `<span class="bg-amber-50 border border-amber-200 text-amber-700 text-[10px] sm:text-xs font-bold px-2.5 py-1 rounded-full"><i class="fas fa-calendar-day"></i> ยังลงตารางไม่ครบ (${rst.filled}/${rst.total} คาบ)</span>`;
                    if (dupes.size > 0) html += `<span class="bg-rose-50 border border-rose-200 text-rose-600 text-[10px] sm:text-xs font-bold px-2.5 py-1 rounded-full"><i class="fas fa-clone"></i> พบวิชาซ้ำ ${dupes.size} รายการ (ชื่อ/รหัสวิชาซ้ำกัน)</span>`;
                    html += `</div>`;
                    // ===== ตารางเรียนรายสัปดาห์ของห้องนี้ (แถว = วันจันทร์-ศุกร์, คอลัมน์ = คาบ 0-8) เพื่อให้ดูง่ายว่าคาบไหนยังขาดวิชา คลิกช่องว่างเพื่อเพิ่มวิชาในคาบนั้นได้ทันที =====
                    const gridPeriods = timeSlots.filter(t => t.period >= 0 || t.period === -2);
                    const gridMatrix = {};
                    getRoomSubjects(window.adminSelectedSubjectRoom, adminTerm(), adminYear()).sort((a, b) => (a.systemType ? -1 : 0) - (b.systemType ? -1 : 0)).forEach(s => (s.schedules || []).forEach(sch => { gridMatrix[sch.day + '-' + sch.period] = s; }));
                    const gridDayColors = { 1: { bg: 'bg-yellow-50', text: 'text-yellow-800' }, 2: { bg: 'bg-pink-50', text: 'text-pink-800' }, 3: { bg: 'bg-green-50', text: 'text-green-800' }, 4: { bg: 'bg-orange-50', text: 'text-orange-800' }, 5: { bg: 'bg-sky-50', text: 'text-sky-800' } };
                    html += `<div class="mb-4"><h4 class="text-xs sm:text-sm font-extrabold text-slate-600 mb-2 flex items-center gap-1.5"><i class="fas fa-table text-indigo-400"></i> ตารางเรียนห้อง ${formatRoomName(window.adminSelectedSubjectRoom)} <span class="text-[9px] sm:text-[10px] font-medium text-slate-400">(คลิกช่องว่างเพื่อเพิ่มวิชาในคาบนั้น)</span></h4><div class="overflow-x-auto rounded-xl border border-slate-200"><table class="w-full text-center text-[9px] sm:text-[11px] border-collapse min-w-[720px]"><thead><tr class="bg-slate-100"><th class="p-1.5 sm:p-2 border border-slate-200 sticky left-0 bg-slate-100 z-10">วัน \\ คาบ</th>${gridPeriods.map(p => `<th class="p-1.5 sm:p-2 border border-slate-200 font-bold">${periodLabel(p.period)}${p.period === -2 ? '<div class="font-normal text-slate-400 text-[8px]">(เขตฯ)</div>' : ''}${p.period === 0 ? '<div class="font-normal text-slate-400 text-[8px] sm:text-[9px]">(แถว)</div>' : ''}</th>${p.period === 4 ? `<th class="p-1 border border-amber-200 font-bold bg-amber-50 text-amber-600 w-6 sm:w-8" title="พักกลางวัน"><i class="fas fa-utensils"></i></th>` : ''}`).join('')}</tr></thead><tbody>`;
                    for (let d = 1; d <= 5; d++) {
                        const dc = gridDayColors[d];
                        html += `<tr><td class="p-1.5 sm:p-2 border border-slate-200 font-bold ${dc.bg} ${dc.text} sticky left-0 z-10 whitespace-nowrap">${daysLabel[d-1].replace('วัน','')}</td>`;
                        gridPeriods.forEach(p => {
                            const sub = gridMatrix[d + '-' + p.period];
                            if (sub) {
                                html += `<td class="p-1 border border-slate-200 bg-emerald-50/70 align-top" title="${sub.name}${sub.teacher ? ' - ครู' + sub.teacher : ''}"><div class="font-bold text-emerald-700 line-clamp-2 leading-tight">${sub.name}</div>${sub.teacher ? `<div class="text-slate-400 text-[8px] sm:text-[9px] line-clamp-1">${sub.teacher}</div>` : ''}</td>`;
                            } else {
                                html += `<td class="p-1 border border-slate-200 bg-rose-50/50 hover:bg-rose-100 cursor-pointer transition-colors" title="คลิกเพื่อเพิ่มวิชาคาบนี้" onclick="window.openSubjectModal(${d}, ${p.period})"><i class="fas fa-plus text-rose-300 text-[9px] sm:text-[10px]"></i></td>`;
                            }
                            if (p.period === 4) html += `<td class="p-1 border border-amber-100 bg-amber-50/50 text-amber-400 text-center"><i class="fas fa-utensils text-[8px] sm:text-[9px]"></i></td>`;
                        });
                        html += `</tr>`;
                    }
                    html += `</tbody></table></div></div>`;
                }

                html += `<div class="mb-4 bg-slate-50 p-2 rounded-xl border border-slate-200 shadow-sm"><div class="relative"><div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><i class="fas fa-search text-slate-400"></i></div><input type="text" id="searchSubjectInput" onkeyup="window.filterSubjects()" class="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-400 shadow-inner" placeholder="ค้นหา รหัสวิชา, ชื่อวิชา, ครูผู้สอน..."></div></div>`;
                html += `<div id="subjectModal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] hidden flex items-center justify-center p-3 transition-opacity"><div class="bg-white rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-4xl max-h-[90vh] overflow-y-auto transform scale-95 opacity-0 transition-all duration-300" id="subjectModalBox"><div class="p-4 sm:p-6"><div class="flex justify-between items-center mb-3 border-b pb-2"><h4 class="font-extrabold text-lg" id="subjectModalTitle">เพิ่ม</h4><button onclick="window.closeSubjectModal()" class="text-slate-400 text-xl hover:text-rose-500 transition-colors"><i class="fas fa-times"></i></button></div><div id="subjectTemplatePickerWrap" class="mb-4 bg-indigo-50 border border-indigo-200 rounded-xl p-3"><label class="block text-[10px] sm:text-xs font-bold text-indigo-700 mb-1"><i class="fas fa-copy"></i> คัดลอกข้อมูลจากวิชาที่มีอยู่แล้วในระดับชั้นเดียวกัน (ไม่บังคับ)</label><select id="subjectTemplatePicker" onchange="window.applySubjectTemplate(this.value)" class="w-full bg-white border border-indigo-200 rounded px-2 py-2 text-base sm:text-sm outline-none focus:ring-1 focus:ring-indigo-400"><option value="">-- พิมพ์ข้อมูลใหม่เอง --</option></select></div><div id="subjectSystemNote" class="hidden bg-slate-100 border border-slate-200 text-slate-500 text-[10px] sm:text-xs font-bold rounded-lg px-3 py-2 mb-3"><i class="fas fa-shield-alt"></i> คาบระบบ (เข้าแถวเช้า/โฮมรูม) แก้ไขได้เฉพาะ "หน่วยกิต" และ "ตารางคาบสอน" เท่านั้น ช่องอื่นถูกล็อคไว้</div><div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2.5 mb-4"><div><label class="block text-[10px] sm:text-xs font-bold mb-1">ห้อง</label><select id="newSubRoom" onchange="window.populateSubjectTemplateOptions(); window.renderScheduleInputs();" class="w-full bg-slate-50 border border-slate-200 rounded px-2 py-2 text-base sm:text-sm disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed">${subjRoomList.map(r => `<option value="${r}">${formatRoomName(r)}</option>`).join('')}</select></div><div><label class="block text-[10px] sm:text-xs font-bold mb-1">รหัสวิชา</label><input type="text" id="newSubCode" class="w-full bg-slate-50 border border-slate-200 rounded px-2 py-2 text-base sm:text-sm outline-none focus:ring-1 focus:ring-indigo-400 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed" placeholder="เช่น ว31101"></div><div><label class="block text-[10px] sm:text-xs font-bold mb-1">ชื่อวิชา</label><input type="text" id="newSubName" class="w-full bg-slate-50 border border-slate-200 rounded px-2 py-2 text-base sm:text-sm outline-none focus:ring-1 focus:ring-indigo-400 disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"></div><div><label class="block text-[10px] sm:text-xs font-bold mb-1">ครู (หลัก)</label><input type="text" list="subjectTeacherDatalist" id="newSubTeacher" placeholder="พิมพ์ชื่อครู..." class="w-full bg-slate-50 border border-slate-200 rounded px-2 py-2 text-base sm:text-sm disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"></div><div><label class="block text-[10px] sm:text-xs font-bold mb-1">ครู (ร่วมสอน)</label><input type="text" list="subjectTeacherDatalist" id="newSubTeacher2" placeholder="พิมพ์ชื่อครู (ไม่บังคับ)..." class="w-full bg-slate-50 border border-slate-200 rounded px-2 py-2 text-base sm:text-sm disabled:bg-slate-200 disabled:text-slate-400 disabled:cursor-not-allowed"></div><datalist id="subjectTeacherDatalist">${teachers.filter(t => !t.inactive).sort((a,b) => a.name.localeCompare(b.name)).map(t => `<option value="${t.name}">`).join('')}</datalist><div><label class="block text-[10px] sm:text-xs font-bold mb-1">หน่วยกิต (คาบ)</label><select id="newSubCredit" onchange="window.renderScheduleInputs()" class="w-full bg-slate-50 border border-slate-200 rounded px-2 py-2 text-base sm:text-sm"><option value="0.5">0.5 (1 คาบ)</option><option value="1.0">1.0 (2 คาบ)</option><option value="1.5">1.5 (3 คาบ)</option><option value="2.0">2.0 (4 คาบ)</option><option value="2.5">2.5 (5 คาบ)</option><option value="3.0">3.0 (6 คาบ)</option></select></div></div><div id="scheduleContainer" class="grid grid-cols-1 sm:grid-cols-3 gap-2 border-t pt-3 mb-4"></div><div class="flex justify-end gap-2"><button onclick="window.closeSubjectModal()" class="bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded font-bold text-sm transition-colors">ยกเลิก</button><button onclick="window.saveSubjectForm()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded font-bold text-sm shadow-sm transition-colors"><i class="fas fa-save"></i> บันทึก</button></div></div></div></div>`;
                html += `<div id="exportSubjectsModal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] hidden flex items-center justify-center p-3 transition-opacity"><div class="bg-white rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-md transform scale-95 opacity-0 transition-all duration-300" id="exportSubjectsModalBox"><div class="p-4 sm:p-6"><div class="flex justify-between items-center mb-3 border-b pb-2"><h4 class="font-extrabold text-lg"><i class="fas fa-file-export text-teal-500"></i> ส่งออกรายวิชาเป็น Excel</h4><button onclick="window.closeExportSubjectsModal()" class="text-slate-400 text-xl hover:text-rose-500 transition-colors"><i class="fas fa-times"></i></button></div><p class="text-[10px] sm:text-xs text-slate-500 font-medium mb-4">เลือกรูปแบบคอลัมน์ที่ต้องการส่งออก สำหรับห้อง <span class="font-bold text-slate-700">${formatRoomName(window.adminSelectedSubjectRoom)}</span></p><div class="space-y-2.5"><button onclick="window.doExportSubjects('basic')" class="w-full text-left bg-slate-50 hover:bg-teal-50 border-2 border-slate-200 hover:border-teal-300 rounded-xl p-3 transition-colors"><div class="font-bold text-sm text-slate-800"><i class="fas fa-list-ol text-teal-500"></i> แบบพื้นฐาน</div><div class="text-[10px] sm:text-xs text-slate-500 mt-0.5">รหัสวิชา, ชื่อวิชา, หน่วยกิต</div></button><button onclick="window.doExportSubjects('full')" class="w-full text-left bg-slate-50 hover:bg-teal-50 border-2 border-slate-200 hover:border-teal-300 rounded-xl p-3 transition-colors"><div class="font-bold text-sm text-slate-800"><i class="fas fa-table text-teal-500"></i> แบบละเอียด</div><div class="text-[10px] sm:text-xs text-slate-500 mt-0.5">รหัสวิชา, ชื่อวิชา, หน่วยกิต, ชื่อครู, คาบสอน</div></button></div></div></div></div>`;
                html += `<div class="overflow-x-auto rounded-xl border border-slate-200 max-h-[500px] w-full"><table class="w-full text-left text-[10px] sm:text-sm min-w-[500px]"><thead class="bg-slate-100 sticky top-0 z-10 border-b"><tr>${isAllRooms ? '<th class="p-2 w-16 text-center">ห้อง</th>' : ''}<th class="p-2">วิชา</th><th class="p-2">ครู</th><th class="p-2 min-w-[120px]">ตาราง</th><th class="p-2 text-center w-16">จัดการ</th></tr></thead><tbody class="divide-y divide-slate-100" id="adminSubjectTableBody">`;
                const filteredSubjects = isAllRooms ? activeSubjects(adminTerm(), adminYear()).slice() : getRoomSubjects(window.adminSelectedSubjectRoom, adminTerm(), adminYear());
                if (filteredSubjects.length === 0) {
                    html += `<tr><td colspan="${isAllRooms ? 5 : 4}" class="p-8 text-center text-slate-400 font-medium">ยังไม่มีข้อมูลวิชาในห้องนี้</td></tr>`;
                } else {
                    const dupSet = isAllRooms ? new Set() : findDuplicateSubjectsInRoom(window.adminSelectedSubjectRoom, adminTerm(), adminYear());
                    const conflicts = findTeacherConflicts(adminTerm(), adminYear());
                    filteredSubjects.sort((a,b) => a.roomId.localeCompare(b.roomId) || (!!b.systemType - !!a.systemType) || a.name.localeCompare(b.name)).forEach(sub => { let schedText = (sub.schedules||[]).map(sch => `<span class="bg-slate-100 px-1 py-0.5 rounded text-[8px] sm:text-[10px] border border-slate-200 mr-1 mb-1 inline-block whitespace-nowrap">${daysLabel[sch.day-1].replace('วัน','')} ค.${sch.period}</span>`).join('');
                        const isDup = dupSet.has(sub.id); const conflictGroup = conflicts.find(g => g.some(x => x.subjectId === sub.id));
                        const rowClass = conflictGroup ? 'bg-rose-50 hover:bg-rose-100' : (isDup ? 'bg-amber-50 hover:bg-amber-100' : 'hover:bg-slate-50');
                        const warnBadges = `${isDup ? '<span class="inline-block bg-amber-100 text-amber-700 border border-amber-300 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded mr-1 mb-1"><i class="fas fa-clone"></i> ซ้ำ</span>' : ''}${conflictGroup ? '<span class="inline-block bg-rose-100 text-rose-700 border border-rose-300 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded mr-1 mb-1" title="ครูมีคาบสอนชนกัน"><i class="fas fa-exclamation-triangle"></i> คาบชน</span>' : ''}${sub.locked ? '<span class="inline-block bg-slate-200 text-slate-600 border border-slate-300 text-[8px] sm:text-[9px] font-black px-1.5 py-0.5 rounded mr-1 mb-1"><i class="fas fa-lock"></i> ล็อค</span>' : ''}`;
                        html += `<tr class="${rowClass} transition-colors" data-room="${sub.roomId}" data-search="${sub.code || ''} ${sub.name} ${sub.teacher} ${sub.teacher2 || ''}">${isAllRooms ? `<td class="p-2 font-bold text-center">${formatRoomName(sub.roomId).replace('ม.','')}</td>` : ''}<td class="p-2">${warnBadges ? `<div class="mb-1">${warnBadges}</div>` : ''}<div class="font-bold text-indigo-700 line-clamp-2">${sub.name}</div>${sub.code ? `<div class="text-[9px] text-slate-500 font-mono mt-0.5">${sub.code}</div>` : ''}</td><td class="p-2 text-[9px] sm:text-sm">${sub.teacher}${sub.teacher2 ? '<br><span class="text-slate-400">' + sub.teacher2 + '</span>' : ''}${internNamesOf(sub.id).length ? '<br>' + internChipHtml(sub.id) : ''}</td><td class="p-2 whitespace-normal">${schedText}</td><td class="p-2 text-center flex justify-center gap-1">${sub.systemType ? `<span class="bg-slate-100 text-slate-500 border border-slate-200 text-[9px] px-2 py-1 rounded-full font-bold whitespace-nowrap" title="คาบระบบ สร้างอัตโนมัติจากครูที่ปรึกษา ลบไม่ได้"><i class="fas fa-shield-alt"></i> คาบระบบ</span><button onclick="window.prepareEditSubject('${sub.id}')" class="text-amber-500 bg-amber-50 hover:bg-amber-100 p-1.5 rounded transition-colors"><i class="fas fa-edit"></i></button>` : `<button onclick="window.toggleSubjectLock('${sub.id}')" title="${sub.locked ? 'ปลดล็อควิชา' : 'ล็อควิชา'}" class="${sub.locked ? 'text-slate-600 bg-slate-200 hover:bg-slate-300' : 'text-slate-400 bg-slate-50 hover:bg-slate-100'} p-1.5 rounded transition-colors"><i class="fas ${sub.locked ? 'fa-lock' : 'fa-lock-open'}"></i></button><button onclick="window.prepareEditSubject('${sub.id}')" class="text-amber-500 bg-amber-50 hover:bg-amber-100 p-1.5 rounded transition-colors"><i class="fas fa-edit"></i></button><button onclick="window.deleteSubject('${sub.id}')" class="text-rose-500 bg-rose-50 hover:bg-rose-100 p-1.5 rounded transition-colors"><i class="fas fa-trash"></i></button>`}</td></tr>`; });
                }
                html += `</tbody></table></div>`;
                content.innerHTML = html;
            }
            else if (currentAdminTab === 'students') {
                const roomList = getRoomList();
                if(!window.adminSelectedRoom && roomList.length > 0) window.adminSelectedRoom = roomList[0];
                let html = `<div class="mb-4 bg-purple-50/60 p-3 sm:p-4 rounded-xl border border-purple-200"><h4 class="font-extrabold text-purple-800 text-sm sm:text-base mb-1.5 flex items-center gap-2"><i class="fas fa-graduation-cap"></i> เลื่อนชั้นนักเรียนไปปีการศึกษาใหม่</h4><p class="text-[9px] sm:text-[11px] text-purple-600 font-medium mb-3">คัดลอกรายชื่อนักเรียนที่ยังเรียนอยู่จากปีการศึกษาต้นทาง ไปเป็นรายชื่อของชั้นถัดไปในปีการศึกษาปลายทางให้อัตโนมัติ (ม.3 และ ม.6 ถือว่าจบการศึกษาแล้ว จะไม่ถูกเลื่อนชั้นต่อ / นักเรียนที่ออก-ย้ายแล้วจะไม่ถูกเลื่อนชั้นไปด้วย) หลังเลื่อนชั้นแล้ว ต้องเพิ่มรายชื่อนักเรียน ม.1 และ ม.4 ใหม่เองด้วย เนื่องจากเป็นชั้นรับเข้าใหม่ ไม่มีรุ่นพี่เลื่อนชั้นขึ้นมา ไม่กระทบรายชื่อเดิมของปีต้นทาง สามารถแก้ไขรายชื่อในปีปลายทางเพิ่มเติมได้ตามปกติหลังเลื่อนชั้นแล้ว</p><div class="flex flex-wrap items-end gap-2"><div class="min-w-[150px]"><label class="block text-[10px] sm:text-xs font-bold text-purple-700 mb-1">จากปีการศึกษา</label><select id="promoteFromYear" class="w-full bg-white border border-purple-200 rounded-lg px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-purple-400 outline-none">${sortedAcademicYears().map(y => `<option value="${y.year}" ${String(y.year) === String(settings.year) ? 'selected' : ''}>ปีการศึกษา ${y.year}</option>`).join('')}</select></div><div class="min-w-[150px]"><label class="block text-[10px] sm:text-xs font-bold text-purple-700 mb-1">ไปยังปีการศึกษา</label><select id="promoteToYear" class="w-full bg-white border border-purple-200 rounded-lg px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-purple-400 outline-none">${sortedAcademicYears().map(y => `<option value="${y.year}" ${String(y.year) !== String(settings.year) ? 'selected' : ''} ${y.status === 'archived' ? 'disabled' : ''}>ปีการศึกษา ${y.year}${y.status === 'archived' ? ' (ถูกจัดเก็บแล้ว)' : ''}</option>`).join('')}</select></div><button onclick="window.promoteStudents()" class="bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-arrow-up"></i> เลื่อนชั้น</button></div>${settings.academicYears && settings.academicYears.length < 2 ? `<p class="text-[9px] sm:text-[11px] text-purple-500 font-bold mt-2"><i class="fas fa-info-circle"></i> ต้องมีปีการศึกษาอย่างน้อย 2 ปีในระบบก่อนจึงจะเลื่อนชั้นได้ (ไปเพิ่มปีที่แท็บ "ตั้งค่าภาคเรียน")</p>` : ''}</div>`;
                html += `<div class="flex flex-col lg:flex-row justify-between lg:items-center mb-3 gap-2"><div class="flex items-center gap-1 w-full lg:w-auto"><div class="flex flex-col shrink-0"><button onclick="window.stepAdminRoom(-1)" title="ห้องก่อนหน้า" class="bg-white border-2 border-slate-200 hover:bg-slate-50 text-slate-500 rounded-t-lg px-2 py-1 text-xs leading-none"><i class="fas fa-chevron-up"></i></button><button onclick="window.stepAdminRoom(1)" title="ห้องถัดไป" class="bg-white border-2 border-t-0 border-slate-200 hover:bg-slate-50 text-slate-500 rounded-b-lg px-2 py-1 text-xs leading-none"><i class="fas fa-chevron-down"></i></button></div><select id="adminRoomSelect" onchange="window.adminSelectedRoom = this.value; window.renderAdminTab();" class="bg-white border-2 border-slate-200 rounded-lg px-3 py-1.5 font-bold text-sm w-full lg:w-auto outline-none focus:border-indigo-400 shadow-sm">${roomList.map(r => `<option value="${r}" ${window.adminSelectedRoom === r ? 'selected' : ''}>ห้อง ${formatRoomName(r)}</option>`).join('')}</select></div><div class="flex flex-wrap gap-1.5"><button onclick="window.openRenumber(window.adminSelectedRoom)" class="bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 text-indigo-700 px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm flex-1 sm:flex-none shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-sort-numeric-down"></i> จัดเลขที่</button><button onclick="window.openStudentModal()" class="bg-blue-600 hover:bg-blue-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm flex-1 sm:flex-none shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-plus"></i> เพิ่ม 1 คน</button><button onclick="window.downloadStudentTemplate()" class="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm flex-1 sm:flex-none shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-file-download"></i> โหลดฟอร์ม</button><label class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm cursor-pointer flex-1 sm:flex-none text-center shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-file-import"></i> นำเข้า Excel<input type="file" accept=".xlsx, .xls" class="hidden" onchange="window.handleImportStudents(event)"></label><button onclick="window.exportAllStudentsExcel('${window.adminSelectedRoom}')" class="bg-teal-600 hover:bg-teal-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm flex-1 sm:flex-none shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-download"></i> โหลดสรุป</button><button onclick="window.deleteAllStudentsInRoom(window.adminSelectedRoom)" class="bg-rose-50 border border-rose-200 hover:bg-rose-100 text-rose-600 px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm flex-1 sm:flex-none shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-user-times"></i> ลบนักเรียนทุกคน</button></div></div>`;
                html += `<div class="mb-4 bg-indigo-50/60 p-3 sm:p-4 rounded-xl border border-indigo-200 flex flex-col sm:flex-row sm:items-center justify-between gap-2"><div><h4 class="font-extrabold text-indigo-800 text-xs sm:text-sm flex items-center gap-1.5"><i class="fas fa-layer-group"></i> นำเข้ารายชื่อนักเรียนทุกห้องพร้อมกัน</h4><p class="text-[9px] sm:text-[11px] text-indigo-500 font-medium mt-0.5">ไฟล์เดียวใส่ได้หลายห้อง มีคอลัมน์ระบุห้องเรียนในตัวเอง เหมาะสำหรับตอนเริ่มต้นภาคเรียนที่ต้องลงรายชื่อทีเดียวหลายห้อง</p></div><div class="flex flex-wrap gap-1.5"><button onclick="window.downloadStudentTemplateAllRooms()" class="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-file-download"></i> โหลดฟอร์ม (ทุกห้อง)</button><label class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-sm cursor-pointer text-center shadow-sm transition-colors flex justify-center items-center gap-1"><i class="fas fa-file-import"></i> นำเข้าทุกห้อง<input type="file" accept=".xlsx, .xls" class="hidden" onchange="window.handleImportStudentsAllRooms(event)"></label></div></div>`;
                const roomStudentsForCount = getRoomStudents(window.adminSelectedRoom, adminYear(), true);
                const activeCountSm = roomStudentsForCount.filter(s => s.status !== 'resigned' && s.status !== 'hidden').length, hiddenCountSm = roomStudentsForCount.filter(s => s.status === 'hidden').length;
                const resignedCountSm = roomStudentsForCount.filter(s => s.status === 'resigned').length;
                html += `<div class="flex flex-wrap gap-2 mb-4"><span class="bg-slate-100 border border-slate-200 text-slate-700 text-[10px] sm:text-xs font-black px-2.5 py-1.5 rounded-full flex items-center gap-1.5"><i class="fas fa-users"></i> ทั้งหมด ${roomStudentsForCount.length} คน</span><span class="bg-emerald-50 border border-emerald-200 text-emerald-700 text-[10px] sm:text-xs font-bold px-2.5 py-1.5 rounded-full flex items-center gap-1.5"><i class="fas fa-user-check"></i> เรียนอยู่ ${activeCountSm} คน</span><span class="bg-rose-50 border border-rose-200 text-rose-600 text-[10px] sm:text-xs font-bold px-2.5 py-1.5 rounded-full flex items-center gap-1.5"><i class="fas fa-user-minus"></i> ออก/ย้าย ${resignedCountSm} คน</span>${hiddenCountSm ? `<span class="bg-slate-100 border border-slate-300 text-slate-600 text-[10px] sm:text-xs font-bold px-2.5 py-1.5 rounded-full flex items-center gap-1.5" title="ไม่ขึ้นในหน้าเช็คชื่อ / รายงาน"><i class="fas fa-eye-slash"></i> ซ่อน ${hiddenCountSm} คน</span>` : ''}</div>`;
                html += `<div class="mb-4 bg-slate-50 p-2 rounded-xl border border-slate-200 shadow-sm"><div class="relative"><div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none"><i class="fas fa-search text-slate-400"></i></div><input type="text" id="searchStudentInput" onkeyup="window.filterAdminStudents()" class="w-full pl-9 pr-3 py-2 bg-white border border-slate-200 rounded-lg text-sm font-bold focus:outline-none focus:ring-2 focus:ring-indigo-400 shadow-inner" placeholder="ค้นหา เลขที่, เลขประจำตัว, ชื่อ-นามสกุล..."></div></div>`;
                html += `<div id="studentModal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] hidden flex items-center justify-center p-3 transition-opacity"><div class="bg-white rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto transform scale-95 opacity-0 transition-all duration-300" id="studentModalBox"><div class="p-4 sm:p-6"><div class="flex justify-between items-center mb-3 border-b pb-2"><h4 class="font-extrabold text-lg" id="studentModalTitle">เพิ่ม</h4><button onclick="window.closeStudentModal()" class="text-slate-400 text-xl hover:text-rose-500 transition-colors"><i class="fas fa-times"></i></button></div><div class="grid grid-cols-2 gap-2.5 mb-4"><div><label class="block text-[10px] sm:text-xs font-bold mb-1">เลขที่</label><input type="number" id="newStuNum" class="w-full bg-slate-50 border border-slate-200 rounded px-2 py-2 text-base sm:text-sm outline-none focus:ring-1 focus:ring-indigo-400"></div><div><label class="block text-[10px] sm:text-xs font-bold mb-1">สถานะ</label><select id="newStuStatus" class="w-full bg-slate-50 border border-slate-200 rounded px-2 py-2 text-base sm:text-sm outline-none"><option value="active">เรียนอยู่</option><option value="resigned">ออก/ย้าย</option><option value="hidden">ซ่อน (ไม่ขึ้นหน้าเช็คชื่อ เช่น แขวนลอย)</option></select></div><div class="col-span-2"><label class="block text-[10px] sm:text-xs font-bold mb-1">เลขประจำตัวนักเรียน <span class="font-medium text-slate-400">(ไม่บังคับ)</span></label><input type="text" id="newStuCode" inputmode="numeric" maxlength="20" placeholder="เช่น 34512" class="w-full bg-slate-50 border border-slate-200 rounded px-2 py-2 text-base sm:text-sm outline-none focus:ring-1 focus:ring-indigo-400"></div><div class="col-span-2"><label class="block text-[10px] sm:text-xs font-bold mb-1">คำนำหน้า + ชื่อ-นามสกุล</label><input type="text" id="newStuName" placeholder="เช่น นาย สมชาย ใจดี" class="w-full bg-slate-50 border border-slate-200 rounded px-2 py-2 text-base sm:text-sm outline-none focus:ring-1 focus:ring-indigo-400"></div></div><div class="flex justify-end gap-2"><button onclick="window.closeStudentModal()" class="bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded font-bold text-sm transition-colors">ยกเลิก</button><button onclick="window.saveStudentForm()" class="bg-blue-600 hover:bg-blue-700 text-white px-4 py-1.5 rounded font-bold text-sm shadow-sm transition-colors"><i class="fas fa-save"></i> บันทึก</button></div></div></div></div><div class="overflow-x-auto rounded-xl border border-slate-200 max-h-[500px] w-full"><table class="w-full text-left text-[10px] sm:text-sm min-w-[300px] sm:min-w-[400px]"><thead class="bg-slate-100 sticky top-0 z-10 border-b"><tr><th class="p-2 w-12 sm:w-16 text-center sticky left-0 bg-slate-100 z-20 shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">เลขที่</th><th class="p-2 w-20 sm:w-28">เลขประจำตัว</th><th class="p-2">ชื่อ-นามสกุล</th><th class="p-2 text-center w-20">จัดการ</th></tr></thead><tbody class="divide-y divide-slate-100" id="adminStudentTableBody">`;
                const roomStudents = getRoomStudents(window.adminSelectedRoom, adminYear(), true).sort((a,b) => parseInt(a.number) - parseInt(b.number));
                if(roomStudents.length === 0) { html += `<tr><td colspan="4" class="p-8 text-center text-slate-400 font-medium">ยังไม่มีข้อมูลนักเรียน</td></tr>`;
                } else { roomStudents.forEach(st => { const badge = st.status === 'resigned' ? `<span class="bg-rose-100 text-rose-700 px-1 py-0.5 rounded text-[8px] sm:text-[10px] ml-1 border border-rose-200 font-bold">ออก/ย้าย</span>` : (st.status === 'hidden' ? `<span class="bg-slate-100 text-slate-600 px-1 py-0.5 rounded text-[8px] sm:text-[10px] ml-1 border border-slate-300 font-bold" title="ไม่ขึ้นในหน้าเช็คชื่อ / รายงาน"><i class="fas fa-eye-slash"></i> ซ่อน</span>` : ''); html += `<tr class="hover:bg-slate-50 transition-colors" data-search="${st.number} ${st.code || ''} ${st.name}"><td class="p-2 text-center font-bold text-slate-500 sticky left-0 bg-white shadow-[2px_0_5px_-2px_rgba(0,0,0,0.05)]">${st.number}</td><td class="p-2 font-mono text-slate-500 text-[10px] sm:text-sm">${st.code ? hrEsc(st.code) : '<span class="text-slate-300">-</span>'}</td><td class="p-2 font-bold ${st.status==='resigned' || st.status==='hidden'?'text-slate-400':''} text-[11px] sm:text-sm">${st.name} ${badge}</td><td class="p-2 text-center flex justify-center gap-1"><button onclick="window.prepareEditStudent('${st.id}')" class="text-amber-500 bg-amber-50 hover:bg-amber-100 p-1.5 rounded transition-colors"><i class="fas fa-edit"></i></button><button onclick="window.deleteStudent('${st.id}')" class="text-rose-500 bg-rose-50 hover:bg-rose-100 p-1.5 rounded transition-colors"><i class="fas fa-trash"></i></button></td></tr>`;
                }); }
                html += `</tbody></table></div>`;
                content.innerHTML = html;
            }
            else if (currentAdminTab === 'users') {
                if (!currentUser || currentUser.role !== 'super_admin') {
                    content.innerHTML = `<div class="text-center text-slate-400 py-16 font-bold"><i class="fas fa-lock text-3xl mb-3"></i><br>เฉพาะ Super Admin เท่านั้นที่จัดการผู้ใช้งานได้</div>`;
                    return;
                }
                let html = `<div class="flex justify-between items-center mb-4 flex-wrap gap-2"><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 flex items-center gap-2"><i class="fas fa-user-cog text-indigo-500"></i> จัดการผู้ใช้งาน (แอดมิน)</h3><button onclick="window.openUserModal()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-3 sm:px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-user-plus"></i> เพิ่มผู้ใช้ใหม่</button></div>`;
                html += `<div id="userModal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] hidden flex items-center justify-center p-3 transition-opacity"><div class="bg-white rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-md transform scale-95 opacity-0 transition-all duration-300" id="userModalBox"><div class="p-4 sm:p-6"><div class="flex justify-between items-center mb-3 border-b pb-2"><h4 class="font-extrabold text-lg" id="userModalTitle">เพิ่มผู้ใช้งาน</h4><button onclick="window.closeUserModal()" class="text-slate-400 text-xl hover:text-rose-500 transition-colors"><i class="fas fa-times"></i></button></div><div class="space-y-3 mb-4"><div><label class="block text-xs font-bold mb-1">ชื่อ-นามสกุล (แสดงในระบบ)</label><input type="text" id="newUserName" class="w-full bg-slate-50 border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400" placeholder="เช่น เจ้าหน้าที่ทะเบียน"></div><div><label class="block text-xs font-bold mb-1">ชื่อผู้ใช้ (Username)</label><input type="text" id="newUserUsername" class="w-full bg-slate-50 border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400" placeholder="username"></div><div><label class="block text-xs font-bold mb-1">รหัสผ่าน</label><input type="text" id="newUserPassword" class="w-full bg-slate-50 border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-indigo-400" placeholder="ตั้งรหัสผ่าน"></div><div class="bg-indigo-50 border border-indigo-200 text-indigo-700 text-[10px] sm:text-xs font-bold rounded-lg px-3 py-2 flex items-center gap-1.5"><i class="fas fa-info-circle"></i> ผู้ใช้ใหม่จะได้รับสิทธิ์ "เจ้าหน้าที่" (ไม่สามารถเพิ่ม/แก้ไข/ลบผู้ใช้งานอื่นได้)</div></div><div class="flex justify-end gap-2"><button onclick="window.closeUserModal()" class="bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded font-bold text-sm transition-colors">ยกเลิก</button><button onclick="window.saveUserForm()" class="bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded font-bold text-sm shadow-sm transition-colors"><i class="fas fa-save"></i> บันทึก</button></div></div></div></div>`;
                html += `<div class="space-y-2.5">`;
                (settings.users || []).forEach(u => {
                    const isSuper = u.role === 'super_admin';
                    const isSelf = currentUser && u.id === currentUser.id;
                    html += `<div class="flex items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3 sm:p-4"><div class="flex items-center gap-3 min-w-0"><div class="w-9 h-9 sm:w-11 sm:h-11 rounded-full flex items-center justify-center text-sm sm:text-lg shrink-0 ${isSuper ? 'bg-purple-100 text-purple-700' : 'bg-indigo-100 text-indigo-700'}"><i class="fas ${isSuper ? 'fa-crown' : 'fa-user'}"></i></div><div class="min-w-0"><div class="font-bold text-slate-800 text-sm sm:text-base truncate">${u.name} ${isSuper ? '<span class="bg-purple-100 text-purple-700 border border-purple-200 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 rounded-full ml-1">Super Admin</span>' : '<span class="bg-indigo-100 text-indigo-700 border border-indigo-200 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 rounded-full ml-1">เจ้าหน้าที่</span>'}${isSelf ? '<span class="bg-emerald-100 text-emerald-700 border border-emerald-200 text-[9px] sm:text-[10px] font-black px-1.5 py-0.5 rounded-full ml-1">คุณ</span>' : ''}</div><div class="text-[10px] sm:text-xs text-slate-500 font-medium truncate">Username: ${u.username}</div></div></div><div class="flex gap-1.5 shrink-0">${isSuper ? (isSelf ? `<button onclick="window.openUserModal('${u.id}')" class="text-amber-500 bg-amber-50 hover:bg-amber-100 p-2 rounded-lg transition-colors" title="เปลี่ยนรหัสผ่านของฉัน"><i class="fas fa-key"></i></button>` : `<span class="text-slate-400 text-[10px] sm:text-xs font-bold px-2 flex items-center gap-1"><i class="fas fa-lock"></i> ล็อกไว้</span>`) : `<button onclick="window.openUserModal('${u.id}')" class="text-amber-500 bg-amber-50 hover:bg-amber-100 p-2 rounded-lg transition-colors"><i class="fas fa-edit"></i></button><button onclick="window.deleteUser('${u.id}')" class="text-rose-500 bg-rose-50 hover:bg-rose-100 p-2 rounded-lg transition-colors"><i class="fas fa-trash"></i></button>`}</div></div>`;
                });
                html += `</div>`;
                content.innerHTML = html;
            }
            else if (currentAdminTab === 'holidays') {
                // ===== ลบวันหยุดเก่าที่เก็บมาเกิน 1 ปีอัตโนมัติ (ทำแค่ครั้งเดียวต่อเซสชัน กันข้อมูลพอกพูนไม่มีที่สิ้นสุด) =====
                if (!window.__holidaysPrunedThisSession) {
                    window.__holidaysPrunedThisSession = true;
                    const oneYearAgo = new Date(); oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
                    const cutoffStr = localDateStr(oneYearAgo);
                    const oldCount = (settings.holidays || []).filter(h => h.date < cutoffStr).length;
                    if (oldCount > 0) {
                        settings.holidays = (settings.holidays || []).filter(h => h.date >= cutoffStr);
                        logAction('ลบวันหยุดเก่ากว่า 1 ปีอัตโนมัติ', `${oldCount} รายการ (ก่อนวันที่ ${cutoffStr})`, 'settings');
                        saveData('full');
                    }
                }
                if (window.holidayCalYear === undefined) { const now = new Date(); window.holidayCalYear = now.getFullYear(); window.holidayCalMonth = now.getMonth(); }
                const year = window.holidayCalYear, month = window.holidayCalMonth;
                const monthNamesFull = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
                const dayNamesShort = ['อา','จ','อ','พ','พฤ','ศ','ส'];
                const firstDay = new Date(year, month, 1);
                const startWeekday = firstDay.getDay();
                const daysInMonth = new Date(year, month + 1, 0).getDate();

                let html = `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-2 flex items-center gap-2"><i class="fas fa-calendar-times text-rose-500"></i> จัดการวันหยุด / กิจกรรม / สอบ และประกาศ</h3><p class="text-[10px] sm:text-xs text-slate-500 font-medium mb-4"><i class="fas fa-info-circle"></i> คลิกวันที่ในปฏิทินเพื่อเพิ่ม/แก้ไข/ลบ เลือกได้ 3 ประเภท: <b class="text-rose-500">วันหยุด</b> (ไม่นับเป็นวันเรียนจริง) <b class="text-sky-500">วันกิจกรรม</b> และ <b class="text-amber-500">วันสอบ</b> (2 ประเภทหลังยังเช็คชื่อและนับเป็นวันเรียนจริงตามปกติ เลือกช่วงเวลาได้ว่าครึ่งวันหรือทั้งวัน) ระบบจะแสดงหมายเหตุในหน้าเช็คชื่อของวันนั้นและขึ้นประกาศบนหน้าเว็บอัตโนมัติด้วย — รายการที่เก่ากว่า 1 ปีจะถูกลบออกให้อัตโนมัติ</p>`;

                html += `<div id="holidayModal" class="fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[60] hidden flex items-center justify-center p-3 transition-opacity"><div class="bg-white rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-md transform scale-95 opacity-0 transition-all duration-300" id="holidayModalBox"><div class="p-4 sm:p-6"><div class="flex justify-between items-center mb-3 border-b pb-2"><h4 class="font-extrabold text-lg" id="holidayModalTitle">เพิ่มวันหยุด</h4><button onclick="window.closeHolidayModal()" class="text-slate-400 text-xl hover:text-rose-500 transition-colors"><i class="fas fa-times"></i></button></div><div class="space-y-3 mb-4"><div><label class="block text-xs font-bold mb-1">วันที่</label><input type="text" id="holidayModalDate" disabled class="w-full bg-slate-100 text-slate-500 border border-slate-200 rounded px-3 py-2 text-sm font-bold outline-none"></div><div><label class="block text-xs font-bold mb-1">ประเภท</label><div class="grid grid-cols-2 gap-1.5" id="holidayModalTypeButtons"><button type="button" onclick="window.setHolidayModalType('holiday')" data-type="holiday" class="px-2 py-2 rounded-lg text-xs sm:text-sm font-bold border-2 transition-all">วันหยุด</button><button type="button" onclick="window.setHolidayModalType('activity')" data-type="activity" class="px-2 py-2 rounded-lg text-xs sm:text-sm font-bold border-2 transition-all">วันกิจกรรม</button><button type="button" onclick="window.setHolidayModalType('exam')" data-type="exam" class="px-2 py-2 rounded-lg text-xs sm:text-sm font-bold border-2 transition-all">วันสอบ</button><button type="button" onclick="window.setHolidayModalType('makeup')" data-type="makeup" class="px-2 py-2 rounded-lg text-xs sm:text-sm font-bold border-2 transition-all">สอนชดเชย</button></div></div><div id="holidayModalMakeupDayWrap" class="hidden"><label class="block text-xs font-bold mb-1">ใช้ตารางสอนของวัน</label><select id="holidayModalMakeupDay" class="w-full bg-slate-50 border border-slate-200 rounded px-3 py-2 text-sm font-bold outline-none focus:ring-1 focus:ring-violet-400"><option value="1">จันทร์</option><option value="2">อังคาร</option><option value="3">พุธ</option><option value="4">พฤหัสบดี</option><option value="5">ศุกร์</option></select></div><div id="holidayModalDurationWrap" class="hidden"><label class="block text-xs font-bold mb-1">ช่วงเวลา</label><div class="grid grid-cols-3 gap-1.5" id="holidayModalDurationButtons"><button type="button" onclick="window.setHolidayModalDuration('morning')" data-duration="morning" class="px-2 py-2 rounded-lg text-[11px] sm:text-xs font-bold border-2 transition-all">ครึ่งเช้า</button><button type="button" onclick="window.setHolidayModalDuration('afternoon')" data-duration="afternoon" class="px-2 py-2 rounded-lg text-[11px] sm:text-xs font-bold border-2 transition-all">ครึ่งบ่าย</button><button type="button" onclick="window.setHolidayModalDuration('full')" data-duration="full" class="px-2 py-2 rounded-lg text-[11px] sm:text-xs font-bold border-2 transition-all">ตลอดวัน</button></div></div><div><label class="block text-xs font-bold mb-1">หมายเหตุ / เหตุผล</label><input type="text" id="holidayModalLabel" class="w-full bg-slate-50 border border-slate-200 rounded px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-rose-400" placeholder="เช่น วันหยุดราชการ, กีฬาสี, สอบปลายภาค"></div><div id="holidayModalNote" class="hidden rounded-lg px-3 py-2 text-[11px] sm:text-xs font-medium"></div></div><div class="flex justify-between items-center gap-2"><button id="holidayModalDeleteBtn" onclick="window.deleteHoliday(document.getElementById('holidayModalDate').value)" class="hidden bg-rose-50 hover:bg-rose-100 text-rose-600 px-3 py-1.5 rounded font-bold text-xs sm:text-sm transition-colors"><i class="fas fa-trash"></i> ลบวันนี้</button><div class="flex gap-2 ml-auto"><button onclick="window.closeHolidayModal()" class="bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded font-bold text-sm transition-colors">ยกเลิก</button><button onclick="window.saveHolidayForm()" class="bg-rose-600 hover:bg-rose-700 text-white px-4 py-1.5 rounded font-bold text-sm shadow-sm transition-colors"><i class="fas fa-save"></i> บันทึก</button></div></div></div></div></div>`;

                html += `<div class="flex items-center justify-between mb-4 bg-slate-50 rounded-xl border border-slate-100 p-2 sm:p-3"><button onclick="window.changeHolidayMonth(-1)" class="w-9 h-9 sm:w-10 sm:h-10 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg flex items-center justify-center text-slate-600 shadow-sm transition-colors"><i class="fas fa-chevron-left"></i></button><span class="font-extrabold text-sm sm:text-lg text-slate-800">${monthNamesFull[month]} ${year + 543}</span><button onclick="window.changeHolidayMonth(1)" class="w-9 h-9 sm:w-10 sm:h-10 bg-white border border-slate-200 hover:bg-slate-100 rounded-lg flex items-center justify-center text-slate-600 shadow-sm transition-colors"><i class="fas fa-chevron-right"></i></button></div>`;

                html += `<div class="grid grid-cols-7 gap-1 sm:gap-1.5 mb-8">`;
                dayNamesShort.forEach(d => { html += `<div class="text-center text-[9px] sm:text-xs font-black text-slate-400 py-1">${d}</div>`; });
                for (let i = 0; i < startWeekday; i++) html += `<div></div>`;
                for (let day = 1; day <= daysInMonth; day++) {
                    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
                    const holiday = getHolidayForDate(dateStr);
                    const isToday = dateStr === todayDateStr();
                    const holType = holiday ? (HOLIDAY_TYPE_META[holiday.type] || HOLIDAY_TYPE_META.holiday) : null;
                    html += `<button onclick="window.openHolidayModal('${dateStr}')" class="aspect-square rounded-lg sm:rounded-xl border p-1 sm:p-1.5 flex flex-col items-center justify-start transition-all hover:shadow-md ${holiday ? holType.calCard : 'bg-white border-slate-200 hover:border-indigo-300'} ${isToday ? 'ring-2 ring-indigo-400' : ''}"><span class="text-[10px] sm:text-sm font-black ${holiday ? holType.calText : 'text-slate-700'}">${day}</span>${holiday ? `<span class="text-[7px] sm:text-[9px] font-bold ${holType.calText} leading-tight text-center hidden sm:block overflow-hidden" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${holiday.label}</span><i class="fas fa-circle ${holType.calDot} text-[5px] sm:hidden mt-0.5"></i>` : ''}</button>`;
                }
                html += `</div>`;

                const allHolidays = (settings.holidays || []).slice().sort((a, b) => a.date.localeCompare(b.date));
                html += `<h4 class="font-extrabold text-sm sm:text-lg text-slate-800 mb-3 flex items-center gap-2"><i class="fas fa-list text-rose-500"></i> รายการวันหยุดทั้งหมด (${allHolidays.length})</h4>`;
                if (allHolidays.length === 0) {
                    html += `<div class="text-center text-slate-400 py-8 text-xs sm:text-sm font-medium bg-slate-50 rounded-xl border border-slate-100">ยังไม่มีการตั้งวันหยุด</div>`;
                } else {
                    html += `<div class="space-y-1.5 max-h-80 overflow-y-auto pr-1">${allHolidays.map(h => `<div class="flex items-center justify-between gap-2 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2"><div class="min-w-0"><span class="font-black text-rose-700 text-xs sm:text-sm">${h.date.split('-').reverse().join('/')}</span><span class="text-rose-600 text-xs sm:text-sm font-bold ml-2">${h.label}</span></div><button onclick="window.deleteHoliday('${h.date}')" class="shrink-0 text-rose-500 hover:text-rose-700 p-1.5"><i class="fas fa-trash"></i></button></div>`).join('')}</div>`;
                }
                // [v1.72.1] วันหยุดเรียนจาก AcademicHub (ดูอย่างเดียว · แก้ที่ปฏิทิน AcademicHub)
                {
                    const hubList = (hubHolidays || []).slice().sort((x, y) => x.date.localeCompare(y.date));
                    const own = new Set((settings.holidays || []).map(h => h.date));
                    html += `<div class="mt-5 mb-6"><div class="flex flex-wrap items-center justify-between gap-2 mb-2"><h4 class="font-extrabold text-sm sm:text-lg text-slate-800 flex items-center gap-2"><i class="fas fa-link text-violet-500"></i> วันหยุดเรียนจาก AcademicHub (${hubList.length})</h4><button onclick="window.syncHubHolidays()" class="bg-violet-600 hover:bg-violet-700 text-white px-3 py-1.5 rounded-lg font-bold text-xs sm:text-sm shadow-sm"><i class="fas fa-sync-alt"></i> ดึงจาก AcademicHub ตอนนี้</button></div><p class="text-[11px] sm:text-xs text-slate-500 font-semibold mb-2">มาจากกิจกรรมในปฏิทิน AcademicHub ที่ติ๊ก "หยุดเรียน ไม่ต้องเช็คชื่อ" · ระบบดึงให้เองทุกประมาณ 6 ชั่วโมง · แก้/ลบได้ที่ AcademicHub · วันที่ตั้งวันหยุดไว้ในเว็บนี้แล้วจะใช้ของเว็บนี้แทน</p>`;
                    html += hubList.length ? `<div class="space-y-1.5 max-h-64 overflow-y-auto pr-1">${hubList.map(h => `<div class="flex items-center gap-2 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2"><span class="font-black text-violet-700 text-xs sm:text-sm">${h.date.split('-').reverse().join('/')}</span><span class="text-violet-700 text-xs sm:text-sm font-bold flex-1 min-w-0 truncate">${hrEsc(h.label)}</span>${own.has(h.date) ? '<span class="text-[10px] font-bold text-slate-500 bg-white border border-slate-200 rounded px-1.5 py-0.5">ใช้วันหยุดของเว็บนี้แทน</span>' : ''}</div>`).join('')}</div>` : `<div class="text-center text-slate-400 py-5 text-xs sm:text-sm font-medium bg-slate-50 rounded-xl border border-slate-100">ยังไม่มีวันหยุดเรียนจาก AcademicHub</div>`;
                    html += `</div>`;
                }
                ensureAnnouncementsArray();
                const annPriorityMeta = { high: { label: 'ด่วนมาก', badge: 'bg-rose-100 text-rose-700 border-rose-300' }, normal: { label: 'ทั่วไป', badge: 'bg-amber-100 text-amber-700 border-amber-300' }, low: { label: 'แจ้งเพื่อทราบ', badge: 'bg-blue-100 text-blue-700 border-blue-300' } };
                html += `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-3 flex items-center gap-2"><i class="fas fa-bullhorn text-amber-500"></i> ประกาศแจ้งเตือน (แสดงบนสุดของเว็บ)</h3><div class="mb-6 bg-amber-50/70 p-3 sm:p-4 rounded-xl border border-amber-200 space-y-3">`;
                if (settings.announcements.length === 0) {
                    html += `<p class="text-[10px] sm:text-xs text-slate-500 font-medium py-2">ยังไม่มีประกาศ — เพิ่มรายการใหม่ด้านล่างได้เลย</p>`;
                } else {
                    html += `<div class="space-y-2">${settings.announcements.map(a => {
                        const active = isAnnouncementItemActive(a);
                        const meta = annPriorityMeta[a.priority] || annPriorityMeta.normal;
                        const rangeLabel = formatAnnouncementRange(a.start, a.end);
                        return `<div class="bg-white border border-amber-200 rounded-lg p-2.5 flex flex-wrap items-center gap-2"><span class="border ${meta.badge} text-[9px] sm:text-[10px] font-black px-2 py-0.5 rounded-full shrink-0">${meta.label}</span>${active ? `<span class="bg-emerald-50 text-emerald-700 border border-emerald-200 text-[9px] sm:text-[10px] font-black px-2 py-0.5 rounded-full shrink-0"><i class="fas fa-circle text-[6px]"></i> กำลังแสดง</span>` : `<span class="bg-slate-100 text-slate-500 border border-slate-200 text-[9px] sm:text-[10px] font-black px-2 py-0.5 rounded-full shrink-0">ไม่แสดง</span>`}<div class="flex-1 min-w-[10rem]"><span class="block text-xs sm:text-sm font-bold text-slate-700 truncate">${(a.text||'').replace(/</g,'&lt;')}</span>${rangeLabel ? `<span class="block text-[9px] sm:text-[11px] text-slate-400 font-medium mt-0.5"><i class="far fa-clock"></i> ${rangeLabel}</span>` : ''}</div><button onclick="window.editAnnouncement('${a.id}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-600 border border-indigo-200 px-2.5 py-1 rounded-lg text-[10px] sm:text-xs font-bold shrink-0"><i class="fas fa-pen"></i> แก้ไข</button><button onclick="window.deleteAnnouncement('${a.id}')" class="bg-rose-50 hover:bg-rose-100 text-rose-600 border border-rose-200 px-2.5 py-1 rounded-lg text-[10px] sm:text-xs font-bold shrink-0"><i class="fas fa-trash-alt"></i> ลบ</button></div>`;
                    }).join('')}</div>`;
                }
                html += `<div class="border-t border-amber-200 pt-3 mt-1"><p id="announcementFormTitle" class="text-[10px] sm:text-xs font-black text-amber-700 mb-2"><i class="fas fa-plus-circle"></i> เพิ่มประกาศใหม่</p><input type="hidden" id="editingAnnouncementId" value=""><div><label class="block text-[10px] sm:text-xs font-bold text-slate-700 mb-1">ข้อความประกาศ</label><textarea id="setAnnouncement" rows="2" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-base sm:text-sm font-bold focus:ring-2 focus:ring-amber-400 outline-none resize-none" placeholder="เช่น ปิดเรียนวันที่ 5 กันยายน เนื่องในกิจกรรมกีฬาสี"></textarea></div><div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-2"><div><label class="block text-[10px] sm:text-xs font-bold text-slate-700 mb-1">ลำดับความสำคัญ</label><select id="setAnnouncementPriority" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-amber-400 outline-none"><option value="high">ด่วนมาก (สีแดง)</option><option value="normal" selected>ทั่วไป (สีเหลือง)</option><option value="low">แจ้งเพื่อทราบ (สีฟ้า)</option></select></div><div><label class="block text-[10px] sm:text-xs font-bold text-slate-700 mb-1">เริ่มแสดงตั้งแต่ (เว้นว่าง = ทันที) <span class="text-slate-400 font-normal">— 24 ชม.</span></label><input type="datetime-local" id="setAnnouncementStart" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-amber-400 outline-none"></div><div><label class="block text-[10px] sm:text-xs font-bold text-slate-700 mb-1">สิ้นสุดการแสดง (เว้นว่าง = ไม่มีวันหมด) <span class="text-slate-400 font-normal">— 24 ชม.</span></label><input type="datetime-local" id="setAnnouncementEnd" class="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-sm font-bold focus:ring-2 focus:ring-amber-400 outline-none"></div></div><div class="flex flex-wrap gap-2 pt-3"><button onclick="window.addAnnouncement()" id="announcementSubmitBtn" class="bg-amber-500 hover:bg-amber-600 text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-plus"></i> เพิ่มประกาศ</button><button onclick="window.cancelEditAnnouncement()" id="announcementCancelBtn" class="hidden bg-slate-100 hover:bg-slate-200 text-slate-600 px-4 py-2 rounded-lg font-bold text-xs sm:text-sm transition-colors">ยกเลิกการแก้ไข</button></div></div></div><h3 class="text-lg sm:text-xl font-extrabold text-rose-600 mb-3 border-t pt-4 sm:pt-6 flex items-center gap-2"><i class="fas fa-bell"></i> ตั้งค่าการแจ้งเตือนติดตาม (ต่อเดือน)</h3><div class="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-3 bg-rose-50 p-3 sm:p-4 rounded-xl border border-rose-100 shadow-inner"><div><label class="block text-[10px] sm:text-xs font-bold text-rose-700 mb-1">สายเกิน (วัน/เดือน)</label><input type="number" id="setLateThresh" value="${settings.thresholds?.late || 4}" class="w-full bg-white border border-rose-200 rounded-lg px-3 py-2 text-base sm:text-sm font-bold focus:ring-2 focus:ring-rose-500 outline-none text-rose-700"></div><div><label class="block text-[10px] sm:text-xs font-bold text-rose-700 mb-1">ขาดเกิน (วัน/เดือน)</label><input type="number" id="setAbsentThresh" value="${settings.thresholds?.absent || 4}" class="w-full bg-white border border-rose-200 rounded-lg px-3 py-2 text-base sm:text-sm font-bold focus:ring-2 focus:ring-rose-500 outline-none text-rose-700"></div></div><div class="mb-3 bg-orange-50 p-3 sm:p-4 rounded-xl border border-orange-100 shadow-inner"><p class="text-[10px] sm:text-xs font-bold text-orange-700 mb-2"><i class="fas fa-door-open"></i> เกณฑ์ "มาโรงเรียนแต่เข้าเรียนไม่ครบ" (นับจากขาดเรียนบางคาบทั้งที่มาโรงเรียน)</p><div class="grid grid-cols-1 sm:grid-cols-2 gap-3"><div><label class="block text-[10px] sm:text-xs font-bold text-orange-700 mb-1">ขาดตั้งแต่กี่คาบ ถึงนับว่า "ไม่ครบ" ในวันนั้น</label><input type="number" id="setIncompletePeriodsThresh" value="${settings.thresholds?.incompletePeriods || 4}" class="w-full bg-white border border-orange-200 rounded-lg px-3 py-2 text-base sm:text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none text-orange-700"></div><div><label class="block text-[10px] sm:text-xs font-bold text-orange-700 mb-1">เกิดซ้ำกี่วัน ภายใน 1 สัปดาห์ ถึงขึ้นแจ้งเตือน (นับต่อเนื่องได้ ไม่ติดเส้นแบ่งเดือน)</label><input type="number" id="setIncompleteDaysThresh" value="${settings.thresholds?.incompleteDays || 3}" class="w-full bg-white border border-orange-200 rounded-lg px-3 py-2 text-base sm:text-sm font-bold focus:ring-2 focus:ring-orange-500 outline-none text-orange-700"></div></div></div><div class="mb-3 bg-teal-50 p-3 sm:p-4 rounded-xl border border-teal-100 shadow-inner"><p class="text-[10px] sm:text-xs font-bold text-teal-700 mb-2"><i class="fas fa-user-md"></i> เกณฑ์ "ลาป่วย/ลากิจ ชนะสาย" (กรณีมีคาบยืนยันลาป่วย-ลากิจมากพอในวันเดียวกัน - ไม่มีผลกับขาด เพราะลาป่วยต้องแจ้งก่อน 8.00 น.)</p><div><label class="block text-[10px] sm:text-xs font-bold text-teal-700 mb-1">ลาป่วยหรือลากิจตั้งแต่กี่คาบ ถึงเปลี่ยนสถานะทั้งวันเป็นลาป่วย/ลากิจ (แทนที่จะเป็นสาย เท่านั้น)</label><input type="number" id="setLeaveOverrideThresh" value="${settings.thresholds?.leaveOverride || 4}" class="w-full bg-white border border-teal-200 rounded-lg px-3 py-2 text-base sm:text-sm font-bold focus:ring-2 focus:ring-teal-500 outline-none text-teal-700"></div><p class="text-[9px] sm:text-[10px] text-teal-500 font-medium mt-2">เช่น คาบ B (เข้าแถว) เช็คว่าสายไว้ก่อน แต่พอถึงเวลาเรียนจริง เพื่อนแจ้งครูประจำวิชาว่าลาป่วย/ลากิจ ถ้าคาบที่เป็นลาป่วย/ลากิจรวมกันถึงเกณฑ์นี้ ระบบจะถือว่าทั้งวันเป็นลาป่วย/ลากิจแทน (ถ้าเช็คว่า "ขาด" ไว้ตั้งแต่แรก จะยังคงเป็น "ขาด" เสมอ ไม่ว่าจะมีคาบลาป่วย/ลากิจกี่คาบก็ตาม เพราะการลาป่วยที่ถูกต้องต้องแจ้งก่อน 8.00 น.)</p></div><div class="flex justify-end mb-6"><button onclick="window.saveThresholdSettings()" class="bg-rose-600 hover:bg-rose-700 text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-save"></i> บันทึกเกณฑ์แจ้งเตือน</button></div>`;
                content.innerHTML = html;
            }
            else if (currentAdminTab === 'logs') {
                // ===== [ใหม่] log ไม่ได้ถูกส่งมาตอนโหลดหน้าแรกอีกต่อไป (เบากว่าเดิม) - โหลดแยกตอนเปิดแท็บนี้เท่านั้น =====
                if (!window.__logsLoaded) {
                    content.innerHTML = `<div class="flex items-center justify-center py-10 text-slate-400 gap-2"><i class="fas fa-spinner fa-spin"></i> กำลังโหลดประวัติการแก้ไข...</div>`;
                    fetch(`${GOOGLE_APP_SCRIPT_URL}?action=get_logs`).then(r => r.json()).then(data => {
                        if (data && data.status === 'success' && Array.isArray(data.logs)) logs = data.logs;
                        window.__logsLoaded = true;
                        if (currentAdminTab === 'logs') renderAdminTab();
                    }).catch(() => { showToast("โหลดประวัติการแก้ไขไม่สำเร็จ", "error"); });
                    return;
                }
                if (!window.logFilterCategory) window.logFilterCategory = 'all';
                if (!window.logFilterUser) window.logFilterUser = 'all';
                const catMeta = {
                    all: { label: 'ทั้งหมด', icon: 'fa-list', color: 'slate' },
                    settings: { label: 'ปรับตั้งค่าระบบ', icon: 'fa-cog', color: 'indigo' },
                    data: { label: 'ลงข้อมูลต่างๆ', icon: 'fa-database', color: 'emerald' },
                    account: { label: 'บัญชีผู้ใช้', icon: 'fa-user-shield', color: 'purple' },
                };
                const uniqueUsers = [...new Set(logs.map(l => l.name))].sort((a,b) => a.localeCompare(b));
                const isSuperAdminLogs = currentUser && currentUser.role === 'super_admin';
                // ===== [แก้ไข] ไม่แสดง Log ของ Super Admin ให้ Admin ทั่วไปเห็น - เทียบ username แบบไม่สนตัวพิมพ์เล็ก-ใหญ่ กันหลุดกรณีตัวพิมพ์ไม่ตรงกันเป๊ะ =====
                const superAdminUsernames = new Set((settings.users || []).filter(u => u.role === 'super_admin').map(u => (u.username || '').toLowerCase()));
                const visibleUniqueUsers = isSuperAdminLogs ? uniqueUsers : uniqueUsers.filter(name => {
                    const matchLog = logs.find(l => l.name === name);
                    return !matchLog || !superAdminUsernames.has((matchLog.username || '').toLowerCase());
                });
                let html = `<div class="flex justify-between items-center mb-4 flex-wrap gap-2"><h3 class="text-lg sm:text-xl font-extrabold text-slate-800 flex items-center gap-2"><i class="fas fa-history text-indigo-500"></i> Log</h3><div class="flex gap-1.5"><button onclick="window.refreshLogView(this)" class="bg-indigo-50 border border-indigo-200 hover:bg-indigo-100 text-indigo-700 px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-sync-alt" id="logRefreshIcon"></i> รีเฟรช Log</button>${isSuperAdminLogs && logs.length > 0 ? `<button onclick="window.clearAllLogs()" class="bg-rose-50 border border-rose-200 hover:bg-rose-100 text-rose-600 px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-trash-alt"></i> ล้างประวัติ Log ทั้งหมด</button>` : ''}</div></div>`;
                html += `<div class="flex flex-wrap gap-1.5 mb-3">${Object.entries(catMeta).map(([key, m]) => `<button onclick="window.filterLogCategory('${key}')" class="px-3 py-1.5 rounded-full text-[10px] sm:text-xs font-bold border transition-colors flex items-center gap-1.5 ${window.logFilterCategory === key ? `bg-${m.color}-600 text-white border-${m.color}-600` : `bg-white text-slate-600 border-slate-200 hover:bg-slate-50`}"><i class="fas ${m.icon}"></i> ${m.label}</button>`).join('')}</div>`;
                if (window.logFilterCategory === 'account') { html += `<div class="mb-3 flex items-start gap-2 bg-purple-50 border border-purple-200 text-purple-700 rounded-lg px-3 py-2.5"><i class="fas fa-info-circle mt-0.5"></i><span class="text-[10px] sm:text-xs font-bold leading-relaxed">ระบบจะออกจากระบบให้อัตโนมัติหากไม่มีการใช้งานเกิน 30 นาที (เพื่อความปลอดภัยของบัญชี) เหตุการณ์นี้จะถูกบันทึกเป็น "ออกจากระบบอัตโนมัติ (หมดเวลา)" ในหมวดนี้เช่นกัน</span></div>`; }
                html += `<div class="mb-4 flex items-center gap-2 flex-wrap"><label class="text-[10px] sm:text-xs font-bold text-slate-500 flex items-center gap-1.5"><i class="fas fa-user"></i> กรองเฉพาะบัญชี:</label><select onchange="window.filterLogUser(this.value)" class="bg-white border border-slate-200 rounded-lg px-2.5 py-1.5 text-[10px] sm:text-xs font-bold outline-none focus:ring-2 focus:ring-indigo-400"><option value="all" ${window.logFilterUser === 'all' ? 'selected' : ''}>ทุกบัญชี</option>${visibleUniqueUsers.map(u => `<option value="${u}" ${window.logFilterUser === u ? 'selected' : ''}>${u}</option>`).join('')}</select></div>`;
                let filteredLogs = (window.logFilterCategory === 'all') ? logs.slice() : logs.filter(l => (l.category || 'data') === window.logFilterCategory);
                if (!isSuperAdminLogs) filteredLogs = filteredLogs.filter(l => !superAdminUsernames.has((l.username || '').toLowerCase()));
                if (window.logFilterUser !== 'all') filteredLogs = filteredLogs.filter(l => l.name === window.logFilterUser);
                const sortedLogs = filteredLogs.slice().reverse().slice(0, 200);
                html += `<div class="mb-3"><span class="text-[10px] sm:text-xs text-slate-400 font-bold">แสดงล่าสุด ${sortedLogs.length} จาก ${filteredLogs.length} รายการ${window.logFilterCategory !== 'all' ? ` (หมวด: ${catMeta[window.logFilterCategory].label})` : ''}${window.logFilterUser !== 'all' ? ` (บัญชี: ${window.logFilterUser})` : ''}</span></div>`;
                if (sortedLogs.length === 0) {
                    html += `<div class="text-center text-slate-400 py-16 font-medium"><i class="fas fa-inbox text-3xl mb-3"></i><br>ยังไม่มีประวัติในหมวดนี้</div>`;
                } else {
                    html += `<div class="space-y-2 max-h-[600px] overflow-y-auto pr-1">`;
                    sortedLogs.forEach(l => {
                        const d = new Date(l.timestamp);
                        const dateStr = isNaN(d) ? '' : d.toLocaleString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                        const m = catMeta[l.category || 'data'] || catMeta.data;
                        html += `<div class="bg-slate-50 border border-slate-200 rounded-xl p-3 flex flex-col sm:flex-row sm:items-start sm:items-center gap-1.5 sm:gap-3"><div class="shrink-0 text-[10px] sm:text-xs font-bold text-slate-400 sm:w-36">${dateStr}</div><div class="shrink-0 text-[10px] sm:text-xs font-black text-${m.color}-700 bg-${m.color}-50 border border-${m.color}-200 px-2 py-0.5 rounded-full w-max"><i class="fas ${m.icon}"></i> ${m.label}</div><div class="shrink-0 text-[10px] sm:text-xs font-black text-indigo-700 bg-indigo-50 border border-indigo-200 px-2 py-0.5 rounded-full w-max">${l.name}</div><div class="flex-1 min-w-0"><span class="font-bold text-slate-700 text-xs sm:text-sm">${l.action}</span>${l.details ? `<span class="text-slate-500 text-[10px] sm:text-xs ml-1">— ${l.details}</span>` : ''}</div></div>`;
                    });
                    html += `</div>`;
                }
                content.innerHTML = html;
            }
        }
        window.filterLogCategory = function(cat) { window.logFilterCategory = cat; renderAdminTab(); };
        window.filterLogUser = function(name) { window.logFilterUser = name; renderAdminTab(); };
        window.refreshLogView = async function(btn) {
            const icon = document.getElementById('logRefreshIcon');
            if (icon) icon.classList.add('fa-spin');
            if (btn) btn.disabled = true;
            await window.refreshData();
        };
        window.clearAllLogs = function() {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่ล้างประวัติ Log ได้", "error"); return; }
            showConfirm("ล้างประวัติ Log ทั้งหมด", "ประวัติการแก้ไขทั้งหมดที่บันทึกไว้จะถูกลบอย่างถาวรและไม่สามารถกู้คืนได้ คุณแน่ใจหรือไม่?", () => {
                logs = [];
                logAction('ล้างประวัติ Log ทั้งหมด', '', 'account');
                saveData('full'); showToast("ล้างประวัติ Log เรียบร้อยแล้ว"); renderAdminTab();
            });
        };

        // ===== จัดการวันหยุด/วันสอบ =====
        window.changeHolidayMonth = function(delta) {
            if (window.holidayCalYear === undefined) { const now = new Date(); window.holidayCalYear = now.getFullYear(); window.holidayCalMonth = now.getMonth(); }
            window.holidayCalMonth += delta;
            if (window.holidayCalMonth > 11) { window.holidayCalMonth = 0; window.holidayCalYear++; }
            if (window.holidayCalMonth < 0) { window.holidayCalMonth = 11; window.holidayCalYear--; }
            renderAdminTab();
        };
        window.openHolidayModal = function(dateStr) {
            const holiday = getHolidayForDate(dateStr);
            document.getElementById('holidayModalTitle').innerText = holiday ? 'แก้ไขวันที่นี้' : 'เพิ่มวันหยุด/กิจกรรม/สอบ';
            document.getElementById('holidayModalDate').value = dateStr;
            document.getElementById('holidayModalLabel').value = holiday ? holiday.label : '';
            document.getElementById('holidayModalDeleteBtn').classList.toggle('hidden', !holiday);
            window.setHolidayModalType((holiday && holiday.type) || 'holiday');
            window.setHolidayModalDuration((holiday && holiday.duration) || 'full');
            document.getElementById('holidayModalMakeupDay').value = (holiday && holiday.useDayOfWeek) || String((new Date(dateStr).getDay() || 7) <= 5 ? (new Date(dateStr).getDay() || 7) : 1);
            document.getElementById('holidayModal').classList.remove('hidden');
            setTimeout(() => { document.getElementById('holidayModalBox').classList.remove('scale-95', 'opacity-0'); document.getElementById('holidayModalBox').classList.add('scale-100', 'opacity-100'); }, 10);
        };
        // ===== [ใหม่] สลับประเภทในหน้าต่างเพิ่ม/แก้ไข - โชว์/ซ่อนตัวเลือกช่วงเวลาตามประเภทที่เลือก =====
        window.setHolidayModalType = function(type) {
            document.getElementById('holidayModal').dataset.type = type;
            document.querySelectorAll('#holidayModalTypeButtons button').forEach(btn => {
                const active = btn.dataset.type === type;
                btn.className = `px-2 py-2 rounded-lg text-xs sm:text-sm font-bold border-2 transition-all ${active ? HOLIDAY_TYPE_META[btn.dataset.type].activeBtn : 'border-slate-200 bg-white text-slate-500'}`;
            });
            document.getElementById('holidayModalDurationWrap').classList.toggle('hidden', type === 'holiday' || type === 'makeup');
            document.getElementById('holidayModalMakeupDayWrap').classList.toggle('hidden', type !== 'makeup');
            const noteEl = document.getElementById('holidayModalNote');
            if (type === 'holiday') { noteEl.classList.add('hidden'); }
            else {
                noteEl.classList.remove('hidden'); noteEl.className = `${HOLIDAY_TYPE_META[type].noteBg.replace('border-2', 'border')} rounded-lg px-3 py-2 text-[11px] sm:text-xs font-medium ${HOLIDAY_TYPE_META[type].noteText}`;
                let msg;
                if (type === 'activity') msg = 'วันกิจกรรมยังเช็คชื่อได้ตามปกติ และนับเป็นวันเรียนจริงในสมุดทะเบียน';
                else if (type === 'exam') msg = 'วันสอบยังเช็คชื่อได้ตามปกติ และนับเป็นวันเรียนจริงในสมุดทะเบียน';
                else msg = 'วันนี้จะใช้ตารางสอนของวันที่เลือกแทนตารางเดิมของวันนี้ทั้งวัน (เหมาะกับวันสลับ/ชดเชย รวมถึงชดเชยวันเสาร์-อาทิตย์)';
                noteEl.innerHTML = `<i class="fas fa-info-circle"></i> ${msg}`;
            }
        };
        window.setHolidayModalDuration = function(duration) {
            document.getElementById('holidayModal').dataset.duration = duration;
            document.querySelectorAll('#holidayModalDurationButtons button').forEach(btn => {
                const active = btn.dataset.duration === duration;
                const type = document.getElementById('holidayModal').dataset.type || 'holiday';
                btn.className = `px-2 py-2 rounded-lg text-[11px] sm:text-xs font-bold border-2 transition-all ${active ? HOLIDAY_TYPE_META[type].activeBtn : 'border-slate-200 bg-white text-slate-500'}`;
            });
        };
        window.closeHolidayModal = function() {
            document.getElementById('holidayModalBox').classList.remove('scale-100', 'opacity-100');
            document.getElementById('holidayModalBox').classList.add('scale-95', 'opacity-0');
            setTimeout(() => { document.getElementById('holidayModal').classList.add('hidden'); }, 300);
        };
        window.saveHolidayForm = function() {
            const dateStr = document.getElementById('holidayModalDate').value;
            const label = document.getElementById('holidayModalLabel').value.trim();
            const type = document.getElementById('holidayModal').dataset.type || 'holiday';
            const duration = (type === 'activity' || type === 'exam') ? (document.getElementById('holidayModal').dataset.duration || 'full') : undefined;
            const useDayOfWeek = type === 'makeup' ? document.getElementById('holidayModalMakeupDay').value : undefined;
            if (!label) { showToast("กรุณากรอกหมายเหตุ/เหตุผล", "error"); return; }
            if (!settings.holidays) settings.holidays = [];
            const existing = settings.holidays.find(h => h.date === dateStr);
            const entry = { date: dateStr, label, type };
            if (duration) entry.duration = duration;
            if (useDayOfWeek) entry.useDayOfWeek = useDayOfWeek;
            if (existing) {
                existing.label = label; existing.type = type;
                if (duration) existing.duration = duration; else delete existing.duration;
                if (useDayOfWeek) existing.useDayOfWeek = useDayOfWeek; else delete existing.useDayOfWeek;
            } else { settings.holidays.push(entry); }
            const extraLog = type === 'makeup' ? ` (ใช้ตารางวัน${daysLabel[useDayOfWeek - 1].replace('วัน','')})` : '';
            logAction('เพิ่ม/แก้ไขวันในปฏิทิน', `${dateStr.split('-').reverse().join('/')} - ${HOLIDAY_TYPE_META[type].label}${extraLog}: ${label}`, 'settings');
            updateHolidayBar();
            saveData('full'); showToast("บันทึกเรียบร้อย"); renderAdminTab(); closeHolidayModal();
        };
        window.deleteHoliday = function(dateStr) {
            const holiday = getHolidayForDate(dateStr);
            if (!holiday) return;
            showConfirm("ลบวันหยุด", `ต้องการลบวันหยุดวันที่ ${dateStr.split('-').reverse().join('/')} (${holiday.label}) ใช่หรือไม่?`, () => {
                settings.holidays = settings.holidays.filter(h => h.date !== dateStr);
                logAction('ลบวันหยุด', `${dateStr.split('-').reverse().join('/')} - ${holiday.label}`, 'settings');
                updateHolidayBar();
                saveData('full'); showToast("ลบวันหยุดเรียบร้อย"); renderAdminTab();
                const modal = document.getElementById('holidayModal'); if (modal && !modal.classList.contains('hidden')) closeHolidayModal();
            });
        };

        window.saveSiteTitleSettings = function() {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้", "error"); return; }
            settings.title = document.getElementById('setSiteTitle').value.trim() || 'ระบบเช็คชื่อนักเรียนอัจฉริยะ';
            document.getElementById('navTitle').innerText = settings.title;
            document.title = settings.title;
            logAction('แก้ไขชื่อหัวเรื่องระบบ', settings.title, 'settings');
            saveData('full'); showToast("บันทึกชื่อระบบเรียบร้อย"); renderAdminTab();
        };
        // เลือกภาคเรียนที่จะบังคับแสดงผลหน้าแรก (ยังไม่บันทึกจริง - แค่เลือกไว้ก่อน ต้องกด "บันทึก" ถึงจะมีผล)
        window.selectPendingPublicTerm = function(term) {
            window.__pendingPublicTerm = String(term);
            renderAdminTab();
        };
        window.savePublicTermSetting = function() {
            const newTerm = (window.__pendingPublicTerm !== undefined && window.__pendingPublicTerm !== null) ? String(window.__pendingPublicTerm) : String(settings.term);
            if (newTerm === String(settings.term)) { showToast("ภาคเรียนที่แสดงผลหน้าแรกเป็นค่านี้อยู่แล้ว"); return; }
            settings.term = newTerm;
            window.__pendingPublicTerm = null;
            window.__justSwitchedTerm = true;
            document.getElementById('navSubtitle').innerText = `ปีการศึกษา ${settings.year}`;
            logAction('เปลี่ยนภาคเรียนที่แสดงผลหน้าแรก', `บังคับแสดงภาคเรียน ${settings.term}/${settings.year} สำหรับผู้ใช้ทั่วไป`, 'settings');
            saveData('full'); showToast(`บันทึกภาคเรียนที่แสดงผลหน้าแรกเป็นภาคเรียน ${settings.term} แล้ว`); renderAdminTab();
            applyServerStatusBadge();
        };
        // เลือกจำนวนภาคเรียนของระบบ (ยังไม่บันทึกจริง - แค่เลือกไว้ก่อน ต้องกด "บันทึก" ถึงจะมีผล)
        window.selectPendingTermCount = function(n) {
            n = Number(n);
            if (![1, 2, 3].includes(n)) return;
            window.__pendingTermCount = n;
            renderAdminTab();
        };
        window.saveTermCountSetting = function() {
            const n = (window.__pendingTermCount !== undefined && window.__pendingTermCount !== null) ? Number(window.__pendingTermCount) : Number(settings.termCount || 2);
            if (![1, 2, 3].includes(n)) return;
            if (n === Number(settings.termCount || 2)) { showToast("จำนวนภาคเรียนเป็นค่านี้อยู่แล้ว"); return; }
            settings.termCount = n;
            window.__pendingTermCount = null;
            // ถ้าภาคเรียนที่แสดงผลหน้าแรก หรือภาคเรียนที่แอดมินกำลังจัดการอยู่ เกินจำนวนภาคเรียนใหม่ ให้ปรับกลับมาที่ภาคเรียน 1
            if (Number(settings.term) > n) { settings.term = '1'; document.getElementById('navSubtitle').innerText = `ปีการศึกษา ${settings.year}`; }
            if (adminWorkingTerm && Number(adminWorkingTerm) > n) { adminWorkingTerm = null; }
            logAction('ปรับจำนวนภาคเรียนของระบบ', `ตั้งจำนวนภาคเรียนเป็น ${n} ภาคเรียน`, 'settings');
            saveData('full'); showToast(`ตั้งจำนวนภาคเรียนเป็น ${n} ภาคเรียนแล้ว`); renderAdminTab();
        };
        // ===== จัดการปีการศึกษา: เพิ่มปีใหม่ / เลือก+บันทึก / จัดเก็บ (archive) / ปลดล็อค (เฉพาะ Super Admin) =====
        window.openAddYearPrompt = function() {
            showPrompt("เพิ่มปีการศึกษาใหม่", "กรอกปีการศึกษาที่ต้องการเพิ่ม (เช่น 2570)", '', async (val) => {
                const yr = (val || '').trim();
                if (!/^\d{4}$/.test(yr)) { showToast("กรุณากรอกปีการศึกษาเป็นตัวเลข 4 หลัก", "error"); return; }
                if (!settings.academicYears) settings.academicYears = [];
                if (settings.academicYears.some(y => String(y.year) === yr)) { showToast("มีปีการศึกษานี้อยู่แล้วในระบบ", "error"); return; }
                settings.academicYears.push({ year: yr, status: 'active' });
                logAction('เพิ่มปีการศึกษาใหม่', `ปีการศึกษา ${yr}`, 'settings');
                showToast("กำลังบันทึก...", "info");
                const ok = await saveData('full');
                if (ok) { showToast(`เพิ่มปีการศึกษา ${yr} แล้ว (ยังไม่ได้ตั้งเป็นปีที่แสดงผล ต้องเลือกแล้วกดบันทึก)`); }
                else { settings.academicYears = settings.academicYears.filter(y => String(y.year) !== yr); showToast("บันทึกไม่สำเร็จ ยกเลิกการเพิ่มปีการศึกษานี้ กรุณาลองใหม่อีกครั้ง", "error"); }
                renderAdminTab();
            });
        };
        window.selectPendingYear = function(year) {
            year = String(year);
            if (getYearStatus(year) === 'archived') { showToast("ปีการศึกษานี้ถูกจัดเก็บแล้ว ต้องให้ Super Admin ปลดล็อคก่อนจึงจะเลือกใช้งานได้", "error"); return; }
            window.__pendingYear = year;
            renderAdminTab();
        };
        window.saveYearSetting = async function() {
            const newYear = (window.__pendingYear !== undefined && window.__pendingYear !== null) ? String(window.__pendingYear) : String(settings.year);
            if (getYearStatus(newYear) === 'archived') { showToast("ปีการศึกษานี้ถูกจัดเก็บแล้ว ไม่สามารถตั้งเป็นปีที่แสดงผลได้", "error"); return; }
            if (newYear === String(settings.year) && !window.__pendingYear) { showToast("ปีการศึกษานี้ถูกตั้งเป็นปีที่แสดงผลอยู่แล้ว"); return; }
            const previousYear = settings.year;
            settings.year = newYear;
            window.__pendingYear = null;
            document.getElementById('navSubtitle').innerText = `ปีการศึกษา ${settings.year}`;
            window.__justSwitchedTerm = true;
            logAction('เปลี่ยนปีการศึกษาที่แสดงผล', `ตั้งปีการศึกษาที่แสดงผลหน้าแรกเป็น ${settings.year}`, 'settings');
            showToast("กำลังบันทึก...", "info");
            const ok = await saveData('full');
            if (ok) { showToast(`บันทึกปีการศึกษาที่แสดงผลเป็น ${settings.year} แล้ว`); }
            else { settings.year = previousYear; document.getElementById('navSubtitle').innerText = `ปีการศึกษา ${settings.year}`; showToast(`บันทึกไม่สำเร็จ ยกเลิกการเปลี่ยนแปลงและกลับไปใช้ปีการศึกษา ${previousYear} ตามเดิม กรุณาลองใหม่อีกครั้ง`, "error"); }
            renderAdminTab();
            applyServerStatusBadge();
        };
        window.archiveAcademicYear = function(year) {
            year = String(year);
            if (String(settings.year) === year) { showToast("ไม่สามารถจัดเก็บปีการศึกษาที่กำลังแสดงผลอยู่ในขณะนี้ได้ กรุณาเปลี่ยนปีที่แสดงผลก่อน", "error"); return; }
            if (getYearStatus(year) === 'archived') { showToast("ปีการศึกษานี้ถูกจัดเก็บไปแล้ว", "error"); return; }
            showConfirm("ยืนยันการจัดเก็บปีการศึกษา", `ปีการศึกษา ${year} พร้อมจัดเก็บหรือไม่? ข้อมูลการเช็คชื่อทั้งหมดของปีนี้ (ทุกภาคเรียน) จะถูกเก็บถาวรไว้บนเซิร์ฟเวอร์และส่งออกเป็นไฟล์ Excel สำรอง แล้วลบออกจากระบบที่ใช้งานอยู่ทันที หากจัดเก็บแล้วจะไม่สามารถนำปีนี้กลับมาใช้งานได้ (ต้องให้ Super Admin ปลดล็อคเท่านั้น)`, async () => {
                const subjIds = new Set(subjects.filter(s => String(s.year) === year).map(s => s.id));
                const toArchive = attendanceData.filter(a => subjIds.has(a.subjectId));
                if (toArchive.length > 0) {
                    showToast("กำลังเก็บถาวร...", "info");
                    const ok = await saveManualArchiveToServer(toArchive, `attendance_archive_year_${year}`);
                    if (!ok) { showToast("เก็บถาวรไปยังเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง (ยังไม่มีการจัดเก็บปีนี้)", "error"); return; }
                    downloadAttendanceExcel(toArchive, `เก็บถาวรข้อมูลเช็คชื่อ_ปีการศึกษา_${year}.xlsx`);
                    attendanceData = attendanceData.filter(a => !subjIds.has(a.subjectId));
                }
                if (!settings.academicYears) settings.academicYears = [];
                let entry = settings.academicYears.find(y => String(y.year) === year);
                if (!entry) { entry = { year, status: 'active' }; settings.academicYears.push(entry); }
                entry.status = 'archived';
                logAction('จัดเก็บปีการศึกษา (เก็บถาวร)', `ปีการศึกษา ${year} - เก็บถาวรข้อมูลเช็คชื่อ ${toArchive.length} รายการ`, 'settings');
                await saveData('full'); showToast(`จัดเก็บปีการศึกษา ${year} เรียบร้อย${toArchive.length > 0 ? ' (บันทึกบนเซิร์ฟเวอร์ + ดาวน์โหลดไฟล์สำรองแล้ว)' : ''}`); renderAdminTab();
            });
        };
        window.unlockAcademicYear = function(year) {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่ปลดล็อคปีการศึกษาได้", "error"); return; }
            year = String(year);
            showConfirm("ปลดล็อคปีการศึกษา", `ต้องการปลดล็อคปีการศึกษา ${year} เพื่อนำกลับมาใช้งานหรือไม่? (ข้อมูลเช็คชื่อเก่าที่เคยเก็บถาวรไปแล้วจะไม่ถูกนำกลับมา มีเฉพาะไฟล์ Excel ที่ดาวน์โหลดไว้เท่านั้น)`, () => {
                const entry = settings.academicYears && settings.academicYears.find(y => String(y.year) === year);
                if (entry) entry.status = 'active';
                logAction('ปลดล็อคปีการศึกษา', `ปีการศึกษา ${year}`, 'settings');
                saveData('full'); showToast(`ปลดล็อคปีการศึกษา ${year} แล้ว`); renderAdminTab();
            });
        };
        // ซ่อน/แสดงปีการศึกษาจากแอดมินทั่วไป (เฉพาะ Super Admin เห็น/สลับได้) - กันแอดมินหลงเข้าไปเพิ่มข้อมูลในปีเก่าโดยไม่ตั้งใจ ไม่กระทบข้อมูลใดๆ แค่ซ่อนจากตัวเลือกภาคเรียน/ปีเท่านั้น
        window.toggleYearVisibility = function(year) {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่ซ่อน/แสดงปีการศึกษาได้", "error"); return; }
            year = String(year);
            const entry = settings.academicYears && settings.academicYears.find(y => String(y.year) === year);
            if (!entry) return;
            const willHide = !entry.hidden;
            entry.hidden = willHide;
            logAction(willHide ? 'ซ่อนปีการศึกษาจากแอดมินทั่วไป' : 'แสดงปีการศึกษาให้แอดมินทั่วไปเห็นอีกครั้ง', `ปีการศึกษา ${year}`, 'settings');
            saveData('full'); showToast(willHide ? `ซ่อนปีการศึกษา ${year} จากแอดมินทั่วไปแล้ว` : `แสดงปีการศึกษา ${year} ให้แอดมินทั่วไปเห็นอีกครั้งแล้ว`); renderAdminTab();
        };
        // ลบปีการศึกษาที่เพิ่มผิดพลาดออกจากรายการ (เผื่อกรณีสร้างผิด) — บล็อกถ้าเป็นปีที่กำลังใช้แสดงผลอยู่ หรือมีข้อมูลวิชา/นักเรียนผูกอยู่แล้ว เพื่อความปลอดภัย
        window.deleteAcademicYear = function(year) {
            year = String(year);
            if (String(settings.year) === year) { showToast("ไม่สามารถลบปีการศึกษาที่กำลังแสดงผลอยู่ในขณะนี้ได้ กรุณาเปลี่ยนปีที่แสดงผลก่อน", "error"); return; }
            const hasSubjects = subjects.some(s => String(s.year) === year);
            const hasStudents = students.some(s => String(s.year) === year);
            if (hasSubjects || hasStudents) { showToast("ปีการศึกษานี้มีข้อมูลวิชาหรือนักเรียนผูกอยู่แล้ว ไม่สามารถลบได้ (ใช้ปุ่ม \"จัดเก็บ\" แทนหากต้องการเก็บถาวร)", "error"); return; }
            showConfirm("ลบปีการศึกษา", `ต้องการลบปีการศึกษา ${year} ออกจากรายการหรือไม่? (ใช้สำหรับกรณีเพิ่มปีผิดพลาด ยังไม่เคยมีการใช้งานจริง)`, () => {
                settings.academicYears = (settings.academicYears || []).filter(y => String(y.year) !== year);
                logAction('ลบปีการศึกษา', `ปีการศึกษา ${year}`, 'settings');
                saveData('full'); showToast(`ลบปีการศึกษา ${year} แล้ว`); renderAdminTab();
            });
        };
        // เลือกสถานะของภาคเรียนใดภาคเรียนหนึ่งโดยเฉพาะ (ยังไม่บันทึกจริง - แค่เลือกไว้ก่อน ต้องกด "บันทึก" ถึงจะมีผล)
        window.selectPendingTermStatusFor = function(term, status) {
            if (!['open', 'not_opened', 'locked', 'maintenance'].includes(status)) return;
            window.__pendingTermStatusByTerm = window.__pendingTermStatusByTerm || {};
            window.__pendingTermStatusByTerm[term] = status;
            renderAdminTab();
        };
        window.saveTermStatusSettingFor = function(term) {
            window.__pendingTermStatusByTerm = window.__pendingTermStatusByTerm || {};
            const current = getTermStatus(term, settings.year);
            const status = window.__pendingTermStatusByTerm[term] || current;
            if (!['open', 'not_opened', 'locked', 'maintenance'].includes(status)) return;
            if (status === current && !window.__pendingTermStatusByTerm[term]) { showToast("สถานะภาคเรียนนี้เป็นค่านี้อยู่แล้ว"); return; }
            if (!settings.termLocks) settings.termLocks = {};
            const key = termKeyOf(term, settings.year);
            settings.termLocks[key] = status;
            delete window.__pendingTermStatusByTerm[term];
            const labels = { open: 'เปิดใช้งาน', not_opened: 'ยังไม่เปิดใช้งาน', locked: 'ล็อคข้อมูล', maintenance: 'ปิดปรับปรุงชั่วคราว' };
            logAction('เปลี่ยนสถานะภาคเรียน', `ภาคเรียน ${term}/${settings.year} => ${labels[status]}`, 'settings');
            saveData('full'); showToast(`ตั้งสถานะภาคเรียน ${term}/${settings.year} เป็น "${labels[status]}" แล้ว`); renderAdminTab();
            applyServerStatusBadge();
        };
        window.goToNotification = function(idx) {
            const n = window.__pendingNotifs && window.__pendingNotifs[idx]; if (n && n.action) n.action(); else window.navigate('admin', { tab: 'subjects' });
        };
        window.toggleNotifBar = function() {
            window.__notifBarExpanded = !window.__notifBarExpanded;
            renderAdmin();
        };
        window.stepAdminSubjectRoom = function(dir) {
            const list = getRoomList();
            if (window.adminSelectedSubjectRoom === 'all' || !list.includes(window.adminSelectedSubjectRoom)) {
                window.adminSelectedSubjectRoom = dir > 0 ? list[0] : list[list.length - 1];
            } else {
                let idx = list.indexOf(window.adminSelectedSubjectRoom) + dir;
                idx = Math.max(0, Math.min(list.length - 1, idx));
                window.adminSelectedSubjectRoom = list[idx];
            }
            renderAdminTab();
        };
        window.stepAdminRoom = function(dir) {
            const list = getRoomList();
            let idx = list.indexOf(window.adminSelectedRoom) + dir;
            idx = Math.max(0, Math.min(list.length - 1, idx));
            window.adminSelectedRoom = list[idx];
            renderAdminTab();
        };
        window.setTeacherLogMode = function(mode, teacherName) {
            window.__teacherLogState = { mode, teacherFilter: teacherName, search: (window.__teacherLogState && window.__teacherLogState.search) || '' };
            renderAdminTab();
        };
        window.setTeacherViewMode = function(mode) {
            window.__teacherViewMode = mode;
            renderAdminTab();
        };
        window.toggleTeacherLogExpand = function(recordId) {
            if (!window.__teacherLogExpanded) window.__teacherLogExpanded = {};
            window.__teacherLogExpanded[recordId] = !window.__teacherLogExpanded[recordId];
            renderAdminTab();
        };
        window.setTeacherLogSearch = function(value) {
            if (!window.__teacherLogState) window.__teacherLogState = { mode: 'all', teacherFilter: null, search: '' };
            window.__teacherLogState.search = value;
            clearTimeout(window.__tlsT); window.__tlsT = setTimeout(window.__tlsApply, 260); // [v2.01.0] พิมพ์ค้นหาไม่วาดหน้าใหม่ทุกตัวอักษร (ไม่กระพริบ)
        };
        window.__tlsApply = function () {
            const activeEl = document.activeElement, y = window.scrollY;
            const selPos = activeEl && typeof activeEl.selectionStart === 'number' ? activeEl.selectionStart : null;
            const ac = document.getElementById('adminContent'); if (ac) ac.style.minHeight = ac.offsetHeight + 'px';
            renderAdminTab(); window.scrollTo(0, y); if (ac) setTimeout(() => { ac.style.minHeight = ''; }, 50);
            const newInput = document.querySelector('#adminContent input[type="text"]');
            if (newInput) { newInput.focus(); if (selPos !== null) { try { newInput.setSelectionRange(selPos, selPos); } catch (e) {} } }
        };
        window.refreshTeacherLog = async function() {
            window.__teacherLogRefreshing = true; renderAdminTab();
            try {
                const response = await fetch(GOOGLE_APP_SCRIPT_URL);
                const data = await response.json();
                if (data) {
                    // [แก้ไข] เดิมเช็ค if (data.attendanceData) ซึ่งได้ [] เสมอจาก default GET (เพราะย้ายไปเก็บแยกรายห้องใน D1 แล้ว)
                    // [] ถือเป็นค่าจริงใน JavaScript เงื่อนไขนี้เลยผ่านทุกครั้ง ทำให้เขียนทับ attendanceData เป็นค่าว่างหมด - นี่คือบั๊กที่พบและแก้แล้ว
                    if (data.subjects) subjects = data.subjects;
                    if (data.teachers) teachers = data.teachers;
                    // ดึงข้อมูลเช็คชื่อของทุกห้องในภาคเรียน/ปีนี้ใหม่ผ่านช่องทางที่ถูกต้อง (แยกรายห้อง) แทน
                    window.__adminTermRoomsLoaded.delete(String(adminTerm()) + '_' + String(adminYear()));
                    await ensureAttendanceLoadedForAllRoomsInTerm(adminTerm(), adminYear());
                    window.__adminTermRoomsLoaded.add(String(adminTerm()) + '_' + String(adminYear()));
                    showToast("รีเฟรชข้อมูลล่าสุดแล้ว", "success");
                }
            } catch (e) { showToast("รีเฟรชไม่สำเร็จ (เชื่อมต่อเซิร์ฟเวอร์ไม่ได้)", "error"); }
            window.__teacherLogRefreshing = false; renderAdminTab();
        };
        // ดูตัวอย่างภาคเรียนอื่นชั่วคราวที่หน้าแรก - ไม่บันทึกลงเซิร์ฟเวอร์ ไม่มีผลกับผู้ใช้คนอื่น และรีเฟรชหน้าเว็บแล้วจะรีเซ็ตกลับไปภาคเรียนเริ่มต้นที่แอดมินตั้งไว้เสมอ
        window.previewSwitchTerm = function(term) {
            term = String(term);
            if (term === String(viewTerm())) return;
            const status = getTermStatus(term, settings.year);
            if (status === 'not_opened' && !isAdmin) { showToast('ภาคเรียนนี้ยังไม่เปิดใช้งาน', 'error'); return; }
            guestPreviewTerm = (term === String(settings.term)) ? null : term; // ถ้าเลือกกลับมาที่ภาคเรียนเริ่มต้นพอดี ก็เคลียร์ค่ากลับเป็น null
            window.__justSwitchedTerm = true;
            renderDashboard();
        };
        window.saveRoomCountsSettings = function() {
            for(let i=1; i<=6; i++) { settings.roomCounts[`m${i}`] = parseInt(document.getElementById(`setCountM${i}`).value) || 0;
            }
            logAction('แก้ไขจำนวนห้องเรียน', '', 'settings');
            saveData('full'); showToast("บันทึกจำนวนห้องเรียบร้อย"); renderAdminTab();
        };
        window.saveThresholdSettings = function() {
            settings.thresholds = {
                late: parseInt(document.getElementById('setLateThresh').value) || 4,
                absent: parseInt(document.getElementById('setAbsentThresh').value) || 4,
                incompletePeriods: parseInt(document.getElementById('setIncompletePeriodsThresh').value) || 4,
                incompleteDays: parseInt(document.getElementById('setIncompleteDaysThresh').value) || 3,
                leaveOverride: parseInt(document.getElementById('setLeaveOverrideThresh').value) || 4
            };
            logAction('แก้ไขเกณฑ์การแจ้งเตือนติดตาม', `สาย ${settings.thresholds.late} / ขาด ${settings.thresholds.absent} วัน, เข้าเรียนไม่ครบ ${settings.thresholds.incompletePeriods} คาบ x ${settings.thresholds.incompleteDays} วัน, ลาป่วย/ลากิจชนะสาย-ขาดที่ ${settings.thresholds.leaveOverride} คาบ`, 'settings');
            saveData('full'); showToast("บันทึกเกณฑ์แจ้งเตือนเรียบร้อย"); renderAdminTab();
        };
        // ===== [ใหม่] บังคับล้างข้อมูลเช็คชื่อค้างในไฟล์หลักทันที (ปกติล้างอัตโนมัติอยู่แล้วทุกครั้งที่มีการใช้งาน) =====
        window.forceCleanMainFile = async function() {
            showToast("กำลังล้างข้อมูล...", "info");
            try {
                const res = await fetch(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'force_clean_main_file' }) });
                const data = await res.json();
                if (data && data.status === 'success') {
                    showToast(data.cleaned ? "ล้างข้อมูลค้างในไฟล์หลักเรียบร้อย" : "ไฟล์หลักสะอาดอยู่แล้ว ไม่มีอะไรให้ล้าง");
                    window.__storageInfo = null; // บังคับให้ดึงขนาดไฟล์ใหม่มาแสดง
                    renderAdminTab();
                } else { showToast("ล้างข้อมูลไม่สำเร็จ", "error"); }
            } catch (e) { showToast("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้", "error"); }
        };
        // ===== [ใหม่] สร้างไฟล์เช็คชื่อล่วงหน้าให้ครบทุกห้องของภาคเรียน/ปีที่แอดมินกำลังจัดการอยู่ (ไม่บังคับ - แค่เพื่อความสะดวกในการดู/จัดระเบียบ) =====
        window.ensureRoomFilesForCurrentTerm = async function() {
            const roomIds = [...new Set(subjects.filter(s => String(s.term) === String(adminTerm()) && String(s.year) === String(adminYear())).map(s => s.roomId))];
            if (roomIds.length === 0) { showToast("ยังไม่มีวิชาลงไว้ในภาคเรียนนี้ ไม่ทราบว่ามีห้องอะไรบ้าง", "error"); return; }
            showToast(`กำลังสร้างไฟล์ล่วงหน้าให้ ${roomIds.length} ห้อง...`, "info");
            try {
                const res = await fetch(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'ensure_room_files', term: adminTerm(), year: adminYear(), roomIds }) });
                const data = await res.json();
                if (data && data.status === 'success') {
                    showToast(data.createdRooms.length > 0 ? `สร้างไฟล์ใหม่ ${data.createdRooms.length} ห้องเรียบร้อย` : "มีไฟล์ครบทุกห้องอยู่แล้ว");
                    window.__storageInfo = null;
                    renderAdminTab();
                } else { showToast("สร้างไฟล์ไม่สำเร็จ", "error"); }
            } catch (e) { showToast("เชื่อมต่อเซิร์ฟเวอร์ไม่ได้", "error"); }
        };
        window.saveStorageLimit = function() {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้", "error"); return; }
            const val = parseInt(document.getElementById('setStorageLimit').value);
            if (!val || val < 1000) { showToast("กรุณากรอกตัวเลขที่มากกว่า 1,000 ตัวอักษร", "error"); return; }
            settings.storageLimitChars = val;
            logAction('แก้ไขขีดจำกัดพื้นที่จัดเก็บข้อมูล', `${val.toLocaleString()} ตัวอักษร`, 'settings');
            saveData('full'); showToast("บันทึกขีดจำกัดเรียบร้อย"); renderAdminTab();
        };

        // เพิ่มประกาศใหม่เข้าไปในลิสต์ (รองรับหลายรายการ พร้อมลำดับความสำคัญ) - หรือบันทึกทับของเดิมถ้ากำลังอยู่ในโหมดแก้ไข
        window.addAnnouncement = function() {
            const text = document.getElementById('setAnnouncement').value.trim();
            const start = document.getElementById('setAnnouncementStart').value || '';
            const end = document.getElementById('setAnnouncementEnd').value || '';
            const priority = document.getElementById('setAnnouncementPriority').value || 'normal';
            const editingId = document.getElementById('editingAnnouncementId').value;
            if (!text) { showToast("กรุณากรอกข้อความประกาศ", "error"); return; }
            if (start && end && new Date(end) < new Date(start)) { showToast("เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่มต้น", "error"); return; }
            ensureAnnouncementsArray();
            if (editingId) {
                // ===== [ใหม่] โหมดแก้ไข - บันทึกทับรายการเดิมแทนการเพิ่มใหม่ =====
                const idx = settings.announcements.findIndex(a => a.id === editingId);
                if (idx >= 0) settings.announcements[idx] = { ...settings.announcements[idx], text, start, end, priority };
                updateAnnouncementBar();
                logAction('แก้ไขประกาศ', `แก้ไขข้อความ (${priority}): "${text.substring(0,60)}"`, 'settings');
                saveData('full'); showToast("บันทึกการแก้ไขเรียบร้อย"); window.cancelEditAnnouncement(); renderAdminTab();
            } else {
                settings.announcements.push({ id: generateId(), text, start, end, priority });
                updateAnnouncementBar();
                logAction('เพิ่มประกาศ', `ตั้งข้อความ (${priority}): "${text.substring(0,60)}"`, 'settings');
                saveData('full'); showToast("เพิ่มประกาศเรียบร้อย"); renderAdminTab();
            }
        };

        // ===== [ใหม่] เปิดโหมดแก้ไขประกาศที่มีอยู่แล้ว - ดึงค่าเดิมมาใส่ในฟอร์มเดียวกับตอนเพิ่มใหม่ =====
        window.editAnnouncement = function(id) {
            const item = (settings.announcements || []).find(a => a.id === id);
            if (!item) return;
            document.getElementById('editingAnnouncementId').value = id;
            document.getElementById('setAnnouncement').value = item.text || '';
            document.getElementById('setAnnouncementPriority').value = item.priority || 'normal';
            document.getElementById('setAnnouncementStart').value = item.start || '';
            document.getElementById('setAnnouncementEnd').value = item.end || '';
            document.getElementById('announcementFormTitle').innerHTML = '<i class="fas fa-pen"></i> กำลังแก้ไขประกาศ';
            document.getElementById('announcementSubmitBtn').innerHTML = '<i class="fas fa-save"></i> บันทึกการแก้ไข';
            document.getElementById('announcementCancelBtn').classList.remove('hidden');
            document.getElementById('setAnnouncement').scrollIntoView({ behavior: 'smooth', block: 'center' });
        };
        // ===== [ใหม่] ยกเลิกโหมดแก้ไข กลับไปเป็นฟอร์ม "เพิ่มประกาศใหม่" ตามเดิม =====
        window.cancelEditAnnouncement = function() {
            document.getElementById('editingAnnouncementId').value = '';
            document.getElementById('setAnnouncement').value = '';
            document.getElementById('setAnnouncementPriority').value = 'normal';
            document.getElementById('setAnnouncementStart').value = '';
            document.getElementById('setAnnouncementEnd').value = '';
            document.getElementById('announcementFormTitle').innerHTML = '<i class="fas fa-plus-circle"></i> เพิ่มประกาศใหม่';
            document.getElementById('announcementSubmitBtn').innerHTML = '<i class="fas fa-plus"></i> เพิ่มประกาศ';
            document.getElementById('announcementCancelBtn').classList.add('hidden');
        };

        // ลบประกาศทีละรายการ (เฉพาะแอดมิน)
        window.deleteAnnouncement = function(id) {
            showConfirm("ลบประกาศ", "ต้องการลบประกาศรายการนี้ทันทีใช่หรือไม่?", () => {
                ensureAnnouncementsArray();
                settings.announcements = settings.announcements.filter(a => a.id !== id);
                updateAnnouncementBar();
                logAction('ลบประกาศ', '', 'settings');
                saveData('full'); showToast("ลบประกาศแล้ว"); renderAdminTab();
            });
        };

        // อัปโหลดไอคอนเว็บไซต์ (Favicon) - เฉพาะแอดมิน ปรับขนาดภาพให้เล็กลงก่อนบันทึกเพื่อไม่ให้ข้อมูลหนักเกินไป
        window.handleFaviconUpload = function(event) {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้", "error"); return; }
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            if (!file.type.startsWith('image/')) { showToast("กรุณาเลือกไฟล์รูปภาพเท่านั้น", "error"); return; }
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const SIZE = 128;
                    const canvas = document.createElement('canvas');
                    canvas.width = SIZE; canvas.height = SIZE;
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, SIZE, SIZE);
                    const scale = Math.max(SIZE / img.width, SIZE / img.height);
                    const w = img.width * scale, h = img.height * scale;
                    ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
                    const dataUrl = canvas.toDataURL('image/png', 0.9);
                    settings.faviconDataUrl = dataUrl;
                    applyFavicon();
                    const preview = document.getElementById('faviconPreview'); if (preview) preview.src = dataUrl;
                    logAction('เปลี่ยนไอคอนเว็บไซต์ (Favicon)', '', 'settings');
                    saveData('full');
                    showToast("บันทึกไอคอนเว็บไซต์เรียบร้อย");
                };
                img.onerror = () => showToast("ไม่สามารถอ่านไฟล์รูปภาพนี้ได้", "error");
                img.src = e.target.result;
            };
            reader.onerror = () => showToast("เกิดข้อผิดพลาดในการอ่านไฟล์", "error");
            reader.readAsDataURL(file);
            event.target.value = '';
        };

        window.handleHeaderLogoUpload = function(event) {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้", "error"); return; }
            const file = event.target.files && event.target.files[0];
            if (!file) return;
            if (!file.type.startsWith('image/')) { showToast("กรุณาเลือกไฟล์รูปภาพเท่านั้น", "error"); return; }
            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    const SIZE = 160;
                    const canvas = document.createElement('canvas');
                    canvas.width = SIZE; canvas.height = SIZE;
                    const ctx = canvas.getContext('2d');
                    ctx.clearRect(0, 0, SIZE, SIZE);
                    const scale = Math.max(SIZE / img.width, SIZE / img.height);
                    const w = img.width * scale, h = img.height * scale;
                    ctx.drawImage(img, (SIZE - w) / 2, (SIZE - h) / 2, w, h);
                    const dataUrl = canvas.toDataURL('image/png', 0.9);
                    settings.logoDataUrl = dataUrl;
                    applyHeaderLogo();
                    logAction('เปลี่ยนโลโก้บนแถบหัวเว็บไซต์', '', 'settings');
                    saveData('full');
                    showToast("บันทึกโลโก้หัวเว็บไซต์เรียบร้อย");
                    renderAdminTab();
                };
                img.onerror = () => showToast("ไม่สามารถอ่านไฟล์รูปภาพนี้ได้", "error");
                img.src = e.target.result;
            };
            reader.onerror = () => showToast("เกิดข้อผิดพลาดในการอ่านไฟล์", "error");
            reader.readAsDataURL(file);
            event.target.value = '';
        };


        // ===== [ใหม่] ปุ่มลิงก์เว็บภายนอกบนหน้าแรก (Super Admin จัดการได้คนเดียวในหน้าตั้งค่าทั่วไป) =====

        // ===== เลขเวอร์ชัน (รูปแบบ หลัก.ฟีเจอร์.แก้บั๊ก.DDMMYY) + ข้อมูล footer =====
        const APP_VERSION = '2.02.3.091126';
        const SUPPORT_EMAIL = 'tear.jeerasak@gmail.com'; // อีเมลผู้ดูแลระบบ ใช้กับลิงก์ "แจ้งปัญหาการใช้งาน" และหน้านโยบายความเป็นส่วนตัว
        // ===== [v1.72] กดเลขเวอร์ชันที่ท้ายเว็บ = เมนู "โหลดหน้าใหม่" / "ล้างแคชแล้วโหลดใหม่" (เหมือน AcademicHub) =====
        function renderVersionButton(v) {
            if (v.querySelector('#verBtn')) return; // วาดไว้แล้ว
            const prev = v.previousSibling; if (prev && prev.nodeType === 3) prev.textContent = prev.textContent.replace(/v$/, '');
            v.innerHTML = `<span class="relative inline-block" id="verWrap"><button type="button" id="verBtn" aria-haspopup="true" aria-expanded="false" title="โหลดหน้าใหม่ / ล้างแคช" class="underline decoration-dotted underline-offset-2 hover:text-indigo-600 font-semibold">v${APP_VERSION} <i class="fas fa-caret-up"></i></button><span id="verMenu" class="hidden absolute bottom-full left-1/2 -translate-x-1/2 mb-1.5 z-[70] flex-col min-w-[200px] bg-white border border-slate-200 rounded-xl shadow-xl overflow-hidden text-left" style="transform:translateX(-50%);"><button type="button" data-ver="check" class="flex items-center gap-2 px-3.5 py-2.5 text-xs sm:text-sm font-bold text-slate-700 hover:bg-slate-50 whitespace-nowrap"><i class="fas fa-search text-indigo-500 w-4 text-center"></i> ตรวจหาอัปเดต</button><button type="button" data-ver="reload" class="flex items-center gap-2 px-3.5 py-2.5 text-xs sm:text-sm font-bold text-slate-700 hover:bg-slate-50 whitespace-nowrap border-t border-slate-100"><i class="fas fa-redo-alt text-indigo-500 w-4 text-center"></i> โหลดหน้าใหม่</button><button type="button" data-ver="hard" class="flex items-center gap-2 px-3.5 py-2.5 text-xs sm:text-sm font-bold text-slate-700 hover:bg-slate-50 whitespace-nowrap border-t border-slate-100"><i class="fas fa-broom text-indigo-500 w-4 text-center"></i> ล้างแคชแล้วโหลดใหม่</button></span></span>`;
            const btn = document.getElementById('verBtn'), menu = document.getElementById('verMenu');
            const setOpen = (on) => { menu.classList.toggle('hidden', !on); menu.classList.toggle('flex', on); btn.setAttribute('aria-expanded', String(on)); };
            btn.addEventListener('click', (e) => { e.stopPropagation(); setOpen(menu.classList.contains('hidden')); });
            document.addEventListener('click', (e) => { if (!menu.classList.contains('hidden') && !e.target.closest('#verWrap')) setOpen(false); });
            document.addEventListener('keydown', (e) => { if (e.key === 'Escape') setOpen(false); });
            menu.addEventListener('click', (e) => { const b = e.target.closest('[data-ver]'); if (!b) return; setOpen(false); const k = b.getAttribute('data-ver'); if (k === 'check') checkForUpdate(true); else if (k === 'reload') location.reload(); else hardReloadPage(); });
            startUpdateWatch();
        }
        // ===== [v1.75.3] แจ้งเวอร์ชันใหม่ (เหมือน AcademicHub) — อ่านเลขรุ่นจาก version.json บน GitHub (ไม่ผ่าน Worker = ไม่ใช้โควต้า)
        // ตอนเปิดหน้า + ทุก 30 นาที + กลับมาที่แท็บ · "ภายหลัง" = ซ่อนรุ่นนั้น 2 ชั่วโมง · "อัปเดตเลย" = ล้างแคชแล้วโหลดใหม่
        let __updLast = 0, __updShown = '';
        const __verParts = (v) => String(v || '').split('.').slice(0, 3).map(x => parseInt(x, 10) || 0);
        function isNewerVersion(remote, local) {
            if (!remote || remote === local) return false;
            const a = __verParts(remote), b = __verParts(local);
            for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
            return true;
        }
        async function checkForUpdate(manual) {
            __updLast = Date.now();
            let remote = '';
            try { const r = await fetch(new URL('version.json', location.href).href + '?t=' + Date.now(), { cache: 'no-store' }); if (r.ok) remote = String(((await r.json()) || {}).v || ''); } catch (e) { remote = ''; }
            if (!remote) { if (manual) showToast('ตรวจหาอัปเดตไม่ได้ (เชื่อมต่อไม่ได้) — ลองใหม่อีกครั้ง', 'error'); return; }
            if (isNewerVersion(remote, APP_VERSION)) {
                if (!manual) { try { const sn = JSON.parse(localStorage.getItem('bnksa_upd_snooze') || 'null'); if (sn && sn.v === remote && Date.now() - sn.at < 2 * 3600e3) return; } catch (e) {} }
                showUpdateCard(remote);
            } else if (manual) showToast('ใช้เวอร์ชันล่าสุดแล้ว (v' + APP_VERSION + ')');
        }
        function showUpdateCard(v) {
            if (__updShown === v && document.getElementById('updCard')) return;
            __updShown = v;
            const old = document.getElementById('updCard'); if (old) old.remove();
            const c = document.createElement('div'); c.id = 'updCard'; c.setAttribute('role', 'status');
            c.className = 'fixed z-[90] bottom-3 left-4 right-4 sm:left-auto sm:right-5 sm:bottom-5 sm:w-80 bg-white text-slate-800 border border-slate-200 rounded-2xl shadow-2xl p-4 text-left';
            c.innerHTML = `<button type="button" data-upd="later" aria-label="ปิด" class="absolute top-2 right-2 w-7 h-7 rounded-lg bg-rose-600 text-white font-bold flex items-center justify-center"><i class="fas fa-times"></i></button>
                <div class="font-extrabold text-base flex items-center gap-2 pr-8"><i class="fas fa-arrow-circle-up text-indigo-600"></i> มีเวอร์ชันใหม่ ${v}</div>
                <div class="text-sm text-slate-500 mt-1 mb-3">โหลดหน้าใหม่เพื่อใช้งานเวอร์ชันล่าสุด</div>
                <div class="flex justify-end gap-2"><button type="button" data-upd="later" class="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 font-bold text-sm">ภายหลัง</button><button type="button" data-upd="go" class="px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-bold text-sm"><i class="fas fa-redo-alt"></i> อัปเดตเลย</button></div>`;
            c.addEventListener('click', (e) => {
                const b = e.target.closest('[data-upd]'); if (!b) return;
                if (b.getAttribute('data-upd') === 'go') { hardReloadPage(); return; }
                try { localStorage.setItem('bnksa_upd_snooze', JSON.stringify({ v, at: Date.now() })); } catch (e2) {}
                c.remove();
            });
            document.body.appendChild(c);
        }
        function startUpdateWatch() {
            if (window.__updWatch) return; window.__updWatch = true;
            setTimeout(() => checkForUpdate(false), 4000);
            setInterval(() => { if (!document.hidden) checkForUpdate(false); }, 30 * 60e3);
            document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - __updLast > 10 * 60e3) checkForUpdate(false); });
        }
        // ล้างแคชแล้วโหลดใหม่: ลบ Cache Storage / Service Worker (ถ้ามี) แล้วดึงไฟล์หน้าเว็บ (HTML/JS/CSS) ใหม่จากเซิร์ฟเวอร์ก่อนโหลดหน้าใหม่
        // ไม่ลบการจดจำการเข้าสู่ระบบ / ธีม ที่เก็บไว้ในเครื่อง
        async function hardReloadPage() {
            showToast('กำลังล้างแคชและโหลดใหม่...', 'info');
            try { if (window.caches && caches.keys) { const ks = await caches.keys(); await Promise.all(ks.map(k => caches.delete(k))); } } catch (e) {}
            try { if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) { const regs = await navigator.serviceWorker.getRegistrations(); await Promise.all(regs.map(r => r.unregister())); } } catch (e) {}
            const urls = [location.href.split('#')[0]];
            document.querySelectorAll('script[src], link[rel="stylesheet"][href]').forEach(el => { const u = el.src || el.href; if (u && u.indexOf(location.origin) === 0) urls.push(u); });
            await Promise.all(urls.map(u => fetch(u, { cache: 'reload', credentials: 'same-origin' }).catch(() => {})));
            location.reload();
        }
        function renderSiteFooter() {
            const y = document.getElementById('footerYear'); if (y) y.textContent = new Date().getFullYear() + 543;
            const v = document.getElementById('footerVersion'); if (v) renderVersionButton(v);
            const l = document.getElementById('footerLinks'); if (l) {
                const links = [];
                links.push(`<a href="javascript:void(0)" onclick="window.navigate('privacy')" class="hover:text-indigo-500 underline underline-offset-2">นโยบายความเป็นส่วนตัว</a>`);
                if (SUPPORT_EMAIL) links.push(`<a href="mailto:${SUPPORT_EMAIL}" class="hover:text-indigo-500 underline underline-offset-2">แจ้งปัญหาการใช้งาน</a>`);
                l.innerHTML = links.join(' · '); l.classList.toggle('hidden', links.length === 0);
            }
        }
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderSiteFooter); else renderSiteFooter();

        // ===== หน้านโยบายความเป็นส่วนตัว (ตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562) =====
        function renderPrivacyPolicy() {
            const mc = document.getElementById('mainContent'); if (!mc) return;
            const th = 'p-2 sm:p-3 border border-slate-200 bg-slate-100 text-left font-extrabold text-slate-700';
            const td = 'p-2 sm:p-3 border border-slate-200 align-top text-slate-600';
            const h2 = (n, t) => `<h2 class="text-base sm:text-xl font-extrabold text-slate-800 mt-8 mb-3 flex items-center gap-2"><span class="w-7 h-7 sm:w-8 sm:h-8 rounded-full bg-indigo-600 text-white text-xs sm:text-sm flex items-center justify-center shrink-0">${n}</span>${t}</h2>`;
            const email = SUPPORT_EMAIL ? `<a href="mailto:${SUPPORT_EMAIL}" class="text-indigo-600 underline">${SUPPORT_EMAIL}</a>` : '[ อีเมลผู้ดูแลระบบ ]';
            const html = `<div class="max-w-3xl mx-auto bg-white rounded-[1.5rem] sm:rounded-[2rem] shadow-sm border border-slate-200 p-5 sm:p-10 text-sm sm:text-base leading-relaxed text-slate-600">
                <button onclick="history.length > 1 ? history.back() : window.navigate('dashboard')" class="mb-4 text-xs sm:text-sm font-bold text-indigo-600 hover:underline"><i class="fas fa-arrow-left"></i> กลับ</button>
                <h1 class="text-xl sm:text-3xl font-black text-slate-800 mb-1">นโยบายความเป็นส่วนตัว</h1>
                <p class="text-xs sm:text-sm text-slate-400 font-semibold">ระบบเช็คชื่อนักเรียนออนไลน์ · โรงเรียนบุ่งคล้านคร · ใช้บังคับตั้งแต่ 26 ตุลาคม 2569 (เวอร์ชันระบบ ${APP_VERSION})</p>

                ${h2(1, 'บทนำ')}
                <p>โรงเรียนบุ่งคล้านคร (โรงเรียนรัฐบาล) เป็น <b>ผู้ควบคุมข้อมูลส่วนบุคคล</b> ของระบบนี้ นโยบายนี้จัดทำตาม พ.ร.บ.คุ้มครองข้อมูลส่วนบุคคล พ.ศ. 2562 เพื่อแจ้งว่าระบบเก็บ ใช้ และเปิดเผยข้อมูลอะไร ใช้กับ <b>นักเรียน ครู เจ้าหน้าที่ และผู้ดูแลระบบ</b> ที่เกี่ยวข้องกับระบบเช็คชื่อนี้ ข้อมูลของนักเรียนเป็นข้อมูลของผู้เยาว์ โรงเรียนจึงเก็บและเปิดเผยเท่าที่จำเป็นเท่านั้น</p>

                ${h2(2, 'ข้อมูลที่เก็บ')}
                <div class="overflow-x-auto"><table class="w-full text-xs sm:text-sm border-collapse"><thead><tr><th class="${th}">ประเภท</th><th class="${th}">ตัวอย่างข้อมูล</th></tr></thead><tbody>
                <tr><td class="${td} font-bold">ข้อมูลนักเรียน (ผู้เยาว์)</td><td class="${td}">ชื่อ-นามสกุล เลขที่ ห้องเรียน สถานะการเป็นนักเรียน (ปกติ/ออก-ย้าย)</td></tr>
                <tr><td class="${td} font-bold">ข้อมูลการเช็คชื่อ</td><td class="${td}">วันที่ คาบเรียน วิชา และสถานะของนักเรียนแต่ละคน (มา สาย ลาป่วย ลากิจ ขาด โดดเรียน ร่วมกิจกรรม) รวมถึงรายการติดตามนักเรียนที่ขาดบ่อย</td></tr>
                <tr><td class="${td} font-bold">บันทึกกิจกรรมโฮมรูม</td><td class="${td}">จัดกิจกรรมหรือไม่ ชื่อกิจกรรม บันทึกสั้นๆ หรือเหตุผลที่ไม่ได้จัด และรูปกิจกรรมไม่เกิน 3 รูปต่อวัน (รูปอาจเห็นนักเรียนในห้อง) ที่ครูที่ปรึกษาบันทึก</td></tr>
                <tr><td class="${td} font-bold">ข้อมูลครูและเจ้าหน้าที่</td><td class="${td}">ชื่อ กลุ่มสาระ/ตำแหน่ง ชื่อผู้ใช้ และรหัสผ่าน (เก็บในรูปแบบเข้ารหัสทางเดียว ไม่สามารถอ่านกลับเป็นรหัสจริงได้)</td></tr>
                <tr><td class="${td} font-bold">บันทึกการใช้งาน (Log)</td><td class="${td}">วันเวลา ชื่อผู้ใช้ และการกระทำที่เจ้าหน้าที่ทำในระบบ เช่น เพิ่ม/แก้ไขข้อมูล</td></tr>
                <tr><td class="${td} font-bold">ข้อมูลสำรอง</td><td class="${td}">สำเนาของข้อมูลข้างต้นที่ระบบสำรองไว้อัตโนมัติเป็นรายวัน เพื่อกู้คืนกรณีข้อมูลเสียหาย</td></tr>
                </tbody></table></div>
                <p class="mt-3"><b>ระบบไม่เก็บ:</b> เลขบัตรประชาชน ที่อยู่ เบอร์โทรศัพท์ ข้อมูลผู้ปกครอง รูปถ่ายนักเรียนรายบุคคล (เก็บเฉพาะรูปกิจกรรมโฮมรูม) ข้อมูลสุขภาพ ข้อมูลทางการเงิน และตำแหน่งที่ตั้งของผู้ใช้ ระบบไม่ใช้คุกกี้เพื่อการโฆษณาหรือติดตามพฤติกรรม (เบราว์เซอร์อาจจำค่าการแสดงผล เช่น โหมดมืด ไว้ในเครื่องของผู้ใช้เอง)</p>

                ${h2(3, 'วัตถุประสงค์การใช้ข้อมูล')}
                <p>โรงเรียนใช้ข้อมูลเพื่อ <b>งานของโรงเรียนเท่านั้น</b> ได้แก่ การบันทึกและสรุปเวลาเรียน จัดทำรายงานและสมุดทะเบียนการเช็คชื่อ ติดตามและช่วยเหลือนักเรียนที่ขาดเรียนบ่อย และการรักษาความปลอดภัยและตรวจสอบการใช้งานระบบ โดยอาศัยฐานภารกิจเพื่อประโยชน์สาธารณะและการปฏิบัติหน้าที่ตามกฎหมายของสถานศึกษา <b>ไม่นำข้อมูลไปใช้เชิงการค้า</b> ไม่ขาย และไม่เปิดเผยให้บุคคลภายนอกเพื่อการตลาด</p>

                ${h2(4, 'ผู้ที่เข้าถึงข้อมูล')}
                <div class="overflow-x-auto"><table class="w-full text-xs sm:text-sm border-collapse"><thead><tr><th class="${th}">บทบาท</th><th class="${th}">สิ่งที่เห็นและทำได้</th></tr></thead><tbody>
                <tr><td class="${td} font-bold">ผู้เข้าชมทั่วไป</td><td class="${td}">เปิดดูรายชื่อห้องเรียนและสถานะการเช็คชื่อรายห้อง/รายวิชาได้โดยไม่ต้องเข้าสู่ระบบ</td></tr>
                <tr><td class="${td} font-bold">ครูผู้สอน / ครูที่ปรึกษา</td><td class="${td}">เช็คชื่อในวิชาที่ตนสอน ดูตารางสอนและสรุปของตนเอง ครูที่ปรึกษาดูรายงานของห้องที่ปรึกษา</td></tr>
                <tr><td class="${td} font-bold">เจ้าหน้าที่ / แอดมิน</td><td class="${td}">จัดการข้อมูลนักเรียน ครู วิชา รายงาน การติดตามนักเรียน และดูบันทึกการใช้งาน</td></tr>
                <tr><td class="${td} font-bold">Super Admin</td><td class="${td}">สิทธิ์ทั้งหมดของแอดมิน รวมถึงตั้งค่าระบบ จัดการบัญชีผู้ใช้ และสำรอง/กู้คืนข้อมูล</td></tr>
                <tr><td class="${td} font-bold">รูปกิจกรรมโฮมรูม</td><td class="${td}">เปิดดูในระบบได้เฉพาะแอดมิน/เจ้าหน้าที่ และแสดงในเล่มสรุปโฮมรูม ซึ่งผู้ใช้ระบบกดสร้างได้</td></tr>
                <tr><td class="${td} font-bold">ผู้พัฒนาระบบ</td><td class="${td}">เข้าถึงฐานข้อมูลในฐานะผู้ดูแลด้านเทคนิคเท่าที่จำเป็นต่อการดูแลและแก้ไขระบบ</td></tr>
                <tr><td class="${td} font-bold">ผู้ปกครอง</td><td class="${td}">ไม่มีบัญชีและไม่สามารถเข้าถึงข้อมูลในระบบโดยตรง หากต้องการทราบข้อมูลของบุตรหลาน ให้ติดต่อครูที่ปรึกษา</td></tr>
                </tbody></table></div>

                ${h2(5, 'การจัดเก็บและระยะเวลา')}
                <p>ข้อมูลเก็บบนบริการคลาวด์ของ <b>Cloudflare</b> (ฐานข้อมูล KV และ D1) ยกเว้นรูปกิจกรรมโฮมรูมซึ่งเก็บใน <b>Google Drive ของโรงเรียน</b> (Google Workspace) ส่วนหน้าเว็บให้บริการผ่าน GitHub Pages ผู้ให้บริการเหล่านี้อาจมีเซิร์ฟเวอร์อยู่นอกประเทศไทย โรงเรียนเลือกใช้บริการที่มีมาตรการรักษาความปลอดภัยตามมาตรฐานสากล</p>
                <div class="overflow-x-auto mt-3"><table class="w-full text-xs sm:text-sm border-collapse"><thead><tr><th class="${th}">ข้อมูล</th><th class="${th}">ระยะเวลาเก็บ</th></tr></thead><tbody>
                <tr><td class="${td} font-bold">ข้อมูลนักเรียนและการเช็คชื่อ</td><td class="${td}">เก็บไว้ <b>1 ปี</b> นับจากสิ้นสุดปีการศึกษานั้น แล้วลบออกจากระบบ</td></tr>
                <tr><td class="${td} font-bold">บันทึกและรูปกิจกรรมโฮมรูม</td><td class="${td}">เก็บไว้ <b>1 ปี</b> นับจากสิ้นสุดปีการศึกษานั้น แล้วลบออกจากระบบและ Google Drive</td></tr>
                <tr><td class="${td} font-bold">บัญชีครู/เจ้าหน้าที่</td><td class="${td}">ตลอดช่วงที่ปฏิบัติหน้าที่ และลบเมื่อพ้นหน้าที่</td></tr>
                <tr><td class="${td} font-bold">บันทึกการใช้งาน (Log)</td><td class="${td}">เก็บเฉพาะรายการล่าสุด ระบบลบรายการเก่าออกอัตโนมัติ</td></tr>
                <tr><td class="${td} font-bold">ข้อมูลสำรอง</td><td class="${td}">ตามอายุของข้อมูลต้นฉบับ ลบพร้อมกับข้อมูลที่หมดระยะเก็บ</td></tr>
                </tbody></table></div>

                ${h2(6, 'ลิขสิทธิ์')}
                <p><b>ตัวระบบ</b> (ซอฟต์แวร์ การออกแบบ และโค้ด) เป็นลิขสิทธิ์ของโรงเรียนบุ่งคล้านคร พัฒนาโดย Jeerasak Chomphuwattana โดยใช้ AI ช่วยพัฒนา (ระบบไม่ได้ใช้ AI ประมวลผลข้อมูลของผู้ใช้ขณะใช้งาน) ระบบนี้ไม่มีการอัปโหลดผลงานของผู้ใช้</p>

                ${h2(7, 'สิทธิของเจ้าของข้อมูล')}
                <p>เจ้าของข้อมูล (หรือผู้ปกครองในกรณีนักเรียนที่เป็นผู้เยาว์) มีสิทธิ <b>ขอเข้าถึงและขอสำเนา · แก้ไขให้ถูกต้อง · ลบหรือทำลาย · คัดค้านหรือระงับการใช้ · ขอรับ/โอนข้อมูล</b> ตามที่กฎหมายกำหนด โรงเรียนจะตอบกลับภายใน <b>30 วัน</b> นับจากได้รับคำขอ หากเห็นว่าโรงเรียนไม่ปฏิบัติตามกฎหมาย มีสิทธิร้องเรียนต่อ <b>สำนักงานคณะกรรมการคุ้มครองข้อมูลส่วนบุคคล (สคส.)</b></p>

                ${h2(8, 'การเปลี่ยนแปลงและช่องทางติดต่อ')}
                <p>โรงเรียนอาจปรับปรุงนโยบายนี้เป็นครั้งคราว โดยแจ้งการเปลี่ยนแปลงที่หน้านี้และปรับวันที่ใช้บังคับ</p>
                <div class="mt-3 bg-slate-50 border border-slate-200 rounded-xl p-4 text-xs sm:text-sm space-y-1">
                    <p><b>ผู้ควบคุมข้อมูล:</b> โรงเรียนบุ่งคล้านคร</p>
                    <p><b>ฝ่ายที่รับผิดชอบ:</b> [ ระบุฝ่าย/ชื่อผู้รับผิดชอบ ]</p>
                    <p><b>อีเมลติดต่อ:</b> ${email}</p>
                    <p><b>ผู้พัฒนาระบบ:</b> Jeerasak Chomphuwattana</p>
                </div>
            </div>`;
            mc.innerHTML = html;
            window.scrollTo({ top: 0 });
        }
        const EXTERNAL_LINK_MAX = 8;
        function __extEsc(t) { return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
        function __extSafeUrl(u) { u = String(u || '').trim(); return /^https?:\/\/[^\s]+$/i.test(u) ? u : ''; }
        function buildExternalLinksHtml() {
            const list = (Array.isArray(settings.externalLinks) ? settings.externalLinks : []).filter(x => x && x.img && __extSafeUrl(x.url));
            if (list.length === 0) return '';
            return `<div class="mb-6 sm:mb-8 mx-auto max-w-[1200px] flex flex-wrap justify-center gap-2">${list.map(x => `<a href="${__extEsc(__extSafeUrl(x.url))}" target="_blank" rel="noopener noreferrer" title="${__extEsc(x.title || '')}" aria-label="${__extEsc(x.title || 'ลิงก์เว็บภายนอก')}" class="block w-[calc(25%-6px)] sm:w-[calc(12.5%-7px)] rounded-xl sm:rounded-2xl overflow-hidden shadow-sm hover:shadow-md hover:-translate-y-0.5 active:scale-95 transition-all" style="aspect-ratio:320/120;"><img src="${x.img}" alt="${__extEsc(x.title || '')}" style="width:100%; height:100%; object-fit:cover; display:block;"></a>`).join('')}</div>`;
        }
        function buildExternalLinksSettingsHtml() {
            const list = Array.isArray(settings.externalLinks) ? settings.externalLinks : [];
            const rows = list.map((x, i) => `<div class="bg-white border border-slate-200 rounded-xl p-3 flex flex-col sm:flex-row gap-3 sm:items-center"><img src="${x.img}" class="rounded-lg border border-slate-200 shrink-0" style="width:160px; height:60px; object-fit:cover;"><div class="flex-1 grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0"><input type="text" id="extTitle_${i}" value="${__extEsc(x.title || '')}" placeholder="ชื่อกำกับ (ไม่บังคับ)" class="px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold outline-none focus:border-indigo-400"><input type="url" id="extUrl_${i}" value="${__extEsc(x.url || '')}" placeholder="https://..." class="px-3 py-2 rounded-lg border border-slate-200 text-sm outline-none focus:border-indigo-400"></div><div class="flex gap-1.5 shrink-0"><button onclick="window.moveExternalLink(${i}, -1)" ${i === 0 ? 'disabled' : ''} class="w-9 h-9 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 disabled:opacity-30" title="เลื่อนขึ้น"><i class="fas fa-arrow-up"></i></button><button onclick="window.moveExternalLink(${i}, 1)" ${i === list.length - 1 ? 'disabled' : ''} class="w-9 h-9 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 disabled:opacity-30" title="เลื่อนลง"><i class="fas fa-arrow-down"></i></button><button onclick="window.saveExternalLink(${i})" class="w-9 h-9 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white" title="บันทึกการแก้ไข"><i class="fas fa-save"></i></button><button onclick="window.deleteExternalLink(${i})" class="w-9 h-9 rounded-lg bg-rose-100 hover:bg-rose-200 text-rose-600" title="ลบปุ่มนี้"><i class="fas fa-trash"></i></button></div></div>`).join('');
            const full = list.length >= EXTERNAL_LINK_MAX;
            return `<h3 class="text-lg sm:text-xl font-extrabold text-slate-800 mb-1 border-t pt-4 sm:pt-6 flex items-center gap-2"><i class="fas fa-link text-indigo-500"></i> ปุ่มลิงก์เว็บภายนอก</h3><p class="text-xs sm:text-sm text-slate-500 mb-3">แสดงที่หน้าแรกให้ผู้ใช้ทุกคน เหนือการ์ดสถานะภาคเรียน กดแล้วเปิดในแท็บใหม่ (สูงสุด ${EXTERNAL_LINK_MAX} ปุ่ม · รูปจะถูกปรับเป็น 320×120 พิกเซลอัตโนมัติ)</p><div class="space-y-2 mb-3">${rows || '<div class="text-sm text-slate-400 italic bg-slate-50 rounded-xl p-4 text-center border border-dashed border-slate-200">ยังไม่มีปุ่มลิงก์</div>'}</div><div class="bg-slate-50 border border-slate-200 rounded-xl p-3 mb-6"><p class="text-xs font-extrabold text-slate-600 mb-2"><i class="fas fa-plus-circle text-indigo-500"></i> เพิ่มปุ่มใหม่</p><div class="grid grid-cols-1 sm:grid-cols-3 gap-2 mb-2"><input type="file" id="extNewImg" accept="image/*" ${full ? 'disabled' : ''} class="text-xs file:mr-2 file:py-2 file:px-3 file:rounded-lg file:border-0 file:bg-indigo-50 file:text-indigo-700 file:font-bold"><input type="text" id="extNewTitle" placeholder="ชื่อกำกับ (ไม่บังคับ)" ${full ? 'disabled' : ''} class="px-3 py-2 rounded-lg border border-slate-200 text-sm font-bold outline-none focus:border-indigo-400"><input type="url" id="extNewUrl" placeholder="https://..." ${full ? 'disabled' : ''} class="px-3 py-2 rounded-lg border border-slate-200 text-sm outline-none focus:border-indigo-400"></div><button onclick="window.addExternalLink()" ${full ? 'disabled' : ''} class="bg-indigo-600 hover:bg-indigo-700 disabled:bg-slate-300 text-white px-4 py-2 rounded-lg font-bold text-xs sm:text-sm"><i class="fas fa-plus"></i> เพิ่มปุ่ม</button>${full ? '<span class="text-xs text-rose-500 font-bold ml-2">ครบจำนวนสูงสุดแล้ว</span>' : ''}</div>`;
        }
        function __extGuard() { if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้", "error"); return false; } if (!Array.isArray(settings.externalLinks)) settings.externalLinks = []; return true; }
        function __extResizeImage(file) {
            return new Promise((resolve, reject) => {
                const reader = new FileReader();
                reader.onerror = () => reject(new Error('read'));
                reader.onload = (e) => {
                    const img = new Image();
                    img.onerror = () => reject(new Error('img'));
                    img.onload = () => {
                        const W = 320, H = 120; const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
                        const ctx = canvas.getContext('2d'); const scale = Math.max(W / img.width, H / img.height); const w = img.width * scale, h = img.height * scale;
                        ctx.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
                        let out = canvas.toDataURL('image/webp', 0.9); if (!out.startsWith('data:image/webp')) out = canvas.toDataURL('image/png'); // เก็บความโปร่งใสของมุมรูป ให้ปุ่มโค้งตามรูปจริง
                        resolve(out);
                    };
                    img.src = e.target.result;
                };
                reader.readAsDataURL(file);
            });
        }
        window.addExternalLink = async function() {
            if (!__extGuard()) return;
            if (settings.externalLinks.length >= EXTERNAL_LINK_MAX) { showToast(`เพิ่มได้สูงสุด ${EXTERNAL_LINK_MAX} ปุ่ม`, "error"); return; }
            const fileEl = document.getElementById('extNewImg'); const file = fileEl && fileEl.files && fileEl.files[0];
            const url = __extSafeUrl(document.getElementById('extNewUrl').value); const title = document.getElementById('extNewTitle').value.trim();
            if (!file || !file.type.startsWith('image/')) { showToast("กรุณาเลือกรูปภาพของปุ่ม", "error"); return; }
            if (!url) { showToast("กรุณาใส่ลิงก์ที่ขึ้นต้นด้วย https:// หรือ http://", "error"); return; }
            try {
                const img = await __extResizeImage(file);
                settings.externalLinks.push({ id: generateId(), title, url, img });
                logAction('เพิ่มปุ่มลิงก์เว็บภายนอก', title || url, 'settings'); saveData('full'); showToast("เพิ่มปุ่มเรียบร้อย"); renderAdminTab();
            } catch (err) { showToast("ไม่สามารถอ่านไฟล์รูปภาพนี้ได้", "error"); }
        };
        window.saveExternalLink = function(i) {
            if (!__extGuard()) return; const x = settings.externalLinks[i]; if (!x) return;
            const url = __extSafeUrl(document.getElementById('extUrl_' + i).value); if (!url) { showToast("ลิงก์ต้องขึ้นต้นด้วย https:// หรือ http://", "error"); return; }
            x.url = url; x.title = document.getElementById('extTitle_' + i).value.trim();
            logAction('แก้ไขปุ่มลิงก์เว็บภายนอก', x.title || url, 'settings'); saveData('full'); showToast("บันทึกการแก้ไขเรียบร้อย"); renderAdminTab();
        };
        window.moveExternalLink = function(i, dir) {
            if (!__extGuard()) return; const j = i + dir; if (j < 0 || j >= settings.externalLinks.length) return;
            const t = settings.externalLinks[i]; settings.externalLinks[i] = settings.externalLinks[j]; settings.externalLinks[j] = t;
            saveData('full'); renderAdminTab();
        };
        window.deleteExternalLink = function(i) {
            if (!__extGuard()) return; const x = settings.externalLinks[i]; if (!x) return;
            showConfirm("ลบปุ่มลิงก์", `ต้องการลบปุ่ม "${x.title || x.url}" ออกจากหน้าแรกหรือไม่?`, () => {
                settings.externalLinks.splice(i, 1); logAction('ลบปุ่มลิงก์เว็บภายนอก', x.title || x.url, 'settings'); saveData('full'); showToast("ลบปุ่มเรียบร้อย"); renderAdminTab();
            });
        };

        window.removeHeaderLogo = function() {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่แก้ไขส่วนนี้ได้", "error"); return; }
            settings.logoDataUrl = '';
            applyHeaderLogo();
            logAction('ลบโลโก้บนแถบหัวเว็บไซต์', '', 'settings');
            saveData('full');
            showToast("ลบโลโก้แล้ว กลับไปใช้ไอคอนเริ่มต้น");
            renderAdminTab();
        };
        
        function saveAdvisors() {
            if (!settings.advisors) settings.advisors = {};
            if (!settings.staffs) settings.staffs = {};
            const key = termKeyOf(adminTerm(), adminYear());
            if (!settings.advisors[key]) settings.advisors[key] = {};
            if (!settings.staffs[key]) settings.staffs[key] = {};
            getRoomList().forEach(roomId => {
                settings.advisors[key][roomId] = [ document.getElementById(`adv1_${roomId}`).value.trim(), document.getElementById(`adv2_${roomId}`).value.trim() ];
                settings.staffs[key][roomId] = document.getElementById(`staff_${roomId}`).value;
            });
            logAction('แก้ไขครูที่ปรึกษา/เจ้าหน้าที่ประจำห้อง', `ภาคเรียน ${adminTerm()}/${adminYear()}`, 'settings');
            getRoomList().forEach(r => ensureSystemSubjectsForRoom(r, adminTerm(), adminYear())); // [v1.74.6] ปรับครูในคาบระบบตามครูที่ปรึกษาใหม่ (บันทึกไปพร้อมกัน)
            saveData('full'); showToast("บันทึกบุคลากรประจำห้องเรียบร้อย"); renderAdminTab();
        }

        window.openTeacherModal = function() {
            editingTeacherId = null;
            document.getElementById('teacherModalTitle').innerText = 'เพิ่มครูใหม่';
            document.getElementById('newTcName').value = ''; document.getElementById('newTcDept').value = departmentsList[0]; tcSetType(false);
            document.getElementById('teacherModal').classList.remove('hidden');
            setTimeout(() => { document.getElementById('teacherModalBox').classList.remove('scale-95', 'opacity-0'); document.getElementById('teacherModalBox').classList.add('scale-100', 'opacity-100'); }, 10);
        };
        window.closeTeacherModal = function() {
            document.getElementById('teacherModalBox').classList.remove('scale-100', 'opacity-100'); document.getElementById('teacherModalBox').classList.add('scale-95', 'opacity-0');
            setTimeout(() => { document.getElementById('teacherModal').classList.add('hidden'); }, 300);
        };
        window.prepareEditTeacher = function(id) {
            editingTeacherId = id;
            const t = teachers.find(x => x.id === id); if(!t) return;
            document.getElementById('teacherModalTitle').innerText = 'แก้ไขข้อมูลครู';
            document.getElementById('newTcName').value = t.name; document.getElementById('newTcDept').value = t.department || 'ระบบ/อื่นๆ'; tcSetType(!!t.foreign);
            document.getElementById('teacherModal').classList.remove('hidden');
            setTimeout(() => { document.getElementById('teacherModalBox').classList.remove('scale-95', 'opacity-0'); document.getElementById('teacherModalBox').classList.add('scale-100', 'opacity-100'); }, 10);
        };
        window.saveTeacherForm = function() {
            const name = document.getElementById('newTcName').value.trim();
            const dept = document.getElementById('newTcDept').value;
            const isForeign = !!(document.querySelector('input[name="newTcType"]:checked') || {}).value && document.querySelector('input[name="newTcType"]:checked').value === 'foreign';
            if (!name) { showToast("กรุณากรอกชื่อครู", "error"); return;
            }
            let logMsg = '';
            if (editingTeacherId) {
                const t = teachers.find(x => x.id === editingTeacherId);
                if (t) {
                    const oldName = t.name;
                    if (teachers.find(x => x.name === name && x.id !== editingTeacherId)) { showToast("มีชื่อนี้แล้ว", "error"); return;
                    }
                    t.name = name;
                    t.department = dept;
                    if (isForeign) t.foreign = true; else delete t.foreign; // [v2.01.0] ประเภทครู
                    if (oldName !== name) { subjects.forEach(s => { if (s.teacher === oldName) s.teacher = name; if (s.teacher2 === oldName) s.teacher2 = name; });
                    }
                    logMsg = `แก้ไขข้อมูลครู: ${oldName} -> ${name}`;
                }
            } else {
                if (teachers.find(x => x.name === name)) { showToast("มีชื่อนี้แล้ว", "error");
                return; }
                teachers.push(Object.assign({ id: generateId(), name, department: dept }, isForeign ? { foreign: true } : {}));
                logMsg = `เพิ่มครูใหม่: ${name}`;
            }
            logAction('จัดการข้อมูลครู', logMsg);
            saveData('full'); showToast("บันทึกข้อมูลครูสำเร็จ"); renderAdminTab(); closeTeacherModal();
        };
        // ===== [v1.71.2] ครูย้ายออก / ไม่ใช้งาน: ไม่โผล่ในรายการเลือกครูของภาคเรียนใหม่ แต่ประวัติภาคเรียนเก่ายังครบ =====
        window.toggleTeacherActive = function(id) {
            const t = teachers.find(x => x.id === id); if (!t) return;
            if (!t.inactive) {
                showConfirm("ย้ายออก / ไม่ใช้งาน", `ตั้ง "${t.name}" เป็นครูที่ย้ายออก?\n\nจะไม่แสดงในรายการเลือกครูของภาคเรียนใหม่ แต่ข้อมูลและรายงานภาคเรียนเก่ายังอยู่ครบ (กดกลับมาใช้งานได้ภายหลัง)`, () => {
                    t.inactive = true; t.inactiveAt = new Date().toISOString(); t.inactiveTerm = `${adminTerm()}/${adminYear()}`;
                    logAction('ตั้งครูเป็นย้ายออก/ไม่ใช้งาน', t.name); saveData('full'); showToast('ตั้งเป็นย้ายออกเรียบร้อย'); renderAdminTab();
                }, 'ยืนยัน');
            } else {
                delete t.inactive; delete t.inactiveAt; delete t.inactiveTerm;
                logAction('ตั้งครูกลับมาใช้งาน', t.name); saveData('full'); showToast('กลับมาใช้งานเรียบร้อย'); renderAdminTab();
            }
        };
        function deleteTeacher(id, subjectCount) { if (subjectCount > 0) { showToast("ไม่สามารถลบได้ มีวิชาที่สอนอยู่", "error"); return;
        } const t = teachers.find(x => x.id === id); showConfirm("ลบ", "แน่ใจหรือไม่ที่จะลบครูท่านนี้?", () => { teachers = teachers.filter(x => x.id !== id); logAction('ลบข้อมูลครู', t ? t.name : id); saveData('full'); showToast("ลบเรียบร้อย"); renderAdminTab(); });
        }
        
        window.resetAllAttendanceData = function() { showConfirm("ยืนยันล้างข้อมูลทั้งหมด", "คำเตือน: ข้อมูลการเช็คชื่อของนักเรียนทุกคนและวิชาทั้งหมดของภาคเรียนนี้จะถูกลบอย่างถาวรและไม่สามารถกู้คืนได้ รวมถึงบันทึกโฮมรูม/เขตพื้นที่ ส่วนโฟลเดอร์รูปของภาคเรียนนี้จะถูกย้ายลงถังขยะของ Google Drive (กู้คืนได้ภายใน 30 วัน) คุณแน่ใจหรือไม่?", async () => { const __rTerm = adminTerm(), __rYear = adminYear(); showToast("กำลังล้างข้อมูล... (อัปเดตแบบเรียลไทม์)", "info"); document.body.style.pointerEvents = 'none'; logAction('ล้างข้อมูลการเช็คชื่อทั้งหมด', 'รีเซ็ตข้อมูลการเช็คชื่อ/ติดตามทั้งระบบ'); await saveData('reset_all'); const __trFail = await hrTrashTermFolders(__rTerm, __rYear); document.body.style.pointerEvents = 'auto'; if (__trFail) showConfirm("ล้างข้อมูลแล้ว แต่ย้ายรูปไม่สำเร็จ", `ล้างข้อมูลเช็คชื่อเรียบร้อยแล้ว แต่ย้ายโฟลเดอร์รูปลงถังขยะไม่สำเร็จ ${__trFail} โฟลเดอร์ — ตรวจสอบว่า Apps Script รูปโฮมรูม (HomeroomPhotoRelay) ยังใช้งานได้ หรือลบโฟลเดอร์ใน Google Drive เอง`, () => {}, 'ตกลง', true); else showToast("ล้างข้อมูลทั้งหมดเรียบร้อยแล้ว", "success"); renderAdminTab(); });
        };

        // ===== เก็บถาวรข้อมูลเช็คชื่อเก่า: ส่งออก Excel แล้วลบออกจากข้อมูลที่ใช้งานจริง (ลดขนาดไฟล์ระยะยาว) =====
        window.updateArchivePreview = function() {
            const cutoff = document.getElementById('archiveCutoffDate').value;
            const textEl = document.getElementById('archivePreviewText');
            if (!cutoff) { textEl.innerText = 'เลือกวันที่เพื่อดูจำนวนข้อมูลที่จะถูกเก็บถาวร'; return; }
            const matching = attendanceData.filter(a => a.date && a.date < cutoff);
            if (matching.length === 0) { textEl.innerText = `ไม่พบข้อมูลก่อนวันที่ ${cutoff.split('-').reverse().join('/')}`; return; }
            textEl.innerHTML = `พบข้อมูล <b>${matching.length}</b> รายการเช็คชื่อ (${matching.length} คาบ) ก่อนวันที่ ${cutoff.split('-').reverse().join('/')} ที่จะถูกเก็บถาวร`;
        };
        // สร้างแถวข้อมูล Excel จากอาร์เรย์ของ attendance record (ใช้ร่วมกันทั้งตอนเก็บถาวรและตอนดูข้อมูลเก่า)
        function buildAttendanceExcelRows(records) {
            const rows = [["วันที่", "คาบ", "รหัสวิชา", "ชื่อวิชา", "ห้อง", "เลขที่", "ชื่อ-นามสกุล", "สถานะ"]];
            records.forEach(a => {
                const sub = subjects.find(s => s.id === a.subjectId);
                const roomName = sub ? formatRoomName(sub.roomId) : '-';
                const dateDisp = (a.date || '').split('-').reverse().join('/');
                Object.keys(a.records || {}).forEach(stId => {
                    const st = students.find(s => s.id === stId);
                    rows.push([dateDisp, periodLabel(a.period), sub ? (sub.code || '') : '', sub ? sub.name : '(วิชาถูกลบแล้ว)', roomName, st ? st.number : '-', st ? st.name : '(ไม่พบข้อมูลนักเรียน)', a.records[stId]]);
                });
            });
            return rows;
        }
        function downloadAttendanceExcel(records, filename) {
            const rows = buildAttendanceExcelRows(records);
            const ws = XLSX.utils.aoa_to_sheet(rows); ws['!cols'] = [{wch:10},{wch:6},{wch:10},{wch:22},{wch:10},{wch:8},{wch:28},{wch:14}];
            const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Archive");
            XLSX.writeFile(wb, filename);
        }
        // บันทึกข้อมูลที่เก็บถาวรแบบแมนวล (เก็บด่วน/จัดเก็บรายปี) ไว้บนเซิร์ฟเวอร์ด้วย ไม่ใช่แค่ดาวน์โหลดไฟล์ลงเครื่อง
        // เพื่อให้กู้คืน/ดูย้อนหลังได้จากส่วน "ดูข้อมูลเช็คชื่อที่เก็บถาวรแล้ว" เหมือนกับข้อมูลที่ถูกเก็บถาวรอัตโนมัติทุก 2 ปี
        // (ต้องมีโค้ดฝั่ง Apps Script รองรับ __mode: 'save_manual_archive' - ดูรายละเอียดที่ให้ไว้แยกต่างหาก)
        async function saveManualArchiveToServer(records, filenamePrefix) {
            if (!records || records.length === 0) return true;
            try {
                const res = await fetch(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'save_manual_archive', filenamePrefix, records }) });
                if (!res.ok) return false;
                const j = await res.json().catch(() => null);
                return !j || j.status !== 'error';
            } catch (e) { return false; }
        }

        window.archiveOldAttendance = function() {
            const cutoff = document.getElementById('archiveCutoffDate').value;
            if (!cutoff) { showToast("กรุณาเลือกวันที่ก่อน", "error"); return; }
            const toArchive = attendanceData.filter(a => a.date && a.date < cutoff);
            if (toArchive.length === 0) { showToast("ไม่พบข้อมูลก่อนวันที่ที่เลือก", "error"); return; }
            showConfirm("ยืนยันการเก็บถาวร", `จะเก็บถาวรข้อมูลเช็คชื่อ ${toArchive.length} รายการ (ก่อนวันที่ ${cutoff.split('-').reverse().join('/')}) ไว้บนเซิร์ฟเวอร์ พร้อมดาวน์โหลดไฟล์ Excel สำรอง แล้วลบออกจากระบบที่ใช้งานอยู่ทันที คุณแน่ใจหรือไม่?`, async () => {
                showToast("กำลังเก็บถาวร...", "info");
                const ok = await saveManualArchiveToServer(toArchive, `attendance_archive_manual_${cutoff}`);
                if (!ok) { showToast("เก็บถาวรไปยังเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง (ยังไม่มีการลบข้อมูลออก)", "error"); return; }
                downloadAttendanceExcel(toArchive, `เก็บถาวรข้อมูลเช็คชื่อ_ก่อน_${cutoff}.xlsx`);
                attendanceData = attendanceData.filter(a => !(a.date && a.date < cutoff));
                logAction('เก็บถาวรข้อมูลเช็คชื่อเก่า', `เก็บถาวร ${toArchive.length} รายการ (ก่อนวันที่ ${cutoff})`);
                await saveData('full');
                showToast(`เก็บถาวร ${toArchive.length} รายการสำเร็จ (บันทึกบนเซิร์ฟเวอร์ + ดาวน์โหลดไฟล์แล้ว)`, "success");
                renderAdminTab();
            });
        };

        // ===== ดูข้อมูลเช็คชื่อที่เก็บถาวรแล้ว (ดึงรายชื่อไฟล์ archive จาก Google Drive ผ่าน backend) =====
        window.loadArchiveList = async function() {
            const listEl = document.getElementById('archiveListContainer');
            if (!listEl) return;
            listEl.innerHTML = `<div class="text-center text-purple-400 py-6 text-xs sm:text-sm font-bold"><i class="fas fa-spinner fa-spin"></i> กำลังโหลดรายชื่อไฟล์เก็บถาวร...</div>`;
            try {
                const res = await fetch(`${GOOGLE_APP_SCRIPT_URL}?action=list_archives`);
                const data = await res.json();
                if (data.status !== 'success' || !data.archives || data.archives.length === 0) {
                    listEl.innerHTML = `<div class="text-center text-slate-400 py-6 text-xs sm:text-sm font-medium">ยังไม่มีไฟล์เก็บถาวรในระบบ</div>`;
                    return;
                }
                const fmtSize = (b) => b < 1024 ? `${b} B` : (b < 1024*1024 ? `${(b/1024).toFixed(1)} KB` : `${(b/1024/1024).toFixed(2)} MB`);
                listEl.innerHTML = data.archives.map(f => {
                    const d = new Date(f.dateCreated);
                    const dateStr = isNaN(d) ? '' : d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric' });
                    return `<div class="flex items-center justify-between gap-2 bg-white border border-purple-200 rounded-lg px-3 py-2.5"><div class="min-w-0"><div class="font-bold text-slate-700 text-xs sm:text-sm truncate">${f.name}</div><div class="text-[10px] sm:text-xs text-slate-400 font-medium">สร้างเมื่อ ${dateStr} · ${fmtSize(f.sizeBytes)}</div></div><button onclick="window.downloadArchiveFile('${f.name}')" class="shrink-0 bg-purple-600 hover:bg-purple-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-file-excel"></i> Excel</button></div>`;
                }).join('<div class="h-1.5"></div>');
            } catch (err) {
                listEl.innerHTML = `<div class="text-center text-rose-400 py-6 text-xs sm:text-sm font-bold"><i class="fas fa-exclamation-circle"></i> โหลดรายชื่อไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง</div>`;
            }
        };
        window.downloadArchiveFile = async function(fileName) {
            showToast("กำลังดึงข้อมูลเก็บถาวร กรุณารอสักครู่...", "success");
            try {
                const res = await fetch(`${GOOGLE_APP_SCRIPT_URL}?action=get_archive&file=${encodeURIComponent(fileName)}`);
                const records = await res.json();
                if (!Array.isArray(records)) { showToast("รูปแบบข้อมูลไม่ถูกต้อง", "error"); return; }
                if (records.length === 0) { showToast("ไฟล์นี้ไม่มีข้อมูล", "error"); return; }
                downloadAttendanceExcel(records, `${fileName.replace('.json', '')}.xlsx`);
                showToast("ดาวน์โหลดไฟล์ Excel สำเร็จ", "success");
            } catch (err) { showToast("ดึงข้อมูลไม่สำเร็จ ลองใหม่อีกครั้ง", "error"); }
        };

        // ===== กู้คืนฐานข้อมูลจาก Snapshot (สำรองอัตโนมัติรายสัปดาห์) - เฉพาะ Super Admin =====
        window.loadSnapshotList = async function() {
            const listEl = document.getElementById('snapshotListContainer');
            if (!listEl) return;
            listEl.innerHTML = `<div class="text-center text-rose-400 py-6 text-xs sm:text-sm font-bold"><i class="fas fa-spinner fa-spin"></i> กำลังโหลดรายชื่อไฟล์สำรอง...</div>`;
            try {
                const res = await fetch(`${GOOGLE_APP_SCRIPT_URL}?action=list_snapshots`);
                const data = await res.json();
                if (data.status !== 'success' || !data.snapshots || data.snapshots.length === 0) {
                    listEl.innerHTML = `<div class="text-center text-slate-400 py-6 text-xs sm:text-sm font-medium">ยังไม่พบไฟล์สำรอง Snapshot ในระบบ (อาจยังไม่เคยตั้งเวลาให้รันอัตโนมัติ หรือยังไม่ถึงรอบแรก)</div>`;
                    return;
                }
                const fmtSize = (b) => b < 1024 ? `${b} B` : (b < 1024*1024 ? `${(b/1024).toFixed(1)} KB` : `${(b/1024/1024).toFixed(2)} MB`);
                const mains = data.snapshots.filter(f => !f.type || f.type === 'main'); // [v2.00.7] เฉพาะไฟล์สำรองข้อมูลหลัก (การเช็คชื่อรายห้องกู้คืนที่ห้องนั้น)
                if (!mains.length) { listEl.innerHTML = `<div class="text-center text-slate-400 py-6 text-xs sm:text-sm font-medium">ยังไม่พบไฟล์สำรองข้อมูลหลัก — กด "สำรองตอนนี้" เพื่อสร้าง</div>`; return; }
                const kindOf = (n) => /^ก่อนนำเข้ารายชื่อ/.test(n) ? ['ก่อนนำเข้ารายชื่อ', 'bg-indigo-100 text-indigo-700'] : /^สำรองเอง/.test(n) ? ['สำรองเอง', 'bg-emerald-100 text-emerald-700'] : /^ก่อนกู้คืน/.test(n) ? ['ก่อนกู้คืน', 'bg-amber-100 text-amber-700'] : ['อัตโนมัติ', 'bg-slate-100 text-slate-600'];
                listEl.innerHTML = mains.map(f => {
                    const d = new Date(f.dateCreated);
                    const dateStr = isNaN(d) ? '' : d.toLocaleDateString('th-TH', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
                    const k = kindOf(f.name), who = (/^(?:ก่อนนำเข้ารายชื่อนักเรียน|สำรองเอง)_(.+)_\d{4}-\d{2}-\d{2}T/.exec(f.name) || [])[1] || '';
                    return `<div class="flex flex-wrap items-center justify-between gap-2 bg-white border ${f.corrupted ? 'border-rose-400' : 'border-rose-200'} rounded-lg px-3 py-2.5"><div class="min-w-0"><div class="font-bold text-slate-700 text-xs sm:text-sm flex flex-wrap items-center gap-1.5"><span class="${k[1]} px-2 py-0.5 rounded-full text-[10px] font-black">${k[0]}</span> ${dateStr}${who ? ` <span class="text-slate-400 font-medium">· ${hrEsc(who)}</span>` : ''}${f.corrupted ? ' <span class="text-rose-500 text-[9px] font-black">(ไฟล์นี้ข้อมูลเสีย ห้ามกู้คืน)</span>' : ''}</div><div class="text-[10px] sm:text-xs text-slate-400 font-medium">${fmtSize(f.sizeBytes)}</div></div>${f.corrupted ? '' : `<div class="flex flex-wrap gap-1.5 shrink-0"><button onclick="window.restoreSnapshotStudents('${f.id}', '${dateStr}')" class="bg-amber-500 hover:bg-amber-600 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-user-graduate"></i> กู้คืนเฉพาะรายชื่อนักเรียน</button><button onclick="window.restoreSnapshot('${f.id}')" class="bg-rose-600 hover:bg-rose-700 text-white px-3 py-1.5 rounded-lg font-bold text-[10px] sm:text-xs shadow-sm transition-colors flex items-center gap-1.5"><i class="fas fa-undo"></i> กู้คืนทั้งหมด</button></div>`}</div>`;
                }).join('<div class="h-1.5"></div>');
            } catch (err) {
                listEl.innerHTML = `<div class="text-center text-rose-400 py-6 text-xs sm:text-sm font-bold"><i class="fas fa-exclamation-circle"></i> โหลดรายชื่อไฟล์ไม่สำเร็จ ลองใหม่อีกครั้ง</div>`;
            }
        };
        // [v2.00.7] สำรองข้อมูลหลักตอนนี้ · กู้คืนเฉพาะรายชื่อนักเรียน
        async function snapshotNowReq(reason) {
            const res = await fetch(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'snapshot_now', reason }) });
            const j = await res.json().catch(() => null);
            if (!res.ok || !j || j.status !== 'success') throw new Error((j && j.message) || 'สำรองข้อมูลไม่สำเร็จ');
            return j.id;
        }
        window.snapshotNow = async function() {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้น", "error"); return; }
            showLoadingSpinnerModal('กำลังสำรองข้อมูล', 'กรุณารอสักครู่...');
            try { await snapshotNowReq('manual'); closeProgressModal(); showToast('สำรองข้อมูลเรียบร้อย', 'success'); window.loadSnapshotList(); }
            catch (e) { errorProgressModal(e.message || 'สำรองข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'); }
        };
        window.restoreSnapshotStudents = function(id, dateStr) {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่กู้คืนข้อมูลได้", "error"); return; }
            showConfirm("กู้คืนเฉพาะรายชื่อนักเรียน", `จะเปลี่ยนรายชื่อนักเรียนทั้งหมดกลับเป็นรายชื่อ ณ ${dateStr || 'เวลาที่สำรอง'} — ห้อง วิชา ครู ตั้งค่า และการเช็คชื่อไม่เปลี่ยน · นักเรียนที่เพิ่ม/แก้หลังเวลานั้นจะหายไป (ระบบสำรองรายชื่อปัจจุบันไว้ให้ก่อนกู้คืน)`, async () => {
                showProgressModal("กำลังกู้คืนรายชื่อนักเรียน", "กรุณารอสักครู่ ห้ามปิดหน้านี้...");
                try {
                    updateProgressModal(40, "กำลังกู้คืน...");
                    const res = await fetch(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'restore_snapshot_students', id }) });
                    const r = await res.json().catch(() => null);
                    if (!res.ok || !r || r.status !== 'success') { errorProgressModal(r && r.message ? r.message : 'กู้คืนไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'); return; }
                    logAction('กู้คืนรายชื่อนักเรียนจากไฟล์สำรอง', `${dateStr || id} (${r.students} คน)`);
                    completeProgressModal("กู้คืนสำเร็จ", `กู้คืนรายชื่อนักเรียน ${r.students} คน · ระบบจะโหลดหน้าเว็บใหม่`);
                    setTimeout(() => { location.reload(); }, 1500);
                } catch (e) { errorProgressModal("เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"); }
            }, 'กู้คืนรายชื่อ');
        };
        window.restoreSnapshot = function(fileName) {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่กู้คืนข้อมูลได้", "error"); return; }
            showConfirm("ยืนยันการกู้คืนข้อมูล", `จะเขียนทับข้อมูลปัจจุบันทั้งหมด (ห้อง/วิชา/นักเรียน/การเช็คชื่อ) ด้วยไฟล์สำรอง "${fileName}" การกระทำนี้ไม่สามารถยกเลิกได้ทันที (แต่ระบบจะสำรองสถานะปัจจุบันไว้ก่อนกู้คืนให้อัตโนมัติ) แน่ใจหรือไม่?`, async () => {
                showProgressModal("กำลังกู้คืนข้อมูล", "กรุณารอสักครู่ ห้ามปิดหน้านี้...");
                try {
                    updateProgressModal(30, "กำลังส่งคำขอกู้คืนไปยังเซิร์ฟเวอร์...");
                    const res = await fetch(GOOGLE_APP_SCRIPT_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ __mode: 'restore_snapshot', file: fileName }) });
                    const result = await res.json().catch(() => null);
                    if (!res.ok || !result || result.status === 'error') {
                        errorProgressModal(result && result.message ? result.message : "กู้คืนข้อมูลไม่สำเร็จ กรุณาลองใหม่อีกครั้ง");
                        return;
                    }
                    updateProgressModal(100, "กู้คืนสำเร็จ กำลังโหลดหน้าเว็บใหม่...");
                    completeProgressModal("กู้คืนข้อมูลสำเร็จ", "ระบบจะโหลดหน้าเว็บใหม่เพื่อดึงข้อมูลที่กู้คืนแล้ว");
                    setTimeout(() => { location.reload(); }, 1500);
                } catch (err) { errorProgressModal("เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาลองใหม่อีกครั้ง"); }
            });
        };

        window.scheduleDayColorMap = { 1: 'border-yellow-400', 2: 'border-pink-400', 3: 'border-green-500', 4: 'border-orange-400', 5: 'border-sky-400' };
        window.__scheduleGridDayBg = { 1: { bg: 'bg-yellow-50', text: 'text-yellow-800' }, 2: { bg: 'bg-pink-50', text: 'text-pink-800' }, 3: { bg: 'bg-green-50', text: 'text-green-800' }, 4: { bg: 'bg-orange-50', text: 'text-orange-800' }, 5: { bg: 'bg-sky-50', text: 'text-sky-800' } };
        window.renderScheduleInputs = function(existingSchedules = null) {
            const credit = parseFloat(document.getElementById('newSubCredit').value) || 0.5; const count = credit * 2;
            if (existingSchedules) window.__scheduleSelection = existingSchedules.slice(0, count).map(s => ({ day: parseInt(s.day), period: parseInt(s.period) }));
            else if (!Array.isArray(window.__scheduleSelection)) window.__scheduleSelection = [];
            else window.__scheduleSelection = window.__scheduleSelection.slice(0, count); // ตัดส่วนเกินถ้าลดหน่วยกิตลง
            window.renderScheduleGrid(count);
        };
        // ===== ตารางคลิกเลือกคาบสอน (แทนดรอปดาวน์) - คลิกช่องเพื่อเลือก/ยกเลิก เตือนทันทีถ้าชนกับวิชาอื่นในห้องเดียวกัน =====
        window.renderScheduleGrid = function(count) {
            const roomId = document.getElementById('newSubRoom') ? document.getElementById('newSubRoom').value : null;
            const otherSubs = roomId ? getRoomSubjects(roomId, adminTerm(), adminYear()).filter(s => s.id !== editingSubjectId && !s.systemType) : [];
            const systemSubsForGrid = roomId ? getRoomSubjects(roomId, adminTerm(), adminYear()).filter(s => s.systemType && s.id !== editingSubjectId) : [];
            const gridPeriods = timeSlots.filter(t => t.period >= 0 || t.period === -2);
            let html = `<div class="col-span-full"><div class="flex items-center justify-between mb-2"><span class="text-[10px] sm:text-xs font-bold text-slate-600">คลิกช่องเพื่อเลือกคาบสอน <span class="text-indigo-600">(เลือกแล้ว ${window.__scheduleSelection.length}/${count})</span></span>${window.__scheduleSelection.length > 0 ? `<button type="button" onclick="window.clearScheduleSelection()" class="text-[10px] sm:text-xs font-bold text-rose-500 hover:underline"><i class="fas fa-eraser"></i> ล้างทั้งหมด</button>` : ''}</div><div class="overflow-x-auto rounded-xl border border-slate-200"><table class="w-full text-center text-[9px] sm:text-[11px] border-collapse min-w-[600px]"><thead><tr class="bg-slate-100"><th class="p-1.5 border border-slate-200 sticky left-0 bg-slate-100 z-10">วัน\\คาบ</th>${gridPeriods.map(p => `<th class="p-1.5 border border-slate-200 font-bold">${periodLabel(p.period)}${p.period === -2 ? '<div class="font-normal text-slate-400 text-[8px]">(เขตฯ)</div>' : ''}${p.period === 0 ? '<div class="font-normal text-slate-400 text-[8px]">(แถว)</div>' : ''}</th>${p.period === 4 ? `<th class="p-1 border border-amber-200 bg-amber-50 text-amber-500 w-5" title="พักกลางวัน"><i class="fas fa-utensils"></i></th>` : ''}`).join('')}</tr></thead><tbody>`;
            for (let d = 1; d <= 5; d++) {
                const dc = window.__scheduleGridDayBg[d];
                html += `<tr><td class="p-1.5 border border-slate-200 font-bold ${dc.bg} ${dc.text} sticky left-0 z-10">${daysLabel[d-1].replace('วัน','')}</td>`;
                gridPeriods.forEach(p => {
                    const idx = window.__scheduleSelection.findIndex(s => s.day === d && s.period === p.period);
                    const isSelected = idx > -1;
                    const clash = otherSubs.find(s => (s.schedules || []).some(os => os.day === d && os.period === p.period));
                    const sysAtCell = systemSubsForGrid.find(ss => (ss.schedules || []).some(os => os.day === d && os.period === p.period)); const isHomeroom = !!sysAtCell;
                    let cellClass, content, titleAttr = '';
                    if (isSelected) { cellClass = 'bg-indigo-500 text-white'; content = `<span class="font-black">${idx + 1}</span>`; if (isHomeroom) titleAttr = `title="ลงทับคาบ${sysAtCell.name} - คาบนี้จะแสดงเป็นวิชานี้แทน"`; }
                    else if (clash) { cellClass = 'bg-rose-100 text-rose-500 hover:bg-rose-200'; content = `<i class="fas fa-exclamation-triangle text-[8px]"></i>`; titleAttr = `title="ชนกับวิชา: ${clash.name}"`; }
                    else if (isHomeroom) { cellClass = 'bg-orange-100 text-orange-500 hover:bg-orange-200'; content = `<i class="fas fa-user-friends text-[8px]"></i>`; titleAttr = `title="คาบ${sysAtCell.name} - ลงวิชาทับคาบนี้ได้ (จะสอนวิชานี้แทน)"`; }
                    else { cellClass = 'bg-white hover:bg-indigo-50'; content = ''; }
                    html += `<td class="p-1.5 border border-slate-200 ${cellClass} cursor-pointer transition-colors" onclick="window.toggleScheduleCell(${d}, ${p.period}, ${count})" ${titleAttr}>${content}</td>`;
                    if (p.period === 4) html += `<td class="p-1 border border-amber-100 bg-amber-50/50 text-amber-300"><i class="fas fa-utensils text-[7px]"></i></td>`;
                });
                html += `</tr>`;
            }
            html += `</tbody></table></div><p class="text-[9px] sm:text-[10px] font-medium mt-1.5 space-x-3"><span class="text-rose-400"><i class="fas fa-exclamation-triangle"></i> สีแดงอ่อน = ชนกับวิชาอื่น</span><span class="text-orange-400"><i class="fas fa-user-friends"></i> สีส้ม = ตรงกับคาบโฮมรูม (ลงซ้อนได้)</span></p>`;
            for (let i = 0; i < count; i++) { const s = window.__scheduleSelection[i]; html += `<input type="hidden" id="newSubDay_${i}" value="${s ? s.day : ''}"><input type="hidden" id="newSubPeriod_${i}" value="${s ? s.period : ''}">`; }
            html += `</div>`;
            document.getElementById('scheduleContainer').innerHTML = html;
        };
        window.toggleScheduleCell = function(day, period, count) {
            const idx = window.__scheduleSelection.findIndex(s => s.day === day && s.period === period);
            if (idx > -1) { window.__scheduleSelection.splice(idx, 1); }
            else {
                if (window.__scheduleSelection.length >= count) { showToast(`เลือกได้สูงสุด ${count} คาบ ตามหน่วยกิตที่ตั้งไว้ (ถ้าต้องการคาบนี้ ให้ยกเลิกคาบอื่นก่อน)`, "error"); return; }
                window.__scheduleSelection.push({ day, period });
            }
            window.renderScheduleGrid(count);
        };
        window.clearScheduleSelection = function() {
            const count = (parseFloat(document.getElementById('newSubCredit').value) || 0.5) * 2;
            window.__scheduleSelection = [];
            window.renderScheduleGrid(count);
        };

        window.openSubjectModal = function(prefillDay, prefillPeriod) { if (guardTermLock('เพิ่มวิชาใหม่')) return; editingSubjectId = null; document.getElementById('subjectModalTitle').innerText = 'เพิ่มวิชาใหม่';
        const __defSubRoom = (window.adminSelectedSubjectRoom && window.adminSelectedSubjectRoom !== 'all' && getRoomList().includes(window.adminSelectedSubjectRoom)) ? window.adminSelectedSubjectRoom : (getRoomList()[0] || ''); document.getElementById('newSubRoom').value = __defSubRoom;
        document.getElementById('newSubCode').value = ''; document.getElementById('newSubName').value = ''; if(teachers.length > 0) document.getElementById('newSubTeacher').value = teachers[0].name; document.getElementById('newSubTeacher2').value = ''; document.getElementById('newSubCredit').value = '0.5';
        ['newSubRoom', 'newSubCode', 'newSubName', 'newSubTeacher', 'newSubTeacher2'].forEach(fid => { const el = document.getElementById(fid); if (el) el.disabled = false; });
        const sysNote0 = document.getElementById('subjectSystemNote'); if (sysNote0) sysNote0.classList.add('hidden');
        if (prefillDay !== undefined && prefillPeriod !== undefined) { window.renderScheduleInputs([{ day: prefillDay, period: prefillPeriod }]); } else { window.__scheduleSelection = []; window.renderScheduleInputs(); }
        document.getElementById('subjectModal').classList.remove('hidden');
        document.getElementById('subjectTemplatePickerWrap').classList.remove('hidden'); window.populateSubjectTemplateOptions();
        setTimeout(() => { document.getElementById('subjectModalBox').classList.remove('scale-95', 'opacity-0'); document.getElementById('subjectModalBox').classList.add('scale-100', 'opacity-100'); }, 10); };
        window.closeSubjectModal = function() { document.getElementById('subjectModalBox').classList.remove('scale-100', 'opacity-100'); document.getElementById('subjectModalBox').classList.add('scale-95', 'opacity-0');
        setTimeout(() => { document.getElementById('subjectModal').classList.add('hidden'); }, 300); };
        window.prepareEditSubject = function(id) { if (guardTermLock('แก้ไขวิชา')) return; editingSubjectId = id;
        const sub = subjects.find(s => s.id === id); if(!sub) return; document.getElementById('subjectModalTitle').innerText = sub.systemType ? `แก้ไขคาบระบบ: ${sub.name}` : 'แก้ไขวิชา'; document.getElementById('newSubRoom').value = sub.roomId; document.getElementById('newSubCode').value = sub.code || ''; document.getElementById('newSubName').value = sub.name; document.getElementById('newSubTeacher').value = sub.teacher; document.getElementById('newSubTeacher2').value = sub.teacher2 || ''; document.getElementById('newSubCredit').value = parseFloat(sub.credits || 0.5).toFixed(1); window.renderScheduleInputs(sub.schedules); document.getElementById('subjectModal').classList.remove('hidden');
        // ===== คาบระบบ (เข้าแถวเช้า/โฮมรูม) แก้ได้แค่หน่วยกิตกับตารางคาบเท่านั้น ล็อคช่องอื่นไว้ =====
        ['newSubRoom', 'newSubCode', 'newSubName', 'newSubTeacher', 'newSubTeacher2'].forEach(fid => { const el = document.getElementById(fid); if (el) el.disabled = !!sub.systemType; });
        const sysNote = document.getElementById('subjectSystemNote'); if (sysNote) sysNote.classList.toggle('hidden', !sub.systemType);
        document.getElementById('subjectTemplatePickerWrap').classList.add('hidden');
        setTimeout(() => { document.getElementById('subjectModalBox').classList.remove('scale-95', 'opacity-0'); document.getElementById('subjectModalBox').classList.add('scale-100', 'opacity-100'); }, 10); };
        // คัดลอกข้อมูลวิชาที่เคยสร้างไว้แล้วในระดับชั้นเดียวกัน (ช่วยลดการพิมพ์ซ้ำ) - เฉพาะภาคเรียนที่แอดมินกำลังจัดการอยู่
        window.populateSubjectTemplateOptions = function() {
            const picker = document.getElementById('subjectTemplatePicker'); if (!picker) return;
            const roomId = document.getElementById('newSubRoom').value; const level = (roomId || '').split('_')[0];
            const seen = new Set(); const candidates = [];
            activeSubjects(adminTerm(), adminYear()).filter(s => (s.roomId || '').split('_')[0] === level).sort((a,b) => a.name.localeCompare(b.name)).forEach(s => {
                const key = s.name + '|' + (s.teacher || ''); if (seen.has(key)) return; seen.add(key); candidates.push(s);
            });
            picker.innerHTML = `<option value="">-- พิมพ์ข้อมูลใหม่เอง --</option>` + candidates.map(s => `<option value="${s.id}">${s.name}${s.teacher ? ' (ครู' + s.teacher + ')' : ''}</option>`).join('');
        };
        window.applySubjectTemplate = function(subId) {
            if (!subId) return;
            const sub = subjects.find(s => s.id === subId); if (!sub) return;
            document.getElementById('newSubCode').value = sub.code || '';
            document.getElementById('newSubName').value = sub.name || '';
            if (sub.teacher) document.getElementById('newSubTeacher').value = sub.teacher;
            document.getElementById('newSubTeacher2').value = sub.teacher2 || '';
            document.getElementById('newSubCredit').value = parseFloat(sub.credits || 0.5).toFixed(1);
            window.renderScheduleInputs(sub.schedules);
            showToast("คัดลอกข้อมูลวิชาแล้ว ตรวจสอบตารางเรียนก่อนบันทึก");
        };
        window.saveSubjectForm = async function() {
            if (guardTermLock('บันทึกวิชา')) return;
            const roomId = document.getElementById('newSubRoom').value, code = document.getElementById('newSubCode').value.trim(), name = document.getElementById('newSubName').value, teacher = document.getElementById('newSubTeacher').value, teacher2 = document.getElementById('newSubTeacher2').value, credit = parseFloat(document.getElementById('newSubCredit').value) || 0.5;
            if (!name) { showToast("กรอกชื่อวิชา", "error"); return; }
            let count = credit * 2;
            if (!Array.isArray(window.__scheduleSelection) || window.__scheduleSelection.length < count) {
                showToast(`กรุณาคลิกเลือกคาบสอนให้ครบ ${count} คาบ ตามหน่วยกิตที่ตั้งไว้ (ตอนนี้เลือกแล้ว ${window.__scheduleSelection ? window.__scheduleSelection.length : 0} คาบ)`, "error");
                return;
            }
            let schedules = [];
            for (let i = 0; i < count; i++) { schedules.push({ day: parseInt(document.getElementById(`newSubDay_${i}`).value), period: parseInt(document.getElementById(`newSubPeriod_${i}`).value) }); }

            // ===== [ใหม่] เช็คว่ามีวิชาอื่น (คนละวิชา) ในห้องเดียวกัน ลงคาบสอนชนกันไหม - ถ้ามีให้เตือนก่อนบันทึก =====
            const roomSubjectsForConflict = getRoomSubjects(roomId, adminTerm(), adminYear()).filter(s => s.id !== editingSubjectId && !s.systemType);
            const conflicts = [];
            schedules.forEach(sch => {
                const clash = roomSubjectsForConflict.find(s => (s.schedules || []).some(os => os.day === sch.day && os.period === sch.period));
                if (clash) conflicts.push({ day: sch.day, period: sch.period, withName: clash.name });
            });

            const doActualSave = async () => {
                showToast("กำลังบันทึกข้อมูลวิชา...", "info");
                document.body.style.pointerEvents = 'none';
                // [v1.74.5] ส่งเฉพาะวิชานี้ — Worker ผสานกับข้อมูลล่าสุดเอง (กันชนกับผู้ดูแลคนอื่นเหมือนเดิม)
                let rec, gone = false;
                if (editingSubjectId) {
                    const sub = subjects.find(s => s.id === editingSubjectId);
                    if (!sub) gone = true;
                    else rec = Object.assign({}, sub, { roomId, code, name, teacher, teacher2, credits: credit, schedules });
                } else {
                    rec = { id: generateId(), roomId, name, code, teacher, teacher2, credits: credit, schedules, term: adminTerm(), year: adminYear(), locked: false };
                }
                if (gone) { document.body.style.pointerEvents = 'auto'; showToast("ไม่พบวิชานี้แล้ว (อาจถูกลบไปโดยผู้ใช้อื่น) กรุณาลองใหม่", "error"); renderAdminTab(); return; }
                const applyLocal = () => { const i = subjects.findIndex(s => s.id === rec.id); if (i >= 0) subjects[i] = rec; else if (editingSubjectId) return false; else subjects.push(rec); };
                const ok = await saveSubjectsDelta([rec], [], { mustExist: !!editingSubjectId, applyLocal });
                document.body.style.pointerEvents = 'auto';
                if (!ok) { renderAdminTab(); return; }
                logAction(editingSubjectId ? 'แก้ไขข้อมูลวิชา' : 'เพิ่มวิชาใหม่', `${name} (${formatRoomName(roomId)})`);
                showToast(savedMsg_("บันทึกสำเร็จ")); renderAdminTab(); closeSubjectModal();
            };

            if (conflicts.length > 0) {
                const conflictListText = conflicts.map(c => `${daysLabel[c.day-1] || ''} คาบ ${periodLabel(c.period)} ชนกับวิชา "${c.withName}"`).join('\n');
                showConfirm("พบคาบสอนชนกันในห้องนี้", `ห้อง ${formatRoomName(roomId)} มีคาบที่ชนกับวิชาอื่นในตารางเดียวกัน:\n\n${conflictListText}\n\nต้องการบันทึกต่อไปหรือไม่? (ระบบจะยังบันทึกให้ แต่ทั้งสองวิชาจะซ้อนกันในตาราง)`, doActualSave);
            } else {
                await doActualSave();
            }
        };
        window.toggleSubjectLock = async function(id) {
            showToast("กำลังบันทึก...", "info");
            document.body.style.pointerEvents = 'none';
            const sub = subjects.find(s => s.id === id);
            if (!sub) { document.body.style.pointerEvents = 'auto'; showToast("ไม่พบวิชานี้แล้ว", "error"); renderAdminTab(); return; }
            const rec = Object.assign({}, sub, { locked: !sub.locked }); // [v1.74.5] ส่งเฉพาะวิชานี้
            const ok = await saveSubjectsDelta([rec], [], { mustExist: true, applyLocal: () => { const s2 = subjects.find(s => s.id === id); if (!s2) return false; s2.locked = rec.locked; } });
            document.body.style.pointerEvents = 'auto';
            if (!ok) { renderAdminTab(); return; }
            logAction(rec.locked ? 'ล็อควิชา (ป้องกันการลบ)' : 'ปลดล็อควิชา', `${rec.name} (${formatRoomName(rec.roomId)})`);
            showToast(savedMsg_(rec.locked ? "ล็อควิชานี้แล้ว" : "ปลดล็อควิชานี้แล้ว")); renderAdminTab();
        };
        window.clearRoomSubjects = function(roomId) {
            if (!roomId || roomId === 'all') { showToast("กรุณาเลือกห้องก่อน", "error"); return; }
            if (guardTermLock('ลบวิชา')) return;
            const all = getRoomSubjects(roomId, adminTerm(), adminYear()); const targets = all.filter(s => !s.locked); const lockedCount = all.length - targets.length;
            if (targets.length === 0) { showToast("ไม่มีวิชาที่สามารถลบได้ (อาจถูกล็อคไว้ทั้งหมด หรือห้องนี้ยังไม่มีวิชา)", "error"); return; }
            showConfirm("ลบวิชาทั้งหมดในห้องนี้", `จะลบวิชาที่ไม่ได้ล็อคไว้ ${targets.length} รายการ พร้อมข้อมูลการเช็คชื่อที่เกี่ยวข้อง ของห้อง ${formatRoomName(roomId)} ภาคเรียน ${adminTerm()}/${adminYear()}${lockedCount > 0 ? ` (วิชาที่ล็อคไว้ ${lockedCount} รายการจะไม่ถูกลบ)` : ''} แน่ใจหรือไม่?`, async () => {
                showToast("กำลังลบวิชา...", "info");
                document.body.style.pointerEvents = 'none';
                const freshTargets = getRoomSubjects(roomId, adminTerm(), adminYear()).filter(s => !s.locked && !s.systemType);
                const ids = freshTargets.map(s => s.id), idSet = new Set(ids);
                const ok = await saveSubjectsDelta([], ids, { applyLocal: () => { subjects = subjects.filter(s => !idSet.has(s.id) || s.locked || s.systemType); } }); // [v1.74.5]
                document.body.style.pointerEvents = 'auto';
                if (!ok) { renderAdminTab(); return; }
                attendanceData = attendanceData.filter(a => !idSet.has(a.subjectId));
                logAction('ลบวิชาทั้งหมดในห้อง', `${formatRoomName(roomId)} ภาคเรียน ${adminTerm()}/${adminYear()} (${freshTargets.length} วิชา)`);
                showToast(savedMsg_("ลบวิชาทั้งหมดในห้องเรียบร้อย")); renderAdminTab();
            });
        };

        window.openExportSubjectsModal = function() {
            if (!window.adminSelectedSubjectRoom || window.adminSelectedSubjectRoom === 'all') { showToast("กรุณาเลือกห้องก่อนส่งออก", "error"); return; }
            document.getElementById('exportSubjectsModal').classList.remove('hidden');
            setTimeout(() => { document.getElementById('exportSubjectsModalBox').classList.remove('scale-95', 'opacity-0'); document.getElementById('exportSubjectsModalBox').classList.add('scale-100', 'opacity-100'); }, 10);
        };
        window.closeExportSubjectsModal = function() {
            document.getElementById('exportSubjectsModalBox').classList.remove('scale-100', 'opacity-100'); document.getElementById('exportSubjectsModalBox').classList.add('scale-95', 'opacity-0');
            setTimeout(() => { document.getElementById('exportSubjectsModal').classList.add('hidden'); }, 300);
        };
        window.doExportSubjects = function(mode) {
            const roomId = window.adminSelectedSubjectRoom;
            const roomName = formatRoomName(roomId);
            const subs = getRoomSubjects(roomId, adminTerm(), adminYear()).slice().sort((a,b) => (a.code||'').localeCompare(b.code||'') || a.name.localeCompare(b.name));
            let ws_data, colWidths, sheetName;
            if (mode === 'full') {
                ws_data = [["รหัสวิชา", "ชื่อวิชา", "หน่วยกิต", "ครู (หลัก)", "ครู (ร่วมสอน)", "คาบสอน"]];
                subs.forEach(s => {
                    const schedText = (s.schedules || []).map(sch => `${(daysLabel[sch.day-1]||'').replace('วัน','')} คาบ ${periodLabel(sch.period)}`).join(', ');
                    ws_data.push([s.code || '', s.name, s.credits || '', s.teacher || '', s.teacher2 || '', schedText]);
                });
                colWidths = [{wch:10},{wch:30},{wch:8},{wch:22},{wch:22},{wch:35}];
                sheetName = "รายวิชา (ละเอียด)";
            } else {
                ws_data = [["รหัสวิชา", "ชื่อวิชา", "หน่วยกิต"]];
                subs.forEach(s => { ws_data.push([s.code || '', s.name, s.credits || '']); });
                colWidths = [{wch:10},{wch:30},{wch:8}];
                sheetName = "รายวิชา";
            }
            const ws = XLSX.utils.aoa_to_sheet(ws_data); ws['!cols'] = colWidths;
            const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, sheetName);
            XLSX.writeFile(wb, `รายวิชา_${roomName}_${mode === 'full' ? 'ละเอียด' : 'พื้นฐาน'}.xlsx`);
            logAction('ส่งออกรายวิชาเป็น Excel', `${roomName} (${mode === 'full' ? 'แบบละเอียด' : 'แบบพื้นฐาน'})`);
            window.closeExportSubjectsModal();
            showToast("ส่งออกไฟล์เรียบร้อย");
        };
        window.downloadSubjectTemplate = function() {
            if (!window.adminSelectedSubjectRoom || window.adminSelectedSubjectRoom === 'all') { showToast("กรุณาเลือกห้องก่อนโหลดฟอร์ม", "error"); return; }
            const roomName = formatRoomName(window.adminSelectedSubjectRoom);
            const ws_data = [
                ["รหัสวิชา", "ชื่อวิชา", "หน่วยกิต"],
                ["ว31101", "คณิตศาสตร์พื้นฐาน", "1.0"],
                ["", "เช็คแถวเช้า", "0.5"],
                [],
                ["หมายเหตุ: นำเข้าได้เฉพาะ รหัสวิชา, ชื่อวิชา และ หน่วยกิต เท่านั้น (รหัสวิชาจะเว้นว่างไว้ก็ได้, หน่วยกิตเว้นว่างไว้จะใช้ค่าเริ่มต้น 0.5)"],
                ["หน่วยกิตที่ใช้ได้: 0.5 / 1.0 / 1.5 / 2.0 / 2.5 / 3.0 (เว้นว่างหรือใส่ค่าอื่นจะปัดเป็น 0.5 อัตโนมัติ)"],
                ["ส่วนที่เหลือ (ครูผู้สอน / ตารางเรียน) เจ้าหน้าที่ต้องเข้ามาแก้ไขเพิ่มเติมเองทีหลังในหน้าเว็บ"],
                ["วิชาที่นำเข้าใหม่จะยังไม่มีตารางเรียน จะไม่นับรวมในการเช็คสถานะ \"ตารางเต็ม\" จนกว่าจะแก้ไขตารางให้ครบ"]
            ];
            const ws = XLSX.utils.aoa_to_sheet(ws_data); ws['!cols'] = [{wch: 12}, {wch: 32}, {wch: 10}];
            const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Template");
            XLSX.writeFile(wb, `แบบฟอร์มนำเข้ารายวิชา_${roomName}.xlsx`);
            showToast("ดาวน์โหลดแบบฟอร์มรายวิชาสำเร็จ", "success");
        };

        window.handleImportSubjects = function(e) {
            if (!window.adminSelectedSubjectRoom || window.adminSelectedSubjectRoom === 'all') { showToast("กรุณาเลือกห้องก่อนนำเข้า", "error"); e.target.value = ''; return; }
            if (guardTermLock('นำเข้ารายวิชา')) { e.target.value = ''; return; }
            const targetRoom = window.adminSelectedSubjectRoom;
            const VALID_CREDITS = [0.5, 1.0, 1.5, 2.0, 2.5, 3.0];
            const file = e.target.files[0];
            if (!file) return; showProgressModal("กำลังนำเข้ารายวิชา", "กำลังอ่านไฟล์..."); const reader = new FileReader();
            reader.onload = async function(evt) {
                try {
                    updateProgressModal(20, "กำลังตรวจสอบข้อมูลในไฟล์...");
                    const data = new Uint8Array(evt.target.result);
                    const workbook = XLSX.read(data, {type: 'array'}); const jsonData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {header: 1});
                    let startIndex = (jsonData.length > 0 && (String(jsonData[0][0] || '').includes("รหัสวิชา") || String(jsonData[0][1] || '').includes("ชื่อวิชา"))) ? 1 : 0;
                    let imported = 0;
                    updateProgressModal(40, "กำลังดึงข้อมูลล่าสุดจากเซิร์ฟเวอร์...");
                    const __prefetch4 = await refreshBeforeEdit(['subjects']); // ดึงข้อมูลล่าสุดก่อนนำเข้า กันชนกับแอดมินคนอื่น
                    updateProgressModal(60, "กำลังนำเข้าข้อมูลรายวิชา...");
                    for (let i = startIndex; i < jsonData.length; i++) {
                        const row = jsonData[i];
                        if (!row || !row[1] || !String(row[1]).trim()) continue;
                        const name = String(row[1]).trim();
                        if (name.startsWith('หมายเหตุ') || name.startsWith('ส่วนที่เหลือ') || name.startsWith('วิชาที่นำเข้าใหม่') || name.startsWith('หน่วยกิตที่ใช้ได้')) continue;
                        const code = String(row[0] || '').trim();
                        const creditsRaw = parseFloat(row[2]);
                        const credits = VALID_CREDITS.includes(creditsRaw) ? creditsRaw : 0.5;
                        const roomActive = getRoomSubjects(targetRoom, adminTerm(), adminYear());
                        const exists = code ? roomActive.find(s => s.code && s.code === code) : roomActive.find(s => s.name === name && !s.teacher);
                        if (exists) { exists.name = name; exists.code = code; exists.credits = credits;
                        } else { subjects.push({ id: generateId(), roomId: targetRoom, name, code, teacher: '', teacher2: '', credits, schedules: [], term: adminTerm(), year: adminYear(), locked: false }); } imported++;
                    }
                    if (imported > 0) { updateProgressModal(85, "กำลังบันทึกขึ้นเซิร์ฟเวอร์..."); await saveData('full', null, __prefetch4); logAction('นำเข้ารายวิชาจาก Excel (ชื่อ+รหัส+หน่วยกิต)', `นำเข้า ${imported} วิชา ห้อง ${formatRoomName(targetRoom)} - รอเจ้าหน้าที่เพิ่มครู/ตารางเรียน`);
                        completeProgressModal("นำเข้าสำเร็จ", `นำเข้า ${imported} วิชา สำเร็จ! กรุณาเข้าไปเพิ่มครูผู้สอนและตารางเรียนให้ครบต่อไป`); renderAdminTab(); } else { errorProgressModal("ไม่พบข้อมูลที่ถูกต้องในไฟล์ (ต้องมีอย่างน้อยคอลัมน์ชื่อวิชา)");
                    }
                } catch (err) { errorProgressModal("เกิดข้อผิดพลาดในการอ่านไฟล์ กรุณาตรวจสอบรูปแบบไฟล์");
                } e.target.value = '';
            }; reader.readAsArrayBuffer(file);
        };

        // ===== นำเข้ารายชื่อครู (ชื่อครู + กลุ่มสาระการเรียนรู้) =====
        window.downloadTeacherTemplate = function() {
            const deptList = departmentsList.join(' / ');
            const ws_data = [
                ["ชื่อ-นามสกุล ครูผู้สอน", "กลุ่มสาระการเรียนรู้"],
                ["ครูสมใจ รักเรียน", departmentsList[0] || 'ระบบ/อื่นๆ'],
                ["ครูสมหญิง ใจดี", departmentsList[1] || 'ระบบ/อื่นๆ'],
                [],
                ["หมายเหตุ: กลุ่มสาระการเรียนรู้ต้องพิมพ์ให้ตรงกับที่มีอยู่ในระบบเป๊ะ ไม่เช่นนั้นจะถูกจัดเป็น \"ระบบ/อื่นๆ\" โดยอัตโนมัติ"],
                [`กลุ่มสาระที่มีในระบบ: ${deptList}`],
                ["ถ้ามีชื่อครูซ้ำกับที่มีอยู่แล้ว ระบบจะอัปเดตกลุ่มสาระให้ตามไฟล์ที่นำเข้าแทนการเพิ่มซ้ำ"]
            ];
            const ws = XLSX.utils.aoa_to_sheet(ws_data); ws['!cols'] = [{wch: 28}, {wch: 30}];
            const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Template");
            XLSX.writeFile(wb, `แบบฟอร์มนำเข้ารายชื่อครู.xlsx`);
            showToast("ดาวน์โหลดแบบฟอร์มครูสำเร็จ", "success");
        };
        window.handleImportTeachers = function(e) {
            const file = e.target.files[0];
            if (!file) return; showProgressModal("กำลังนำเข้ารายชื่อครู", "กำลังอ่านไฟล์..."); const reader = new FileReader();
            reader.onload = async function(evt) {
                try {
                    updateProgressModal(20, "กำลังตรวจสอบข้อมูลในไฟล์...");
                    const data = new Uint8Array(evt.target.result);
                    const workbook = XLSX.read(data, {type: 'array'}); const jsonData = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {header: 1});
                    let startIndex = (jsonData.length > 0 && (String(jsonData[0][0] || '').includes("ชื่อ") || String(jsonData[0][1] || '').includes("กลุ่มสาระ"))) ? 1 : 0;
                    let imported = 0, updated = 0;
                    updateProgressModal(50, "กำลังนำเข้าข้อมูลครู...");
                    for (let i = startIndex; i < jsonData.length; i++) {
                        const row = jsonData[i];
                        if (!row || !row[0] || !String(row[0]).trim()) continue;
                        const name = String(row[0]).trim();
                        if (name.startsWith('หมายเหตุ') || name.startsWith('กลุ่มสาระที่มีในระบบ') || name.startsWith('ถ้ามีชื่อครูซ้ำ')) continue;
                        const deptRaw = String(row[1] || '').trim();
                        const department = departmentsList.includes(deptRaw) ? deptRaw : 'ระบบ/อื่นๆ';
                        const existing = teachers.find(t => t.name === name);
                        if (existing) { existing.department = department; updated++; }
                        else { teachers.push({ id: generateId(), name, department }); imported++; }
                    }
                    if (imported > 0 || updated > 0) { updateProgressModal(85, "กำลังบันทึกขึ้นเซิร์ฟเวอร์..."); await saveData('full'); logAction('นำเข้ารายชื่อครูจาก Excel', `เพิ่มใหม่ ${imported} คน อัปเดต ${updated} คน`);
                        completeProgressModal("นำเข้าสำเร็จ", `เพิ่มครูใหม่ ${imported} คน${updated > 0 ? ` และอัปเดตกลุ่มสาระของครูเดิม ${updated} คน` : ''}`); renderAdminTab(); } else { errorProgressModal("ไม่พบข้อมูลที่ถูกต้องในไฟล์ (ต้องมีอย่างน้อยคอลัมน์ชื่อครู)");
                    }
                } catch (err) { errorProgressModal("เกิดข้อผิดพลาดในการอ่านไฟล์ กรุณาตรวจสอบรูปแบบไฟล์");
                } e.target.value = '';
            }; reader.readAsArrayBuffer(file);
        };

        window.openStudentModal = function() { editingStudentId = null; document.getElementById('studentModalTitle').innerText = 'เพิ่มนักเรียนใหม่'; document.getElementById('newStuNum').value = ''; document.getElementById('newStuName').value = ''; document.getElementById('newStuCode').value = '';
        document.getElementById('newStuStatus').value = 'active'; document.getElementById('studentModal').classList.remove('hidden'); setTimeout(() => { document.getElementById('studentModalBox').classList.remove('scale-95', 'opacity-0'); document.getElementById('studentModalBox').classList.add('scale-100', 'opacity-100'); }, 10); };
        window.closeStudentModal = function() { document.getElementById('studentModalBox').classList.remove('scale-100', 'opacity-100');
        document.getElementById('studentModalBox').classList.add('scale-95', 'opacity-0'); setTimeout(() => { document.getElementById('studentModal').classList.add('hidden'); }, 300); };
        window.prepareEditStudent = function(id) { editingStudentId = id;
        const st = students.find(s => s.id === id); if(!st) return; document.getElementById('studentModalTitle').innerText = 'แก้ไขข้อมูลนักเรียน'; document.getElementById('newStuNum').value = st.number;
        document.getElementById('newStuName').value = st.name; document.getElementById('newStuCode').value = st.code || ''; document.getElementById('newStuStatus').value = st.status || 'active'; document.getElementById('studentModal').classList.remove('hidden'); setTimeout(() => { document.getElementById('studentModalBox').classList.remove('scale-95', 'opacity-0'); document.getElementById('studentModalBox').classList.add('scale-100', 'opacity-100'); }, 10); };
        window.promoteStudents = function() {
            const fromYear = document.getElementById('promoteFromYear').value;
            const toYear = document.getElementById('promoteToYear').value;
            if (!fromYear || !toYear) { showToast("กรุณาเลือกปีการศึกษาต้นทางและปลายทาง", "error"); return; }
            if (fromYear === toYear) { showToast("ปีต้นทางและปลายทางต้องไม่ใช่ปีเดียวกัน", "error"); return; }
            if (getYearStatus(toYear) === 'archived') { showToast("ปีปลายทางถูกจัดเก็บแล้ว ไม่สามารถเลื่อนชั้นเข้าไปได้", "error"); return; }
            const roomList = getRoomList();
            const GRADUATING_LEVELS = [3, 6]; // ม.3 จบการศึกษาภาคบังคับ และ ม.6 จบการศึกษาขั้นสูงสุด ทั้งสองระดับไม่ถูกเลื่อนชั้นต่อ
            let toPromote = 0, graduating = 0;
            roomList.forEach(r => {
                const level = parseInt(r.split('_')[0].replace('m', ''));
                const roomStu = getRoomStudents(r, fromYear).filter(s => s.status !== 'resigned');
                if (GRADUATING_LEVELS.includes(level)) graduating += roomStu.length; else toPromote += roomStu.length;
            });
            if (toPromote === 0 && graduating === 0) { showToast(`ไม่พบรายชื่อนักเรียนในปีการศึกษา ${fromYear} ที่จะเลื่อนชั้นได้`, "error"); return; }
            showConfirm("ยืนยันการเลื่อนชั้นนักเรียน", `จะเลื่อนชั้นนักเรียน ${toPromote} คน จากปีการศึกษา ${fromYear} ไปเป็นรายชื่อในปีการศึกษา ${toYear}${graduating > 0 ? ` (ม.3 และ ม.6 ที่จบการศึกษาแล้ว รวม ${graduating} คน จะไม่ถูกเลื่อนชั้น)` : ''} หลังเลื่อนชั้นแล้ว อย่าลืมเพิ่มรายชื่อนักเรียน ม.1 และ ม.4 ใหม่สำหรับปีการศึกษา ${toYear} ด้วยตนเอง (เนื่องจากเป็นชั้นรับเข้าใหม่ ไม่มีรุ่นพี่เลื่อนชั้นขึ้นมา) ข้อมูลเดิมของปี ${fromYear} จะไม่ถูกเปลี่ยนแปลงหรือลบทิ้ง คุณแน่ใจหรือไม่?`, () => {
                // ตรึงปีให้กับนักเรียนเก่าที่ยังไม่มีปีระบุ (ข้อมูลก่อนใช้ระบบเลื่อนชั้น) ให้อยู่ที่ปีต้นทางเสมอ ป้องกันไม่ให้ไปปนกับปีอื่นในอนาคต
                students.forEach(s => { if ((s.year === undefined || s.year === null) && roomList.includes(s.roomId)) s.year = fromYear; });
                let added = 0;
                roomList.forEach(r => {
                    const level = parseInt(r.split('_')[0].replace('m', ''));
                    if (GRADUATING_LEVELS.includes(level)) return; // ม.3 และ ม.6 จบการศึกษาแล้ว ไม่เลื่อนชั้นต่อ
                    const roomStu = getRoomStudents(r, fromYear, true).filter(s => s.status !== 'resigned');
                    if (roomStu.length === 0) return;
                    const newRoomId = `m${level + 1}_${r.split('_')[1]}`;
                    roomStu.forEach(s => {
                        const dup = students.find(x => x.roomId === newRoomId && String(x.year) === String(toYear) && x.number === s.number && x.name === s.name);
                        if (dup) return;
                        students.push(Object.assign({ id: generateId(), roomId: newRoomId, number: s.number, name: s.name, status: s.status === 'hidden' ? 'hidden' : 'active', year: toYear }, s.code ? { code: s.code } : {}));
                        added++;
                    });
                });
                logAction('เลื่อนชั้นนักเรียน', `จากปีการศึกษา ${fromYear} ไปปีการศึกษา ${toYear} (เลื่อนชั้น ${added} คน${graduating > 0 ? `, จบการศึกษา ${graduating} คน` : ''})`, 'settings');
                saveData('full'); showToast(`เลื่อนชั้นนักเรียนสำเร็จ ${added} คน${graduating > 0 ? ` (ม.3 และ ม.6 จบการศึกษาไปแล้ว รวม ${graduating} คน)` : ''} อย่าลืมเพิ่มรายชื่อ ม.1 และ ม.4 ใหม่สำหรับปีการศึกษา ${toYear}`); renderAdminTab();
            });
        };
        // ===== [v1.76] จัดเลขที่ (แบบ C) — ลาก (คอม) / ปุ่ม ↑ ↓ (มือถือ) / พิมพ์เลขที่เอง · เตือนเลขซ้ำ/เลขข้าม · บันทึกครั้งเดียวทั้งห้อง
        // ข้อมูลเช็คชื่อผูกกับรหัสนักเรียน (ไม่ได้ผูกกับเลขที่) — เปลี่ยนเลขที่แล้วผลการเช็คเดิมตามตัวนักเรียนไปเอง
        let __rn = null;
        window.openRenumber = function(roomId) {
            if (!roomId) return;
            const list = getRoomStudents(roomId, adminYear()).slice().sort((a, b) => (parseInt(a.number) || 0) - (parseInt(b.number) || 0));
            if (!list.length) { showToast('ห้องนี้ยังไม่มีนักเรียน', 'error'); return; }
            __rn = { roomId, rows: list.map(s => ({ id: s.id, number: String(s.number || ''), name: s.name, code: s.code || '', resigned: s.status === 'resigned' })), moved: null };
            let m = document.getElementById('renumModal');
            if (!m) {
                m = document.createElement('div'); m.id = 'renumModal';
                m.className = 'fixed inset-0 bg-slate-900/60 backdrop-blur-sm z-[65] flex items-center justify-center p-2 sm:p-4';
                m.innerHTML = `<div class="bg-white rounded-2xl sm:rounded-3xl shadow-2xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden"><div class="p-3 sm:p-5 border-b border-slate-100"><div class="flex items-center gap-2 flex-wrap"><h4 class="font-extrabold text-base sm:text-lg flex-1 min-w-[160px]" id="renumTitle"></h4><button type="button" onclick="window.renumSequence()" class="bg-indigo-50 border border-indigo-200 text-indigo-700 hover:bg-indigo-100 px-3 py-1.5 rounded-lg font-bold text-xs sm:text-sm"><i class="fas fa-list-ol"></i> เรียงเลขที่ต่อเนื่อง 1…n</button><button type="button" onclick="window.closeRenumber()" class="bg-slate-100 hover:bg-slate-200 px-3 py-1.5 rounded-lg font-bold text-xs sm:text-sm">ยกเลิก</button><button type="button" onclick="window.saveRenumber()" class="bg-emerald-600 hover:bg-emerald-700 text-white px-3 py-1.5 rounded-lg font-bold text-xs sm:text-sm shadow-sm"><i class="fas fa-check"></i> บันทึกเลขที่</button></div><div id="renumWarn" class="hidden mt-2 bg-orange-50 border border-orange-300 text-orange-800 rounded-lg px-3 py-1.5 text-[11px] sm:text-sm font-bold"></div></div><div class="overflow-y-auto flex-1" id="renumList"></div><div class="p-2.5 sm:p-3 border-t border-slate-100 text-[10px] sm:text-xs text-slate-500 font-medium"><i class="fas fa-info-circle"></i> ลากแถว (คอม) หรือกด ↑ ↓ (มือถือ) เพื่อย้าย — แถวที่ย้ายจะสลับเลขที่กันอัตโนมัติ · พิมพ์เลขที่เองได้ · ข้อมูลการเช็คชื่อเดิมตามตัวนักเรียนไปเสมอ</div></div>`;
                document.body.appendChild(m);
                const L = m.querySelector('#renumList');
                L.addEventListener('click', (e) => { const b = e.target.closest('[data-rn-mv]'); if (!b) return; renumMove(Number(b.getAttribute('data-rn-i')), Number(b.getAttribute('data-rn-mv'))); });
                L.addEventListener('input', (e) => { const n = e.target.closest('[data-rn-num]'); if (!n) return; __rn.rows[Number(n.getAttribute('data-rn-num'))].number = n.value.replace(/[^0-9]/g, '').slice(0, 3); renumWarn(); });
                L.addEventListener('dragstart', (e) => { const r = e.target.closest('[data-rn-row]'); if (!r) return; __rn.drag = Number(r.getAttribute('data-rn-row')); e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', String(__rn.drag)); } catch (x) {} r.classList.add('opacity-50'); });
                L.addEventListener('dragover', (e) => { if (__rn && __rn.drag != null && e.target.closest('[data-rn-row]')) e.preventDefault(); });
                L.addEventListener('drop', (e) => { const r = e.target.closest('[data-rn-row]'); if (!r || __rn.drag == null) return; e.preventDefault(); const to = Number(r.getAttribute('data-rn-row')), from = __rn.drag; __rn.drag = null; renumMove(from, to - from); });
                L.addEventListener('dragend', () => { if (__rn) __rn.drag = null; renumRender(); });
            }
            m.classList.remove('hidden');
            document.getElementById('renumTitle').innerHTML = `<i class="fas fa-sort-numeric-down text-indigo-500"></i> จัดเลขที่ · ${formatRoomName(roomId)} <span class="text-xs font-bold text-slate-400">(${list.length} คน)</span>`;
            renumRender();
        };
        window.closeRenumber = function() { const m = document.getElementById('renumModal'); if (m) m.classList.add('hidden'); __rn = null; };
        // ย้ายแถว: นักเรียนย้ายตำแหน่ง ส่วนเลขที่อยู่กับตำแหน่ง (เลขที่ที่มีอยู่ทั้งหมดเรียงตามเดิม) = สลับเลขที่กันอัตโนมัติ
        function renumMove(i, d) {
            const rows = __rn.rows, j = i + d;
            if (j < 0 || j >= rows.length || d === 0) return;
            const nums = rows.map(r => r.number);
            const [x] = rows.splice(i, 1); rows.splice(j, 0, x);
            rows.forEach((r, k) => { r.number = nums[k]; });
            __rn.moved = x.id; renumRender();
        }
        window.renumSequence = function() { if (!__rn) return; __rn.rows.forEach((r, k) => { r.number = String(k + 1); }); __rn.moved = null; renumRender(); showToast('เรียงเลขที่ 1–' + __rn.rows.length + ' ตามลำดับแล้ว (ยังไม่บันทึก)'); };
        function renumIssues() {
            const rows = __rn.rows, cnt = {}, bad = new Set();
            rows.forEach(r => { if (!/^\d+$/.test(r.number) || Number(r.number) < 1) bad.add(r.id); else cnt[r.number] = (cnt[r.number] || 0) + 1; });
            const dup = Object.keys(cnt).filter(k => cnt[k] > 1).sort((a, b) => a - b);
            rows.forEach(r => { if (cnt[r.number] > 1) bad.add(r.id); });
            const max = rows.length, gaps = []; for (let k = 1; k <= max; k++) if (!cnt[String(k)]) gaps.push(k);
            return { dup, gaps, bad, empty: rows.some(r => !/^\d+$/.test(r.number) || Number(r.number) < 1) };
        }
        function renumWarn() {
            const w = document.getElementById('renumWarn'); if (!w || !__rn) return;
            const iss = renumIssues(), msg = [];
            if (iss.empty) msg.push('มีช่องเลขที่ว่าง');
            iss.dup.forEach(k => msg.push(`เลขที่ ${k} ซ้ำ ${__rn.rows.filter(r => r.number === k).length} คน`));
            if (iss.gaps.length) msg.push('เลขที่ ' + iss.gaps.slice(0, 8).join(', ') + (iss.gaps.length > 8 ? ' …' : '') + ' ว่าง');
            w.innerHTML = msg.length ? `<i class="fas fa-exclamation-triangle"></i> ${msg.join(' · ')}${iss.dup.length || iss.empty ? ' — แก้ให้ครบ หรือกด "เรียงเลขที่ต่อเนื่อง" ก่อนบันทึก' : ''}` : '';
            w.classList.toggle('hidden', !msg.length);
            document.querySelectorAll('#renumList [data-rn-num]').forEach(inp => { const r = __rn.rows[Number(inp.getAttribute('data-rn-num'))]; const b = iss.bad.has(r.id); inp.classList.toggle('border-orange-400', b); inp.classList.toggle('bg-orange-50', b); });
        }
        function renumRender() {
            const L = document.getElementById('renumList'); if (!L || !__rn) return;
            const n = __rn.rows.length;
            L.innerHTML = __rn.rows.map((r, i) => `<div data-rn-row="${i}" draggable="true" class="flex items-center gap-2 px-2 sm:px-4 py-1.5 sm:py-2 border-b border-slate-100 ${__rn.moved === r.id ? 'bg-emerald-50' : 'bg-white'}"><i class="fas fa-grip-vertical text-slate-300 cursor-grab hidden sm:block w-4"></i><input type="text" inputmode="numeric" data-rn-num="${i}" value="${hrEsc(r.number)}" aria-label="เลขที่ของ ${hrEsc(r.name)}" class="w-12 sm:w-14 text-center font-extrabold border border-slate-300 rounded-lg py-1.5 text-base sm:text-sm outline-none focus:ring-2 focus:ring-indigo-400"><span class="hidden sm:block w-24 font-mono text-slate-500 text-sm">${r.code ? hrEsc(r.code) : '-'}</span><div class="flex-1 min-w-0"><div class="font-bold text-sm truncate ${r.resigned ? 'text-slate-400' : 'text-slate-800'}">${hrEsc(r.name)}${r.resigned ? ' <span class="text-[10px] text-rose-500">(ออก/ย้าย)</span>' : ''}</div>${r.code ? `<div class="sm:hidden font-mono text-[11px] text-slate-400">${hrEsc(r.code)}</div>` : ''}</div><button type="button" data-rn-mv="-1" data-rn-i="${i}" ${i === 0 ? 'disabled' : ''} aria-label="เลื่อนขึ้น" class="w-9 h-9 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 disabled:opacity-30"><i class="fas fa-arrow-up"></i></button><button type="button" data-rn-mv="1" data-rn-i="${i}" ${i === n - 1 ? 'disabled' : ''} aria-label="เลื่อนลง" class="w-9 h-9 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-600 disabled:opacity-30"><i class="fas fa-arrow-down"></i></button></div>`).join('');
            renumWarn();
        }
        window.saveRenumber = async function() {
            if (!__rn) return;
            const iss = renumIssues();
            if (iss.empty || iss.dup.length) { showToast('ยังมีเลขที่ซ้ำหรือว่าง — แก้ให้ครบ หรือกด "เรียงเลขที่ต่อเนื่อง" ก่อน', 'error'); renumWarn(); return; }
            const want = {}; __rn.rows.forEach(r => { want[r.id] = r.number; });
            const roomId = __rn.roomId;
            showToast('กำลังบันทึกเลขที่...', 'info'); document.body.style.pointerEvents = 'none';
            const pre = await refreshBeforeEdit(['students']); // ดึงล่าสุดก่อน กันทับงานของผู้ดูแลคนอื่น
            let changed = 0; students.forEach(s => { if (want[s.id] != null && String(s.number) !== want[s.id]) { s.number = want[s.id]; changed++; } });
            if (!changed) { document.body.style.pointerEvents = 'auto'; window.closeRenumber(); showToast('เลขที่ไม่มีการเปลี่ยนแปลง'); return; }
            logAction('จัดเลขที่นักเรียน', `${formatRoomName(roomId)} (เปลี่ยน ${changed} คน)`);
            const ok = await saveData('full', null, pre); document.body.style.pointerEvents = 'auto';
            if (ok) { window.closeRenumber(); showToast(`บันทึกเลขที่แล้ว (เปลี่ยน ${changed} คน)`); renderAdminTab(); }
        };
        window.saveStudentForm = async function() {
            const number = document.getElementById('newStuNum').value, name = document.getElementById('newStuName').value.trim(), status = document.getElementById('newStuStatus').value, code = document.getElementById('newStuCode').value.trim().slice(0, 20);
            if (!number || !name) { showToast("กรอกข้อมูลให้ครบ", "error"); return; }
            showToast("กำลังบันทึกข้อมูลนักเรียน...", "info");
            document.body.style.pointerEvents = 'none';
            const __prefetch5 = await refreshBeforeEdit(['students']); // ดึงข้อมูลล่าสุดก่อนบันทึก กันชนกับแอดมินคนอื่นที่เพิ่ม/แก้ไขนักเรียนพร้อมกัน
            if (editingStudentId) {
                const st = students.find(s => s.id === editingStudentId);
                if (st) { st.number = number; st.name = name; st.status = status; if (code) st.code = code; else delete st.code; logAction('แก้ไขข้อมูลนักเรียน', `${name} (เลขที่ ${number}, ${formatRoomName(st.roomId)})`); }
                else { document.body.style.pointerEvents = 'auto'; showToast("ไม่พบนักเรียนคนนี้แล้ว (อาจถูกลบไปโดยผู้ใช้อื่น)", "error"); renderAdminTab(); return; }
            } else {
                students.push(Object.assign({ id: generateId(), roomId: window.adminSelectedRoom, number, name, status }, code ? { code } : {}));
                logAction('เพิ่มนักเรียนใหม่', `${name} (เลขที่ ${number}, ${formatRoomName(window.adminSelectedRoom)})`);
            }
            await saveData('full', null, __prefetch5); document.body.style.pointerEvents = 'auto'; showToast("บันทึกสำเร็จ"); renderAdminTab(); closeStudentModal();
        };
        function deleteSubject(id) {
            if (guardTermLock('ลบวิชา')) return;
            const subCheck = subjects.find(s => s.id === id);
            if (subCheck && subCheck.systemType) { showToast("วิชานี้เป็นคาบระบบ (เขตพื้นที่รับผิดชอบ/เข้าแถวเช้า/โฮมรูม) ไม่สามารถลบได้", "error"); return; }
            if (subCheck && subCheck.locked) { showToast("วิชานี้ถูกล็อคไว้ กรุณาปลดล็อคก่อนลบ", "error"); return; }
            showConfirm("ลบวิชา", "ข้อมูลการเช็คชื่อทั้งหมดในวิชานี้จะถูกลบไปด้วย แน่ใจหรือไม่?", async () => {
                showToast("กำลังลบวิชา...", "info");
                document.body.style.pointerEvents = 'none';
                const sub = subjects.find(s => s.id === id);
                const ok = await saveSubjectsDelta([], [id], { applyLocal: () => { subjects = subjects.filter(s => s.id !== id); } }); // [v1.74.5]
                document.body.style.pointerEvents = 'auto';
                if (!ok) { renderAdminTab(); return; }
                attendanceData = attendanceData.filter(a => a.subjectId !== id);
                logAction('ลบวิชา', sub ? sub.name : id);
                showToast(savedMsg_("ลบวิชาเรียบร้อย")); renderAdminTab();
            });
        }
        function deleteStudent(id) {
            showConfirm("ลบนักเรียน", "แน่ใจหรือไม่ที่จะลบนักเรียนคนนี้?", async () => {
                showToast("กำลังลบนักเรียน...", "info");
                document.body.style.pointerEvents = 'none';
                const __prefetch7 = await refreshBeforeEdit(['students']);
                const st = students.find(s => s.id === id);
                students = students.filter(s => s.id !== id);
                logAction('ลบนักเรียน', st ? `${st.name} (${formatRoomName(st.roomId)})` : id);
                await saveData('full', null, __prefetch7); document.body.style.pointerEvents = 'auto'; renderAdminTab();
            });
        }
        window.deleteAllStudentsInRoom = function(roomId) {
            if (!roomId || roomId === 'all') { showToast("กรุณาเลือกห้องก่อน", "error"); return; }
            const targets = getRoomStudents(roomId, adminYear(), true);
            if (targets.length === 0) { showToast("ห้องนี้ยังไม่มีรายชื่อนักเรียน", "error"); return; }
            showConfirm("ลบนักเรียนทุกคนในห้องนี้", `จะลบรายชื่อนักเรียนทั้งหมด ${targets.length} คน ของห้อง ${formatRoomName(roomId)} ออกจากระบบ (ประวัติการเช็คชื่อเก่าของนักเรียนกลุ่มนี้จะยังคงอยู่ในไฟล์แต่จะไม่ผูกกับชื่อใครแล้ว) การกระทำนี้ไม่สามารถยกเลิกได้ แน่ใจหรือไม่?`, async () => {
                showToast("กำลังลบนักเรียน...", "info");
                document.body.style.pointerEvents = 'none';
                const __prefetch9 = await refreshBeforeEdit(['students']);
                const freshTargets = getRoomStudents(roomId, adminYear(), true);
                const ids = new Set(freshTargets.map(s => s.id));
                students = students.filter(s => !ids.has(s.id));
                logAction('ลบนักเรียนทุกคนในห้อง', `${formatRoomName(roomId)} (${freshTargets.length} คน)`);
                await saveData('full', null, __prefetch9); document.body.style.pointerEvents = 'auto'; showToast("ลบนักเรียนทุกคนในห้องเรียบร้อย"); renderAdminTab();
            });
        };

        // ===== จัดการผู้ใช้งาน (เฉพาะ Super Admin) =====
        window.openUserModal = function(id = null) {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่จัดการผู้ใช้งานได้", "error"); return; }
            editingUserId = id;
            const u = id ? (settings.users || []).find(x => x.id === id) : null;
            document.getElementById('userModalTitle').innerText = id ? 'แก้ไขผู้ใช้งาน' : 'เพิ่มผู้ใช้งานใหม่';
            document.getElementById('newUserName').value = u ? u.name : '';
            document.getElementById('newUserUsername').value = u ? u.username : '';
            document.getElementById('newUserPassword').value = '';
            document.getElementById('newUserPassword').placeholder = id ? 'เว้นว่างไว้ถ้าไม่ต้องการเปลี่ยนรหัสผ่าน' : 'ตั้งรหัสผ่าน';
            document.getElementById('userModal').classList.remove('hidden');
            setTimeout(() => { document.getElementById('userModalBox').classList.remove('scale-95', 'opacity-0'); document.getElementById('userModalBox').classList.add('scale-100', 'opacity-100'); }, 10);
        };
        window.closeUserModal = function() {
            document.getElementById('userModalBox').classList.remove('scale-100', 'opacity-100');
            document.getElementById('userModalBox').classList.add('scale-95', 'opacity-0');
            setTimeout(() => { document.getElementById('userModal').classList.add('hidden'); }, 300);
        };
        window.saveUserForm = async function() {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่จัดการผู้ใช้งานได้", "error"); return; }
            const name = document.getElementById('newUserName').value.trim();
            const username = document.getElementById('newUserUsername').value.trim();
            const password = document.getElementById('newUserPassword').value;
            if (!name || !username) { showToast("กรอกข้อมูลให้ครบ", "error"); return; }
            if (!editingUserId && !password) { showToast("กรุณาตั้งรหัสผ่าน", "error"); return; }
            if (!settings.users) settings.users = [];
            const dup = settings.users.find(u => u.username.toLowerCase() === username.toLowerCase() && u.id !== editingUserId);
            if (dup) { showToast("ชื่อผู้ใช้นี้มีอยู่แล้ว", "error"); return; }
            if (editingUserId) {
                const u = settings.users.find(x => x.id === editingUserId);
                const isEditingSelf = currentUser && u && u.id === currentUser.id;
                if (u && u.role === 'super_admin' && !isEditingSelf) { showToast("ไม่สามารถแก้ไข Super Admin คนอื่นได้", "error"); return; }
                if (u) {
                    u.name = name; u.username = username;
                    if (password) u.password = await sha256Hex(password); // [ใหม่] เข้ารหัสก่อนเก็บ - เว้นว่างไว้ = ไม่เปลี่ยนรหัสผ่านเดิม
                    logAction(isEditingSelf ? 'เปลี่ยนรหัสผ่านของตัวเอง' : 'แก้ไขข้อมูลผู้ใช้งาน', `${name} (${username})`, 'account');
                    if (isEditingSelf) currentUser = u;
                }
            } else {
                settings.users.push({ id: generateId(), username, password: await sha256Hex(password), name, role: 'admin', createdAt: new Date().toISOString() });
                logAction('เพิ่มผู้ใช้งานใหม่', `${name} (${username}) สิทธิ์เจ้าหน้าที่`, 'account');
            }
            saveData('full'); showToast("บันทึกสำเร็จ"); renderAdminTab(); closeUserModal();
        };
        window.deleteUser = function(id) {
            if (!currentUser || currentUser.role !== 'super_admin') { showToast("เฉพาะ Super Admin เท่านั้นที่จัดการผู้ใช้งานได้", "error"); return; }
            const u = (settings.users || []).find(x => x.id === id);
            if (!u || u.role === 'super_admin') { showToast("ไม่สามารถลบ Super Admin ได้", "error"); return; }
            showConfirm("ลบผู้ใช้งาน", `ต้องการลบผู้ใช้ "${u.name}" ใช่หรือไม่?`, () => {
                settings.users = settings.users.filter(x => x.id !== id);
                logAction('ลบผู้ใช้งาน', `${u.name} (${u.username})`, 'account');
                saveData('full'); showToast("ลบผู้ใช้งานแล้ว"); renderAdminTab();
            });
        };
        
        window.filterSubjects = function() {
            const searchInput = document.getElementById('searchSubjectInput');
            if (!searchInput) return;
            const searchText = searchInput.value.toLowerCase();
            const rows = document.querySelectorAll('#adminSubjectTableBody tr');
            rows.forEach(row => {
                const searchContent = row.getAttribute('data-search');
                if (!searchContent) return;
                row.style.display = searchContent.toLowerCase().includes(searchText) ? '' : 'none';
            });
        };

        window.filterTeachers = function() {
            const searchText = document.getElementById('searchTeacherInput').value.toLowerCase();
            const cards = document.querySelectorAll('#adminTeacherGrid .teacher-card');
            
            cards.forEach(card => {
                const searchContent = card.getAttribute('data-search');
                if (searchContent) {
                    if (searchContent.toLowerCase().includes(searchText)) {
                        card.style.display = '';
                    } else {
                        card.style.display = 'none';
                    }
                }
            });
        };

        window.filterAdminStudents = function() {
            const searchText = document.getElementById('searchStudentInput').value.toLowerCase();
            const rows = document.querySelectorAll('#adminStudentTableBody tr');
            
            rows.forEach(row => {
                const searchContent = row.getAttribute('data-search');
                if (searchContent) {
                    if (searchContent.toLowerCase().includes(searchText)) {
                        row.style.display = '';
                    } else {
                        row.style.display = 'none';
                    }
                }
            });
        };

        // ===== [v2.00.4] นำเข้ารายชื่อนักเรียน: จับคู่ "เลขประจำตัว" ก่อน → "ชื่อ" (ไม่สนคำนำหน้า/ช่องว่าง) → ไม่พบ = เพิ่มใหม่ · ดูตัวอย่างก่อนบันทึกทุกครั้ง
        // เดิมจับคู่ด้วย ห้อง + เลขที่ — เลขที่เปลี่ยน = ชื่อไปทับนักเรียนคนอื่น (ประวัติเช็คชื่อผูกกับนักเรียนคนเดิม) จึงเลิกใช้เลขที่จับคู่
        const STU_PREFIX = ['เด็กชาย', 'เด็กหญิง', 'ด.ช.', 'ด.ญ.', 'ดช.', 'ดญ.', 'นางสาว', 'น.ส.', 'นส.', 'นาย', 'นาง'];
        function stuNormName(n) {
            let x = String(n || '').replace(/[​-‍﻿*]/g, '').replace(/\s+/g, ''); // [v2.00.6] ตัด * (เครื่องหมายในไฟล์รายชื่อ)
            for (let g = 0; g < 2; g++) { const pre = STU_PREFIX.find(pf => x.indexOf(pf) === 0); if (!pre) break; x = x.slice(pre.length); }
            return x;
        }
        function stuCleanName(n) { return String(n || '').replace(/[​-‍﻿]/g, '').replace(/\s*\*+\s*$/, '').replace(/\s+/g, ' ').trim(); } // [v2.00.6] ชื่อที่บันทึก: ตัด * ท้ายชื่อ + ช่องว่างซ้ำ
        function stuRealCode(c) { c = String(c || '').trim(); return c && !/^0+$/.test(c) ? c : ''; }
        function stuImportPlan(rows) {
            const yr = String(settings.year), pool = students.filter(st => st.year === undefined || st.year === null || st.year === '' || String(st.year) === yr), used = new Set(), out = [];
            const byCode = {}; pool.forEach(st => { const c = stuRealCode(st.code); if (c) (byCode[c] = byCode[c] || []).push(st); });
            rows.forEach(r => {
                r.name = stuCleanName(r.name);
                const nn = stuNormName(r.name), code = stuRealCode(r.code); let st = null, how = '';
                if (code) { st = (byCode[code] || []).find(x => !used.has(x.id)) || null; if (st) how = 'เลขประจำตัว'; }
                if (!st) {
                    const same = pool.filter(x => x.roomId === r.roomId && !used.has(x.id) && stuNormName(x.name) === nn && (!code || !stuRealCode(x.code) || stuRealCode(x.code) === code));
                    st = same.find(x => x.number === r.number) || same[0] || null; if (st) how = 'ชื่อ';
                }
                if (!st && nn) { const other = pool.filter(x => x.roomId !== r.roomId && !used.has(x.id) && stuNormName(x.name) === nn && (!code || !stuRealCode(x.code) || stuRealCode(x.code) === code)); if (other.length === 1) { st = other[0]; how = 'ชื่อ (ห้องอื่น)'; } }
                if (st) {
                    used.add(st.id);
                    const ch = [];
                    if (st.roomId !== r.roomId) ch.push(`ห้อง ${formatRoomName(st.roomId)} → ${formatRoomName(r.roomId)}`);
                    if (String(st.number) !== String(r.number)) ch.push(`เลขที่ ${st.number} → ${r.number}`);
                    if (code && stuRealCode(st.code) !== code) ch.push(stuRealCode(st.code) ? `เลขประจำตัว ${st.code} → ${code}` : `ใส่เลขประจำตัว ${code}`);
                    if (st.name !== r.name) ch.push(`ชื่อ "${st.name}" → "${r.name}"`);
                    const want = r.left ? 'resigned' : 'active', had = st.status || 'active';
                    if (had !== want) ch.push(`สถานะ ${STU_ST[had] || had} → ${STU_ST[want]}`);
                    out.push({ type: st.roomId !== r.roomId ? 'move' : (ch.length ? 'update' : 'same'), row: r, st, how, ch });
                } else {
                    const clash = code && (byCode[code] || []).length ? (byCode[code][0]) : null;
                    out.push({ type: 'new', row: r, ch: clash ? [`เลขประจำตัว ${code} ซ้ำกับ ${clash.name} (${formatRoomName(clash.roomId)}) — ไม่ใส่เลขประจำตัวให้`] : [], noCode: !!clash });
                }
            });
            const rooms = new Set(rows.map(r => r.roomId));
            const missing = pool.filter(x => rooms.has(x.roomId) && !used.has(x.id) && x.status !== 'resigned' && x.status !== 'hidden');
            return { items: out, missing, missAct: {} }; // missAct[id] = keep | hidden | resigned | delete
        }
        const STU_ST = { active: 'เรียนอยู่', resigned: 'ออก/ย้าย', hidden: 'ซ่อน' };
        function stuApplyPlan(plan) {
            let n = 0;
            plan.items.forEach(it => {
                const r = it.row, code = stuRealCode(r.code);
                if (it.type === 'new') { students.push(Object.assign({ id: generateId(), roomId: r.roomId, number: r.number, name: r.name, status: r.left ? 'resigned' : 'active' }, code && !it.noCode ? { code } : (String(r.code || '').trim() ? { code: String(r.code).trim() } : {}))); n++; return; }
                if (it.type === 'same') return;
                const st = students.find(x => x.id === it.st.id); if (!st) return; // หาใหม่จากข้อมูลล่าสุด (เผื่อมีการซิงก์ระหว่างดูตัวอย่าง)
                st.roomId = r.roomId; st.number = r.number; st.name = r.name; if (code) st.code = code; st.status = r.left ? 'resigned' : 'active'; n++;
            });
            // [v2.00.6] นักเรียนในระบบที่ไม่มีในไฟล์: ซ่อน / ออก-ย้าย / ลบ (ค่าเริ่มต้น = คงไว้)
            const del = new Set();
            Object.keys(plan.missAct || {}).forEach(id => { const a = plan.missAct[id], st = students.find(x => x.id === id); if (!st) return; if (a === 'hidden' || a === 'resigned') { st.status = a; n++; } else if (a === 'delete') del.add(id); });
            if (del.size) { students = students.filter(x => !del.has(x.id)); n += del.size; }
            return n;
        }
        // ตัวอย่างก่อนบันทึก · onOk(plan) = บันทึก
        function stuShowPlan(plan, roomsLabel, onOk) {
            const esc = (t) => String(t == null ? '' : t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
            // [v2.00.5] สีตามโหมดมืด/สว่าง (ใส่สีตัวอักษรเองทุกจุด — ไม่พึ่งสีที่สืบทอดจากหน้าเว็บ)
            const dk = document.documentElement.classList.contains('dark');
            const P = dk ? { bg: '#141e33', text: '#e2e8f0', sub: '#94a3b8', line: '#26324d', head: '#1c2843', headT: '#cbd5e1', foot: '#e2e8f0', noBg: 'rgba(244,63,94,.18)', noT: '#fda4af', chipOff: '#1c2843', chipLine: '#334155' }
                       : { bg: '#ffffff', text: '#0f172a', sub: '#64748b', line: '#f1f5f9', head: '#f8fafc', headT: '#475569', foot: '#334155', noBg: '#fef2f2', noT: '#dc2626', chipOff: '#ffffff', chipLine: '#e2e8f0' };
            const cnt = { update: 0, move: 0, new: 0, same: 0 }; plan.items.forEach(it => cnt[it.type]++);
            const cats = [['all', 'ทั้งหมด', plan.items.length, dk ? '#cbd5e1' : '#334155'], ['update', 'ตรงกัน · อัปเดต', cnt.update, dk ? '#a5b4fc' : '#4f46e5'], ['same', 'ตรงกัน · ไม่เปลี่ยน', cnt.same, dk ? '#94a3b8' : '#64748b'], ['move', 'ย้ายห้อง', cnt.move, dk ? '#fbbf24' : '#d97706'], ['new', 'เพิ่มใหม่', cnt.new, dk ? '#34d399' : '#059669'], ['missing', 'ในระบบแต่ไม่มีในไฟล์ (เลือก ซ่อน / ออก / ลบ)', plan.missing.length, dk ? '#fb7185' : '#dc2626']];
            const TAG = dk ? { update: ['rgba(99,102,241,.22)', '#c7d2fe', 'อัปเดต'], same: ['rgba(148,163,184,.18)', '#cbd5e1', 'ไม่เปลี่ยน'], move: ['rgba(245,158,11,.2)', '#fcd34d', 'ย้ายห้อง'], new: ['rgba(16,185,129,.2)', '#6ee7b7', 'เพิ่มใหม่'] }
                           : { update: ['#eef2ff', '#4338ca', 'อัปเดต'], same: ['#f1f5f9', '#64748b', 'ไม่เปลี่ยน'], move: ['#fffbeb', '#b45309', 'ย้ายห้อง'], new: ['#ecfdf5', '#047857', 'เพิ่มใหม่'] };
            const td = `padding:7px 8px;border-top:1px solid ${P.line};color:${P.text};background:${P.bg}`;
            const chip = (t) => `<span style="background:${t[0]};color:${t[1]};border-radius:99px;padding:1px 8px;font-weight:800;font-size:11px">${t[2]}</span>`;
            let el = document.getElementById('stuPlanModal'); if (el) el.remove();
            el = document.createElement('div'); el.id = 'stuPlanModal';
            el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(2,6,23,.6);display:flex;align-items:center;justify-content:center;padding:12px';
            let cat = 'all', askDel = false;
            const MISS_OPT = [['keep', 'คงไว้'], ['hidden', 'ซ่อน'], ['resigned', 'ออก/ย้าย'], ['delete', 'ลบ']];
            const draw = () => {
                const list = cat === 'missing' ? plan.missing.map(st => ({ type: 'missing', st })) : plan.items.filter(it => cat === 'all' || it.type === cat);
                const rows = list.slice(0, 400).map(it => {
                    if (it.type === 'missing') { const a = plan.missAct[it.st.id] || 'keep'; return `<tr><td style="${td}">${esc(formatRoomName(it.st.roomId))}</td><td style="${td}">${esc(it.st.number)}</td><td style="${td}">${esc(it.st.code || '-')}</td><td style="${td}">${esc(it.st.name)}</td><td style="${td}"><select data-stp-act="${esc(it.st.id)}" style="background:${P.bg};color:${a === 'delete' ? P.noT : P.text};border:1px solid ${P.chipLine};border-radius:8px;padding:4px 6px;font-size:13px;font-weight:700">${MISS_OPT.map(o => `<option value="${o[0]}"${a === o[0] ? ' selected' : ''}>${o[1]}</option>`).join('')}</select></td></tr>`; }
                    const r = it.row;
                    return `<tr><td style="${td}">${esc(formatRoomName(r.roomId))}</td><td style="${td}">${esc(r.number)}</td><td style="${td}">${esc(r.code || '-')}</td><td style="${td}">${esc(r.name)}</td><td style="${td}">${chip(TAG[it.type])}${it.how ? ` <span style="color:${P.sub};font-size:11px">ตรงกันด้วย${esc(it.how)}</span>` : ''}${it.ch.length ? `<div style="color:${P.sub};font-size:12px;margin-top:2px">${it.ch.map(esc).join(' · ')}</div>` : ''}</td></tr>`;
                }).join('');
                const ma = { hidden: 0, resigned: 0, delete: 0 }; Object.values(plan.missAct).forEach(a => { if (ma[a] !== undefined) ma[a]++; });
                const can = cnt.update + cnt.move + cnt.new + ma.hidden + ma.resigned + ma.delete;
                el.innerHTML = `<div style="background:${P.bg};color:${P.text};border:1px solid ${P.chipLine};border-radius:22px;max-width:980px;width:100%;max-height:92vh;display:flex;flex-direction:column;box-shadow:0 20px 50px rgba(0,0,0,.35);overflow:hidden">
                  <div style="padding:16px 20px 8px;background:${P.bg}"><div style="font-size:19px;font-weight:800;color:${P.text}"><i class="fas fa-user-check" style="color:${dk ? '#a5b4fc' : '#4f46e5'}"></i> ตรวจรายชื่อก่อนนำเข้า · ${esc(roomsLabel)}</div>
                  <div style="color:${P.sub};font-size:13px;margin-top:2px">จับคู่ด้วย <b style="color:${P.text}">เลขประจำตัว</b> ก่อน แล้วจึงใช้ <b style="color:${P.text}">ชื่อ</b> (ไม่สนคำนำหน้า ด.ช. / เด็กชาย / นาย และช่องว่าง) · ตรงกัน = แก้ข้อมูลคนเดิม (ประวัติเช็คชื่อยังอยู่) · ไม่พบ = เพิ่มใหม่ · นักเรียนที่ไม่มีในไฟล์จะไม่ถูกลบ</div>
                  <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:10px">${cats.map(c => `<button type="button" data-stp-cat="${c[0]}" style="border:2px solid ${cat === c[0] ? c[3] : P.chipLine};background:${cat === c[0] ? c[3] : P.chipOff};color:${cat === c[0] ? (dk ? '#0b1222' : '#fff') : c[3]};border-radius:99px;padding:4px 12px;font-weight:800;font-size:13px;cursor:pointer">${c[1]} ${c[2]}</button>`).join('')}</div></div>
                  ${cat === 'missing' && plan.missing.length ? `<div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:4px 20px 8px;background:${P.bg};color:${P.sub};font-size:13px;font-weight:700">ทั้งหมดในกลุ่มนี้: ${MISS_OPT.map(o => `<button type="button" data-stp-all="${o[0]}" style="border:1px solid ${P.chipLine};background:${P.chipOff};color:${o[0] === 'delete' ? P.noT : P.text};border-radius:99px;padding:3px 11px;font-weight:800;font-size:12.5px;cursor:pointer">${o[1]}</button>`).join('')}<span style="font-weight:500">· แนะนำ "ซ่อน" สำหรับนักเรียนแขวนลอย / "ออก/ย้าย" สำหรับคนที่ย้ายออก — ประวัติยังอยู่ทั้งคู่</span></div>` : ''}
                  <div style="overflow:auto;padding:0 20px;flex:1;background:${P.bg}"><table style="width:100%;border-collapse:collapse;font-size:13.5px;background:${P.bg}"><thead><tr style="text-align:left">${['ห้อง', 'เลขที่', 'เลขประจำตัว', 'ชื่อ (ในไฟล์)', 'ผล'].map(h => `<th style="padding:8px;background:${P.head};color:${P.headT};font-weight:800;position:sticky;top:0">${h}</th>`).join('')}</tr></thead><tbody>${rows || `<tr><td colspan="5" style="${td};text-align:center;color:${P.sub}">ไม่มีรายการ</td></tr>`}</tbody></table>${list.length > 400 ? `<p style="color:${P.sub};font-size:12px">แสดง 400 รายการแรก</p>` : ''}</div>
                  <div style="display:flex;gap:8px;justify-content:flex-end;align-items:center;padding:12px 20px;border-top:1px solid ${P.line};flex-wrap:wrap;background:${P.bg}"><span style="margin-right:auto;color:${P.foot};font-size:13px;font-weight:700">จะบันทึก: อัปเดต ${cnt.update} · ย้ายห้อง ${cnt.move} · เพิ่มใหม่ ${cnt.new} คน${ma.hidden ? ` · ซ่อน ${ma.hidden}` : ''}${ma.resigned ? ` · ออก/ย้าย ${ma.resigned}` : ''}${ma.delete ? ` · <span style="color:${P.noT}">ลบ ${ma.delete}</span>` : ''}</span><button type="button" data-stp-no style="border:0;background:${P.noBg};color:${P.noT};font-weight:800;border-radius:12px;padding:9px 16px;cursor:pointer">ยกเลิก</button><button type="button" data-stp-ok ${can ? '' : 'disabled'} style="border:0;background:${askDel ? '#dc2626' : '#059669'};color:#fff;font-weight:800;border-radius:12px;padding:9px 16px;cursor:pointer;opacity:${can ? 1 : .5}"><i class="fas fa-${askDel ? 'trash' : 'check'}"></i> ${askDel ? 'ยืนยันลบ ' + ma.delete + ' คน และนำเข้า' : 'ยืนยันนำเข้า'}</button></div>${askDel ? `<div style="padding:10px 20px;background:${P.noBg};color:${P.noT};font-size:13px;font-weight:700"><i class="fas fa-exclamation-triangle"></i> จะลบนักเรียน ${ma.delete} คนออกจากระบบ — ประวัติการเช็คชื่อของคนที่ลบจะดูไม่ได้อีก (กู้ได้จากไฟล์สำรองเท่านั้น) · ถ้าไม่แน่ใจ ให้เลือก "ซ่อน" แทน · กดปุ่มแดงอีกครั้งเพื่อยืนยัน</div>` : ''}</div>`;
            };
            draw(); document.body.appendChild(el);
            el.addEventListener('click', (ev) => {
                const c = ev.target.closest('[data-stp-cat]'); if (c) { cat = c.getAttribute('data-stp-cat'); draw(); return; }
                const all = ev.target.closest('[data-stp-all]'); if (all) { const v = all.getAttribute('data-stp-all'); plan.missing.forEach(st => { if (v === 'keep') delete plan.missAct[st.id]; else plan.missAct[st.id] = v; }); askDel = false; draw(); return; }
                if (ev.target.closest('[data-stp-no]')) { el.remove(); return; }
                if (ev.target.closest('[data-stp-ok]')) {
                    const nDel = Object.values(plan.missAct).filter(a => a === 'delete').length;
                    if (nDel && !askDel) { askDel = true; draw(); return; } // ลบ = ต้องกดยืนยันอีกครั้ง
                    el.remove(); onOk(plan);
                }
            });
            el.addEventListener('change', (ev) => { const sl = ev.target.closest('[data-stp-act]'); if (!sl) return; const id = sl.getAttribute('data-stp-act'); if (sl.value === 'keep') delete plan.missAct[id]; else plan.missAct[id] = sl.value; askDel = false; const y = el.querySelector('[style*="overflow:auto"]'), top = y ? y.scrollTop : 0; draw(); const y2 = el.querySelector('[style*="overflow:auto"]'); if (y2) y2.scrollTop = top; });
        }
        function stuReadRows(file, parse, done) {
            showProgressModal('กำลังอ่านไฟล์รายชื่อนักเรียน', 'กำลังอ่านไฟล์...'); const reader = new FileReader();
            reader.onload = async function(evt) {
                try {
                    updateProgressModal(30, 'กำลังดึงข้อมูลล่าสุดจากเซิร์ฟเวอร์...');
                    const prefetch = await refreshBeforeEdit(['students']);
                    const wb = XLSX.read(new Uint8Array(evt.target.result), { type: 'array' }), json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
                    const res = parse(json, wb);
                    if (!res.rows.length) { errorProgressModal(res.err || 'ไม่พบข้อมูลที่ถูกต้องในไฟล์'); return; }
                    updateProgressModal(70, 'กำลังจับคู่รายชื่อ...');
                    const plan = stuImportPlan(res.rows); closeProgressModal();
                    done(plan, res, prefetch);
                } catch (err) { errorProgressModal('เกิดข้อผิดพลาดในการอ่านไฟล์ กรุณาตรวจสอบรูปแบบไฟล์'); }
            };
            reader.readAsArrayBuffer(file);
        }
        async function stuSavePlan(plan, prefetch, logLabel) {
            showProgressModal('กำลังนำเข้ารายชื่อนักเรียน', 'กำลังสำรองข้อมูลก่อนนำเข้า...');
            try { await snapshotNowReq('before_import'); } catch (e) { errorProgressModal('สำรองข้อมูลก่อนนำเข้าไม่สำเร็จ — ยังไม่ได้บันทึกอะไร กรุณาลองใหม่อีกครั้ง'); return; } // [v2.00.7] สำรองก่อนทุกครั้ง
            updateProgressModal(30, 'กำลังบันทึก...');
            try {
                const cnt = { update: 0, move: 0, new: 0 }; plan.items.forEach(it => { if (cnt[it.type] !== undefined) cnt[it.type]++; });
                const ma = { hidden: 0, resigned: 0, delete: 0 }; Object.values(plan.missAct || {}).forEach(a => { if (ma[a] !== undefined) ma[a]++; });
                const n = stuApplyPlan(plan); updateProgressModal(70, 'กำลังบันทึกขึ้นเซิร์ฟเวอร์...');
                await saveData('full', null, prefetch);
                const extra = (ma.hidden ? ` · ซ่อน ${ma.hidden}` : '') + (ma.resigned ? ` · ออก/ย้าย ${ma.resigned}` : '') + (ma.delete ? ` · ลบ ${ma.delete}` : '');
                logAction('นำเข้ารายชื่อนักเรียนจาก Excel', `${logLabel}: อัปเดต ${cnt.update} · ย้ายห้อง ${cnt.move} · เพิ่มใหม่ ${cnt.new}${extra}`);
                completeProgressModal('นำเข้าสำเร็จ', `อัปเดต ${cnt.update} คน · ย้ายห้อง ${cnt.move} คน · เพิ่มใหม่ ${cnt.new} คน${extra}`); renderAdminTab();
                return n;
            } catch (e) { errorProgressModal('บันทึกไม่สำเร็จ กรุณาลองใหม่อีกครั้ง'); }
        }
        window.handleImportStudents = function(e) {
            const file = e.target.files[0]; e.target.value = ''; if (!file) return;
            const roomId = window.adminSelectedRoom;
            stuReadRows(file, (json, wb) => {
                if (wb && stuIsSchoolFile(wb)) { // [v2.00.6] ไฟล์แบบของโรงเรียน: ใช้เฉพาะห้องที่เลือก (แผ่นแรกที่มีห้องนี้ · แนะนำใช้ "นำเข้าทุกห้อง" เพื่อเลือกแผ่นงาน)
                    const names = wb.SheetNames.filter(n => /มีต[ัั]?วตน/.test(n)).concat(wb.SheetNames.filter(n => !/มีต[ัั]?วตน/.test(n)));
                    for (const n of names) { const b = stuSchoolBlocks(wb.Sheets[n]); if (b[roomId] && b[roomId].length) return { rows: b[roomId], sheet: n.trim() }; }
                    return { rows: [], err: 'ไม่พบห้อง ' + formatRoomName(roomId) + ' ในไฟล์นี้' };
                }
                const startIndex = (json.length > 0 && String(json[0][0]).includes('เลขที่')) ? 1 : 0, rows = [];
                for (let i = startIndex; i < json.length; i++) {
                    const row = json[i]; if (!row || row.length < 2 || !row[0] || !(String(row[2] || '').trim() || String(row[1] || '').trim())) continue; // [v2.00.4] เลขประจำตัวว่างได้ (เดิมข้ามทั้งแถว)
                    if (String(row[0]).trim().startsWith('หมายเหตุ')) continue;
                    // [v1.76] 3 คอลัมน์ = เลขที่ | เลขประจำตัว | ชื่อ · 2 คอลัมน์ (ไฟล์เดิม) = เลขที่ | ชื่อ
                    const has3 = row.length >= 3 && String(row[2] || '').trim();
                    rows.push({ roomId, number: String(row[0]).trim(), name: String(has3 ? row[2] : row[1]).trim(), code: has3 ? String(row[1] || '').trim().slice(0, 20) : '' });
                }
                return { rows };
            }, (plan, res, prefetch) => stuShowPlan(plan, 'ห้อง ' + formatRoomName(roomId) + (res.sheet ? ' · แผ่น ' + res.sheet : ''), (pl) => stuSavePlan(pl, prefetch, 'ห้อง ' + formatRoomName(roomId))));
        };

        window.downloadStudentTemplate = function() {
            const ws_data = [ ["เลขที่", "เลขประจำตัว", "คำนำหน้า+ชื่อ-นามสกุล"], ["1", "34512", "ด.ช.รักเรียน เพียรศึกษา"], ["2", "34513", "ด.ญ.ใจดี มีเมตตา"], [], ["หมายเหตุ: ระบบจับคู่นักเรียนเดิมด้วยเลขประจำตัวก่อน แล้วจึงใช้ชื่อ — ตรงกัน = อัปเดตคนเดิม (ประวัติเช็คชื่อยังอยู่) · ไม่พบ = เพิ่มใหม่ · มีหน้าตรวจก่อนบันทึก"] ];
            const ws = XLSX.utils.aoa_to_sheet(ws_data); ws['!cols'] = [{wch: 10}, {wch: 14}, {wch: 35}];
            const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Template");
            XLSX.writeFile(wb, "แบบฟอร์มนำเข้านักเรียน.xlsx");
            showToast("ดาวน์โหลดแบบฟอร์มสำเร็จ", "success");
        };

        // แปลงป้ายห้อง เช่น "ม.1/1" กลับเป็น roomId เช่น "m1_1" (รองรับช่องว่างและรูปแบบเขียนต่างกันเล็กน้อย)
        function parseRoomLabel_(label) {
            if (!label) return null;
            const m = String(label).trim().match(/ม\.?\s*(\d+)\s*\/\s*(\d+)/);
            if (!m) return null;
            const roomId = `m${m[1]}_${m[2]}`;
            return getRoomList().includes(roomId) ? roomId : null;
        }

        window.downloadStudentTemplateAllRooms = function() {
            const sampleRooms = getRoomList().slice(0, 2);
            const ws_data = [ ["ห้อง", "เลขที่", "เลขประจำตัว", "คำนำหน้า+ชื่อ-นามสกุล"] ];
            if (sampleRooms[0]) ws_data.push([formatRoomName(sampleRooms[0]), "1", "34512", "ด.ช.รักเรียน เพียรศึกษา"], [formatRoomName(sampleRooms[0]), "2", "34513", "ด.ญ.ใจดี มีเมตตา"]);
            if (sampleRooms[1]) ws_data.push([formatRoomName(sampleRooms[1]), "1", "34600", "ด.ช.ขยัน ตั้งใจดี"]);
            ws_data.push([], ["หมายเหตุ: คอลัมน์ \"ห้อง\" ต้องเป็นรูปแบบ ม.X/Y เช่น ม.1/1, ม.4/2 ให้ตรงกับห้องที่มีอยู่ในระบบ"], ["สามารถใส่นักเรียนได้หลายห้องในไฟล์เดียว โดยเรียงแถวสลับห้องกันได้ตามสะดวก"], ["หมายเหตุ: ระบบจับคู่นักเรียนเดิมด้วยเลขประจำตัวก่อน แล้วจึงใช้ชื่อ (ย้ายห้องได้) — ตรงกัน = อัปเดตคนเดิม · ไม่พบ = เพิ่มใหม่ · มีหน้าตรวจก่อนบันทึก"]);
            const ws = XLSX.utils.aoa_to_sheet(ws_data); ws['!cols'] = [{wch: 12}, {wch: 10}, {wch: 14}, {wch: 35}];
            const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Template");
            XLSX.writeFile(wb, "แบบฟอร์มนำเข้านักเรียนทุกห้อง.xlsx");
            showToast("ดาวน์โหลดแบบฟอร์ม (ทุกห้อง) สำเร็จ", "success");
        };

        // ===== [v2.00.6] ไฟล์รายชื่อแบบของโรงเรียน: 1 แผ่นงาน = หลายห้องเรียงต่อกัน ("รายชื่อนักเรียนชั้นมัธยมศึกษาปีที่ 1/1 …" → ลำดับที่ | เลขประจำตัว | ชื่อ - สกุล)
        // เลือกแผ่นงานที่จะใช้ได้ (เช่น "มีตัวตน") · คอลัมน์ท้ายแถวมีคำว่า "ออก" = ออก/ย้าย
        function stuSchoolBlocks(ws) {
            const json = XLSX.utils.sheet_to_json(ws, { header: 1 }), out = {}; let cur = null;
            json.forEach(row => {
                const a = String((row && row[0]) ?? '').trim();
                const m = /ปีที่\s*(\d)\s*\/\s*(\d+)/.exec(a);
                if (m && /รายชื่อ/.test(a)) { cur = `m${m[1]}_${m[2]}`; out[cur] = out[cur] || []; return; }
                if (!cur || !/^\d+$/.test(a) || !String(row[2] ?? '').trim()) return;
                const rest = row.slice(3).map(x => String(x ?? '').trim()).filter(Boolean).join(' ');
                out[cur].push({ roomId: cur, number: a, code: String(row[1] ?? '').trim().slice(0, 20), name: String(row[2]).trim(), left: /ออก/.test(rest) });
            });
            return out;
        }
        function stuIsSchoolFile(wb) { return wb.SheetNames.some(n => { const j = XLSX.utils.sheet_to_json(wb.Sheets[n], { header: 1 }).slice(0, 6); return j.some(r => /รายชื่อนักเรียน.*ปีที่\s*\d\s*\/\s*\d+/.test(String((r && r[0]) ?? ''))); }); }
        function stuPickSheets(wb, onPick) {
            const info = wb.SheetNames.map(n => { const b = stuSchoolBlocks(wb.Sheets[n]), rooms = Object.keys(b).filter(r => b[r].length); return { n, rooms, cnt: rooms.reduce((a, r) => a + b[r].length, 0), left: rooms.reduce((a, r) => a + b[r].filter(x => x.left).length, 0) }; }).filter(x => x.rooms.length);
            const pref = info.filter(x => /มีต[ัั]?วตน/.test(x.n));
            const sel = new Set((pref.length ? pref : info).map(x => x.n));
            const dk = document.documentElement.classList.contains('dark'), P = dk ? { bg: '#141e33', text: '#e2e8f0', sub: '#94a3b8', line: '#26324d' } : { bg: '#fff', text: '#0f172a', sub: '#64748b', line: '#e2e8f0' };
            const esc = (t) => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
            const el = document.createElement('div'); el.id = 'stuPickModal';
            el.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(2,6,23,.6);display:flex;align-items:center;justify-content:center;padding:12px';
            const draw = () => {
                const dupRooms = {}; info.filter(x => sel.has(x.n)).forEach(x => x.rooms.forEach(r => { (dupRooms[r] = dupRooms[r] || []).push(x.n); }));
                const dup = Object.keys(dupRooms).filter(r => dupRooms[r].length > 1);
                el.innerHTML = `<div style="background:${P.bg};color:${P.text};border:1px solid ${P.line};border-radius:22px;max-width:640px;width:100%;max-height:92vh;overflow:auto;padding:18px 20px;box-shadow:0 20px 50px rgba(0,0,0,.35)">
                  <div style="font-size:19px;font-weight:800;color:${P.text}"><i class="fas fa-layer-group" style="color:${dk ? '#a5b4fc' : '#4f46e5'}"></i> เลือกแผ่นงานที่จะนำเข้า</div>
                  <div style="color:${P.sub};font-size:13px;margin:4px 0 10px">ไฟล์นี้เป็นรายชื่อแบบของโรงเรียน (หลายห้องในแผ่นเดียว) · ห้องเดียวกันเลือกได้แผ่นเดียว · แนะนำแผ่น "มีตัวตน" (นักเรียนที่มาเรียนจริง) — คนที่อยู่ในระบบแต่ไม่มีในแผ่นที่เลือก ไปจัดการได้ในหน้าถัดไป (ซ่อน / ออก/ย้าย / ลบ)</div>
                  ${info.map(x => `<label style="display:flex;gap:10px;align-items:flex-start;border:2px solid ${sel.has(x.n) ? (dk ? '#818cf8' : '#4f46e5') : P.line};border-radius:14px;padding:9px 12px;margin-bottom:6px;cursor:pointer;color:${P.text}"><input type="checkbox" data-pk="${esc(x.n)}" ${sel.has(x.n) ? 'checked' : ''} style="margin-top:4px;width:16px;height:16px"><span><b style="color:${P.text}">${esc(x.n.trim())}</b><span style="display:block;color:${P.sub};font-size:12.5px">${x.rooms.length} ห้อง (${x.rooms.map(formatRoomName).join(', ')}) · ${x.cnt} คน${x.left ? ` · มีเครื่องหมาย "ออก" ${x.left} คน (จะตั้งเป็น ออก/ย้าย)` : ''}</span></span></label>`).join('')}
                  ${dup.length ? `<div style="color:#dc2626;font-weight:700;font-size:13px;margin-top:6px"><i class="fas fa-exclamation-triangle"></i> ห้องซ้ำกันหลายแผ่น: ${dup.map(r => formatRoomName(r) + ' (' + dupRooms[r].map(n => n.trim()).join(' / ') + ')').join(' · ')} — เลือกแผ่นเดียวต่อห้อง</div>` : ''}
                  <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px"><button type="button" data-pk-no style="border:0;background:${dk ? 'rgba(244,63,94,.18)' : '#fef2f2'};color:${dk ? '#fda4af' : '#dc2626'};font-weight:800;border-radius:12px;padding:9px 16px;cursor:pointer">ยกเลิก</button><button type="button" data-pk-ok ${sel.size && !dup.length ? '' : 'disabled'} style="border:0;background:#4f46e5;color:#fff;font-weight:800;border-radius:12px;padding:9px 16px;cursor:pointer;opacity:${sel.size && !dup.length ? 1 : .5}">ถัดไป <i class="fas fa-arrow-right"></i></button></div></div>`;
            };
            draw(); document.body.appendChild(el);
            el.addEventListener('change', (ev) => { const c = ev.target.closest('[data-pk]'); if (!c) return; const n = c.getAttribute('data-pk'); if (c.checked) sel.add(n); else sel.delete(n); draw(); });
            el.addEventListener('click', (ev) => {
                if (ev.target.closest('[data-pk-no]')) { el.remove(); return; }
                if (ev.target.closest('[data-pk-ok]')) { el.remove(); onPick(Array.from(sel)); }
            });
        }
        window.handleImportStudentsAllRooms = function(e) {
            const file = e.target.files[0]; e.target.value = ''; if (!file) return;
            showProgressModal('กำลังอ่านไฟล์รายชื่อนักเรียน', 'กำลังอ่านไฟล์...'); const reader = new FileReader();
            reader.onload = async function(evt) {
                let wb, prefetch;
                try {
                    updateProgressModal(30, 'กำลังดึงข้อมูลล่าสุดจากเซิร์ฟเวอร์...');
                    prefetch = await refreshBeforeEdit(['students']);
                    wb = XLSX.read(new Uint8Array(evt.target.result), { type: 'array' });
                } catch (err) { errorProgressModal('เกิดข้อผิดพลาดในการอ่านไฟล์ กรุณาตรวจสอบรูปแบบไฟล์'); return; }
                const go = (rows, label, skipped) => {
                    if (!rows.length) { errorProgressModal('ไม่พบข้อมูลที่ถูกต้อง หรือชื่อห้องในไฟล์ไม่ตรงกับห้องในระบบ'); return; }
                    const plan = stuImportPlan(rows); closeProgressModal();
                    const nRooms = new Set(rows.map(r => r.roomId)).size;
                    stuShowPlan(plan, nRooms + ' ห้อง' + (label ? ' · ' + label : '') + (skipped ? ' (ข้าม ' + skipped + ' ห้อง/แถวที่ไม่มีในระบบ)' : ''), (pl) => stuSavePlan(pl, prefetch, nRooms + ' ห้อง'));
                };
                if (stuIsSchoolFile(wb)) {
                    closeProgressModal();
                    stuPickSheets(wb, (names) => {
                        const rooms = getRoomList(), rows = []; let skipped = 0;
                        names.forEach(n => { const b = stuSchoolBlocks(wb.Sheets[n]); Object.keys(b).forEach(r => { if (!rooms.includes(r)) { skipped++; return; } b[r].forEach(x => rows.push(x)); }); });
                        go(rows, names.map(n => n.trim()).join(', '), skipped);
                    });
                    return;
                }
                const json = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
                const startIndex = (json.length > 0 && String(json[0][0] || '').includes('ห้อง')) ? 1 : 0, rows = []; let skippedRoom = 0;
                for (let i = startIndex; i < json.length; i++) {
                    const row = json[i];
                    if (!row || row.length < 3 || !row[0] || !row[1] || !(String(row[3] || '').trim() || String(row[2] || '').trim())) continue; // [v2.00.4] เลขประจำตัวว่างได้
                    if (String(row[0]).trim().startsWith('หมายเหตุ') || String(row[0]).trim().startsWith('สามารถ')) continue;
                    const roomId = parseRoomLabel_(row[0]); if (!roomId) { skippedRoom++; continue; }
                    const has4 = row.length >= 4 && String(row[3] || '').trim(); // [v1.76] ห้อง | เลขที่ | เลขประจำตัว | ชื่อ (ไฟล์เดิม 3 คอลัมน์ยังใช้ได้)
                    rows.push({ roomId, number: String(row[1]).trim(), name: String(has4 ? row[3] : row[2]).trim(), code: has4 ? String(row[2] || '').trim().slice(0, 20) : '' });
                }
                go(rows, '', skippedRoom);
            };
            reader.readAsArrayBuffer(file);
        };

        window.exportAllStudentsExcel = function(roomId) {
            const roomName = formatRoomName(roomId), roomStudents = getRoomStudents(roomId).sort((a,b) => parseInt(a.number) - parseInt(b.number)), roomSubjects = getRoomSubjects(roomId);
            let ws_data = [ ["รายงานสรุปภาพรวมทั้งหมด", `ห้อง ${roomName}`], [], ["เลขที่", "เลขประจำตัว", "คำนำหน้า+ชื่อ-นามสกุล", "สถานะ"] ]; roomSubjects.forEach(sub => ws_data[2].push(`รวม ${sub.name}`));
            roomStudents.forEach(st => {
                let row = [st.number, st.code || '', st.name, st.status === 'resigned' ? 'ออก/ย้าย' : 'เรียนอยู่'];
                roomSubjects.forEach(sub => { let count = 0; attendanceData.filter(a => a.subjectId === sub.id).forEach(att => { if (att.records[st.id] === 'มา' || att.records[st.id] === 'ร่วมกิจกรรม' || att.records[st.id] === 'สาย') count++; }); row.push(count); });
                ws_data.push(row);
            });
            const ws = XLSX.utils.aoa_to_sheet(ws_data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Summary"); XLSX.writeFile(wb, `สรุปทั้งหมด_ห้อง_${roomName}.xlsx`);
        };
        window.exportSubjectExcel = function(subjectId) {
            const subject = subjects.find(s => s.id === subjectId), roomStudents = getRoomStudents(subject.roomId).sort((a, b) => parseInt(a.number) - parseInt(b.number)), subjectAtt = attendanceData.filter(a => a.subjectId === subjectId).sort((a, b) => new Date(a.date) - new Date(b.date) || parseInt(a.period || 0) - parseInt(b.period || 0));
            let uniqueCols = []; subjectAtt.forEach(att => { const key = `${att.date}_${att.period}`; if (!uniqueCols.find(c => c.key === key)) uniqueCols.push({ date: att.date, period: att.period, data: att.records, subTeacher: att.substituteTeacher }); });
            let ws_data = []; let header = ["เลขที่", "เลขประจำตัว", "ชื่อ-นามสกุล", "สถานะ"]; uniqueCols.forEach(col => header.push(`${col.date} (ค.${col.period||'-'})${col.subTeacher ? `\n[แทน: ${col.subTeacher}]` : ''}`)); header.push("รวมมาเรียน");
            header.push("หมายเหตุ"); ws_data.push(header);
            roomStudents.forEach(st => {
                let row = [st.number, st.code || '', `${st.name}`, st.status === 'resigned' ? 'ออก/ย้าย' : 'เรียนอยู่']; let valid = 0, late = 0, absent = 0;
                uniqueCols.forEach(col => { const status = col.data[st.id] || '-'; if(status === 'มา' || status === 'ร่วมกิจกรรม') valid++; if(status === 'สาย') late++; if(status === 'ขาด') absent++; row.push(status); }); row.push(valid); 
                let remarks = []; if(late >= (settings.thresholds?.late||4)) remarks.push(`สาย ${late}`); if(absent >= (settings.thresholds?.absent||4)) remarks.push(`ขาด ${absent}`); row.push(remarks.length > 0 ? remarks.join(', ') + ' ครั้ง' : '');
                ws_data.push(row);
            });
            const ws = XLSX.utils.aoa_to_sheet(ws_data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Attendance"); XLSX.writeFile(wb, `วิชา_${subject.name}_ห้อง_${formatRoomName(subject.roomId)}.xlsx`);
        }

        window.exportRoomMonthlyExcel = function(roomId, month) {
            const report = window.tempRoomReport;
            if(!report || report.roomId !== roomId) return; const roomName = formatRoomName(roomId);
            let ws_data = [ ["รายงานห้องเรียน", `ห้อง ${roomName}`, `เดือน ${month}`], [], ["เลขที่", "เลขประจำตัว", "ชื่อ-นามสกุล", "สถานะ", "ส.1", "ส.2", "ส.3", "ส.4", "ส.5", "รวมมาเรียน", "สาย(แยก)", "ลาป่วย", "ลากิจ", "ขาด", "โดด"] ];
            report.data.forEach(row => { let valid = row.monthly['มา'] + row.monthly['ร่วมกิจกรรม'] + row.monthly['สาย']; ws_data.push([ row.student.number, row.student.code || '', `${row.student.name}`, row.student.status === 'resigned' ? 'ออก/ย้าย' : 'เรียนอยู่', row.weekly[1]||0, row.weekly[2]||0, row.weekly[3]||0, row.weekly[4]||0, row.weekly[5]||0, valid||0, row.monthly['สาย']||0, row.monthly['ลาป่วย']||0, row.monthly['ลากิจ']||0, row.monthly['ขาด']||0, row.monthly['โดดเรียน']||0 ]); });
            const ws = XLSX.utils.aoa_to_sheet(ws_data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, `Summary`); XLSX.writeFile(wb, `สรุปภาพรวมห้อง_${roomName}_${month}.xlsx`);
        }
        
        window.exportRoomDailyExcel = function(roomId, date) {
            const roomName = formatRoomName(roomId), roomStudents = getRoomStudents(roomId).sort((a,b) => parseInt(a.number) - parseInt(b.number)), roomSubjects = getRoomSubjects(roomId);
            const dObj = new Date(date); const dayOfWeek = dObj.getDay(); let dayIndexForSched = getEffectiveDayOfWeek(date);
            const subjectsToday = []; roomSubjects.forEach(s => { if (s.schedules) { effSched(s).forEach(sch => { if (parseInt(sch.day) === dayIndexForSched) { subjectsToday.push({ ...s, period: parseInt(sch.period) }); } }); } });
            subjectsToday.sort((a,b) => a.period - b.period);
            const dailyAttRecords = attendanceData.filter(a => a.date === date && subjectsToday.some(st => st.id === a.subjectId && String(st.period) === String(a.period)));
            let ws_data = [ ["รายงานการเช็คชื่อประจำวัน", `ห้อง ${roomName}`, `ประจำวันที่ ${date}`], [], ["เลขที่", "เลขประจำตัว", "ชื่อ-นามสกุล", "สถานะ"] ];
            if (subjectsToday.length === 0) { ws_data[2].push("ไม่มีวิชาเรียน");
            } else { subjectsToday.forEach(sub => ws_data[2].push(`${sub.name} (ค.${sub.period})`)); }
            roomStudents.forEach(st => {
                let row = [st.number, st.code || '', `${st.name}`, st.status === 'resigned' ? 'ออก/ย้าย' : 'เรียนอยู่'];
                if (subjectsToday.length === 0) { row.push("-"); } else { subjectsToday.forEach(sub => { const attRecord = dailyAttRecords.find(a => a.subjectId === sub.id && String(a.period) === String(sub.period)); if (attRecord && attRecord.records[st.id]) { row.push(attRecord.records[st.id]); } else { row.push("-"); } }); 
                }
                ws_data.push(row);
            });
            const ws = XLSX.utils.aoa_to_sheet(ws_data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, `Daily`); XLSX.writeFile(wb, `สรุปรายวัน_ห้อง_${roomName}_${date}.xlsx`);
        };
        window.exportStudentExcel = function(studentId, month) {
            const data = window.tempStudentReport;
            if(!data) return;
            let ws_data = [ ["รายงานส่วนบุคคล", `เดือน ${month}`], ["ชื่อ:", `${data.student.name}`, "เลขที่:", data.student.number, "ห้อง:", data.room], [], ["สรุปรายเดือน", "มา", "กิจกรรม", "สาย", "ป่วย", "ลากิจ", "ขาด", "โดด"], ["", data.monthly['มา'], data.monthly['ร่วมกิจกรรม'], data.monthly['สาย'], data.monthly['ลาป่วย'], data.monthly['ลากิจ'], data.monthly['ขาด'], data.monthly['โดดเรียน']], [], ["สรุปสัปดาห์", "มา", "กิจกรรม", "สาย", "ป่วย", "ลากิจ", "ขาด", "โดด"] ];
            for(let i=1; i<=5; i++) ws_data.push([`สัปดาห์ ${i}`, data.weekly[i]['มา'], data.weekly[i]['ร่วมกิจกรรม'], data.weekly[i]['สาย'], data.weekly[i]['ลาป่วย'], data.weekly[i]['ลากิจ'], data.weekly[i]['ขาด'], data.weekly[i]['โดดเรียน']]);
            ws_data.push([]); ws_data.push(["ประวัติรายวัน (อิงจากคาบ)"]); ws_data.push(["วันที่", "สถานะ"]);
            data.dates.forEach(d => { ws_data.push([d, data.daily[d].status]); });
            const ws = XLSX.utils.aoa_to_sheet(ws_data); const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, ws, "Student"); XLSX.writeFile(wb, `รายงาน_${data.student.name}_${month}.xlsx`);
        }

        // ===== ส่งออกส่วนกราฟ/ภาพรวมเป็น Infographic แบบทั่วไป (PDF หรือรูปภาพ) ใช้ได้กับทุกส่วนที่มีกราฟ =====
        window.exportSectionInfographicPDF = async function(elementId, filenameBase, format = 'pdf') {
            const el = document.getElementById(elementId);
            if (!el) { showToast("ไม่พบข้อมูลสำหรับส่งออก", "error"); return; }
            showToast(`กำลังสร้างไฟล์ ${format === 'image' ? 'รูปภาพ' : 'PDF'} กรุณารอสักครู่...`, "success");
            const __wasDark = document.documentElement.classList.contains('dark'); if (__wasDark) document.documentElement.classList.remove('dark');
            // ===== [ใหม่] กันสระ/วรรณยุกต์ไทยที่อยู่ใต้บรรทัด (เช่น สระอุ สระอู) โดนตัดตอนแคปภาพ - เพิ่มระยะห่างบรรทัดชั่วคราวเฉพาะตอนส่งออก แล้วคืนค่าเดิมทันทีหลังเสร็จ =====
            const lineHeightFixStyle = document.createElement('style');
            lineHeightFixStyle.textContent = `#${elementId} * { line-height: 2 !important; }`;
            document.head.appendChild(lineHeightFixStyle);
            await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 400));
            // [v2.01.0] ใส่กรอบหัว/ท้ายเอกสารแบบเดียวกับรายงานอื่น (คัดลอกส่วนบนหน้าจอ + รูปกราฟ ลงกรอบ แล้วค่อยแคป)
            const frame = document.createElement('div'); frame.className = 'rp-frame';
            frame.style.cssText = `position:fixed;left:-30000px;top:0;width:${Math.max(760, el.offsetWidth + 64)}px;background:#fff;padding:0 32px 18px;box-sizing:border-box;font-family:'Sarabun','Noto Sans Thai',sans-serif;color:#0f172a`;
            const nowF = new Date(), stampF = `${nowF.getDate()} ${['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'][nowF.getMonth()]} ${nowF.getFullYear() + 543} ${String(nowF.getHours()).padStart(2, '0')}:${String(nowF.getMinutes()).padStart(2, '0')} น.`;
            frame.innerHTML = `<div style="height:48px;display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #4338ca;font-size:12px;color:#475569;margin-bottom:14px"><span>${settings.logoDataUrl ? `<img src="${settings.logoDataUrl}" style="width:24px;height:24px;border-radius:50%;object-fit:cover;vertical-align:middle;margin-right:8px;display:inline">` : ''}<b style="color:#312e81">${rpEsc(settings.title || 'ระบบเช็คชื่อ')}</b></span><span>${rpEsc(String(filenameBase || '').replace(/_/g, ' '))}</span></div><div class="rp-frame-body"></div><div style="margin-top:14px;height:30px;border-top:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#94a3b8"><span>${rpEsc(rpTermText())} · ข้อมูล ณ ${stampF}</span><span>${rpEsc(settings.title || '')}</span></div>`;
            const cl = el.cloneNode(true); cl.removeAttribute('id'); frame.querySelector('.rp-frame-body').appendChild(cl); document.body.appendChild(frame);
            const srcC = el.querySelectorAll('canvas'), dstC = cl.querySelectorAll('canvas'); srcC.forEach((c, i) => { try { if (dstC[i]) { dstC[i].width = c.width; dstC[i].height = c.height; dstC[i].getContext('2d').drawImage(c, 0, 0); } } catch (e) { /* ข้าม */ } });
            lineHeightFixStyle.textContent += ` .rp-frame * { line-height: 2 !important; }`;
            await new Promise(resolve => setTimeout(resolve, 200));
            try {
                const canvas = await html2canvas(frame, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false });
                if (format === 'image') {
                    const pngData = canvas.toDataURL('image/png', 1.0);
                    const link = document.createElement('a');
                    link.href = pngData; link.download = `${filenameBase}.png`;
                    document.body.appendChild(link); link.click(); link.remove();
                } else {
                    const imgData = canvas.toDataURL('image/jpeg', 0.95);
                    const pdfW = 595.28; const pdfH = pdfW * (canvas.height / canvas.width);
                    const orientation = pdfH > pdfW ? 'p' : 'l';
                    const pdfDoc = new jspdf.jsPDF({ orientation, unit: 'pt', format: [pdfW, pdfH] });
                    pdfDoc.addImage(imgData, 'JPEG', 0, 0, pdfW, pdfH);
                    pdfDoc.save(`${filenameBase}.pdf`);
                }
                showToast(`สร้างไฟล์ ${format === 'image' ? 'รูปภาพ' : 'PDF'} สำเร็จ!`, "success");
            } catch (err) { showToast("เกิดข้อผิดพลาดในการสร้างไฟล์ Infographic", "error"); }
            frame.remove(); lineHeightFixStyle.remove();
            if (__wasDark) document.documentElement.classList.add('dark');
        };

        // สร้างช่องลงนามแบบทางการ แสดงเฉพาะผู้ที่มีชื่อจริงเท่านั้น (กรองคนที่ยังไม่มีข้อมูลออกไปเลย ไม่ใช่โชว์ช่องว่างงงๆ)
        // ใช้เส้นขีดจริง (border) แทนการเคาะวรรค เพราะเบราว์เซอร์จะยุบช่องว่างต่อเนื่องอยู่ดี ทำให้เส้นที่เคาะด้วยวรรคแทบมองไม่เห็นจริงในไฟล์ที่ปริ้นออกมา
        function buildPdfSignatureBlock(signers) {
            const valid = (signers || []).filter(s => s && s.name && String(s.name).trim());
            if (valid.length === 0) return `<div class="rp-sig"><p style="font-size:11px;color:#94a3b8;font-style:italic">— ยังไม่มีข้อมูลผู้รับผิดชอบสำหรับลงนามในเอกสารฉบับนี้ —</p></div>`;
            return `<div class="rp-sig">${valid.map(s => `<div><div style="font-size:11px;color:#94a3b8;text-align:left;margin-left:12px">ลงชื่อ</div><div class="ln"></div><div style="font-weight:700">( ${s.name} )</div><div style="color:#64748b;font-size:11px;font-weight:700">${s.role}</div><div style="color:#94a3b8;font-size:10px;margin-top:4px">วันที่ ____ / ____ / ____</div></div>`).join('')}</div>`;
        }
        // บรรทัดข้อมูลกำกับความเป็นทางการของเอกสาร (ชื่อระบบ + วันที่ออกรายงาน)
        function pdfDocMeta() {
            const now = new Date();
            const genDate = now.toLocaleDateString('th-TH', { day: '2-digit', month: 'long', year: 'numeric' });
            return `<p class="text-[10px] text-slate-400 font-semibold mb-1.5 tracking-wide">${settings.title || 'ระบบเช็คชื่อนักเรียนอัจฉริยะ'} · ออกรายงานเมื่อวันที่ ${genDate}</p>`;
        }
        // โลโก้โรงเรียน/เว็บ (ถ้ามีอัปโหลดไว้) แสดงกลางหัวรายงาน
        function pdfLogoHtml() {
            if (!settings.logoDataUrl) return '';
            return `<img src="${settings.logoDataUrl}" style="width:52px; height:52px; object-fit:cover; border-radius:9999px; margin:0 auto 10px auto; display:block; border:2px solid #e2e8f0;">`;
        }
        // ป้ายเลขหน้า มุมขวาบนของกระดาษ (แยกออกจากหัวเรื่องหลัก กันไม่ให้หัวเรื่องยาวจนตัวอักษรชนกับกล่องด้านล่าง)
        // ===== [v2.01.0] ชุดหน้ารายงานแบบใหม่ (ทุกรายงาน PDF ใช้ร่วมกัน) =====
        // หัวกระดาษ (โลโก้ · ชื่อระบบ · ชื่อรายงาน) + ท้ายกระดาษ (ภาคเรียน · เวลาออกรายงาน · หน้า n / N) ใส่ให้ตอนสร้างจริงใน rpFinalize()
        // ตาราง/กล่อง/ลายเซ็นใช้สไตล์ชุดเดียวกัน (ไม่พึ่ง styles.css / Tailwind ตอนแคปภาพ)
        const RP_ST = { 'มา': '#10b981', 'ร่วมกิจกรรม': '#06b6d4', 'สาย': '#f59e0b', 'ลาป่วย': '#3b82f6', 'ลากิจ': '#6366f1', 'ขาด': '#f43f5e', 'โดดเรียน': '#9333ea' };
        (function () {
            const css = `
.a4-export-container{position:fixed!important;left:-30000px!important;top:0!important;z-index:-1;font-family:'Sarabun','Noto Sans Thai',sans-serif!important;color:#0f172a}
.a4-export-container .a4-page{position:relative!important;width:794px!important;height:1123px!important;min-height:1123px!important;max-height:1123px!important;box-sizing:border-box!important;padding:66px 38px 50px!important;margin:0!important;background:#fff!important;overflow:hidden!important;display:flex!important;flex-direction:column!important;border:0!important;box-shadow:none!important;border-radius:0!important}
.a4-export-container .a4-page *{line-height:1.6!important}
:where(.a4-export-container .a4-page) table{font-size:11px}
:where(.a4-export-container .a4-page) th{font-size:11px}
.a4-export-container .a4-page tr{border:0!important}
.a4-export-container .a4-page > div > .rounded-xl.bg-slate-50,.a4-export-container .a4-page > div > div > .rounded-xl.bg-slate-50{padding:6px 14px!important;border-radius:12px!important;border:1px solid #e2e8f0!important;background:#f8fafc!important;font-size:12px!important;margin-bottom:10px!important}
.a4-export-container .rp-info{display:flex;flex-wrap:wrap;gap:4px 18px;padding:6px 14px;border-radius:12px;border:1px solid #e2e8f0;background:#f8fafc;font-size:12px;margin-bottom:10px}
.a4-export-container .rp-info span{color:#64748b}
.a4-export-container .a4-page.rp-cover{padding:0!important}
.a4-export-container .a4-page table{border-collapse:separate!important;border-spacing:0!important;width:100%!important;border:0!important;border-top:1px solid #cbd5e1!important;border-left:1px solid #cbd5e1!important;margin-bottom:10px!important}
.a4-export-container .a4-page th,.a4-export-container .a4-page td{border:0!important;border-right:1px solid #cbd5e1!important;border-bottom:1px solid #cbd5e1!important;padding:3px 6px!important}
.a4-export-container .a4-page thead th,.a4-export-container .a4-page thead td{background:#eef2ff!important;color:#312e81!important;font-weight:700!important}
.a4-export-container .a4-page tbody tr:nth-child(even) td{background-color:#f8fafc}
.a4-export-container .rp-band{position:absolute;left:38px;right:38px;top:0;height:48px;display:flex;align-items:center;justify-content:space-between;gap:12px;border-bottom:2px solid #4338ca;font-size:11px;color:#475569}
.a4-export-container .rp-band b{color:#312e81}
.a4-export-container .rp-band img{width:24px;height:24px;border-radius:50%;object-fit:cover;margin-right:8px;vertical-align:middle}
.a4-export-container .rp-foot{position:absolute;left:38px;right:38px;bottom:0;height:36px;border-top:1px solid #e2e8f0;display:flex;align-items:center;justify-content:space-between;font-size:10px;color:#94a3b8}
.a4-export-container .rp-head{display:flex;justify-content:space-between;align-items:flex-end;gap:12px;margin:2px 0 12px}
.a4-export-container .rp-head h1{font-size:22px;font-weight:800;color:#1e1b4b;margin:0}
.a4-export-container .rp-head .rp-sub{font-size:12px;color:#64748b;margin-top:2px}
.a4-export-container .rp-pill{display:inline-block;background:#eef2ff;color:#3730a3;border-radius:999px;padding:3px 12px;font-size:12px;font-weight:700;white-space:nowrap}
.a4-export-container .rp-kp{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:8px;margin-bottom:12px}
.a4-export-container .rp-k{border-radius:12px;padding:6px 12px;border:1px solid}
.a4-export-container .rp-k span{display:block;font-size:11px;color:#475569;font-weight:600}
.a4-export-container .rp-k b{display:block;font-size:22px;font-weight:800}
.a4-export-container .rp-sec{display:flex;align-items:center;gap:8px;margin:10px 0 6px;font-size:14px;font-weight:800;color:#1e1b4b}
.a4-export-container .rp-sec:before{content:'';width:4px;height:16px;border-radius:2px;background:#4338ca;display:inline-block}
.a4-export-container .rp-sec small{font-weight:600;color:#64748b;font-size:11px}
.a4-export-container .rp-lg{display:flex;flex-wrap:wrap;gap:4px 14px;font-size:10px;color:#475569;margin-top:6px}
.a4-export-container .rp-lg i{display:inline-block;width:10px;height:10px;border-radius:3px;margin-right:4px;vertical-align:-1px}
.a4-export-container .rp-sig{margin-top:auto;padding-top:14px;display:flex;flex-wrap:wrap;justify-content:space-around;gap:14px 10px;text-align:center;font-size:12px;color:#334155}
.a4-export-container .rp-sig > div{min-width:170px}
.a4-export-container .rp-sig .ln{border-bottom:1px dotted #64748b;height:34px;margin:0 12px 6px}
.a4-export-container .rp-ftag{display:inline-block;background:#e0f2fe;color:#0369a1;border:1px solid #7dd3fc;border-radius:6px;padding:0 5px;font-size:9px;font-weight:800;margin-left:4px}
.a4-export-container .rp-lbl{display:none}
img[src^="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP"]{display:inline!important;vertical-align:baseline!important}`; // html2canvas วัดตำแหน่งตัวอักษรด้วยรูปจิ๋วนี้ — Tailwind ตั้ง img เป็น block ทำให้ตัวอักษรในไฟล์ PDF เลื่อนลง
            const st = document.createElement('style'); st.id = 'rpStyle'; st.textContent = css; document.head.appendChild(st);
        })();
        function rpEsc(v) { return String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
        // หัวเรื่องของหน้า (ซ้าย: ชื่อรายงาน + ข้อความรอง · ขวา: ป้าย)
        function rpHead(title, sub, right) { return `<div class="rp-head"><div style="min-width:0"><h1>${title}</h1>${sub ? `<div class="rp-sub">${sub}</div>` : ''}</div>${right ? `<div style="text-align:right;flex:none">${right}</div>` : ''}</div>`; }
        function rpPill(t) { return `<span class="rp-pill">${t}</span>`; }
        function rpKpis(items) { return `<div class="rp-kp" style="grid-template-columns:repeat(${items.length},minmax(0,1fr))">${items.map(x => `<div class="rp-k" style="border-color:${x[2] === '#0f172a' ? '#e2e8f0' : x[2] + '55'};background:${x[2] === '#0f172a' ? '#f8fafc' : x[2] + '12'}"><span>${x[0]}</span><b style="color:${x[2]}">${x[1]}</b></div>`).join('')}</div>`; }
        function rpSec(t, sub, color) { return `<div class="rp-sec"${color ? ` style="color:${color}"` : ''}>${t}${sub ? ` <small>${sub}</small>` : ''}</div>`; }
        function rpPctColor(p) { return p == null ? '#64748b' : (p >= 90 ? '#16a34a' : (p >= 75 ? '#d97706' : '#dc2626')); }
        function rpStack(counts, h) { const keys = Object.keys(RP_ST), tot = keys.reduce((a, k) => a + (counts[k] || 0), 0); if (!tot) return `<div style="height:${h || 12}px;border-radius:8px;background:#e2e8f0"></div>`; return `<div style="display:flex;height:${h || 12}px;border-radius:8px;overflow:hidden;background:#e2e8f0">${keys.filter(k => counts[k]).map(k => `<div style="width:${(counts[k] / tot * 100).toFixed(2)}%;background:${RP_ST[k]}"></div>`).join('')}</div>`; }
        function rpLegend(keys) { return `<div class="rp-lg">${(keys || Object.keys(RP_ST)).map(k => `<span><i style="background:${RP_ST[k]}"></i>${k}</span>`).join('')}</div>`; }
        // วงกลมสัดส่วนสถานะ — วาดลง canvas เอง (ไม่พึ่ง Chart.js) ค่าใน data-rp-donut จะถูกวาดตอน rpFinalize
        function rpDonut(counts, size) { const sz = size || 170; return `<canvas width="${sz * 2}" height="${sz * 2}" style="width:${sz}px;height:${sz}px" data-rp-donut='${JSON.stringify(counts).replace(/'/g, '&#39;')}'></canvas>`; }
        function rpDrawDonut(cv) {
            let counts = {}; try { counts = JSON.parse(cv.getAttribute('data-rp-donut') || '{}'); } catch (e) { counts = {}; }
            const ctx = cv.getContext('2d'), W = cv.width, R = W / 2, r0 = R * 0.62, keys = Object.keys(RP_ST), tot = keys.reduce((a, k) => a + (counts[k] || 0), 0);
            ctx.clearRect(0, 0, W, W); let a = -Math.PI / 2;
            if (!tot) { ctx.fillStyle = '#e2e8f0'; ctx.beginPath(); ctx.arc(R, R, R - 2, 0, Math.PI * 2); ctx.arc(R, R, r0, 0, Math.PI * 2, true); ctx.fill(); }
            keys.forEach(k => { const v = counts[k] || 0; if (!v) return; const b = a + v / tot * Math.PI * 2; ctx.fillStyle = RP_ST[k]; ctx.beginPath(); ctx.arc(R, R, R - 2, a, b); ctx.arc(R, R, r0, b, a, true); ctx.closePath(); ctx.fill(); a = b; });
            const ok = (counts['มา'] || 0) + (counts['ร่วมกิจกรรม'] || 0) + (counts['สาย'] || 0), pct = tot ? Math.round(ok / tot * 1000) / 10 : null;
            ctx.fillStyle = rpPctColor(pct); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = `800 ${Math.round(W * 0.15)}px Sarabun, 'Noto Sans Thai', sans-serif`; ctx.fillText(pct == null ? '-' : pct + '%', R, R - W * 0.03);
            ctx.fillStyle = '#64748b'; ctx.font = `600 ${Math.round(W * 0.065)}px Sarabun, 'Noto Sans Thai', sans-serif`; ctx.fillText('มาเรียน', R, R + W * 0.1);
        }
        function rpStatusRows(counts) { const keys = Object.keys(RP_ST), tot = keys.reduce((a, k) => a + (counts[k] || 0), 0); return keys.map(k => `<div style="display:flex;align-items:center;gap:8px;font-size:12px;margin:4px 0"><i style="width:10px;height:10px;border-radius:3px;background:${RP_ST[k]};display:inline-block"></i><span>${k}</span><b style="margin-left:auto">${counts[k] || 0}${tot ? ` <span style="color:#64748b;font-weight:600">(${((counts[k] || 0) / tot * 100).toFixed(1)}%)</span>` : ''}</b></div>`).join(''); }
        function pdfPageBadge(pageLabel) { return pageLabel ? `<div class="rp-lbl" data-l="${rpEsc(pageLabel)}"></div>` : ''; }
        function rpTermText() { try { return `ภาคเรียนที่ ${adminTerm()}/${adminYear()}`; } catch (e) { return ''; } }
        // ใส่หัว/ท้ายกระดาษ + เลขหน้า ให้ทุกหน้าในกล่องรายงาน (เรียกหลังแทรก HTML ก่อนแคปภาพ)
        function rpFinalize(root, docTitle) {
            const box = typeof root === 'string' ? document.querySelector(root) : root; if (!box) return;
            const pages = Array.from(box.querySelectorAll('.a4-page')), N = pages.length, now = new Date();
            const stamp = `${now.getDate()} ${['ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.', 'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.'][now.getMonth()]} ${now.getFullYear() + 543} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} น.`;
            const logo = settings.logoDataUrl ? `<img src="${settings.logoDataUrl}">` : '';
            pages.forEach((pg, i) => {
                pg.querySelectorAll('canvas[data-rp-donut]').forEach(rpDrawDonut);
                if (pg.classList.contains('rp-cover') || pg.getAttribute('data-rp')) return;
                pg.setAttribute('data-rp', '1');
                const lb = pg.querySelector('.rp-lbl'), label = lb ? String(lb.getAttribute('data-l') || '').replace(/\s*·?\s*หน้า\S*\s*\d+\s*\/\s*\d+\s*$/, '').trim() : ''; // เลขหน้าอยู่ท้ายกระดาษแล้ว
                const h1 = pg.querySelector('.rp-head h1'), title = docTitle || (h1 ? h1.textContent : '');
                pg.insertAdjacentHTML('afterbegin', `<div class="rp-band"><span>${logo}<b>${rpEsc(settings.title || 'ระบบเช็คชื่อ')}</b></span><span>${rpEsc(title)}${label ? ' · ' + rpEsc(label) : ''}</span></div>`);
                pg.insertAdjacentHTML('beforeend', `<div class="rp-foot"><span>${rpEsc(rpTermText())} · ข้อมูล ณ ${stamp}</span><span>หน้า ${i + 1} / ${N}</span></div>`);
            });
        }
        // [v2.01.0] กล่องสรุป + แถบสัดส่วนสถานะ (ใช้ในรายงานรายบุคคล)
        function rpStudentSummary(m) {
            m = m || {}; const keys = Object.keys(RP_ST), tot = keys.reduce((a, k) => a + (m[k] || 0), 0), ok = (m['มา'] || 0) + (m['ร่วมกิจกรรม'] || 0) + (m['สาย'] || 0), pct = tot ? Math.round(ok / tot * 1000) / 10 : null;
            return rpKpis([['มาเรียน (รวมสาย)', pct == null ? '-' : pct + '%', rpPctColor(pct)], ['สาย', (m['สาย'] || 0) + ' ครั้ง', '#d97706'], ['ลา', ((m['ลาป่วย'] || 0) + (m['ลากิจ'] || 0)) + ' ครั้ง', '#2563eb'], ['ขาด / โดด', ((m['ขาด'] || 0) + (m['โดดเรียน'] || 0)) + ' ครั้ง', '#e11d48']]) + rpSec('สัดส่วนสถานะ', tot ? tot + ' ครั้งที่เช็ค' : 'ยังไม่มีข้อมูล') + rpStack(m, 14) + rpLegend() + '<div style="height:10px"></div>';
        }
        window.downloadStudentPDF = async function(studentId, month) {
            const pdfType = document.getElementById('studentPdfType').value;
            const data = window.tempStudentReport; if (!data || data.student.id !== studentId) return;
            showToast("กำลังประมวลผล PDF กรุณารอสักครู่...", "success");
            const __wasDark = document.documentElement.classList.contains('dark'); if (__wasDark) document.documentElement.classList.remove('dark');
            const advData = getRoomAdvisors(data.student.roomId);
            const adv1 = advData[0] || '';
            const staffName = getRoomStaff(data.student.roomId);
            const pdfDoc = new jspdf.jsPDF('p', 'pt', 'a4');
            let htmlContainer = `<div id="pdf-student-container" class="a4-export-container text-slate-800" style="font-family: 'Sarabun', sans-serif;"><div id="pdf-student-page" class="a4-page flex flex-col justify-between bg-white"><div>${rpHead(`รายงานสรุปเวลาเรียนส่วนบุคคล`, rpPill(`ประจำเดือน: ${month.split('-')[1]}/${parseInt(month.split('-')[0])+543} | รูปแบบ: ${pdfType === 'daily' ? 'รายวัน' : (pdfType === 'weekly' ? 'รายสัปดาห์' : 'รายเดือน')}`))}<div class="flex justify-between items-center mb-6 text-sm font-bold bg-slate-50 p-4 rounded-xl border border-slate-300"><div><span class="text-slate-500">ชื่อ-นามสกุล:</span> ${data.student.name}</div><div><span class="text-slate-500">เลขที่:</span> ${data.student.number}</div><div><span class="text-slate-500">ห้อง:</span> ${data.room}</div></div>${rpStudentSummary(data.monthly)}`;
            if (pdfType === 'monthly') {
                htmlContainer += `<table class="w-full text-center border-collapse border border-slate-500 text-base mb-6"><thead class="bg-slate-100"><tr><th class="border border-slate-500 p-3" colspan="2">สรุปสถิติประจำเดือน</th></tr></thead><tbody class="divide-y divide-slate-400 font-bold"><tr><td class="border border-slate-500 p-3 w-1/2 text-right pr-6">มาเรียน</td><td class="border border-slate-500 p-3 w-1/2 text-left pl-6 text-emerald-600">${data.monthly['มา']} ครั้ง</td></tr><tr><td class="border border-slate-500 p-3 text-right pr-6">ร่วมกิจกรรม</td><td class="border border-slate-500 p-3 text-left pl-6 text-cyan-600">${data.monthly['ร่วมกิจกรรม']} ครั้ง</td></tr><tr><td class="border border-slate-500 p-3 text-right pr-6">สาย</td><td class="border border-slate-500 p-3 text-left pl-6 text-amber-600">${data.monthly['สาย']} ครั้ง</td></tr><tr><td class="border border-slate-500 p-3 text-right pr-6">ลาป่วย</td><td class="border border-slate-500 p-3 text-left pl-6 text-blue-600">${data.monthly['ลาป่วย']} ครั้ง</td></tr><tr><td class="border border-slate-500 p-3 text-right pr-6">ลากิจ</td><td class="border border-slate-500 p-3 text-left pl-6 text-indigo-600">${data.monthly['ลากิจ']} ครั้ง</td></tr><tr><td class="border border-slate-500 p-3 text-right pr-6">ขาดเรียน</td><td class="border border-slate-500 p-3 text-left pl-6 text-rose-600">${data.monthly['ขาด']} ครั้ง</td></tr><tr><td class="border border-slate-500 p-3 text-right pr-6">โดดเรียน</td><td class="border border-slate-500 p-3 text-left pl-6 text-purple-600">${data.monthly['โดดเรียน']} ครั้ง</td></tr></tbody></table>`;
            } else if (pdfType === 'weekly') {
                htmlContainer += `<table class="w-full text-center border-collapse border border-slate-500 text-[14px] mb-6"><thead class="bg-slate-100"><tr><th class="border border-slate-500 p-2">สัปดาห์ที่</th><th class="border border-slate-500 p-2 text-emerald-700">มา</th><th class="border border-slate-500 p-2 text-cyan-700">กิจกรรม</th><th class="border border-slate-500 p-2 text-amber-700">สาย</th><th class="border border-slate-500 p-2 text-blue-700">ลาป่วย</th><th class="border border-slate-500 p-2 text-indigo-700">ลากิจ</th><th class="border border-slate-500 p-2 text-rose-700">ขาด</th><th class="border border-slate-500 p-2 text-purple-700">โดด</th></tr></thead><tbody class="divide-y divide-slate-400 font-bold">${[1,2,3,4,5].map(w => `<tr><td class="border border-slate-500 p-2 bg-slate-50">สัปดาห์ ${w}</td><td class="border border-slate-500 p-2 text-emerald-600">${data.weekly[w]['มา']}</td><td class="border border-slate-500 p-2 text-cyan-600">${data.weekly[w]['ร่วมกิจกรรม']}</td><td class="border border-slate-500 p-2 text-amber-600">${data.weekly[w]['สาย']}</td><td class="border border-slate-500 p-2 text-blue-600">${data.weekly[w]['ลาป่วย']}</td><td class="border border-slate-500 p-2 text-indigo-600">${data.weekly[w]['ลากิจ']}</td><td class="border border-slate-500 p-2 text-rose-600">${data.weekly[w]['ขาด']}</td><td class="border border-slate-500 p-2 text-purple-600">${data.weekly[w]['โดดเรียน']}</td></tr>`).join('')}</tbody></table>`;
                // ===== [ใหม่] คำชี้แจงช่วงวันที่ของแต่ละสัปดาห์ ใต้ตาราง (นับแบบปฏิทินจริง เริ่มวันจันทร์เสมอ) =====
                const [pdfWkYear, pdfWkMonth] = month.split('-').map(Number);
                const pdfWeekRanges = getMonthWeekRanges(pdfWkYear, pdfWkMonth);
                htmlContainer += `<p class="text-[11px] text-slate-500 font-medium mb-6" style="margin-top:-16px;">ช่วงวันที่ของแต่ละสัปดาห์: ${[1,2,3,4,5].filter(w => pdfWeekRanges[w]).map(w => `สัปดาห์ ${w} = วันที่ ${pdfWeekRanges[w].start}${pdfWeekRanges[w].end !== pdfWeekRanges[w].start ? '-' + pdfWeekRanges[w].end : ''}`).join(' / ')}</p>`;
            } else if (pdfType === 'daily') {
                htmlContainer += `<table class="w-full text-center border-collapse border border-slate-500 text-[13px] mb-6"><thead class="bg-slate-100"><tr><th class="border border-slate-500 p-2 w-1/2">วันที่</th><th class="border border-slate-500 p-2 w-1/2">สถานะการมาเรียน</th></tr></thead><tbody class="divide-y divide-slate-400 font-bold">${data.dates.map(d => { const stat = data.daily[d].status; let cl = ''; if(stat==='มา'||stat==='ร่วมกิจกรรม') cl='text-emerald-600'; else if(stat==='สาย') cl='text-amber-600'; else cl='text-rose-600'; return `<tr><td class="border border-slate-500 p-2">${d.split('-').reverse().join('/')}</td><td class="border border-slate-500 p-2 ${cl}">${stat}</td></tr>`; }).join('')}${data.dates.length === 0 ? `<tr><td class="border border-slate-500 p-4 text-slate-400" colspan="2">ไม่มีข้อมูลในเดือนนี้</td></tr>` : ''}</tbody></table>`;
            }

            htmlContainer += `</div>${buildPdfSignatureBlock([{ name: adv1, role: 'ครูที่ปรึกษา' }, { name: staffName, role: 'เจ้าหน้าที่ / ฝ่ายวิชาการ' }])}</div></div>`;
            document.body.insertAdjacentHTML('beforeend', htmlContainer); rpFinalize(document.body.lastElementChild);

            await document.fonts.ready; await new Promise(resolve => setTimeout(resolve, 1500));

            try {
                const el = document.getElementById(`pdf-student-page`);
                const canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false });
                const imgData = canvas.toDataURL('image/jpeg', 0.95);
                pdfDoc.addImage(imgData, 'JPEG', 0, 0, 595.28, 841.89);
                pdfDoc.save(`StudentReport_${data.student.name}_${month}_${pdfType}.pdf`); showToast("สร้างไฟล์ PDF สำเร็จ!", "success");
            } catch (err) { showToast("เกิดข้อผิดพลาดในการสร้าง PDF", "error");
            }
            document.getElementById('pdf-student-container').remove();
            if (__wasDark) document.documentElement.classList.add('dark');
        };
        window.downloadInfographicPDF = async function(subjectId) {
            showToast("กำลังประมวลผล PDF กรุณารอสักครู่...", "success");
            const __wasDark = document.documentElement.classList.contains('dark'); if (__wasDark) document.documentElement.classList.remove('dark');
            const subject = subjects.find(s => s.id === subjectId); const roomStudents = getRoomStudents(subject.roomId).sort((a,b) => parseInt(a.number) - parseInt(b.number));
            const subjectAtt = attendanceData.filter(a => a.subjectId === subjectId);
            
            let uniqueCols = [];
            subjectAtt.forEach(att => { const key = `${att.date}_${att.period}`; if (!uniqueCols.find(c => c.key === key)) uniqueCols.push({ key, data: att.records, subTeacher: att.substituteTeacher }); });
            const totalClasses = uniqueCols.length;
            const staffName = getRoomStaff(subject.roomId);
            let subNotes = uniqueCols.filter(c => c.subTeacher).map(c => `วันที่ ${c.key.split('_')[0].split('-').reverse().join('/')} คาบ ${periodLabel(c.key.split('_')[1])} (แทนโดย: ${c.subTeacher})`);
            let subNotesHtml = '';
            if (subNotes.length > 0) { subNotesHtml = `<div class="mb-4 text-[10px] font-bold text-amber-700 bg-amber-50 p-2 rounded-lg border border-amber-200"><span class="text-amber-800 underline mr-1">หมายเหตุการสอนแทน:</span> ${subNotes.join(', ')}</div>`;
            }

            const STUDENTS_PER_PAGE = 24; // ลดจาก 30 เพื่อกันเนื้อหาล้นหน้า A4 แล้วถูกบีบเล็กลงตอนแปลงเป็น PDF (ทำให้แต่ละหน้าดูสัดส่วนไม่เท่ากัน)
            const subjTot = {}; uniqueCols.forEach(col => Object.values(col.data || {}).forEach(v => { if (RP_ST[v]) subjTot[v] = (subjTot[v] || 0) + 1; })); // [v2.01.0] สรุปทั้งวิชา
            const sN = Object.values(subjTot).reduce((a, b) => a + b, 0), sOk = (subjTot['มา'] || 0) + (subjTot['ร่วมกิจกรรม'] || 0) + (subjTot['สาย'] || 0), sPct = sN ? Math.round(sOk / sN * 1000) / 10 : null;
            const subjSummary = rpKpis([['คาบที่สอนแล้ว', totalClasses, '#0f172a'], ['มาเรียน (รวมสาย)', sPct == null ? '-' : sPct + '%', rpPctColor(sPct)], ['ลา', (subjTot['ลาป่วย'] || 0) + (subjTot['ลากิจ'] || 0), '#2563eb'], ['ขาด / โดด', (subjTot['ขาด'] || 0) + (subjTot['โดดเรียน'] || 0), '#e11d48']]) + rpStack(subjTot, 12) + rpLegend() + '<div style="height:8px"></div>';
            const pagesCount = Math.ceil(roomStudents.length / STUDENTS_PER_PAGE) || 1;
            const pdfDoc = new jspdf.jsPDF('p', 'pt', 'a4');
            let htmlContainer = `<div id="pdf-export-container" class="a4-export-container text-slate-800" style="font-family: 'Sarabun', sans-serif;">`;
            for (let page = 0; page < pagesCount; page++) {
                const studentsChunk = roomStudents.slice(page * STUDENTS_PER_PAGE, (page + 1) * STUDENTS_PER_PAGE);
                let studentTable = `<table class="w-full text-center border-collapse border border-slate-500 text-[13px] mb-6" style="table-layout: fixed; width: 100%;"><thead class="bg-slate-100"><tr><th class="border border-slate-500 p-2" style="width: 8%;">เลขที่</th><th class="border border-slate-500 p-2 text-left" style="width: 32%;">ชื่อ-นามสกุล</th><th class="border border-slate-500 p-2 text-emerald-700" style="width: 15%;">มา/กิจกรรม</th><th class="border border-slate-500 p-2 text-amber-700" style="width: 15%;">สาย</th><th class="border border-slate-500 p-2 text-blue-700" style="width: 15%;">ลา</th><th class="border border-slate-500 p-2 text-rose-700" style="width: 15%;">ขาด/โดด</th></tr></thead><tbody class="divide-y divide-slate-400">`;
                studentsChunk.forEach(st => {
                    let valid = 0, late = 0, leave = 0, absent = 0; 
                    uniqueCols.forEach(col => { const s = col.data[st.id]; if(s === 'มา' || s === 'ร่วมกิจกรรม') valid++; else if(s === 'สาย') late++; else if(s === 'ลาป่วย' || s === 'ลากิจ') leave++; else if(s === 'ขาด' || s === 'โดดเรียน') absent++; });
                    const isRes = st.status === 'resigned'; const calcPct = (val) => totalClasses > 0 ? Math.round((val/totalClasses)*100) : 0;
                    const validPct = calcPct(valid), latePct = calcPct(late), leavePct = calcPct(leave), absentPct = calcPct(absent);
                    studentTable += `<tr class="${isRes ? 'bg-slate-50' : 'bg-white'}"><td class="border border-slate-500 p-1.5 font-bold text-slate-600">${st.number}</td><td class="border border-slate-500 p-1.5 font-bold text-left">${st.name}${stuCodePdf(st)} ${isRes?'(ออก/ย้าย)':''}</td><td class="border border-slate-500 p-1.5 font-black text-emerald-600">${valid} <span class="text-[10px] text-emerald-700/70">(${validPct}%)</span></td><td class="border border-slate-500 p-1.5 font-black text-amber-600">${late} <span class="text-[10px] text-amber-700/70">(${latePct}%)</span></td><td class="border border-slate-500 p-1.5 font-black text-blue-600">${leave} <span class="text-[10px] text-blue-700/70">(${leavePct}%)</span></td><td class="border border-slate-500 p-1.5 font-black text-rose-600">${absent} <span class="text-[10px] text-rose-700/70">(${absentPct}%)</span></td></tr>`;
                });
                studentTable += '</tbody></table>';
                htmlContainer += `<div id="pdf-page-${page}" class="a4-page flex flex-col justify-between bg-white">${pdfPageBadge(pagesCount > 1 ? `หน้า ${page+1}/${pagesCount}` : '')}<div>${rpHead(`สรุปเวลาเรียนรายบุคคล`, rpPill(`วิชา: ${subject.name} | ห้อง: ${formatRoomName(subject.roomId)}`))}<div class="rp-info"><span>ครูผู้สอน:</span><b>${subject.teacher || '-'}${isForeignSubject(subject) ? '<span class="rp-ftag">ครูต่างชาติ</span>' : ''}${subject.teacher2 ? ' / ' + subject.teacher2 : ''}</b><span>คาบที่สอนแล้ว:</span><b>${totalClasses} คาบ</b></div>${page === 0 ? subjSummary : ''}${subNotesHtml}${studentTable}</div>${page === pagesCount - 1 ? buildPdfSignatureBlock([{ name: subject.teacher, role: subject.teacher2 ? 'ครูผู้สอน (หลัก)' : 'ครูผู้สอน / ผู้รับผิดชอบ' }, { name: subject.teacher2, role: 'ครูผู้สอน (ร่วมสอน)' }, { name: staffName, role: 'เจ้าหน้าที่ / ฝ่ายวิชาการ' }]) : ''}</div>`;
            }
            htmlContainer += `</div>`; document.body.insertAdjacentHTML('beforeend', htmlContainer); rpFinalize(document.body.lastElementChild);
            await document.fonts.ready;
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
                for (let page = 0; page < pagesCount; page++) {
                    const el = document.getElementById(`pdf-page-${page}`);
                    const canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false }); const imgData = canvas.toDataURL('image/jpeg', 0.95);
                    if (page > 0) pdfDoc.addPage(); pdfDoc.addImage(imgData, 'JPEG', 0, 0, 595.28, 841.89);
                }
                pdfDoc.save(`Report_${subject.name}_${formatRoomName(subject.roomId)}.pdf`);
                showToast("สร้างไฟล์ PDF สำเร็จ!", "success");
            } catch (err) { showToast("เกิดข้อผิดพลาดในการสร้าง PDF", "error"); } document.getElementById('pdf-export-container').remove();
            if (__wasDark) document.documentElement.classList.add('dark');
        }

        window.downloadRoomInfographicPDF = async function(roomId, month) {
            showToast("กำลังประมวลผล PDF กรุณารอสักครู่...", "success");
            const __wasDark = document.documentElement.classList.contains('dark'); if (__wasDark) document.documentElement.classList.remove('dark');
            const report = window.tempRoomReport; if(!report || report.roomId !== roomId) return; const roomName = formatRoomName(roomId);
            const monthNames = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
            const displayMonthYear = `${monthNames[parseInt(month.split('-')[1])-1]} ${parseInt(month.split('-')[0])+543}`;
            const advData = getRoomAdvisors(roomId); let advisorText = Array.isArray(advData) ? advData.filter(a => a.trim()).join(' และ ') : "ยังไม่ระบุ";
            const staffName = getRoomStaff(roomId);
            const signerList = [];
            if (advData[0]) signerList.push({ name: advData[0], role: advData[1] ? 'ครูที่ปรึกษาคนที่ 1' : 'ครูที่ปรึกษา' });
            if (advData[1]) signerList.push({ name: advData[1], role: 'ครูที่ปรึกษาคนที่ 2' });
            signerList.push({ name: staffName, role: 'เจ้าหน้าที่ / นายทะเบียน' });
            const STUDENTS_PER_PAGE = 24, FIRST_ROWS = 12; const pagesCount = report.data.length <= FIRST_ROWS ? 1 : 1 + Math.ceil((report.data.length - FIRST_ROWS) / STUDENTS_PER_PAGE); // [v2.01.0] หน้าแรกมีภาพรวม (กล่องสรุป + วงกลมสัดส่วน + นักเรียนที่ควรติดตาม)
            const tot = {}; report.data.forEach(row => Object.keys(RP_ST).forEach(k => { tot[k] = (tot[k] || 0) + (row.monthly[k] || 0); }));
            const totN = Object.keys(RP_ST).reduce((a, k) => a + (tot[k] || 0), 0), okN = (tot['มา'] || 0) + (tot['ร่วมกิจกรรม'] || 0) + (tot['สาย'] || 0), pctAll = totN ? Math.round(okN / totN * 1000) / 10 : null;
            const watch = report.data.filter(r => r.student.status !== 'resigned').map(r => ({ r, a: (r.monthly['ขาด'] || 0) + (r.monthly['โดดเรียน'] || 0), l: r.monthly['สาย'] || 0 })).filter(x => x.a || x.l).sort((x, y) => (y.a * 2 + y.l) - (x.a * 2 + x.l)).slice(0, 5);
            const overview = rpKpis([['มาเรียน (รวมสาย)', pctAll == null ? '-' : pctAll + '%', rpPctColor(pctAll)], ['สาย', tot['สาย'] || 0, '#d97706'], ['ลา', (tot['ลาป่วย'] || 0) + (tot['ลากิจ'] || 0), '#2563eb'], ['ขาด / โดด', (tot['ขาด'] || 0) + (tot['โดดเรียน'] || 0), '#e11d48']]) +
                `<div style="display:grid;grid-template-columns:150px 1fr 1.3fr;gap:18px;align-items:center;margin-bottom:6px"><div>${rpDonut(tot, 150)}</div><div>${rpStatusRows(tot)}</div><div>${rpSec('นักเรียนที่ควรติดตาม', 'ขาด / สายบ่อยที่สุด', '#b91c1c')}${watch.length ? `<table><thead><tr><th>ชื่อ – สกุล</th><th style="width:40px">ขาด</th><th style="width:40px">สาย</th></tr></thead><tbody>${watch.map(x => `<tr><td>${x.r.student.number}. ${x.r.student.name}</td><td style="text-align:center;color:#e11d48;font-weight:800">${x.a}</td><td style="text-align:center;color:#d97706;font-weight:800">${x.l}</td></tr>`).join('')}</tbody></table>` : '<div style="color:#16a34a;font-weight:800;font-size:12px">ไม่มีนักเรียนขาดหรือสายในเดือนนี้</div>'}</div></div>` + rpSec('รายชื่อนักเรียน', 'ส.1–ส.5 = จำนวนครั้งที่มาเรียนในแต่ละสัปดาห์');
            const pdfDoc = new jspdf.jsPDF('p', 'pt', 'a4');
            let htmlContainer = `<div id="pdf-room-container" class="a4-export-container text-slate-800" style="font-family: 'Sarabun', sans-serif;">`;
            for (let page = 0; page < pagesCount; page++) {
                const dataChunk = page === 0 ? report.data.slice(0, FIRST_ROWS) : report.data.slice(FIRST_ROWS + (page - 1) * STUDENTS_PER_PAGE, FIRST_ROWS + page * STUDENTS_PER_PAGE);
                let tableHTML = `<table class="w-full text-center border-collapse text-[12px] bg-white border border-slate-500" style="table-layout: fixed; width: 100%;"><thead class="bg-slate-100 text-slate-700"><tr><th class="p-2 border border-slate-500" style="width: 8%;">เลขที่</th><th class="p-2 border border-slate-500 text-left" style="width: 32%;">ชื่อ-นามสกุล</th><th class="p-2 border border-slate-500" style="width: 6%;">ส.1</th><th class="p-2 border border-slate-500" style="width: 6%;">ส.2</th><th class="p-2 border border-slate-500" style="width: 6%;">ส.3</th><th class="p-2 border border-slate-500" style="width: 6%;">ส.4</th><th class="p-2 border border-slate-500" style="width: 6%;">ส.5</th><th class="p-2 border border-slate-500 bg-emerald-50 text-emerald-800" style="width: 6%;">มา</th><th class="p-2 border border-slate-500 bg-blue-50 text-blue-800" style="width: 6%;">ลา</th><th class="p-2 border border-slate-500 bg-rose-50 text-rose-800" style="width: 6%;">ขาด</th><th class="p-2 border border-slate-500 text-indigo-700" style="width: 12%;">การติดตาม</th></tr></thead><tbody class="divide-y divide-slate-400">`;
                dataChunk.forEach((row) => {
                    const isRes = row.student.status === 'resigned'; let bgRow = isRes ? 'bg-slate-100 text-slate-500 opacity-80' : 'bg-white';
                    let valid = row.monthly['มา'] + row.monthly['ร่วมกิจกรรม'], leave = row.monthly['ลากิจ'] + row.monthly['ลาป่วย'], absent = row.monthly['ขาด'] + row.monthly['โดดเรียน'];
                    
                    let fwText = '-'; let fwCls = '';
                    let lateLimit = settings.thresholds?.late || 4; let absLimit = settings.thresholds?.absent || 4;
                    let lateCount = row.monthly['สาย'] || 0; let absentCount = row.monthly['ขาด'] || 0;
                   
                    if (lateCount >= lateLimit || absentCount >= absLimit) {
                        const isFollowedUp = followUps.find(f => f.studentId === row.student.id && f.month === month);
                        if (isFollowedUp) { fwText = 'ติดตามแล้ว'; fwCls = 'text-emerald-700 bg-emerald-50 font-bold'; }
                        else { fwText = 'ต้องติดตาม'; fwCls = 'text-rose-700 bg-rose-50 font-bold'; }
                    }

                    tableHTML += `<tr class="${bgRow}"><td class="p-1.5 border border-slate-500 font-bold">${row.student.number}</td><td class="p-1.5 border border-slate-500 text-left font-bold">${row.student.name} ${isRes?'(ออก)':''}</td><td class="p-1.5 border border-slate-500">${row.weekly[1]||'-'}</td><td class="p-1.5 border border-slate-500">${row.weekly[2]||'-'}</td><td class="p-1.5 border border-slate-500">${row.weekly[3]||'-'}</td><td class="p-1.5 border border-slate-500">${row.weekly[4]||'-'}</td><td class="p-1.5 border border-slate-500">${row.weekly[5]||'-'}</td><td class="p-1.5 border border-slate-500 font-black text-emerald-700 bg-emerald-50/50">${valid||'-'}</td><td class="p-1.5 border border-slate-500 font-black text-blue-700 bg-blue-50/50">${leave||'-'}</td><td class="p-1.5 border border-slate-500 font-black text-rose-700 bg-rose-50/50">${absent||'-'}</td><td class="p-1.5 border border-slate-500 ${fwCls} text-[10px]">${fwText}</td></tr>`;
                });
                tableHTML += '</tbody></table>';
                htmlContainer += `<div id="pdf-room-page-${page}" class="a4-page flex flex-col justify-between bg-white">${pdfPageBadge(pagesCount > 1 ? `หน้า ${page+1}/${pagesCount}` : '')}<div>${rpHead(`รายงานภาพรวมห้องเรียน`, rpPill(`ห้อง: ${roomName} | ประจำเดือน: ${displayMonthYear}`))}<div class="rp-info"><span>ครูที่ปรึกษา:</span><b>${advisorText}</b></div>${page === 0 ? overview : ''}${tableHTML}</div>${page === pagesCount - 1 ? buildPdfSignatureBlock(signerList) : ''}</div>`;
            }
            htmlContainer += `</div>`; document.body.insertAdjacentHTML('beforeend', htmlContainer); rpFinalize(document.body.lastElementChild);
            await document.fonts.ready;
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
                for (let page = 0; page < pagesCount; page++) {
                    const el = document.getElementById(`pdf-room-page-${page}`);
                    const canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false }); const imgData = canvas.toDataURL('image/jpeg', 0.95);
                    if (page > 0) pdfDoc.addPage(); pdfDoc.addImage(imgData, 'JPEG', 0, 0, 595.28, 841.89);
                }
                pdfDoc.save(`RoomSummary_${roomName}_${month}.pdf`);
                showToast("สร้างไฟล์ PDF สำเร็จ!", "success");
            } catch (err) { showToast("เกิดข้อผิดพลาดในการสร้าง PDF", "error"); } document.getElementById('pdf-room-container').remove();
            if (__wasDark) document.documentElement.classList.add('dark');
        }

        window.downloadRoomDailyPDF = async function(roomId, date) {
            showToast("กำลังประมวลผล PDF กรุณารอสักครู่...", "success");
            const __wasDark = document.documentElement.classList.contains('dark'); if (__wasDark) document.documentElement.classList.remove('dark');
            const roomName = formatRoomName(roomId), roomStudents = getRoomStudents(roomId).sort((a,b) => parseInt(a.number) - parseInt(b.number)), roomSubjects = getRoomSubjects(roomId);
            const advData = getRoomAdvisors(roomId); let advisorText = Array.isArray(advData) ? advData.filter(a => a.trim()).join(' และ ') : "ยังไม่ระบุ";
            const staffName = getRoomStaff(roomId);
            const signerListDaily = [];
            if (advData[0]) signerListDaily.push({ name: advData[0], role: advData[1] ? 'ครูที่ปรึกษาคนที่ 1' : 'ครูที่ปรึกษา' });
            if (advData[1]) signerListDaily.push({ name: advData[1], role: 'ครูที่ปรึกษาคนที่ 2' });
            signerListDaily.push({ name: staffName, role: 'เจ้าหน้าที่ / นายทะเบียน' });
            const dObj = new Date(date); const dayOfWeek = dObj.getDay(); let dayIndexForSched = getEffectiveDayOfWeek(date);
            const subjectsToday = []; roomSubjects.forEach(s => { if (s.schedules) { effSched(s).forEach(sch => { if (parseInt(sch.day) === dayIndexForSched) { subjectsToday.push({ ...s, period: parseInt(sch.period) }); } }); } });
            subjectsToday.sort((a,b) => a.period - b.period);
            const dailyAttRecords = attendanceData.filter(a => a.date === date && subjectsToday.some(st => st.id === a.subjectId && String(st.period) === String(a.period)));
            const STUDENTS_PER_PAGE = 24; const pagesCount = Math.ceil(roomStudents.length / STUDENTS_PER_PAGE) || 1; // ลดจาก 30 เพื่อกันเนื้อหาล้นหน้า A4
            const pdfDoc = new jspdf.jsPDF('p', 'pt', 'a4');
            let htmlContainer = `<div id="pdf-daily-room-container" class="a4-export-container text-slate-800" style="font-family: 'Sarabun', sans-serif;">`;
            const thaiMonths = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."]; const displayDateStr = `${dObj.getDate()} ${thaiMonths[dObj.getMonth()]} ${dObj.getFullYear() + 543}`;
            for (let page = 0; page < pagesCount; page++) {
                const dataChunk = roomStudents.slice(page * STUDENTS_PER_PAGE, (page + 1) * STUDENTS_PER_PAGE);
                let tableHTML = `<table class="w-full text-center border-collapse text-[12px] bg-white border border-slate-500" style="table-layout: fixed; width: 100%;"><thead class="bg-slate-100 text-slate-700"><tr><th class="p-2 border border-slate-500" style="width: 10%;">เลขที่</th><th class="p-2 border border-slate-500 text-left" style="width: 35%;">ชื่อ-นามสกุล</th>`;
                if (subjectsToday.length === 0) { tableHTML += `<th class="p-2 border border-slate-500 w-auto">ไม่มีวิชาเรียน</th>`;
                } else { const subColWidth = 55 / subjectsToday.length; subjectsToday.forEach(sub => { tableHTML += `<th class="p-2 border border-slate-500" style="width: ${subColWidth}%;"><div class="leading-tight" title="${sub.name}">${sub.name}</div><div class="text-[9px] mt-1 text-slate-500">คาบ ${periodLabel(sub.period)}</div></th>`; });
                }
                tableHTML += `</tr></thead><tbody class="divide-y divide-slate-400">`;
                dataChunk.forEach((st) => {
                    const isRes = st.status === 'resigned'; let bgRow = isRes ? 'bg-slate-100 text-slate-500 opacity-80' : 'bg-white';
                    tableHTML += `<tr class="${bgRow}"><td class="p-1.5 border border-slate-500 font-bold">${st.number}</td><td class="p-1.5 border border-slate-500 text-left font-bold">${st.name}${stuCodePdf(st)} ${isRes?'(ออก/ย้าย)':''}</td>`;
                    if (subjectsToday.length === 0) { tableHTML += `<td class="p-1.5 border border-slate-500">-</td>`; } else { subjectsToday.forEach(sub => { const attRecord = dailyAttRecords.find(a => a.subjectId === sub.id && String(a.period) === String(sub.period)); let statusStr = '-', statusCls = ''; if (attRecord && attRecord.records[st.id]) { statusStr = attRecord.records[st.id]; if(statusStr === 'มา' || statusStr === 'ร่วมกิจกรรม') statusCls = 'text-emerald-700 font-bold'; else if(statusStr === 'สาย') statusCls = 'text-amber-600 font-bold'; else statusCls = 'text-rose-600 font-bold';
                    } tableHTML += `<td class="p-1.5 border border-slate-500 ${statusCls} whitespace-nowrap">${statusStr}</td>`; });
                    }
                    tableHTML += `</tr>`;
                });
                tableHTML += '</tbody></table>';
                htmlContainer += `<div id="pdf-daily-room-page-${page}" class="a4-page flex flex-col justify-between bg-white">${pdfPageBadge(pagesCount > 1 ? `หน้า ${page+1}/${pagesCount}` : '')}<div>${rpHead(`รายงานการเช็คชื่อรายวัน`, rpPill(`ห้อง: ${roomName} | ประจำวันที่: ${displayDateStr}`))}<div class="mb-6 text-sm font-bold bg-slate-50 p-4 rounded-xl border border-slate-300 text-center"><span class="text-slate-500">ครูที่ปรึกษา:</span> ${advisorText}</div>${tableHTML}</div>${page === pagesCount - 1 ? buildPdfSignatureBlock(signerListDaily) : ''}</div>`;
            }
            htmlContainer += `</div>`; document.body.insertAdjacentHTML('beforeend', htmlContainer); rpFinalize(document.body.lastElementChild);
            await document.fonts.ready;
            await new Promise(resolve => setTimeout(resolve, 1500));
            try {
                for (let page = 0; page < pagesCount; page++) {
                    const el = document.getElementById(`pdf-daily-room-page-${page}`);
                    const canvas = await html2canvas(el, { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false }); const imgData = canvas.toDataURL('image/jpeg', 0.95);
                    if (page > 0) pdfDoc.addPage(); pdfDoc.addImage(imgData, 'JPEG', 0, 0, 595.28, 841.89);
                }
                pdfDoc.save(`DailySummary_${roomName}_${date}.pdf`);
                showToast("สร้างไฟล์ PDF สำเร็จ!", "success");
            } catch (err) { showToast("เกิดข้อผิดพลาดในการสร้าง PDF", "error"); } document.getElementById('pdf-daily-room-container').remove();
            if (__wasDark) document.documentElement.classList.add('dark');
        }

        // ===== สมุดทะเบียนการเช็คชื่อรายเดือน (รวมหน้าปก + บันทึกรายวันทุกวันจันทร์-ศุกร์ + หน้าสรุปทั้งเดือน + ลงนามครั้งเดียวท้ายเล่ม) =====
        // นับเฉพาะวันจันทร์-ศุกร์เท่านั้น (เสาร์-อาทิตย์ไม่นับรวมเด็ดขาด) วันที่ตรงกับวันหยุดที่แอดมินประกาศไว้จะขึ้นหน้าแจ้งวันหยุดแทนตารางเช็คชื่อ
        let __registerChoicePending = null;
        window.downloadRoomMonthlyRegisterPDF = function(roomId, month) {
            const reportCheck = window.tempRoomReport; if (!reportCheck || reportCheck.roomId !== roomId) { showToast("กรุณาเปิดหน้าสรุปห้องนี้ก่อนสร้างสมุดทะเบียน", "error"); return; }
            __registerChoicePending = { roomId, month };
            const modal = document.getElementById('registerChoiceModal'); const box = document.getElementById('registerChoiceModalBox');
            modal.classList.remove('hidden'); setTimeout(() => { box.classList.remove('scale-95', 'opacity-0'); box.classList.add('scale-100', 'opacity-100'); }, 10);
        };
        window.closeRegisterChoiceModal = function() {
            const modal = document.getElementById('registerChoiceModal'); const box = document.getElementById('registerChoiceModalBox');
            box.classList.remove('scale-100', 'opacity-100'); box.classList.add('scale-95', 'opacity-0');
            setTimeout(() => { modal.classList.add('hidden'); }, 300);
        };
        window.__chooseRegisterMode = function(mode) {
            window.closeRegisterChoiceModal();
            if (!__registerChoicePending) return;
            const { roomId, month } = __registerChoicePending; __registerChoicePending = null;
            const modeLabel = mode === 'summary' ? 'เฉพาะสรุป (ปก + สรุปทั้งเดือน + รายชื่อนักเรียนที่ต้องติดตาม)' : (mode === 'incomplete_only' ? 'เฉพาะรายชื่อนักเรียนที่ต้องติดตาม' : (mode === 'monthly_and_incomplete' ? 'สรุปรายเดือน + รายชื่อนักเรียนที่ต้องติดตาม (ไม่มีปก)' : 'ทั้งเล่ม (รวมภาคผนวกบันทึกรายวันทุกวัน)'));
            showConfirm("สร้างสมุดทะเบียนรายเดือน", `จะสร้างสมุดทะเบียนแบบ "${modeLabel}" ซึ่งอาจใช้เวลาสักครู่ พร้อมดำเนินการหรือไม่?`, () => {
                window.__runDownloadRoomMonthlyRegisterPDF(roomId, month, mode);
            });
        };

        // ===== [ใหม่] สรุปเขตพื้นที่รับผิดชอบ (คาบ A) - รายงานแยกจากสมุดทะเบียน =====
        window.downloadZoneSummaryPDF = function(roomId, month) {
            const report = window.tempRoomReport; if (!report || report.roomId !== roomId) { showToast("กรุณาเปิดหน้าสรุปห้องนี้ก่อน", "error"); return; }
            const zoneSubs = getRoomSubjects(roomId).filter(sb => (sb.schedules || []).some(sc => parseInt(sc.period) === -2));
            if (zoneSubs.length === 0) { showToast("ห้องนี้ยังไม่มีวิชา/กิจกรรมในคาบ A (เขตพื้นที่รับผิดชอบ)", "error"); return; }
            showConfirm("สรุปเขตรับผิดชอบ", `จะสร้างรายงานสรุปคาบ A เขตพื้นที่รับผิดชอบ ของห้อง ${formatRoomName(roomId)} ประจำเดือนที่เลือก พร้อมดำเนินการหรือไม่?`, () => { window.__runZoneSummaryPDF(roomId, month, zoneSubs); });
        };
        window.__runZoneSummaryPDF = async function(roomId, month, zoneSubs) {
            showProgressModal("กำลังจัดทำสรุปเขตรับผิดชอบ", "กำลังเตรียมข้อมูล...");
            const wasDark = document.documentElement.classList.contains('dark'); if (wasDark) document.documentElement.classList.remove('dark');
            await document.fonts.ready; await new Promise(r => setTimeout(r, 400));
            const roomName = formatRoomName(roomId);
            const students = getRoomStudents(roomId).sort((a,b) => parseInt(a.number) - parseInt(b.number));
            const advData = getRoomAdvisors(roomId); const staffName = getRoomStaff(roomId);
            const signers = []; if (advData[0]) signers.push({ name: advData[0], role: advData[1] ? 'ครูที่ปรึกษาคนที่ 1' : 'ครูที่ปรึกษา' }); if (advData[1]) signers.push({ name: advData[1], role: 'ครูที่ปรึกษาคนที่ 2' }); signers.push({ name: staffName, role: 'เจ้าหน้าที่ / นายทะเบียน' });
            const monthNames = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
            const [ys, ms] = month.split('-'); const year = parseInt(ys), mNum = parseInt(ms);
            const daysInMonth = new Date(year, mNum, 0).getDate();
            const zoneIds = new Set(zoneSubs.map(x => x.id));
            const cols = [];
            for (let d = 1; d <= daysInMonth; d++) {
                const dow = new Date(year, mNum - 1, d).getDay(); if (dow === 0 || dow === 6) continue;
                const dateStr = `${year}-${String(mNum).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                const hol = getHolidayForDate(dateStr);
                const effDow = getEffectiveDayOfWeek(dateStr);
                const hasZone = zoneSubs.some(sb => (sb.schedules || []).some(sc => parseInt(sc.period) === -2 && parseInt(sc.day) === effDow));
                const isHoliday = !!(hol && (!hol.type || hol.type === 'holiday'));
                const recs = attendanceData.filter(a => a.date === dateStr && parseInt(a.period) === -2 && zoneIds.has(a.subjectId));
                cols.push({ d, dateStr, hasZone, isHoliday, recs });
            }
            const activeCols = cols.filter(c => c.hasZone && !c.isHoliday);
            const abbr = { 'มา':'/', 'ร่วมกิจกรรม':'/', 'สาย':'ส', 'ลาป่วย':'ป', 'ลากิจ':'ก', 'ขาด':'ข', 'โดดเรียน':'ด' };
            const colorOf = { 'มา':'#047857', 'ร่วมกิจกรรม':'#047857', 'สาย':'#d97706' };
            const PER = 28; const pages = Math.ceil(students.length / PER) || 1;
            const zoneNames = zoneSubs.map(x => x.name).join(', ');
            let html = `<div id="pdf-zone-container" class="a4-export-container text-slate-800" style="font-family: 'Sarabun', sans-serif;">`;
            for (let p = 0; p < pages; p++) {
                const chunk = students.slice(p * PER, (p + 1) * PER);
                let t = `<table class="w-full text-center border-collapse bg-white border border-slate-500" style="table-layout:fixed; width:100%; font-size:10px;"><thead class="bg-slate-100"><tr><th class="p-1 border border-slate-500" style="width:5%;">ที่</th><th class="p-1 border border-slate-500 text-left" style="width:24%;">ชื่อ-นามสกุล</th>${activeCols.map(c => `<th class="p-0.5 border border-slate-500">${c.d}</th>`).join('')}<th class="p-1 border border-slate-500" style="width:4.5%;">มา</th><th class="p-1 border border-slate-500" style="width:4.5%;">สาย</th><th class="p-1 border border-slate-500" style="width:4.5%;">ลา</th><th class="p-1 border border-slate-500" style="width:4.5%;">ขาด</th></tr></thead><tbody>`;
                chunk.forEach(st => {
                    let present = 0, late = 0, leave = 0, absent = 0;
                    const cells = activeCols.map(c => {
                        const rec = c.recs.find(r => r.records && r.records[st.id]); const stt = rec ? rec.records[st.id] : null;
                        if (!stt) return `<td class="border border-slate-500 p-0.5 text-slate-300">-</td>`;
                        if (stt === 'มา' || stt === 'ร่วมกิจกรรม') present++; else if (stt === 'สาย') late++; else if (stt === 'ลาป่วย' || stt === 'ลากิจ') leave++; else absent++;
                        return `<td class="border border-slate-500 p-0.5 font-bold" style="color:${colorOf[stt] || '#e11d48'}">${abbr[stt] || stt}</td>`;
                    }).join('');
                    const res = st.status === 'resigned';
                    t += `<tr class="${res ? 'bg-slate-100 text-slate-500' : ''}"><td class="border border-slate-500 p-0.5 font-bold">${st.number}</td><td class="border border-slate-500 p-0.5 text-left font-bold" style="white-space:nowrap; overflow:hidden;">${st.name}${stuCodePdf(st)}${res ? ' (ออก/ย้าย)' : ''}</td>${cells}<td class="border border-slate-500 p-0.5 font-bold text-emerald-700">${present}</td><td class="border border-slate-500 p-0.5 font-bold text-amber-600">${late}</td><td class="border border-slate-500 p-0.5 font-bold text-indigo-600">${leave}</td><td class="border border-slate-500 p-0.5 font-bold text-rose-600">${absent}</td></tr>`;
                });
                t += `</tbody></table><p class="text-[10px] text-slate-500 mt-2 font-semibold">สัญลักษณ์: / = มา · ส = สาย · ป = ลาป่วย · ก = ลากิจ · ข = ขาด · ด = โดดเรียน · - = ยังไม่เช็ค · จำนวนวันที่มีคาบ A ในเดือนนี้ ${activeCols.length} วัน</p>`;
                html += `<div class="a4-page flex flex-col justify-between bg-white">${pdfPageBadge(pages > 1 ? `หน้า ${p+1}/${pages}` : '')}<div>${rpHead(`สรุปเขตพื้นที่รับผิดชอบ (คาบ A)`, rpPill(`ห้อง ${roomName} · ${monthNames[mNum-1]} ${year+543}`))}<p class="text-xs text-slate-500 mt-2 font-semibold">กิจกรรม/วิชา: ${zoneNames}</p>${t}</div>${p === pages - 1 ? buildPdfSignatureBlock(signers) : ''}</div>`;
            }
            // ===== [v1.71.3] บันทึกสภาพเขตพื้นที่ + รูปรายงาน (ถ้ามีบันทึกในเดือนนี้) =====
            try {
                const zs = zoneSubs[0];
                const zLogs = ((await hrLoadLogs(zs.term, zs.year, recStoreRoomId('zone', roomId), true)) || []).filter(l => String(l.date || '').startsWith(month)).sort((p, q) => p.date.localeCompare(q.date));
                if (zLogs.length) {
                    const thMs = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
                    const fmt = (d) => { const x = new Date(d); return `${x.getDate()} ${thMs[x.getMonth()]} ${x.getFullYear() + 543}`; };
                    const head2 = `${rpHead(`บันทึกสภาพเขตพื้นที่รับผิดชอบ`, rpPill(`ห้อง ${roomName} · ${monthNames[mNum-1]} ${year+543}`))}`;
                    const urls = await hrMapLimit(zLogs, 3, (l) => { const ph = (l.photos || [])[0]; return ph ? hrGetPhotoPdf(ph.id) : null; }, (d, n) => updateProgressModal((d / n) * 30, `กำลังโหลดรูปรายงาน ${d}/${n}...`)); // [v2.02.2]
                    const PERP = 4;
                    for (let p = 0; p < Math.ceil(zLogs.length / PERP); p++) {
                        const cells = zLogs.slice(p * PERP, (p + 1) * PERP).map((l, k) => { const u = urls[p * PERP + k]; return `<div style="border:1px solid #cbd5e1; border-radius:12px; padding:10px; display:flex; flex-direction:column; gap:6px;"><div style="display:flex; justify-content:space-between; font-size:13px; font-weight:800;"><span>${fmt(l.date)}</span><span style="color:#0f766e;">${hrEsc(l.condition || '-')}</span></div>${u ? `<div style="aspect-ratio:4/3; border-radius:8px; overflow:hidden; background:#e2e8f0;"><img src="${u}" style="width:100%; height:100%; object-fit:cover; display:block;"></div>` : `<div style="aspect-ratio:4/3; border-radius:8px; background:#f1f5f9; color:#64748b; display:flex; align-items:center; justify-content:center; font-size:12px; font-weight:700;">ไม่มีรูป / โหลดรูปไม่สำเร็จ</div>`}<div style="font-size:11px; color:#64748b; font-weight:600;">บันทึกโดย ${hrEsc(l.recordedBy || '-')}</div></div>`; }).join('');
                        html += `<div class="a4-page flex flex-col bg-white">${pdfPageBadge('บันทึกเขตพื้นที่')}${head2}<div style="display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px;">${cells}</div></div>`;
                    }
                }
            } catch (e) { /* โหลดบันทึกเขตพื้นที่ไม่สำเร็จ - ยังออกรายงานการเช็คชื่อได้ตามปกติ */ }
            html += `</div>`; document.body.insertAdjacentHTML('beforeend', html); rpFinalize(document.body.lastElementChild);
            await document.fonts.ready; await new Promise(r => setTimeout(r, 500));
            try {
                const pdfDoc = new jspdf.jsPDF('p', 'pt', 'a4');
                const els = document.querySelectorAll('#pdf-zone-container .a4-page');
                for (let i = 0; i < els.length; i++) {
                    updateProgressModal((i / els.length) * 100, `กำลังสร้างหน้าที่ ${i+1} จาก ${els.length}...`);
                    const canvas = await html2canvas(els[i], { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false });
                    if (i > 0) pdfDoc.addPage(); pdfDoc.addImage(canvas.toDataURL('image/jpeg', 0.95), 'JPEG', 0, 0, 595.28, 841.89);
                }
                updateProgressModal(100, "กำลังบันทึกไฟล์...");
                pdfDoc.save(`สรุปเขตรับผิดชอบ_${roomName}_${month}.pdf`);
                completeProgressModal("ดำเนินการเสร็จสิ้น", `สร้างสรุปเขตรับผิดชอบ (${els.length} หน้า) สำเร็จ ไฟล์ถูกดาวน์โหลดแล้ว`);
            } catch (err) { errorProgressModal("เกิดข้อผิดพลาดในการสร้างรายงาน กรุณาลองใหม่อีกครั้ง"); }
            const el = document.getElementById('pdf-zone-container'); if (el) el.remove();
            if (wasDark) document.documentElement.classList.add('dark');
        };
        window.__runDownloadRoomMonthlyRegisterPDF = async function(roomId, month, mode = 'full') {
            const report = window.tempRoomReport; if (!report || report.roomId !== roomId) { showToast("กรุณาเปิดหน้าสรุปห้องนี้ก่อนสร้างสมุดทะเบียน", "error"); return; }
            showProgressModal("กำลังจัดทำสมุดทะเบียน", "กำลังเตรียมข้อมูล...");
            const __wasDark = document.documentElement.classList.contains('dark'); if (__wasDark) document.documentElement.classList.remove('dark');
            await document.fonts.ready; // รอฟอนต์ครั้งเดียวตอนเริ่ม ไม่ต้องรอซ้ำทุกหน้า (มีหลายสิบหน้า จะช้ามากถ้ารอทุกหน้า)
            await new Promise(resolve => setTimeout(resolve, 500));

            const roomName = formatRoomName(roomId);
            const roomStudents = getRoomStudents(roomId).sort((a,b) => parseInt(a.number) - parseInt(b.number));
            const roomSubjects = getRoomSubjects(roomId);
            const advData = getRoomAdvisors(roomId);
            const staffName = getRoomStaff(roomId);
            const signerList = [];
            if (advData[0]) signerList.push({ name: advData[0], role: advData[1] ? 'ครูที่ปรึกษาคนที่ 1' : 'ครูที่ปรึกษา' });
            if (advData[1]) signerList.push({ name: advData[1], role: 'ครูที่ปรึกษาคนที่ 2' });
            signerList.push({ name: staffName, role: 'เจ้าหน้าที่ / นายทะเบียน' });

            const monthNames = ["มกราคม","กุมภาพันธ์","มีนาคม","เมษายน","พฤษภาคม","มิถุนายน","กรกฎาคม","สิงหาคม","กันยายน","ตุลาคม","พฤศจิกายน","ธันวาคม"];
            const thaiMonthsShort = ["ม.ค.","ก.พ.","มี.ค.","เม.ย.","พ.ค.","มิ.ย.","ก.ค.","ส.ค.","ก.ย.","ต.ค.","พ.ย.","ธ.ค."];
            const [yearStr, monthStr] = month.split('-');
            const year = parseInt(yearStr), monthNum = parseInt(monthStr);
            const daysInMonth = new Date(year, monthNum, 0).getDate();
            const displayMonthYear = `${monthNames[monthNum-1]} ${year+543}`;
            const STUDENTS_PER_PAGE = 24;

            // เก็บเฉพาะวันจันทร์-ศุกร์ในเดือนนี้ (dow: 1=จันทร์ ... 5=ศุกร์) เสาร์-อาทิตย์ข้ามไปเลย ไม่นับรวมในเล่ม
            const weekdays = [];
            for (let d = 1; d <= daysInMonth; d++) {
                const dObj = new Date(year, monthNum - 1, d);
                const dow = dObj.getDay();
                if (dow === 0 || dow === 6) continue;
                const dateStr = `${year}-${String(monthNum).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
                weekdays.push({ day: d, dateStr, dObj, dow, holiday: getHolidayForDate(dateStr) });
            }
            const totalWeekdays = weekdays.length;
            const totalHolidays = weekdays.filter(w => w.holiday && (!w.holiday.type || w.holiday.type === 'holiday')).length;
            const totalTeachingDays = totalWeekdays - totalHolidays;

            const pdfDoc = new jspdf.jsPDF('p', 'pt', 'a4');
            let htmlContainer = `<div id="pdf-register-container" class="a4-export-container text-slate-800" style="font-family: 'Sarabun', sans-serif;">`;

            // ===== หน้าปก (ข้ามในโหมด "จัดทำเฉพาะรายชื่อนักเรียนที่ต้องติดตาม" และ "จัดทำสรุปรายเดือน+ติดตามนักเรียน") =====
            if (mode !== 'incomplete_only' && mode !== 'monthly_and_incomplete') {
            htmlContainer += `<div id="pdf-reg-cover" class="a4-page rp-cover"><div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:linear-gradient(180deg,#eef2ff 0%,#ffffff 62%);border-left:10px solid #4338ca">${settings.logoDataUrl ? `<img src="${settings.logoDataUrl}" style="width:104px;height:104px;object-fit:cover;border-radius:50%;border:4px solid #fff;box-shadow:0 6px 18px rgba(67,56,202,.18)">` : `<div style="width:104px;height:104px;border-radius:28px;background:#4338ca;color:#fff;display:flex;align-items:center;justify-content:center;font-size:44px;font-weight:800">${rpEsc((settings.title || 'บ').trim().charAt(0))}</div>`}<div style="margin-top:16px;font-size:16px;font-weight:700;color:#475569">${rpEsc(settings.title || 'ระบบเช็คชื่อนักเรียน')}</div><div style="margin-top:34px;background:#4338ca;color:#fff;border-radius:999px;padding:4px 20px;font-weight:800;font-size:15px">สมุดทะเบียนการเช็คชื่อนักเรียน</div><div style="font-size:54px;font-weight:800;color:#1e1b4b;margin-top:10px">ห้อง ${roomName}</div><div style="font-size:19px;color:#475569;font-weight:700">ประจำเดือน${displayMonthYear}</div><div style="margin-top:40px;display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;width:430px;text-align:left">${[['นักเรียนทั้งหมด', roomStudents.length + ' คน', '#0f172a'], ['วันทำการ (จ–ศ)', totalWeekdays + ' วัน', '#0f172a'], ['วันหยุดประกาศ', totalHolidays + ' วัน', '#e11d48'], ['วันเรียนจริง', totalTeachingDays + ' วัน', '#16a34a']].map(x => `<div style="background:#fff;border:1px solid #c7d2fe;border-radius:16px;padding:10px 16px"><div style="font-size:12px;color:#64748b;font-weight:700">${x[0]}</div><div style="font-size:26px;font-weight:800;color:${x[2]}">${x[1]}</div></div>`).join('')}</div><div style="margin-top:34px;font-size:12px;color:#64748b">ครูที่ปรึกษา: ${rpEsc(advData.filter(a => a && a.trim()).join(' · ') || '-')} · ${rpEsc(rpTermText())}</div></div></div>`;
            }

            // ===== หน้าสรุปทั้งเดือน + ลงนาม (กลับมาลงนามในหน้านี้ตามเดิม) - แสดงทุกโหมดยกเว้น "เฉพาะรายชื่อนักเรียนที่ต้องติดตาม" =====
            if (mode !== 'incomplete_only') {
            const summaryPagesCount = Math.ceil(report.data.length / STUDENTS_PER_PAGE) || 1;
            for (let page = 0; page < summaryPagesCount; page++) {
                const dataChunk = report.data.slice(page * STUDENTS_PER_PAGE, (page + 1) * STUDENTS_PER_PAGE);
                let tableHTML = `<table class="w-full text-center border-collapse text-[12px] bg-white border border-slate-500" style="table-layout: fixed; width: 100%;"><thead class="bg-slate-100 text-slate-700"><tr><th class="p-2 border border-slate-500" style="width: 8%;">เลขที่</th><th class="p-2 border border-slate-500 text-left" style="width: 32%;">ชื่อ-นามสกุล</th><th class="p-2 border border-slate-500" style="width: 6%;">ส.1</th><th class="p-2 border border-slate-500" style="width: 6%;">ส.2</th><th class="p-2 border border-slate-500" style="width: 6%;">ส.3</th><th class="p-2 border border-slate-500" style="width: 6%;">ส.4</th><th class="p-2 border border-slate-500" style="width: 6%;">ส.5</th><th class="p-2 border border-slate-500 bg-emerald-50 text-emerald-800" style="width: 6%;">มา</th><th class="p-2 border border-slate-500 bg-blue-50 text-blue-800" style="width: 6%;">ลา</th><th class="p-2 border border-slate-500 bg-rose-50 text-rose-800" style="width: 6%;">ขาด</th><th class="p-2 border border-slate-500 text-indigo-700" style="width: 12%;">การติดตาม</th></tr></thead><tbody class="divide-y divide-slate-400">`;
                dataChunk.forEach((row) => {
                    const isRes = row.student.status === 'resigned'; let bgRow = isRes ? 'bg-slate-100 text-slate-500 opacity-80' : 'bg-white';
                    let valid = row.monthly['มา'] + row.monthly['ร่วมกิจกรรม'], leave = row.monthly['ลากิจ'] + row.monthly['ลาป่วย'], absent = row.monthly['ขาด'] + row.monthly['โดดเรียน'];
                    let fwText = '-'; let fwCls = '';
                    let lateLimit = settings.thresholds?.late || 4; let absLimit = settings.thresholds?.absent || 4;
                    let lateCount = row.monthly['สาย'] || 0; let absentCount = row.monthly['ขาด'] || 0;
                    const incompleteTriggeredPdf = (row.triggerDatesThisMonth || []).length > 0;
                    if (lateCount >= lateLimit || absentCount >= absLimit || incompleteTriggeredPdf) {
                        const isFollowedUp = followUps.find(f => f.studentId === row.student.id && f.month === month);
                        if (isFollowedUp) { fwText = 'ติดตามแล้ว'; fwCls = 'text-emerald-700 bg-emerald-50 font-bold'; }
                        else { fwText = 'ต้องติดตาม'; fwCls = 'text-rose-700 bg-rose-50 font-bold'; }
                    }
                    tableHTML += `<tr class="${bgRow}"><td class="p-1.5 border border-slate-500 font-bold">${row.student.number}</td><td class="p-1.5 border border-slate-500 text-left font-bold">${row.student.name} ${isRes?'(ออก)':''}</td><td class="p-1.5 border border-slate-500">${row.weekly[1]||'-'}</td><td class="p-1.5 border border-slate-500">${row.weekly[2]||'-'}</td><td class="p-1.5 border border-slate-500">${row.weekly[3]||'-'}</td><td class="p-1.5 border border-slate-500">${row.weekly[4]||'-'}</td><td class="p-1.5 border border-slate-500">${row.weekly[5]||'-'}</td><td class="p-1.5 border border-slate-500 font-black text-emerald-700 bg-emerald-50/50">${valid||'-'}</td><td class="p-1.5 border border-slate-500 font-black text-blue-700 bg-blue-50/50">${leave||'-'}</td><td class="p-1.5 border border-slate-500 font-black text-rose-700 bg-rose-50/50">${absent||'-'}</td><td class="p-1.5 border border-slate-500 ${fwCls} text-[10px]">${fwText}</td></tr>`;
                });
                tableHTML += '</tbody></table>';
                htmlContainer += `<div class="a4-page flex flex-col justify-between bg-white">${pdfPageBadge(summaryPagesCount > 1 ? `หน้าสรุป ${page+1}/${summaryPagesCount}` : '')}<div>${rpHead(`สรุปผลรวมทั้งเดือน`, rpPill(`ห้อง: ${roomName} | ประจำเดือน: ${displayMonthYear}`))}${tableHTML}</div>${page === summaryPagesCount - 1 ? buildPdfSignatureBlock(signerList) : ''}</div>`;
            }
            } // ปิดเงื่อนไข mode !== 'incomplete_only' (สรุปทั้งเดือน)

            // ===== หน้ากราฟสรุปสถิติการมาเรียน - ย้ายมาจากหน้าเว็บ (ไม่มีให้ส่งออกแยกอีกต่อไป) แสดงเฉพาะโหมดที่มีหน้าสรุปแบบเต็ม (summary/full) ก่อนหน้านักเรียนที่ต้องติดตาม - ข้ามในโหมด "สรุปรายเดือน+ติดตามนักเรียน" ตามที่ขอให้กระชับที่สุด =====
            let regBookChartTotals = null;
            if (mode !== 'incomplete_only' && mode !== 'monthly_and_incomplete') {
                regBookChartTotals = { 'มา': 0, 'ร่วมกิจกรรม': 0, 'สาย': 0, 'ลาป่วย': 0, 'ลากิจ': 0, 'ขาด': 0, 'โดดเรียน': 0 };
                report.data.forEach(row => { Object.keys(regBookChartTotals).forEach(k => regBookChartTotals[k] += (row.monthly[k] || 0)); });
                const cN = Object.values(regBookChartTotals).reduce((a, b) => a + b, 0), cOk = regBookChartTotals['มา'] + regBookChartTotals['ร่วมกิจกรรม'] + regBookChartTotals['สาย'], cPct = cN ? Math.round(cOk / cN * 1000) / 10 : null;
                htmlContainer += `<div class="a4-page flex flex-col bg-white">${pdfPageBadge('กราฟสรุป')}${rpHead('กราฟสรุปสถิติการมาเรียน', rpPill(`ห้อง: ${roomName} | ประจำเดือน: ${displayMonthYear}`))}${rpKpis([['มาเรียน (รวมสาย)', cPct == null ? '-' : cPct + '%', rpPctColor(cPct)], ['สาย', regBookChartTotals['สาย'], '#d97706'], ['ลา', regBookChartTotals['ลาป่วย'] + regBookChartTotals['ลากิจ'], '#2563eb'], ['ขาด / โดด', regBookChartTotals['ขาด'] + regBookChartTotals['โดดเรียน'], '#e11d48']])}<div style="display:grid;grid-template-columns:300px 1fr;gap:30px;align-items:center;margin-top:30px"><div>${rpDonut(regBookChartTotals, 290)}</div><div>${rpStatusRows(regBookChartTotals)}</div></div>${rpSec('สัดส่วนสถานะ', 'ทั้งห้องตลอดเดือน')}${rpStack(regBookChartTotals, 16)}${rpLegend()}</div>`;
            }

            // ===== รายชื่อ "นักเรียนที่ต้องติดตาม" (รวม 2 เกณฑ์) + ลงนามของส่วนนี้เอง (เป็นการยืนยันแยกต่างหากจากหน้าสรุป) - แสดงทุกโหมด =====
            const incompleteList = report.incompleteList || [];
            const INC_PER_PAGE = 20;
            const incPagesCount = Math.ceil(incompleteList.length / INC_PER_PAGE) || 1;
            for (let page = 0; page < incPagesCount; page++) {
                const chunk = incompleteList.slice(page * INC_PER_PAGE, (page + 1) * INC_PER_PAGE);
                let listHTML;
                if (incompleteList.length === 0) {
                    listHTML = `<div class="flex-1 flex flex-col items-center justify-center text-center py-16"><p class="text-lg font-black text-emerald-600">ไม่มีนักเรียนที่เข้าเงื่อนไขในเดือนนี้</p><p class="text-sm text-slate-400 mt-2">(เข้าเรียนไม่ครบซ้ำตามเกณฑ์ หรือ สาย/ขาด เกินจำนวนวันที่ตั้งไว้ต่อเดือน)</p></div>`;
                } else {
                    listHTML = `<table class="w-full text-center border-collapse text-[11px] bg-white border border-slate-500" style="table-layout: fixed; width: 100%;"><thead class="bg-slate-100 text-slate-700"><tr><th class="p-2 border border-slate-500" style="width: 6%;">เลขที่</th><th class="p-2 border border-slate-500 text-left" style="width: 24%;">ชื่อ-นามสกุล</th><th class="p-2 border border-slate-500" style="width: 8%;">สาย(ด)</th><th class="p-2 border border-slate-500" style="width: 8%;">ขาด(ด)</th><th class="p-2 border border-slate-500" style="width: 27%;">วันที่เข้าเรียนไม่ครบในเดือนนี้</th><th class="p-2 border border-slate-500" style="width: 27%;">เหตุผลที่ต้องติดตาม</th></tr></thead><tbody class="divide-y divide-slate-400">${chunk.map(row => { const incompleteDatesDisplay = row.incompleteDays.map(d => { const p = d.date.split('-'); return `${p[2]}/${p[1]}`; }).join(', '); const reasons = [ row.triggerDatesThisMonth.length > 0 ? 'เข้าเรียนไม่ครบ' : '', row.lateExceeded ? 'สายเกินเกณฑ์' : '', row.absentExceeded ? 'ขาดเกินเกณฑ์' : '' ].filter(Boolean).join(' / '); return `<tr class="bg-white"><td class="p-1.5 border border-slate-500 font-bold">${row.student.number}</td><td class="p-1.5 border border-slate-500 text-left font-bold">${row.student.name}</td><td class="p-1.5 border border-slate-500 font-bold text-amber-600">${row.monthly['สาย']||0}</td><td class="p-1.5 border border-slate-500 font-bold text-rose-600">${row.monthly['ขาด']||0}</td><td class="p-1.5 border border-slate-500 font-bold text-slate-600 text-[10px]">${incompleteDatesDisplay || '-'}</td><td class="p-1.5 border border-slate-500 font-black text-orange-600 text-[10px]">${reasons || '-'}</td></tr>`; }).join('')}</tbody></table>`;
                }
                htmlContainer += `<div class="a4-page flex flex-col justify-between bg-white">${pdfPageBadge(incPagesCount > 1 ? `หน้า ${page+1}/${incPagesCount}` : '')}<div>${rpHead(`นักเรียนที่ต้องติดตาม`, rpPill(`ห้อง: ${roomName} | ประจำเดือน: ${displayMonthYear}`))}${listHTML}</div>${page === incPagesCount - 1 ? buildPdfSignatureBlock(signerList) : ''}</div>`;
            }

            // ===== หน้าคั่นภาคผนวก + บันทึกรายวัน (เฉพาะโหมด "จัดทำทั้งเล่ม" เท่านั้น) =====
            if (mode === 'full') {
            htmlContainer += `<div class="a4-page rp-cover"><div style="height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;background:linear-gradient(180deg,#f8fafc,#fff);border-left:10px solid #94a3b8"><div style="background:#475569;color:#fff;border-radius:999px;padding:4px 18px;font-weight:800">ภาคผนวก</div><div style="font-size:34px;font-weight:800;color:#1e293b;margin-top:12px">บันทึกการเช็คชื่อรายวัน</div><div style="font-size:14px;color:#64748b;margin-top:6px">ห้อง ${roomName} · ประจำเดือน${displayMonthYear} · เอกสารประกอบสำหรับตรวจสอบย้อนหลัง</div></div></div>`;

            // ===== หน้าบันทึกรายวัน (จันทร์-ศุกร์ทุกวัน) - ภาคผนวก อยู่ท้ายเล่ม =====
            weekdays.forEach(w => {
                const displayDateStr = `${w.day} ${thaiMonthsShort[monthNum-1]} ${year + 543}`;
                if (w.holiday) {
                    htmlContainer += `<div class="a4-page flex flex-col bg-white">${pdfPageBadge('ภาคผนวก')}${rpHead(`บันทึกประจำวันที่ ${displayDateStr}`, rpPill(`ห้อง: ${roomName}`))}<div class="flex-1 flex flex-col items-center justify-center text-center py-16"><div class="w-20 h-20 bg-rose-100 text-rose-500 rounded-full flex items-center justify-center text-4xl mb-6"><i class="fas fa-calendar-times"></i></div><p class="text-2xl font-black text-rose-600 mb-2">วันหยุด</p><p class="text-lg font-bold text-slate-600">${w.holiday.label}</p><p class="text-sm text-slate-400 mt-4">ไม่มีการเรียนการสอนในวันนี้</p></div></div>`;
                    return;
                }
                const subjectsToday = []; roomSubjects.forEach(s => { if (s.schedules) { effSched(s).forEach(sch => { if (parseInt(sch.day) === w.dow && parseInt(sch.period) !== -2) { subjectsToday.push({ ...s, period: parseInt(sch.period) }); } }); } });
                subjectsToday.sort((a,b) => a.period - b.period);
                const dailyAttRecords = attendanceData.filter(a => a.date === w.dateStr && subjectsToday.some(st => st.id === a.subjectId && String(st.period) === String(a.period)));
                const pagesForDay = Math.ceil(roomStudents.length / STUDENTS_PER_PAGE) || 1;
                for (let p = 0; p < pagesForDay; p++) {
                    const dataChunk = roomStudents.slice(p * STUDENTS_PER_PAGE, (p + 1) * STUDENTS_PER_PAGE);
                    let tableHTML = `<table class="w-full text-center border-collapse text-[12px] bg-white border border-slate-500" style="table-layout: fixed; width: 100%;"><thead class="bg-slate-100 text-slate-700"><tr><th class="p-2 border border-slate-500" style="width: 10%;">เลขที่</th><th class="p-2 border border-slate-500 text-left" style="width: 35%;">ชื่อ-นามสกุล</th>`;
                    if (subjectsToday.length === 0) { tableHTML += `<th class="p-2 border border-slate-500 w-auto">ไม่มีวิชาเรียน</th>`;
                    } else { const subColWidth = 55 / subjectsToday.length; subjectsToday.forEach(sub => { tableHTML += `<th class="p-2 border border-slate-500" style="width: ${subColWidth}%;"><div class="leading-tight" title="${sub.name}">${sub.name}</div><div class="text-[9px] mt-1 text-slate-500">คาบ ${periodLabel(sub.period)}</div></th>`; }); }
                    tableHTML += `</tr></thead><tbody class="divide-y divide-slate-400">`;
                    dataChunk.forEach((st) => {
                        const isRes = st.status === 'resigned'; let bgRow = isRes ? 'bg-slate-100 text-slate-500 opacity-80' : 'bg-white';
                        tableHTML += `<tr class="${bgRow}"><td class="p-1.5 border border-slate-500 font-bold">${st.number}</td><td class="p-1.5 border border-slate-500 text-left font-bold">${st.name}${stuCodePdf(st)} ${isRes?'(ออก/ย้าย)':''}</td>`;
                        if (subjectsToday.length === 0) { tableHTML += `<td class="p-1.5 border border-slate-500">-</td>`; } else { subjectsToday.forEach(sub => { const attRecord = dailyAttRecords.find(a => a.subjectId === sub.id && String(a.period) === String(sub.period)); let statusStr = '-', statusCls = ''; if (attRecord && attRecord.records[st.id]) { statusStr = attRecord.records[st.id]; if(statusStr === 'มา' || statusStr === 'ร่วมกิจกรรม') statusCls = 'text-emerald-700 font-bold'; else if(statusStr === 'สาย') statusCls = 'text-amber-600 font-bold'; else statusCls = 'text-rose-600 font-bold';
                        } tableHTML += `<td class="p-1.5 border border-slate-500 ${statusCls} whitespace-nowrap">${statusStr}</td>`; }); }
                        tableHTML += `</tr>`;
                    });
                    tableHTML += '</tbody></table>';
                    htmlContainer += `<div class="a4-page flex flex-col bg-white">${pdfPageBadge(pagesForDay > 1 ? `ภาคผนวก · หน้าเสริม ${p+1}/${pagesForDay}` : 'ภาคผนวก')}${rpHead(`บันทึกประจำวันที่ ${displayDateStr}`, rpPill(`ห้อง: ${roomName}`))}${tableHTML}</div>`;
                }
            });
            } // ปิดเงื่อนไข mode === 'full'

            htmlContainer += `</div>`; document.body.insertAdjacentHTML('beforeend', htmlContainer); rpFinalize(document.body.lastElementChild);
            // [v2.01.0] วงกลมสัดส่วนวาดเองใน rpFinalize (ไม่พึ่ง Chart.js)
            await document.fonts.ready;
            await new Promise(resolve => setTimeout(resolve, 800));
            try {
                const allPages = document.querySelectorAll('#pdf-register-container .a4-page');
                const totalPages = allPages.length;
                for (let i = 0; i < totalPages; i++) {
                    updateProgressModal((i / totalPages) * 100, `กำลังสร้างหน้าที่ ${i+1} จาก ${totalPages}...`);
                    const canvas = await html2canvas(allPages[i], { scale: 2, backgroundColor: "#ffffff", useCORS: true, logging: false });
                    const imgData = canvas.toDataURL('image/jpeg', 0.95);
                    if (i > 0) pdfDoc.addPage(); pdfDoc.addImage(imgData, 'JPEG', 0, 0, 595.28, 841.89);
                }
                updateProgressModal(100, "กำลังบันทึกไฟล์...");
                const modeSuffix = mode === 'summary' ? '_สรุป' : (mode === 'incomplete_only' ? '_นักเรียนที่ต้องติดตาม' : (mode === 'monthly_and_incomplete' ? '_สรุปเดือน_ติดตามนักเรียน' : ''));
                pdfDoc.save(`สมุดทะเบียน_${roomName}_${month}${modeSuffix}.pdf`);
                completeProgressModal("ดำเนินการเสร็จสิ้น", `สร้างสมุดทะเบียน (${totalPages} หน้า) สำเร็จ ไฟล์ถูกดาวน์โหลดแล้ว`);
            } catch (err) { errorProgressModal("เกิดข้อผิดพลาดในการสร้างสมุดทะเบียน กรุณาลองใหม่อีกครั้ง"); }
            document.getElementById('pdf-register-container').remove();
            if (__wasDark) document.documentElement.classList.add('dark');
        };
    
