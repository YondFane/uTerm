import chrome from "../../shared/contracts/chrome-ui-v1.json" with { type: "json" };
import { panelCollapseWidth } from "./sidebar-layout.ts";

export function inspectorDragLayout(available: number, requestedWidth: number) {
  return {
    ...inspectorLayout(
      available,
      requestedWidth / Math.max(chrome.metrics.inspectorMinimumAvailable, available),
    ),
    hidden: requestedWidth <= panelCollapseWidth,
  };
}

export function inspectorLayout(availableWidth: number, ratio: number) {
  const available = Math.max(chrome.metrics.inspectorMinimumAvailable, availableWidth);
  const minimum = panelCollapseWidth;
  const maximum = Math.min(
    available - chrome.metrics.mainMinimumWidth,
    available * chrome.metrics.inspectorMaximumRatio,
  );
  const width = Math.max(minimum, Math.min(maximum, available * ratio));
  return { available, minimum, maximum, width, ratio: width / available };
}

export function hasInspectorContent(
  directory: string,
  project: boolean,
  panels: {
    files: boolean;
    directory: boolean;
    git: boolean;
    github: boolean;
  },
): boolean {
  return (
    !!directory && (panels.files || panels.directory || (project && (panels.git || panels.github)))
  );
}

export function inspectorResizeWidth(width: number, deltaX: number, position: "left" | "right") {
  return width + (position === "left" ? deltaX : -deltaX);
}
