"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Eye, EyeOff, Key, Loader2, Save, X, ExternalLink } from "lucide-react";
import { useTranslations } from "next-intl";
import { api } from "@/lib/api";
import {
  DEFAULT_JIUCAIHEZI_CONFIG,
  hasJiucaiheziKey,
  normalizeJiucaiheziConfig,
  toJiucaiheziPayload,
  type JiucaiheziConfig,
} from "@/lib/jiucaiheziConfig";

interface EnvConfigDialogProps {
  isOpen: boolean;
  onClose: () => void;
  isRequired?: boolean;
}

export default function EnvConfigDialog({ isOpen, onClose, isRequired = false }: EnvConfigDialogProps) {
  const [config, setConfig] = useState<JiucaiheziConfig>(DEFAULT_JIUCAIHEZI_CONFIG);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [revealed, setRevealed] = useState(false);
  const t = useTranslations("project");
  const tc = useTranslations("common");

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setRevealed(false);
    setLoadError(null);
    api.getEnvConfig()
      .then((data) => setConfig(normalizeJiucaiheziConfig(data)))
      .catch(() => setLoadError(t("configLoadFailed")))
      .finally(() => setLoading(false));
  }, [isOpen, t]);

  const canClose = !isRequired || hasJiucaiheziKey(config);
  const requestClose = () => {
    if (canClose) onClose();
  };

  const handleSave = async () => {
    if (!hasJiucaiheziKey(config)) {
      alert(`${t("requiredFields")}\n- 韭菜盒子 API Key`);
      return;
    }
    setSaving(true);
    try {
      await api.saveEnvConfig(toJiucaiheziPayload(config));
      alert(t("configSaved"));
      onClose();
      if (isRequired) window.location.reload();
    } catch {
      alert(t("configSaveFailed"));
    } finally {
      setSaving(false);
    }
  };

  if (!isOpen) return null;
  const inputClass = "w-full bg-surface border border-glass-border rounded-lg px-4 py-2 text-foreground placeholder-text-muted focus:outline-none focus:border-primary/50 transition-colors";

  return (
    <AnimatePresence>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="fixed inset-0 z-50 flex items-center justify-center bg-overlay backdrop-blur-sm p-4" onClick={requestClose}>
        <motion.div initial={{ opacity: 0, scale: 0.95 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: 0.95 }} className="bg-elevated rounded-2xl border border-glass-border w-full max-w-xl overflow-hidden" onClick={(event) => event.stopPropagation()}>
          <div className="flex items-center justify-between p-6 border-b border-glass-border">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-gradient-to-br from-amber-500/20 to-orange-500/20 rounded-lg"><Key size={20} className="text-amber-400" /></div>
              <div>
                <h2 className="text-lg font-bold text-foreground">韭菜盒子 API</h2>
                <p className="text-xs text-text-muted">一个凭证即可使用全部模型能力</p>
              </div>
            </div>
            <button onClick={requestClose} disabled={!canClose} className="p-2 hover:bg-hover-bg rounded-lg disabled:opacity-40"><X size={20} className="text-text-secondary" /></button>
          </div>

          <div className="p-6">
            {isRequired && !canClose && <div className="mb-4 bg-yellow-500/10 border border-yellow-500/20 rounded-lg p-3 text-xs text-yellow-300">请先填写韭菜盒子 API Key。</div>}
            {loading ? (
              <div className="flex items-center justify-center py-12"><Loader2 size={24} className="animate-spin text-amber-400" /></div>
            ) : loadError ? (
              <div className="bg-red-500/10 border border-red-500/20 rounded-lg p-4 text-sm text-red-300">{loadError}</div>
            ) : (
              <div className="bg-glass border border-glass-border rounded-lg p-4">
                <div>
                  <label className="block text-sm font-medium text-foreground mb-2">API Key <span className="text-red-500">*</span></label>
                  <div className="relative">
                    <input type={revealed ? "text" : "password"} value={config.JIUCAIHEZI_API_KEY} onChange={(event) => setConfig((current) => ({ ...current, JIUCAIHEZI_API_KEY: event.target.value }))} placeholder="韭菜盒子 API Key" className={inputClass + " pr-11"} />
                    <button type="button" onClick={async () => { if (!revealed && config.JIUCAIHEZI_API_KEY.includes("•")) { try { const full = await api.getEnvKey(); setConfig((current) => ({ ...current, JIUCAIHEZI_API_KEY: full })); } catch {} } setRevealed((current) => !current); }} aria-label={revealed ? "隐藏 API Key" : "显示完整 API Key"} className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 text-text-muted hover:text-foreground">{revealed ? <EyeOff size={16} /> : <Eye size={16} />}</button>
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="flex justify-end gap-3 p-6 border-t border-glass-border">
            <button onClick={requestClose} disabled={!canClose} className="px-4 py-2 text-sm text-text-secondary disabled:opacity-40">{tc("cancel")}</button>
            <button onClick={() => window.open("https://api.jiucaihezi.studio/keys", "_blank", "noopener,noreferrer")} className="flex items-center gap-2 px-4 py-2 border border-glass-border text-text-secondary text-sm font-medium rounded-lg"><ExternalLink size={15} /> 前往获取</button>
            <button onClick={handleSave} disabled={saving || loading || !!loadError} className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-amber-600 to-orange-600 text-foreground text-sm font-medium rounded-lg disabled:opacity-50">
              {saving ? <Loader2 size={16} className="animate-spin" /> : <Save size={16} />}
              {saving ? t("savingConfig") : t("saveConfig")}
            </button>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  );
}
