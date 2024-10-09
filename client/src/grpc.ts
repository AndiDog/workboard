import { RpcError, StatusCode } from 'grpc-web';

export type GrpcResult<TResponse> =
  | { ok: true; pending: false; error: null; res: TResponse }
  | { ok: false; pending: false; error: RpcError; res: null }
  | { ok: false; pending: true; error: null; res: null };

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
