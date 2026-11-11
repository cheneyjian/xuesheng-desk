'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ID_RE = /^\d{8}-\d{6}-[a-z0-9]{4}$/;

function pad(n) {
  return String(n).padStart(2, '0');
}

function newId(now = new Date()) {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const r = crypto.randomBytes(2).toString('hex').slice(0, 4);
  return `${d}-${t}-${r}`;
}

// 本地资料库：一个 JSON 索引 + 每次录音一个目录。不用原生数据库，避免打包时重编译。
class Library {
  constructor(rootDir) {
    this.root = rootDir;
    this.file = path.join(rootDir, 'library.json');
    fs.mkdirSync(path.join(rootDir, 'sessions'), { recursive: true });
    this.data = this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (parsed && Array.isArray(parsed.sessions)) {
        const changed = !Array.isArray(parsed.courses) || parsed.sessions.some((s) =>
          !Object.hasOwn(s, 'courseId') || !Object.hasOwn(s, 'lessonId') ||
          !Object.hasOwn(s, 'siteId') || !Object.hasOwn(s, 'sourceUrl'));
        const data = {
          courses: Array.isArray(parsed.courses) ? parsed.courses : [],
          sessions: parsed.sessions.map((s) => ({
            ...s,
            courseId: s.courseId || null,
            lessonId: s.lessonId || null,
            siteId: s.siteId || null,
            sourceUrl: s.sourceUrl || null,
          })),
        };
        this.data = data;
        if (changed) this._save();
        return data;
      }
    } catch (err) {
      if (err.code !== 'ENOENT') console.warn('[library] 索引损坏，已重新创建：', err.message);
    }
    return { courses: [], sessions: [] };
  }

  _save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _assertId(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new Error('非法的会话编号');
  }

  sessionDir(id) {
    this._assertId(id);
    return path.join(this.root, 'sessions', id);
  }

  audioPath(id) {
    const dir = this.sessionDir(id);
    const mp3 = path.join(dir, 'audio.mp3');
    // Keep existing WebM recordings readable after switching new recordings to MP3.
    return fs.existsSync(mp3) ? mp3 : path.join(dir, 'audio.webm');
  }

  newAudioPath(id) {
    return path.join(this.sessionDir(id), 'audio.mp3');
  }

  audioExtension(id) {
    return path.extname(this.audioPath(id)).slice(1) || 'mp3';
  }

  createCourse(title) {
    const clean = String(title || '').trim().slice(0, 120);
    if (!clean) throw new Error('课程名称不能为空');
    const course = { id: newId(), title: clean, createdAt: new Date().toISOString(), lessons: [] };
    this.data.courses.push(course);
    this._save();
    return { ...course, lessons: [] };
  }

  createLesson(courseId, { title, siteId, sourceUrl }) {
    const course = this.data.courses.find((item) => item.id === courseId);
    if (!course) throw new Error('找不到这门课程');
    const clean = String(title || '').trim().slice(0, 120);
    if (!clean) throw new Error('课时名称不能为空');
    const lesson = {
      id: newId(), title: clean, siteId: String(siteId || ''),
      sourceUrl: String(sourceUrl || ''), createdAt: new Date().toISOString(),
    };
    course.lessons.push(lesson);
    this._save();
    return { ...lesson };
  }

  getLesson(courseId, lessonId) {
    const course = this.data.courses.find((item) => item.id === courseId);
    const lesson = course && course.lessons.find((item) => item.id === lessonId);
    if (!lesson) throw new Error('请先选择有效课时');
    return { ...lesson, courseTitle: course.title };
  }

  create({ title, courseId = null, lessonId = null, siteId = null, sourceUrl = null }) {
    const id = newId();
    const session = {
      id,
      title: String(title || '').trim().slice(0, 120) || '未命名课程',
      createdAt: new Date().toISOString(),
      endedAt: null,
      durationMs: 0,
      bytes: 0,
      notes: [],
      transcript: null,
      courseId,
      lessonId,
      siteId,
      sourceUrl,
    };
    fs.mkdirSync(this.sessionDir(id), { recursive: true });
    this.data.sessions.push(session);
    this._save();
    return { ...session };
  }

  get(id) {
    this._assertId(id);
    const s = this.data.sessions.find((x) => x.id === id);
    if (!s) throw new Error('找不到这条录音');
    return s;
  }

  list() {
    return [...this.data.sessions].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  update(id, patch) {
    const s = this.get(id);
    const allowed = ['title', 'endedAt', 'durationMs', 'bytes'];
    for (const k of allowed) if (k in patch) s[k] = patch[k];
    this._save();
    return { ...s };
  }

  addNote(id, { t, text }) {
    const s = this.get(id);
    const clean = String(text || '').trim().slice(0, 2000);
    if (!clean) throw new Error('笔记内容不能为空');
    const note = { t: Math.max(0, Math.round(Number(t) || 0)), text: clean };
    s.notes.push(note);
    s.notes.sort((a, b) => a.t - b.t);
    this._save();
    return note;
  }

  setTranscript(id, segments) {
    const s = this.get(id);
    s.transcript = segments;
    this._save();
    return s;
  }

  remove(id) {
    this._assertId(id);
    const index = this.data.sessions.findIndex((x) => x.id === id);
    if (index < 0) return;
    this.data.sessions.splice(index, 1);
    this._save();
    fs.rmSync(this.sessionDir(id), { recursive: true, force: true });
  }
}

module.exports = { Library, ID_RE };
