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

// Locate yt-dlp binary across environments (Colab global PATH, /usr/local/bin, or local)
function getYtDlpBin(): string {
  if (fs.existsSync("/usr/local/bin/yt-dlp")) return "/usr/local/bin/yt-dlp";
  if (fs.existsSync("/usr/bin/yt-dlp")) return "/usr/bin/yt-dlp";
  if (fs.existsSync("./yt-dlp")) return "./yt-dlp";
  return "yt-dlp";
}

// Execute yt-dlp command using direct fast attempt first, then proxy racing fallback
async function execWithProxyRotation(
  cmdBuilder: (proxyArg: string, ytBin: string) => string,
  maxAttempts = 30
): Promise<{ stdout: string; stderr: string }> {
  const ytBin = getYtDlpBin();
  const ytArgs = `--no-warnings --no-check-certificates --geo-bypass --extractor-args "youtube:player_client=android,mweb,web_creator,ios"`;

  // 1. Direct fast attempt (Android client bypasses YouTube bot detection reliably in Colab)
  try {
    const cmd = cmdBuilder(ytArgs, ytBin);
    console.log(`Executing direct yt-dlp command: ${cmd}`);
    const res = await execAsync(cmd, { timeout: 60000 });
    return res;
  } catch (directErr: any) {
    console.warn("Direct yt-dlp attempt failed, proceeding to proxy fallback...", directErr.message);
  }

  // 2. Try cached working proxy if available
  if (cachedProxy) {
    try {
      console.log(`Trying cached working proxy: ${cachedProxy}`);
      const cmd = cmdBuilder(`--proxy "${cachedProxy}" --socket-timeout 8 ${ytArgs}`, ytBin);
      const res = await execAsync(cmd, { timeout: 45000 });
      return res;
    } catch (err: any) {
      console.warn(`Cached proxy ${cachedProxy} failed. Resetting proxy cache.`);
      cachedProxy = null;
    }
  }

  // 3. Fetch fresh public proxy list
  const proxies = await fetchProxiesList();
  if (proxies.length > 0) {
    const shuffled = proxies.sort(() => 0.5 - Math.random()).slice(0, maxAttempts);
    console.log(`Fetched ${proxies.length} proxies. Running parallel proxy racing on ${shuffled.length} candidates...`);

    const BATCH_SIZE = 8;
    for (let i = 0; i < shuffled.length; i += BATCH_SIZE) {
      const batch = shuffled.slice(i, i + BATCH_SIZE);
      try {
        const winner = await Promise.any(
          batch.map(async (proxy) => {
            const cmd = cmdBuilder(`--proxy "${proxy}" --socket-timeout 8 ${ytArgs}`, ytBin);
            const res = await execAsync(cmd, { timeout: 25000 });
            cachedProxy = proxy;
            console.log(`Successfully found working proxy: ${proxy}`);
            return res;
          })
        );
        return winner;
      } catch (err: any) {}
    }
  }

  // 4. Final fallback attempt with tv_embedded client
  try {
    const fallbackArgs = `--no-warnings --no-check-certificates --geo-bypass --extractor-args "youtube:player_client=tv_embedded,web"`;
    const cmd = cmdBuilder(fallbackArgs, ytBin);
    return await execAsync(cmd, { timeout: 60000 });
  } catch (err: any) {
    throw new Error("دانلود ویدیو از یوتیوب امکان‌پذیر نشد. لطفاً از اتصال اینترنت یا در دسترس بودن ویدیو اطمینان حاصل کنید.");
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
    httpOptions: { headers: { "User-Agent": "aistudio-build" } },
  });
}

// Queued Rate Limiter to strictly enforce RPM (Requests Per Minute) limits
class RateLimiter {
  private lastCallTime = 0;
  private minIntervalMs: number;
  private queue: Array<() => void> = [];
  private isProcessing = false;

  constructor(rpm: number) {
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

const transcribeRateLimiter = new RateLimiter(5);
const translationRateLimiter = new RateLimiter(15);
let transcribeModelRotationIndex = 0;

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
      if (startMatch) currentStart = parseFloat(startMatch[1]);
      const endMatch = line.match(/silence_end:\s*([0-9.]+)/);
      if (endMatch && currentStart !== null) {
        const end = parseFloat(endMatch[1]);
        silences.push({ start: currentStart, end, mid: (currentStart + end) / 2 });
        currentStart = null;
      }
    }
    return silences;
  } catch (err) {
    console.warn("Silence detection failed or returned empty, falling back to clean splitting:", err);
    return [];
  }
}

async function splitAudioAtSilencePoints(audioPath: string, totalDurationMs: number): Promise<Array<{ path: string; startMs: number; endMs: number }>> {
  const CHUNK_TARGET_MS = 10 * 60 * 1000;
  if (totalDurationMs <= CHUNK_TARGET_MS + 30000) {
    return [{ path: audioPath, startMs: 0, endMs: totalDurationMs }];
  }

  const silences = await detectAudioSilences(audioPath, 0.4, -30);
  const chunks: Array<{ path: string; startMs: number; endMs: number }> = [];
  let currentStartMs = 0;
  let chunkIndex = 1;

  while (currentStartMs < totalDurationMs) {
    const remainingMs = totalDurationMs - currentStartMs;
    if (remainingMs <= CHUNK_TARGET_MS + 45000) {
      const chunkFile = path.join(path.dirname(audioPath), `chunk_${Date.now()}_${chunkIndex}.mp3`);
      const startSec = (currentStartMs / 1000).toFixed(3);
      const durationSec = (remainingMs / 1000).toFixed(3);
      await execAsync(`"${ffmpegPath}" -y -ss ${startSec} -i "${audioPath}" -t ${durationSec} -acodec copy "${chunkFile}"`);
      chunks.push({ path: chunkFile, startMs: currentStartMs, endMs: totalDurationMs });
      break;
    }

    const targetCutMs = currentStartMs + CHUNK_TARGET_MS;
    const targetCutSec = targetCutMs / 1000;
    const searchMinSec = (currentStartMs + 8.5 * 60 * 1000) / 1000;
    const searchMaxSec = (currentStartMs + 11.5 * 60 * 1000) / 1000;
    const candidates = silences.filter(s => s.mid >= searchMinSec && s.mid <= searchMaxSec);
    let bestCutSec = targetCutSec;
    if (candidates.length > 0) {
      candidates.sort((a, b) => Math.abs(a.mid - targetCutSec) - Math.abs(b.mid - targetCutSec));
      bestCutSec = candidates[0].mid;
    }

    const cutEndMs = Math.round(bestCutSec * 1000);
    const chunkDurationMs = cutEndMs - currentStartMs;
    const chunkFile = path.join(path.dirname(audioPath), `chunk_${Date.now()}_${chunkIndex}.mp3`);
    const startSec = (currentStartMs / 1000).toFixed(3);
    const durationSec = (chunkDurationMs / 1000).toFixed(3);
    await execAsync(`"${ffmpegPath}" -y -ss ${startSec} -i "${audioPath}" -t ${durationSec} -acodec copy "${chunkFile}"`);
    chunks.push({ path: chunkFile, startMs: currentStartMs, endMs: cutEndMs });
    currentStartMs = cutEndMs;
    chunkIndex++;
  }

  return chunks;
}

async function transcribeSingleAudioSlice(
  audioBase64: string,
  mimeType: string = "audio/mp3",
  onLog?: (text: string) => void,
  customApiKey?: string
): Promise<{ text: string; modelUsed: string }> {
  const aiClient = getGeminiAiClient(customApiKey);
  const audioPart = { inlineData: { data: audioBase64, mimeType } };
  const textPart = {
    text: "Analyze this audio file and transcribe all the spoken text into standard SubRip Subtitle (SRT) format. CRITICAL: You MUST break the transcribed text into short, readable, individual subtitle segments with highly accurate start and end timestamps (HH:MM:SS,mmm)."
  };

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
    const retries = 3;
    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        if (onLog) onLog(`🤖 مدل فعال: ${model} | تنظیم صف هوشمند (سهمیه ۵ RPM)...`);
        await transcribeRateLimiter.acquire();
        const response = await aiClient.models.generateContent({ model, contents: [audioPart, textPart] });
        const text = response.text || "";
        if (text.trim()) return { text, modelUsed: model };
      } catch (error: any) {
        lastError = error;
        if (attempt < retries) await new Promise((resolve) => setTimeout(resolve, 3000));
      }
    }
  }

  throw lastError || new Error("استخراج زیرنویس توسط هوش مصنوعی با خطا مواجه شد.");
}

const app = express();
const PORT = process.env.PORT ? parseInt(process.env.PORT, 10) : 3000;
app.use(express.json({ limit: "1000mb" }));
app.use(express.urlencoded({ extended: true, limit: "1000mb" }));

const UPLOADS_DIR = path.join(process.cwd(), "uploads");
const OUTPUT_DIR = path.join(process.cwd(), "output");
const PROJECT_DIR = path.join(process.cwd(), "dubbing_project");

if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(PROJECT_DIR)) fs.mkdirSync(PROJECT_DIR, { recursive: true });

app.use("/uploads", express.static(UPLOADS_DIR));
app.use("/output", express.static(OUTPUT_DIR));

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname);
    const base = path.basename(file.originalname, ext).replace(/[^a-zA-Z0-9]/g, "_");
    cb(null, `${base}_${Date.now()}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: 1000 * 1024 * 1024 } });

interface SrtSegment { id: number; startTime: string; endTime: string; text: string; }
const jobs: Record<string, any> = {};

app.get("/api/health", (req, res) => {
  res.json({ status: "ok", time: new Date() });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({ server: { middlewareMode: true, allowedHosts: true }, appType: "spa" });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get("*", (req, res) => res.sendFile(path.join(distPath, "index.html")));
    }
  }
  app.listen(PORT, "0.0.0.0", () => console.log(`Server listening on port ${PORT}`));
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
  process.exit(1);
});
