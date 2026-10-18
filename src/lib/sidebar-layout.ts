export const panelCollapseWidth = 30;
export const sidebarRailWidth = 48;

export function sidebarLayout(available: number, requested: number, navigation = false) {
  const maximum = Math.max(180, Math.min(320, available * 0.3));
  const minimum = navigation ? sidebarRailWidth : panelCollapseWidth;
  const collapseWidth = panelCollapseWidth + (navigation ? sidebarRailWidth : 0);
  return {
    width: Math.max(minimum, Math.min(maximum, requested)),
    minimum,
    maximum,
    collapseWidth,
    hidden: requested <= collapseWidth,
  };
}
