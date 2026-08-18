/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as React from "react";
import { useState, useRef, useEffect, useCallback } from "react";
import {
  Upload,
  Video,
  Music,
  FileText,
  Volume2,
  Settings,
  Play,
  Pause,
  Download,
  Languages,
  RotateCcw,
  CheckCircle2,
  AlertCircle,
  Trash2,
  Plus,
  Clock,
  ArrowRight,
  ChevronDown,
  ChevronUp,
  Sliders,
  Sparkles,
  Loader2,
  Search,
  VolumeX,
  Youtube,
  Link2,
  Cloud,
  Folder,
  FolderOpen,
  HardDrive,
  CornerLeftUp,
  RefreshCw,
  FileVideo,
  FileAudio,
  LogOut,
  Globe,
  Terminal,
  Activity,
  Key,
  ExternalLink,
  X,
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import {
  SrtSegment,
  DubbingJob,
  DUBBING_VOICES,
  TARGET_LANGUAGES,
  VoiceName,
} from "./types";
import { initAuth, googleSignIn, logoutUser } from "./lib/firebase";
import { User } from "firebase/auth";
import { LiveLogViewer } from "./components/LiveLogViewer";

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

function calculateWpm(text: string, startTime: string, endTime: string): number {
  const cleanText = text.trim();
  if (!cleanText) return 0;
  const startMs = parseTimeToMs(startTime);
  const endMs = parseTimeToMs(endTime);
  const durationSec = (endMs - startMs) / 1000;
  if (durationSec <= 0) return 0;
  const wordCount = cleanText.split(/\s+/).length;
  return Math.round((wordCount / durationSec) * 60);
}

const getSpeedStatus = (wpm: number) => {
  if (wpm === 0) return null;
  if (wpm <= 110) {
    return {
      label: "آهسته و شمرده",
      color: "text-emerald-400 bg-emerald-950/40 border-emerald-800/30",
      barColor: "bg-emerald-500",
      percentage: Math.min(100, (wpm / 180) * 100)
    };
  }
  if (wpm <= 150) {
    return {
      label: "سرعت طبیعی و روان",
      color: "text-cyan-400 bg-cyan-950/40 border-cyan-800/30",
      barColor: "bg-cyan-500",
      percentage: Math.min(100, (wpm / 180) * 100)
    };
  }
  if (wpm <= 180) {
    return {
      label: "سریع و متراکم",
      color: "text-amber-400 bg-amber-950/40 border-amber-800/30",
      barColor: "bg-amber-500",
      percentage: Math.min(100, (wpm / 180) * 100)
    };
  }
  return {
    label: "بسیار سریع و فشرده ⚠️",
    color: "text-red-400 bg-red-950/40 border-red-800/30",
    barColor: "bg-red-500",
    percentage: Math.min(100, (wpm / 180) * 100)
  };
};

export default function App() {
  // Input Files & Upload States
  const [mediaFile, setMediaFile] = useState<File | null>(null);
  const [srtFile, setSrtFile] = useState<File | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [transcribeMessage, setTranscribeMessage] = useState("");

  // Chunked upload tracking for large files and robust retries
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [uploadedChunks, setUploadedChunks] = useState<number[]>([]);

  const handleSetMediaFile = (file: File | null) => {
    setMediaFile(file);
    setUploadId(null);
    setUploadedChunks([]);
    setUploadError(null);
  };

  // Translation Tone settings
  const [translationTone, setTranslationTone] = useState<"auto" | "formal" | "colloquial">("auto");
  // Smart shortening & speed warning options
  const [enableShortening, setEnableShortening] = useState(true);

  // Active Project State
  const [fileId, setFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string>("");
  const [fileType, setFileType] = useState<"video" | "audio">("video");
  const [segments, setSegments] = useState<SrtSegment[]>([]);
  const [searchQuery, setSearchQuery] = useState("");

  // Dubbing & Translation Configuration
  const [targetLanguage, setTargetLanguage] = useState("fa");
  const [selectedVoice, setSelectedVoice] = useState<VoiceName>("zephyr");
  const [isVoiceDropdownOpen, setIsVoiceDropdownOpen] = useState(false);
  const [voiceSearchQuery, setVoiceSearchQuery] = useState("");
  const [podcastMode, setPodcastMode] = useState(false);
  
  // Advanced Dubbing parameters
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [originalVolume, setOriginalVolume] = useState(0.2);
  const [allowStretch, setAllowStretch] = useState(false);
  const [maxStretch, setMaxStretch] = useState(5); // 5% stretch limit
  const [balanceSpeed, setBalanceSpeed] = useState(false);
  const [maxSpeedFactor, setMaxSpeedFactor] = useState(1.6);

  // Subtitle Translation state & logs
  const [isTranslating, setIsTranslating] = useState(false);
  const [translationProgress, setTranslationProgress] = useState(0);
  const [translationMessage, setTranslationMessage] = useState("");
  const [translationLogs, setTranslationLogs] = useState<string[]>([]);

  // Transcription & Extraction Live Logs
  const [transcribeLogs, setTranscribeLogs] = useState<string[]>([]);

  // Global Live Logs Modal Viewer
  const [showLiveLogsModal, setShowLiveLogsModal] = useState(false);

  // Rendering & Dubbing Job States
  const [activeJob, setActiveJob] = useState<DubbingJob | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);

  // Secure Media Blob Streaming States (fixes __cookie_check.html and player issues in iframes)
  const [mediaBlobUrl, setMediaBlobUrl] = useState<string | null>(null);
  const [isBlobLoading, setIsBlobLoading] = useState(false);
  const [blobLoadError, setBlobLoadError] = useState<string | null>(null);

  // Google Drive state & actions
  const [driveUser, setDriveUser] = useState<User | null>(null);
  const [driveToken, setDriveToken] = useState<string | null>(null);
  const [isDriveLoading, setIsDriveLoading] = useState(false);
  const [driveFiles, setDriveFiles] = useState<any[]>([]);
  const [driveSearchQuery, setDriveSearchQuery] = useState("");
  const [driveActiveTab, setDriveActiveTab] = useState<"local" | "drive" | "youtube">("local");
  const [youtubeUrl, setYoutubeUrl] = useState("");
  const [driveError, setDriveError] = useState<string | null>(null);

  // Colab Direct Google Drive Explorer State (No OAuth required)
  const [colabDriveMode, setColabDriveMode] = useState<"colab" | "oauth">("colab");
  const [colabDrivePath, setColabDrivePath] = useState<string>("");
  const [colabDriveFolders, setColabDriveFolders] = useState<Array<{ name: string; path: string }>>([]);
  const [colabDriveFiles, setColabDriveFiles] = useState<Array<{ name: string; path: string; size: number; sizeFormatted: string; isVideo: boolean; isAudio: boolean; ext: string }>>([]);
  const [colabDriveParent, setColabDriveParent] = useState<string | null>(null);
  const [colabAvailableRoots, setColabAvailableRoots] = useState<string[]>([]);
  const [isColabDriveMounted, setIsColabDriveMounted] = useState<boolean>(true);
  const [isColabDriveLoading, setIsColabDriveLoading] = useState<boolean>(false);
  const [colabDriveError, setColabDriveError] = useState<string | null>(null);
  const [colabCustomPathInput, setColabCustomPathInput] = useState<string>("");
  const [colabFileSearch, setColabFileSearch] = useState<string>("");

  // Google Drive saving state
  const [isSavingToDrive, setIsSavingToDrive] = useState<{[key: string]: boolean}>({});
  const [saveToDriveResult, setSaveToDriveResult] = useState<{[key: string]: string | null}>({});
  const [lastAutoSavedJobId, setLastAutoSavedJobId] = useState<string | null>(null);

  // Workspace sub-tabs for mobile (Settings vs Timeline)
  const [activeWorkspaceTab, setActiveWorkspaceTab] = useState<"settings" | "timeline">("settings");

  // Secure Audio Blob Streaming States
  const [audioBlobUrl, setAudioBlobUrl] = useState<string | null>(null);
  const [isAudioBlobLoading, setIsAudioBlobLoading] = useState(false);

  // User Custom Gemini API Key State
  const [customApiKey, setCustomApiKey] = useState<string>(() => {
    return sessionStorage.getItem("gemini_user_api_key") || "";
  });
  const [isApiKeyModalOpen, setIsApiKeyModalOpen] = useState(false);
  const [apiKeyInput, setApiKeyInput] = useState(customApiKey);

  const handleSaveApiKey = () => {
    const trimmed = apiKeyInput.trim();
    if (trimmed) {
      sessionStorage.setItem("gemini_user_api_key", trimmed);
      setCustomApiKey(trimmed);
    } else {
      sessionStorage.removeItem("gemini_user_api_key");
      setCustomApiKey("");
    }
    setIsApiKeyModalOpen(false);
  };

  const handleRemoveApiKey = () => {
    sessionStorage.removeItem("gemini_user_api_key");
    setCustomApiKey("");
    setApiKeyInput("");
  };

  const fetchDriveFiles = useCallback(async (token: string, search: string = "") => {
    setIsDriveLoading(true);
    setDriveError(null);
    try {
      let query = `(mimeType contains 'video/' or mimeType contains 'audio/' or mimeType = 'application/octet-stream' or name contains '.mp4' or name contains '.mp3' or name contains '.mkv' or name contains '.wav' or name contains '.avi' or name contains '.ogg' or name contains '.flac') and trashed = false`;
      if (search.trim()) {
        const safeSearch = search.replace(/'/g, "\\'");
        query += ` and name contains '${safeSearch}'`;
      }
      
      const response = await fetch(
        `https://www.googleapis.com/drive/v3/files?q=${encodeURIComponent(
          query
        )}&fields=files(id,name,mimeType,size)&pageSize=40&orderBy=modifiedTime desc`,
        {
          headers: {
            Authorization: `Bearer ${token}`,
          },
        }
      );

      if (!response.ok) {
        throw new Error(`Google API returned status ${response.status}`);
      }

      const data = await response.json();
      setDriveFiles(data.files || []);
    } catch (err: any) {
      console.error("Error listing Drive files:", err);
      setDriveError("عدم موفقیت در دریافت لیست فایل‌ها از گوگل درایو. ممکن است نیاز به ورود مجدد باشد.");
    } finally {
      setIsDriveLoading(false);
    }
  }, []);

  // Direct Colab / Server Google Drive Explorer Fetcher (No OAuth)
  const fetchColabDrive = useCallback(async (dirPath?: string) => {
    setIsColabDriveLoading(true);
    setColabDriveError(null);
    try {
      const queryParam = dirPath ? `?dirPath=${encodeURIComponent(dirPath)}` : "";
      const response = await fetch(`/api/colab-drive/list${queryParam}`);
      if (!response.ok) {
        throw new Error(`Server returned status ${response.status}`);
      }
      const data = await response.json();
      if (!data.success && data.error) {
        setColabDriveError(data.error);
      }
      setIsColabDriveMounted(data.isDriveMounted ?? true);
      setColabDrivePath(data.currentPath || dirPath || "");
      setColabCustomPathInput(data.currentPath || dirPath || "");
      setColabDriveParent(data.parentPath || null);
      setColabAvailableRoots(data.availableRoots || []);
      setColabDriveFolders(data.folders || []);
      setColabDriveFiles(data.files || []);
    } catch (err: any) {
      console.error("Error listing Colab drive files:", err);
      setColabDriveError(err.message || "خطا در دریافت لیست فایل‌ها از سرور/کولب.");
    } finally {
      setIsColabDriveLoading(false);
    }
  }, []);

  // Auto-fetch Colab drive when Drive tab is opened in Colab mode
  useEffect(() => {
    if (driveActiveTab === "drive" && colabDriveMode === "colab") {
      fetchColabDrive(colabDrivePath || undefined);
    }
  }, [driveActiveTab, colabDriveMode, fetchColabDrive]);

  // Colab Direct Import and Transcribe Handler
  const handleColabDriveImport = async (targetFilePath: string, targetFileName?: string) => {
    if (!targetFilePath.trim()) {
      setUploadError("لطفاً مسیر فایل مورد نظر در کولب یا گوگل درایو را مشخص کنید.");
      return;
    }

    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(5);
    setTranscribeMessage("در حال بارگذاری فایل انتخاب‌شده از کولب/درایو...");
    setTranscribeLogs([`📁 انتخاب فایل محلی: ${targetFilePath}`]);

    try {
      const response = await fetch("/api/colab-drive/import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gemini-api-key": customApiKey,
        },
        body: JSON.stringify({
          filePath: targetFilePath.trim(),
          fileName: targetFileName,
          apiKey: customApiKey,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || "خطا در فراخوانی فایل از کولب.");
      }

      const { jobId } = await response.json();
      if (!jobId) {
        throw new Error("شناسه فرآیند پردازش دریافت نشد.");
      }

      setUploadProgress(15);
      setTranscribeMessage("فایل روی سرور بارگذاری شد. شروع پردازش صوتی و استخراج دیالوگ‌ها...");

      let isCompleted = false;
      while (!isCompleted) {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const statusRes = await fetch(`/api/transcribe-status/${jobId}`);
        if (!statusRes.ok) {
          throw new Error("خطا در دریافت وضعیت فرآیند از سرور.");
        }

        const jobData = await statusRes.json();
        setUploadProgress(jobData.progress || 15);
        setTranscribeMessage(jobData.message || "در حال پردازش...");
        if (jobData.logs && Array.isArray(jobData.logs)) {
          setTranscribeLogs(jobData.logs);
        }

        if (jobData.status === "completed") {
          setFileId(jobData.fileId);
          setFileName(jobData.fileName);
          setFileType(jobData.fileType);

          const sanitizedSegments = (jobData.segments || []).map((seg: any, idx: number) => ({
            ...seg,
            id: idx + 1,
          }));
          setSegments(sanitizedSegments);
          setUploadProgress(100);
          isCompleted = true;
        } else if (jobData.status === "failed") {
          throw new Error(jobData.error || jobData.message || "عملیات با خطا مواجه شد.");
        }
      }
    } catch (err: any) {
      console.error("Colab Drive import error:", err);
      setUploadError(err.message || "خطایی در حین فراخوانی یا پردازش فایل رخ داد.");
    } finally {
      setIsUploading(false);
      setTranscribeMessage("");
    }
  };

  useEffect(() => {
    const unsubscribe = initAuth(
      (user, token) => {
        setDriveUser(user);
        setDriveToken(token);
        fetchDriveFiles(token);
      },
      () => {
        setDriveUser(null);
        setDriveToken(null);
      }
    );
    return () => unsubscribe();
  }, [fetchDriveFiles]);

  const handleDriveSignIn = async () => {
    setIsDriveLoading(true);
    setDriveError(null);
    try {
      const result = await googleSignIn();
      if (result) {
        setDriveUser(result.user);
        setDriveToken(result.accessToken);
        fetchDriveFiles(result.accessToken);
      }
    } catch (err: any) {
      console.error("Sign-in failed:", err);
      setDriveError(err.message || "ورود به حساب گوگل ناموفق بود.");
    } finally {
      setIsDriveLoading(false);
    }
  };

  const handleDriveSignOut = async () => {
    try {
      await logoutUser();
      setDriveUser(null);
      setDriveToken(null);
      setDriveFiles([]);
    } catch (err) {
      console.error("Sign-out failed:", err);
    }
  };

  const handleDriveImport = async (file: { id: string; name: string; mimeType: string }) => {
    if (!driveToken) return;
    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(5);
    setTranscribeMessage("در حال ایجاد درخواست وارد کردن فایل روی سرور...");

    try {
      const response = await fetch("/api/drive-import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gemini-api-key": customApiKey,
        },
        body: JSON.stringify({
          fileId: file.id,
          fileName: file.name,
          mimeType: file.mimeType,
          accessToken: driveToken,
          apiKey: customApiKey,
        }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || "خطا در شروع دریافت فایل روی سرور.");
      }

      const { jobId } = await response.json();
      if (!jobId) {
        throw new Error("شناسه فرآیند پردازش دریافت نشد.");
      }

      setUploadProgress(10);
      setTranscribeMessage("مرحله ۱ از ۲ (دانلود ابری): شروع دانلود فایل روی سرور...");
      setTranscribeLogs(["🌐 شروع درخواست وارد کردن فایل از گوگل درایو..."]);

      let isCompleted = false;
      while (!isCompleted) {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const statusRes = await fetch(`/api/transcribe-status/${jobId}`);
        if (!statusRes.ok) {
          throw new Error("خطا در دریافت وضعیت فرآیند از سرور.");
        }

        const jobData = await statusRes.json();
        setUploadProgress(jobData.progress || 10);
        setTranscribeMessage(jobData.message || "در حال پردازش...");
        if (jobData.logs && Array.isArray(jobData.logs)) {
          setTranscribeLogs(jobData.logs);
        }

        if (jobData.status === "completed") {
          setFileId(jobData.fileId);
          setFileName(jobData.fileName);
          setFileType(jobData.fileType);

          const sanitizedSegments = (jobData.segments || []).map((seg: any, idx: number) => ({
            ...seg,
            id: idx + 1,
          }));
          setSegments(sanitizedSegments);
          setUploadProgress(100);
          isCompleted = true;
        } else if (jobData.status === "failed") {
          throw new Error(jobData.error || jobData.message || "عملیات با خطا مواجه شد.");
        }
      }
    } catch (err: any) {
      console.error("Drive import error:", err);
      setUploadError(err.message || "خطایی در حین دریافت یا پردازش فایل رخ داد.");
    } finally {
      setIsUploading(false);
      setTranscribeMessage("");
    }
  };

  // YouTube Import and Transcribe Handler
  const handleYoutubeImport = async () => {
    if (!youtubeUrl.trim()) {
      setUploadError("لطفاً آدرس ویدیو یوتیوب را وارد کنید.");
      return;
    }

    setIsUploading(true);
    setUploadError(null);
    setUploadProgress(5);
    setTranscribeMessage("در حال فراخوانی سرور برای بررسی و دریافت ویدیو از یوتیوب...");
    setTranscribeLogs(["🚀 شروع پردازش لینک یوتیوب..."]);

    try {
      const response = await fetch("/api/youtube-import", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gemini-api-key": customApiKey,
        },
        body: JSON.stringify({ url: youtubeUrl.trim() }),
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        throw new Error(errData.error || "خطا در برقراری ارتباط با سرور برای دریافت یوتیوب.");
      }

      const { jobId } = await response.json();
      if (!jobId) {
        throw new Error("شناسه فرآیند پردازش دریافت نشد.");
      }

      setUploadProgress(10);
      setTranscribeMessage("در حال دانلود ویدیو از یوتیوب و استخراج متن با هوش مصنوعی...");

      let isCompleted = false;
      while (!isCompleted) {
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const statusRes = await fetch(`/api/transcribe-status/${jobId}`);
        if (!statusRes.ok) {
          throw new Error("خطا در دریافت وضعیت فرآیند از سرور.");
        }

        const jobData = await statusRes.json();
        setUploadProgress(jobData.progress || 10);
        setTranscribeMessage(jobData.message || "در حال دانلود و پردازش...");
        if (jobData.logs && Array.isArray(jobData.logs)) {
          setTranscribeLogs(jobData.logs);
        }

        if (jobData.status === "completed") {
          const res = jobData.result || {};
          setFileId(res.fileId || jobData.fileId);
          setFileName(res.fileName || jobData.fileName || "ویدیو یوتیوب");
          setFileType(res.fileType || jobData.fileType || "video");

          const rawSegments = res.segments || jobData.segments || [];
          const sanitizedSegments = rawSegments.map((seg: any, idx: number) => ({
            ...seg,
            id: idx + 1,
          }));
          setSegments(sanitizedSegments);
          setUploadProgress(100);
          isCompleted = true;
        } else if (jobData.status === "failed") {
          throw new Error(jobData.error || jobData.message || "دریافت ویدیو از یوتیوب با خطا مواجه شد.");
        }
      }
    } catch (err: any) {
      console.error("YouTube import error:", err);
      setUploadError(err.message || "خطا در دریافت ویدیو از یوتیوب.");
    } finally {
      setIsUploading(false);
      setTranscribeMessage("");
    }
  };

  // Fetch media file as Blob to bypass Cloud Run cookie challenge
  const fetchMediaBlob = useCallback(async (url: string) => {
    setIsBlobLoading(true);
    setBlobLoadError(null);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch dubbed media: ${res.statusText} (${res.status})`);
      }
      
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("html")) {
        throw new Error("Received security check page instead of media content. Please try clicking the 'Retry loading' button.");
      }
      
      const blob = await res.blob();
      const localUrl = URL.createObjectURL(blob);
      setMediaBlobUrl(localUrl);
    } catch (err: any) {
      console.error("Error loading media blob:", err);
      setBlobLoadError(err.message || "Failed to establish a secure media stream");
    } finally {
      setIsBlobLoading(false);
    }
  }, []);

  // Fetch audio file as Blob to bypass Cloud Run cookie challenge
  const fetchAudioBlob = useCallback(async (url: string) => {
    setIsAudioBlobLoading(true);
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`Failed to fetch dubbed audio: ${res.statusText}`);
      }
      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("html")) {
        throw new Error("Security challenge page returned");
      }
      const blob = await res.blob();
      const localUrl = URL.createObjectURL(blob);
      setAudioBlobUrl(localUrl);
    } catch (err) {
      console.error("Error loading audio blob:", err);
    } finally {
      setIsAudioBlobLoading(false);
    }
  }, []);

  // Extract file name from result download URL
  const getFileNameFromUrl = (url: string) => {
    const match = url.match(/[?&]file=([^&]+)/);
    return match ? match[1] : url.split("/").pop() || "";
  };

  // Upload finished file to Google Drive using backend endpoint and user's token
  const handleSaveToDrive = async (fileNameOnServer: string, targetKey: string) => {
    setSaveToDriveResult(prev => ({ ...prev, [targetKey]: null }));
    
    let currentToken = driveToken;
    let currentUser = driveUser;

    // If not logged in, trigger Google Sign-In first
    if (!currentToken) {
      try {
        const result = await googleSignIn();
        if (result) {
          currentToken = result.accessToken;
          currentUser = result.user;
          setDriveUser(result.user);
          setDriveToken(result.accessToken);
          fetchDriveFiles(result.accessToken);
        } else {
          return;
        }
      } catch (err: any) {
        setSaveToDriveResult(prev => ({ ...prev, [targetKey]: `ورود ناموفق بود: ${err.message}` }));
        return;
      }
    }

    if (!currentToken) return;

    setIsSavingToDrive(prev => ({ ...prev, [targetKey]: true }));
    try {
      const res = await fetch("/api/save-to-drive", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          file: fileNameOnServer,
          accessToken: currentToken
        })
      });

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("html")) {
        throw new Error("خطا در پاسخ سرور. لطفاً دوباره تلاش کنید.");
      }

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "خطا در ارتباط با سرور");
      }

      const data = await res.json();
      setSaveToDriveResult(prev => ({ ...prev, [targetKey]: `فایل با موفقیت در گوگل درایو شما ذخیره شد! ID فایل: ${data.fileId}` }));
    } catch (err: any) {
      console.error("Save to drive error:", err);
      setSaveToDriveResult(prev => ({ ...prev, [targetKey]: `خطا در ذخیره‌سازی: ${err.message}` }));
    } finally {
      setIsSavingToDrive(prev => ({ ...prev, [targetKey]: false }));
    }
  };

  const handleSaveToColabDrive = async (fileNameOnServer: string, targetKey: "main" | "audio") => {
    setIsSavingToDrive(prev => ({ ...prev, [targetKey]: true }));
    try {
      const res = await fetch("/api/colab-drive/save", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          file: fileNameOnServer
        })
      });

      if (!res.ok) {
        const errData = await res.json().catch(() => ({}));
        throw new Error(errData.error || "خطا در ارتباط با سرور");
      }

      const data = await res.json();
      if (!data.success) {
        throw new Error(data.error || "خطا در ذخیره فایل");
      }

      setSaveToDriveResult(prev => ({ ...prev, [targetKey]: `فایل با موفقیت در پوشه درایو ذخیره شد: ${data.savedPath}` }));
    } catch (err: any) {
      console.error("Colab drive save error:", err);
      setSaveToDriveResult(prev => ({ ...prev, [targetKey]: `خطا در ذخیره‌سازی در درایو کولب: ${err.message}` }));
    } finally {
      setIsSavingToDrive(prev => ({ ...prev, [targetKey]: false }));
    }
  };

  useEffect(() => {
    if (activeJob && activeJob.status === "completed") {
      if (activeJob.resultUrl) {
        const url = activeJob.resultUrl.startsWith("/output/")
          ? `/api/download-dubbed?file=${activeJob.resultUrl.replace("/output/", "")}`
          : activeJob.resultUrl;
        fetchMediaBlob(url);
      }
      if (activeJob.audioResultUrl) {
        const url = activeJob.audioResultUrl.startsWith("/output/")
          ? `/api/download-dubbed?file=${activeJob.audioResultUrl.replace("/output/", "")}`
          : activeJob.audioResultUrl;
        fetchAudioBlob(url);
      }

      // Automatically save to Google Drive if the user is logged in and we haven't autosaved this job yet
      if (driveToken && activeJob.id !== lastAutoSavedJobId) {
        setLastAutoSavedJobId(activeJob.id);
        if (activeJob.resultUrl) {
          handleSaveToDrive(getFileNameFromUrl(activeJob.resultUrl), "main");
        }
        if (activeJob.audioResultUrl) {
          handleSaveToDrive(getFileNameFromUrl(activeJob.audioResultUrl), "audio");
        }
      }
    } else {
      if (mediaBlobUrl) {
        URL.revokeObjectURL(mediaBlobUrl);
        setMediaBlobUrl(null);
      }
      if (audioBlobUrl) {
        URL.revokeObjectURL(audioBlobUrl);
        setAudioBlobUrl(null);
      }
    }
    
    return () => {
      if (mediaBlobUrl) {
        URL.revokeObjectURL(mediaBlobUrl);
      }
      if (audioBlobUrl) {
        URL.revokeObjectURL(audioBlobUrl);
      }
    };
  }, [
    activeJob?.status,
    activeJob?.id,
    activeJob?.resultUrl,
    activeJob?.audioResultUrl,
    driveToken,
    lastAutoSavedJobId,
    fetchMediaBlob,
    fetchAudioBlob
  ]);

  // References for drag-and-drop
  const fileInputRef = useRef<HTMLInputElement>(null);
  const srtInputRef = useRef<HTMLInputElement>(null);

  // Suppress and swallow benign WebSocket/Vite HMR errors inside React runtime
  useEffect(() => {
    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event.reason;
      const message = (reason && (reason.message || String(reason))) || "";
      if (
        message.includes("WebSocket") ||
        message.includes("websocket") ||
        message.includes("closed without opened") ||
        message.includes("WS")
      ) {
        console.warn("React layer intercepted and suppressed WebSocket rejection:", message);
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };

    const handleError = (event: ErrorEvent) => {
      const message = event.message || "";
      if (
        message.includes("WebSocket") ||
        message.includes("websocket") ||
        message.includes("closed without opened") ||
        message.includes("WS")
      ) {
        console.warn("React layer intercepted and suppressed WebSocket error:", message);
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("unhandledrejection", handleRejection, true);
    window.addEventListener("error", handleError, true);

    return () => {
      window.removeEventListener("unhandledrejection", handleRejection, true);
      window.removeEventListener("error", handleError, true);
    };
  }, []);

  // Check backend server connection on mount
  useEffect(() => {
    fetch("/api/health")
      .then((res) => res.json())
      .then((data) => {
        console.log("Backend healthy:", data);
      })
      .catch((err) => {
        console.error("Backend health check:", err);
      });
  }, []);

  // Poll for dubbing job status
  useEffect(() => {
    if (!activeJob || activeJob.status === "completed" || activeJob.status === "failed") {
      return;
    }

    const interval = setInterval(async () => {
      try {
        const res = await fetch(`/api/dub-status/${activeJob.id}`);
        if (!res.ok) throw new Error("Failed to check status");
        const data: DubbingJob = await res.json();
        
        setActiveJob(data);

        if (data.status === "completed" || data.status === "failed") {
          clearInterval(interval);
        }
      } catch (err) {
        console.error("Error polling job status:", err);
      }
    }, 1500);

    return () => clearInterval(interval);
  }, [activeJob]);

  // Handle Drag-and-Drop
  const [isDragging, setIsDragging] = useState(false);
  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };
  const handleDragLeave = () => {
    setIsDragging(false);
  };
  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      const file = e.dataTransfer.files[0];
      const ext = file.name.split(".").pop()?.toLowerCase();
      if (ext === "srt") {
        setSrtFile(file);
      } else {
        handleSetMediaFile(file);
      }
    }
  };

  // Upload and Transcribe flow with direct upload for small files and robust chunked upload for large files
  const handleUploadAndTranscribe = async () => {
    if (!mediaFile) return;

    setIsUploading(true);
    setUploadProgress(0);
    setUploadError(null);
    setTranscribeMessage("در حال آماده‌سازی برای بارگذاری فایل...");

    try {
      const MAX_DIRECT_UPLOAD_SIZE = 15 * 1024 * 1024; // 15MB (highly reliable direct atomic upload limit)
      let jobId: string | null = null;

      // Read SRT file content if available
      let srtText: string | undefined = undefined;
      if (srtFile) {
        setTranscribeMessage("در حال خواندن فایل زیرنویس...");
        srtText = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = (e) => resolve(e.target?.result as string || "");
          reader.onerror = (err) => reject(new Error("خطا در خواندن فایل زیرنویس"));
          reader.readAsText(srtFile);
        });
      }

      if (mediaFile.size <= MAX_DIRECT_UPLOAD_SIZE) {
        // --- DIRECT ATOMIC UPLOAD FLOW ---
        console.log(`[UPLOAD] Starting direct atomic upload of ${mediaFile.name} (${(mediaFile.size / 1024 / 1024).toFixed(2)} MB)`);
        
        jobId = await new Promise<string>((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open("POST", "/api/upload-and-transcribe");
          xhr.timeout = 180000; // 3 minutes timeout
          if (customApiKey) {
            xhr.setRequestHeader("x-gemini-api-key", customApiKey);
          }
          
          const formData = new FormData();
          formData.append("media", mediaFile);
          if (srtFile) {
            formData.append("srt", srtFile);
          }
          if (customApiKey) {
            formData.append("apiKey", customApiKey);
          }
          
          xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) {
              const progress = Math.round((event.loaded / event.total) * 100);
              setUploadProgress(progress);
              setTranscribeMessage(`مرحله ۱ از ۲ (بارگذاری مستقیم فایل): ${progress}%`);
            }
          };
          
          xhr.onload = () => {
            const contentType = xhr.getResponseHeader("content-type") || "";
            if (xhr.status < 200 || xhr.status >= 300) {
              reject(new Error(`خطای سرور با کد ${xhr.status} در بارگذاری فایل.`));
              return;
            }
            if (contentType.includes("html")) {
              reject(new Error("پاسخ نامعتبر از سرور دریافت شد. لطفاً دوباره تلاش کنید."));
              return;
            }
            try {
              const resData = JSON.parse(xhr.responseText);
              if (resData.error) {
                reject(new Error(resData.error));
              } else if (resData.jobId) {
                resolve(resData.jobId);
              } else {
                reject(new Error("پاسخ نامشخص از سرور دریافت شد."));
              }
            } catch (e) {
              reject(new Error("پاسخ نامعتبر از سرور دریافت شد."));
            }
          };
          
          xhr.onerror = () => {
            reject(new Error("ارتباط با سرور برقرار نشد. لطفا اتصال اینترنت خود را بررسی و دوباره تلاش کنید."));
          };
          
          xhr.ontimeout = () => {
            reject(new Error("زمان بارگذاری مستقیم فایل به پایان رسید. اگر سرعت اینترنت شما پایین است، لطفا دوباره تلاش کنید."));
          };
          
          xhr.send(formData);
        });
        
      } else {
        // --- ROBUST CHUNKED UPLOAD FLOW ---
        console.log(`[UPLOAD] Starting robust chunked upload of ${mediaFile.name} (${(mediaFile.size / 1024 / 1024).toFixed(2)} MB)`);
        
        const CHUNK_SIZE = 2 * 1024 * 1024; // 2MB chunks
        const totalChunks = Math.ceil(mediaFile.size / CHUNK_SIZE);
        
        // Generate or reuse upload ID
        let currentUploadId = uploadId;
        if (!currentUploadId) {
          currentUploadId = `up_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
          setUploadId(currentUploadId);
        }

        let activeUploadedList = [...uploadedChunks];
        
        for (let chunkIndex = 0; chunkIndex < totalChunks; chunkIndex++) {
          if (activeUploadedList.includes(chunkIndex)) {
            // Already uploaded this chunk! Skip.
            continue;
          }
          
          const start = chunkIndex * CHUNK_SIZE;
          const end = Math.min(start + CHUNK_SIZE, mediaFile.size);
          const chunkBlob = mediaFile.slice(start, end);
          
          // Implement reliable chunk upload with 6 retries and exponential backoff
          let chunkSuccess = false;
          let lastChunkError: any = null;
          const maxAttempts = 6;
          
          for (let attempt = 1; attempt <= maxAttempts; attempt++) {
            try {
              if (attempt > 1) {
                const backoffDelay = Math.min(1000 * Math.pow(2, attempt - 2), 20000); // 1s, 2s, 4s, 8s, 16s, 20s
                console.log(`[UPLOAD CHUNK] Retrying chunk ${chunkIndex + 1}/${totalChunks}, attempt ${attempt}/${maxAttempts}, delaying ${backoffDelay}ms`);
                setTranscribeMessage(`تلاش مجدد ${attempt - 1} از ${maxAttempts - 1} برای ارسال بخش ${chunkIndex + 1} از ${totalChunks} (اتصال ناپایدار، لطفا صبور باشید)...`);
                await new Promise((r) => setTimeout(r, backoffDelay));
              }
              
              await new Promise<void>((resolve, reject) => {
                const xhr = new XMLHttpRequest();
                xhr.open("POST", "/api/upload-chunk");
                xhr.timeout = 180000; // 180 seconds (3 minutes) timeout per 2MB chunk is extremely safe for slow/unstable networks
                
                const chunkForm = new FormData();
                chunkForm.append("chunk", chunkBlob, `chunk_${chunkIndex}.bin`);
                chunkForm.append("uploadId", currentUploadId!);
                chunkForm.append("chunkIndex", chunkIndex.toString());
                chunkForm.append("totalChunks", totalChunks.toString());
                chunkForm.append("fileName", mediaFile.name);
                
                xhr.upload.onprogress = (event) => {
                  if (event.lengthComputable) {
                    const currentChunkProgress = event.loaded / event.total;
                    const overallProgress = Math.round(
                      ((activeUploadedList.length + currentChunkProgress) / totalChunks) * 100
                    );
                    setUploadProgress(Math.min(overallProgress, 99)); // Keep at 99% max during upload phase
                    setTranscribeMessage(`مرحله ۱ از ۲ (آپلود بخش ${chunkIndex + 1} از ${totalChunks}): ${overallProgress}%`);
                  }
                };
                
                xhr.onload = () => {
                  const contentType = xhr.getResponseHeader("content-type") || "";
                  
                  if (xhr.status < 200 || xhr.status >= 300) {
                    let errMessage = `خطای سرور با کد ${xhr.status} در آپلود بخش ${chunkIndex + 1}.`;
                    if (xhr.status === 413) {
                      errMessage = "حجم بخش فایل بیش از حد مجاز سرور است.";
                    }
                    reject(new Error(errMessage));
                    return;
                  }
                  
                  if (contentType.includes("html")) {
                    reject(new Error("پاسخ نامعتبر از سرور در آپلود بخش فایل دریافت شد."));
                    return;
                  }
                  
                  try {
                    const resData = JSON.parse(xhr.responseText);
                    if (resData.error) {
                      reject(new Error(resData.error));
                    } else {
                      activeUploadedList.push(chunkIndex);
                      setUploadedChunks([...activeUploadedList]);
                      resolve();
                    }
                  } catch (e) {
                    reject(new Error(`پاسخ نامعتبر از سرور در بخش ${chunkIndex + 1}.`));
                  }
                };
                
                xhr.onerror = () => {
                  reject(new Error(`ارتباط با سرور در آپلود بخش ${chunkIndex + 1} برقرار نشد. لطفا اتصال اینترنت خود را بررسی کنید.`));
                };
                
                xhr.ontimeout = () => {
                  reject(new Error(`زمان ارسال بخش ${chunkIndex + 1} به پایان رسید (سرعت آپلود اینترنت شما بسیار پایین است).`));
                };
                
                xhr.send(chunkForm);
              });
              
              chunkSuccess = true;
              break; // Success! Break out of attempts loop
            } catch (err: any) {
              lastChunkError = err;
              console.error(`[UPLOAD CHUNK FAILED] Chunk ${chunkIndex}, Attempt ${attempt} failed:`, err.message || err);
            }
          }
          
          if (!chunkSuccess) {
            throw lastChunkError || new Error(`ارسال بخش شماره ${chunkIndex + 1} از فایل پس از ${maxAttempts} بار تلاش ناموفق بود. نگران نباشید! با کلیک روی دکمه نارنجی زیر، آپلود مجدداً از همین بخش (${chunkIndex + 1}) ادامه خواهد یافت و فایل از ابتدا ارسال نخواهد شد.`);
          }
        }

        // Merge chunks on the server
        setUploadProgress(99);
        setTranscribeMessage("در حال یکپارچه‌سازی بخش‌های آپلود شده روی سرور...");
        const mergeRes = await fetch("/api/merge-chunks", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-gemini-api-key": customApiKey,
          },
          body: JSON.stringify({
            uploadId: currentUploadId,
            fileName: mediaFile.name,
            totalChunks,
            srtText,
            apiKey: customApiKey,
          }),
        });

        if (!mergeRes.ok) {
          const errData = await mergeRes.json().catch(() => ({}));
          throw new Error(errData.error || `خطا در یکپارچه‌سازی فایل‌ها روی سرور (کد ${mergeRes.status})`);
        }

        const mergeData = await mergeRes.json();
        jobId = mergeData.jobId;
        if (!jobId) {
          throw new Error("شناسه فرآیند پردازش دریافت نشد.");
        }
      }

      // Step 2: Extraction (Transcription) stage
      setUploadProgress(0);
      setTranscribeMessage("مرحله ۲ از ۲ (استخراج متن): شروع فرآیند پردازش صوتی...");
      setTranscribeLogs(["🎙️ شروع فرآیند استخراج متن از فایل چندرسانه‌ای..."]);

      // Start polling the job status
      let isCompleted = false;
      while (!isCompleted) {
        // Wait 2 seconds between polls
        await new Promise((resolve) => setTimeout(resolve, 2000));

        const statusRes = await fetch(`/api/transcribe-status/${jobId}`);
        if (!statusRes.ok) {
          throw new Error("[خطای مرحله استخراج] خطا در دریافت وضعیت فرآیند از سرور.");
        }

        const jobData = await statusRes.json();
        setUploadProgress(jobData.progress || 30);
        setTranscribeMessage(`مرحله ۲ از ۲ (استخراج متن): ${jobData.message || "در حال پردازش..."}`);
        if (jobData.logs && Array.isArray(jobData.logs)) {
          setTranscribeLogs(jobData.logs);
        }

        if (jobData.status === "completed") {
          setFileId(jobData.fileId);
          setFileName(jobData.fileName);
          setFileType(jobData.fileType);

          // Ensure all loaded segments have strictly unique sequential IDs starting from 1
          const sanitizedSegments = (jobData.segments || []).map((seg: any, idx: number) => ({
            ...seg,
            id: idx + 1,
          }));
          setSegments(sanitizedSegments);
          setUploadProgress(100);
          isCompleted = true;
        } else if (jobData.status === "failed") {
          throw new Error(`[خطای مرحله استخراج] ${jobData.error || jobData.message || "عملیات با خطا مواجه شد."}`);
        }
      }

    } catch (err: any) {
      console.error(err);
      setUploadError(err.message || "خطایی در حین پردازش فایل رخ داد.");
    } finally {
      setIsUploading(false);
      setTranscribeMessage("");
    }
  };

  // Google Drive file selection handler removed

  // Auto-translate subtitles using parallel worker pool with real-time logging
  const handleTranslateAllSubtitles = async () => {
    if (segments.length === 0) return;

    setIsTranslating(true);
    setTranslationProgress(5);
    setTranslationMessage("در حال راه‌اندازی فرآیند ترجمه موازی...");
    setTranslationLogs([`🌐 شروع کار ترجمه برای ${segments.length} دیالوگ با ۳ کارگر موازی و بچ‌های ۳۰ تایی...`]);

    try {
      // 1. Start background translation job
      const startRes = await fetch("/api/start-translation-job", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gemini-api-key": customApiKey,
        },
        body: JSON.stringify({
          segments,
          targetLanguage: TARGET_LANGUAGES.find((l) => l.code === targetLanguage)?.name || targetLanguage,
          translationTone,
          enableShortening,
          apiKey: customApiKey,
        }),
      });

      const contentType = startRes.headers.get("content-type") || "";
      if (contentType.includes("html")) {
        throw new Error("پاسخ نامعتبر از سرور در شروع ترجمه دریافت شد.");
      }

      if (!startRes.ok) {
        const errData = await startRes.json().catch(() => ({}));
        throw new Error(errData.error || "شروع فرآیند ترجمه ناموفق بود.");
      }

      const { jobId } = await startRes.json();
      if (!jobId) {
        throw new Error("شناسه فرآیند ترجمه دریافت نشد.");
      }

      // 2. Poll for translation status and live logs
      let isDone = false;
      while (!isDone) {
        await new Promise((resolve) => setTimeout(resolve, 1500));

        const pollRes = await fetch(`/api/translation-status/${jobId}`);
        if (!pollRes.ok) {
          throw new Error("خطا در دریافت وضعیت ترجمه از سرور.");
        }

        const jobData = await pollRes.json();
        setTranslationProgress(jobData.progress || 10);
        setTranslationMessage(jobData.message || "در حال ترجمه هوشمند دیالوگ‌ها...");
        if (jobData.logs && Array.isArray(jobData.logs)) {
          setTranslationLogs(jobData.logs);
        }

        if (jobData.status === "completed") {
          const updatedSegments = segments.map((seg, i) => ({
            ...seg,
            translatedText: jobData.segments?.[i]?.text || "",
            id: i + 1,
          }));
          setSegments(updatedSegments);
          setTranslationProgress(100);
          isDone = true;
        } else if (jobData.status === "failed") {
          throw new Error(jobData.error || jobData.message || "فرآیند ترجمه با خطا مواجه شد.");
        }
      }
    } catch (err: any) {
      console.error("Translation job error:", err);
      // Fallback: direct translation endpoint if background runner failed to start
      try {
        setTranslationMessage("تلاش با روش مستقیم ترجمه...");
        const res = await fetch("/api/translate-srt", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-gemini-api-key": customApiKey,
          },
          body: JSON.stringify({
            segments,
            targetLanguage: TARGET_LANGUAGES.find((l) => l.code === targetLanguage)?.name || targetLanguage,
            translationTone,
            enableShortening,
            apiKey: customApiKey,
          }),
        });

        if (res.ok) {
          const data = await res.json();
          const updatedSegments = segments.map((seg, i) => ({
            ...seg,
            translatedText: data.segments[i]?.text || "",
            id: i + 1,
          }));
          setSegments(updatedSegments);
          setTranslationProgress(100);
          setTranslationLogs((prev) => [...prev, "✅ ترجمه مستقیم با موفقیت تکمیل شد."]);
          return;
        }
      } catch (_) {}

      alert(`خطا در ترجمه: ${err.message}`);
    } finally {
      setIsTranslating(false);
    }
  };

  // Trigger single segment translation using Gemini
  const handleTranslateSegment = async (index: number) => {
    const segment = segments[index];
    if (!segment || !segment.text.trim()) return;

    try {
      const res = await fetch("/api/translate-srt", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gemini-api-key": customApiKey,
        },
        body: JSON.stringify({
          segments: [segment],
          targetLanguage: TARGET_LANGUAGES.find((l) => l.code === targetLanguage)?.name || targetLanguage,
          translationTone,
          enableShortening,
          apiKey: customApiKey,
        }),
      });

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("html")) {
        throw new Error("پاسخ نامعتبر از سرور در ترجمه دریافت شد.");
      }

      if (!res.ok) throw new Error("Failed to translate segment");
      const data = await res.json();
      const updated = [...segments];
      updated[index] = {
        ...segment,
        translatedText: data.segments[0]?.text || "",
      };
      setSegments(updated);
    } catch (err) {
      console.error(err);
    }
  };

  // Start the actual dubbing project render
  const handleStartDubbing = async () => {
    if (!fileId) return;
    setRenderError(null);

    // Filter and map segments
    const finalSegments = segments.map((seg) => ({
      ...seg,
      // Fallback to original text if translated text is empty
      text: seg.translatedText?.trim() || seg.text,
    }));

    try {
      const res = await fetch("/api/dub", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-gemini-api-key": customApiKey,
        },
        body: JSON.stringify({
          fileId,
          segments: finalSegments,
          voice: selectedVoice,
          targetLanguage,
          podcastMode,
          keepOriginal,
          originalVolume,
          allowStretch,
          maxStretch,
          balanceSpeed,
          maxSpeedFactor,
          apiKey: customApiKey,
        }),
      });

      const contentType = res.headers.get("content-type") || "";
      if (contentType.includes("html")) {
        throw new Error("پاسخ نامعتبر از سرور در شروع دوبله دریافت شد.");
      }

      if (!res.ok) {
        const errData = await res.json();
        throw new Error(errData.error || "Render request failed.");
      }

      const data = await res.json();
      setActiveJob({
        id: data.jobId,
        status: "pending",
        progress: 0,
        message: "Project queued for rendering...",
      });
    } catch (err: any) {
      console.error(err);
      setRenderError(err.message || "Failed to start rendering.");
    }
  };

  // Modify Segment Text Local State
  const handleUpdateSegmentText = (index: number, text: string, isOriginal: boolean) => {
    const updated = [...segments];
    if (isOriginal) {
      updated[index].text = text;
    } else {
      updated[index].translatedText = text;
    }
    setSegments(updated);
  };

  // Modify Timestamps
  const handleUpdateSegmentTime = (index: number, field: "startTime" | "endTime", val: string) => {
    const updated = [...segments];
    updated[index][field] = val;
    setSegments(updated);
  };

  // Add Segment
  const handleAddSegment = () => {
    let newStart = "00:00:00,000";
    if (segments.length > 0) {
      newStart = segments[segments.length - 1].endTime;
    }
    const maxId = segments.reduce((max, s) => Math.max(max, s.id), 0);
    const newSegment: SrtSegment = {
      id: maxId + 1,
      startTime: newStart,
      endTime: newStart,
      text: "",
      translatedText: "",
    };
    setSegments([...segments, newSegment]);
  };

  // Delete Segment
  const handleDeleteSegment = (index: number) => {
    const filtered = segments.filter((_, i) => i !== index).map((s, i) => ({ ...s, id: i + 1 }));
    setSegments(filtered);
  };

  // Reset Project State to upload new video
  const handleReset = () => {
    setMediaFile(null);
    setSrtFile(null);
    setFileId(null);
    setFileName("");
    setSegments([]);
    setUploadProgress(0);
    setActiveJob(null);
    setRenderError(null);
  };

  // Filter segments by query
  const filteredSegments = segments.filter(
    (s) =>
      s.text.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (s.translatedText && s.translatedText.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="min-h-screen bg-[#090b0f] text-slate-100 flex flex-col font-sans">
      {/* Sleek App Header */}
      <header className="border-b border-[#1b202c] bg-[#0c0e14] px-6 py-4 flex items-center justify-between sticky top-0 z-50">
        <div className="flex items-center gap-3">
          <div className="bg-gradient-to-tr from-cyan-500 to-indigo-600 p-2 rounded-xl text-white shadow-lg shadow-indigo-500/10">
            <Sparkles className="w-6 h-6 animate-pulse" />
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight font-display bg-gradient-to-r from-white via-slate-100 to-slate-400 bg-clip-text text-transparent">
              AI Smart Video Dubber Studio
            </h1>
            <p className="text-xs text-slate-400">
              Professional Voice Translation & Timed Alignment Studio
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowLiveLogsModal(true)}
            className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold bg-[#111622] hover:bg-[#182030] text-cyan-400 hover:text-cyan-300 rounded-lg border border-cyan-500/20 hover:border-cyan-500/40 transition-all cursor-pointer shadow-sm shadow-cyan-500/5"
            title="نمایش لاگ زنده و لحظه‌ای مدل‌های هوش مصنوعی"
          >
            <Activity className="w-3.5 h-3.5 animate-pulse text-cyan-400" />
            <span className="hidden sm:inline">کنسول زنده هوش مصنوعی</span>
            <span className="sm:hidden">لاگ زنده</span>
            {(isUploading || isTranslating || (activeJob && ["pending", "processing"].includes(activeJob.status))) && (
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-ping"></span>
            )}
          </button>

          {fileId && (
            <button
              onClick={handleReset}
              className="flex items-center gap-2 px-3.5 py-1.5 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-lg border border-[#272d3e] transition-all cursor-pointer"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              New Project
            </button>
          )}
        </div>
      </header>

      {/* YouTube Subscription Banner */}
      <div className="bg-gradient-to-r from-red-950/40 via-[#0c0e14] to-indigo-950/20 border-b border-[#1b202c] px-6 py-3 flex flex-col md:flex-row items-center justify-between gap-4">
        <div className="flex items-center gap-4 w-full md:w-auto">
          <a href="https://youtube.com/@aigolden" target="_blank" rel="noopener noreferrer" className="flex-shrink-0 relative group block">
            <img 
              src="https://huggingface.co/Toolsai/dubtest/resolve/main/newgolden.png" 
              alt="AI Golden Channel Logo" 
              className="w-18 h-18 rounded-xl object-contain bg-[#0c0e14] p-1 border border-slate-700/50 transition-all duration-300 shadow-lg shadow-black/50"
              referrerPolicy="no-referrer"
            />
            <div className="absolute bottom-0 right-0 bg-red-600 text-white rounded-full p-1 border border-[#0c0e14]">
              <Youtube className="w-4 h-4" />
            </div>
          </a>
          <div className="text-right md:text-left flex-1" dir="rtl">
            <p className="text-sm font-bold text-slate-100 flex items-center gap-2 justify-start md:justify-start">
              <span>کانال یوتیوب AI Golden</span>
              <span className="inline-block w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
            </p>
            <p className="text-xs text-slate-400 mt-1">
              برای آموزش‌های بیشتر ما را در یوتیوب دنبال کنید
            </p>
          </div>
        </div>
        <a 
          href="https://youtube.com/@aigolden" 
          target="_blank" 
          rel="noopener noreferrer" 
          className="flex items-center gap-2 px-5 py-2.5 bg-red-600 hover:bg-red-500 active:scale-95 text-white font-bold text-xs rounded-xl shadow-lg shadow-red-600/30 hover:shadow-red-500/40 transition-all w-full md:w-auto justify-center"
        >
          <Youtube className="w-4 h-4" />
          <span>🚀 دنبال کردن (Subscribe)</span>
        </a>
      </div>

      {/* User API Key & Tutorial Section */}
      <div className="bg-[#0b0e17] border-b border-[#1b2234] px-6 py-4 shadow-inner" dir="rtl">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row items-center justify-between gap-4">
          
          {/* Right side info */}
          <div className="flex items-center gap-3.5 w-full md:w-auto">
            <div className="p-3 bg-amber-500/20 text-amber-400 rounded-xl border border-amber-500/30 shrink-0">
              <Key className="w-5 h-5" />
            </div>
            <div className="text-right">
              <div className="flex items-center gap-2">
                <span className="text-xs font-bold text-slate-100">کلید اختصاصی هوش مصنوعی (Gemini API Key)</span>
                {customApiKey ? (
                  <span className="px-2.5 py-0.5 bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 text-[10px] font-bold rounded-full">
                    ✓ کلید اختصاصی شما فعال است
                  </span>
                ) : (
                  <span className="px-2.5 py-0.5 bg-amber-500/20 border border-amber-500/40 text-amber-300 text-[10px] font-bold rounded-full">
                    کلید اختصاصی وارد نشده است (دستی وارد کنید)
                  </span>
                )}
              </div>
              <p className="text-xs text-slate-400 mt-0.5 leading-relaxed">
                هر کاربر می‌تواند کلید رایگان Gemini خود را از گوگل دریافت و وارد نماید (بدون نیاز به کارت اعتباری یا Billing):
              </p>
            </div>
          </div>

          {/* Left side action buttons */}
          <div className="flex flex-wrap items-center gap-2.5 w-full md:w-auto justify-end">
            {/* Button 1: Get Free Key (Opens in new tab) */}
            <a
              href="https://aistudio.google.com/app/apikey"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-blue-600 to-indigo-600 hover:from-blue-500 hover:to-indigo-500 text-white text-xs font-bold rounded-xl transition-all shadow-md shadow-blue-600/20 active:scale-95 cursor-pointer"
            >
              <ExternalLink className="w-3.5 h-3.5" />
              <span>دریافت رایگان کلید API</span>
            </a>

            {/* Button 2: Video Tutorial (Opens in new tab) */}
            <a
              href="https://youtube.com/shorts/boQrl3uCYFk?is=Q1T2_LXATLp5jUWV"
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 px-4 py-2.5 bg-gradient-to-r from-red-600 to-rose-600 hover:from-red-500 hover:to-rose-500 text-white text-xs font-bold rounded-xl transition-all shadow-md shadow-red-600/20 active:scale-95 cursor-pointer"
            >
              <Youtube className="w-3.5 h-3.5" />
              <span>آموزش دریافت api</span>
            </a>

            {/* Button 3: Register API Key Modal Trigger */}
            <button
              onClick={() => {
                setApiKeyInput(customApiKey);
                setIsApiKeyModalOpen(true);
              }}
              className="flex items-center gap-2 px-4 py-2.5 bg-[#182033] hover:bg-[#202b44] border border-[#2b395a] text-slate-200 text-xs font-semibold rounded-xl transition-all shadow-sm active:scale-95 cursor-pointer"
            >
              <Key className="w-3.5 h-3.5 text-amber-400" />
              <span>{customApiKey ? "تغییر کلید" : "ثبت کلید در برنامه"}</span>
            </button>

            {/* Delete saved key button */}
            {customApiKey && (
              <button
                onClick={handleRemoveApiKey}
                title="حذف کلید اختصاصی"
                className="p-2.5 text-slate-400 hover:text-red-400 hover:bg-red-500/10 rounded-xl border border-slate-800 hover:border-red-500/20 transition-all cursor-pointer"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>

        </div>
      </div>

      {/* Main Workspace Area */}
      <main className="flex-1 flex flex-col">
        <AnimatePresence mode="wait">
          {!fileId ? (
            /* Onboarding Upload State */
            <motion.div
              key="uploader"
              initial={{ opacity: 0, y: 15 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -15 }}
              className="flex-1 max-w-4xl mx-auto w-full px-6 py-12 flex flex-col justify-center gap-6"
            >
              <div className="text-center mb-4">
                <h2 className="text-3xl font-extrabold tracking-tight font-display mb-3">
                  Translate & Dub Any Video in Seconds
                </h2>
                <p className="text-slate-400 max-w-xl mx-auto text-sm sm:text-base leading-relaxed">
                  Upload a video or audio file. Our advanced AI automatically transcribes your media, 
                  translates it, and generates a dubbed voice track perfectly timed to your video.
                </p>
              </div>

              {/* Tab Switcher (Only shown when not currently uploading/processing) */}
              {!isUploading && (
                <div className="flex p-1 bg-[#0c0e14] border border-[#202738] rounded-xl max-w-xl mx-auto w-full mb-2">
                  <button
                    onClick={() => setDriveActiveTab("local")}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                      driveActiveTab === "local"
                        ? "bg-slate-800 text-white shadow-md"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <Upload className="w-4 h-4" />
                    <span>آپلود فایل محلی</span>
                  </button>
                  <button
                    onClick={() => {
                      setDriveActiveTab("drive");
                      if (driveToken) {
                        fetchDriveFiles(driveToken);
                      }
                    }}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                      driveActiveTab === "drive"
                        ? "bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/10"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <Cloud className="w-4 h-4" />
                    <span>گوگل درایو</span>
                  </button>
                  <button
                    onClick={() => setDriveActiveTab("youtube")}
                    className={`flex-1 flex items-center justify-center gap-2 py-2.5 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                      driveActiveTab === "youtube"
                        ? "bg-red-600 text-white shadow-md shadow-red-600/20"
                        : "text-slate-400 hover:text-slate-200"
                    }`}
                  >
                    <Youtube className="w-4 h-4 text-red-400" />
                    <span>ورود از یوتیوب</span>
                  </button>
                </div>
              )}

              {/* View 3: YouTube Import Tab */}
              {!isUploading && driveActiveTab === "youtube" && (
                <div className="bg-[#0c0e14] border border-[#202738] rounded-2xl p-6 sm:p-8 flex flex-col justify-center">
                  <div className="max-w-xl mx-auto w-full text-right" dir="rtl">
                    <div className="flex items-center gap-3 mb-4">
                      <div className="w-12 h-12 rounded-xl bg-red-950/50 text-red-400 flex items-center justify-center border border-red-800/30 shrink-0">
                        <Youtube className="w-6 h-6" />
                      </div>
                      <div>
                        <h3 className="text-base font-bold text-slate-100">وارد کردن مستقیم ویدیو از یوتیوب (YouTube Import)</h3>
                        <p className="text-xs text-slate-400 mt-0.5">
                          لینک هر ویدیو یا شورتس (Shorts) یوتیوب را وارد کنید تا به صورت مستقیم دریافت و دوبله شود.
                        </p>
                      </div>
                    </div>

                    <div className="flex flex-col gap-2 my-4">
                      <label className="text-xs font-semibold text-slate-300">لینک ویدیو یوتیوب</label>
                      <div className="relative flex items-center">
                        <input
                          type="text"
                          placeholder="https://www.youtube.com/watch?v=... یا https://youtu.be/..."
                          value={youtubeUrl}
                          onChange={(e) => setYoutubeUrl(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") handleYoutubeImport();
                          }}
                          className="w-full bg-[#131722] border border-[#232a3e] rounded-xl px-4 py-3.5 text-xs text-slate-100 placeholder-slate-500 focus:outline-none focus:border-red-500 transition-all font-mono text-left dir-ltr pl-12 pr-10"
                          dir="ltr"
                        />
                        <Youtube className="w-5 h-5 text-red-500 absolute left-4 pointer-events-none" />
                        {youtubeUrl && (
                          <button
                            onClick={() => setYoutubeUrl("")}
                            className="absolute right-3 p-1 text-slate-400 hover:text-white rounded-lg transition-colors cursor-pointer"
                            title="پاک کردن"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Quick Paste Button & Helper */}
                    <div className="flex flex-wrap items-center justify-between gap-2 mb-6">
                      <button
                        type="button"
                        onClick={async () => {
                          try {
                            const text = await navigator.clipboard.readText();
                            if (text && (text.includes("youtube.com") || text.includes("youtu.be"))) {
                              setYoutubeUrl(text.trim());
                            }
                          } catch (e) {
                            // clipboard permission
                          }
                        }}
                        className="text-xs text-cyan-400 hover:text-cyan-300 font-semibold flex items-center gap-1 cursor-pointer bg-cyan-950/30 hover:bg-cyan-950/60 border border-cyan-800/30 px-3 py-1.5 rounded-lg transition-all"
                      >
                        <Sparkles className="w-3.5 h-3.5" />
                        <span>جای‌گذاری از حافظه (Paste Link)</span>
                      </button>

                      <span className="text-[11px] text-slate-500">
                        پشتیبانی کامل از لینک‌های Standard، Shorts و Mobile
                      </span>
                    </div>

                    <button
                      onClick={handleYoutubeImport}
                      disabled={!youtubeUrl.trim()}
                      className="w-full py-3.5 bg-gradient-to-r from-red-600 via-rose-600 to-indigo-600 hover:from-red-500 hover:to-indigo-500 text-white rounded-xl font-bold text-xs sm:text-sm shadow-xl shadow-red-600/20 active:scale-98 transition-all flex items-center justify-center gap-2 cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Youtube className="w-4 h-4" />
                      <span>دریافت ویدیو و استخراج هوشمند دیالوگ‌ها با جمینای</span>
                    </button>
                  </div>
                </div>
              )}

              {/* Loader Card when Uploading/Processing */}
              {isUploading && (
                <motion.div
                  initial={{ opacity: 0, scale: 0.95 }}
                  animate={{ opacity: 1, scale: 1 }}
                  className="bg-[#0c0e14] border border-cyan-500/30 rounded-2xl p-8 text-center flex flex-col items-center justify-center gap-4 shadow-xl"
                >
                  <Loader2 className="w-10 h-10 text-cyan-400 animate-spin" />
                  <h3 className="text-lg font-bold text-slate-100">در حال دریافت و پردازش فایل صوتی یا ویدیویی</h3>
                  <div className="w-full bg-slate-900 rounded-full h-2.5 max-w-md my-2 overflow-hidden border border-slate-800">
                    <div
                      className="bg-gradient-to-r from-cyan-500 to-indigo-600 h-2.5 rounded-full transition-all duration-300"
                      style={{ width: `${uploadProgress}%` }}
                    ></div>
                  </div>
                  <span className="text-sm font-semibold text-cyan-400">{uploadProgress}% کامل شده</span>
                  {transcribeMessage && (
                    <p className="text-xs text-slate-300 mt-1 font-mono" dir="rtl">
                      {transcribeMessage}
                    </p>
                  )}
                  <p className="text-xs text-slate-400 max-w-sm mt-1">
                    لطفا این صفحه را نبندید. فرآیند دریافت ابری مستقیم و استخراج متن در حال انجام است.
                  </p>

                  {/* Live Real-Time Logs during extraction */}
                  <div className="w-full max-w-2xl mt-4">
                    <LiveLogViewer
                      logs={transcribeLogs}
                      stageName="استخراج"
                      title="گزارش زنده استخراج زیرنویس و دیالوگ‌ها"
                      isProcessing={isUploading}
                      defaultExpanded={true}
                    />
                  </div>
                </motion.div>
              )}

              {/* View 1: Local Upload Tab */}
              {!isUploading && driveActiveTab === "local" && (
                <>
                  {/* Upload Dropzone */}
                  <div
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                    className={`border-2 border-dashed rounded-2xl p-10 text-center flex flex-col items-center justify-center transition-all cursor-pointer ${
                      isDragging
                        ? "border-cyan-500 bg-cyan-500/5 shadow-2xl shadow-cyan-500/5"
                        : "border-[#202738] bg-[#0c0e14] hover:border-[#303b55] hover:bg-[#0e111a]"
                    }`}
                    onClick={() => fileInputRef.current?.click()}
                  >
                    <input
                      type="file"
                      ref={fileInputRef}
                      className="hidden"
                      accept="video/*,audio/*"
                      onChange={(e) => {
                        if (e.target.files && e.target.files.length > 0) {
                          handleSetMediaFile(e.target.files[0]);
                        }
                      }}
                    />

                    <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center text-cyan-400 mb-4 border border-[#232a3d]">
                      <Upload className="w-7 h-7" />
                    </div>

                    <h3 className="text-lg font-bold mb-1">
                      {mediaFile ? mediaFile.name : "Select your Video or Audio file"}
                    </h3>
                    <p className="text-xs text-slate-400 mb-6 max-w-xs">
                      Drag and drop your media file here, or click to browse (MP4, MKV, AVI, MP3, WAV)
                    </p>

                    {mediaFile && (
                      <div className="flex flex-col items-center gap-3">
                        <div className="flex items-center gap-2 bg-slate-900 px-4 py-2 rounded-lg border border-[#1e2535] text-xs">
                          {mediaFile.type.startsWith("video/") ? (
                            <Video className="w-4 h-4 text-cyan-400" />
                          ) : (
                            <Music className="w-4 h-4 text-purple-400" />
                          )}
                          <span className="font-semibold text-slate-300">
                            {(mediaFile.size / (1024 * 1024)).toFixed(2)} MB
                          </span>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Optional Subtitle Upload */}
                  {mediaFile && (
                    <motion.div
                      initial={{ opacity: 0, height: 0 }}
                      animate={{ opacity: 1, height: "auto" }}
                      className="mt-6 border border-[#1d2334] bg-[#0c0e14]/50 rounded-xl p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
                    >
                      <div className="flex items-start gap-3">
                        <div className="p-2 rounded-lg bg-slate-800 text-amber-400 mt-0.5">
                          <FileText className="w-4 h-4" />
                        </div>
                        <div>
                          <h4 className="text-xs font-bold text-slate-200">
                            Optional: Upload Pre-existing Subtitles (.srt)
                          </h4>
                          <p className="text-[11px] text-slate-400">
                            Highly recommended if you already have custom translated timings or transcripts.
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            srtInputRef.current?.click();
                          }}
                          className="px-4 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg border border-[#22293b]"
                        >
                          {srtFile ? srtFile.name : "Choose .srt Subtitle"}
                        </button>
                        {srtFile && (
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              setSrtFile(null);
                            }}
                            className="p-2 text-slate-400 hover:text-red-400"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        )}
                        <input
                          type="file"
                          ref={srtInputRef}
                          className="hidden"
                          accept=".srt"
                          onChange={(e) => {
                            if (e.target.files && e.target.files.length > 0) {
                              setSrtFile(e.target.files[0]);
                            }
                          }}
                        />
                      </div>
                    </motion.div>
                  )}

                  {/* Core Onboarding Action Button */}
                  {mediaFile && (
                    <motion.button
                      initial={{ opacity: 0, scale: 0.95 }}
                      animate={{ opacity: 1, scale: 1 }}
                      onClick={handleUploadAndTranscribe}
                      className="mt-8 py-3.5 bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-white rounded-xl font-bold text-sm shadow-xl shadow-cyan-500/10 flex items-center justify-center gap-2 transition-all cursor-pointer"
                    >
                      <Sparkles className="w-4 h-4" />
                      Upload & Transcribe Media with Gemini
                    </motion.button>
                  )}
                </>
              )}

              {/* View 2: Google Drive Tab */}
              {!isUploading && driveActiveTab === "drive" && (
                <div className="bg-[#0c0e14] border border-[#202738] rounded-2xl p-4 sm:p-6 min-h-[300px] flex flex-col justify-center">
                  {/* Mode switcher within Drive Tab */}
                  <div className="flex p-1 bg-[#10141e] border border-[#202738] rounded-xl max-w-lg mx-auto w-full mb-5" dir="rtl">
                    <button
                      type="button"
                      onClick={() => {
                        setColabDriveMode("colab");
                        fetchColabDrive(colabDrivePath || undefined);
                      }}
                      className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                        colabDriveMode === "colab"
                          ? "bg-cyan-500 text-slate-950 shadow-md shadow-cyan-500/20"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      <HardDrive className="w-3.5 h-3.5" />
                      <span>مرورگر مستقیم درایو در کولب</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => setColabDriveMode("oauth")}
                      className={`flex-1 flex items-center justify-center gap-2 py-2 text-xs font-bold rounded-lg transition-all cursor-pointer ${
                        colabDriveMode === "oauth"
                          ? "bg-indigo-600 text-white shadow-md shadow-indigo-600/20"
                          : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      <Cloud className="w-3.5 h-3.5" />
                      <span>اتصال با لاگین گوگل (OAuth)</span>
                    </button>
                  </div>

                  {colabDriveMode === "colab" ? (
                    /* Colab Direct Drive & Local Server Explorer */
                    <div className="flex flex-col gap-4" dir="rtl">
                      {/* Mount status header */}
                      <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#131722] border border-[#202738] rounded-xl p-3.5">
                        <div className="flex items-center gap-3 w-full sm:w-auto">
                          <div className={`w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border ${
                            isColabDriveMounted
                              ? "bg-emerald-950/40 text-emerald-400 border-emerald-800/40"
                              : "bg-amber-950/40 text-amber-400 border-amber-800/40"
                          }`}>
                            <HardDrive className="w-4 h-4" />
                          </div>
                          <div>
                            <div className="flex items-center gap-2">
                              <h4 className="text-xs font-bold text-slate-100">مسیر حافظه مستقیم در سرور و کولب</h4>
                              {isColabDriveMounted ? (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-bold border border-emerald-500/20">
                                  🟢 گوگل درایو متصل است
                                </span>
                              ) : (
                                <span className="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/10 text-amber-400 font-bold border border-amber-500/20">
                                  🟡 حافظه محلی فعال (درایو Mount نشده)
                                </span>
                              )}
                            </div>
                            <p className="text-[11px] text-slate-400 mt-0.5 font-mono dir-ltr text-right">
                              {colabDrivePath || "/content/drive/MyDrive"}
                            </p>
                          </div>
                        </div>

                        <div className="flex items-center gap-2 w-full sm:w-auto justify-end">
                          {colabDriveParent && (
                            <button
                              type="button"
                              onClick={() => fetchColabDrive(colabDriveParent)}
                              disabled={isColabDriveLoading}
                              className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-bold rounded-lg transition-all flex items-center gap-1.5 cursor-pointer disabled:opacity-50"
                              title="بازگشت به پوشه والد"
                            >
                              <CornerLeftUp className="w-3.5 h-3.5" />
                              <span>پوشه قبلی</span>
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => fetchColabDrive(colabDrivePath || undefined)}
                            disabled={isColabDriveLoading}
                            className="p-2 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-cyan-400 rounded-lg transition-all cursor-pointer disabled:opacity-50"
                            title="بروزرسانی لیست"
                          >
                            <RefreshCw className={`w-3.5 h-3.5 ${isColabDriveLoading ? "animate-spin text-cyan-400" : ""}`} />
                          </button>
                        </div>
                      </div>

                      {/* Quick Location Shortcuts */}
                      <div className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="text-[11px] text-slate-400 font-bold">مسیرهای سریع:</span>
                        <button
                          type="button"
                          onClick={() => fetchColabDrive("/content/drive/MyDrive")}
                          className="px-2.5 py-1 bg-[#151a27] hover:bg-cyan-950/60 hover:text-cyan-300 border border-[#202738] rounded-lg text-[11px] font-semibold text-slate-300 transition-all cursor-pointer flex items-center gap-1.5"
                        >
                          <Folder className="w-3 h-3 text-cyan-400" />
                          <span>گوگل درایو (MyDrive)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => fetchColabDrive("/content")}
                          className="px-2.5 py-1 bg-[#151a27] hover:bg-slate-800 border border-[#202738] rounded-lg text-[11px] font-semibold text-slate-300 transition-all cursor-pointer flex items-center gap-1.5"
                        >
                          <HardDrive className="w-3 h-3 text-slate-400" />
                          <span>روت کولب (/content)</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => fetchColabDrive("uploads")}
                          className="px-2.5 py-1 bg-[#151a27] hover:bg-slate-800 border border-[#202738] rounded-lg text-[11px] font-semibold text-slate-300 transition-all cursor-pointer flex items-center gap-1.5"
                        >
                          <FolderOpen className="w-3 h-3 text-purple-400" />
                          <span>پوشه آپلودها (uploads)</span>
                        </button>
                      </div>

                      {/* Manual Path Input Form */}
                      <form
                        onSubmit={(e) => {
                          e.preventDefault();
                          if (colabCustomPathInput.trim()) {
                            // Check if path is directly a file
                            const isDirectFile = /\.(mp4|mkv|avi|mov|webm|mp3|wav|m4a|flac|aac)$/i.test(colabCustomPathInput.trim());
                            if (isDirectFile) {
                              handleColabDriveImport(colabCustomPathInput.trim());
                            } else {
                              fetchColabDrive(colabCustomPathInput.trim());
                            }
                          }
                        }}
                        className="flex gap-2"
                      >
                        <input
                          type="text"
                          placeholder="آدرس دقیق پوشه یا فایل در کولب... (مثال: /content/drive/MyDrive/video.mp4)"
                          value={colabCustomPathInput}
                          onChange={(e) => setColabCustomPathInput(e.target.value)}
                          className="flex-1 bg-[#131722] border border-[#202738] rounded-xl px-3.5 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 font-mono text-left dir-ltr"
                        />
                        <button
                          type="submit"
                          disabled={isColabDriveLoading}
                          className="px-4 bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-xs rounded-xl transition-all cursor-pointer disabled:opacity-50 shrink-0"
                        >
                          برو به مسیر
                        </button>
                      </form>

                      {/* Error notice if any */}
                      {colabDriveError && (
                        <div className="bg-amber-500/10 border border-amber-500/20 text-amber-300 p-3 rounded-xl text-xs flex items-start gap-2.5">
                          <AlertCircle className="w-4 h-4 text-amber-400 shrink-0 mt-0.5" />
                          <div className="flex-1">
                            <p className="font-bold mb-1">{colabDriveError}</p>
                            {!isColabDriveMounted && (
                              <div className="mt-2 p-2 bg-slate-900/80 rounded-lg text-[11px] text-slate-300 border border-slate-700/50">
                                <p className="mb-1 text-slate-400">برای اتصال مستقیم گوگل درایو، این دستور را در سلول کولب اجرا فرمایید:</p>
                                <code className="text-cyan-300 font-mono select-all font-bold block dir-ltr text-left">
                                  from google.colab import drive; drive.mount('/content/drive')
                                </code>
                              </div>
                            )}
                          </div>
                        </div>
                      )}

                      {/* Filter Search */}
                      {colabDriveFiles.length > 3 && (
                        <div className="relative">
                          <input
                            type="text"
                            placeholder="فیلتر کردن فایل‌های این پوشه..."
                            value={colabFileSearch}
                            onChange={(e) => setColabFileSearch(e.target.value)}
                            className="w-full bg-[#10141e] border border-[#202738] rounded-xl pl-3 pr-9 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500"
                          />
                          <Search className="absolute right-3 top-2.5 w-3.5 h-3.5 text-slate-500" />
                        </div>
                      )}

                      {/* Folders & Files Browser Container */}
                      <div className="border border-[#202738] bg-[#10141e] rounded-xl overflow-hidden min-h-[160px] max-h-[340px] overflow-y-auto">
                        {isColabDriveLoading ? (
                          <div className="py-14 text-center flex flex-col items-center justify-center gap-2">
                            <Loader2 className="w-7 h-7 text-cyan-400 animate-spin" />
                            <p className="text-xs text-slate-400">در حال خواندن فایل‌های درایو در حافظه کولب...</p>
                          </div>
                        ) : colabDriveFolders.length === 0 && colabDriveFiles.length === 0 ? (
                          <div className="py-12 text-center text-slate-400 px-6">
                            <Folder className="w-10 h-10 text-slate-600 mx-auto mb-2 opacity-50" />
                            <p className="text-xs font-bold mb-1">این پوشه خالی است یا فایل ویدیویی/صوتی در آن وجود ندارد.</p>
                            <p className="text-[10px] text-slate-500 max-w-sm mx-auto leading-relaxed mt-1">
                              فایل‌های ویدیویی (MP4, MKV, AVI) یا صوتی خود را داخل گوگل درایو یا پوشه /content کولب قرار دهید.
                            </p>
                          </div>
                        ) : (
                          <div className="flex flex-col">
                            {/* Subfolders list */}
                            {colabDriveFolders.length > 0 && (
                              <div className="p-2.5 bg-[#0b0e14] border-b border-[#1b202c]">
                                <p className="text-[10px] font-bold text-slate-400 mb-2">📁 پوشه‌های داخل این مسیر ({colabDriveFolders.length}):</p>
                                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                                  {colabDriveFolders.map((folder) => (
                                    <button
                                      key={folder.path}
                                      type="button"
                                      onClick={() => fetchColabDrive(folder.path)}
                                      className="flex items-center gap-2 p-2 rounded-lg bg-[#141926] hover:bg-cyan-950/40 hover:border-cyan-500/40 border border-[#202738] text-right transition-all cursor-pointer group"
                                    >
                                      <Folder className="w-4 h-4 text-cyan-400 group-hover:scale-110 transition-transform shrink-0" />
                                      <span className="text-xs font-medium text-slate-200 group-hover:text-cyan-300 truncate">
                                        {folder.name}
                                      </span>
                                    </button>
                                  ))}
                                </div>
                              </div>
                            )}

                            {/* Media Files list */}
                            <div className="divide-y divide-[#1b202c]">
                              {colabDriveFiles
                                .filter((f) => !colabFileSearch.trim() || f.name.toLowerCase().includes(colabFileSearch.toLowerCase()))
                                .map((file) => (
                                  <div
                                    key={file.path}
                                    className="flex items-center justify-between p-3 hover:bg-[#131722] transition-colors"
                                  >
                                    <button
                                      type="button"
                                      onClick={() => handleColabDriveImport(file.path, file.name)}
                                      className="px-3.5 py-2 bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 active:scale-95 text-slate-950 font-extrabold text-xs rounded-lg transition-all shadow-md shadow-cyan-500/10 hover:shadow-cyan-500/20 cursor-pointer flex items-center gap-1.5 shrink-0"
                                    >
                                      <Sparkles className="w-3.5 h-3.5" />
                                      <span>انتخاب و دوبله</span>
                                    </button>

                                    <div className="flex items-center gap-3 text-right overflow-hidden ml-3" dir="rtl">
                                      <div className="p-2 rounded-lg bg-slate-900 border border-[#202738] text-slate-300 shrink-0">
                                        {file.isVideo ? (
                                          <Video className="w-4 h-4 text-cyan-400" />
                                        ) : (
                                          <Music className="w-4 h-4 text-purple-400" />
                                        )}
                                      </div>
                                      <div className="overflow-hidden">
                                        <p className="text-xs font-bold text-slate-200 truncate max-w-[220px] sm:max-w-[340px]" title={file.name}>
                                          {file.name}
                                        </p>
                                        <div className="flex items-center gap-2 mt-0.5">
                                          <span className="text-[10px] text-cyan-400/90 font-mono font-bold uppercase">{file.ext.replace(".", "")}</span>
                                          <span className="text-[10px] text-slate-500 font-semibold">• {file.sizeFormatted}</span>
                                        </div>
                                      </div>
                                    </div>
                                  </div>
                                ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    /* Mode 2: Google OAuth Sign In */
                    <div>
                      {!driveUser ? (
                        /* Google Sign In Call-To-Action */
                        <div className="text-center py-6 flex flex-col items-center justify-center max-w-lg mx-auto">
                          <div className="w-16 h-16 rounded-full bg-cyan-950/40 text-cyan-400 flex items-center justify-center mb-4 border border-cyan-800/30">
                            <Cloud className="w-7 h-7" />
                          </div>
                          <h3 className="text-lg font-bold mb-2">اتصال با حساب گوگل (Google OAuth)</h3>
                          <p className="text-xs text-slate-400 leading-relaxed mb-6" dir="rtl">
                            برای محیط‌هایی که دسترسی مستقیم به پنجره پاپ‌آپ گوگل دارند، می‌توانید مستقیماً وارد حساب گوگل شوید. (در محیط‌های تونل شده مانند Gradio یا Cloudflare، تب «مرورگر مستقیم درایو در کولب» پیشنهاد می‌شود).
                          </p>
                          <button
                            onClick={handleDriveSignIn}
                            disabled={isDriveLoading}
                            className="flex items-center gap-3 px-6 py-3.5 bg-white hover:bg-slate-100 text-slate-900 rounded-xl font-bold text-xs transition-all active:scale-98 shadow-xl shadow-white/5 cursor-pointer disabled:opacity-50"
                          >
                            {isDriveLoading ? (
                              <Loader2 className="w-4 h-4 animate-spin text-slate-900" />
                            ) : (
                              <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
                                <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
                                <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l3.66-2.85z" fill="#FBBC05" />
                                <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.85c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
                              </svg>
                            )}
                            <span>ورود با حساب گوگل و انتخاب فایل</span>
                          </button>
                        </div>
                      ) : (
                        /* Drive Connected View - Files list */
                        <div className="flex flex-col gap-4">
                          {/* Connection Header bar */}
                          <div className="flex flex-col sm:flex-row items-center justify-between gap-3 bg-[#131722] border border-[#202738] rounded-xl px-4 py-3" dir="rtl">
                            <div className="flex items-center gap-3">
                              {driveUser.photoURL ? (
                                <img src={driveUser.photoURL} alt="Avatar" className="w-8 h-8 rounded-full border border-cyan-500/30" referrerPolicy="no-referrer" />
                              ) : (
                                <div className="w-8 h-8 rounded-full bg-cyan-950 text-cyan-400 flex items-center justify-center font-bold text-xs">
                                  {driveUser.email ? driveUser.email[0].toUpperCase() : "G"}
                                </div>
                              )}
                              <div className="text-right">
                                <p className="text-xs font-bold text-slate-100">{driveUser.displayName || "کاربر گوگل"}</p>
                                <p className="text-[10px] text-slate-400">{driveUser.email}</p>
                              </div>
                            </div>
                            <button
                              onClick={handleDriveSignOut}
                              className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 hover:text-red-400 rounded-lg text-[10px] font-bold text-slate-300 transition-all cursor-pointer"
                            >
                              <LogOut className="w-3.5 h-3.5" />
                              <span>خروج از حساب</span>
                            </button>
                          </div>

                          {/* Search Bar & Refresh */}
                          <div className="flex gap-2">
                            <div className="relative flex-1">
                              <input
                                type="text"
                                placeholder="جستجو در فایل‌های گوگل درایو..."
                                value={driveSearchQuery}
                                onChange={(e) => setDriveSearchQuery(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && driveToken) {
                                    fetchDriveFiles(driveToken, driveSearchQuery);
                                  }
                                }}
                                className="w-full bg-[#131722] border border-[#202738] rounded-xl pl-3 pr-10 py-2.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 text-right"
                                dir="rtl"
                              />
                              <Search className="absolute right-3.5 top-3 w-4 h-4 text-slate-500" />
                            </div>
                            <button
                              onClick={() => driveToken && fetchDriveFiles(driveToken, driveSearchQuery)}
                              disabled={isDriveLoading}
                              className="px-4 bg-[#131722] hover:bg-slate-800 border border-[#202738] rounded-xl text-xs font-semibold text-slate-300 flex items-center gap-1 cursor-pointer disabled:opacity-50"
                            >
                              {isDriveLoading ? <Loader2 className="w-4 h-4 animate-spin text-slate-400" /> : "جستجو"}
                            </button>
                          </div>

                          {/* Drive error box */}
                          {driveError && (
                            <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-3 rounded-xl text-xs text-right" dir="rtl">
                              {driveError}
                            </div>
                          )}

                          {/* Files list container */}
                          <div className="border border-[#202738] bg-[#10141e] rounded-xl overflow-hidden max-h-[300px] overflow-y-auto">
                            {isDriveLoading ? (
                              <div className="py-16 text-center flex flex-col items-center justify-center gap-2">
                                <Loader2 className="w-8 h-8 text-cyan-400 animate-spin" />
                                <p className="text-xs text-slate-400">در حال دریافت لیست فایل‌های ویدیویی و صوتی گوگل درایو شما...</p>
                              </div>
                            ) : driveFiles.length === 0 ? (
                              <div className="py-16 text-center text-slate-400 px-6">
                                <p className="text-xs font-bold mb-1">هیچ فایل ویدیو یا صوتی پیدا نشد!</p>
                                <p className="text-[10px] text-slate-500 max-w-xs mx-auto leading-relaxed">
                                  مطمئن شوید فایل‌های با پسوند ویدیویی (MP4, MKV) یا صوتی (MP3, WAV) در روت یا پوشه‌های درایو شما آپلود شده‌اند.
                                </p>
                              </div>
                            ) : (
                              <div className="divide-y divide-[#1b202c]">
                                {driveFiles.map((file) => {
                                  const isVideoType = file.mimeType?.startsWith("video/") || file.name.endsWith(".mp4") || file.name.endsWith(".mkv") || file.name.endsWith(".avi");
                                  const fileSizeMb = file.size ? (parseInt(file.size, 10) / (1024 * 1024)).toFixed(1) + " MB" : "اندازه نامشخص";
                                  return (
                                    <div
                                      key={file.id}
                                      className="flex items-center justify-between p-3.5 hover:bg-[#131722] transition-colors"
                                    >
                                      <button
                                        onClick={() => handleDriveImport(file)}
                                        className="px-4 py-2 bg-cyan-500 hover:bg-cyan-400 active:scale-95 text-slate-950 font-extrabold text-xs rounded-lg transition-all shadow-md shadow-cyan-500/10 hover:shadow-cyan-500/20 cursor-pointer flex items-center gap-1.5"
                                      >
                                        <Sparkles className="w-3.5 h-3.5" />
                                        <span>پردازش فایل</span>
                                      </button>
                                      <div className="flex items-center gap-3 text-right" dir="rtl">
                                        <div className="p-2 rounded-lg bg-slate-900 border border-[#202738] text-slate-300">
                                          {isVideoType ? <Video className="w-4 h-4 text-cyan-400" /> : <Music className="w-4 h-4 text-purple-400" />}
                                        </div>
                                        <div>
                                          <p className="text-xs font-bold text-slate-200 line-clamp-1 max-w-[240px] sm:max-w-[320px]">{file.name}</p>
                                          <p className="text-[10px] text-slate-500 font-semibold mt-0.5">{fileSizeMb}</p>
                                        </div>
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* Centralized Upload/Import error container */}
              {uploadError && (
                <div className="mt-2 flex flex-col gap-3">
                  <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4 rounded-xl flex items-center gap-3 text-sm" dir="rtl">
                    <AlertCircle className="w-5 h-5 text-red-400 flex-shrink-0" />
                    <p className="text-right leading-relaxed flex-1">{uploadError}</p>
                  </div>
                  {driveActiveTab === "local" && (
                    <button
                      type="button"
                      onClick={handleUploadAndTranscribe}
                      className="py-3 bg-gradient-to-r from-amber-600 to-orange-600 hover:from-amber-500 hover:to-orange-500 text-white rounded-xl font-bold text-xs sm:text-sm shadow-xl shadow-orange-500/10 flex items-center justify-center gap-2 transition-all cursor-pointer"
                    >
                      <RotateCcw className="w-4 h-4" />
                      <span>تلاش مجدد آپلود و پردازش (Retry Upload)</span>
                    </button>
                  )}
                </div>
              )}
            </motion.div>
          ) : (
            /* Dual-Panel Active Studio Workspace */
            <motion.div
              key="workspace"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex-1 flex flex-col lg:flex-row h-[calc(100vh-73px)] divide-y lg:divide-y-0 lg:divide-x divide-[#1b202c]"
            >
              {/* Mobile/Tablet Workspace Tab Switcher */}
              <div className="flex lg:hidden bg-[#0c0e14] border-b border-[#1b202c] p-1.5 sticky top-0 z-20 w-full">
                <button
                  onClick={() => setActiveWorkspaceTab("settings")}
                  className={`flex-1 py-2.5 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer ${
                    activeWorkspaceTab === "settings"
                      ? "bg-slate-800 text-white border border-[#2e374d]"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                  <span>تنظیمات و خروجی</span>
                </button>
                <button
                  onClick={() => setActiveWorkspaceTab("timeline")}
                  className={`flex-1 py-2.5 text-xs font-bold rounded-lg transition-all flex items-center justify-center gap-2 cursor-pointer ${
                    activeWorkspaceTab === "timeline"
                      ? "bg-slate-800 text-white border border-[#2e374d]"
                      : "text-slate-400 hover:text-slate-200"
                  }`}
                >
                  <FileText className="w-3.5 h-3.5 text-cyan-400" />
                  <span>ویرایش دیالوگ‌ها (زیرنویس)</span>
                </button>
              </div>

              {/* Left Column: Settings and Controls */}
              <div className={`w-full lg:w-[400px] flex-shrink-0 flex flex-col overflow-y-auto bg-[#0b0d13] p-5 gap-6 ${
                activeWorkspaceTab === "settings" ? "flex" : "hidden lg:flex"
              }`}>
                
                {/* Media file card */}
                <div className="bg-[#0e111a] border border-[#1e2535] rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-[11px] font-bold tracking-wider text-slate-400 uppercase">
                      Current Media Source
                    </span>
                    <span className="text-[11px] font-semibold bg-cyan-950 text-cyan-400 border border-cyan-800/30 px-2 py-0.5 rounded-full">
                      {fileType === "video" ? "Video Track" : "Audio Track"}
                    </span>
                  </div>
                  <h3 className="font-bold text-sm truncate text-white" title={fileName}>
                    {fileName}
                  </h3>
                </div>

                {/* Primary configuration card */}
                <div className="flex flex-col gap-4 bg-[#0e111a] border border-[#1c2232] rounded-xl p-5">
                  <h4 className="text-xs font-extrabold tracking-wider text-slate-400 uppercase flex items-center gap-2">
                    <Languages className="w-3.5 h-3.5 text-cyan-400" />
                    Target Language & Voice
                  </h4>

                  {/* Target Language Select */}
                  <div className="flex flex-col gap-1.5">
                    <label className="text-xs text-slate-300">Target Language</label>
                    <div className="relative">
                      <select
                        value={targetLanguage}
                        onChange={(e) => setTargetLanguage(e.target.value)}
                        className="w-full bg-[#121622] border border-[#232a3e] rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500 transition-all appearance-none"
                      >
                        {TARGET_LANGUAGES.map((lang) => (
                          <option key={lang.code} value={lang.code}>
                            {lang.name}
                          </option>
                        ))}
                      </select>
                      <ChevronDown className="w-4 h-4 absolute right-3 top-3 text-slate-400 pointer-events-none" />
                    </div>
                  </div>

                  {/* Translation Tone Select */}
                  <div className="flex flex-col gap-1.5 mt-1" dir="rtl">
                    <label className="text-xs text-slate-300 text-right flex items-center gap-1.5 justify-end">
                      <span>لحن ترجمه دیالوگ‌ها</span>
                      <Globe className="w-3.5 h-3.5 text-cyan-400" />
                    </label>
                    <div className="relative" dir="ltr">
                      <select
                        value={translationTone}
                        onChange={(e) => setTranslationTone(e.target.value as any)}
                        className="w-full bg-[#121622] border border-[#232a3e] rounded-lg px-3 py-2 text-sm text-slate-200 outline-none focus:border-cyan-500 transition-all appearance-none text-right pr-8"
                      >
                        <option value="auto">هوشمند (انطباق خودکار با متن ویدیو)</option>
                        <option value="formal">کتابی و رسمی (Formal)</option>
                        <option value="colloquial">صمیمی و محاوره‌ای (Colloquial)</option>
                      </select>
                      <ChevronDown className="w-4 h-4 absolute left-3 top-3 text-slate-400 pointer-events-none" />
                    </div>
                  </div>

                  {/* Smart Dialogue Shortening Checkbox */}
                  <div className="flex flex-col gap-2 mt-2 bg-[#121622] p-3 rounded-lg border border-[#232a3e]" dir="rtl">
                    <div className="flex items-center justify-between">
                      <label className="text-xs font-semibold text-slate-200 flex items-center gap-1.5">
                        <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                        <span>خلاصه‌سازی هوشمند دیالوگ‌ها</span>
                      </label>
                      <input
                        type="checkbox"
                        checked={enableShortening}
                        onChange={(e) => setEnableShortening(e.target.checked)}
                        className="w-4 h-4 rounded text-cyan-500 border-slate-700 bg-[#0c0e14] outline-none cursor-pointer accent-cyan-500"
                      />
                    </div>
                    <p className="text-[10px] text-slate-400 leading-relaxed text-right">
                      متن ترجمه را به صورت هوشمند خلاصه و بهینه‌سازی می‌کند تا طول دیالوگ‌های ترجمه شده کاملاً متناسب با زمان ویدیو و سرعت گوینده اصلی باشد.
                    </p>
                  </div>

                  {/* Voice Select */}
                  <div className="flex flex-col gap-1.5 relative">
                    <label className="text-xs text-slate-300">Dubbing Speaker Voice</label>
                    <button
                      type="button"
                      onClick={() => {
                        setIsVoiceDropdownOpen(!isVoiceDropdownOpen);
                        setVoiceSearchQuery(""); // Reset search on open
                      }}
                      className="w-full p-3 rounded-lg border text-left bg-[#121622] border-[#222a3d] hover:border-[#2f3952] transition-all flex items-center justify-between cursor-pointer"
                    >
                      <div className="flex-1 min-w-0 pr-2">
                        {(() => {
                          const activeVoiceObj = DUBBING_VOICES.find((v) => v.id === selectedVoice) || DUBBING_VOICES[0];
                          return (
                            <div className="flex flex-col text-left">
                              <div className="flex items-center gap-2 mb-1">
                                <span className="font-bold text-xs text-slate-200">{activeVoiceObj.name}</span>
                                <span
                                  className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase ${
                                    activeVoiceObj.gender === "Male"
                                      ? "bg-blue-950 text-blue-400 border border-blue-800/30"
                                      : activeVoiceObj.gender === "Female"
                                      ? "bg-pink-950 text-pink-400 border border-pink-800/30"
                                      : "bg-slate-800 text-slate-400 border border-slate-700/30"
                                  }`}
                                >
                                  {activeVoiceObj.gender}
                                </span>
                              </div>
                              <p className="text-[10px] text-slate-400 leading-normal truncate">{activeVoiceObj.description}</p>
                            </div>
                          );
                        })()}
                      </div>
                      <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform flex-shrink-0 ${isVoiceDropdownOpen ? "rotate-180" : ""}`} />
                    </button>

                    {/* Collapsible Dropdown List */}
                    <AnimatePresence>
                      {isVoiceDropdownOpen && (
                        <motion.div
                          initial={{ opacity: 0, y: -8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0, y: -8 }}
                          className="absolute z-50 left-0 right-0 bg-[#121622] border border-[#2d364f] rounded-lg shadow-2xl overflow-hidden max-h-72 flex flex-col mt-1"
                          style={{ top: "100%" }}
                        >
                          {/* Inside Dropdown Search */}
                          <div className="p-2 border-b border-[#222a3d] bg-[#0c0e14]">
                            <input
                              type="text"
                              placeholder="جستجوی گوینده..."
                              value={voiceSearchQuery}
                              onChange={(e) => setVoiceSearchQuery(e.target.value)}
                              className="w-full bg-[#121622] border border-[#232a3e] rounded-md px-2.5 py-1.5 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500 text-right"
                              dir="rtl"
                            />
                          </div>

                          {/* Voices Options */}
                          <div className="overflow-y-auto flex-1 p-1 flex flex-col gap-1">
                            {(() => {
                              const filtered = DUBBING_VOICES.filter((v) =>
                                v.name.toLowerCase().includes(voiceSearchQuery.toLowerCase()) ||
                                v.description.toLowerCase().includes(voiceSearchQuery.toLowerCase()) ||
                                v.gender.toLowerCase().includes(voiceSearchQuery.toLowerCase())
                              );

                              if (filtered.length === 0) {
                                return (
                                  <div className="py-6 text-center text-[11px] text-slate-500" dir="rtl">
                                    گوینده‌ای پیدا نشد
                                  </div>
                                );
                              }

                              return filtered.map((v) => {
                                const isSelected = selectedVoice === v.id;
                                return (
                                  <button
                                    key={v.id}
                                    type="button"
                                    onClick={() => {
                                      setSelectedVoice(v.id);
                                      setIsVoiceDropdownOpen(false);
                                    }}
                                    className={`p-2.5 rounded-md text-left transition-all flex flex-col gap-0.5 cursor-pointer ${
                                      isSelected
                                        ? "bg-cyan-500/15 border border-cyan-500/35 shadow-md text-cyan-300"
                                        : "hover:bg-slate-800/60 border border-transparent"
                                    }`}
                                  >
                                    <div className="flex items-center justify-between w-full">
                                      <span className="font-bold text-xs text-slate-200">{v.name}</span>
                                      <span
                                        className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full uppercase ${
                                          v.gender === "Male"
                                            ? "bg-blue-950 text-blue-400 border border-blue-800/30"
                                            : v.gender === "Female"
                                            ? "bg-pink-950 text-pink-400 border border-pink-800/30"
                                            : "bg-slate-800 text-slate-400 border border-slate-700/30"
                                        }`}
                                      >
                                        {v.gender}
                                      </span>
                                    </div>
                                    <p className="text-[10px] text-slate-400 leading-normal">{v.description}</p>
                                  </button>
                                );
                              });
                            })()}
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* Podcast vs Timing Preservation Mode */}
                <div className="bg-[#0e111a] border border-[#1c2232] rounded-xl p-5 flex flex-col gap-3">
                  <h4 className="text-xs font-extrabold tracking-wider text-slate-400 uppercase flex items-center gap-2">
                    <Sliders className="w-3.5 h-3.5 text-cyan-400" />
                    Dubbing Delivery Mode
                  </h4>
                  <div className="grid grid-cols-2 gap-2 bg-[#121622] p-1.5 rounded-lg border border-[#22293c]">
                    <button
                      onClick={() => setPodcastMode(false)}
                      className={`py-2 text-center rounded-md font-bold text-xs transition-all ${
                        !podcastMode ? "bg-cyan-500 text-white shadow-md shadow-cyan-500/10" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      Dub Video Timings
                    </button>
                    <button
                      onClick={() => setPodcastMode(true)}
                      className={`py-2 text-center rounded-md font-bold text-xs transition-all ${
                        podcastMode ? "bg-cyan-500 text-white shadow-md shadow-cyan-500/10" : "text-slate-400 hover:text-slate-200"
                      }`}
                    >
                      Podcast Mode
                    </button>
                  </div>
                  <p className="text-[10px] text-slate-400 leading-normal">
                    {!podcastMode
                      ? "Dubbed voice timing is tightly synced to match original dialogue speed and intervals."
                      : "Dialogue timing is fully ignored. Dubbed segments play back sequentially at natural speed."}
                  </p>
                </div>

                {/* Collapsible Advanced Settings */}
                <div className="bg-[#0e111a] border border-[#1c2232] rounded-xl overflow-hidden">
                  <button
                    onClick={() => setShowAdvanced(!showAdvanced)}
                    className="w-full px-5 py-3.5 flex items-center justify-between text-left hover:bg-slate-900 transition-all"
                  >
                    <div className="flex items-center gap-2 text-xs font-extrabold tracking-wider text-slate-300 uppercase">
                      <Settings className="w-3.5 h-3.5 text-cyan-400" />
                      Advanced Alignment Parameters
                    </div>
                    {showAdvanced ? (
                      <ChevronUp className="w-4 h-4 text-slate-400" />
                    ) : (
                      <ChevronDown className="w-4 h-4 text-slate-400" />
                    )}
                  </button>

                  <AnimatePresence>
                    {showAdvanced && (
                      <motion.div
                        initial={{ height: 0 }}
                        animate={{ height: "auto" }}
                        exit={{ height: 0 }}
                        className="overflow-hidden border-t border-[#1a1f2b]"
                      >
                        <div className="p-5 flex flex-col gap-5 bg-[#0e111a]">
                          {/* Keep original track option */}
                          <div className="flex flex-col gap-2.5">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-slate-200">Keep Original Audio Track</span>
                              <input
                                type="checkbox"
                                checked={keepOriginal}
                                onChange={(e) => setKeepOriginal(e.target.checked)}
                                className="w-4 h-4 rounded text-cyan-500 border-slate-700 bg-[#121622] outline-none"
                              />
                            </div>
                            <p className="text-[10px] text-slate-400 leading-normal">
                              Plays original background audio/effects underneath the new dubbed track.
                            </p>
                            {keepOriginal && (
                              <div className="flex flex-col gap-1.5 mt-1 bg-[#121622] p-3 rounded-lg border border-[#20273a]">
                                <div className="flex items-center justify-between text-[11px] font-mono">
                                  <span className="text-slate-400">Original Volume</span>
                                  <span className="text-cyan-400 font-bold">{Math.round(originalVolume * 100)}%</span>
                                </div>
                                <input
                                  type="range"
                                  min="0"
                                  max="1"
                                  step="0.05"
                                  value={originalVolume}
                                  onChange={(e) => setOriginalVolume(parseFloat(e.target.value))}
                                  className="w-full accent-cyan-500 bg-slate-800 h-1.5 rounded-lg appearance-none cursor-pointer"
                                />
                              </div>
                            )}
                          </div>

                          <hr className="border-[#1b212f]" />

                          {/* Allow timeline stretch option */}
                          <div className="flex flex-col gap-2.5">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-slate-200">Timeline Pitch/Speed Stretching</span>
                              <input
                                type="checkbox"
                                checked={allowStretch}
                                onChange={(e) => setAllowStretch(e.target.checked)}
                                className="w-4 h-4 rounded text-cyan-500 border-slate-700 bg-[#121622] outline-none"
                              />
                            </div>
                            <p className="text-[10px] text-slate-400 leading-normal">
                              Invisibly stretches/slows the overall video runtime slightly to create breathing space for translation lines.
                            </p>
                            {allowStretch && (
                              <div className="flex flex-col gap-1.5 mt-1 bg-[#121622] p-3 rounded-lg border border-[#20273a]">
                                <div className="flex items-center justify-between text-[11px] font-mono">
                                  <span className="text-slate-400">Max Stretching Limit</span>
                                  <span className="text-cyan-400 font-bold">{maxStretch}%</span>
                                </div>
                                <input
                                  type="range"
                                  min="1"
                                  max="15"
                                  step="1"
                                  value={maxStretch}
                                  onChange={(e) => setMaxStretch(parseInt(e.target.value, 10))}
                                  className="w-full accent-cyan-500 bg-slate-800 h-1.5 rounded-lg appearance-none cursor-pointer"
                                />
                              </div>
                            )}
                          </div>

                          <hr className="border-[#1b212f]" />

                          {/* Speed Balancing */}
                          <div className="flex flex-col gap-2.5">
                            <div className="flex items-center justify-between">
                              <span className="text-xs font-semibold text-slate-200">Balance Segment Speeds</span>
                              <input
                                type="checkbox"
                                checked={balanceSpeed}
                                onChange={(e) => setBalanceSpeed(e.target.checked)}
                                className="w-4 h-4 rounded text-cyan-500 border-slate-700 bg-[#121622] outline-none"
                              />
                            </div>
                            <p className="text-[10px] text-slate-400 leading-normal">
                              Averages speaking speed across neighboring timelines to prevent frantic burst talking on dense segments.
                            </p>
                            {balanceSpeed && (
                              <div className="flex flex-col gap-1.5 mt-1 bg-[#121622] p-3 rounded-lg border border-[#20273a]">
                                <div className="flex items-center justify-between text-[11px] font-mono">
                                  <span className="text-slate-400">Maximum Speed factor</span>
                                  <span className="text-cyan-400 font-bold">{maxSpeedFactor}x</span>
                                </div>
                                <input
                                  type="range"
                                  min="1.4"
                                  max="2.0"
                                  step="0.05"
                                  value={maxSpeedFactor}
                                  onChange={(e) => setMaxSpeedFactor(parseFloat(e.target.value))}
                                  className="w-full accent-cyan-500 bg-slate-800 h-1.5 rounded-lg appearance-none cursor-pointer"
                                />
                              </div>
                            )}
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </AnimatePresence>
                </div>

                {/* Big Render Dub Action Box */}
                <button
                  onClick={handleStartDubbing}
                  disabled={!fileId || segments.length === 0 || (activeJob ? ["pending", "processing"].includes(activeJob.status) : false)}
                  className="w-full py-3.5 bg-gradient-to-r from-cyan-500 to-indigo-600 hover:from-cyan-400 hover:to-indigo-500 text-white rounded-xl font-bold text-sm shadow-xl shadow-cyan-500/10 flex items-center justify-center gap-2 transition-all disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Sparkles className="w-4.5 h-4.5" />
                  {segments.length === 0 ? "No Segments to Render" : "Compile & Render Dubbed File"}
                </button>

                {renderError && (
                  <div className="bg-red-500/10 border border-red-500/20 text-red-400 p-4.5 rounded-xl flex items-center gap-3 text-xs leading-relaxed">
                    <AlertCircle className="w-4.5 h-4.5 flex-shrink-0" />
                    <p>{renderError}</p>
                  </div>
                )}

                {/* Job Rendering progress box */}
                {activeJob && (
                  <div className="bg-[#0e111a] border border-[#1e2535] rounded-xl p-5 flex flex-col gap-4">
                    <div className="flex items-center justify-between text-xs font-extrabold uppercase tracking-wider text-slate-400">
                      <span>Render Status</span>
                      <span className="font-mono text-[10px] text-slate-500">#{activeJob.id}</span>
                    </div>

                    <div className="flex items-start gap-3">
                      {activeJob.status === "completed" ? (
                        <div className="p-1.5 bg-emerald-500/10 text-emerald-400 rounded-full border border-emerald-800/20 mt-0.5">
                          <CheckCircle2 className="w-4 h-4" />
                        </div>
                      ) : activeJob.status === "failed" ? (
                        <div className="p-1.5 bg-red-500/10 text-red-400 rounded-full border border-red-800/20 mt-0.5">
                          <AlertCircle className="w-4 h-4" />
                        </div>
                      ) : (
                        <div className="p-1.5 bg-cyan-500/10 text-cyan-400 rounded-full mt-0.5 animate-spin">
                          <Loader2 className="w-4 h-4" />
                        </div>
                      )}
                      <div>
                        <h5 className="text-xs font-bold text-slate-200">
                          {activeJob.status === "completed"
                            ? "Compile Complete!"
                            : activeJob.status === "failed"
                            ? "Compilation Failed"
                            : "Processing Mix..."}
                        </h5>
                        <p className="text-[11px] text-slate-400 leading-normal mt-0.5">{activeJob.message}</p>
                        {activeJob.status === "failed" && activeJob.error && (
                          <p className="text-[10px] text-red-400 font-mono mt-1 bg-red-950/20 p-2 rounded border border-red-900/30 whitespace-pre-wrap">{activeJob.error}</p>
                        )}
                      </div>
                    </div>

                    {/* Progress Bar */}
                    <div className="w-full bg-[#121622] h-2 rounded-full overflow-hidden border border-[#1a202d]">
                      <div
                        className="bg-gradient-to-r from-cyan-500 to-indigo-600 h-full transition-all duration-500"
                        style={{ width: `${activeJob.progress}%` }}
                      />
                    </div>

                    {/* Live Dubbing & Segments Logs */}
                    <div className="w-full mt-1">
                      <LiveLogViewer
                        logs={activeJob.logs || []}
                        stageName="دوبله و سگمنت‌ها"
                        title="گزارش زنده صداگذاری و سینک سگمنت‌ها"
                        isProcessing={activeJob.status === "processing" || activeJob.status === "pending"}
                        defaultExpanded={true}
                      />
                    </div>

                    {/* Output Download Link & Player if finished */}
                    {activeJob.status === "completed" && activeJob.resultUrl && (() => {
                      const betterResultUrl = activeJob.resultUrl.startsWith("/output/")
                        ? `/api/download-dubbed?file=${activeJob.resultUrl.replace("/output/", "")}`
                        : activeJob.resultUrl;
                      return (
                        <div className="flex flex-col gap-3.5 mt-1 border-t border-[#1d2333] pt-4.5">
                          {isBlobLoading && (
                            <div className="flex flex-col items-center justify-center py-8 text-center text-xs text-slate-400 gap-2.5">
                              <Loader2 className="w-6 h-6 text-cyan-400 animate-spin" />
                              <span>در حال آماده‌سازی و بارگذاری امن فایل ویدیو...</span>
                            </div>
                          )}

                          {blobLoadError && (
                            <div className="flex flex-col items-center justify-center p-4 text-center bg-amber-500/10 border border-amber-500/20 rounded-lg text-xs text-amber-400 gap-1.5" dir="rtl">
                              <div className="flex items-center gap-1.5 font-bold">
                                <AlertCircle className="w-4 h-4 text-amber-400" />
                                <span>محدودیت امنیتی فریم (Cookie Challenge)</span>
                              </div>
                              <p className="text-[10px] text-slate-300 leading-relaxed text-right">
                                به دلیل محدودیت‌های فریم شبیه‌ساز مرورگر، در صورتی که ویدیو در زیر پخش نشد یا لود نشد، لطفاً دکمه آبی رنگ زیر را بزنید تا ویدیو را در پنجره مستقیم تماشا و ذخیره کنید.
                              </p>
                              <div className="flex gap-2 mt-1.5 w-full">
                                <button
                                  onClick={() => fetchMediaBlob(betterResultUrl)}
                                  className="flex-1 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded font-semibold text-[9px]"
                                >
                                  تلاش مجدد اتصال امن
                                </button>
                                <a
                                  href={betterResultUrl + (betterResultUrl.includes("?") ? "&download=true" : "?download=true")}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  className="flex-1 py-1 bg-[#1a7f9a] hover:bg-[#166c83] text-white rounded font-semibold text-[9px] text-center"
                                >
                                  باز کردن مستقیم در تب جدید ↗
                                </a>
                              </div>
                            </div>
                          )}

                          {!isBlobLoading && (
                            <>
                              <div className="w-full rounded-lg overflow-hidden bg-black/60 border border-[#1c2231] flex flex-col items-center justify-center p-4">
                                <p className="text-[10px] font-bold text-slate-400 mb-2 uppercase tracking-wide">
                                  Preview Render Output
                                </p>
                                {fileType === "video" ? (
                                  <video
                                    src={mediaBlobUrl || betterResultUrl}
                                    controls
                                    className="w-full max-h-[150px] bg-black rounded"
                                  />
                                ) : (
                                  <audio src={mediaBlobUrl || betterResultUrl} controls className="w-full mt-1" />
                                )}
                              </div>

                              <div className="flex flex-col gap-2 w-full">
                                <a
                                  href={mediaBlobUrl || (betterResultUrl + (betterResultUrl.includes("?") ? "&download=true" : "?download=true"))}
                                  download={fileName ? `dubbed_${fileName}` : "dubbed_media.mp4"}
                                  className="w-full py-2.5 bg-emerald-500 hover:bg-emerald-400 text-white font-bold text-xs rounded-lg flex items-center justify-center gap-1.5 shadow-lg shadow-emerald-500/10 transition-all text-center"
                                >
                                  <Download className="w-4 h-4" />
                                  دانلود ویدیوی دوبله شده
                                </a>

                                <button
                                  type="button"
                                  onClick={() => handleSaveToColabDrive(getFileNameFromUrl(activeJob.resultUrl || ""), "main")}
                                  disabled={isSavingToDrive["main"]}
                                  className="w-full py-2 bg-slate-800 hover:bg-cyan-950/60 hover:border-cyan-500/40 border border-[#202738] text-cyan-300 font-bold text-xs rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
                                >
                                  {isSavingToDrive["main"] ? (
                                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                                  ) : (
                                    <HardDrive className="w-3.5 h-3.5" />
                                  )}
                                  <span>ذخیره مستقیم در گوگل درایو کولب (/content/drive/MyDrive)</span>
                                </button>
                              </div>

                              {saveToDriveResult["main"] && (
                                <div className="p-2.5 bg-cyan-950/30 border border-cyan-800/30 rounded-lg text-xs flex items-start gap-2 text-right" dir="rtl">
                                  <CheckCircle2 className="w-4 h-4 text-emerald-400 mt-0.5 shrink-0" />
                                  <p className="text-[11px] text-slate-200">{saveToDriveResult["main"]}</p>
                                </div>
                              )}

                              {activeJob.audioResultUrl && (
                                <div className="mt-3 p-3.5 rounded-lg bg-[#111622] border border-[#1d273a] flex flex-col gap-2" dir="rtl">
                                  <div className="flex items-center justify-between">
                                    <span className="text-[11px] font-bold text-cyan-400 flex items-center gap-1.5">
                                      🎵 نسخه صوتی دوبله (فرمت MP3)
                                    </span>
                                    <span className="text-[9px] text-slate-400 bg-cyan-950/40 text-cyan-400 border border-cyan-900/40 px-1.5 py-0.5 rounded-full font-mono">
                                      MP3 Track
                                    </span>
                                  </div>
                                  <audio 
                                    src={audioBlobUrl || activeJob.audioResultUrl} 
                                    controls 
                                    className="w-full h-8 mt-1" 
                                  />
                                  <div className="flex flex-col gap-1.5 w-full">
                                    <a
                                      href={audioBlobUrl || (activeJob.audioResultUrl + (activeJob.audioResultUrl.includes("?") ? "&download=true" : "?download=true"))}
                                      download={fileName ? `dubbed_${fileName.replace(/\.[^/.]+$/, "")}.mp3` : "dubbed_audio.mp3"}
                                      className="w-full py-2 bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-[11px] rounded-lg flex items-center justify-center gap-1.5 transition-all text-center"
                                    >
                                      <Download className="w-3.5 h-3.5" />
                                      دانلود نسخه صوتی دوبله شده (MP3)
                                    </a>

                                    <button
                                      type="button"
                                      onClick={() => handleSaveToColabDrive(getFileNameFromUrl(activeJob.audioResultUrl || ""), "audio")}
                                      disabled={isSavingToDrive["audio"]}
                                      className="w-full py-1.5 bg-[#171d2b] hover:bg-slate-800 text-slate-300 text-[10px] font-semibold rounded-lg flex items-center justify-center gap-1.5 transition-all cursor-pointer disabled:opacity-50"
                                    >
                                      {isSavingToDrive["audio"] ? (
                                        <Loader2 className="w-3 h-3 animate-spin" />
                                      ) : (
                                        <HardDrive className="w-3 h-3 text-cyan-400" />
                                      )}
                                      <span>ذخیره نسخه صوتی در درایو کولب</span>
                                    </button>
                                  </div>

                                  {saveToDriveResult["audio"] && (
                                    <div className="p-2 bg-cyan-950/30 border border-cyan-800/30 rounded-lg text-xs flex items-start gap-1.5 text-right" dir="rtl">
                                      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 mt-0.5 shrink-0" />
                                      <p className="text-[10px] text-slate-200">{saveToDriveResult["audio"]}</p>
                                    </div>
                                  )}
                                </div>
                              )}

                              <div className="text-center mt-1">
                                <p className="text-[9px] text-slate-500 leading-normal" dir="rtl">
                                  💡 در صورت عدم شروع دانلود، می‌توانید ویدیو را در{" "}
                                  <a
                                    href={betterResultUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-cyan-400 underline hover:text-cyan-300 font-bold"
                                  >
                                    تب جدید
                                  </a>{" "}
                                  باز کرده و مستقیماً تماشا یا دانلود (کلید ترکیبی Ctrl+S) کنید.
                                </p>
                              </div>
                            </>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}
              </div>

              {/* Right Column: Interactive Subtitles Timelines Workspace */}
              <div className={`flex-1 flex flex-col bg-[#07090d] overflow-hidden ${
                activeWorkspaceTab === "timeline" ? "flex" : "hidden lg:flex"
              }`}>
                {/* Workspace Header Panel */}
                <div className="border-b border-[#181d29] px-6 py-4 flex flex-col md:flex-row md:items-center md:justify-between gap-4 bg-[#0a0d14]">
                  <div>
                    <h2 className="text-lg font-extrabold tracking-tight font-display text-white">
                      Translation Timeline Workspace
                    </h2>
                    <p className="text-xs text-slate-400">
                      Manage transcription timelines, edit dialogue segments, and auto-translate original parts.
                    </p>
                  </div>

                  {/* Draft Translate actions */}
                  <div className="flex items-center gap-2">
                    <button
                      onClick={handleTranslateAllSubtitles}
                      disabled={isTranslating || segments.length === 0}
                      className="flex items-center gap-2 px-4 py-2 text-xs font-bold bg-cyan-600 hover:bg-cyan-500 disabled:bg-cyan-900/30 text-white rounded-lg transition-all"
                    >
                      {isTranslating ? (
                        <>
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                          AI Translating...
                        </>
                      ) : (
                        <>
                          <Sparkles className="w-3.5 h-3.5" />
                          Auto-Translate Subtitles
                        </>
                      )}
                    </button>

                    <button
                      onClick={handleAddSegment}
                      className="flex items-center gap-1.5 px-3 py-2 text-xs font-semibold bg-slate-800 hover:bg-slate-700 text-slate-200 hover:text-white rounded-lg border border-[#232b3c] transition-all"
                    >
                      <Plus className="w-3.5 h-3.5" />
                      Add Segment
                    </button>
                  </div>
                </div>

                {/* Subtitles Filter & Info */}
                <div className="px-6 py-3 border-b border-[#141822] bg-[#090b10] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                  <div className="flex items-center gap-2 font-mono text-xs text-slate-400 bg-slate-900 px-3 py-1.5 rounded border border-[#1c2231]">
                    <span>Subtitles Count:</span>
                    <span className="font-bold text-cyan-400">{segments.length} segments</span>
                  </div>

                  {/* Subtitles Search bar */}
                  <div className="relative max-w-xs w-full">
                    <Search className="w-4 h-4 text-slate-400 absolute left-3 top-2.5 pointer-events-none" />
                    <input
                      type="text"
                      placeholder="Search subtitles..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="w-full bg-[#11141c] border border-[#202737] rounded-lg pl-9 pr-4 py-1.5 text-xs text-slate-200 outline-none focus:border-cyan-500 transition-all"
                    />
                  </div>
                </div>

                {/* Subtitle segments scrollable view */}
                <div className="flex-1 overflow-y-auto px-6 py-6 flex flex-col gap-4">
                  {/* Translation Live Progress & Logs Banner */}
                  {(isTranslating || translationLogs.length > 0) && (
                    <div className="flex flex-col gap-2 bg-[#0d1017] border border-cyan-500/20 rounded-xl p-4 shadow-lg">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {isTranslating ? (
                            <Loader2 className="w-4 h-4 text-cyan-400 animate-spin" />
                          ) : (
                            <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                          )}
                          <span className="text-xs font-bold text-slate-200">
                            {isTranslating ? "فرآیند ترجمه موازی هوشمند در حال انجام است..." : "گزارش فرآیند ترجمه دیالوگ‌ها"}
                          </span>
                        </div>
                        {isTranslating && (
                          <span className="text-xs font-mono text-cyan-400 font-bold">{translationProgress}%</span>
                        )}
                      </div>

                      {isTranslating && (
                        <div className="w-full bg-slate-900 h-1.5 rounded-full overflow-hidden border border-slate-800">
                          <div
                            className="bg-gradient-to-r from-cyan-500 to-indigo-500 h-full transition-all duration-300"
                            style={{ width: `${translationProgress}%` }}
                          />
                        </div>
                      )}

                      {translationMessage && (
                        <p className="text-[11px] text-slate-400 font-mono" dir="rtl">{translationMessage}</p>
                      )}

                      <div className="mt-1">
                        <LiveLogViewer
                          logs={translationLogs}
                          stageName="ترجمه"
                          title="گزارش زنده کارگرهای هوش مصنوعی ترجمه"
                          isProcessing={isTranslating}
                          defaultExpanded={isTranslating}
                        />
                      </div>
                    </div>
                  )}

                  {(() => {
                    const fastSegmentsCount = segments.filter(seg => calculateWpm(seg.text, seg.startTime, seg.endTime) > 150).length;
                    if (fastSegmentsCount === 0) return null;
                    return (
                      <div className="p-4 bg-amber-950/20 border border-amber-900/40 text-amber-300 rounded-xl flex items-start gap-3 text-xs leading-relaxed animate-pulse" dir="rtl">
                        <AlertCircle className="w-5 h-5 text-amber-400 flex-shrink-0 mt-0.5" />
                        <div>
                          <h4 className="font-bold text-slate-100 mb-1 text-right">
                            تراکم و سرعت گفتار بالا شناسایی شد ({fastSegmentsCount} بخش سریع)
                          </h4>
                          <p className="text-slate-300 text-right">
                            در این ویدیو گوینده در برخی بخش‌ها با سرعت زیادی صحبت می‌کند. ترجمه مستقیم این دیالوگ‌ها به فارسی ممکن است باعث طولانی شدن متن و ناهماهنگی در صداگذاری (تداخل و عقب ماندن دوبلور) شود.
                          </p>
                          <p className="text-slate-300 mt-1.5 text-right">
                            💡 <strong>راهکار پیشنهادی:</strong> حتماً گزینه <strong>«خلاصه‌سازی هوشمند دیالوگ‌ها»</strong> را در منوی تنظیمات سمت چپ فعال کنید تا مدل هوش مصنوعی ما متن ترجمه را به صورت خلاصه و متناسب با زمان ویدیو بهینه‌سازی کند.
                          </p>
                        </div>
                      </div>
                    );
                  })()}

                  {filteredSegments.length === 0 ? (
                    <div className="text-center py-16 border border-[#1b212f] border-dashed rounded-2xl p-8 max-w-md mx-auto my-12 bg-[#0c0e14]">
                      <FileText className="w-12 h-12 text-slate-500 mx-auto mb-4" />
                      <h4 className="font-bold text-slate-300 text-sm">No timeline segments matching search</h4>
                      <p className="text-xs text-slate-400 mt-2 max-w-xs mx-auto leading-normal">
                        Try modifying your filter query or add a brand new segment to get started!
                      </p>
                    </div>
                  ) : (
                    filteredSegments.map((seg, i) => {
                      const segIndex = segments.findIndex((s) => s.id === seg.id);
                      const origWpm = calculateWpm(seg.text, seg.startTime, seg.endTime);
                      const transWpm = calculateWpm(seg.translatedText || "", seg.startTime, seg.endTime);
                      const origStatus = getSpeedStatus(origWpm);
                      const transStatus = getSpeedStatus(transWpm);
                      return (
                        <div
                          key={seg.id}
                          className="bg-[#0c0e14] border border-[#1c2231] hover:border-slate-800 rounded-xl p-4 flex flex-col md:flex-row gap-4 transition-all relative group"
                        >
                          {/* Segment Meta column */}
                          <div className="flex flex-row md:flex-col justify-between md:justify-start items-center md:items-start gap-2 flex-shrink-0 w-full md:w-[130px] border-b md:border-b-0 md:border-r border-[#191f2c] pb-3 md:pb-0 md:pr-4">
                            <span className="text-xs font-extrabold text-cyan-400 font-mono">
                              SEGMENT #{segIndex + 1}
                            </span>
                            
                            {/* Precise timestamps editor */}
                            <div className="flex flex-col gap-1 w-full max-w-[120px] md:max-w-none">
                              <div className="flex items-center gap-1.5 text-[10px] font-mono text-slate-400">
                                <Clock className="w-3 h-3 text-slate-500" />
                                <span>Timeline Range</span>
                              </div>
                              <input
                                type="text"
                                value={seg.startTime}
                                onChange={(e) => handleUpdateSegmentTime(segIndex, "startTime", e.target.value)}
                                className="bg-[#121622] border border-[#20273a] rounded px-2 py-1 text-[10px] font-mono text-slate-200 outline-none focus:border-cyan-500 text-center"
                                placeholder="00:00:00,000"
                              />
                              <div className="text-center text-slate-600 text-[9px] font-mono">to</div>
                              <input
                                type="text"
                                value={seg.endTime}
                                onChange={(e) => handleUpdateSegmentTime(segIndex, "endTime", e.target.value)}
                                className="bg-[#121622] border border-[#20273a] rounded px-2 py-1 text-[10px] font-mono text-slate-200 outline-none focus:border-cyan-500 text-center"
                                placeholder="00:00:00,000"
                              />
                            </div>

                            {/* Delete segment button */}
                            <button
                              onClick={() => handleDeleteSegment(segIndex)}
                              className="mt-2 md:mt-auto text-slate-500 hover:text-red-400 p-1.5 hover:bg-red-500/5 rounded transition-all opacity-100 md:opacity-0 md:group-hover:opacity-100 self-end md:self-start"
                              title="Delete segment"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>

                          {/* Dual dialogue texts */}
                          <div className="flex-1 grid grid-cols-1 md:grid-cols-2 gap-4">
                            {/* Original Dialog Transcript Card */}
                            <div className="flex flex-col gap-1.5">
                              <span className="text-[10px] font-extrabold text-slate-400 uppercase tracking-wider">
                                Original Transcript (Voice Input)
                              </span>
                              <textarea
                                value={seg.text}
                                onChange={(e) => handleUpdateSegmentText(segIndex, e.target.value, true)}
                                className="flex-1 min-h-[75px] bg-[#11141d] border border-[#20273a] rounded-lg p-3 text-xs text-slate-200 outline-none focus:border-cyan-500 transition-all resize-none leading-relaxed"
                                placeholder="Enter original spoken text..."
                              />
                              {origWpm > 0 && origStatus && (
                                <div className="flex flex-col gap-1 mt-1 bg-[#090b10]/40 p-1.5 rounded border border-[#1b212f]">
                                  <div className="flex items-center justify-between text-[10px] font-sans">
                                    <span className="text-slate-400">Pacing: <strong className="text-slate-200 font-mono">{origWpm} WPM</strong></span>
                                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${origStatus.color}`} dir="rtl">
                                      {origStatus.label}
                                    </span>
                                  </div>
                                  <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
                                    <div className={`h-full ${origStatus.barColor}`} style={{ width: `${origStatus.percentage}%` }} />
                                  </div>
                                </div>
                              )}
                            </div>

                            {/* Translated text to Speak */}
                            <div className="flex flex-col gap-1.5 relative">
                              <div className="flex items-center justify-between">
                                <span className="text-[10px] font-extrabold text-cyan-400 uppercase tracking-wider">
                                  Translated Dubbing Dialogue
                                </span>
                                {seg.text.trim() && (
                                  <button
                                    onClick={() => handleTranslateSegment(segIndex)}
                                    className="text-[10px] text-cyan-400 hover:text-cyan-300 font-bold flex items-center gap-0.5"
                                    title="Auto-translate this segment only"
                                  >
                                    <Sparkles className="w-2.5 h-2.5" />
                                    Translate
                                  </button>
                                )}
                              </div>
                              <textarea
                                value={seg.translatedText || ""}
                                onChange={(e) => handleUpdateSegmentText(segIndex, e.target.value, false)}
                                className="flex-1 min-h-[75px] bg-[#11141d] border border-[#20273a] focus:border-cyan-500 rounded-lg p-3 text-xs text-cyan-200 outline-none transition-all resize-none leading-relaxed"
                                placeholder="Translate dialogue here... (This text will be dubbed to audio)"
                              />
                              {transWpm > 0 && transStatus && (
                                <div className="flex flex-col gap-1 mt-1 bg-[#090b10]/40 p-1.5 rounded border border-[#1b212f]">
                                  <div className="flex items-center justify-between text-[10px] font-sans">
                                    <span className="text-slate-400">Pacing: <strong className="text-slate-200 font-mono">{transWpm} WPM</strong></span>
                                    <span className={`px-1.5 py-0.5 rounded text-[9px] font-bold border ${transStatus.color}`} dir="rtl">
                                      {transStatus.label}
                                    </span>
                                  </div>
                                  <div className="w-full bg-slate-800 h-1 rounded-full overflow-hidden">
                                    <div className={`h-full ${transStatus.barColor}`} style={{ width: `${transStatus.percentage}%` }} />
                                  </div>
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Global AI Real-Time Execution Logs Modal */}
      {showLiveLogsModal && (
        <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-sm flex items-center justify-center p-4">
          <motion.div
            initial={{ opacity: 0, scale: 0.95 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className="bg-[#0b0e15] border border-cyan-500/30 rounded-2xl w-full max-w-3xl overflow-hidden shadow-2xl flex flex-col max-h-[85vh]"
          >
            {/* Modal Header */}
            <div className="px-6 py-4 border-b border-[#1b2232] bg-[#0f131c] flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="p-2 bg-cyan-500/10 text-cyan-400 rounded-lg border border-cyan-500/20">
                  <Terminal className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-sm font-bold text-slate-100 flex items-center gap-2">
                    <span>کنسول گزارش‌های زنده هوش مصنوعی (AI Live Console)</span>
                    <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
                  </h3>
                  <p className="text-[11px] text-slate-400">
                    مشاهده لحظه‌ای مدل‌های فعال (Gemini 3.7 Flash, 3.6 Flash, 3.5 Lite, 3.1 Lite) و گزارش مراحل
                  </p>
                </div>
              </div>
              <button
                onClick={() => setShowLiveLogsModal(false)}
                className="px-3 py-1.5 bg-slate-800 hover:bg-slate-700 text-slate-300 hover:text-white rounded-lg text-xs font-bold transition-all cursor-pointer"
              >
                بستن ✕
              </button>
            </div>

            {/* Modal Content with all stages */}
            <div className="p-6 overflow-y-auto flex flex-col gap-6 flex-1">
              {/* Stage 1: Extraction */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-cyan-400 flex items-center gap-1.5">
                    <span>۱. مرحله استخراج زیرنویس و دیالوگ‌ها</span>
                    <span className="text-[10px] text-slate-500 font-mono">(gemini-3.7-flash / gemini-3.6-flash)</span>
                  </h4>
                  <span className="text-[10px] text-slate-400 font-mono">{transcribeLogs.length} خط</span>
                </div>
                <LiveLogViewer
                  logs={transcribeLogs}
                  stageName="استخراج"
                  title="گزارش مرحله استخراج"
                  isProcessing={isUploading}
                  defaultExpanded={true}
                />
              </div>

              {/* Stage 2: Translation */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-indigo-400 flex items-center gap-1.5">
                    <span>۲. مرحله ترجمه موازی با ۳ کارگر</span>
                    <span className="text-[10px] text-slate-500 font-mono">(gemini-3.5-flash-lite / gemini-3.1-flash-lite)</span>
                  </h4>
                  <span className="text-[10px] text-slate-400 font-mono">{translationLogs.length} خط</span>
                </div>
                <LiveLogViewer
                  logs={translationLogs}
                  stageName="ترجمه"
                  title="گزارش مرحله ترجمه موازی"
                  isProcessing={isTranslating}
                  defaultExpanded={true}
                />
              </div>

              {/* Stage 3: Dubbing & Segments */}
              <div className="flex flex-col gap-2">
                <div className="flex items-center justify-between">
                  <h4 className="text-xs font-bold text-purple-400 flex items-center gap-1.5">
                    <span>۳. مرحله صداگذاری، کشش و سینک سگمنت‌ها</span>
                    <span className="text-[10px] text-slate-500 font-mono">(Gemini Live Audio / TTS & FFmpeg)</span>
                  </h4>
                  <span className="text-[10px] text-slate-400 font-mono">{activeJob?.logs?.length || 0} خط</span>
                </div>
                <LiveLogViewer
                  logs={activeJob?.logs || []}
                  stageName="دوبله و سگمنت‌ها"
                  title="گزارش مرحله صداگذاری و سینک"
                  isProcessing={activeJob?.status === "processing" || activeJob?.status === "pending"}
                  defaultExpanded={true}
                />
              </div>
            </div>

            {/* Modal Footer */}
            <div className="px-6 py-3 border-t border-[#1b2232] bg-[#0c0e14] flex items-center justify-between text-xs text-slate-400">
              <span className="font-mono text-[10px] text-slate-500">
                Studio Runtime Rate Limit: 5 RPM (Transcription) | 15 RPM (Translation)
              </span>
              <button
                onClick={() => setShowLiveLogsModal(false)}
                className="px-4 py-1.5 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-xs font-bold transition-all"
              >
                تأیید
              </button>
            </div>
          </motion.div>
        </div>
      )}

      {/* API Key Registration Modal */}
      {isApiKeyModalOpen && (
        <div className="fixed inset-0 bg-black/75 backdrop-blur-sm z-50 flex items-center justify-center p-4" dir="rtl">
          <div className="bg-[#0e1320] border border-[#232d42] rounded-2xl p-6 max-w-md w-full shadow-2xl relative animate-in fade-in zoom-in-95 duration-200">
            <button
              onClick={() => setIsApiKeyModalOpen(false)}
              className="absolute top-4 left-4 text-slate-400 hover:text-white p-1 rounded-lg hover:bg-slate-800 transition-all cursor-pointer"
            >
              <X className="w-5 h-5" />
            </button>

            <div className="flex items-center gap-3 mb-4">
              <div className="p-2.5 bg-amber-500/20 text-amber-400 rounded-xl border border-amber-500/30">
                <Key className="w-5 h-5" />
              </div>
              <h3 className="text-base font-bold text-white">ثبت Gemini API Key اختصاصی</h3>
            </div>

            <p className="text-xs text-slate-300 leading-relaxed mb-4">
              کلید API اختصاصی شما به صورت امن در مرورگرتان ذخیره می‌شود و برای پردازش و ترجمه‌های هوش مصنوعی استفاده خواهد شد.
            </p>

            <div className="space-y-3 mb-5">
              <input
                type="password"
                value={apiKeyInput}
                onChange={(e) => setApiKeyInput(e.target.value)}
                placeholder="AIzaSy..."
                className="w-full px-4 py-2.5 bg-[#151c2e] border border-[#2b3854] rounded-xl text-slate-100 placeholder-slate-500 text-xs font-mono focus:outline-none focus:border-amber-500 transition-all"
              />
            </div>

            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setIsApiKeyModalOpen(false)}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold rounded-xl transition-all cursor-pointer"
              >
                انصراف
              </button>
              <button
                onClick={handleSaveApiKey}
                className="px-5 py-2 bg-gradient-to-r from-amber-500 to-amber-600 hover:from-amber-400 hover:to-amber-500 text-slate-950 text-xs font-bold rounded-xl shadow-md transition-all cursor-pointer"
              >
                ذخیره کلید
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Google Drive Picker removed to prevent OAuth 403 blocks */}
    </div>
  );
}
