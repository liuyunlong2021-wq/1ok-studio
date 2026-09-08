"use client";

import { useState, useEffect } from "react";
import EnvConfigDialog from "@/components/project/EnvConfigDialog";
import { api } from "@/lib/api";

export default function EnvConfigChecker() {
  const [isEnvDialogOpen, setIsEnvDialogOpen] = useState(false);
  const [envRequired, setEnvRequired] = useState(false);
  const [hasChecked, setHasChecked] = useState(false);

  useEffect(() => {
    // 只在客户端执行，且只检查一次
    if (typeof window === 'undefined' || hasChecked) return;
    
    checkEnvConfig();
    setHasChecked(true);
  }, [hasChecked]);

  const checkEnvConfig = async () => {
    try {
      const config = await api.getEnvConfig();
      // 韭菜盒子或 DashScope 任一主要凭证即可启动。
      const jiucaiheziKey = config.JIUCAIHEZI_API_KEY?.trim();
      const dashscopeKey = config.DASHSCOPE_API_KEY?.trim();
      const hasRequired = Boolean(jiucaiheziKey || dashscopeKey);
      
      if (!hasRequired) {
        setEnvRequired(true);
        setIsEnvDialogOpen(true);
      }
    } catch (error) {
      console.error("Failed to check env config:", error);
      // 如果API调用失败，也显示配置对话框
      setEnvRequired(true);
      setIsEnvDialogOpen(true);
    }
  };

  return (
    <EnvConfigDialog
      isOpen={isEnvDialogOpen}
      onClose={() => {
        setIsEnvDialogOpen(false);
        setEnvRequired(false);
      }}
      isRequired={envRequired}
    />
  );
}
