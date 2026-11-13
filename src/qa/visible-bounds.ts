export function visibleControlBounds(control: HTMLElement) {
  const view = control.ownerDocument.defaultView;
  if (!view) throw new Error("Control has no actual window");
  const rect = control.getBoundingClientRect();
  let left = Math.max(0, rect.left),
    right = Math.min(view.innerWidth, rect.right);
  let top = Math.max(0, rect.top),
    bottom = Math.min(view.innerHeight, rect.bottom);
  for (let parent = control.parentElement; parent; parent = parent.parentElement) {
    const style = view.getComputedStyle(parent),
      bounds = parent.getBoundingClientRect();
    const scaleX = parent.offsetWidth ? bounds.width / parent.offsetWidth : 1;
    const scaleY = parent.offsetHeight ? bounds.height / parent.offsetHeight : 1;
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX || style.overflow)) {
      left = Math.max(left, bounds.left + parent.clientLeft * scaleX);
      right = Math.min(right, bounds.left + (parent.clientLeft + parent.clientWidth) * scaleX);
    }
    if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY || style.overflow)) {
      top = Math.max(top, bounds.top + parent.clientTop * scaleY);
      bottom = Math.min(bottom, bounds.top + (parent.clientTop + parent.clientHeight) * scaleY);
    }
  }
  return { width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}
