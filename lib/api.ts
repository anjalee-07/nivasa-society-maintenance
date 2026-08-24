export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export function handleApiError(error: unknown): Response {
  if (error instanceof ApiError) {
    return Response.json({ error: error.message }, { status: error.status });
  }

  const message = error instanceof Error ? error.message : "Unexpected error";
  const lower = message.toLowerCase();
  if (lower.includes("no such table") || lower.includes("binding is unavailable")) {
    return Response.json(
      { error: "The application database is not ready yet. Please try again shortly." },
      { status: 503 },
    );
  }

  return Response.json(
    { error: "Something went wrong while processing the request." },
    { status: 500 },
  );
}

export function readString(
  value: unknown,
  label: string,
  options: { min?: number; max?: number; required?: boolean } = {},
): string {
  const text = typeof value === "string" ? value.trim() : "";
  const required = options.required ?? true;
  if (!text && required) throw new ApiError(400, `${label} is required.`);
  if (text && options.min && text.length < options.min) {
    throw new ApiError(400, `${label} must be at least ${options.min} characters.`);
  }
  if (options.max && text.length > options.max) {
    throw new ApiError(400, `${label} must be ${options.max} characters or fewer.`);
  }
  return text;
}

export function noStoreJson(body: unknown, init?: ResponseInit): Response {
  const response = Response.json(body, init);
  response.headers.set("Cache-Control", "no-store");
  response.headers.set("X-Content-Type-Options", "nosniff");
  return response;
}

export function requireSameOrigin(request: Request): void {
  const origin = request.headers.get("Origin");
  if (!origin) return;
  let originUrl: URL;
  try {
    originUrl = new URL(origin);
  } catch {
    throw new ApiError(403, "The request origin is not allowed.");
  }
  if (originUrl.origin !== new URL(request.url).origin) {
    throw new ApiError(403, "The request origin is not allowed.");
  }
}
