import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeWav, MicrophoneRecorder, recordingError } from "./recording";

afterEach(() => vi.unstubAllGlobals());
it("encodes mono PCM WAV with correct sizes, clipping, and stereo downmix", () => {
  const bytes = encodeWav(
    [new Float32Array([-2, 0, 2]), new Float32Array([-2, 1, 2])],
    44100,
  );
  const view = new DataView(bytes);
  expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("RIFF");
  expect(view.getUint32(4, true)).toBe(bytes.byteLength - 8);
  expect(view.getUint32(40, true)).toBe(6);
  expect(view.getUint32(24, true)).toBe(44100);
  expect(view.getInt16(44, true)).toBe(-32768);
  expect(view.getInt16(46, true)).toBe(16384);
  expect(view.getInt16(48, true)).toBe(32767);
});

class FakeRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/mp4";
  ondataavailable?: (event: { data: Blob }) => void;
  onstop?: () => void;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["audio"]) });
    this.onstop?.();
  }
}
describe("microphone lifecycle", () => {
  it("records multiple independent clips and releases their microphones", async () => {
    const stop = vi.fn();
    const track = { stop, onended: null };
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: vi.fn().mockResolvedValue({
          getTracks: () => [track],
          getAudioTracks: () => [track],
        }),
      },
    });
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    for (let i = 0; i < 2; i++) {
      const recorder = new MicrophoneRecorder();
      const ended = vi.fn();
      expect(await recorder.start(ended)).toBe(true);
      expect(await (await recorder.stop()).text()).toBe("audio");
      expect(ended).toHaveBeenCalledOnce();
    }
    expect(stop).toHaveBeenCalled();
  });
  it("releases a late microphone permission result after cancellation", async () => {
    const stop = vi.fn();
    let resolve!: (value: unknown) => void;
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    });
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const recorder = new MicrophoneRecorder();
    const pending = recorder.start(vi.fn());
    recorder.cancel();
    resolve({ getTracks: () => [{ stop }] });
    expect(await pending).toBe(false);
    expect(stop).toHaveBeenCalledOnce();
  });
  it("provides actionable permission and missing-device errors", () => {
    expect(recordingError(new DOMException("", "NotAllowedError"))).toContain(
      "system settings",
    );
    expect(recordingError(new DOMException("", "NotFoundError"))).toContain(
      "Connect a microphone",
    );
  });
});
it("times out a pending permission and releases a late stream", async () => {
  vi.useFakeTimers();
  try {
    let resolve!: (value: unknown) => void;
    const stop = vi.fn();
    vi.stubGlobal("navigator", {
      mediaDevices: {
        getUserMedia: () =>
          new Promise((r) => {
            resolve = r;
          }),
      },
    });
    vi.stubGlobal("MediaRecorder", FakeRecorder);
    const recorder = new MicrophoneRecorder();
    const check = expect(
      recorder.start(vi.fn(), undefined, 50),
    ).rejects.toThrow("still pending");
    await vi.advanceTimersByTimeAsync(51);
    await check;
    resolve({ getTracks: () => [{ stop }] });
    await Promise.resolve();
    expect(stop).toHaveBeenCalledOnce();
  } finally {
    vi.useRealTimers();
  }
});
