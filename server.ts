import express from "express";
import multer from "multer";
import path from "path";
import fs from "fs";
import https from "https";
import url from "url";
import { exec } from "child_process";
import { promisify } from "util";
import { GoogleGenAI } from "@google/genai";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";
import { Readable } from "stream";
// @ts-ignore
import ffmpegPath from "ffmpeg-static";
// @ts-ignore
import ffprobeStatic from "ffprobe-static";

dotenv.config();

const execAsync = promisify(exec);
const ffprobePath = ffprobeStatic.path;

// Cached verified working proxy to reuse across requests
let cachedProxy: string | null = null;

// Fetch HTTP and SOCKS5 proxies from updated public lists
async function fetchProxiesList(): Promise<string[]> {
  try {
    const urls = [
      "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt",
      "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt",
      "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt",
      "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt"
    ];

    const results = await Promise.allSettled(
      urls.map(url => fetch(url, { signal: AbortSignal.timeout(4000) }).then(r => r.text()))
    );

    const proxies: string[] = [];
    results.forEach((res, i) => {
      if (res.status === "fulfilled" && res.value) {
        const protocol = urls[i].includes("socks") ? "socks5://" : "http://";
        const lines = res.value.split("\n");
        for (const line of lines) {
          const clean = line.trim();
          if (clean && !clean.startsWith("#")) {
            proxies.push(clean.includes("://") ? clean : `${protocol}${clean}`);
          }
        }
      }
    });

    return proxies;
  } catch (err) {
    console.error("Error fetching proxies list:", err);
    return [];
  }
}

// Execute yt-dlp command using parallel proxy racing to find a working proxy fast
async function execWithProxyRotation(
  cmdBuilder: (proxyArg: string) => string,
  maxAttempts = 40
): Promise<{ stdout: string; stderr: string }> {
  const ytArgs = `--no-warnings --extractor-args "youtube:player_client=mweb,android,ios,web"`;

  // 1. Try cached working proxy first
  if (cachedProxy) {
    try {
      console.log(`Trying cached working proxy: ${cachedProxy}`);
      const cmd = cmdBuilder(`--proxy "${cachedProxy}" --socket-timeout 6 ${ytArgs}`);
      const { stdout, stderr } = await execAsync(cmd, { timeout: 45000 });
      return { stdout, stderr };
    } catch (err: any) {
      console.warn(`Cached proxy ${cachedProxy} failed. Resetting proxy cache.`);
      cachedProxy = null;
    }
  }

  // 2. Fetch fresh public proxy list
  const proxies = await fetchProxiesList();
  if (proxies.length === 0) {
    // Fallback attempt without proxy if list fetch failed
    const cmd = cmdBuilder(`--socket-timeout 6 ${ytArgs}`);
    return await execAsync(cmd, { timeout: 45000 });
  }

  // Shuffle proxy list
  const shuffled = proxies.sort(() => 0.5 - Math.random()).slice(0, maxAttempts);
  console.log(`Fetched ${proxies.length} proxies. Running parallel proxy racing on ${shuffled.length} candidates...`);

  const BATCH_SIZE = 10;
  for (let i = 0; i < shuffled.length; i += BATCH_SIZE) {
    const batch = shuffled.slice(i, i + BATCH_SIZE);
    try {
      const winner = await Promise.any(
        batch.map(async (proxy) => {
          const cmd = cmdBuilder(`--proxy "${proxy}" --socket-timeout 6 ${ytArgs}`);
          const res = await execAsync(cmd, { timeout: 25000 });
          cachedProxy = proxy; // Cache the winning proxy
          console.log(`Successfully found working proxy: ${proxy}`);
          return res;
        })
      );
      return winner;
    } catch (err: any) {
      // Batch failed, proceed to next parallel batch
    }
  }

  // Fallback to direct connection if all proxies in batch race failed
  try {
    console.warn("Proxy racing failed, attempting direct connection as last resort...");
    const cmd = cmdBuilder(`--socket-timeout 8 ${ytArgs}`);
    return await execAsync(cmd, { timeout: 60000 });
  } catch (err: any) {
    throw new Error("دانلود ویدیو از یوتیوب امکان‌پذیر نشد. لطفاً چند دقیقه دیگر مجدداً تلاش کنید.");
  }
}

// Initialize Gemini Client Helper with dynamic per-user custom API key support
function getGeminiAiClient(apiKeyOrReq?: string | express.Request): GoogleGenAI {
  let customKey: string | undefined;
  if (typeof apiKeyOrReq === "string") {
    customKey = apiKeyOrReq;
  } else if (apiKeyOrReq && typeof apiKeyOrReq === "object") {
    customKey =
      (apiKeyOrReq.headers?.["x-gemini-api-key"] as string) ||
      (apiKeyOrReq.body?.apiKey as string) ||
      (apiKeyOrReq.body?.customApiKey as string) ||
      (apiKeyOrReq.query?.apiKey as string);
  }
  const apiKey = (customKey && customKey.trim()) ? customKey.trim() : process.env.GEMINI_API_KEY;
  return new GoogleGenAI({
    apiKey: apiKey || "",
    httpOptions: {
      headers: {
        "User-Agent": "aistudio-build",
      },
    },
  });
}

// Queued Rate Limiter to strictly enforce RPM (Requests Per Minute) limits
class RateLimiter {
  private lastCallTime = 0;
  private minIntervalMs: number;
  private queue: Array<() => void> = [];
  private isProcessing = false;

  constructor(rpm: number) {
    // interval with safety margin (e.g. 5 RPM -> 12.5s, 15 RPM -> 4.2s)
    this.minIntervalMs = Math.ceil((60000 / rpm) * 1.05);
  }

  async acquire(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.queue.push(resolve);
      this.processQueue();
    });
  }

  private async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      const elapsed = now - this.lastCallTime;
      if (elapsed < this.minIntervalMs) {
        const waitTime = this.minIntervalMs - elapsed;
        await new Promise((res) => setTimeout(res, waitTime));
      }
      this.lastCallTime = Date.now();
      const next = this.queue.shift();
      if (next) next();
    }

    this.isProcessing = false;
  }
}

// 5 RPM rate limiter for subtitle extraction with gemini-3.7-flash
const transcribeRateLimiter = new RateLimiter(5);

// 15 RPM rate limiter for translation models (gemini-3.5-flash-lite, gemini-3.1-flash-lite)
const translationRateLimiter = new RateLimiter(15);

// Dedicated subtitle extraction function using alternating gemini-3.7-flash and gemini-3.6-flash (5 RPM managed per request)
let transcribeModelRotationIndex = 0;

// Helper to detect silences in audio via ffmpeg silencedetect filter
async function detectAudioSilences(filePath: string, minDurationSec = 0.4, noiseDb = -30): Promise<Array<{ start: number; end: number; mid: number }>> {
  try {
    const { stderr } = await execAsync(
      `"${ffmpegPath}" -i "${filePath}" -af silencedetect=noise=${noiseDb}dB:d=${minDurationSec} -f null -`,
      { maxBuffer: 10 * 1024 * 1024 }
    );

    const silences: Array<{ start: number; end: number; mid: number }> = [];
    const lines = stderr.split("\n");
    let currentStart: number | null = null;

    for (const line of lines) {
      const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
      if (startMatch) {
        currentStart = parseFloat(startMatch[1]);
      }
      const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
      if (endMatch && currentStart !== null) {
        const end = parseFloat(endMatch[1]);
        silences.push({
          start: currentStart,
          end: end,
          mid: (currentStart + end) / 2,
        });
        currentStart = null;
      }
    }
    return silences;
  } catch (err) {
    console.warn("Silence detection failed or returned empty, falling back to clean splitting:", err);
    return [];
  }
}

// Helper to split long audio (> 10 mins) into silence-aligned ~10-minute chunks
async function splitAudioAtSilencePoints(audioPath: string, totalDurationMs: number): Promise<Array<{ path: string; startMs: number; endMs: number }>> {
  const CHUNK_TARGET_MS = 10 * 60 * 1000; // 10 minutes (600,000 ms)

  if (totalDurationMs <= CHUNK_TARGET_MS + 30000) {
    // Under ~10.5 minutes: single chunk (single API request!)
    return [{ path: audioPath, startMs: 0, endMs: totalDurationMs }];
  }

  console.log(`[AUDIO SPLIT] Media is ${(totalDurationMs / 60000).toFixed(1)} minutes long. Detecting silence points for smooth 10-minute slicing...`);
  const silences = await detectAudioSilences(audioPath, 0.4, -30);
  console.log(`[AUDIO SPLIT] Found ${silences.length} silence gaps in audio.`);

  const chunks: Array<{ path: string; startMs: number; endMs: number }> = [];
  let currentStartMs = 0;
  let chunkIndex = 1;

  while (currentStartMs < totalDurationMs) {
    const remainingMs = totalDurationMs - currentStartMs;
    if (remainingMs <= CHUNK_TARGET_MS + 45000) {
      // Last remaining piece is small enough, keep as final chunk
      const chunkFile = path.join(path.dirname(audioPath), `chunk_${Date.now()}_${chunkIndex}.mp3`);
      const startSec = (currentStartMs / 1000).toFixed(3);
      const durationSec = (remainingMs / 1000).toFixed(3);

      await execAsync(
        `"${ffmpegPath}" -y -ss ${startSec} -i "${audioPath}" -t ${durationSec} -acodec copy "${chunkFile}"`
      );

      chunks.push({ path: chunkFile, startMs: currentStartMs, endMs: totalDurationMs });
      break;
    }

    const targetCutMs = currentStartMs + CHUNK_TARGET_MS;
    const targetCutSec = targetCutMs / 1000;

    // Look for best silence in a window: 9.0 mins to 11.0 mins
    const searchMinSec = (currentStartMs + 8.5 * 60 * 1000) / 1000;
    const searchMaxSec = (currentStartMs + 11.5 * 60 * 1000) / 1000;

    const candidateSilences = silences.filter(s => s.mid >= searchMinSec && s.mid <= searchMaxSec);
    let bestCutSec = targetCutSec;

    if (candidateSilences.length > 0) {
      // Pick silence closest to 10 min mark
      candidateSilences.sort((a, b) => Math.abs(a.mid - targetCutSec) - Math.abs(b.mid - targetCutSec));
      bestCutSec = candidateSilences[0].mid;
      console.log(`[AUDIO SPLIT] Found clean silence cut at ${(bestCutSec / 60).toFixed(2)} min (near 10 min target).`);
    } else {
      console.log(`[AUDIO SPLIT] No silence found between 8.5-11.5 min, cutting directly at 10.0 min mark.`);
    }

    const cutEndMs = Math.round(bestCutSec * 1000);
    const chunkDurationMs = cutEndMs - currentStartMs;
    const chunkFile = path.join(path.dirname(audioPath), `chunk_${Date.now()}_${chunkIndex}.mp3`);

    const startSec = (currentStartMs / 1000).toFixed(3);
    const durationSec = (chunkDurationMs / 1000).toFixed(3);

    await execAsync(
      `"${ffmpegPath}" -y -ss ${startSec} -i "${audioPath}" -t ${durationSec} -acodec copy "${chunkFile}"`
    );

    chunks.push({ path: chunkFile, startMs: currentStartMs, endMs: cutEndMs });
    currentStartMs = cutEndMs;
    chunkIndex++;
  }

  return chunks;
}

// Transcribe an audio slice using gemini-3.7-flash and gemini-3.6-flash in rotation
async function transcribeSingleAudioSlice(
  audioBase64: string,
  mimeType: string = "audio/mp3",
  onLog?: (text: string) => void,
  customApiKey?: string
): Promise<{ text: string; modelUsed: string }> {
  const aiClient = getGeminiAiClient(customApiKey);
  const audioPart = {
    inlineData: {
      data: audioBase64,
      mimeType: mimeType,
    },
  };
  const textPart = {
    text: "Analyze this audio file and transcribe all the spoken text into standard SubRip Subtitle (SRT) format. CRITICAL: You MUST break the transcribed text into short, readable, individual subtitle segments with highly accurate start and end timestamps (HH:MM:SS,mmm). Each segment should represent a single short sentence or phrase, lasting at most 4 to 5 seconds (maximum 6 to 10 words per segment). Do NOT output a single large block of text or giant paragraphs with one timestamp. Start segment indices from 1. Return ONLY the raw SRT text, no markdown block wrappers (like ```srt), no conversational introductory or explanatory remarks. If the speech content is dense, make sure to transcribe as much as you can up to the end of the audio.",
  };

  // User requirement: Alternating requests between gemini-3.7-flash and gemini-3.6-flash for speed and reliability
  const modelList = [
    "gemini-3.7-flash",
    "gemini-3.6-flash",
  ];

  const startIndex = transcribeModelRotationIndex % modelList.length;
  transcribeModelRotationIndex++;

  const orderedModels = [
    modelList[startIndex],
    modelList[(startIndex + 1) % modelList.length],
    "gemini-3.5-flash",
  ];

  let lastError: any = null;

  for (const model of orderedModels) {
    const is37or36 = model === "gemini-3.7-flash" || model === "gemini-3.6-flash";
    const retries = 3;
    let delay = is37or36 ? 12500 : 3000;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (onLog) {
          onLog(`🤖 مدل فعال: ${model} | تنظیم صف هوشمند (سهمیه ۵ RPM)...`);
        }
        console.log(`[TRANSCRIBE] Acquiring RPM slot for ${model}...`);
        await transcribeRateLimiter.acquire();

        if (onLog) {
          onLog(`🤖 مدل: ${model} | ارسال درخواست استخراج زیرنویس و زمان‌بندی (تلاش ${attempt}/${retries})...`);
        }
        console.log(`[TRANSCRIBE] Attempting transcription with model: ${model} (attempt ${attempt}/${retries})`);
        const response = await aiClient.models.generateContent({
          model,
          contents: [audioPart, textPart],
        });
        const text = response.text || "";
        if (text.trim()) {
          console.log(`[TRANSCRIBE] Successfully received transcription from ${model}`);
          if (onLog) {
            onLog(`✅ پاسخ کامل با مدل ${model} دریافت شد (${text.length} کاراکتر SRT).`);
          }
          return { text, modelUsed: model };
        }
      } catch (error: any) {
        lastError = error;
        const errStr = error.message || String(error);
        console.warn(`[TRANSCRIBE] Model ${model} failed on attempt ${attempt}: ${errStr}`);
        if (onLog) {
          onLog(`⚠️ خطا در ارتباط با ${model} (تلاش ${attempt}): ${errStr.slice(0, 80)}`);
        }
        const isQuotaExceeded = errStr.toLowerCase().includes("quota") || 
                               errStr.includes("RESOURCE_EXHAUSTED") ||
                               errStr.includes("429") ||
                               errStr.toLowerCase().includes("limit");
        if (attempt < retries) {
          const waitTime = isQuotaExceeded ? (is37or36 ? 15000 : 6000) : delay;
          console.log(`[TRANSCRIBE] Waiting ${waitTime}ms before retry...`);
          if (onLog) {
            onLog(`⏳ وقفه ایمن ${(waitTime / 1000).toFixed(1)} ثانیه جهت رعایت سقف لیمیت و تلاش مجدد...`);
          }
          await new Promise((resolve) => setTimeout(resolve, waitTime));
          delay *= 1.5;
        }
      }
    }
  }

  throw lastError || new Error("استخراج زیرنویس توسط هوش مصنوعی با خطا مواجه شد.");
}

// Complete Full-Media Subtitle Extraction with 10-Minute Silence-Aware Chunking
async function transcribeAudioWithGemini(
  audioFilePath: string,
  onProgress?: (msg: string, pct: number, log?: string) => void,
  customApiKey?: string
): Promise<SrtSegment[]> {
  const durationMs = await getMediaDurationMs(audioFilePath);
  const durationMin = (durationMs / 60000).toFixed(2);
  console.log(`[TRANSCRIBE PIPELINE] Total audio duration: ${durationMs}ms (${durationMin} mins)`);

  if (onProgress) {
    onProgress("تحلیل طول فایل صوتی...", 35, `🎬 فایل صوتی بارگذاری شد: طول کل ${durationMin} دقیقه (${durationMs}ms)`);
  }

  const slices = await splitAudioAtSilencePoints(audioFilePath, durationMs);
  console.log(`[TRANSCRIBE PIPELINE] Sliced into ${slices.length} piece(s) (1 request per <=10 minutes).`);

  if (onProgress) {
    if (slices.length === 1) {
      onProgress(
        "آماده‌سازی استخراج با هوش مصنوعی...",
        40,
        `📊 طول فایل زیر ۱۰ دقیقه است -> فقط ۱ درخواست بهینه و مستقل ارسال خواهد شد.`
      );
    } else {
      onProgress(
        "تقطیع هوشمند در نقاط سکوت...",
        40,
        `✂️ فایل به ${slices.length} قطعه تا سقف ۱۰ دقیقه تقطیع شد (برش از روی سکوت طبیعی بدون قطع کلام).`
      );
    }
  }

  const allSegments: SrtSegment[] = [];

  for (let i = 0; i < slices.length; i++) {
    const slice = slices[i];
    const sliceIndex = i + 1;
    const totalSlices = slices.length;
    const sliceDurationMin = ((slice.endMs - slice.startMs) / 60000).toFixed(2);

    if (onProgress) {
      const progressPercent = Math.round(45 + (i / totalSlices) * 50);
      onProgress(
        `استخراج زیرنویس بخش ${sliceIndex} از ${totalSlices} با هوش مصنوعی...`,
        progressPercent,
        `🎙️ شروع استخراج بخش ${sliceIndex}/${totalSlices} (بازه زمانی ${(slice.startMs / 60000).toFixed(2)} تا ${(slice.endMs / 60000).toFixed(2)} دقیقه - مدت: ${sliceDurationMin} دقیقه)`
      );
    }

    console.log(`[TRANSCRIBE PIPELINE] Processing slice ${sliceIndex}/${totalSlices} (from ${(slice.startMs / 60000).toFixed(2)} to ${(slice.endMs / 60000).toFixed(2)} min)...`);
    const base64Audio = fs.readFileSync(slice.path).toString("base64");
    
    const { text: rawSrt, modelUsed } = await transcribeSingleAudioSlice(
      base64Audio,
      "audio/mp3",
      (log) => {
        if (onProgress) {
          const progressPercent = Math.round(45 + (i / totalSlices) * 50);
          onProgress(`استخراج زیرنویس بخش ${sliceIndex} از ${totalSlices}...`, progressPercent, log);
        }
      },
      customApiKey
    );

    // Clean markdown
    const srtText = rawSrt.replace(/```srt\s*/g, "").replace(/```\s*$/g, "").trim();
    const sliceSegments = parseSrt(srtText);

    if (onProgress) {
      onProgress(
        `بخش ${sliceIndex} با موفقیت استخراج شد.`,
        65,
        `📝 [بخش ${sliceIndex}/${totalSlices}] تعداد ${sliceSegments.length} دیالوگ با زمان‌بندی دقیق از مدل ${modelUsed} استخراج شد.`
      );
    }

    // Shift timestamps by slice.startMs
    const offsetMs = slice.startMs;
    for (const seg of sliceSegments) {
      const segStartMs = parseTimeToMs(seg.startTime) + offsetMs;
      const segEndMs = parseTimeToMs(seg.endTime) + offsetMs;
      allSegments.push({
        id: allSegments.length + 1,
        startTime: formatSrtTime(segStartMs),
        endTime: formatSrtTime(segEndMs),
        text: seg.text,
      });
    }

    // Clean up temporary chunk file if it was created
    if (slice.path !== audioFilePath && fs.existsSync(slice.path)) {
      try {
        fs.unlinkSync(slice.path);
      } catch (_) {}
    }
  }

  // If no segments detected, return placeholder
  if (allSegments.length === 0) {
    allSegments.push({
      id: 1,
      startTime: "00:00:00,000",
      endTime: formatSrtTime(Math.min(durationMs, 5000) || 5000),
      text: "گفتاری در فایل صوتی تشخیص داده نشد. متن خود را در اینجا وارد کنید.",
    });
  }

  if (onProgress) {
    onProgress(
      "استخراج کامل شد.",
      98,
      `🎉 پایان موفق استخراج: مجموعاً ${allSegments.length} دیالوگ روی تایم‌لاین تنظیم شد.`
    );
  }

  return allSegments;
}

// Single batch verification & translation function
interface TranslateBatchOptions {
  targetLanguage: string;
  toneInstructions: string;
  shorteningInstructions: string;
  startIndex: number;
  onLog?: (logLine: string) => void;
  customApiKey?: string;
}

async function translateBatchWithVerification(
  batch: SrtSegment[],
  batchIndex: number,
  totalBatches: number,
  workerId: number,
  options: TranslateBatchOptions
): Promise<SrtSegment[]> {
  const { targetLanguage, toneInstructions, shorteningInstructions, startIndex, onLog, customApiKey } = options;
  const aiClient = getGeminiAiClient(customApiKey);

  // Decide primary model based on dialogue index (0..499 -> gemini-3.5-flash-lite, 500+ -> gemini-3.1-flash-lite)
  const isAfter500 = startIndex >= 500;
  const primaryModel = isAfter500 ? "gemini-3.1-flash-lite" : "gemini-3.5-flash-lite";
  const secondaryModel = isAfter500 ? "gemini-3.5-flash-lite" : "gemini-3.1-flash-lite";
  const candidateModels = [primaryModel, secondaryModel, "gemini-3.5-flash"];

  const rawSrt = batch
    .map((seg, i) => `${i + 1}\n${seg.startTime} --> ${seg.endTime}\n${seg.text}`)
    .join("\n\n");

  const prompt = `Translate the following SRT subtitles to ${targetLanguage}.
Keep the exact same subtitle indices (1 to ${batch.length}) and timestamps (HH:MM:SS,mmm).
Only translate the actual spoken text.
${toneInstructions}
${shorteningInstructions}
CRITICAL REQUIREMENT: You MUST translate and return all ${batch.length} subtitle items without skipping any index.
Return ONLY the translated raw SRT text. Do not include any explanations, prefaces, or markdown blocks (like \`\`\`srt).

Subtitles content:
${rawSrt}`;

  const maxBatchRetries = 4;
  let lastError: any = null;

  for (let attempt = 1; attempt <= maxBatchRetries; attempt++) {
    // Rotate model on retry if needed
    const modelToUse = candidateModels[(attempt - 1) % candidateModels.length];

    try {
      // Respect 15 RPM limit across all workers
      if (onLog) {
        onLog(`[کارگر ${workerId}] 🤖 مدل: ${modelToUse} | تنظیم صف هوشمند (سهمیه ۱۵ RPM) برای دسته ${batchIndex + 1}/${totalBatches}...`);
      }
      console.log(`[TRANSLATE BATCH ${batchIndex + 1}/${totalBatches}] Worker acquiring 15 RPM slot... (Model: ${modelToUse}, Attempt: ${attempt})`);
      await translationRateLimiter.acquire();

      if (onLog) {
        onLog(`[کارگر ${workerId}] 🚀 ارسال دسته ${batchIndex + 1}/${totalBatches} (${batch.length} دیالوگ، شماره‌های ${startIndex + 1} تا ${startIndex + batch.length}) به مدل ${modelToUse} (تلاش ${attempt}/${maxBatchRetries})`);
      }
      console.log(`[TRANSLATE BATCH ${batchIndex + 1}/${totalBatches}] Sending ${batch.length} dialogues (indices ${startIndex + 1}..${startIndex + batch.length}) to ${modelToUse}...`);
      const response = await aiClient.models.generateContent({
        model: modelToUse,
        contents: prompt,
      });

      let translatedSrtText = (response.text || "").replace(/```srt\s*/g, "").replace(/```\s*$/g, "").trim();
      if (!translatedSrtText) {
        throw new Error(`Empty response received from ${modelToUse}`);
      }

      const parsedSegments = parseSrt(translatedSrtText);
      console.log(`[TRANSLATE BATCH ${batchIndex + 1}/${totalBatches}] Received ${parsedSegments.length}/${batch.length} parsed translated segments.`);

      // Verification: Ensure batch is completely translated
      if (parsedSegments.length === batch.length) {
        if (onLog) {
          onLog(`[کارگر ${workerId}] ✅ دسته ${batchIndex + 1}/${totalBatches} با موفقیت کامل تأیید شد (${parsedSegments.length} دیالوگ ترجمه شده با مدل ${modelToUse}).`);
        }
        return batch.map((orig, i) => ({
          ...orig,
          text: parsedSegments[i]?.text || orig.text,
        }));
      } else if (parsedSegments.length > 0 && Math.abs(parsedSegments.length - batch.length) <= 2 && attempt >= 2) {
        if (onLog) {
          onLog(`[کارگر ${workerId}] ⚠️ دسته ${batchIndex + 1}/${totalBatches} با انطباق جزئی تأیید شد (${parsedSegments.length}/${batch.length} دیالوگ).`);
        }
        return batch.map((orig, i) => ({
          ...orig,
          text: parsedSegments[i]?.text || orig.text,
        }));
      } else {
        throw new Error(`Batch incomplete: Expected ${batch.length} segments but received ${parsedSegments.length}. Retrying batch...`);
      }
    } catch (err: any) {
      lastError = err;
      const errStr = err.message || String(err);
      console.warn(`[TRANSLATE BATCH ${batchIndex + 1}/${totalBatches}] Attempt ${attempt} failed on ${modelToUse}: ${errStr}`);
      if (onLog) {
        onLog(`[کارگر ${workerId}] ⚠️ خطا در ترجمه دسته ${batchIndex + 1} با ${modelToUse}: ${errStr.slice(0, 80)}`);
      }
      const isQuota = errStr.toLowerCase().includes("quota") || 
                      errStr.includes("RESOURCE_EXHAUSTED") || 
                      errStr.includes("429");
      if (attempt < maxBatchRetries) {
        const waitMs = isQuota ? 6000 : 2500;
        if (onLog) {
          onLog(`[کارگر ${workerId}] ⏳ وقفه ${(waitMs / 1000).toFixed(1)} ثانیه و ارسال مجدد به مدل پشتیبان...`);
        }
        console.log(`[TRANSLATE BATCH ${batchIndex + 1}/${totalBatches}] Waiting ${waitMs}ms before retrying batch...`);
        await new Promise((res) => setTimeout(res, waitMs));
      }
    }
  }

  console.error(`[TRANSLATE BATCH ${batchIndex + 1}/${totalBatches}] All retries failed for batch.`);
  throw lastError || new Error(`ترجمه دسته ${batchIndex + 1} با خطا مواجه شد.`);
}

// Parallel Subtitle Translation Pipeline (3 Workers, 30 Dialogues/Batch, 15 RPM)
async function translateAllSegmentsParallel(
  segments: SrtSegment[],
  targetLanguage: string,
  translationTone: string,
  enableShortening: boolean,
  onProgress?: (msg: string, pct: number, log?: string) => void,
  customApiKey?: string
): Promise<{ translatedSrtText: string; segments: SrtSegment[] }> {
  const BATCH_SIZE = 30;
  const CONCURRENCY = 3;

  let toneInstructions = "";
  if (translationTone === "formal") {
    toneInstructions = `Use a formal, professional, and academic tone (لحن رسمی و کتابی) in ${targetLanguage}.`;
  } else if (translationTone === "colloquial") {
    toneInstructions = `Use a friendly, casual, and colloquial/spoken tone (لحن صمیمی و محاوره‌ای/شکسته) in ${targetLanguage}.`;
  } else {
    toneInstructions = `Dynamically match the tone of the original context (whether formal, casual, technical, or conversational) in ${targetLanguage}.`;
  }

  let shorteningInstructions = "";
  if (enableShortening) {
    shorteningInstructions = `
CRITICAL CONSTRAINT - SMART SHORTENING & DURATION FIT:
1. Since these translations will be dubbed into an audio stream, you MUST make sure each translated segment's word length matches its timestamp duration.
2. The duration of each segment is specified by the "startTime --> endTime" timestamp.
3. If the original spoken text is very fast, long, or dense, do NOT translate it word-for-word. Instead, write an intelligent, high-quality, and natural summary/paraphrase in ${targetLanguage} that captures the core meaning perfectly but uses significantly fewer words (isochronic speed-fit).
4. Target a standard comfortable speech pacing of approximately 110 to 130 words per minute in ${targetLanguage} for the segment duration. Keep the translation concise, punchy, and natural.
`;
  }

  // Create batches of 30 dialogues
  const batches: { batch: SrtSegment[]; startIndex: number; batchIndex: number }[] = [];
  for (let i = 0; i < segments.length; i += BATCH_SIZE) {
    batches.push({
      batch: segments.slice(i, i + BATCH_SIZE),
      startIndex: i,
      batchIndex: Math.floor(i / BATCH_SIZE),
    });
  }

  const totalBatches = batches.length;
  console.log(`[PARALLEL TRANSLATION] Translating ${segments.length} segments across ${totalBatches} batches (Batch Size: ${BATCH_SIZE}) with ${CONCURRENCY} workers.`);

  if (onProgress) {
    onProgress(
      `شروع ترجمه موازی ${segments.length} دیالوگ...`,
      5,
      `🌐 آغاز ترجمه: ${segments.length} دیالوگ در قالب ${totalBatches} دسته ۳۰تایی با ۳ کارگر موازی (مدل gemini-3.5-flash-lite تا ۵۰۰ دیالوگ، سپس gemini-3.1-flash-lite)`
    );
  }

  const translatedResults: SrtSegment[][] = new Array(totalBatches);
  let currentBatchQueueIndex = 0;
  let completedBatchesCount = 0;

  // Worker task runner
  const runWorker = async (workerId: number) => {
    while (true) {
      const idx = currentBatchQueueIndex++;
      if (idx >= totalBatches) break;

      const item = batches[idx];
      console.log(`[WORKER ${workerId}] Processing Batch ${item.batchIndex + 1}/${totalBatches} (indices ${item.startIndex + 1}..${item.startIndex + item.batch.length})`);
      
      const isAfter500 = item.startIndex >= 500;
      const modelName = isAfter500 ? "gemini-3.1-flash-lite" : "gemini-3.5-flash-lite";

      if (onProgress) {
        const pct = Math.round(5 + (completedBatchesCount / totalBatches) * 90);
        onProgress(
          `در حال ترجمه دسته‌های دیالوگ (${completedBatchesCount}/${totalBatches})...`,
          pct,
          `[کارگر ${workerId}] ⚙️ شروع پردازش دسته ${item.batchIndex + 1}/${totalBatches} با مدل ${modelName} ${isAfter500 ? "(سوییچ بالای ۵۰۰ دیالوگ)" : ""}`
        );
      }

      const translatedBatch = await translateBatchWithVerification(
        item.batch,
        item.batchIndex,
        totalBatches,
        workerId,
        {
          targetLanguage,
          toneInstructions,
          shorteningInstructions,
          startIndex: item.startIndex,
          customApiKey,
          onLog: (logLine) => {
            if (onProgress) {
              const pct = Math.round(5 + (completedBatchesCount / totalBatches) * 90);
              onProgress(`در حال ترجمه دسته‌ها...`, pct, logLine);
            }
          }
        }
      );

      translatedResults[item.batchIndex] = translatedBatch;
      completedBatchesCount++;
      console.log(`[WORKER ${workerId}] Successfully finished Batch ${item.batchIndex + 1}/${totalBatches}`);

      if (onProgress) {
        const pct = Math.round(5 + (completedBatchesCount / totalBatches) * 90);
        onProgress(
          `دسته ${item.batchIndex + 1} از ${totalBatches} با موفقیت ترجمه شد.`,
          pct,
          `[کارگر ${workerId}] 🎉 تکمیل دسته ${item.batchIndex + 1}/${totalBatches} | پیشرفت کل: ${completedBatchesCount}/${totalBatches} دسته`
        );
      }
    }
  };

  // Launch 3 workers in parallel
  const workers = Array.from({ length: Math.min(CONCURRENCY, totalBatches) }, (_, i) => runWorker(i + 1));
  await Promise.all(workers);

  // Collect results in exact order
  const finalSegments: SrtSegment[] = [];
  for (let i = 0; i < totalBatches; i++) {
    const batchResult = translatedResults[i];
    if (!batchResult) {
      throw new Error(`دسته شماره ${i + 1} کامل ترجمه نشد.`);
    }
    finalSegments.push(...batchResult);
  }

  // Ensure sequential IDs
  const fixedSegments = finalSegments.map((s, idx) => ({
    ...s,
    id: idx + 1,
  }));

  const translatedSrtText = fixedSegments
    .map((seg, i) => `${i + 1}\n${seg.startTime} --> ${seg.endTime}\n${seg.text}`)
    .join("\n\n");

  if (onProgress) {
    onProgress(
      "ترجمه کامل شد!",
      100,
      `✨ ترجمه ۱۰۰٪ به پایان رسید: تمامی ${fixedSegments.length} دیالوگ با موفقیت بازنویسی و زمان‌بندی شدند.`
    );
  }

  return {
    translatedSrtText,
    segments: fixedSegments,
  };
}

// Helper function to call Gemini generateContent with fallback and exponential backoff retry for transient errors
async function generateGeminiContentWithFallback(params: {
  contents: any;
  config?: any;
  customApiKey?: string;
}): Promise<any> {
  const aiClient = getGeminiAiClient(params.customApiKey);
  const modelsToTry = [
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
    "gemini-flash-latest"
  ];

  let lastError: any = null;

  for (const model of modelsToTry) {
    const retries = 3;
    let delay = 1500;
    
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`Attempting Gemini call with model: ${model} (attempt ${attempt}/${retries})`);
        const response = await aiClient.models.generateContent({
          model,
          contents: params.contents,
          config: params.config,
        });
        console.log(`Successfully completed call with model: ${model}`);
        return response;
      } catch (error: any) {
        lastError = error;
        const errStr = error.message || String(error);
        const isQuotaExceeded = errStr.toLowerCase().includes("quota") || 
                               errStr.includes("RESOURCE_EXHAUSTED") ||
                               errStr.toLowerCase().includes("limit") ||
                               errStr.toLowerCase().includes("exceeded");
                               
        const isTransient = (errStr.includes("fetch failed") || 
                            errStr.includes("timeout") || 
                            error.status === 429 || 
                            error.status >= 500) && !isQuotaExceeded;
                            
        if (isTransient && attempt < retries) {
          console.warn(`Transient error on model ${model} (attempt ${attempt}): ${errStr}. Retrying in ${delay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          delay *= 2; // Exponential backoff
        } else {
          console.warn(`Model ${model} failed on attempt ${attempt}. Error: ${errStr}.`);
          break; // Try next fallback model
        }
      }
    }
  }

  console.error("All Gemini fallback models and retry attempts failed.");
  throw lastError || new Error("All Gemini model generation attempts failed.");
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;

// Body parser
app.use(express.json({ limit: "1000mb" }));
app.use(express.urlencoded({ extended: true, limit: "1000mb" }));

// Ensure folders exist
const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const OUTPUT_DIR = path.join(process.cwd(), "output");
const PROJECT_DIR = path.join(process.cwd(), "dubbing_project");

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(PROJECT_DIR)) fs.mkdirSync(PROJECT_DIR, { recursive: true });

// Serve static assets
app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/output", express.static(OUTPUT_DIR));

// Setup multer for local disk uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, "_");
    cb(null, `${base}_${Date.now()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 1000 * 1024 * 1024 }, // 1000 MB limit
});

// Parsed SRT Interface
interface SrtSegment {
  id: number;
  startTime: string;
  endTime: string;
  text: string;
}

// Background jobs dictionary
interface Job {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  message: string;
  logs?: string[];
  resultUrl?: string;
  audioResultUrl?: string;
  error?: string;
}
const jobs: Record<string, Job> = {};

// Background transcription jobs dictionary
interface TranscribeJob {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  message: string;
  logs?: string[];
  fileId?: string;
  fileName?: string;
  fileType?: "video" | "audio";
  segments?: SrtSegment[];
  error?: string;
}
const transcribeJobs: Record<string, TranscribeJob> = {};

// Background translation jobs dictionary
interface TranslationJob {
  id: string;
  status: "pending" | "processing" | "completed" | "failed";
  progress: number;
  message: string;
  logs?: string[];
  segments?: SrtSegment[];
  translatedSrtText?: string;
  error?: string;
}
const translationJobs: Record<string, TranslationJob> = {};

function addJobLog(job: { logs?: string[] }, text: string) {
  if (!job.logs) job.logs = [];
  const time = new Date().toLocaleTimeString("fa-IR", { hour12: false });
  job.logs.push(`[${time}] ${text}`);
  if (job.logs.length > 250) {
    job.logs.shift();
  }
}

// Helper function to extract media duration in milliseconds via ffprobe
async function getMediaDurationMs(filePath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `"${ffprobePath}" -v error -show_entries format=duration -of default=nw=1:nk=1 "${filePath}"`
    );
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? 0 : Math.round(duration * 1000);
  } catch (err) {
    console.error("Failed to get media duration via ffprobe:", err);
    return 0;
  }
}

// Parse SRT content to array
function parseSrt(srtContent: string): SrtSegment[] {
  if (!srtContent || !srtContent.trim()) return [];

  const segments: SrtSegment[] = [];

  // Helper to standardise times to "HH:MM:SS,mmm"
  function padTime(timeStr: string): string {
    timeStr = timeStr.trim().replace(".", ",");
    const parts = timeStr.split(":");
    let formatted = timeStr;
    if (parts.length === 2) {
      formatted = "00:" + timeStr;
    }
    if (!formatted.includes(",")) {
      formatted += ",000";
    } else {
      const subParts = formatted.split(",");
      if (subParts[1].length < 3) {
        subParts[1] = subParts[1].padEnd(3, "0");
        formatted = subParts.join(",");
      } else if (subParts[1].length > 3) {
        subParts[1] = subParts[1].substring(0, 3);
        formatted = subParts.join(",");
      }
    }
    const mainParts = formatted.split(",")[0].split(":");
    const h = (mainParts[0] || "00").padStart(2, "0");
    const m = (mainParts[1] || "00").padStart(2, "0");
    const s = (mainParts[2] || "00").padStart(2, "0");
    return `${h}:${m}:${s},${formatted.split(",")[1] || "000"}`;
  }

  const timeRegex = /(\d{1,2}:\d{2}:\d{2}(?:[,\.]\d{1,3})?|\d{1,2}:\d{2}(?:[,\.]\d{1,3})?)\s*--?>\s*(\d{1,2}:\d{2}:\d{2}(?:[,\.]\d{1,3})?|\d{1,2}:\d{2}(?:[,\.]\d{1,3})?)/;

  const lines = srtContent.split(/\r?\n/);
  let currentStart: string | null = null;
  let currentEnd: string | null = null;
  let currentTextLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    const timeMatch = line.match(timeRegex);
    if (timeMatch) {
      // We found a new timestamp line!
      // If we had a previous segment, finalize it first.
      if (currentStart && currentEnd) {
        // Remove index number from the end of currentTextLines if it got added there
        if (currentTextLines.length > 0) {
          const lastLine = currentTextLines[currentTextLines.length - 1];
          if (/^\d+$/.test(lastLine)) {
            currentTextLines.pop();
          }
        }
        const text = currentTextLines.join("\n").trim();
        if (text) {
          segments.push({
            id: segments.length + 1,
            startTime: padTime(currentStart),
            endTime: padTime(currentEnd),
            text: text,
          });
        }
      }
      currentStart = timeMatch[1];
      currentEnd = timeMatch[2];
      currentTextLines = [];
    } else {
      if (currentStart && currentEnd) {
        currentTextLines.push(line);
      }
    }
  }

  // Push the final segment
  if (currentStart && currentEnd) {
    if (currentTextLines.length > 0) {
      const lastLine = currentTextLines[currentTextLines.length - 1];
      if (/^\d+$/.test(lastLine)) {
        currentTextLines.pop();
      }
    }
    const text = currentTextLines.join("\n").trim();
    if (text) {
      segments.push({
        id: segments.length + 1,
        startTime: padTime(currentStart),
        endTime: padTime(currentEnd),
        text: text,
      });
    }
  }

  return segments;
}

// Parse time string "HH:MM:SS,mmm" to milliseconds
function parseTimeToMs(timeStr: string): number {
  const parts = timeStr.trim().replace(".", ",").split(":");
  if (parts.length < 3) return 0;
  const hours = parseInt(parts[0], 10) || 0;
  const minutes = parseInt(parts[1], 10) || 0;
  const secondParts = parts[2].split(",");
  const seconds = parseInt(secondParts[0], 10) || 0;
  const ms = parseInt(secondParts[1], 10) || 0;
  return ((hours * 3600 + minutes * 60 + seconds) * 1000) + ms;
}

// Format milliseconds to "HH:MM:SS,mmm"
function formatSrtTime(ms: number): string {
  const hours = Math.floor(ms / 3600000);
  const minutes = Math.floor((ms % 3600000) / 60000);
  const seconds = Math.floor((ms % 60000) / 1000);
  const milliseconds = ms % 1000;
  return `${hours.toString().padStart(2, "0")}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")},${milliseconds.toString().padStart(2, "0")}`;
}

// Check if a file has video stream
async function hasVideoStream(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `"${ffprobePath}" -v error -select_streams v -show_entries stream=codec_type -of default=nw=1:nk=1 "${filePath}"`
    );
    return stdout.trim().includes("video");
  } catch (error) {
    return false;
  }
}

// Check if a file has audio stream
async function hasAudioStream(filePath: string): Promise<boolean> {
  try {
    const { stdout } = await execAsync(
      `"${ffprobePath}" -v error -select_streams a -show_entries stream=codec_type -of default=nw=1:nk=1 "${filePath}"`
    );
    return stdout.trim().includes("audio");
  } catch (error) {
    return false;
  }
}

// Get precise audio duration
async function getAudioDuration(filePath: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `"${ffprobePath}" -v error -show_entries format=duration -of default=nw=1:nk=1 "${filePath}"`
    );
    return parseFloat(stdout.trim()) || 0;
  } catch (error) {
    console.error("ffprobe duration error:", error);
    return 0;
  }
}

// Health Check API
app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date() });
});

// Background transcription runner function
async function runTranscribeBackground(
  jobId: string,
  mediaFile: { path: string; filename: string; originalname: string },
  srtFile: { path: string } | undefined,
  customApiKey?: string
) {
  const job = transcribeJobs[jobId];
  if (!job) return;

  try {
    const mediaPath = mediaFile.path;
    const mediaName = mediaFile.filename;
    const ext = path.extname(mediaFile.originalname).toLowerCase();

    addJobLog(job, `🎬 دریافت فایل: ${mediaFile.originalname} (شناسه: ${mediaName})`);

    // Fetch media duration
    const mediaDurationMs = await getMediaDurationMs(mediaPath);
    const durMin = (mediaDurationMs / 60000).toFixed(2);
    console.log(`Media duration retrieved: ${mediaDurationMs}ms`);
    addJobLog(job, `⏱️ مدت زمان فایل: ${durMin} دقیقه (${mediaDurationMs} میلی‌ثانیه)`);

    // If subtitle was pre-uploaded, use it directly!
    if (srtFile) {
      job.message = "فایل با موفقیت بارگذاری شد. در حال خواندن فایل زیرنویس آپلود شده...";
      job.progress = 50;
      addJobLog(job, `📄 خواندن فایل زیرنویس آپلود شده توسط کاربر...`);
      const srtContent = fs.readFileSync(srtFile.path, "utf-8");
      let segments = parseSrt(srtContent);
      if (!segments || segments.length === 0) {
        segments = [{
          id: 1,
          startTime: "00:00:00,000",
          endTime: "00:00:05,000",
          text: "No subtitles found. Please click 'Add Segment' or write dialogue here.",
        }];
      }
      job.status = "completed";
      job.progress = 100;
      job.message = "استخراج زیرنویس با موفقیت پایان یافت.";
      job.fileId = mediaName;
      job.fileName = mediaFile.originalname;
      job.fileType = ext === ".mp3" || ext === ".wav" || ext === ".m4a" ? "audio" : "video";
      job.segments = segments;
      addJobLog(job, `✅ فایل زیرنویس بارگذاری شد (${segments.length} دیالوگ).`);
      return;
    }

    // Identify if video or audio
    const isVideo = !(ext === ".mp3" || ext === ".wav" || ext === ".m4a" || ext === ".ogg");
    const audioPath = path.join(UPLOADS_DIR, `${mediaName}_extracted.mp3`);

    const stats = fs.statSync(mediaPath);
    const isLargeFile = stats.size > 15 * 1024 * 1024; // > 15MB to optimize Gemini token usage
    let sourceAudioPath = mediaPath;

    if (isVideo) {
      job.message = isLargeFile 
        ? "مرحله ۱ از ۲: استخراج و بهینه‌سازی بسیار فشرده صدا از ویدیو بزرگ..." 
        : "مرحله ۱ از ۲: استخراج صدا از ویدیو...";
      job.progress = 30;
      addJobLog(job, `🔊 [مرحله ۱/۲] استخراج ترک صوتی از ویدیو با FFmpeg...`);
      try {
        const ab = isLargeFile ? "24k" : "64k";
        const ar = isLargeFile ? "16000" : "22050";
        await execAsync(
          `"${ffmpegPath}" -y -i "${mediaPath}" -vn -acodec libmp3lame -ab ${ab} -ar ${ar} -ac 1 "${audioPath}"`
        );
        sourceAudioPath = audioPath;
        addJobLog(job, `✅ استخراج ترک صوتی کامل شد.`);
      } catch (err: any) {
        console.error("FFmpeg extraction failed:", err);
        addJobLog(job, `❌ خطا در استخراج صدا: ${err.message}`);
        throw new Error(`خطا در مرحله استخراج صدا از ویدیو (FFmpeg): ${err.message}`);
      }
    } else {
      // It's an audio file
      if (isLargeFile) {
        job.message = "مرحله ۱ از ۲: بهینه‌سازی و فشرده‌سازی فایل صوتی بزرگ...";
        job.progress = 30;
        addJobLog(job, `🎛️ بهینه‌سازی و فشرده‌سازی فایل صوتی با حجم بالا...`);
        try {
          await execAsync(
            `"${ffmpegPath}" -y -i "${mediaPath}" -acodec libmp3lame -ab 24k -ar 16000 -ac 1 "${audioPath}"`
          );
          sourceAudioPath = audioPath;
          addJobLog(job, `✅ بهینه‌سازی صوت کامل شد.`);
        } catch (err: any) {
          console.error("FFmpeg audio compression failed:", err);
          throw new Error(`خطا در فشرده‌سازی فایل صوتی (FFmpeg): ${err.message}`);
        }
      } else {
        // Send raw audio file as-is
        sourceAudioPath = mediaPath;
      }
    }

    // Call Gemini to transcribe using silence-aware 10-minute slicing and alternating 3.7/3.6 models
    job.message = "مرحله ۲ از ۲: پردازش صوتی و استخراج زمان‌بندی دقیق زیرنویس با هوش مصنوعی...";
    job.progress = 50;
    addJobLog(job, `🧠 [مرحله ۲/۲] ارسال به مدل‌های هوش مصنوعی (gemini-3.7-flash / gemini-3.6-flash)...`);

    console.log(`[STAGE: TRANSCRIPTION] Verifying audio file exists at path: ${sourceAudioPath}`);
    if (!fs.existsSync(sourceAudioPath)) {
      console.error(`[STAGE: TRANSCRIPTION ERROR] Audio file not found at: ${sourceAudioPath}`);
      throw new Error("فایل صوتی جهت استخراج متن یافت نشد.");
    }

    console.log(`[STAGE: TRANSCRIPTION] Starting transcription pipeline with 10-minute silence-aligned chunks...`);
    const startTime = Date.now();
    const segments = await transcribeAudioWithGemini(
      sourceAudioPath,
      (msg, pct, logLine) => {
        job.message = msg;
        job.progress = pct;
        if (logLine) {
          addJobLog(job, logLine);
        }
      },
      customApiKey
    );
    console.log(`[STAGE: TRANSCRIPTION] Finished full transcription in ${((Date.now() - startTime) / 1000).toFixed(2)}s with ${segments.length} segments.`);

    job.status = "completed";
    job.progress = 100;
    job.message = "استخراج متن با موفقیت به پایان رسید!";
    job.fileId = mediaName;
    job.fileName = mediaFile.originalname;
    job.fileType = isVideo ? "video" : "audio";
    job.segments = segments;
    addJobLog(job, `🎯 پایان فرآیند استخراج در ${((Date.now() - startTime) / 1000).toFixed(1)} ثانیه با ${segments.length} سگمنت دیالوگ.`);
  } catch (err: any) {
    console.error("Background transcription job failed:", err);
    job.status = "failed";
    job.message = "بروز خطا در پردازش فایل";
    job.error = err.message || "خطای نامشخص در استخراج متن توسط هوش مصنوعی.";
    addJobLog(job, `❌ خطا: ${err.message || "استخراج ناموفق بود."}`);
  }
}

// Upload media file and start background transcription
app.post("/api/upload-and-transcribe", upload.fields([
  { name: "media", maxCount: 1 },
  { name: "srt", maxCount: 1 }
]), async (req: any, res: any) => {
  try {
    const mediaFile = req.files?.media?.[0];
    const srtFile = req.files?.srt?.[0];
    const customApiKey = (req.headers["x-gemini-api-key"] as string | undefined)?.trim() || (req.body?.apiKey as string | undefined)?.trim();

    if (!mediaFile) {
      return res.status(400).json({ error: "No media file uploaded" });
    }

    const jobId = `trans_job_${Date.now()}`;
    transcribeJobs[jobId] = {
      id: jobId,
      status: "pending",
      progress: 10,
      message: "فایل با موفقیت بارگذاری شد. شروع آماده‌سازی پردازش..."
    };

    // Run the transcription background job
    runTranscribeBackground(jobId, mediaFile, srtFile, customApiKey);

    res.json({ jobId });
  } catch (err: any) {
    console.error("Upload handler error:", err);
    res.status(500).json({ error: err.message || "An error occurred during upload." });
  }
});

// Helper function to dynamically clean up old media/chunk files to avoid ENOSPC on Cloud Run memory filesystem
function cleanupOldFiles() {
  try {
    const now = Date.now();
    const fifteenMinutesAgo = now - 15 * 60 * 1000; // 15 minutes of preservation

    const cleanDir = (dirPath: string) => {
      if (!fs.existsSync(dirPath)) return;
      const files = fs.readdirSync(dirPath);
      for (const file of files) {
        const filePath = path.join(dirPath, file);
        if (file === "chunks" || file === "dubbing_project") continue;
        
        try {
          const stats = fs.statSync(filePath);
          if (stats.isFile() && stats.mtimeMs < fifteenMinutesAgo) {
            fs.unlinkSync(filePath);
            console.log(`[CLEANUP] Deleted old file: ${filePath}`);
          } else if (stats.isDirectory() && stats.mtimeMs < fifteenMinutesAgo) {
            fs.rmSync(filePath, { recursive: true, force: true });
            console.log(`[CLEANUP] Deleted old directory: ${filePath}`);
          }
        } catch (e) {
          console.warn(`[CLEANUP] Failed to process ${filePath}:`, e);
        }
      }
    };

    cleanDir(UPLOADS_DIR);
    cleanDir(OUTPUT_DIR);
    
    const chunksDir = path.join(UPLOADS_DIR, "chunks");
    if (fs.existsSync(chunksDir)) {
      const uploadFolders = fs.readdirSync(chunksDir);
      for (const folder of uploadFolders) {
        const folderPath = path.join(chunksDir, folder);
        try {
          const stats = fs.statSync(folderPath);
          if (stats.mtimeMs < fifteenMinutesAgo) {
            fs.rmSync(folderPath, { recursive: true, force: true });
            console.log(`[CLEANUP] Deleted old chunk folder: ${folderPath}`);
          }
        } catch (e) {
          console.warn(`[CLEANUP] Failed to clean chunk folder ${folderPath}:`, e);
        }
      }
    }
  } catch (err) {
    console.error("[CLEANUP] Error during automatic cleanup:", err);
  }
}

// Upload chunk endpoint for chunked file uploading (bypasses Cloud Run 32MB limit)
app.post("/api/upload-chunk", upload.single("chunk"), async (req: any, res: any) => {
  try {
    // Run automated disk space cleanup
    cleanupOldFiles();

    const { uploadId, chunkIndex, totalChunks, fileName } = req.body;
    const file = req.file;

    console.log(`[CHUNK UPLOAD RECEIVED] Upload ID: ${uploadId || "N/A"}, Index: ${chunkIndex || "N/A"}, Total: ${totalChunks || "N/A"}, FileName: ${fileName || "N/A"}, TempPath: ${file ? file.path : "N/A"}, Size: ${file ? file.size : 0} bytes`);

    if (!uploadId || chunkIndex === undefined || !file) {
      console.error(`[CHUNK UPLOAD ERROR] Missing parameters: uploadId=${uploadId}, chunkIndex=${chunkIndex}, file=${!!file}`);
      return res.status(400).json({ error: "Missing chunk upload parameters" });
    }

    // Create chunks temp directory inside uploads
    const chunkDir = path.join(UPLOADS_DIR, "chunks", uploadId);
    if (!fs.existsSync(chunkDir)) {
      fs.mkdirSync(chunkDir, { recursive: true });
    }

    // Move file to the chunk path with sequential name
    const chunkPath = path.join(chunkDir, `chunk_${chunkIndex}`);
    try {
      fs.renameSync(file.path, chunkPath);
    } catch (renameErr) {
      // Robust fallback for cross-device mounts/link errors (EXDEV) in Docker/Cloud Run
      try {
        fs.copyFileSync(file.path, chunkPath);
        fs.unlinkSync(file.path);
      } catch (fallbackErr: any) {
        console.error("Fallback file move failed:", fallbackErr);
        throw new Error(`Failed to save chunk: ${fallbackErr.message || fallbackErr}`);
      }
    }

    console.log(`[CHUNK UPLOAD SUCCESS] Saved chunk_${chunkIndex} to ${chunkPath}`);
    res.json({ success: true });
  } catch (err: any) {
    console.error("Error in upload-chunk endpoint:", err);
    res.status(500).json({ error: err.message || "Failed to upload chunk." });
  }
});

// Merge chunks endpoint to reconstruct files larger than 32MB on Cloud Run
app.post("/api/merge-chunks", async (req: any, res: any) => {
  try {
    // Run automated disk space cleanup
    cleanupOldFiles();

    const { uploadId, fileName, totalChunks, srtText } = req.body;
    console.log(`[MERGE CHUNKS STARTED] Upload ID: ${uploadId}, FileName: ${fileName}, Total Chunks: ${totalChunks}`);

    if (!uploadId || !fileName || totalChunks === undefined) {
      console.error(`[MERGE CHUNKS ERROR] Missing parameters: uploadId=${uploadId}, fileName=${fileName}, totalChunks=${totalChunks}`);
      return res.status(400).json({ error: "Missing merge parameters" });
    }

    const chunkDir = path.join(UPLOADS_DIR, "chunks", uploadId);
    if (!fs.existsSync(chunkDir)) {
      return res.status(400).json({ error: "آپلود به علت منقضی شدن یا خطا یافت نشد. لطفاً دوباره تلاش کنید." });
    }

    // Verify all chunks exist
    const chunksCount = parseInt(totalChunks, 10);
    for (let i = 0; i < chunksCount; i++) {
      const chunkPath = path.join(chunkDir, `chunk_${i}`);
      if (!fs.existsSync(chunkPath)) {
        return res.status(400).json({ error: `بخش شماره ${i + 1} از فایل آپلود نشده یا گم شده است. لطفاً دکمه تلاش مجدد را بزنید تا آپلود از همین‌جا ادامه یابد.` });
      }
    }

    // Determine target location inside uploads
    const ext = path.extname(fileName);
    const base = path.basename(fileName, ext).replace(/[^a-zA-Z0-9]/g, "_");
    const uniqueFileName = `${base}_${Date.now()}${ext}`;
    const destPath = path.join(UPLOADS_DIR, uniqueFileName);

    // Merge chunks sequentially
    const writeStream = fs.createWriteStream(destPath);
    for (let i = 0; i < chunksCount; i++) {
      const chunkPath = path.join(chunkDir, `chunk_${i}`);
      const chunkData = fs.readFileSync(chunkPath);
      writeStream.write(chunkData);
    }
    writeStream.end();

    // Await stream finish
    await new Promise<void>((resolve, reject) => {
      writeStream.on("finish", () => resolve());
      writeStream.on("error", (err) => reject(err));
    });

    // Clean up temporary chunks
    try {
      for (let i = 0; i < chunksCount; i++) {
        fs.unlinkSync(path.join(chunkDir, `chunk_${i}`));
      }
      fs.rmdirSync(chunkDir);
    } catch (cleanupErr) {
      console.warn("Temporary chunk clean-up warning:", cleanupErr);
    }

    // Save optional custom subtitles text
    let srtFile: { path: string } | undefined = undefined;
    if (srtText) {
      const srtFileName = `${uniqueFileName}.srt`;
      const srtFilePath = path.join(UPLOADS_DIR, srtFileName);
      fs.writeFileSync(srtFilePath, srtText, "utf-8");
      srtFile = { path: srtFilePath };
    }

    // Create transcription background job
    const jobId = `trans_job_${Date.now()}`;
    transcribeJobs[jobId] = {
      id: jobId,
      status: "pending",
      progress: 10,
      message: "فایل با موفقیت بارگذاری شد. شروع آماده‌سازی پردازش..."
    };

    const mediaFileObj = {
      path: destPath,
      filename: uniqueFileName,
      originalname: fileName
    };

    // Run transcribe background
    const customApiKey = (req.headers["x-gemini-api-key"] as string | undefined)?.trim() || (req.body?.apiKey as string | undefined)?.trim();
    runTranscribeBackground(jobId, mediaFileObj, srtFile, customApiKey);

    res.json({ jobId });
  } catch (err: any) {
    console.error("Error in merge-chunks endpoint:", err);
    res.status(500).json({ error: err.message || "Failed to merge and process chunks." });
  }
});

// Custom chunk-streamed download API (bypasses Cloud Run 32MB buffering limits)
app.get("/api/download-dubbed", (req: any, res: any) => {
  const fileName = req.query.file as string;
  if (!fileName) {
    return res.status(400).send("File name required");
  }
  // Sanitize file name to prevent directory traversal
  const safeName = path.basename(fileName);
  const filePath = path.join(OUTPUT_DIR, safeName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  const isDownload = req.query.download === "true";
  const headers: Record<string, string> = {
    "Content-Type": "video/mp4",
  };

  if (isDownload) {
    headers["Content-Disposition"] = `attachment; filename="${safeName}"`;
  }

  res.sendFile(filePath, { headers }, (err) => {
    if (err) {
      console.error("Error sending file via sendFile:", err);
      if (!res.headersSent) {
        res.status(500).send("Error downloading file");
      }
    }
  });
});

// Transcription job status polling endpoint
app.get("/api/transcribe-status/:jobId", (req: any, res: any) => {
  const job = transcribeJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Transcription job not found" });
  res.json(job);
});

// Translate SRT API (synchronous endpoint for backwards compatibility)
app.post("/api/translate-srt", async (req: any, res: any) => {
  const { segments, targetLanguage, translationTone = "auto", enableShortening = false } = req.body;
  const customApiKey = (req.headers["x-gemini-api-key"] as string | undefined)?.trim() || (req.body?.apiKey as string | undefined)?.trim();

  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: "No segments provided" });
  }
  if (!targetLanguage) {
    return res.status(400).json({ error: "No target language specified" });
  }

  try {
    const result = await translateAllSegmentsParallel(
      segments,
      targetLanguage,
      translationTone,
      enableShortening,
      undefined,
      customApiKey
    );

    res.json(result);
  } catch (err: any) {
    console.error("Translation error:", err);
    res.status(500).json({ error: err.message || "Failed to translate subtitles." });
  }
});

// Translation background runner job endpoint for real-time live logs
app.post("/api/start-translation-job", async (req: any, res: any) => {
  const { segments, targetLanguage, translationTone = "auto", enableShortening = false } = req.body;
  const customApiKey = (req.headers["x-gemini-api-key"] as string | undefined)?.trim() || (req.body?.apiKey as string | undefined)?.trim();

  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: "No segments provided" });
  }
  if (!targetLanguage) {
    return res.status(400).json({ error: "No target language specified" });
  }

  const jobId = `trans_job_${Date.now()}`;
  translationJobs[jobId] = {
    id: jobId,
    status: "pending",
    progress: 5,
    message: "در حال آماده‌سازی خط لوله ترجمه موازی...",
    logs: [`🌐 شروع کار ترجمه برای ${segments.length} دیالوگ به زبان ${targetLanguage}`]
  };

  // Run in background
  (async () => {
    const job = translationJobs[jobId];
    try {
      job.status = "processing";
      const result = await translateAllSegmentsParallel(
        segments,
        targetLanguage,
        translationTone,
        enableShortening,
        (msg, pct, logLine) => {
          job.message = msg;
          job.progress = pct;
          if (logLine) {
            addJobLog(job, logLine);
          }
        },
        customApiKey
      );
      job.status = "completed";
      job.progress = 100;
      job.message = "ترجمه با موفقیت به پایان رسید!";
      job.segments = result.segments;
      job.translatedSrtText = result.translatedSrtText;
      addJobLog(job, `🎉 ترجمه تمام سگمنت‌ها تکمیل شد.`);
    } catch (err: any) {
      console.error("Background translation job failed:", err);
      job.status = "failed";
      job.progress = 0;
      job.error = err.message || "خطا در ترجمه هوشمند دیالوگ‌ها.";
      job.message = `خطا: ${err.message || "ترجمه ناموفق بود."}`;
      addJobLog(job, `❌ خطا در ترجمه: ${err.message || "نامشخص"}`);
    }
  })();

  res.json({ jobId });
});

// Translation status polling endpoint
app.get("/api/translation-status/:jobId", (req: any, res: any) => {
  const job = translationJobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Translation job not found" });
  res.json(job);
});

// YouTube Import & Transcribe API
app.post("/api/youtube-import", async (req: any, res: any) => {
  const { url } = req.body;
  if (!url) {
    return res.status(400).json({ error: "آدرس یوتیوب وارد نشده است." });
  }

  const jobId = `trans_job_yt_${Date.now()}`;
  const customApiKey = (req.headers["x-gemini-api-key"] as string | undefined)?.trim();

  // Extract video ID
  const videoIdMatch = url.match(/(?:https?:\/\/)?(?:www\.)?(?:youtube\.com\/(?:[^\/\n\s]+\/\S+\/|(?:v|e(?:mbed)?)\/|\S*?[?&]v=)|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  const videoId = videoIdMatch ? videoIdMatch[1] : `yt_${Date.now()}`;
  const cleanUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const filename = `yt_${videoId}.mp4`;
  const destPath = path.join(UPLOADS_DIR, filename);

  // Initialize job status
  const job: TranscribeJob = {
    id: jobId,
    status: "processing",
    progress: 5,
    message: "در حال تحلیل لینک و دریافت اطلاعات ویدیو از یوتیوب...",
    logs: [`🎥 دریافت درخواست وارد کردن ویدیو یوتیوب: ${url}`],
  };
  transcribeJobs[jobId] = job;

  // Run import in background
  (async () => {
    try {
      addJobLog(job, `🔍 شناسه ویدیو: ${videoId}`);

      // 1. Fetch title via official oEmbed API
      let videoTitle = `یوتیوب - ${videoId}`;
      addJobLog(job, "🔍 در حال دریافت مشخصات ویدیو از یوتیوب...");
      try {
        const oembedRes = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(cleanUrl)}&format=json`, { signal: AbortSignal.timeout(4000) });
        if (oembedRes.ok) {
          const odata: any = await oembedRes.json();
          if (odata && odata.title) {
            videoTitle = odata.title;
          }
        }
      } catch (e: any) {
        console.warn("oEmbed title fetch skipped, using fallback title.");
      }

      addJobLog(job, `📌 عنوان ویدیو: "${videoTitle}"`);
      job.progress = 20;
      job.message = `در حال دانلود ویدیو: "${videoTitle}"...`;

      // 2. Download video file if not cached
      if (!fs.existsSync(destPath) || fs.statSync(destPath).size < 1000) {
        addJobLog(job, "📥 شروع دانلود فایل ویدیو با شبکه اختصاصی و چرخش پروکسی...");
        let downloaded = false;

        // Try primary video download with fast parallel proxy racing
        try {
          await execWithProxyRotation((proxyArg) =>
            `./yt-dlp ${proxyArg} --js-runtimes node -f "bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best/ba/b" --merge-output-format mp4 -o "${destPath}" --no-playlist "${cleanUrl}"`
          );
          if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
            downloaded = true;
            addJobLog(job, "✅ دانلود فایل اصلی ویدیو با موفقیت انجام شد.");
          }
        } catch (e: any) {
          console.warn("Primary video download failed, trying audio stream fallback...", e.message);
          addJobLog(job, "⚠️ دانلود نسخه کامل ویدیو با محدودیت مواجه شد. در حال تلاش برای دریافت ترک صوتی با کیفیت بالا...");
        }

        // Fallback: Audio-only stream download
        if (!downloaded) {
          try {
            await execWithProxyRotation((proxyArg) =>
              `./yt-dlp ${proxyArg} --js-runtimes node -f "ba/bestaudio/best" -o "${destPath}" --no-playlist "${cleanUrl}"`
            );
            if (fs.existsSync(destPath) && fs.statSync(destPath).size > 1000) {
              downloaded = true;
              addJobLog(job, "✅ فایل صوتی ویدیو با موفقیت دریافت و ذخیره شد.");
            }
          } catch (e: any) {
            console.error("Audio-only download failed:", e.message);
          }
        }

        if (!downloaded || !fs.existsSync(destPath) || fs.statSync(destPath).size < 1000) {
          throw new Error("دانلود ویدیو از یوتیوب ناموفق بود. امکان دریافت این ویدیو در حال حاضر وجود ندارد.");
        }
      } else {
        addJobLog(job, "⚡ فایل ویدیو از قبل موجود است.");
      }

      job.progress = 50;
      job.message = "در حال استخراج باند صوتی برای تبدیل به متن...";
      addJobLog(job, "🎧 استخراج فایل صوتی (MP3) جهت پردازش در هوش مصنوعی...");

      // 3. Extract audio for Gemini
      const audioPath = path.join(UPLOADS_DIR, `${filename}_extracted.mp3`);
      if (!fs.existsSync(audioPath) || fs.statSync(audioPath).size < 1000) {
        await execAsync(
          `"${ffmpegPath}" -y -i "${destPath}" -vn -acodec libmp3lame -ab 64k -ar 22050 -ac 1 "${audioPath}"`
        );
      }

      job.progress = 65;
      job.message = "در حال پردازش هوشمند و استخراج دیالوگ‌ها با هوش مصنوعی جمینای...";
      addJobLog(job, "🤖 شروع پیاده‌سازی هوشمند متن و زمان‌بندی با مدل Gemini...");

      // 4. Gemini Transcription
      const segments = await transcribeAudioWithGemini(audioPath, (msg, pct, logLine) => {
        job.message = msg;
        job.progress = pct;
        if (logLine) addJobLog(job, logLine);
      }, customApiKey);

      job.progress = 100;
      job.status = "completed";
      job.message = "استخراج زیرنویس و دیالوگ‌های ویدیو یوتیوب با موفقیت پایان یافت!";
      job.fileId = filename;
      job.fileName = videoTitle;
      job.fileType = "video";
      job.segments = segments;
      addJobLog(job, "🎉 فرآیند دریافت ویدیو و استخراج دیالوگ‌ها به پایان رسید.");
    } catch (err: any) {
      console.error("YouTube import job failed:", err);
      job.status = "failed";
      job.progress = 0;
      job.error = err.message || "خطا در دریافت ویدیو از یوتیوب.";
      job.message = `خطا: ${err.message || "دریافت ویدیو ناموفق بود."}`;
      addJobLog(job, `❌ خطا: ${err.message || "نامشخص"}`);
    }
  })();

  res.json({ jobId });
});

// Google Drive Import & Transcribe API
app.post("/api/drive-import", async (req: any, res: any) => {
  const { fileId, fileName, mimeType, accessToken } = req.body;
  const customApiKey = (req.headers["x-gemini-api-key"] as string | undefined)?.trim() || (req.body?.apiKey as string | undefined)?.trim();
  if (!fileId || !accessToken || !fileName) {
    return res.status(400).json({ error: "Missing required parameters (fileId, fileName, accessToken)" });
  }

  const jobId = `trans_job_drive_${Date.now()}`;

  try {
    console.log("Initializing Google Drive import job for file:", fileName, "ID:", fileId);

    // Save with unique name to avoid conflicts
    const fileExt = path.extname(fileName).toLowerCase() || (mimeType && mimeType.includes("audio") ? ".mp3" : ".mp4");
    const safeBaseName = path.basename(fileName, fileExt).replace(/[^a-zA-Z0-9_-]/g, "_");
    const uniqueId = `${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
    const localFileName = `drive_${safeBaseName}_${uniqueId}${fileExt}`;
    const destPath = path.join(UPLOADS_DIR, localFileName);

    // Create transcription background job
    transcribeJobs[jobId] = {
      id: jobId,
      status: "pending",
      progress: 5,
      message: "در حال اتصال به گوگل درایو برای شروع دانلود..."
    };

    // Run Drive Download & Transcription in the background
    (async () => {
      try {
        transcribeJobs[jobId].message = "در حال دانلود فایل از گوگل درایو به سرور (با سرعت بسیار بالا)...";
        transcribeJobs[jobId].progress = 15;

        // 1. Download file from Google Drive via v3 media API
        const driveRes = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
        });

        if (!driveRes.ok) {
          const errMsg = await driveRes.text();
          console.error("Google Drive API download error:", errMsg);
          throw new Error(`Google Drive API download failed: ${driveRes.statusText} (${driveRes.status})`);
        }

        const fileStream = fs.createWriteStream(destPath);
        await new Promise<void>((resolve, reject) => {
          if (!driveRes.body) return reject(new Error("No response body from Google Drive API"));
          const nodeStream = Readable.fromWeb(driveRes.body as any);
          nodeStream.pipe(fileStream);
          nodeStream.on("error", (err) => reject(err));
          fileStream.on("finish", () => resolve());
          fileStream.on("error", (err) => reject(err));
        });

        console.log("Successfully downloaded Google Drive file to:", destPath);
        transcribeJobs[jobId].message = "دانلود از گوگل درایو کامل شد. شروع فرآیند پردازش صوتی...";
        transcribeJobs[jobId].progress = 25;

        // 2. Delegate the remaining process to runTranscribeBackground
        await runTranscribeBackground(
          jobId,
          { path: destPath, filename: localFileName, originalname: fileName },
          undefined,
          customApiKey
        );
      } catch (err: any) {
        console.error("Background Google Drive import/transcribe failed:", err);
        transcribeJobs[jobId].status = "failed";
        transcribeJobs[jobId].progress = 0;
        transcribeJobs[jobId].error = err.message || "خطا در حین دانلود یا پردازش فایل از گوگل درایو.";
        transcribeJobs[jobId].message = `خطا: ${err.message || "آپلود گوگل درایو ناموفق بود."}`;
      }
    })();

    // Return jobId instantly to the client to avoid timeouts
    res.json({ jobId });
  } catch (err: any) {
    console.error("Google Drive job initialization failed:", err);
    res.status(500).json({ error: err.message || "An error occurred during Google Drive import initialization." });
  }
});

// Dubbing request handler
app.post("/api/dub", async (req: any, res: any) => {
  const {
    fileId,
    segments,
    voice = "zephyr",
    targetLanguage = "fa",
    podcastMode = false,
    keepOriginal = false,
    originalVolume = 0.1,
    allowStretch = false,
    maxStretch = 5,
    balanceSpeed = false,
    maxSpeedFactor = 1.6,
  } = req.body;

  const customApiKey = (req.headers["x-gemini-api-key"] as string | undefined)?.trim() || (req.body?.apiKey as string | undefined)?.trim() || (req.body?.customApiKey as string | undefined)?.trim();

  if (!fileId) return res.status(400).json({ error: "Missing fileId" });
  if (!segments || !Array.isArray(segments) || segments.length === 0) {
    return res.status(400).json({ error: "Missing or empty segments list" });
  }

  const jobId = `job_${Date.now()}`;
  jobs[jobId] = {
    id: jobId,
    status: "pending",
    progress: 0,
    message: "Initializing dubbing project...",
  };

  // Start background process
  dubBackground(jobId, {
    fileId,
    segments,
    voice,
    targetLanguage,
    podcastMode,
    keepOriginal,
    originalVolume,
    allowStretch,
    maxStretch,
    balanceSpeed,
    maxSpeedFactor,
    customApiKey,
  });

  res.json({ jobId });
});

// Dubbing job status endpoint
app.get("/api/dub-status/:jobId", (req: any, res: any) => {
  const job = jobs[req.params.jobId];
  if (!job) return res.status(404).json({ error: "Job not found" });
  res.json(job);
});

// Google Drive save endpoint
app.post("/api/save-to-drive", async (req: any, res: any) => {
  const { file, accessToken } = req.body;
  if (!file || !accessToken) {
    return res.status(400).json({ error: "Missing file or accessToken" });
  }

  const filePath = path.join(OUTPUT_DIR, file);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File not found on server" });
  }

  try {
    const fileMetadata = {
      name: file,
      mimeType: file.endsWith(".mp4") ? "video/mp4" : "audio/mpeg",
    };
    const fileSize = fs.statSync(filePath).size;

    console.log(`[DRIVE UPLOAD] Initiating resumable session for ${file} (${fileSize} bytes)`);

    // 1. Initiate resumable upload session
    const initResponse = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json; charset=UTF-8",
        "X-Upload-Content-Type": fileMetadata.mimeType,
        "X-Upload-Content-Length": fileSize.toString(),
      },
      body: JSON.stringify(fileMetadata),
    });

    if (!initResponse.ok) {
      const errText = await initResponse.text();
      throw new Error(`Google Drive API session initiation failed: ${initResponse.status} ${errText}`);
    }

    const uploadUrl = initResponse.headers.get("location");
    if (!uploadUrl) {
      throw new Error("Failed to get resumable upload location URL from Google Drive response headers.");
    }

    console.log(`[DRIVE UPLOAD] Resumable session created. Streaming file bytes directly...`);

    // 2. PUT stream chunk to Google Drive
    const parsedUrl = url.parse(uploadUrl);
    const driveData = await new Promise<any>((resolve, reject) => {
      const driveReq = https.request({
        hostname: parsedUrl.hostname,
        path: parsedUrl.path,
        method: "PUT",
        headers: {
          "Content-Length": fileSize.toString(),
          "Content-Type": fileMetadata.mimeType,
        }
      }, (resStream) => {
        let resData = "";
        resStream.on("data", (chunk) => {
          resData += chunk;
        });
        resStream.on("end", () => {
          if (resStream.statusCode && resStream.statusCode >= 200 && resStream.statusCode < 300) {
            try {
              const parsed = JSON.parse(resData);
              resolve(parsed);
            } catch (e) {
              resolve({ success: true });
            }
          } else {
            reject(new Error(`Upload chunk streaming failed with status code ${resStream.statusCode}: ${resData}`));
          }
        });
      });

      driveReq.on("error", (e) => {
        reject(e);
      });

      const fileStream = fs.createReadStream(filePath);
      fileStream.on("error", (err) => {
        reject(err);
      });
      fileStream.pipe(driveReq);
    });

    console.log(`[DRIVE UPLOAD] Save to Drive complete. File ID: ${driveData.id}`);
    res.json({ success: true, fileId: driveData.id });
  } catch (err: any) {
    console.error("Error saving to Google Drive:", err);
    res.status(500).json({ error: err.message || "Failed to save file to Google Drive" });
  }
});

// Live TTS Helper using gemini-3.1-flash-live-preview
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
    model: 'gemini-3.1-flash-live-preview',
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

// Robust Retry Wrapper for Live TTS
async function generateSpeechWithLiveAPI(
  text: string,
  voiceName: string,
  outputPath: string,
  targetLanguage?: string,
  customApiKey?: string
): Promise<number> {
  const attempts = 3;
  let lastError: any = null;

  for (let i = 0; i < attempts; i++) {
    try {
      if (i > 0) {
        console.log(`Retrying speech generation for text "${text.slice(0, 35)}..." (Attempt ${i + 1}/${attempts})...`);
      }
      return await generateSpeechWithLiveAPIInternal(text, voiceName, outputPath, targetLanguage, customApiKey);
    } catch (err: any) {
      console.warn(`Live API attempt ${i + 1} failed:`, err.message || err);
      lastError = err;
      if (i < attempts - 1) {
        // Exponential backoff
        await new Promise((resolve) => setTimeout(resolve, 800 * (i + 1)));
      }
    }
  }
  throw lastError || new Error("Failed after maximum retries");
}

// Background dubbing logic
async function dubBackground(jobId: string, params: any) {
  const job = jobs[jobId];
  const {
    fileId,
    segments,
    voice,
    targetLanguage = "fa",
    podcastMode,
    keepOriginal,
    originalVolume,
    allowStretch,
    maxStretch,
    balanceSpeed,
    maxSpeedFactor,
    customApiKey,
  } = params;

  const jobDir = path.join(PROJECT_DIR, jobId);
  const rawSegmentsDir = path.join(jobDir, "raw_segments");
  const adjSegmentsDir = path.join(jobDir, "adj_segments");

  try {
    fs.mkdirSync(jobDir, { recursive: true });
    fs.mkdirSync(rawSegmentsDir, { recursive: true });
    fs.mkdirSync(adjSegmentsDir, { recursive: true });

    const sourceFile = path.join(UPLOADS_DIR, fileId);
    if (!fs.existsSync(sourceFile)) {
      throw new Error("Source file not found on server.");
    }

    job.status = "processing";
    job.progress = 5;
    job.message = "آماده‌سازی خط تولید دوبله صوتی...";
    addJobLog(job, `🎙️ شروع فرآیند دوبله: تعداد ${segments.length} سگمنت دیالوگ با صدای ${voice} و زبان مقصد ${targetLanguage}`);

    const n = segments.length;
    const rawPaths: string[] = [];
    const naturalMs: number[] = [];
    const windowsMs: number[] = [];

    // Step 1: Generate speech for each segment using Live Translate API or fallback TTS
    for (let i = 0; i < n; i++) {
      const seg = segments[i];
      const segmentText = seg.text.trim();

      job.progress = Math.round(5 + (i / n) * 55);
      job.message = `در حال تولید صدای دوبله برای سگمنت ${i + 1} از ${n}...`;

      const startMs = parseTimeToMs(seg.startTime);
      const endMs = parseTimeToMs(seg.endTime);
      let windowMs = endMs - startMs;

      // Handle window between current and next segment
      if (i < n - 1) {
        const nextStartMs = parseTimeToMs(segments[i + 1].startTime);
        windowMs = Math.max(windowMs, nextStartMs - startMs);
      }
      windowsMs.push(windowMs);

      const rawPath = path.join(rawSegmentsDir, `raw_${i + 1}.wav`);
      rawPaths.push(rawPath);

      if (!segmentText) {
        const durationSec = Math.max(0.1, windowMs / 1000.0);
        await execAsync(`"${ffmpegPath}" -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${durationSec} "${rawPath}"`);
        naturalMs.push(windowMs);
        addJobLog(job, `[سگمنت ${i + 1}/${n}] ⏸️ ایجاد سکوت زمانی (${windowMs} میلی‌ثانیه) به دلیل خالی بودن متن.`);
        continue;
      }

      let voiceGenerated = false;
      const voiceName = voice.charAt(0).toUpperCase() + voice.slice(1).toLowerCase();

      // Try calling Gemini Live API for high-quality TTS on the subtitle text
      try {
        console.log(`Generating speech for segment ${i + 1}/${n} using Live API...`);
        addJobLog(job, `[سگمنت ${i + 1}/${n}] 🗣️ تولید صوت هوشمند با مدل gemini-3.1-flash-live-preview (صدای: ${voiceName}) | متن: "${segmentText.slice(0, 30)}..."`);
        const durationMs = await generateSpeechWithLiveAPI(
          segmentText,
          voiceName,
          rawPath,
          targetLanguage,
          customApiKey
        );
        naturalMs.push(durationMs);
        voiceGenerated = true;
        addJobLog(job, `[سگمنت ${i + 1}/${n}] ✅ تولید صوت موفق (${(durationMs / 1000).toFixed(2)} ثانیه)`);
        console.log(`Segment ${i + 1} dubbed successfully with Live API. Duration: ${durationMs}ms`);
      } catch (err: any) {
        console.warn(`Live API speech generation failed for segment ${i + 1}, falling back to standard TTS...`, err.message || err);
        addJobLog(job, `[سگمنت ${i + 1}/${n}] ⚠️ عدم دسترسی به Live API، سوییچ به مدل صوتی جایگزین gemini-3.1-flash-tts-preview...`);
      }

      // Fallback: use standard gemini-3.1-flash-tts-preview on translated text
      if (!voiceGenerated) {
        try {
          console.log(`Using fallback TTS for segment ${i + 1}/${n}...`);
          let fallbackSystemInstruction = "You are a professional text-to-speech engine. Your ONLY job is to speak the user's input text word for word, with natural pronunciation and professional cadence.";
          if (targetLanguage === "fa" || targetLanguage?.toLowerCase().startsWith("fa")) {
            fallbackSystemInstruction += " Since the target language is Persian (Farsi), you MUST speak in a standard Tehrani accent (لهجه معیار تهرانی) as used in Tehran, Iran. Avoid any Afghan (Dari) or Tajik pronunciations, vocabulary, or accents completely. The voice must sound exactly like a native speaker from Tehran, Iran.";
          }

          const fallbackAi = getGeminiAiClient(customApiKey);
          const response = await fallbackAi.models.generateContent({
            model: "gemini-3.1-flash-tts-preview",
            contents: [{ parts: [{ text: `Say: ${segmentText}` }] }],
            config: {
              systemInstruction: fallbackSystemInstruction,
              responseModalities: ["AUDIO"],
              speechConfig: {
                voiceConfig: {
                  prebuiltVoiceConfig: { voiceName },
                },
              },
            },
          });

          const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
          if (base64Audio) {
            const buffer = Buffer.from(base64Audio, "base64");
            const tempRawPath = rawPath + ".raw";
            fs.writeFileSync(tempRawPath, buffer);

            await execAsync(`"${ffmpegPath}" -y -f s16le -ar 24000 -ac 1 -i "${tempRawPath}" -acodec pcm_s16le "${rawPath}"`);
            fs.unlinkSync(tempRawPath);

            const durationSec = await getAudioDuration(rawPath);
            naturalMs.push(Math.round(durationSec * 1000));
            voiceGenerated = true;
            addJobLog(job, `[سگمنت ${i + 1}/${n}] ✅ صوت با موفقیت توسط gemini-3.1-flash-tts-preview ایجاد شد (${durationSec.toFixed(2)} ثانیه)`);
          } else {
            throw new Error("No audio content returned from TTS service");
          }
        } catch (err: any) {
          console.error(`TTS fallback failed for segment ${i + 1}:`, err.message || err);
          // Ultimate fallback: generate silent spacer
          const durationSec = Math.max(0.1, windowMs / 1000.0);
          await execAsync(`"${ffmpegPath}" -y -f lavfi -i anullsrc=r=24000:cl=mono -t ${durationSec} "${rawPath}"`);
          naturalMs.push(windowMs);
          addJobLog(job, `[سگمنت ${i + 1}/${n}] ⚠️ خطا در ایجاد صوت، جایگذاری سکوت متناظر.`);
        }
      }
    }

    job.progress = 65;
    job.message = "محاسبه سرعت تطبیقی و سینک زمانی لب‌زنی...";
    addJobLog(job, `⚙️ محاسبه سرعت تطبیقی دیالوگ‌ها و تنظیم پنجره‌های زمانی (Time Stretching)...`);

    // Step 2: Time Stretches and Speed balancing
    let stretchFactor = 1.0;
    const idxBorrowable = n > 1 ? Array.from({ length: n - 1 }, (_, k) => k) : [];

    let totalNatural = 0;
    let totalWindow = 0;
    for (const idx of idxBorrowable) {
      totalNatural += naturalMs[idx];
      totalWindow += windowsMs[idx];
    }

    const ratioG = totalWindow > 0 ? totalNatural / totalWindow : 1.0;

    if (allowStretch && ratioG > 1.0) {
      const maxStretchValue = 1 + maxStretch / 100.0;
      stretchFactor = Math.min(ratioG, maxStretchValue);
      console.log(`Applying Timeline Stretch factor: ${stretchFactor}`);
      addJobLog(job, `⏱️ کشش هوشمند تایم‌لاین با ضریب ${stretchFactor.toFixed(3)} اعمال شد.`);
    }

    // Apply global stretch to windows
    const adjustedWindowsMs = windowsMs.map((w, i) =>
      idxBorrowable.includes(i) ? w * stretchFactor : w
    );
    const adjustedTotalWindow = totalWindow * stretchFactor;

    const ratioR = adjustedTotalWindow > 0 ? totalNatural / adjustedTotalWindow : 1.0;
    const baseFactor = balanceSpeed && ratioR > 1.0 ? Math.min(ratioR, 1.3) : 1.0;
    const hardCap = balanceSpeed ? maxSpeedFactor : 1.4;

    const finalPaths: string[] = [];

    for (let i = 0; i < n; i++) {
      const adjMs = naturalMs[i] / baseFactor;
      const localFactor = adjustedWindowsMs[i] > 0 ? adjMs / adjustedWindowsMs[i] : 1.0;
      const finalFactor = Math.max(1.0, Math.min(baseFactor * Math.max(1.0, localFactor), hardCap));

      const finalPath = path.join(adjSegmentsDir, `dub_${i + 1}.wav`);
      finalPaths.push(finalPath);

      const rawPath = rawPaths[i];

      if (finalFactor <= 1.01) {
        fs.copyFileSync(rawPath, finalPath);
      } else {
        // Adjust speed using FFmpeg rubberband tempo or built-in atempo filter
        await execAsync(`"${ffmpegPath}" -y -i "${rawPath}" -filter:a "atempo=${finalFactor.toFixed(3)}" "${finalPath}"`);
      }
    }

    job.progress = 80;
    job.message = "میکس حرفه‌ای صدا با موزیک پس‌زمینه و رندر نهایی...";
    addJobLog(job, `🎚️ در حال میکس ترک‌های صوتی و ادغام با ویدیو اصلی توسط FFmpeg...`);

    const outputFilename = `dubbed_${Date.now()}`;
    let finalOutputPath = "";
    let hasVideo = false;

    if (podcastMode) {
      // Concatenate files together sequentially
      const concatListFile = path.join(jobDir, "concat.txt");
      const concatContent = finalPaths.map((p) => `file '${p}'`).join("\n");
      fs.writeFileSync(concatListFile, concatContent);

      finalOutputPath = path.join(OUTPUT_DIR, `${outputFilename}.mp3`);
      await execAsync(`"${ffmpegPath}" -y -f concat -safe 0 -i "${concatListFile}" -c:a libmp3lame -ab 192k "${finalOutputPath}"`);
      addJobLog(job, `🎧 پادکست صوتی با فرمت MP3 و کیفیت بالا ایجاد شد.`);
    } else {
      // Video/Audio overlay alignment using precise startMs delays
      hasVideo = await hasVideoStream(sourceFile);
      const hasAudio = await hasAudioStream(sourceFile);
      const outputExt = hasVideo ? ".mp4" : ".mp3";
      finalOutputPath = path.join(OUTPUT_DIR, `${outputFilename}${outputExt}`);
      const finalAudioOutputPath = hasVideo ? path.join(OUTPUT_DIR, `${outputFilename}.mp3`) : "";

      const origTempo = stretchFactor > 1 ? 1 / stretchFactor : 1.0;
      const filterParts: string[] = [];
      const inputArgs: string[] = ["-i", `"${sourceFile}"`];
      const validSegs: number[] = [];

      // Determine if we should keep and mix the original audio track
      const mixWithOriginal = keepOriginal && hasAudio;

      if (mixWithOriginal) {
        if (stretchFactor > 1.0) {
          filterParts.push(`[0:a]volume=${originalVolume},atempo=${origTempo.toFixed(3)}[orig]`);
        } else {
          filterParts.push(`[0:a]volume=${originalVolume}[orig]`);
        }
      }

      for (let i = 0; i < n; i++) {
        const segPath = finalPaths[i];
        if (fs.existsSync(segPath)) {
          const originalStartMs = parseTimeToMs(segments[i].startTime);
          const startMs = Math.round(originalStartMs * stretchFactor);

          // Use ':all=1' to delay mono streams safely
          filterParts.push(`[${validSegs.length + 1}:a]adelay=${startMs}:all=1[a${i + 1}]`);
          inputArgs.push("-i", `"${segPath}"`);
          validSegs.push(i + 1);
        }
      }

      if (validSegs.length > 0) {
        if (mixWithOriginal) {
          const mixInputs = "[orig]" + validSegs.map((v) => `[a${v}]`).join("");
          filterParts.push(`${mixInputs}amix=inputs=${validSegs.length + 1}:normalize=0[aout]`);
        } else {
          const mixInputs = validSegs.map((v) => `[a${v}]`).join("");
          if (validSegs.length === 1) {
            filterParts.push(`[a${validSegs[0]}]anull[aout]`);
          } else {
            filterParts.push(`${mixInputs}amix=inputs=${validSegs.length}:normalize=0[aout]`);
          }
        }

        // Video track mapping & stretching
        const videoMap: string[] = [];
        let vcodec = "copy";

        if (hasVideo) {
          if (stretchFactor > 1.0) {
            filterParts.push(`[0:v]setpts=${stretchFactor.toFixed(3)}*PTS[vout]`);
            videoMap.push("-map", "[vout]");
            vcodec = "libx264"; // Transcoding required to stretch video
          } else {
            videoMap.push("-map", "0:v");
            vcodec = "libx264"; // Transcode using libx264 to apply size compression
          }
        }

        const filterComplex = filterParts.join(";");

        const cmd = `"${ffmpegPath}" -y ${inputArgs.join(" ")} -filter_complex "${filterComplex}" ${videoMap.join(" ")} -map "[aout]" ${
          hasVideo ? `-c:v ${vcodec} -preset superfast -crf 26 -c:a aac` : "-c:a libmp3lame -ab 192k"
        } "${finalOutputPath}"`;

        console.log("Running ffmpeg merge command:\n", cmd);
        await execAsync(cmd);

        if (hasVideo && finalAudioOutputPath) {
          const audioCmd = `"${ffmpegPath}" -y -i "${finalOutputPath}" -vn -acodec libmp3lame -ab 128k "${finalAudioOutputPath}"`;
          console.log("Extracting dubbed audio to MP3 file:\n", audioCmd);
          try {
            await execAsync(audioCmd);
          } catch (audioErr) {
            console.error("Failed to extract MP3 from dubbed video:", audioErr);
          }
        }
      } else {
        throw new Error("No dubbed segments generated successfully.");
      }
    }

    job.progress = 100;
    job.status = "completed";
    job.message = "ویدیو با موفقیت دوبله و آماده دانلود شد!";
    job.resultUrl = `/api/download-dubbed?file=${path.basename(finalOutputPath)}`;
    if (hasVideo && fs.existsSync(path.join(OUTPUT_DIR, `${outputFilename}.mp3`))) {
      job.audioResultUrl = `/api/download-dubbed?file=${outputFilename}.mp3`;
    }
    addJobLog(job, `✨ فایل نهایی با موفقیت تولید شد.`);

    // Clean up job raw files to save disk space
    try {
      fs.rmSync(rawSegmentsDir, { recursive: true, force: true });
      fs.rmSync(adjSegmentsDir, { recursive: true, force: true });
    } catch (_) {}
  } catch (err: any) {
    console.error("Dubbing job failed:", err);
    job.status = "failed";
    job.message = "خطا در حین میکس و کامپایل ویدیو.";
    job.error = err.message || "An error occurred during mixing/compilation.";
    addJobLog(job, `❌ خطا در دوبله: ${err.message || "نامشخص"}`);
  }
}

// Vite and static production assets pipeline setup
async function startServer() {
  // API endpoints FIRST (defined above)

  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
    app.use("*", async (req, res, next) => {
      if (req.originalUrl.startsWith("/api")) {
        return next();
      }
      try {
        const indexPath = path.join(process.cwd(), "index.html");
        if (fs.existsSync(indexPath)) {
          let template = fs.readFileSync(indexPath, "utf-8");
          template = await vite.transformIndexHtml(req.originalUrl, template);
          res.status(200).set({ "Content-Type": "text/html" }).end(template);
        } else {
          next();
        }
      } catch (e) {
        vite.ssrFixStacktrace(e as Error);
        next(e);
      }
    });
  } else {
    const distPath = path.join(process.cwd(), "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => {
        res.sendFile(path.join(distPath, "index.html"));
      });
    }
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server listening on host 0.0.0.0, port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
