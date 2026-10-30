/**
 * Single source of truth for "which Hub is this" (decentralization phase 3).
 * Runtime code must not hard-code the jkamma-operated origin; read it here.
 */
export const JKAMMA_HUB_ORIGIN = "https://hub.jkamma.com";
export const JKAMMA_STAGING_HUB_ORIGIN = "https://jkamma-hub-staging.jammakamma0.workers.dev";
export const DEFAULT_INSTANCE_ORIGIN = "http://127.0.0.1:3020";

/** This Hub's own public origin (HUB_PUBLIC_ORIGIN). Unset or invalid falls back to loopback, never to jkamma. */
export function getInstanceOrigin(env: Record<string, string | undefined> = process.env): string {
  const configured = env.HUB_PUBLIC_ORIGIN?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // fall through
    }
  }
  return DEFAULT_INSTANCE_ORIGIN;
}

export function getInstanceHost(env: Record<string, string | undefined> = process.env): string {
  return new URL(getInstanceOrigin(env)).host;
}

/**
 * True only for the jkamma-operated Hub (production or staging), or when an operator explicitly sets
 * HUB_JKAMMA_SERVICES=1. A self-hosted Hub is a separate operator and gets no Account, Music, Vault,
 * Mail, AI, Commerce or Identity integration, so it fails closed here.
 */
export function isJkammaServicesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.HUB_JKAMMA_SERVICES?.trim().toLowerCase();
  if (flag === "1" || flag === "true") return true;
  if (flag === "0" || flag === "false") return false;
  const origin = getInstanceOrigin(env);
  return origin === JKAMMA_HUB_ORIGIN || origin === JKAMMA_STAGING_HUB_ORIGIN;
}

/**
 * Where the corresponding source of this Hub can be read (AGPL-3.0, HUB_SOURCE_URL). Only an
 * http(s) URL is accepted; unset or invalid returns null and the UI shows nothing.
 */
export function getSourceCodeUrl(env: Record<string, string | undefined> = process.env): string | null {
  const configured = env.HUB_SOURCE_URL?.trim();
  if (!configured) return null;
  try {
    const url = new URL(configured);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Product/site name of this Hub (HUB_INSTANCE_NAME, trimmed, at most 80 characters). When unset, the
 * jkamma-operated Hub keeps its current name (`jkammaName`) and every other Hub is simply "Hub".
 */
export function getInstanceName(
  env: Record<string, string | undefined> = process.env,
  jkammaName = "Hub",
): string {
  const configured = env.HUB_INSTANCE_NAME?.trim().replace(/\s+/g, " ").slice(0, 80);
  if (configured) return configured;
  return isJkammaServicesEnabled(env) ? jkammaName : "Hub";
}
