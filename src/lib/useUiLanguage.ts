import { useSyncExternalStore } from "react";
import { getUiLanguage, subscribeLanguage } from "./i18n";
export function useUiLanguage() {
  return useSyncExternalStore(subscribeLanguage, getUiLanguage, getUiLanguage);
}
