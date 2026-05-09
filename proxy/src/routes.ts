export interface RouteConfig {
  path: string;
  price: number;
}

export function matchRoute(
  method: string,
  path: string,
  routes: RouteConfig[]
): RouteConfig | null {
  const requestKey = `${method} ${path}`;

  for (const route of routes) {
    if (route.path === "*") {
      return route;
    }

    // Exact match: "GET /api/data"
    if (route.path === requestKey) {
      return route;
    }

    // Method + wildcard path: "GET /api/*"
    const [routeMethod, routePath] = parseRoutePath(route.path);

    if (routeMethod && routeMethod !== method) {
      continue;
    }

    if (routePath && matchPath(path, routePath)) {
      return route;
    }
  }

  return null;
}

function parseRoutePath(route: string): [string | null, string | null] {
  const parts = route.split(" ");
  if (parts.length === 2) {
    return [parts[0], parts[1]];
  }
  // Path only (no method specified, matches all methods)
  return [null, parts[0]];
}

function matchPath(requestPath: string, pattern: string): boolean {
  // Exact match
  if (pattern === requestPath) return true;

  // Wildcard: /api/* matches /api/anything/here
  if (pattern.endsWith("/*")) {
    const prefix = pattern.slice(0, -2);
    return requestPath.startsWith(prefix);
  }

  // Glob: /api/*/data matches /api/123/data
  if (pattern.includes("*")) {
    const regex = new RegExp(
      "^" + pattern.replace(/\*/g, "[^/]+") + "$"
    );
    return regex.test(requestPath);
  }

  return false;
}
