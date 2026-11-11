'use strict';

function pad(n, w = 2) {
  return String(n).padStart(w, '0');
}

// 59000 -> "00:59"，3723000 -> "1:02:03"
function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function srtTime(ms) {
  const v = Math.max(0, Math.round(ms));
  const h = Math.floor(v / 3600000);
  const m = Math.floor((v % 3600000) / 60000);
  const s = Math.floor((v % 60000) / 1000);
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(v % 1000, 3)}`;
}

function toSrt(segments) {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error('还没有文字稿，请先转写');
  }
  return (
    segments
      .map((seg, i) => {
        // 部分引擎没有结束时间，用下一句的开始时间补上
        const next = segments[i + 1];
        const end = seg.end > seg.start ? seg.end : next ? next.start : seg.start + 2000;
        return `${i + 1}\n${srtTime(seg.start)} --> ${srtTime(end)}\n${seg.text}\n`;
      })
      .join('\n') + '\n'
  );
}

function toMarkdown(session, opts = {}) {
  const fmt = new Intl.DateTimeFormat('zh-CN', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: opts.timeZone,
  });
  const lines = [];
  lines.push(`# ${session.title}`, '');
  lines.push(`- 录制时间：${fmt.format(new Date(session.createdAt))}`);
  lines.push(`- 时长：${formatClock(session.durationMs || 0)}`);
  lines.push('- 来源：课程网页音轨，仅作个人学习研究', '');

  lines.push('## 我的笔记', '');
  if (session.notes && session.notes.length) {
    for (const n of session.notes) lines.push(`- [${formatClock(n.t)}] ${n.text}`);
  } else {
    lines.push('（没有笔记）');
  }
  lines.push('');

  lines.push('## 文字稿', '');
  if (session.transcript && session.transcript.length) {
    for (const seg of session.transcript) lines.push(`[${formatClock(seg.start)}] ${seg.text}`, '');
  } else {
    lines.push('（尚未转写）', '');
  }
  return lines.join('\n');
}

function safeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  return cleaned || '未命名课程';
}

module.exports = { formatClock, srtTime, toSrt, toMarkdown, safeFileName };
