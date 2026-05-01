/**
 * Generic Middleware Pipeline
 *
 * Type-safe, sequential middleware execution for any data type.
 * Used as the foundation for messaging (ALF), route, and fetch pipelines.
 *
 * Usage:
 *   const pipeline = new Pipeline<MyDataType, MyContextType>()
 *   pipeline.add(myMiddleware)
 *   const result = await pipeline.process(data, context)
 */

// ===========================================================================
// Core Types
// ===========================================================================

/** Result of a middleware function or full pipeline run. */
export interface PipelineResult<T> {
  /** The (possibly transformed) data */
  data: T
  /** Set if the middleware rejects the data — short-circuits the pipeline */
  rejected?: { code: number; reason: string }
}

/** A single middleware function in the pipeline. */
export type MiddlewareFn<T, C = Record<string, unknown>> = (
  data: T,
  context: C
) => PipelineResult<T> | Promise<PipelineResult<T>>

// ===========================================================================
// Pipeline Class
// ===========================================================================

/**
 * Generic sequential middleware pipeline.
 *
 * @typeParam T - The data type being processed (e.g. AlfMessage, HttpRequest)
 * @typeParam C - The context type passed to each middleware
 */
export class Pipeline<T, C = Record<string, unknown>> {
  private fns: MiddlewareFn<T, C>[] = []

  /** Add a middleware function to the end of the pipeline. */
  add(fn: MiddlewareFn<T, C>): this {
    this.fns.push(fn)
    return this
  }

  /** Run all middleware in order. Short-circuits on rejection. */
  async process(data: T, ctx: C): Promise<PipelineResult<T>> {
    let current = data
    for (const fn of this.fns) {
      const result = await fn(current, ctx)
      if (result.rejected) return result
      current = result.data
    }
    return { data: current }
  }

  /** Number of middleware functions in this pipeline. */
  get length(): number {
    return this.fns.length
  }
}
