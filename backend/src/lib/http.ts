import type { APIGatewayProxyStructuredResultV2 } from "aws-lambda";

/**
 * JSON response helper. Every handler returns through here so that headers and
 * shape stay consistent across the API.
 */
export function json(
  statusCode: number,
  body: unknown,
  cacheSeconds = 0,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control":
        cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : "no-store",
    },
    body: JSON.stringify(body),
  };
}

/**
 * Error shape returned to the browser. Deliberately terse: the client never
 * needs an internal reason, and the detail belongs in the logs instead.
 */
export function problem(
  statusCode: number,
  message: string,
): APIGatewayProxyStructuredResultV2 {
  return json(statusCode, { error: message });
}
