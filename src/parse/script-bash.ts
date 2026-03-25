/**
 * Whether the script body should use Jaiph bash rules (keyword guard, quote stripping, shell emit).
 * True when there is no custom shebang or the shebang runs bash.
 */
export function scriptShebangIsBash(shebang?: string): boolean {
  if (shebang === undefined) return true;
  const t = shebang.trim();
  if (t === "#!/usr/bin/env bash" || t === "#!/bin/bash" || t === "#!/usr/bin/bash") return true;
  if (/^#!\/usr\/bin\/env\s+bash(?:\s|$)/.test(t)) return true;
  return false;
}
