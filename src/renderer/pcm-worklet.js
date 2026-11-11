/* global AudioWorkletProcessor, registerProcessor */
class CoursePcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4800);
    this.used = 0;
    this.finished = false;
    this.port.onmessage = ({ data }) => {
      if (data.type !== 'flush') return;
      if (this.used) this.send(this.buffer.slice(0, this.used));
      this.used = 0;
      this.finished = true;
      this.port.postMessage({ type: 'flushed' });
    };
  }

  send(pcm) {
    this.port.postMessage({ pcm: pcm.buffer }, [pcm.buffer]);
  }

  process(inputs, outputs) {
    for (const output of outputs) for (const channel of output) channel.fill(0);
    if (this.finished) return true;
    const channels = inputs[0];
    const frames = channels[0]?.length || outputs[0][0].length;
    for (let i = 0; i < frames; i++) {
      let value = 0;
      for (const channel of channels) value += channel[i];
      this.buffer[this.used++] = channels.length ? value / channels.length : 0;
      if (this.used === this.buffer.length) {
        this.send(this.buffer);
        this.buffer = new Float32Array(4800);
        this.used = 0;
      }
    }
    return true;
  }
}
registerProcessor('course-pcm', CoursePcmProcessor);
