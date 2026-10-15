import { tx } from "./i18n.ts";
export function boundedPdfScale(
  width: number,
  height: number,
  scale: number,
  thumbnail: boolean,
): number {
  if (![width, height, scale].every((value) => Number.isFinite(value) && value > 0))
    throw new Error(tx("PDF 页面尺寸无效。"));
  const pixels = thumbnail ? 128 * 1024 : 4 * 1024 * 1024;
  const edge = thumbnail ? 512 : 4096;
  return Math.min(scale, Math.sqrt(pixels / width / height), edge / width, edge / height);
}
