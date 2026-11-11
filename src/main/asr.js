'use strict';

const fs = require('node:fs');
const { spawn } = require('node:child_process');

// 转写引擎约定（任何能满足它的命令都可以接入）：
//   命令行里的 {audio} 是输入音频路径，{out} 是要写出的 JSON 路径，{app} 是应用资源目录
//   输出 JSON：{"segments":[{"start":秒,"end":秒,"text":"..."}]}

function fillArgs(args, vars) {
  return args.map((a) => String(a).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m)));
}

function normalize(raw) {
  const list = raw && Array.isArray(raw.segments) ? raw.segments : [];
  const segments = list
    .map((s) => ({
      start: Math.round(Number(s.start) * 1000) || 0,
      end: Math.round(Number(s.end) * 1000) || 0,
      text: String(s.text || '').trim(),
    }))
    .filter((s) => s.text);
  if (segments.length === 0) throw new Error('转写结果为空，可能是录音里没有声音');
  return segments;
}

function transcribe({ command, args = [], timeoutMs = 7200000, audioPath, outPath, appRoot, onLog }) {
  if (!command) {
    return Promise.reject(new Error('还没有配置转写引擎，请查看 README 的“转写”一节'));
  }
  const finalArgs = fillArgs(args, { audio: audioPath, out: outPath, app: appRoot });

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, finalArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      reject(new Error(`无法启动转写命令：${err.message}`));
      return;
    }

    let tail = '';
    const keep = (buf) => {
      const text = buf.toString();
      tail = (tail + text).slice(-2000);
      if (onLog) onLog(text);
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('转写超时，已终止'));
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`无法启动转写命令“${command}”：${err.message}`));
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`转写命令失败（退出码 ${code}）：${tail.trim().split('\n').slice(-3).join(' | ')}`));
        return;
      }
      try {
        resolve(normalize(JSON.parse(fs.readFileSync(outPath, 'utf8'))));
      } catch (err) {
        reject(new Error(`读取转写结果失败：${err.message}`));
      }
    });
  });
}

module.exports = { transcribe, fillArgs, normalize };
