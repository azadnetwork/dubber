const { GoogleGenAI } = require("@google/genai");
const fs = require("fs");

async function test() {
  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY,
  });

  try {
    console.log("Testing gemini-3.5-live-translate-preview...");
    const response = await ai.models.generateContent({
      model: "gemini-3.5-live-translate-preview",
      contents: [{ parts: [{ text: "Translate: Hello, welcome to our application." }] }],
      config: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: { voiceName: "Puck" },
          },
        },
      },
    });

    console.log("Success! Response keys:", Object.keys(response));
    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (base64Audio) {
      console.log("Found base64 audio! Length:", base64Audio.length);
      fs.writeFileSync("test_out_translate.wav", Buffer.from(base64Audio, "base64"));
      console.log("Wrote test_out_translate.wav");
    } else {
      console.log("No audio data found. Parts structure:", JSON.stringify(response.candidates?.[0]?.content?.parts, null, 2));
    }
  } catch (err) {
    console.error("Failed to call Gemini Live Translate:", err);
  }
}

test();
