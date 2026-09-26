import { NextResponse, type NextRequest } from "next/server";

/**
 * Routing-level gate only.
 *
 * The cookie's signature and the configuration check are enforced again in the
 * API layer (lib/auth.ts), which is what actually protects the data. This
 * middleware just makes the browser land somewhere sensible.
 */
export function middleware(request: NextRequest) {
  const configured =
    (process.env.NL_ENCRYPTION_KEY ?? "").length >= 32 &&
    (process.env.NL_APP_PASSWORD ?? "").length >= 8;

  const url = request.nextUrl.clone();
  url.search = "";

  if (!configured) {
    if (request.nextUrl.pathname === "/setup") return NextResponse.next();
    url.pathname = "/setup";
    return NextResponse.redirect(url);
  }

  if (request.nextUrl.pathname === "/setup") {
    url.pathname = "/";
    return NextResponse.redirect(url);
  }

  if (request.cookies.get("nl_session")) return NextResponse.next();

  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!login|api|_next/static|_next/image|manifest.webmanifest|sw.js|icon.svg|icon-.*\\.png|apple-touch-icon\\.png|favicon.*).*)"],
};
