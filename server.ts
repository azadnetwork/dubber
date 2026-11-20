// Live TTS Helper using gemini-3.8-live
async function generateSpeechWithLiveAPIInternal(
  text: string,
  voiceName: string,
  outputPath: string,
  targetLanguage?: string,
  customApiKey?: string
): Promise<number> {
  const aiClient = getGeminiAiClient(customApiKey);
  const tempPcmOut = outputPath + ".out.raw";
  const audioChunks: Buffer[] = [];

  let openPromiseResolve!: () => void;
  const openPromise = new Promise<void>((resolve) => { openPromiseResolve = resolve; });

  let closePromiseResolve!: () => void;
  const closePromise = new Promise<void>((resolve) => { closePromiseResolve = resolve; });

  let systemInstruction = "You are a professional text-to-speech engine. Your ONLY job is to speak the user's input text word for word in their language, with natural pronunciation and professional cadence. You MUST NOT add any introduction, explanations, prefaces, filler, or ending remarks. Speak only the exact text given.";

  // If the target language is Persian (fa), strictly request a standard Tehrani accent
  if (targetLanguage === "fa" || targetLanguage?.toLowerCase().startsWith("fa")) {
    systemInstruction += " Since the target language is Persian (Farsi), you MUST speak in a standard Tehrani accent (لهجه معیار تهرانی) as used in Tehran, Iran. Avoid any Afghan (Dari) or Tajik pronunciations, vocabulary, or accents completely. The voice must sound exactly like a native speaker from Tehran, Iran.";
  }

  // 1. Establish connection to Gemini Live API
  const session = await aiClient.live.connect({
    model: 'gemini-3.8-live',
    config: {
      responseModalities: ["AUDIO"],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: { voiceName }
        }
      },
      systemInstruction: systemInstruction
    } as any,
    callbacks: {
      onopen: () => {
        openPromiseResolve();
      },
      onmessage: (msg: any) => {
        if (msg.serverContent) {
          const modelTurn = msg.serverContent.modelTurn;
          if (modelTurn && modelTurn.parts) {
            for (const part of modelTurn.parts) {
              if (part.inlineData) {
                audioChunks.push(Buffer.from(part.inlineData.data, 'base64'));
              }
            }
          }
          if (msg.serverContent.turnComplete) {
            session.close();
            closePromiseResolve();
          }
        }
      },
      onerror: (err: any) => {
        console.error("Live TTS session error:", err);
      },
      onclose: () => {
        closePromiseResolve();
      }
    }
  });

  await openPromise;

  // 2. Send text to speak
  session.sendClientContent({
    turns: [{
      role: "user",
      parts: [{ text }]
    }],
    turnComplete: true
  });

  await closePromise;

  if (audioChunks.length === 0) {
    throw new Error("No audio chunks returned from Live API for TTS");
  }

  const combined = Buffer.concat(audioChunks);
  fs.writeFileSync(tempPcmOut, combined);

  // Convert raw 24kHz output PCM to standard containerized WAV
  await execAsync(`"${ffmpegPath}" -y -f s16le -ar 24000 -ac 1 -i "${tempPcmOut}" -acodec pcm_s16le "${outputPath}"`);

  try {
    fs.unlinkSync(tempPcmOut);
  } catch (_) {}

  const durationSec = await getAudioDuration(outputPath);
  return Math.round(durationSec * 1000);
}
