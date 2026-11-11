(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const els = {
    siteSelect: $('siteSelect'),
    courseSelect: $('courseSelect'),
    courseCreate: $('courseCreate'),
    lessonSelect: $('lessonSelect'),
    lessonCreate: $('lessonCreate'),
    title: $('title'),
    start: $('start'),
    stop: $('stop'),
    timer: $('timer'),
    meter: $('meterFill'),
    status: $('status'),
    noteInput: $('noteInput'),
    noteAdd: $('noteAdd'),
    notes: $('notes'),
    list: $('list'),
    transcriptDialog: $('transcriptDialog'),
    nameDialog: $('nameDialog'),
    nameDialogTitle: $('nameDialogTitle'),
    nameDialogInput: $('nameDialogInput'),
    nameDialogConfirm: $('nameDialogConfirm'),
    nameDialogCancel: $('nameDialogCancel'),
    transcriptSegments: $('transcriptSegments'),
    transcriptSave: $('transcriptSave'),
  };

  const SILENCE_WARN_MS = 15000;
  let rec = null; // 进行中的录音
  const lineById = new Map(); // 录音编号 -> 该条目下的状态文字
  const sessionsById = new Map();
  let courses = [];
  let editingTranscript = null;

  // ---------- 小工具 ----------

  function clock(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(total / 3600);
    const m = String(Math.floor((total % 3600) / 60)).padStart(2, '0');
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
  }

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  async function refreshSites() {
    const { sites, currentId } = await window.desk.sites();
    els.siteSelect.textContent = '';
    for (const site of sites) {
      const option = document.createElement('option');
      option.value = site.id;
      option.textContent = site.recordAudio ? `${site.name} · 可录音` : site.name;
      els.siteSelect.append(option);
    }
    els.siteSelect.value = currentId || (sites[0] && sites[0].id) || '';
    els.siteSelect.disabled = !!rec || sites.length < 2;
    if (sites.length < 2) {
      const option = els.siteSelect.options[0];
      if (option) option.textContent = `${sites[0].name} · 可在配置中添加固定网站`;
    }
  }

  async function changeSite() {
    const id = els.siteSelect.value;
    if (!id || rec) return;
    els.siteSelect.disabled = true;
    try {
      await window.desk.navigateSite(id);
      setStatus('正在打开固定网站…', '');
    } catch (err) {
      setStatus(`切换网站失败：${err.message}`, 'error');
      await refreshSites();
    }
  }

  async function refreshCourses(selectCourseId = els.courseSelect.value) {
    courses = await window.desk.courses();
    els.courseSelect.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = courses.length ? '选择课程' : '先新建课程';
    els.courseSelect.append(placeholder);
    for (const course of courses) {
      const option = document.createElement('option');
      option.value = course.id;
      option.textContent = course.title;
      els.courseSelect.append(option);
    }
    els.courseSelect.value = courses.some((course) => course.id === selectCourseId) ? selectCourseId : '';
    renderLessons();
  }

  function renderLessons(selectLessonId = '') {
    const course = courses.find((item) => item.id === els.courseSelect.value);
    els.lessonSelect.textContent = '';
    const placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = course ? (course.lessons.length ? '选择课时' : '先新建课时') : '先选择课程';
    els.lessonSelect.append(placeholder);
    if (course) for (const lesson of course.lessons) {
      const option = document.createElement('option');
      option.value = lesson.id;
      option.textContent = lesson.title;
      els.lessonSelect.append(option);
    }
    els.lessonSelect.value = course && course.lessons.some((lesson) => lesson.id === selectLessonId) ? selectLessonId : '';
    els.lessonSelect.disabled = !course || rec !== null;
    els.lessonCreate.disabled = !course || rec !== null;
    els.start.disabled = !els.lessonSelect.value || rec !== null;
  }

  function askName(label) {
    els.nameDialogTitle.textContent = label;
    els.nameDialogInput.value = '';
    els.nameDialog.showModal();
    els.nameDialogInput.focus();
    return new Promise(resolve => {
      const finish = value => { els.nameDialog.close(); resolve(value); };
      const confirm = () => { const value = els.nameDialogInput.value.trim(); if (value) finish(value); else els.nameDialogInput.reportValidity(); };
      const cancel = () => finish(null);
      els.nameDialogConfirm.onclick = confirm;
      els.nameDialogCancel.onclick = cancel;
      els.nameDialog.onclose = () => resolve(null);
      els.nameDialogInput.onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); confirm(); } };
    });
  }

  async function createCourse() {
    const title = await askName('新建课程');
    if (!title) return;
    try {
      const course = await window.desk.createCourse(title);
      await refreshCourses(course.id);
      setStatus(`已创建课程“${course.title}”。`, 'ok');
    } catch (err) { setStatus(`创建课程失败：${err.message}`, 'error'); }
  }

  async function createLesson() {
    const courseId = els.courseSelect.value;
    if (!courseId) return;
    const title = await askName('新建课时');
    if (!title) return;
    try {
      const lesson = await window.desk.createLesson(courseId, title);
      await refreshCourses(courseId);
      renderLessons(lesson.id);
      setStatus('课时已关联当前固定网站。', 'ok');
    } catch (err) { setStatus(`创建课时失败：${err.message}`, 'error'); }
  }

  // ---------- 录音 ----------

  function setRecordingUi(on) {
    els.siteSelect.disabled = on || els.siteSelect.options.length < 2;
    els.start.disabled = on;
    els.stop.disabled = !on;
    els.title.disabled = on;
    els.courseSelect.disabled = on;
    els.courseCreate.disabled = on;
    els.list.inert = on;
    for (const audio of els.list.querySelectorAll('audio')) {
      if (on) audio.pause();
      audio.controls = !on;
    }
    renderLessons(on ? els.lessonSelect.value : els.lessonSelect.value);
    els.noteInput.disabled = !on;
    els.noteAdd.disabled = !on;
    if (!on) {
      els.meter.style.width = '0%';
    }
  }

  async function startRecording() {
    if (rec) return;
    const title = els.title.value.trim() || '未命名课程';
    if (!els.courseSelect.value || !els.lessonSelect.value) {
      setStatus('请先选择课程和课时。', 'error');
      return;
    }
    for (const audio of els.list.querySelectorAll('audio')) audio.pause();
    let session;
    try {
      session = await window.desk.recStart(title, els.courseSelect.value, els.lessonSelect.value);
    } catch (err) {
      setStatus(`无法开始录音：${err.message}`, 'error');
      return;
    }

    rec = {
      id: session.id,
      startedAt: performance.now(),
      lastSoundAt: performance.now(),
      rms: 0,
      silenceWarned: false,
      ticker: null,
    };
    rec.ticker = setInterval(tick, 200);
    setRecordingUi(true);
    els.start.disabled = true;
    els.notes.textContent = '';
    setStatus('录音中：只采集当前课程网页的声音，不采集其他网页、其他应用和麦克风。', '');
    els.noteInput.focus();
  }

  function tick() {
    if (!rec) return;
    els.timer.textContent = clock(performance.now() - rec.startedAt);
    const rms = rec.rms;
    els.meter.style.width = Math.min(100, Math.round(rms * 400)) + '%';

    const now = performance.now();
    if (rms > 0.002) {
      rec.lastSoundAt = now;
      if (rec.silenceWarned) {
        rec.silenceWarned = false;
        setStatus('录音中', '');
      }
    } else if (!rec.silenceWarned && now - rec.lastSoundAt > SILENCE_WARN_MS) {
      rec.silenceWarned = true;
      setStatus('已经 15 秒没有检测到课程声音：请确认当前网页的课程正在播放。', 'error');
    }
  }

  async function stopRecording() {
    const r = rec;
    if (!r) return;
    rec = null;
    clearInterval(r.ticker);
    els.stop.disabled = true;

    const durationMs = performance.now() - r.startedAt;

    try {
      await window.desk.recStop(r.id, durationMs);
      setStatus(`已保存 MP3，时长 ${clock(durationMs)}。`, 'ok');
    } catch (err) {
      setStatus(`保存收尾失败：${err.message}`, 'error');
    }
    setRecordingUi(false);
    els.timer.textContent = '00:00';
    await refreshList();
  }

  // ---------- 笔记 ----------

  async function saveNote(text, options = {}) {
    const active = rec;
    const clean = String(text || '').trim().slice(0, 2000);
    if (!active || !clean) return false;
    const t = Math.round(performance.now() - active.startedAt);
    try {
      await window.desk.addNote(active.id, t, clean);
    } catch (err) {
      setStatus(`笔记保存失败：${err.message}`, 'error');
      return false;
    }
    const li = document.createElement('li');
    const tt = document.createElement('span');
    tt.className = 't';
    tt.textContent = clock(t);
    const body = document.createElement('span');
    body.textContent = clean;
    li.append(tt, body);
    els.notes.append(li);
    if (options.source === 'web') {
      setStatus('已将网页选中文字记为时间戳笔记。', 'ok');
    }
    return true;
  }

  async function addNote() {
    const saved = await saveNote(els.noteInput.value);
    if (saved) els.noteInput.value = '';
  }

  async function addWebSelection(payload) {
    const text = String(payload && payload.text || '').trim().slice(0, 2000);
    if (!text) return;
    if (!rec) {
      setStatus('这段录音已结束，选中文字未记入笔记。请重新开始内录后再添加。', 'error');
      return;
    }
    await saveNote(text, { source: 'web' });
  }

  // ---------- 录音列表 ----------

  function button(label, action, id, disabled) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.dataset.action = action;
    b.dataset.id = id;
    if (disabled) b.disabled = true;
    return b;
  }

  async function refreshList() {
    const sessions = await window.desk.list();
    els.list.textContent = '';
    sessionsById.clear();
    if (sessions.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '还没有录音。';
      els.list.append(li);
      return;
    }
    for (const s of sessions) {
      sessionsById.set(s.id, s);
      const li = document.createElement('li');
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = s.title;
      const meta = document.createElement('div');
      meta.className = 'meta';
      const when = new Date(s.createdAt).toLocaleString('zh-CN');
      const state = s.endedAt ? clock(s.durationMs) : '异常中断（音频仍可导出）';
      const tr = s.transcript ? `，已转写 ${s.transcript.length} 句` : '';
      const course = courses.find((item) => item.id === s.courseId);
      const lesson = course && course.lessons.find((item) => item.id === s.lessonId);
      const location = lesson ? `${course.title} / ${lesson.title}` : '未归档';
      meta.textContent = `${location} · ${when} · ${state} · ${s.notes.length} 条笔记${tr}`;
      const actions = document.createElement('div');
      actions.className = 'actions';
      const hasText = !!(s.transcript && s.transcript.length);
      actions.append(
        button(hasText ? '编辑转写稿' : '转写', hasText ? 'edit' : 'asr', s.id, false),
        button('导出文字稿', 'md', s.id, false),
        button('导出字幕', 'srt', s.id, !hasText),
        button('导出音频', 'audio', s.id, false),
        button('所在文件夹', 'reveal', s.id, false)
      );
      const line = document.createElement('div');
      line.className = 'line';
      lineById.set(s.id, line);
      const audio = document.createElement('audio');
      audio.controls = true;
      audio.preload = 'none';
      audio.setAttribute('aria-label', `${s.title}录音回放`);
      window.desk.audioUrl(s.id).then((url) => { audio.src = url; }).catch(() => {});
      const noteDetails = document.createElement('details');
      const noteSummary = document.createElement('summary');
      noteSummary.textContent = `时间戳笔记（${s.notes.length}）`;
      const noteList = document.createElement('ul');
      noteList.className = 'session-notes';
      for (const note of s.notes) {
        const noteItem = document.createElement('li');
        const timestamp = document.createElement('span');
        timestamp.className = 't';
        timestamp.textContent = clock(note.t);
        const text = document.createElement('span');
        text.textContent = note.text;
        noteItem.append(timestamp, text);
        noteList.append(noteItem);
      }
      noteDetails.append(noteSummary, noteList);
      li.append(name, meta, audio, noteDetails, actions, line);
      els.list.append(li);
    }
  }

  async function onListClick(event) {
    const b = event.target.closest('button[data-action]');
    if (!b) return;
    const { action, id } = b.dataset;
    const line = lineById.get(id);
    const say = (text) => {
      if (line) line.textContent = text;
    };
    try {
      if (action === 'reveal') {
        await window.desk.reveal(id);
      } else if (action === 'edit') {
        openTranscriptEditor(id);
      } else if (action === 'asr') {
        b.disabled = true;
        const res = await window.desk.runAsr(id);
        say(`转写完成，共 ${res.count} 句。`);
        await refreshList();
        const updated = sessionsById.get(id);
        if (updated && updated.transcript) openTranscriptEditor(id);
      } else {
        const res = await window.desk.exportFile(id, action);
        if (res.saved) say(`已导出到：${res.saved}`);
      }
    } catch (err) {
      say(`失败：${err.message}`);
      b.disabled = false;
    }
  }

  function openTranscriptEditor(id) {
    const s = sessionsById.get(id);
    if (!s || !Array.isArray(s.transcript)) return;
    editingTranscript = { id, segments: s.transcript.map((segment) => ({ ...segment })) };
    els.transcriptSegments.textContent = '';
    for (const [index, segment] of editingTranscript.segments.entries()) {
      const row = document.createElement('div');
      row.className = 'transcript-row';
      const time = document.createElement('div');
      time.className = 'transcript-time';
      time.textContent = `${clock(segment.start)} – ${clock(segment.end)}`;
      const textarea = document.createElement('textarea');
      textarea.value = segment.text;
      textarea.maxLength = 2000;
      textarea.setAttribute('aria-label', `第 ${index + 1} 句`);
      textarea.addEventListener('input', () => { editingTranscript.segments[index].text = textarea.value; });
      row.append(time, textarea);
      els.transcriptSegments.append(row);
    }
    els.transcriptDialog.showModal();
  }

  async function saveTranscript() {
    if (!editingTranscript) return;
    try {
      await window.desk.saveTranscript(editingTranscript.id, editingTranscript.segments);
      els.transcriptDialog.close();
      setStatus('转写稿已保存，时间戳保持不变。', 'ok');
      editingTranscript = null;
      await refreshList();
    } catch (err) { setStatus(`保存转写稿失败：${err.message}`, 'error'); }
  }

  // ---------- 绑定 ----------

  els.start.addEventListener('click', startRecording);
  els.stop.addEventListener('click', stopRecording);
  els.noteAdd.addEventListener('click', addNote);
  els.noteInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) addNote();
  });
  els.siteSelect.addEventListener('change', changeSite);
  els.courseSelect.addEventListener('change', () => renderLessons());
  els.lessonSelect.addEventListener('change', () => { els.start.disabled = !els.lessonSelect.value || rec !== null; });
  els.courseCreate.addEventListener('click', createCourse);
  els.lessonCreate.addEventListener('click', createLesson);
  els.transcriptSave.addEventListener('click', saveTranscript);
  els.transcriptDialog.addEventListener('close', () => { editingTranscript = null; });
  els.list.addEventListener('click', onListClick);
  window.desk.onAsrStatus(({ id, message }) => {
    const line = lineById.get(id);
    if (line) line.textContent = message;
  });
  window.desk.onAudioLevel(({ rms }) => {
    if (!rec) return;
    rec.rms = Number(rms) || 0;
    if (rec.rms > 0.002) rec.lastSoundAt = performance.now();
  });
  window.desk.onRecError(({ message }) => {
    if (!rec) return;
    setStatus(`课程网页音轨已中断：${message}。正在保存 MP3。`, 'error');
    stopRecording();
  });
  window.desk.onSiteChanged(({ id }) => {
    if (id) els.siteSelect.value = id;
  });
  window.desk.onSiteNotice(({ message }) => setStatus(message, 'error'));
  window.desk.onWebSelection(addWebSelection);

  refreshSites().catch((err) => setStatus(`读取固定网站失败：${err.message}`, 'error'));
  refreshCourses().then(refreshList).catch((err) => setStatus(`读取资料库失败：${err.message}`, 'error'));
})();
