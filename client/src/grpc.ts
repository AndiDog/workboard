import { Metadata, RpcError, StatusCode } from 'grpc-web';

// Background requests which make the server talk to the GitHub API for many
// pull requests at once
export const grpcBatchTimeoutMs = 300000;

// Requests triggered by a button click. The user is waiting for the row to
// update, so give up early enough that we can still tell them something went
// wrong.
export const grpcCommandTimeoutMs = 3000;

// Requests which only read the server's local database
export const grpcQueryTimeoutMs = 10000;

export type GrpcResult<TResponse> =
  | { ok: true; pending: false; error: null; res: TResponse }
  | { ok: false; pending: false; error: RpcError; res: null }
  | { ok: false; pending: true; error: null; res: null };

export function grpcDeadline(timeoutMs: number): Metadata {
  return { deadline: (Date.now() + timeoutMs).toString() };
}

export function isGrpcTimeout(error: RpcError | null): boolean {
  return error?.code === StatusCode.DEADLINE_EXCEEDED;
}

export function makePendingGrpcResult<TResponse>(): GrpcResult<TResponse> {
  return { ok: false, pending: true, error: null, res: null };
}

export function toGrpcResult<TResponse>(
  error: RpcError,
  res: TResponse,
): GrpcResult<TResponse> {
  return !error || error.code == StatusCode.OK
    ? { ok: true, pending: false, error: null, res }
    : { ok: false, pending: false, error, res: null };
}
