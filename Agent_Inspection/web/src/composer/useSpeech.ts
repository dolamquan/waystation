import { useCallback, useEffect, useRef, useState } from 'react';

/** The parts of the Web Speech API the composer uses (Chrome and Edge ship it as webkitSpeechRecognition). */
interface SpeechAlternative { readonly transcript: string }
interface SpeechResult { readonly isFinal: boolean; readonly 0: SpeechAlternative }
interface SpeechResultEvent { readonly resultIndex: number; readonly results: ArrayLike<SpeechResult> }
interface SpeechErrorEvent { readonly error: string }
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: SpeechResultEvent) => void) | null;
  onerror: ((event: SpeechErrorEvent) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionConstructor = new () => Recognition;

function recognitionClass(): RecognitionConstructor | undefined {
  if (typeof window === 'undefined') return undefined;
  const scope = window as unknown as { SpeechRecognition?: RecognitionConstructor; webkitSpeechRecognition?: RecognitionConstructor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition;
}

const ERROR_TEXT: Readonly<Record<string, string>> = {
  'not-allowed': 'Microphone access is blocked. Allow it for this page in your browser’s site settings.',
  'service-not-allowed': 'Your browser’s speech service is turned off.',
  'audio-capture': 'No microphone was found.',
  network: 'Your browser’s speech service could not be reached.',
};

export interface Speech {
  readonly supported: boolean;
  readonly listening: boolean;
  /** Words heard so far that are not final yet. */
  readonly interim: string;
  readonly error?: string;
  readonly toggle: () => void;
  readonly stop: () => void;
}

/** Dictation into the composer. Each finished phrase goes to `onPhrase`; listening stops on unmount. */
export function useSpeech(onPhrase: (text: string) => void): Speech {
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string>();
  const recognition = useRef<Recognition | undefined>(undefined);
  const phrase = useRef(onPhrase);
  useEffect(() => { phrase.current = onPhrase; }, [onPhrase]);
  const Ctor = recognitionClass();

  const stop = useCallback(() => {
    recognition.current?.stop();
  }, []);

  const start = useCallback(() => {
    if (!Ctor) return;
    const next = new Ctor();
    next.lang = navigator.language || 'en-US';
    next.continuous = true;
    next.interimResults = true;
    next.onresult = (event) => {
      let pending = '';
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (result.isFinal) { if (text) phrase.current(text); } else pending += result[0].transcript;
      }
      setInterim(pending.trim());
    };
    next.onerror = (event) => {
      // "no-speech" and "aborted" are normal ends of a quiet or cancelled session.
      if (event.error !== 'no-speech' && event.error !== 'aborted') setError(ERROR_TEXT[event.error] ?? `Voice input stopped (${event.error}).`);
    };
    next.onend = () => {
      setListening(false);
      setInterim('');
      if (recognition.current === next) recognition.current = undefined;
    };
    setError(undefined);
    try {
      next.start();
      recognition.current = next;
      setListening(true);
    } catch (startError) {
      setError((startError as Error).message);
    }
  }, [Ctor]);

  const toggle = useCallback(() => {
    if (recognition.current) stop(); else start();
  }, [start, stop]);

  useEffect(() => () => {
    const current = recognition.current;
    if (!current) return;
    current.onend = null;
    current.onresult = null;
    current.abort();
  }, []);

  return { supported: !!Ctor, listening, interim, error, toggle, stop };
}
