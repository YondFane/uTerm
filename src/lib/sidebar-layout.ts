import chrome from "../../shared/contracts/chrome-ui-v1.json" with { type: "json" };

export const panelCollapseWidth = 30;
export const sidebarRailWidth = chrome.metrics.sidebarRailWidth;

export function sidebarLayout(available: number, requested: number) {
  const maximum = Math.max(
    chrome.metrics.sidebarMinimumWide,
    Math.min(chrome.metrics.sidebarMaximumWidth, available * chrome.metrics.sidebarMaximumRatio),
  );
  const minimum = sidebarRailWidth;
  const collapseWidth = panelCollapseWidth + sidebarRailWidth;
  return {
    width: Math.max(minimum, Math.min(maximum, requested)),
    minimum,
    maximum,
    collapseWidth,
    hidden: requested <= collapseWidth,
  };
}
