export const panelCollapseWidth = 30;
export const sidebarRailWidth = 48;

export function sidebarLayout(available: number, requested: number) {
  const maximum = Math.max(180, Math.min(320, available * 0.3));
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
