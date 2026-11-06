import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
const execute = promisify(execFile);

export function cpuSeconds(text) {
  const [days, clock] = text.includes("-") ? text.split("-") : ["0", text];
  const parts = clock.split(":").map(Number);
  return Number(days) * 86400 + parts.reduce((sum, value) => sum * 60 + value, 0);
}

export function parsePs(text) {
  return text
    .trim()
    .split("\n")
    .flatMap((line) => {
      const [pid, parent, rss, cpu] = line.trim().split(/\s+/);
      const value = {
        pid: Number(pid),
        parent: Number(parent),
        rssBytes: Number(rss) * 1024,
        cpuSeconds: cpu ? cpuSeconds(cpu) : NaN,
      };
      return value.pid > 0 && Object.values(value).every(Number.isFinite) ? [value] : [];
    });
}

export function ownedProcesses(processes, appPID, hostPID) {
  const owned = new Set([appPID, hostPID].filter((pid) => Number.isInteger(pid) && pid > 0));
  let changed = true;
  while (changed) {
    changed = false;
    for (const value of processes) {
      if (owned.has(value.parent) && !owned.has(value.pid)) {
        owned.add(value.pid);
        changed = true;
      }
    }
  }
  return processes.filter((value) => owned.has(value.pid));
}

export function summarizeSamples(samples) {
  const phases = {};
  const previous = new Map();
  for (const sample of samples) {
    const stats = (phases[sample.phase] ??= {
      samples: 0,
      peakRSSBytes: 0,
      observedCPUSeconds: 0,
      firstRSSBytes: 0,
      lastRSSBytes: 0,
    });
    const rss = sample.processes.reduce((sum, value) => sum + value.rssBytes, 0);
    if (!stats.samples) stats.firstRSSBytes = rss;
    stats.samples++;
    stats.lastRSSBytes = rss;
    stats.peakRSSBytes = Math.max(stats.peakRSSBytes, rss);
    for (const value of sample.processes) {
      const before = previous.get(value.pid);
      if (before !== undefined) stats.observedCPUSeconds += Math.max(0, value.cpuSeconds - before);
      previous.set(value.pid, value.cpuSeconds);
    }
  }
  return phases;
}

export function startResourceSampler(appPID, phasePath, outputPath) {
  const samples = [];
  const errors = [];
  const start = performance.now();
  let running = Promise.resolve();
  let pending = false;
  let sensor;
  let sensorExit;
  const accept = (processes) => {
    let phase = { phase: "startup", cycle: -1 };
    try {
      phase = JSON.parse(readFileSync(phasePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) errors.push(String(error));
    }
    samples.push({
      elapsedMilliseconds: performance.now() - start,
      phase: phase.phase,
      cycle: phase.cycle,
      processes: ownedProcesses(processes, appPID, phase.hostPID),
    });
  };
  let timer;
  if (process.platform === "win32") {
    // Keep one sampling process; repeatedly starting PowerShell would distort the workload.
    // 保持单个采样进程，避免重复启动 PowerShell 干扰负载。
    sensor = spawn(
      "powershell.exe",
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `
      [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
      while (Get-Process -Id ${appPID} -ErrorAction SilentlyContinue) {
        $qaParents = @{}
        Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId | ForEach-Object { $qaParents[[int]$_.ProcessId]=[int]$_.ParentProcessId }
        $qaRows = @(Get-Process | ForEach-Object { try { @{pid=$_.Id;parent=$qaParents[$_.Id];rssBytes=$_.WorkingSet64;cpuSeconds=$_.CPU} } catch {} })
        ConvertTo-Json -InputObject $qaRows -Compress -Depth 3
        Start-Sleep -Milliseconds 250
      }`,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    createInterface({ input: sensor.stdout }).on("line", (line) => {
      try {
        accept(JSON.parse(line).filter((value) => Object.values(value).every(Number.isFinite)));
      } catch (error) {
        errors.push(String(error));
      }
    });
    sensor.stderr.on("data", (data) => errors.push(data.toString()));
    sensor.on("error", (error) => errors.push(String(error)));
    sensorExit = new Promise((done) => sensor.once("close", done));
  } else {
    const sample = () => {
      if (pending) return;
      pending = true;
      running = execute("ps", ["-axo", "pid=,ppid=,rss=,time="], { maxBuffer: 4 * 1024 * 1024 })
        .then(({ stdout }) => accept(parsePs(stdout)))
        .catch((error) => errors.push(String(error)))
        .finally(() => {
          pending = false;
        });
    };
    sample();
    timer = setInterval(sample, 250);
  }
  return {
    async stop() {
      clearInterval(timer);
      await running;
      if (sensor) {
        if (sensor.exitCode === null && sensor.signalCode === null) sensor.kill();
        await sensorExit;
      }
      const result = {
        appPID,
        sampleCount: samples.length,
        samples,
        phases: summarizeSamples(samples),
        errors,
        scope:
          "App PID, its descendants, authenticated fixture host PID and its descendants; per-process RSS sum and observed cumulative CPU deltas",
        excluded: [
          "Unattributed WebContent/GPU/XPC processes",
          "Kernel memory",
          "Sampler process cost",
        ],
        wholeAppImprovementClaim: false,
        longTermLeakAcceptance: false,
      };
      writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
      if (errors.length || samples.length < 10)
        throw Error("Resource sampler failed or produced too few samples");
      return result;
    },
  };
}
