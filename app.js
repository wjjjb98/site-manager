/* 现场经理工作平台 — 云端多人版（匿名共享 + 本地优先容错）
 * 数据存储在 WorkBuddy 云后端（PostgreSQL + RLS 行级权限），多人共享同一份数据。
 * 容错设计：预览/离线/跨域受限时自动降级为 localStorage 本地模式，云端可用时后台静默同步。
 */
(function () {
  'use strict';

  const FAULT_TYPES = ['机械故障', '电气故障', '液压/气动故障', '控制系统故障', '结构/磨损', '安全装置', '仪表/传感器', '其他'];
  const STATUSES = ['待处理', '处理中', '已解决'];
  const SEVERITIES = ['紧急', '重要', '一般'];

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const today = () => new Date().toISOString().slice(0, 10);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  // ---- 云客户端 ----
  let cloud = null;
  try {
    if (window.WorkBuddyCloud && window.CLOUD_CONFIG) {
      cloud = window.WorkBuddyCloud.createWorkBuddyCloud({
        endpoint: window.CLOUD_CONFIG.endpoint,
        oauthRelayBaseUrl: window.CLOUD_CONFIG.oauthRelayBaseUrl,
        publishableKey: window.CLOUD_CONFIG.publishableKey
      });
    }
  } catch (e) { console.error('云客户端初始化失败', e); }

  // ---- 运行时状态（匿名共享模式：无登录，所有访客共用同一份云端数据）----
  let myUid = null;
  let projects = [];          // {id,name,location,owner_id,created_at,...}
  let records = [];           // {id,project_id,device,code,type,severity,status,description,reporter,fault_date}
  let members = {};           // pid -> []（匿名模式无成员体系）
  let charts = {};
  let syncing = false;
  let cloudOk = false;        // 最近一次云端连接是否成功
  // 离线创建/删除的待同步项（云端不可用期间写入本地，恢复后自动推送）
  let pendingP = [];          // 离线新建的项目（projects 的子集）
  let pendingR = [];          // 离线新建的记录（records 的子集）
  let deletedP = [];          // 待删除的云端项目 id
  let deletedR = [];          // 待删除的云端记录 id

  // ---- 本地缓存（localStorage）----
  const LS_KEY = 'fmp_data_v1';
  function loadCache() {
    try {
      const o = JSON.parse(localStorage.getItem(LS_KEY) || 'null');
      if (o) {
        projects = Array.isArray(o.projects) ? o.projects : [];
        records = Array.isArray(o.records) ? o.records : [];
        pendingP = Array.isArray(o.pendingP) ? o.pendingP : [];
        pendingR = Array.isArray(o.pendingR) ? o.pendingR : [];
        deletedP = Array.isArray(o.deletedP) ? o.deletedP : [];
        deletedR = Array.isArray(o.deletedR) ? o.deletedR : [];
      }
    } catch (e) { console.warn('读取本地缓存失败', e); }
  }
  function saveCache() {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ projects, records, pendingP, pendingR, deletedP, deletedR }));
    } catch (e) { console.warn('写入本地缓存失败', e); }
  }

  // ---- 通用 UI ----
  function toast(msg) {
    const t = $('#toast'); t.textContent = msg; t.hidden = false;
    clearTimeout(t._t); t._t = setTimeout(() => (t.hidden = true), 1800);
  }
  function openModal(id) { $('#' + id).hidden = false; }
  function closeModal(id) { $('#' + id).hidden = true; }
  function setCloudStatus(state) {
    const b = $('#cloudBadge'); if (!b) return;
    if (state === 'online') { b.textContent = '☁ 云端已连接'; b.className = 'cloud-badge ok'; }
    else if (state === 'sync') { b.textContent = '⟳ 同步中'; b.className = 'cloud-badge sync'; }
    else { b.textContent = '📱 本地模式'; b.className = 'cloud-badge off'; }
  }
  // 用户主动操作失败时的提示（后台同步失败不再打扰用户）
  async function guard(fn) {
    try { return await fn(); }
    catch (e) { console.error(e); toast('操作失败：' + (e && e.message ? e.message : '网络异常')); return null; }
  }

  // ---- 权限（匿名共享：所有访客均为 owner，可管理/录入/删除）----
  function roleOf(pid) {
    const p = projects.find(x => x.id === pid);
    if (!p) return null;
    if (p.owner_id === myUid) return 'owner';
    const m = (members[pid] || []).find(m => m.user_id === myUid);
    return m ? m.role : null;
  }
  function canEditRecords(pid) { const r = roleOf(pid); return r === 'owner' || r === 'admin' || r === 'editor'; }
  function canDeleteRecords(pid) { const r = roleOf(pid); return r === 'owner' || r === 'admin'; }
  function canManage(pid) { return roleOf(pid) === 'owner'; }
  function activeProjectId() {
    const v = $('#projectSelect').value;
    if (v) return isNaN(Number(v)) ? v : Number(v);   // 本地项为字符串 id，云端项为数字 id
    return projects[0] ? projects[0].id : null;
  }
  function projectName(id) { const p = projects.find(x => x.id === id); return p ? p.name : '—'; }

  // ---- 云数据库封装 ----
  function dbSelect(t) { return cloud.database.from(t).select('*').order('created_at', { ascending: false }); }
  function dbInsert(t, p) { return cloud.database.from(t).insert(p).select(); }
  function dbUpdate(t, p, id) { return cloud.database.from(t).update(p).eq('id', id).select(); }
  function dbDelete(t, id) { return cloud.database.from(t).delete().eq('id', id).select(); }
  function stripLocal(p) { const c = Object.assign({}, p); delete c._local; delete c.syncKey; delete c.id; return c; }

  // ================= 启动 =================
  function boot() {
    loadCache();              // 先展示本地缓存，立即可用（无需等待云端）
    renderAll();
    if (cloud) refreshAll();  // 后台尝试云端同步
    else setCloudStatus('offline');
  }

  // ================= 数据层（本地优先 + 云端同步） =================
  async function refreshAll() {
    if (!cloud) { setCloudStatus('offline'); return; }
    if (syncing) { return; }
    syncing = true; setCloudStatus('sync');
    const ok = await pullCloud();
    if (ok) await pushPending();   // 把离线期间的增删推送到云端
    syncing = false;
    renderAll();
  }
  async function pullCloud() {
    try {
      const [pj, rc] = await Promise.all([dbSelect('projects'), dbSelect('records')]);
      if (pj.error || rc.error) throw new Error((pj.error && pj.error.message) || (rc.error && rc.error.message) || '数据库错误');
      const cloudP = (pj.data || []).filter(p => !deletedP.includes(p.id));
      const cloudR = (rc.data || []).filter(r => !deletedR.includes(r.id));
      // 合并：云端数据 + 尚未推送成功的本地项
      projects = cloudP.concat(pendingP);
      records = cloudR.concat(pendingR);
      cloudOk = true; setCloudStatus('online'); saveCache();
      return true;
    } catch (e) {
      console.warn('云端拉取失败，使用本地缓存：', e && e.message);
      cloudOk = false; setCloudStatus('offline');
      return false;
    }
  }
  async function pushPending() {
    const projIdMap = {};
    for (const p of pendingP.slice()) {
      const { data, error } = await dbInsert('projects', stripLocal(p));
      if (!error && data && data[0]) {
        projIdMap[p.syncKey] = data[0].id;
        const i = projects.findIndex(x => x.syncKey === p.syncKey);
        if (i >= 0) projects[i] = data[0];
        pendingP = pendingP.filter(x => x.syncKey !== p.syncKey);
      }
    }
    for (const r of pendingR.slice()) {
      const payload = stripLocal(r);
      if (projIdMap[r.project_id] !== undefined) payload.project_id = projIdMap[r.project_id]; // 更新外键
      const { data, error } = await dbInsert('records', payload);
      if (!error && data && data[0]) {
        const i = records.findIndex(x => x.syncKey === r.syncKey);
        if (i >= 0) records[i] = data[0];
        pendingR = pendingR.filter(x => x.syncKey !== r.syncKey);
      }
    }
    for (const id of deletedP.slice()) { const { error } = await dbDelete('projects', id); if (!error) deletedP = deletedP.filter(x => x !== id); }
    for (const id of deletedR.slice()) { const { error } = await dbDelete('records', id); if (!error) deletedR = deletedR.filter(x => x !== id); }
    saveCache();
  }
  function addLocal(kind, item) {
    const id = 'L' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    const full = Object.assign({}, item, { id, syncKey: id, _local: true, created_at: item.created_at || new Date().toISOString() });
    if (kind === 'projects') { projects.unshift(full); pendingP.push(full); }
    else { records.unshift(full); pendingR.push(full); }
    saveCache();
    return full;
  }
  function applyLocalEdit(kind, id, patch) {
    const arr = kind === 'projects' ? projects : records;
    const i = arr.findIndex(x => String(x.id) === String(id));
    if (i >= 0) { arr[i] = Object.assign({}, arr[i], patch); saveCache(); }
  }
  async function deleteRecordById(id) {
    const nid = Number(id);
    const isCloud = !isNaN(nid) && typeof id === 'number';
    if (isCloud && cloudOk) {
      const { error } = await dbDelete('records', nid);
      if (error && !deletedR.includes(nid)) deletedR.push(nid);
    } else if (isCloud && !cloudOk && !deletedR.includes(nid)) {
      deletedR.push(nid); // 联网后删除
    }
    records = records.filter(r => String(r.id) !== String(id));
    pendingR = pendingR.filter(r => String(r.id) !== String(id));
    saveCache();
    if (cloudOk) refreshAll();
  }

  function loadMembers(pid) { members[pid] = []; } // 匿名模式无成员体系

  // ================= 写操作（云端优先，失败降级本地） =================
  async function createProject(e) {
    e.preventDefault();
    const name = $('#p-name').value.trim(); if (!name) return;
    const payload = { name, location: $('#p-location').value.trim(), owner_id: myUid };
    let created = null;
    if (cloudOk) {
      const { data, error } = await dbInsert('projects', payload);
      if (!error && data && data[0]) { created = data[0]; projects.unshift(created); saveCache(); }
    }
    if (!created) addLocal('projects', payload);
    e.target.reset(); closeModal('projectModal'); renderAll();
    toast(created ? '项目已创建（已同步云端）' : '已保存到本地（云端暂不可用）');
    if (!created) refreshAll();
  }
  async function deleteProject(pid) {
    if (!canManage(pid)) { toast('仅项目创建人可删除'); return; }
    if (!confirm(`确认删除项目「${projectName(pid)}」？其下故障记录将一并删除。`)) return;
    const isCloud = typeof pid === 'number';
    if (isCloud && cloudOk) {
      const { error } = await dbDelete('projects', pid);
      if (error && !deletedP.includes(pid)) deletedP.push(pid);
    } else if (isCloud && !cloudOk && !deletedP.includes(pid)) {
      deletedP.push(pid);
    }
    projects = projects.filter(p => String(p.id) !== String(pid));
    pendingP = pendingP.filter(p => String(p.id) !== String(pid));
    records = records.filter(r => String(r.project_id) !== String(pid));
    pendingR = pendingR.filter(r => String(r.project_id) !== String(pid));
    saveCache(); renderAll(); toast('项目已删除');
    if (cloudOk) refreshAll();
  }

  function handleFaultSubmit(e) {
    e.preventDefault();
    const pid = activeProjectId();
    if (!canEditRecords(pid)) { toast('当前角色无录入权限'); return; }
    const v = id => $('#' + id).value;
    const payload = {
      project_id: pid,
      device: v('f-device').trim(), code: v('f-code').trim(), type: v('f-type'),
      severity: v('f-severity'), status: v('f-status'),
      description: v('f-desc').trim(), reporter: v('f-reporter').trim(),
      fault_date: v('f-date') || today()
    };
    if (!payload.device || !payload.type || !payload.description) { toast('请填写必填项'); return; }
    (async () => {
      let created = null;
      if (cloudOk) {
        const { data, error } = await dbInsert('records', payload);
        if (!error && data && data[0]) { created = data[0]; records.unshift(created); saveCache(); }
      }
      if (!created) addLocal('records', payload);
      e.target.reset(); $('#f-date').value = today();
      renderAll(); switchView('list');
      toast(created ? '已保存记录（已同步云端）' : '已保存到本地（云端暂不可用）');
      if (!created) refreshAll();
    })();
  }
  function openEdit(id) {
    const r = records.find(x => x.id === id);
    if (!r) return;
    if (!canEditRecords(activeProjectId())) { toast('当前角色无编辑权限'); return; }
    $('#e-id').value = r.id; $('#e-device').value = r.device; $('#e-code').value = r.code || '';
    $('#e-type').value = r.type; $('#e-severity').value = r.severity; $('#e-status').value = r.status;
    $('#e-date').value = r.fault_date; $('#e-desc').value = r.description; $('#e-reporter').value = r.reporter || '';
    openModal('editModal');
  }
  async function handleEditSubmit(e) {
    e.preventDefault();
    const id = $('#e-id').value;
    const patch = {
      device: $('#e-device').value.trim(), code: $('#e-code').value.trim(), type: $('#e-type').value,
      severity: $('#e-severity').value, status: $('#e-status').value,
      fault_date: $('#e-date').value || today(), description: $('#e-desc').value.trim(), reporter: $('#e-reporter').value.trim()
    };
    const nid = Number(id);
    if (cloudOk && !isNaN(nid) && typeof nid === 'number') {
      const { data, error } = await dbUpdate('records', patch, nid);
      if (!error && data && data.length) { const i = records.findIndex(x => x.id === nid); if (i >= 0) records[i] = data[0]; saveCache(); toast('已保存修改（已同步云端）'); }
      else { applyLocalEdit('records', id, patch); toast('已保存到本地（云端暂不可用）'); }
    } else { applyLocalEdit('records', id, patch); toast('已保存到本地（云端暂不可用）'); }
    closeModal('editModal'); renderAll();
    if (cloudOk) refreshAll();
  }
  async function handleDeleteRecord() {
    const id = $('#e-id').value;
    if (!canDeleteRecords(activeProjectId())) { toast('仅管理员/创建人可删除'); return; }
    if (!confirm('确认删除这条记录？')) return;
    await deleteRecordById(id);
    closeModal('editModal');
  }

  // ================= 渲染 =================
  function renderAll() {
    renderProjectSelect();
    const pid = activeProjectId();
    if (pid) loadMembers(pid);
    renderList(); renderStats();
  }
  function renderProjectSelect() {
    const sel = $('#projectSelect');
    const cur = sel.value;
    sel.innerHTML = projects.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('');
    if (cur && projects.some(p => String(p.id) === String(cur))) sel.value = cur;
    else if (projects[0]) sel.value = String(projects[0].id);
    if (projects.length) renderRoleBadge(activeProjectId());
  }
  function renderRoleBadge(pid) { /* 匿名共享模式不展示角色徽章 */ }
  function renderProjectList() {
    const ul = $('#projectList');
    ul.innerHTML = projects.map(p => {
      const recCount = records.filter(r => String(r.project_id) === String(p.id)).length;
      return `<li><span class="p-meta"><b>${esc(p.name)}</b><span>${esc(p.location || '—')} · ${recCount} 条</span></span>
        <button class="p-del" data-del="${p.id}" type="button">删除</button></li>`;
    }).join('');
    $$('#projectList .p-del').forEach(b => b.addEventListener('click', () => deleteProject(b.dataset.del === String(Number(b.dataset.del)) ? Number(b.dataset.del) : b.dataset.del)));
  }

  function renderList() {
    const pid = activeProjectId();
    const q = $('#searchInput').value.trim().toLowerCase();
    const ft = $('#filterType').value, fs = $('#filterStatus').value;
    let rows = records.filter(r => String(r.project_id) === String(pid));
    if (ft) rows = rows.filter(r => r.type === ft);
    if (fs) rows = rows.filter(r => r.status === fs);
    if (q) rows = rows.filter(r => (r.device + r.code + r.description + r.reporter).toLowerCase().includes(q));
    const canEdit = canEditRecords(pid);
    const canDel = canDeleteRecords(pid);
    $('#listEmpty').hidden = rows.length > 0;
    $('#recordTableBody').innerHTML = rows.map(r => `
      <tr>
        <td class="dev">${esc(r.device)}<br><span class="muted">${esc(r.code || '')}</span></td>
        <td><span class="tag tag-type">${esc(r.type)}</span></td>
        <td><span class="tag sev-${r.severity}">${esc(r.severity)}</span></td>
        <td><span class="tag st-${r.status}">${esc(r.status)}</span></td>
        <td>${esc(r.fault_date)}</td>
        <td>${(canEdit ? `<button class="row-btn" data-edit="${r.id}" type="button">编辑</button>` : '')}${(canDel ? `<button class="row-btn" data-delrec="${r.id}" type="button">删</button>` : '')}</td>
      </tr>`).join('');
    $$('#recordTableBody [data-edit]').forEach(b => b.addEventListener('click', () => openEdit(b.dataset.edit)));
    $$('#recordTableBody [data-delrec]').forEach(b => b.addEventListener('click', async () => {
      if (!canDeleteRecords(activeProjectId())) { toast('仅管理员/创建人可删除'); return; }
      if (!confirm('确认删除这条记录？')) return;
      await deleteRecordById(b.dataset.delrec);
    }));
  }

  function renderStats() {
    const pid = activeProjectId();
    const rows = records.filter(r => String(r.project_id) === String(pid));
    const total = rows.length, todo = rows.filter(r => r.status === '待处理').length,
      doing = rows.filter(r => r.status === '处理中').length, done = rows.filter(r => r.status === '已解决').length;
    $('#statsSummary').innerHTML = `
      <div class="stat c-total"><div class="num">${total}</div><div class="lbl">故障总数</div></div>
      <div class="stat c-todo"><div class="num">${todo}</div><div class="lbl">待处理</div></div>
      <div class="stat c-doing"><div class="num">${doing}</div><div class="lbl">处理中</div></div>
      <div class="stat c-done"><div class="num">${done}</div><div class="lbl">已解决</div></div>`;
    drawDoughnut('chartType', '故障类型', countBy(rows, 'type'), FAULT_TYPES);
    drawBar('chartProject', '各项目故障数量', projects.map(p => p.name), projects.map(p => records.filter(r => String(r.project_id) === String(p.id)).length), 'rgba(13,148,136,.8)');
    drawDoughnut('chartStatus', '处理状态', countBy(rows, 'status'), STATUSES);
    drawDoughnut('chartSeverity', '严重程度', countBy(rows, 'severity'), SEVERITIES);
    drawBar('chartTop', '高频设备 TOP 10', topDevices(rows), topDevicesCount(rows), 'rgba(217,119,6,.8)');
  }
  function countBy(rows, key) {
    const base = key === 'type' ? FAULT_TYPES : key === 'status' ? STATUSES : SEVERITIES;
    const map = {}; base.forEach(b => (map[b] = 0));
    rows.forEach(r => { if (map[r[key]] !== undefined) map[r[key]]++; });
    return Object.values(map);
  }
  function topDevices(rows) { const m = {}; rows.forEach(r => (m[r.device] = (m[r.device] || 0) + 1)); return Object.keys(m).sort((a, b) => m[b] - m[a]).slice(0, 10); }
  function topDevicesCount(rows) { return topDevices(rows).map(d => rows.filter(r => r.device === d).length); }
  function destroyChart(id) { if (charts[id]) { charts[id].destroy(); delete charts[id]; } }
  function drawDoughnut(id, label, data, labels) {
    destroyChart(id);
    charts[id] = new Chart($('#' + id).getContext('2d'), {
      type: 'doughnut',
      data: { labels, datasets: [{ data, backgroundColor: palette(labels.length), borderWidth: 2, borderColor: '#fff' }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: 'bottom' } } }
    });
  }
  function drawBar(id, label, labels, data, color) {
    destroyChart(id);
    charts[id] = new Chart($('#' + id).getContext('2d'), {
      type: 'bar',
      data: { labels, datasets: [{ label, data, backgroundColor: color, borderRadius: 6 }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } }
    });
  }
  function palette(n) { const c = ['#0d9488', '#2563eb', '#d97706', '#dc2626', '#16a34a', '#7c3aed', '#0891b2', '#db2777', '#65a30d', '#475569']; return Array.from({ length: n }, (_, i) => c[i % c.length]); }

  // ================= 数据备份 =================
  function exportJSON() {
    const blob = new Blob([JSON.stringify({ projects, records }, null, 2)], { type: 'application/json' });
    download(blob, '现场设备数据_' + today() + '.json');
  }
  function exportCSV() {
    const head = ['项目', '设备', '编号/位置', '故障类型', '严重程度', '状态', '日期', '上报人', '描述'];
    const lines = records.map(r => [projectName(r.project_id), r.device, r.code, r.type, r.severity, r.status, r.fault_date, r.reporter, r.description]
      .map(v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"').join(','));
    const csv = '﻿' + [head.join(','), ...lines].join('\n');
    download(new Blob([csv], { type: 'text/csv;charset=utf-8' }), '现场设备数据_' + today() + '.csv');
  }
  function download(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); }
  async function loadSample() {
    const pid = activeProjectId();
    if (!canEditRecords(pid)) { toast('当前角色无录入权限'); return; }
    if (records.length && !confirm('将追加示例数据到当前项目，确认？')) return;
    const sample = [
      ['1#塔吊', 'TD-001', '机械故障', '重要', '待处理', '吊臂回转异响，疑似轴承磨损', '张工', 2],
      ['施工电梯', 'EL-02', '电气故障', '紧急', '处理中', '控制柜跳闸，需更换接触器', '李工', 1],
      ['混凝土泵车', 'PB-03', '液压/气动故障', '重要', '待处理', '臂架油缸渗油', '王工', 3],
      ['钢筋切断机', 'RC-05', '控制系统故障', '一般', '已解决', 'PLC 通讯中断已恢复', '赵工', 5],
      ['1#塔吊', 'TD-001', '结构/磨损', '重要', '处理中', '标准节螺栓松动', '张工', 4],
      ['雾炮机', 'WP-08', '仪表/传感器', '一般', '已解决', '水位传感器误报', '孙工', 6],
      ['施工电梯', 'EL-02', '安全装置', '紧急', '待处理', '防坠器检测超期', '李工', 1],
      ['电焊机', 'WX-12', '电气故障', '一般', '已解决', '电缆接头发热已处理', '周工', 7]
    ];
    const base = Date.now();
    const payload = sample.map((s) => ({
      project_id: pid, device: s[0], code: s[1], type: s[2], severity: s[3], status: s[4],
      description: s[5], reporter: s[6], fault_date: new Date(base - s[7] * 864e5).toISOString().slice(0, 10)
    }));
    let added = 0;
    if (cloudOk) {
      const { data, error } = await dbInsert('records', payload);
      if (!error && data && data.length) { data.forEach(r => records.unshift(r)); added = data.length; saveCache(); }
    }
    if (added === 0) { payload.forEach(p => addLocal('records', p)); added = payload.length; }
    renderAll();
    toast(added ? `已载入 ${added} 条示例数据${cloudOk && added === payload.length ? '（已同步云端）' : '（已保存到本地）'}` : '示例数据写入失败');
    if (cloudOk && added < payload.length) refreshAll();
  }

  // ================= 视图切换 / 同步 =================
  function switchView(v) {
    $$('.view').forEach(s => (s.hidden = s.id !== 'view-' + v));
    $$('.tab').forEach(t => t.classList.toggle('active', t.dataset.view === v));
    if (v === 'list') renderList();
    if (v === 'stats') renderStats();
  }

  // ================= 初始化 =================
  function init() {
    if (!cloud) console.warn('未配置云端，进入本地模式');
    setCloudStatus(cloud ? 'sync' : 'offline');
    fillTypeSelect($('#f-type')); fillTypeSelect($('#e-type'));
    $('#filterType').innerHTML = '<option value="">全部类型</option>' + FAULT_TYPES.map(t => `<option>${t}</option>`).join('');
    $('#f-date').value = today();

    $$('.tab').forEach(t => t.addEventListener('click', () => switchView(t.dataset.view)));
    ['#searchInput', '#filterType', '#filterStatus'].forEach(s => $(s).addEventListener('input', renderList));
    $('#projectSelect').addEventListener('change', () => { const pid = activeProjectId(); if (pid) loadMembers(pid); renderRoleBadge(pid); renderList(); renderStats(); });

    $('#btnManageProjects').addEventListener('click', () => { renderProjectList(); openModal('projectModal'); });
    $('#btnDataMenu').addEventListener('click', () => openModal('dataModal'));
    $$('[data-close]').forEach(el => el.addEventListener('click', () => closeModal(el.dataset.close)));
    document.addEventListener('keydown', e => { if (e.key === 'Escape') $$('.modal').forEach(m => (m.hidden = true)); });

    $('#faultForm').addEventListener('submit', handleFaultSubmit);
    $('#projectForm').addEventListener('submit', createProject);
    $('#editForm').addEventListener('submit', handleEditSubmit);
    $('#btnDeleteRecord').addEventListener('click', handleDeleteRecord);
    $('#btnExportJson').addEventListener('click', exportJSON);
    $('#btnExportCsv').addEventListener('click', exportCSV);
    $('#toggleSample').addEventListener('change', e => { if (e.target.checked) { loadSample(); e.target.checked = false; } });

    // 实时同步：切回前台 + 定时拉取（云端可用时后台静默同步，不可用则保持本地）
    let vt;
    document.addEventListener('visibilitychange', () => { if (!document.hidden) { clearTimeout(vt); vt = setTimeout(refreshAll, 800); } });
    window.addEventListener('focus', () => { clearTimeout(vt); vt = setTimeout(refreshAll, 800); });
    setInterval(() => { if (document.visibilityState === 'visible') refreshAll(); }, 30000);

    boot();
  }

  function fillTypeSelect(sel) { sel.innerHTML = '<option value="">请选择</option>' + FAULT_TYPES.map(t => `<option>${t}</option>`).join(''); }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
