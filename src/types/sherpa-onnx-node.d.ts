// Minimal typings for the parts of sherpa-onnx-node (1.13.8) this module
// uses. The package ships JSDoc only. Field names follow its types.js.

declare module 'sherpa-onnx-node' {
  export interface Waveform {
    samples: Float32Array;
    sampleRate: number;
  }

  export interface SileroVadModelConfig {
    model: string;
    threshold?: number;
    minSilenceDuration?: number;
    minSpeechDuration?: number;
    windowSize?: number;
    maxSpeechDuration?: number;
  }

  export interface VadConfig {
    sileroVad: SileroVadModelConfig;
    sampleRate: number;
    numThreads?: number;
    provider?: string;
    debug?: boolean | number;
  }

  export interface SpeechSegment {
    start: number;
    samples: Float32Array;
  }

  export class Vad {
    constructor(config: VadConfig, bufferSizeInSeconds: number);
    acceptWaveform(samples: Float32Array): void;
    isEmpty(): boolean;
    isDetected(): boolean;
    pop(): void;
    clear(): void;
    front(enableExternalBuffer?: boolean): SpeechSegment;
    reset(): void;
    flush(): void;
  }

  export interface OfflineRecognizerConfig {
    featConfig: { sampleRate: number; featureDim: number };
    modelConfig: {
      transducer?: { encoder: string; decoder: string; joiner: string };
      whisper?: { encoder: string; decoder: string; language?: string; task?: 'transcribe' | 'translate'; tailPaddings?: number };
      tokens: string;
      numThreads?: number;
      provider?: string;
      modelType?: string;
      debug?: number;
    };
  }

  export interface OfflineRecognizerResult {
    text: string;
    timestamps: number[];
    tokens: string[];
    /** Detected language (Whisper), e.g. "zh". */
    lang?: string;
  }

  export class OfflineStream {
    acceptWaveform(w: Waveform): void;
  }

  export class OfflineRecognizer {
    static createAsync(config: OfflineRecognizerConfig): Promise<OfflineRecognizer>;
    createStream(): OfflineStream;
    decodeAsync(stream: OfflineStream): Promise<OfflineRecognizerResult>;
  }

  export class LinearResampler {
    constructor(inputSampleRate: number, outputSampleRate: number);
    resample(samples: Float32Array): Float32Array;
    flush(samples: Float32Array): Float32Array;
  }

  export interface OfflineTtsConfig {
    model: {
      kokoro?: {
        model: string;
        voices: string;
        tokens: string;
        dataDir: string;
        lexicon?: string;
        dictDir?: string;
        lang?: string;
        lengthScale?: number;
      };
      vits?: { model: string; tokens: string; dataDir?: string; lexicon?: string };
      numThreads?: number;
      provider?: string;
      debug?: number;
    };
    maxNumSentences?: number;
    silenceScale?: number;
    /** Text normalization rules (comma-separated .fst files). */
    ruleFsts?: string;
  }

  export interface GeneratedAudio {
    samples: Float32Array;
    sampleRate: number;
  }

  export class OfflineTts {
    static createAsync(config: OfflineTtsConfig): Promise<OfflineTts>;
    generateAsync(req: { text: string; sid: number; speed: number }): Promise<GeneratedAudio>;
  }

  export function readWave(path: string): Waveform;
  export function writeWave(path: string, w: Waveform): void;

  const sherpa: {
    Vad: typeof Vad;
    OfflineRecognizer: typeof OfflineRecognizer;
    LinearResampler: typeof LinearResampler;
    OfflineTts: typeof OfflineTts;
    readWave: typeof readWave;
    writeWave: typeof writeWave;
  };
  export default sherpa;
}
