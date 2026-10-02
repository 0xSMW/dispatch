import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "../components/Toast";

export interface UseMutationOptions<TData, TVariables> {
  onSuccess?: (data: TData, variables: TVariables) => void | Promise<void>;
  /** Replaces the default, which shows the error in a toast. */
  onError?: (error: Error, variables: TVariables) => void | Promise<void>;
  onSettled?: (data: TData | undefined, error: Error | null, variables: TVariables) => void | Promise<void>;
  /** Toast shown after success, such as "Domain added." */
  success?: string | ((data: TData) => string);
}

/**
 * Wraps one write. `mutate` never throws: errors land in `error` and, by default, in a toast.
 * Disable submit buttons with `isLoading`.
 */
export function useMutation<TData = unknown, TVariables = void>(
  mutationFn: (variables: TVariables) => Promise<TData>,
  options: UseMutationOptions<TData, TVariables> = {},
) {
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [data, setData] = useState<TData | undefined>(undefined);
  const fn = useRef(mutationFn);
  const opts = useRef(options);
  const mounted = useRef(true);
  fn.current = mutationFn;
  opts.current = options;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    setIsLoading(false);
    setError(null);
    setData(undefined);
  }, []);

  const mutate = useCallback(async (variables: TVariables): Promise<TData | undefined> => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await fn.current(variables);
      if (mounted.current) setData(result);
      const { success } = opts.current;
      if (success) toast.success(typeof success === "function" ? success(result) : success);
      await opts.current.onSuccess?.(result, variables);
      await opts.current.onSettled?.(result, null, variables);
      return result;
    } catch (err) {
      const normalized = err instanceof Error ? err : new Error(String(err));
      if (mounted.current) setError(normalized);
      if (opts.current.onError) await opts.current.onError(normalized, variables);
      else toast.error(normalized.message);
      await opts.current.onSettled?.(undefined, normalized, variables);
      return undefined;
    } finally {
      if (mounted.current) setIsLoading(false);
    }
  }, []);

  return { mutate, isLoading, isPending: isLoading, error, data, reset };
}
