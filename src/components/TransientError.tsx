import { useEffect, useState } from "react";
import { localizeMessage } from "../lib/i18n";
import { useUiLanguage } from "../lib/useUiLanguage";

export function TransientError({ message }: { message: string }) {
  useUiLanguage();
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    // Hide presentation only; persistence failures must retain their underlying state.
    // 仅隐藏展示，保存失败等内部错误状态必须保留。
    const timer = setTimeout(() => setVisible(false), 1500);
    return () => clearTimeout(timer);
  }, []);
  return visible ? (
    <div className="workspace-error" role="alert">
      {localizeMessage(message)}
    </div>
  ) : null;
}
