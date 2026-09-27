export const panelCollapseWidth = 30;

export function sidebarLayout(available: number, requested: number) {
  const maximum = Math.max(180, Math.min(320, available * 0.3));
  return {
    width: Math.max(panelCollapseWidth, Math.min(maximum, requested)),
    maximum,
    hidden: requested <= panelCollapseWidth,
  };
}
