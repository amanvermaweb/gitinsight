import { NextResponse } from "next/server";

type JsonResponseOptions = {
  status: number;
  headers?: HeadersInit;
};

type ErrorPayload = {
  error: string;
};

export function jsonSuccess<T extends Record<string, unknown>>(
  payload: T,
  options: JsonResponseOptions,
) {
  return NextResponse.json(payload, {
    status: options.status,
    headers: options.headers,
  });
}

export function jsonError(error: string, options: JsonResponseOptions) {
  const payload: ErrorPayload = { error };

  return NextResponse.json(payload, {
    status: options.status,
    headers: options.headers,
  });
}
