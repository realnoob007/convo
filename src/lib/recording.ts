export const MAX_RECORDING_SECONDS = 180;
export const MAX_SAMPLE_BYTES = 50 * 1024 * 1024;

export function encodeWav(
  channels: Float32Array[],
  sampleRate: number,
): ArrayBuffer {
  if (!channels.length || channels.some((c) => c.length !== channels[0].length))
    throw Error("Invalid recording audio");
  const frames = channels[0].length;
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const write = (offset: number, text: string) =>
    [...text].forEach((char, i) =>
      view.setUint8(offset + i, char.charCodeAt(0)),
    );
  write(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  write(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    const sample = Math.max(
      -1,
      Math.min(
        1,
        channels.reduce((sum, channel) => sum + channel[i], 0) /
          channels.length,
      ),
    );
    view.setInt16(
      44 + i * 2,
      Math.round(sample * (sample < 0 ? 32768 : 32767)),
      true,
    );
  }
  return buffer;
}

export async function recordingToWav(
  blob: Blob,
  maxSeconds = MAX_RECORDING_SECONDS,
): Promise<Blob> {
  const context = new OfflineAudioContext(1, 1, 44100);
  const decoded = await context.decodeAudioData(await blob.arrayBuffer());
  if (decoded.duration < 0.3)
    throw Error("Recording is too short. Record at least one second.");
  const frames = Math.min(decoded.length, 44100 * maxSeconds);
  const channels = Array.from({ length: decoded.numberOfChannels }, (_, i) =>
    decoded.getChannelData(i).subarray(0, frames),
  );
  return new Blob([encodeWav(channels, 44100)], { type: "audio/wav" });
}
export function blobBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(",")[1]);
    reader.onerror = () => reject(Error("Could not save recording"));
    reader.readAsDataURL(blob);
  });
}

export class MicrophoneRecorder {
  private stream?: MediaStream;
  private recorder?: MediaRecorder;
  private cancelled = false;
  private pending?: Promise<Blob>;
  private context?: AudioContext;
  private analyser?: AnalyserNode;
  private levels?: Uint8Array<ArrayBuffer>;
  async start(
    onEnded: () => void,
    deviceId?: string,
    permissionTimeout = 30000,
  ) {
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof MediaRecorder === "undefined"
    )
      throw Error(
        "Microphone recording is unavailable in this app or browser. Import audio files instead.",
      );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const requested = navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        channelCount: 1,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
    });
    // getUserMedia cannot be aborted. Release a permission result that arrives late.
    void requested.then(
      (stream) => {
        if (this.cancelled) stream.getTracks().forEach((track) => track.stop());
      },
      () => {},
    );
    let stream: MediaStream;
    try {
      stream = await Promise.race([
        requested,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            this.cancelled = true;
            reject(
              Error(
                "Microphone permission is still pending. Check the system permission prompt, then try again.",
              ),
            );
          }, permissionTimeout);
        }),
      ]);
    } finally {
      clearTimeout(timeout);
    }
    if (this.cancelled) return false;
    this.stream = stream;
    try {
      const mimeType = [
        "audio/mp4",
        "audio/webm;codecs=opus",
        "audio/webm",
        "audio/ogg;codecs=opus",
      ].find((type) => MediaRecorder.isTypeSupported(type));
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      this.recorder = recorder;
      const chunks: Blob[] = [];
      this.pending = new Promise<Blob>((resolve, reject) => {
        recorder.ondataavailable = (event) => {
          if (event.data.size) chunks.push(event.data);
        };
        recorder.onerror = () => {
          this.release();
          reject(
            Error("Recording failed. Check your microphone and try again."),
          );
          onEnded();
        };
        recorder.onstop = () => {
          this.release();
          resolve(new Blob(chunks, { type: recorder.mimeType }));
          onEnded();
        };
      });
      // The UI consumes the result on Stop; avoid an unhandled rejection before then.
      void this.pending.catch(() => {});
      stream.getAudioTracks().forEach(
        (track) =>
          (track.onended = () => {
            if (recorder.state !== "inactive") recorder.stop();
          }),
      );
      recorder.start(1000);
      try {
        this.context = new AudioContext();
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 256;
        this.levels = new Uint8Array(256);
        this.context.createMediaStreamSource(stream).connect(this.analyser);
        void this.context.resume().catch(() => {});
      } catch {
        /* Capture remains usable when level metering is unavailable. */
      }
      return true;
    } catch (error) {
      this.release();
      throw error;
    }
  }
  async stop(): Promise<Blob> {
    if (!this.pending)
      throw Error("Recording failed. Check your microphone and try again.");
    if (this.recorder?.state !== "inactive") this.recorder?.stop();
    this.release();
    return this.pending;
  }
  cancel() {
    this.cancelled = true;
    if (this.recorder && this.recorder.state !== "inactive")
      this.recorder.stop();
    this.release();
  }
  level() {
    if (!this.analyser || !this.levels) return 0;
    this.analyser.getByteTimeDomainData(this.levels);
    return Math.min(
      1,
      Math.sqrt(
        this.levels.reduce((sum, v) => sum + ((v - 128) / 128) ** 2, 0) /
          this.levels.length,
      ) * 3,
    );
  }
  private release() {
    this.stream?.getTracks().forEach((track) => track.stop());
    this.stream = undefined;
    if (this.context) void this.context.close().catch(() => {});
    this.context = undefined;
    this.analyser = undefined;
  }
}
export function recordingError(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "Microphone access was denied. Allow microphone access in system settings, then try again.";
  if (name === "NotFoundError")
    return "No microphone found. Connect a microphone and try again.";
  if (name === "NotReadableError")
    return "The microphone is busy or unavailable. Close other recording apps and try again.";
  return error instanceof Error ? error.message : String(error);
}
