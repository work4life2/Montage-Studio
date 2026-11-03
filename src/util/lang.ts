/** Heuristic: does the buyer write in Chinese? */
export function isChinese(text: string): boolean {
  const cjk = (text.match(/[一-鿿]/g) ?? []).length;
  return cjk >= 4 && cjk / Math.max(1, text.replace(/\s/g, "").length) > 0.15;
}
