(() => {
  'use strict';
  let stream;
  let context;
  let source;
  let processor;
  let queue = Promise.resolve();
  let pending = 0;
  let stopping = false;
  let accepting = true;
  let flushed;

  const fail = error => {
    if (!stopping) window.captureTransport.fail(error.message || String(error));
  };

  window.tabAudioCapture = {
    async start() {
      // The main-process handler grants only the selected course WebContents.
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: 1 },
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      if (stream.getAudioTracks().length !== 1) throw new Error('没有取得课程网页的音轨');
      for (const track of stream.getTracks()) track.addEventListener('ended', () => fail(new Error('课程网页音轨已结束')));
      context = new AudioContext({ sampleRate: 48000 });
      if (context.sampleRate !== 48000) throw new Error('无法创建 48 kHz 录音通道');
      await context.audioWorklet.addModule('pcm-worklet.js');
      source = context.createMediaStreamSource(new MediaStream(stream.getAudioTracks()));
      processor = new AudioWorkletNode(context, 'course-pcm', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
      processor.port.onmessage = ({ data }) => {
        if (data.type === 'flushed') {
          accepting = false;
          if (flushed) flushed();
          return;
        }
        if (!accepting || !(data.pcm instanceof ArrayBuffer)) return;
        if (++pending > 30) {
          accepting = false;
          fail(new Error('音频写入速度不足，已停止以避免丢失课程声音'));
          return;
        }
        queue = queue.then(() => window.captureTransport.push(data.pcm, 48000))
          .catch(fail).finally(() => { pending--; });
      };
      processor.onprocessorerror = () => fail(new Error('网页音频处理器已退出'));
      // The processor outputs silence. Original page playback is preserved by
      // enableLocalEcho; reconnecting captured audio here would duplicate it.
      source.connect(processor).connect(context.destination);
      await context.resume();
      return { sampleRate: context.sampleRate };
    },

    async stop() {
      stopping = true;
      try {
        if (processor && context.state !== 'closed') {
          let timeout;
          try {
            await Promise.race([
              new Promise(resolve => { flushed = resolve; processor.port.postMessage({ type: 'flush' }); }),
              new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('音频收尾超时')), 3000); }),
            ]);
          } finally { clearTimeout(timeout); }
        }
        await queue;
      } finally {
        accepting = false;
        if (source) source.disconnect();
        if (processor) processor.disconnect();
        if (stream) stream.getTracks().forEach(track => track.stop());
        if (context && context.state !== 'closed') await context.close();
      }
    },
  };
})();
