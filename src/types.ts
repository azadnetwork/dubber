/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface SrtSegment {
  id: number;
  startTime: string;
  endTime: string;
  text: string;
  translatedText?: string;
}

export interface DubbingJob {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  message: string;
  logs?: string[];
  resultUrl?: string;
  audioResultUrl?: string;
  error?: string;
}

export interface TranslationJob {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  message: string;
  logs?: string[];
  segments?: SrtSegment[];
  error?: string;
}

export type VoiceName =
  | "zephyr"
  | "puck"
  | "charon"
  | "kore"
  | "fenrir"
  | "leda"
  | "orus"
  | "aoede"
  | "callirrhoe"
  | "autonoe"
  | "enceladus"
  | "iapetus"
  | "umbriel"
  | "algieba"
  | "despina"
  | "erinome"
  | "algenib"
  | "rasalgethi"
  | "laomedeia"
  | "achernar"
  | "alnilam"
  | "schedar"
  | "gacrux"
  | "pulcherrima"
  | "achird"
  | "zubenelgenubi"
  | "vindemiatrix"
  | "sadachbia"
  | "sadaltager"
  | "sulafat";

export interface VoiceOption {
  id: VoiceName;
  name: string;
  gender: "Male" | "Female" | "Neutral";
  description: string;
}

export const DUBBING_VOICES: VoiceOption[] = [
  { id: "zephyr", name: "Zephyr", gender: "Male", description: "Warm, professional, and clear narrator voice" },
  { id: "puck", name: "Puck", gender: "Female", description: "Bright, energetic, and expressive voice" },
  { id: "charon", name: "Charon", gender: "Male", description: "Deep, resonant, authoritative voice" },
  { id: "kore", name: "Kore", gender: "Female", description: "Soft, calm, clear, and reassuring tone" },
  { id: "fenrir", name: "Fenrir", gender: "Male", description: "Bold, strong, and highly dynamic voice" },
  { id: "leda", name: "Leda", gender: "Female", description: "Melodic, smooth, and friendly narration" },
  { id: "orus", name: "Orus", gender: "Male", description: "Direct, crisp, and standard corporate tone" },
  { id: "aoede", name: "Aoede", gender: "Female", description: "Articulate, expressive, and warm storyteller" },
  { id: "callirrhoe", name: "Callirrhoe", gender: "Female", description: "Sophisticated, fluent, and gentle voice" },
  { id: "autonoe", name: "Autonoe", gender: "Female", description: "Intellectual, steady, and engaging tone" },
  { id: "enceladus", name: "Enceladus", gender: "Male", description: "Powerful, thick, and confident narrative voice" },
  { id: "iapetus", name: "Iapetus", gender: "Male", description: "Wise, seasoned, and comforting old tone" },
  { id: "umbriel", name: "Umbriel", gender: "Male", description: "Shadowy, mysterious, and highly cinematic" },
  { id: "algieba", name: "Algieba", gender: "Female", description: "Sparkling, clear, and very polite voice" },
  { id: "despina", name: "Despina", gender: "Female", description: "Playful, light-hearted, and youthful tone" },
  { id: "erinome", name: "Erinome", gender: "Female", description: "Airy, soft, and whisper-like calm voice" },
  { id: "algenib", name: "Algenib", gender: "Male", description: "Modern, upbeat, and tech-savvy presenter" },
  { id: "rasalgethi", name: "Rasalgethi", gender: "Male", description: "Vibrant, highly animated, and dramatic" },
  { id: "laomedeia", name: "Laomedeia", gender: "Female", description: "Poetic, slow, and artistic narration style" },
  { id: "achernar", name: "Achernar", gender: "Male", description: "Crisp, business-oriented, and formal voice" },
  { id: "alnilam", name: "Alnilam", gender: "Male", description: "Smooth, balanced, and everyday natural voice" },
  { id: "schedar", name: "Schedar", gender: "Female", description: "Distinctive, assertive, and authoritative female" },
  { id: "gacrux", name: "Gacrux", gender: "Male", description: "Deep, gravelly, and vintage classic style" },
  { id: "pulcherrima", name: "Pulcherrima", gender: "Female", description: "Highly polished, elegant, and lyrical voice" },
  { id: "achird", name: "Achird", gender: "Male", description: "Friendly, casual, and conversational companion" },
  { id: "zubenelgenubi", name: "Zubenelgenubi", gender: "Male", description: "Grand, echoey, and storytelling baritone" },
  { id: "vindemiatrix", name: "Vindemiatrix", gender: "Female", description: "Clear-cut, helpful, and energetic helper" },
  { id: "sadachbia", name: "Sadachbia", gender: "Female", description: "Delicate, slow, and highly soothing tone" },
  { id: "sadaltager", name: "Sadaltager", gender: "Male", description: "Rich, enthusiastic, and promotional voice" },
  { id: "sulafat", name: "Sulafat", gender: "Female", description: "Velvety, mature, and deeply narrative voice" },
];

export const TARGET_LANGUAGES = [
  { code: "fa", name: "Persian (فارسی)" },
  { code: "ku", name: "Kurdish (کُردی)" },
  { code: "en", name: "English" },
  { code: "ar", name: "Arabic (العربية)" },
  { code: "es", name: "Spanish (Español)" },
  { code: "fr", name: "French (Français)" },
  { code: "de", name: "German (Deutsch)" },
  { code: "it", name: "Italian (Italiano)" },
  { code: "tr", name: "Turkish (Türkçe)" },
  { code: "ru", name: "Russian (Русский)" },
  { code: "zh-Hans", name: "Simplified Chinese (简体中文)" },
  { code: "ja", name: "Japanese (日本語)" },
  { code: "ko", name: "Korean (한국어)" },
  { code: "hi", name: "Hindi (हिन्दी)" },
  { code: "pt-BR", name: "Portuguese (Português)" },
  { code: "pl", name: "Polish (Polski)" },
];
