import { SignJWT, jwtVerify } from "jose";
import { randomBytes } from "node:crypto";

const ALG = "HS256";

export interface SessionConfig {
  /** Session duration in seconds (default: 3600 = 1 hour) */
  durationSeconds: number;
  /** Cookie name (default: "chest_session") */
  cookieName: string;
  /** JWT signing secret, auto-generated per proxy instance if not provided */
  secret: Uint8Array;
}

export interface SessionPayload {
  payer: string;
  route: string;
  paid: boolean;
  iat: number;
  exp: number;
}

export function createSessionConfig(opts?: {
  durationSeconds?: number;
  cookieName?: string;
  secret?: string;
}): SessionConfig {
  const secret = opts?.secret
    ? new TextEncoder().encode(opts.secret)
    : randomBytes(32);

  return {
    durationSeconds: opts?.durationSeconds ?? 3600,
    cookieName: opts?.cookieName ?? "chest_session",
    secret: secret instanceof Buffer ? new Uint8Array(secret) : secret,
  };
}

export async function createSessionToken(
  config: SessionConfig,
  payer: string,
  route: string
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);

  return new SignJWT({
    payer,
    route,
    paid: true,
  })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt(now)
    .setExpirationTime(now + config.durationSeconds)
    .sign(config.secret);
}

export async function verifySessionToken(
  config: SessionConfig,
  token: string
): Promise<SessionPayload | null> {
  try {
    const { payload } = await jwtVerify(token, config.secret, {
      algorithms: [ALG],
    });

    if (!payload.paid || !payload.payer) return null;

    return {
      payer: payload.payer as string,
      route: payload.route as string,
      paid: payload.paid as boolean,
      iat: payload.iat as number,
      exp: payload.exp as number,
    };
  } catch {
    return null;
  }
}

export function buildSetCookieHeader(
  config: SessionConfig,
  token: string
): string {
  return [
    `${config.cookieName}=${token}`,
    `Max-Age=${config.durationSeconds}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ].join("; ");
}

export function extractSessionCookie(
  config: SessionConfig,
  cookieHeader: string | null
): string | null {
  if (!cookieHeader) return null;

  const cookies = cookieHeader.split(";").map((c) => c.trim());
  for (const cookie of cookies) {
    const [name, ...rest] = cookie.split("=");
    if (name === config.cookieName) {
      return rest.join("=");
    }
  }
  return null;
}
