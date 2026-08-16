import React, { useEffect, useRef, useState } from "react";
import { Terminal, Copy, Check, ChevronDown, ChevronUp, Cpu, Activity } from "lucide-react";
import { motion, AnimatePresence } from "motion/react";

interface LiveLogViewerProps {
  logs: string[];
  title?: string;
  stageName?: "استخراج" | "ترجمه" | "دوبله و سگمنت‌ها" | "عمومی";
  currentModel?: string;
  isProcessing?: boolean;
  className?: string;
  defaultExpanded?: boolean;
}

export const LiveLogViewer: React.FC<LiveLogViewerProps> = ({
  logs = [],
  title = "گزارش زنده پردازش هوش مصنوعی (Live Logs)",
  stageName,
  currentModel,
  isProcessing = false,
  className = "",
  defaultExpanded = true,
}) => {
  const [isExpanded, setIsExpanded] = useState(defaultExpanded);
  const [copied, setCopied] = useState(false);
  const logsEndRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new logs arrive
  useEffect(() => {
    if (isExpanded && logsEndRef.current) {
      logsEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [logs, isExpanded]);

  const handleCopyLogs = () => {
    if (logs.length === 0) return;
    navigator.clipboard.writeText(logs.join("\n"));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Determine current active model from recent log if not explicitly provided
  const detectedModel = React.useMemo(() => {
    if (currentModel) return currentModel;
    for (let i = logs.length - 1; i >= 0; i--) {
      const line = logs[i];
      if (line.includes("gemini-3.7-flash")) return "gemini-3.7-flash";
      if (line.includes("gemini-3.6-flash")) return "gemini-3.6-flash";
      if (line.includes("gemini-3.5-flash-lite")) return "gemini-3.5-flash-lite";
      if (line.includes("gemini-3.1-flash-lite")) return "gemini-3.1-flash-lite";
      if (line.includes("gemini-3.1-flash-live-preview")) return "gemini-3.1-flash-live-preview";
      if (line.includes("gemini-3.1-flash-tts-preview")) return "gemini-3.1-flash-tts-preview";
    }
    return null;
  }, [logs, currentModel]);

  const formatLogLine = (line: string) => {
    // Highlight model names
    const highlighted = line
      .replace(/(gemini-3\.7-flash)/g, '<span class="text-cyan-400 font-bold">$1</span>')
      .replace(/(gemini-3\.6-flash)/g, '<span class="text-indigo-400 font-bold">$1</span>')
      .replace(/(gemini-3\.5-flash-lite)/g, '<span class="text-emerald-400 font-bold">$1</span>')
      .replace(/(gemini-3\.1-flash-lite)/g, '<span class="text-teal-400 font-bold">$1</span>')
      .replace(/(gemini-3\.1-flash-live-preview)/g, '<span class="text-amber-400 font-bold">$1</span>')
      .replace(/(gemini-3\.1-flash-tts-preview)/g, '<span class="text-purple-400 font-bold">$1</span>')
      .replace(/(\[کارگر \d+\])/g, '<span class="text-sky-300 font-mono bg-sky-950/60 px-1 py-0.5 rounded text-[11px]">$1</span>')
      .replace(/(\[بخش \d+\/\d+\])/g, '<span class="text-yellow-300 font-mono bg-yellow-950/60 px-1 py-0.5 rounded text-[11px]">$1</span>')
      .replace(/(\[سگمنت \d+\/\d+\])/g, '<span class="text-purple-300 font-mono bg-purple-950/60 px-1 py-0.5 rounded text-[11px]">$1</span>');

    return highlighted;
  };

  return (
    <div
      className={`rounded-xl border border-[#1e2536] bg-[#090c13] shadow-2xl overflow-hidden font-sans text-xs ${className}`}
      dir="rtl"
    >
      {/* Header Bar */}
      <div className="bg-[#0e131d] border-b border-[#1b2230] px-4 py-2.5 flex items-center justify-between gap-2 select-none">
        <div className="flex items-center gap-2.5">
          <div className="p-1.5 rounded-lg bg-cyan-950/50 text-cyan-400 border border-cyan-800/30">
            <Terminal className="w-3.5 h-3.5" />
          </div>
          <div className="flex items-center gap-2">
            <span className="font-bold text-slate-200 text-xs">{title}</span>
            {isProcessing && (
              <span className="flex items-center gap-1 text-[10px] text-cyan-400 bg-cyan-950/60 border border-cyan-800/40 px-2 py-0.5 rounded-full animate-pulse">
                <Activity className="w-3 h-3 animate-spin" />
                در حال پردازش زنده
              </span>
            )}
            {stageName && (
              <span className="text-[10px] text-indigo-300 bg-indigo-950/60 border border-indigo-800/40 px-2 py-0.5 rounded-md">
                مرحله: {stageName}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2" dir="ltr">
          {detectedModel && (
            <div className="hidden sm:flex items-center gap-1.5 text-[11px] text-emerald-400 bg-emerald-950/40 border border-emerald-800/40 px-2.5 py-0.5 rounded-full font-mono">
              <Cpu className="w-3 h-3 text-emerald-400" />
              <span>{detectedModel}</span>
            </div>
          )}

          <button
            onClick={handleCopyLogs}
            disabled={logs.length === 0}
            title="کپی لاگ‌ها"
            className="p-1.5 rounded-lg bg-slate-800/60 hover:bg-slate-700 text-slate-300 hover:text-white border border-[#202738] transition-all disabled:opacity-40 cursor-pointer"
          >
            {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          </button>

          <button
            onClick={() => setIsExpanded(!isExpanded)}
            title={isExpanded ? "بستن گزارش" : "باز کردن گزارش"}
            className="p-1.5 rounded-lg bg-slate-800/60 hover:bg-slate-700 text-slate-300 hover:text-white border border-[#202738] transition-all cursor-pointer"
          >
            {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
        </div>
      </div>

      {/* Expandable Log Feed */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="overflow-hidden"
          >
            <div
              ref={scrollContainerRef}
              className="max-h-60 overflow-y-auto p-3.5 space-y-1.5 font-mono text-[11.5px] leading-relaxed select-text bg-[#07090e]"
              dir="rtl"
            >
              {logs.length === 0 ? (
                <div className="text-slate-500 italic text-center py-4">
                  هنوز لاگی ثبت نشده است. هنگام شروع فرآیند، وضعیت دقیق و لحظه‌ای مدل‌ها در اینجا نمایش داده می‌شود.
                </div>
              ) : (
                logs.map((log, index) => {
                  const isError = log.includes("❌") || log.includes("خطا") || log.toLowerCase().includes("error");
                  const isWarn = log.includes("⚠️") || log.includes("سوییچ");
                  const isSuccess = log.includes("✅") || log.includes("✨") || log.includes("تکمیل");

                  return (
                    <div
                      key={index}
                      className={`flex items-start gap-2 py-0.5 px-1.5 rounded transition-colors ${
                        isError
                          ? "bg-red-950/30 text-red-300 border-r-2 border-red-500"
                          : isWarn
                          ? "bg-amber-950/20 text-amber-200 border-r-2 border-amber-500"
                          : isSuccess
                          ? "text-emerald-300"
                          : "text-slate-300 hover:bg-slate-900/50"
                      }`}
                    >
                      <span className="text-slate-600 text-[10px] select-none font-mono min-w-[24px]">
                        {index + 1}.
                      </span>
                      <span
                        className="flex-1 whitespace-pre-wrap break-words"
                        dangerouslySetInnerHTML={{ __html: formatLogLine(log) }}
                      />
                    </div>
                  );
                })
              )}
              <div ref={logsEndRef} />
            </div>

            {/* Status Footer */}
            <div className="bg-[#0b0e15] border-t border-[#161d2b] px-3.5 py-1.5 flex items-center justify-between text-[10px] text-slate-400">
              <span className="font-mono">مجموع خطوط لاگ: {logs.length}</span>
              <span className="text-slate-500">پایش هوشمند مدل‌ها و نرخ درخواست (RPM)</span>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

