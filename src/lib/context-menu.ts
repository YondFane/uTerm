export function suppressBrowserContextMenu(target: EventTarget): () => void {
  const suppress = (event: Event) => event.preventDefault();
  target.addEventListener("contextmenu", suppress, true);
  return () => target.removeEventListener("contextmenu", suppress, true);
}
