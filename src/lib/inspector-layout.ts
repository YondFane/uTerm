import { panelCollapseWidth } from "./sidebar-layout.ts";

export function inspectorDragLayout(available: number, requestedWidth: number) {
  return {
    ...inspectorLayout(available, requestedWidth / Math.max(560, available)),
    hidden: requestedWidth <= panelCollapseWidth,
  };
}

export function inspectorLayout(availableWidth: number, ratio: number) {
  const available = Math.max(560, availableWidth);
  const minimum = panelCollapseWidth;
  const maximum = Math.min(available - 320, available * 0.6);
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
