import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke, isTauri } from "@tauri-apps/api/core";

type Phase = "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "current";
interface Availability {
  enabled: boolean;
  version: string;
  notes: string | null;
  downloaded: boolean;
}
export function useUpdates(
  prepare: () => Promise<void>,
  restore: () => Promise<void>,
  automatic = false,
) {
  const [available, setAvailable] = useState<Availability | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState("");
  const [progress, setProgress] = useState({ downloaded: 0, total: null as number | null });
  const busy = useRef(false);
  const checked = useRef(false);
  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setError("");
    checked.current = true;
    setPhase("checking");
    try {
      const result = await invoke<Availability>("update_check");
      setAvailable(result);
      setPhase(result.version ? "available" : "current");
    } catch (reason) {
      setError(String(reason));
      setPhase("idle");
    } finally {
      busy.current = false;
    }
  }, []);
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    void invoke<Availability>("update_status")
      .then((result) => {
        if (disposed) return;
        setAvailable(result);
        if (result.version) setPhase(result.downloaded ? "ready" : "available");
        else if (result.enabled)
          timer = setTimeout(() => {
            if (!checked.current) void check();
          }, 15_000);
      })
      .catch((reason) => {
        if (!disposed) setError(String(reason));
      });
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [check]);
  async function download() {
    if (busy.current) return;
    busy.current = true;
    setError("");
    setProgress({ downloaded: 0, total: null });
    setPhase("downloading");
    const events = new Channel<{ downloaded: number; total: number | null }>();
    events.onmessage = setProgress;
    try {
      await invoke("update_download", { events });
      setPhase("ready");
    } catch (reason) {
      setError(String(reason));
      setPhase("available");
    } finally {
      busy.current = false;
    }
  }
  async function install() {
    if (busy.current) return;
    busy.current = true;
    setError("");
    setPhase("installing");
    try {
      await prepare();
      await invoke("update_install");
    } catch (reason) {
      setError(String(reason));
      setPhase("ready");
      try {
        await restore();
      } catch (restoreError) {
        setError(`${String(reason)}；${String(restoreError)}`);
      }
    } finally {
      busy.current = false;
    }
  }
  const actions = useRef({ check, download, install, phase });
  actions.current = { check, download, install, phase };
  useEffect(() => {
    if (!automatic || !available?.enabled) return;
    const checkWhenIdle = () => {
      if (["idle", "current"].includes(actions.current.phase)) void actions.current.check();
    };
    checkWhenIdle();
    const timer = setInterval(checkWhenIdle, 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [automatic, available?.enabled]);
  useEffect(() => {
    if (!automatic || !available?.enabled || error) return;
    if (phase === "available") void actions.current.download();
    else if (phase === "ready") void actions.current.install();
  }, [automatic, available?.enabled, phase, error]);
  return { available, phase, error, progress, check, download, install };
}
export type Updates = ReturnType<typeof useUpdates>;
